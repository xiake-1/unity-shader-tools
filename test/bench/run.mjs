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

const results = [
  { name: '冷启动全量索引', value: coldMs, limit: 3000, unit: 'ms' },
  { name: '增量编辑（中位数）', value: medianMs, limit: 100, unit: 'ms' },
  { name: '增量编辑（p95）', value: p95Ms, limit: 100, unit: 'ms' },
  { name: 'F12 转到定义（中位数）', value: defMedian, limit: 200, unit: 'ms' },
  { name: 'F12 转到定义（p95）', value: defP95, limit: 200, unit: 'ms' },
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
