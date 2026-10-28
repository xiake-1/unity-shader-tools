/** T-013 / T-020 性能基准：冷启动全量索引 / 增量编辑 / 常驻内存 / F12 转到定义
 *
 * 阈值来自 docs/specs/feature-language-server-core.md 的约束
 * （冷启动全量索引 < 3s；单次编辑「解析 + 符号表更新」< 100ms；RSS < 500MB）
 * 与 docs/specs/feature-go-to-definition.md 的约束（F12 P95 < 200ms，查询只读不触发重建）。
 * 语料：真实 Unity 工程 ShaderStudy（50 个 shader/hlsl）+ 2022.3 内置 CGIncludes
 *      + 该工程 Library/PackageCache 里的 render-pipelines ShaderLibrary（若存在）。
 * 用法：npm run bench
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SymbolIndex } from '../../server/out/symbolIndex.js';
import { DocumentStore } from '../../server/out/documentStore.js';
import { provideDefinition, clearDefinitionCache } from '../../server/out/definition.js';
import { provideCompletion } from '../../server/out/completion.js';
import { provideHover } from '../../server/out/hover.js';
import { provideReferences } from '../../server/out/references.js';
import { rename as provideRename } from '../../server/out/rename.js';
import { collectOccurrences } from '../../server/out/occurrences.js';
import { computeFileDiagnostics, treesForFile } from '../../server/out/diagnostics.js';
import { parseHlslFile } from '../../server/out/parser.js';
import { collectInactiveRegions } from '../../server/out/inactiveRegions.js';
import { UnityKeywordSource } from '../../server/out/unityKeywordSource.js';
import { resolveDxc, probeDxc, compileUnit } from '../../server/out/dxcRunner.js';
import { prepareTypeRun } from '../../server/out/typeDiagnostics.js';
import { formatDocument } from '../../server/out/formatter.js';
import { DEFAULT_FORMAT_SWITCHES, resolveIndentOptions } from '../../server/out/formatSettings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const PROJECT = process.env.BENCH_PROJECT ?? 'D:/Work/Unity/ShaderStudy';
const EDITOR = process.env.BENCH_EDITOR ?? 'D:/Soft/Work/Unity/UnityEditor/2022.3.62f3c1/Editor';

const SHADER_EXT = /\.(shader|hlsl|hlslinc|cginc)$/i;

function listFiles(dir, limit = 5000) {
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < limit) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'Temp' || e.name === 'obj' || e.name === '.git') continue;
        stack.push(full);
      } else if (SHADER_EXT.test(e.name)) out.push(full);
    }
  }
  return out;
}

const sources = [];
if (fs.existsSync(PROJECT)) {
  sources.push(...listFiles(path.join(PROJECT, 'Assets')));
  const pc = path.join(PROJECT, 'Library', 'PackageCache');
  if (fs.existsSync(pc)) {
    for (const e of fs.readdirSync(pc)) {
      if (!/^com\.unity\.render-pipelines\./i.test(e)) continue;
      const lib = path.join(pc, e, 'ShaderLibrary');
      if (fs.existsSync(lib)) sources.push(...listFiles(lib));
    }
  }
}
const cginc = path.join(EDITOR, 'Data', 'CGIncludes');
if (fs.existsSync(cginc)) {
  for (const e of fs.readdirSync(cginc)) if (SHADER_EXT.test(e)) sources.push(path.join(cginc, e));
}

if (sources.length === 0) {
  console.error('bench: 找不到语料（BENCH_PROJECT / BENCH_EDITOR）');
  process.exit(2);
}

const rssMB = () => process.memoryUsage().rss / 1024 / 1024;

// ---- 1) 冷启动全量索引 ----
global.gc && global.gc();
const rssBefore = rssMB();
const t0 = performance.now();
const index = new SymbolIndex();
let indexed = 0;
for (const f of sources) {
  try {
    index.indexFile(f, fs.readFileSync(f, 'utf8'));
    indexed++;
  } catch {
    /* 单文件失败不中断 */
  }
}
const coldMs = performance.now() - t0;
const rssAfterIndex = rssMB();

