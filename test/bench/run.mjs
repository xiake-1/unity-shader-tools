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
  { name: '补全后索引规模变化（应为 0）', value: compIndexDelta, limit: 1, unit: 'files' },
  { name: 'F12 后索引规模变化（应为 0）', value: indexDelta, limit: 1, unit: 'files' },
  { name: '索引后 RSS', value: rssAfterIndex, limit: 500, unit: 'MB' },
  { name: '结束时 RSS', value: rssEnd, limit: 500, unit: 'MB' },
].map((r) => ({ ...r, pass: r.value < r.limit }));

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

const failed = results.filter((r) => !r.pass);
if (failed.length) {
  console.error('bench FAILED: ' + failed.map((f) => `${f.name}=${f.value.toFixed(1)} (limit ${f.limit}${f.unit})`).join('; '));
  process.exit(1);
}
console.log('bench PASS');