// ---- 2) 增量编辑：解析 + 符号表更新 ----
const target = sources.find((f) => f.endsWith('.shader')) ?? sources[0];
const base = fs.readFileSync(target, 'utf8');
const store = new DocumentStore();
store.open(target, base);
index.indexFile(target, base, store.get(target).tree);

const lines = base.split('\n');
const editLine = lines.findIndex((l) => /^\s*(float|half|int)\s+\w+\s*;/.test(l));
const editAt = editLine >= 0 ? editLine : lines.length - 3;

const samples = [];
for (let i = 0; i < 20; i++) {
  const line = lines[editAt] ?? '';
  const ch = line.length;
  const t = performance.now();
  const state = store.change(target, [
    {
      range: { start: { line: editAt, character: ch }, end: { line: editAt, character: ch } },
      text: i % 2 === 0 ? ' ' : '',
    },
  ]);
  index.indexFile(target, state.text, state.tree);
  samples.push(performance.now() - t);
}
samples.sort((a, b) => a - b);
const medianMs = samples[Math.floor(samples.length / 2)];
const p95Ms = samples[Math.floor(samples.length * 0.95) - 1] ?? samples[samples.length - 1];
const rssEnd = rssMB();

// ---- 3) F12 转到定义（T-020：P95 < 200ms；查询只读，不触发重建） ----
const posAt = (text, offset) => {
  const before = text.slice(0, offset);
  return { line: before.split('\n').length - 1, character: offset - before.lastIndexOf('\n') - 1 };
};

const defCtx = {
  index,
  store,
  includeCtx: {
    projectRoot: PROJECT,
    cgIncludesDir: fs.existsSync(cginc) ? cginc : null,
    packageCacheDir: path.join(PROJECT, 'Library', 'PackageCache'),
  },
  projectRoot: PROJECT,
  log: () => {},
  indexing: () => false,
};

const defTargets = sources
  .filter((f) => f.endsWith('.shader') && fs.readFileSync(f, 'utf8').split('\n').length <= 2000)
  .slice(0, 6);
const probes = [];
for (const f of defTargets) {
  const text = fs.readFileSync(f, 'utf8');
  store.open(f, text);
  index.indexFile(f, text, store.get(f).tree);
  const programStart = text.search(/\b(CGPROGRAM|HLSLPROGRAM)\b/);
  const found = [];
  for (const name of ['_MainTex', 'UnityObjectToClipPos', 'mul', 'v2f', 'tex2D', 'o', 'v', '_Time', 'fixed4']) {
    const re = new RegExp(`\\b${name}\\b`, 'g');
    let m;
    while ((m = re.exec(text))) if (m.index > programStart) found.push({ file: f, offset: m.index });
  }
  found.sort((a, b) => a.offset - b.offset);
  probes.push(...found.slice(0, 8));
  if (probes.length >= 30) break;
}

const filesBeforeQuery = index.fileCount;
const symbolsBeforeQuery = index.symbolCount;
clearDefinitionCache();
for (const p0 of probes.slice(0, 3)) {
  const p = posAt(fs.readFileSync(p0.file, 'utf8'), p0.offset);
  provideDefinition(p0.file, p.line, p.character, defCtx); // 预热：首查要建虚拟 HLSL 树
}
const defSamples = [];
let defHits = 0;
for (const p0 of probes.slice(3, 23)) {
  const p = posAt(fs.readFileSync(p0.file, 'utf8'), p0.offset);
  const t = performance.now();
  const r = provideDefinition(p0.file, p.line, p.character, defCtx);
  defSamples.push(performance.now() - t);
  if (r.length) defHits++;
}
defSamples.sort((a, b) => a - b);
const defMedian = defSamples[Math.floor(defSamples.length / 2)];
const defP95 = defSamples[Math.floor(defSamples.length * 0.95) - 1] ?? defSamples[defSamples.length - 1];
const indexDelta = index.fileCount - filesBeforeQuery + (index.symbolCount - symbolsBeforeQuery);

// ---- 4) M3 语义补全（T-027：P95 < 150ms；成员 + 标识符混合，查询只读不触发重建） ----
const compCtx = { ...defCtx, log: () => {} };
const compFile = path.join(PROJECT, 'Assets', '__bench_completion.shader'); // 内存文档，不落盘
const compText = [
  'Shader "Bench/Completion"',
  '{',
  '  SubShader',
  '  {',
  '    Pass',
  '    {',
  '      HLSLPROGRAM',
  '      #include "UnityCG.cginc"',
  '      struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; float4 color : COLOR; };',
  '      v2f i;',
  '      float4 frag(v2f IN) : SV_Target',
  '      {',
  '        float2 b = i.uv;',
  '        float4 c = SAMPLE_TEXTURE2D(_MainTex, sampler_M, float2(0, 0));',
  '        return c + float4(b, 0, 0);',
  '      }',
  '      ENDHLSL',
  '    }',
  '  }',
  '}',
  '',
].join('\n');
store.open(compFile, compText);
index.indexFile(compFile, compText, store.get(compFile).tree);
const memberPos = posAt(compText, compText.indexOf('i.uv') + 2); // `i.` 之后
const identPos = posAt(compText, compText.indexOf('SAMPLE_TEXTURE2D(') + 10); // `SAMPLE_TEXTURE2` 之后
provideCompletion(compFile, memberPos.line, memberPos.character, compCtx); // 预热
provideCompletion(compFile, identPos.line, identPos.character, compCtx);
const filesBeforeComp = index.fileCount;
const symbolsBeforeComp = index.symbolCount;
const compSamples = [];
let compHits = 0;
for (let k = 0; k < 20; k++) {
  const p = k % 2 === 0 ? memberPos : identPos;
  const t = performance.now();
  const r = provideCompletion(compFile, p.line, p.character, compCtx);
  compSamples.push(performance.now() - t);
  if (r.items.length) compHits++;
}
compSamples.sort((a, b) => a - b);
const compMedian = compSamples[Math.floor(compSamples.length / 2)];
const compP95 = compSamples[Math.floor(compSamples.length * 0.95) - 1] ?? compSamples[compSamples.length - 1];
const compIndexDelta = index.fileCount - filesBeforeComp + (index.symbolCount - symbolsBeforeComp);

// ---- 4b) 悬停（T-035，规格 feature-hover：P95 < 150ms；语义 + 宏符号 + 变量三处混合） ----
const hoverPos = [
  posAt(compText, compText.indexOf('SV_Target') + 3), // 语义（函数返回值）
  posAt(compText, compText.indexOf('SAMPLE_TEXTURE2D(') + 5), // 宏符号（macroTable 兜底）
  posAt(compText, compText.indexOf('i.uv') + 1), // 变量（索引可解析）
];
provideHover(compFile, hoverPos[0].line, hoverPos[0].character, compCtx); // 预热
const hoverSamples = [];
let hoverHits = 0;
for (let k = 0; k < 21; k++) {
  const p = hoverPos[k % 3];
  const t = performance.now();
  const h = provideHover(compFile, p.line, p.character, compCtx);
  hoverSamples.push(performance.now() - t);
  if (h) hoverHits++;
}
hoverSamples.sort((a, b) => a - b);
const hoverMedian = hoverSamples[Math.floor(hoverSamples.length / 2)];
const hoverP95 = hoverSamples[Math.floor(hoverSamples.length * 0.95) - 1] ?? hoverSamples[hoverSamples.length - 1];

// ---- 5) M3 references / rename（T-033：references P95 < 500ms；rename ≤50 处 < 1s）----
// references：对补全 fixture 里的 `_MainTex` 全工程查引用（真实规模：occurrence 上限 200 截断）。
// 首次查询建 docTrees 缓存（与 F12 同一缓存），采样测的是交互态热路径；冷路径单独报告不设限。
const refCtx = { ...defCtx, log: () => {} };
const refPos = posAt(compText, compText.indexOf('_MainTex', compText.indexOf('SAMPLE_TEXTURE2D')) + 2);
const tRefCold = performance.now();
const refCold = provideReferences(compFile, refPos.line, refPos.character, refCtx, true);
const refColdMs = performance.now() - tRefCold;
const refSamples = [];
let refCount = 0;
for (let k = 0; k < 10; k++) {
  const t = performance.now();
  const r = provideReferences(compFile, refPos.line, refPos.character, refCtx, true);
  refSamples.push(performance.now() - t);
  refCount = r.length;
}
refSamples.sort((a, b) => a - b);
const refMedian = refSamples[Math.floor(refSamples.length / 2)];
const refP95 = refSamples[Math.floor(refSamples.length * 0.95) - 1] ?? refSamples[refSamples.length - 1];

// rename：在真实工程 shader 里挑一个 occurrence 数 ≤50 的 Properties 属性（预算口径），
// 只组装 WorkspaceEdit 不落盘；扫描成本与 references 同量级（全工程 occurrence 收集）。
let rnFile = null;
let rnText = '';
let rnName = null;
let rnOcc = 0;
for (const f of defTargets) {
  const props = (index.getFileSymbols(f) ?? []).filter((s) => s.kind === 'property');
  for (const p of props) {
    const n = collectOccurrences(p.name, { index, store, log: () => {} }).occurrences.length;
    if (n >= 2 && n <= 50) {
      rnFile = f;
      rnName = p.name;
      rnOcc = n;
      break;
    }
    if (!rnName && n >= 2) {
      rnFile = f;
      rnName = p.name;
      rnOcc = n; // 兜底：没有 ≤50 的，取第一个多 occurrence 的
    }
  }
  if (rnName && rnOcc <= 50) break;
}
if (rnFile) {
  rnText = fs.readFileSync(rnFile, 'utf8');
}
let rnMedian = 0;
let rnEdits = 0;
if (rnName) {
  const rnPos = posAt(rnText, rnText.indexOf(rnName) + 2);
  const rnCtx = { ...refCtx, notifyInfo: undefined };
  provideRename(rnFile, rnPos.line, rnPos.character, `${rnName}_B`, rnCtx); // 预热
  const rnSamples = [];
  for (let k = 0; k < 3; k++) {
    const t = performance.now();
    const r = provideRename(rnFile, rnPos.line, rnPos.character, `${rnName}_B`, rnCtx);
    rnSamples.push(performance.now() - t);
    rnEdits = Object.values(r?.changes ?? {}).flat().length;
  }
  rnSamples.sort((a, b) => a - b);
  rnMedian = rnSamples[1];
}

// ---- 6) M4 语法诊断（T-042：2000 行 shader 单文件 P95 < 150ms，与 hover/completion 同预算）----
// 口径与 server 的 publishNow 一致：treesForFile + computeFileDiagnostics 全算（含解析），
// 因为发布路径就是从这里取树。
const diagFile = path.join(PROJECT, 'Assets', '__bench_diagnostics.shader'); // 内存文档，不落盘
const diagText = [
  'Shader "Bench/Diagnostics"',
  '{',
  '  Properties { _MainTex("Tex", 2D) = "white" {} }',
  '  SubShader',
  '  {',
  '    Pass',
  '    {',
  '      HLSLPROGRAM',
  '      #include "UnityCG.cginc"',
  '      struct appdata { float4 vertex : POSITION; float2 uv : TEXCOORD0; };',
  '      struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };',
  ...Array.from({ length: 1985 }, (_, i) => `      float b${i} = ${i} * 2.0 + ${i};`),
  '      ENDHLSL',
  '    }',
  '  }',
  '}',
  '',
].join('\n');
store.open(diagFile, diagText);
const diagTrees = treesForFile(diagFile, diagText);
computeFileDiagnostics(diagTrees, { file: diagFile }); // 预热
const diagSamples = [];
let diagCount = 0;
for (let k = 0; k < 20; k++) {
  const t = performance.now();
  const r = computeFileDiagnostics(treesForFile(diagFile, diagText), { file: diagFile });
  diagSamples.push(performance.now() - t);
  diagCount = r.diagnostics.length;
}
diagSamples.sort((a, b) => a - b);
const diagMedian = diagSamples[Math.floor(diagSamples.length / 2)];
const diagP95 = diagSamples[Math.floor(diagSamples.length * 0.95) - 1] ?? diagSamples[diagSamples.length - 1];
const diagLines = diagText.split('\n').length;

// ---- 7) M4 死分支求值（T-048：2000 行 shader 采样 20 次 P95 < 150ms）----
// 口径 = 规格约束里的「求值 + 推送」的求值部分（推送只是一次 notification send，可忽略）。
const deadText = [
  ...Array.from(
    { length: 40 },
    (_, i) =>
      `#if DEAD_MACRO_${i}\nfloat4 dead${i}(){ return ${i}; }\n#elif UNKNOWN_${i}\nfloat4 maybe${i}(){ return 0; }\n#else\nfloat4 live${i}(){ return 1; }\n#endif`
  ),
  ...Array.from({ length: 1799 }, (_, i) => `float b${i} = ${i} * 1.5;`),
  '',
].join('\n');
const deadTree = parseHlslFile(deadText);
const deadDisabled = new Set(Array.from({ length: 40 }, (_, i) => `DEAD_MACRO_${i}`));
collectInactiveRegions(deadTree.rootNode, deadText, { disabled: deadDisabled }); // 预热
const deadSamples = [];
let deadRegionCount = 0;
for (let k = 0; k < 20; k++) {
  const t = performance.now();
  deadRegionCount = collectInactiveRegions(deadTree.rootNode, deadText, { disabled: deadDisabled }).length;
  deadSamples.push(performance.now() - t);
}
deadSamples.sort((a, b) => a - b);
const deadMedian = deadSamples[Math.floor(deadSamples.length / 2)];
const deadP95 = deadSamples[Math.floor(deadSamples.length * 0.95) - 1] ?? deadSamples[deadSamples.length - 1];

// ---- 8) 关键字轮询空转（T-048：mtime 未变不得产生可测 CPU 峰值）----
// 60 s 墙钟在 CI 里不现实，用「200 次空转轮询的 CPU 时间」等价口径：
// mtime 未变时 refresh() 只 stat 一次，不读盘不解析。
const kwLog = path.join(os.tmpdir(), `bench-keywords-${process.pid}.log`);
fs.writeFileSync(kwLog, 'Disabled keywords: A B C\n', 'utf8');
const kwSrc = new UnityKeywordSource({ logPath: kwLog });
kwSrc.refresh(true);
const cpuBefore = process.cpuUsage();
for (let k = 0; k < 200; k++) kwSrc.refresh(false);
const cpuDelta = process.cpuUsage(cpuBefore);
const cpuDeltaUs = cpuDelta.user + cpuDelta.system; // 微秒
fs.rmSync(kwLog, { force: true });

// ---- 9) M5 类型诊断：单编译单元 DXC 编译（T-058：P95 < 1500ms）----
// 口径 = 规格 feature-type-diagnostics 的约束「单个编译单元 DXC 编译 P95 < 1500ms」。
// 样本取语料里**最重的单个编译单元**（PackageCache 的 ShaderLibrary `.hlsl`，整文件一个单元）：
// 本机语料的 52 个 `.shader` 全是 CGPROGRAM、零 HLSLPROGRAM，项目侧不产编译单元（见 status/log 的语料发现）。
// dxc 不可用时该项记 `skipped`，不记 pass——门槛与基准都不能把「没测」当成「通过」。
const dxcRes = resolveDxc({ moduleDir: path.join(root, 'server', 'out') });
const dxcProbe = dxcRes.ok ? await probeDxc(dxcRes.path) : null;
let dxcStatus = 'skipped';
let dxcMedian = 0;
let dxcP95 = 0;
let dxcFile = null;
let dxcUnitLines = 0;
let dxcIssueCount = 0;
if (dxcRes.ok && dxcProbe && dxcProbe.ok) {
  const hlsl = sources
    .filter((f) => /\.hlsl$/i.test(f))
    .map((f) => ({ f, size: fs.statSync(f).size }))
    .sort((a, b) => b.size - a.size)[0];
  if (hlsl) {
    dxcFile = hlsl.f;
    const text = fs.readFileSync(hlsl.f, 'utf8');
    const prepared = prepareTypeRun(hlsl.f, text, {
      includeCtx: {
        projectRoot: PROJECT,
        cgIncludesDir: fs.existsSync(path.join(EDITOR, 'Data', 'CGIncludes'))
          ? path.join(EDITOR, 'Data', 'CGIncludes')
          : null,
        packageCacheDir: fs.existsSync(path.join(PROJECT, 'Library', 'PackageCache'))
          ? path.join(PROJECT, 'Library', 'PackageCache')
          : null,
      },
      dxcVersion: dxcProbe.version ?? null,
    });
    const unit = prepared.units[0];
    const plan = prepared.plans[0];
    if (unit && plan && plan.failures.length === 0) {
      dxcUnitLines = unit.endLine - unit.startLine + 1;
      const ac = new AbortController();
      const warm = await compileUnit({
        exePath: dxcRes.path,
        virtualText: plan.virtualText,
        macros: prepared.macros,
        includeRoots: plan.includeRoots,
        timeoutMs: 20000,
        label: 'bench-warm',
        signal: ac.signal,
      });
      dxcStatus = warm.status;
      const dxcSamples = [];
      for (let k = 0; k < 10; k++) {
        const t = performance.now();
        const r = await compileUnit({
          exePath: dxcRes.path,
          virtualText: plan.virtualText,
          macros: prepared.macros,
          includeRoots: plan.includeRoots,
          timeoutMs: 20000,
          label: `bench-${k}`,
          signal: new AbortController().signal,
        });
        dxcSamples.push(performance.now() - t);
        dxcIssueCount = r.issues.length;
        dxcStatus = r.status;
      }
      dxcSamples.sort((a, b) => a - b);
      dxcMedian = dxcSamples[Math.floor(dxcSamples.length / 2)];
      dxcP95 = dxcSamples[Math.floor(dxcSamples.length * 0.95) - 1] ?? dxcSamples[dxcSamples.length - 1];
    }
  }
}

// ---- 10) M5 格式化：2001 行文档（T-065）----
// 口径 = 规格 feature-formatting 的性能约束。两种形状都量，因为代价差一个量级：
// ① **ShaderLab 为主**（Properties + Pass + `CGPROGRAM` 原样块）= 本机语料里 `.shader` 的真实形状；
// ② **HLSL 区域为主** = 最坏情况（HLSL 正文要单独解析并建行模型，且三条硬断言要求整条流水线跑两遍）。
// 见 ADR 0013：双遍复验是硬断言 ①② 的必要代价，预算按形状分别给。
function buildFmtDoc(hlslHeavy) {
  const L = ['Shader "Bench/Big"', '{', '  Properties', '  {'];
  for (let i = 0; L.length < 504; i++) L.push(`_P${i}("P${i}", Float) = ${i % 5}`);
  L.push('  }', 'SubShader', '{', 'Pass', '{', 'Blend   SrcAlpha    OneMinusSrcAlpha');
  L.push(hlslHeavy ? 'HLSLPROGRAM' : 'CGPROGRAM');
  while (L.length < 1996) {
    const k = L.length;
    L.push(k % 7 === 0 ? `    float4 v${k} = float4(${k % 3}, 0.5, 1.0, 0.0);` : `   o += v${k - 1} * 0.5;`);
  }
  L.push(hlslHeavy ? 'ENDHLSL' : 'ENDCG', '}', '}', '}', '');
  return L.join('\n');
}
const fmtIndent = resolveIndentOptions({ tabSize: 4, insertSpaces: true });
function measureFormat(text) {
  const probe = formatDocument({ file: 'bench/big.shader', text, indent: fmtIndent, switches: DEFAULT_FORMAT_SWITCHES });
  if (probe.text === null) return { lines: 0, median: 0, p95: 0, changedBytes: 0, verbatimBytes: 0 };
  formatDocument({ file: 'bench/big.shader', text: probe.text, indent: fmtIndent, switches: DEFAULT_FORMAT_SWITCHES }); // 预热
  const s = [];
  for (let k = 0; k < 10; k++) {
    const t = performance.now();
    formatDocument({ file: 'bench/big.shader', text, indent: fmtIndent, switches: DEFAULT_FORMAT_SWITCHES });
    s.push(performance.now() - t);
  }
  s.sort((a, b) => a - b);
  return {
    lines: text.split('\n').length,
    median: s[Math.floor(s.length / 2)],
    p95: s[Math.floor(s.length * 0.95) - 1] ?? s[s.length - 1],
    changedBytes: probe.changedBytes,
    verbatimBytes: probe.verbatimBytes,
  };
}
const fmtShell = measureFormat(buildFmtDoc(false));
const fmtHlsl = measureFormat(buildFmtDoc(true));

const results = [
  { name: '冷启动全量索引', value: coldMs, limit: 3000, unit: 'ms' },
  { name: '增量编辑（中位数）', value: medianMs, limit: 100, unit: 'ms' },
  { name: '增量编辑（p95）', value: p95Ms, limit: 100, unit: 'ms' },
  { name: 'F12 转到定义（中位数）', value: defMedian, limit: 200, unit: 'ms' },
  { name: 'F12 转到定义（p95）', value: defP95, limit: 200, unit: 'ms' },
  { name: '补全（中位数）', value: compMedian, limit: 150, unit: 'ms' },
  { name: '补全（p95）', value: compP95, limit: 150, unit: 'ms' },
  { name: '悬停（中位数）', value: hoverMedian, limit: 150, unit: 'ms' },
  { name: '悬停（p95）', value: hoverP95, limit: 150, unit: 'ms' },
  { name: 'references（中位数）', value: refMedian, limit: 500, unit: 'ms' },
  { name: 'references（p95）', value: refP95, limit: 500, unit: 'ms' },
  { name: `rename（≤50 处，实测 ${rnOcc} 处）`, value: rnMedian, limit: 1000, unit: 'ms' },
  { name: `语法诊断（${diagLines} 行，中位数）`, value: diagMedian, limit: 150, unit: 'ms' },
  { name: `语法诊断（${diagLines} 行，p95）`, value: diagP95, limit: 150, unit: 'ms' },
  { name: `死分支求值（${deadText.split('\n').length} 行，中位数）`, value: deadMedian, limit: 150, unit: 'ms' },
  { name: `死分支求值（${deadText.split('\n').length} 行，p95）`, value: deadP95, limit: 150, unit: 'ms' },
  { name: '关键字轮询空转（200 次，CPU 时间）', value: cpuDeltaUs / 1000, limit: 20, unit: 'ms' },
  {
    name: `单编译单元 DXC 编译（${dxcUnitLines} 行，中位数）`,
    value: dxcMedian,
    limit: 1500,
    unit: 'ms',
    // dxc 不可用时记 null（跳过），不能让「没测」变成「通过」
    pass: dxcStatus === 'skipped' ? null : dxcMedian < 1500,
  },
  {
    name: `单编译单元 DXC 编译（${dxcUnitLines} 行，p95）`,
    value: dxcP95,
    limit: 1500,
    unit: 'ms',
    pass: dxcStatus === 'skipped' ? null : dxcP95 < 1500,
  },
  {
    name: `格式化（ShaderLab 为主 ${fmtShell.lines} 行，p95）`,
    value: fmtShell.p95,
    limit: 150,
    unit: 'ms',
    // 排版返回 null（结构不足）时记 null，不能让「没排版」变成「排得快」
    pass: fmtShell.lines === 0 ? null : fmtShell.p95 < 150,
  },
  {
    name: `格式化（HLSL 区域为主 ${fmtHlsl.lines} 行，p95）`,
    value: fmtHlsl.p95,
    limit: 250,
    unit: 'ms',
    // 最坏形状：HLSL 正文单独解析 + 双遍复验（ADR 0013）
    pass: fmtHlsl.lines === 0 ? null : fmtHlsl.p95 < 250,
  },
  { name: '补全后索引规模变化（应为 0）', value: compIndexDelta, limit: 1, unit: 'files' },
  { name: 'F12 后索引规模变化（应为 0）', value: indexDelta, limit: 1, unit: 'files' },
  { name: '索引后 RSS', value: rssAfterIndex, limit: 500, unit: 'MB' },
  { name: '结束时 RSS', value: rssEnd, limit: 500, unit: 'MB' },
].map((r) => ({ ...r, pass: 'pass' in r ? r.pass : r.value < r.limit }));

console.log(
  JSON.stringify(
    {
      files: indexed,
      symbols: index.symbolCount,
      rssBefore: +rssBefore.toFixed(1),
      definition: {
        files: defTargets.length,
        samples: defSamples.length,
        hits: defHits,
      },
      completion: {
        samples: compSamples.length,
        hits: compHits,
      },
      hover: {
        samples: hoverSamples.length,
        hits: hoverHits,
      },
      references: {
        samples: refSamples.length,
        returned: refCount,
        coldFirstQueryMs: +refColdMs.toFixed(1),
        coldReturned: refCold.length,
      },
      rename: {
        symbol: rnName,
        occurrences: rnOcc,
        edits: rnEdits,
      },
      diagnostics: {
        lines: diagLines,
        samples: diagSamples.length,
        diagnostics: diagCount,
        median: +diagMedian.toFixed(2),
        p95: +diagP95.toFixed(2),
      },
      deadBranch: {
        lines: deadText.split('\n').length,
        regions: deadRegionCount,
        samples: deadSamples.length,
        median: +deadMedian.toFixed(2),
        p95: +deadP95.toFixed(2),
        keywordIdleCpuMs: +(cpuDeltaUs / 1000).toFixed(2),
      },
      typeDiagnostics: {
        dxc: dxcRes.ok ? dxcRes.source : `missing:${dxcRes.reason}`,
        version: dxcProbe && dxcProbe.ok ? dxcProbe.version : null,
        sampleFile: dxcFile,
        unitLines: dxcUnitLines,
        status: dxcStatus,
        issues: dxcIssueCount,
        median: +dxcMedian.toFixed(2),
        p95: +dxcP95.toFixed(2),
      },
      formatting: {
        shellShaped: {
          lines: fmtShell.lines,
          changedBytes: fmtShell.changedBytes,
          verbatimBytes: fmtShell.verbatimBytes,
          median: +fmtShell.median.toFixed(2),
          p95: +fmtShell.p95.toFixed(2),
        },
        hlslHeavy: {
          lines: fmtHlsl.lines,
          changedBytes: fmtHlsl.changedBytes,
          verbatimBytes: fmtHlsl.verbatimBytes,
          median: +fmtHlsl.median.toFixed(2),
          p95: +fmtHlsl.p95.toFixed(2),
        },
      },
      results: results.map((r) => ({
        name: r.name,
        value: +r.value.toFixed(2),
        limit: r.limit,
        pass: r.pass,
      })),
    },
    null,
    2
  )
);

const failed = results.filter((r) => r.pass === false);
const skipped = results.filter((r) => r.pass === null);
if (skipped.length) {
  console.error('bench SKIPPED（环境缺件，不计入通过）: ' + skipped.map((s) => s.name).join('; '));
}
if (failed.length) {
  console.error('bench FAILED: ' + failed.map((f) => `${f.name}=${f.value.toFixed(1)} (limit ${f.limit}${f.unit})`).join('; '));
  process.exit(1);
}
console.log('bench PASS');
