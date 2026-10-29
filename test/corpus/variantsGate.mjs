/** T-072 · 变体分析语料门槛（`npm run gate:variants`）
 *
 * 三条断言：
 * ① **夹具自检**（`test/corpus/fixtures/variants/`，不依赖本机 Unity）：显式组 4、内置组条目 3、
 *    组合数 48、pass 2、`mat-mapped=2`、`mat-unmapped=1`、`material-evidence=present`、建议 3 条。
 *    —— 门槛逻辑本身必须有确定性验证，不能只靠本机语料。
 * ② **计数与独立 grep 一致**：三源语料上 CST 得到的显式/内置 pragma 数，必须与直接扫原文的正则一致
 *    （两条实现互为对照；CST 是权威口径，正则只当探针）。
 * ③ **不二次 parse**：`analyzeVariants` 自身的 parse 增量必须为 0（复用同一棵树），
 *    门槛全程的 parse 总数不得超过「索引一遍」的成本。
 *
 * 语料缺失 → `SKIP + 原因` 退出 0，绝不记 PASS（沿用其它门槛的口径）。
 * 用法：npm run gate:variants  （--json 机器可读；--limit N 只跑前 N 个文件）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShaderLab, parseHlslFile, extractProgramBodies, buildVirtualHlsl, parseStats } from '../../server/out/parser.js';
import { analyzeVariants, variantSummaryLine } from '../../server/out/variantReport.js';
import { collectMaterialSources, materialScanLine, scanMaterials, suggestStripping } from '../../server/out/materialScan.js';
import { isGeneratedFile } from '../../server/out/tempFiles.js';
import { collectCorpus, PROJECT, EDITOR } from './corpus.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures', 'variants');

const asJson = process.argv.includes('--json');
const limitIdx = process.argv.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : Infinity;

const HLSL_EXT = /\.(hlsl|hlslinc|cginc|compute|raytrace)$/i;

/** 独立探针：直接扫原文数 pragma（与 CST 实现互为对照） */
const EXPLICIT_RE = /^[ \t]*#[ \t]*pragma[ \t]+(multi_compile|shader_feature|multi_compile_local|shader_feature_local)([ \t]|$)/gm;
const BUILTIN_RE = /^[ \t]*#[ \t]*pragma[ \t]+(multi_compile|shader_feature)_\w+/gm;

function treesFor(file, text) {
  if (HLSL_EXT.test(file)) {
    const hlsl = parseHlslFile(text);
    return { labRoot: hlsl.rootNode, hlslRoot: hlsl.rootNode };
  }
  const lab = parseShaderLab(text);
  const virtual = buildVirtualHlsl(text, extractProgramBodies(lab, text));
  const hlsl = virtual.trim().length > 0 ? parseHlslFile(virtual) : null;
  return { labRoot: lab.rootNode, hlslRoot: hlsl ? hlsl.rootNode : null };
}

const problems = [];
const fail = (msg) => problems.push(msg);

/* ---------------- ① 夹具自检 ---------------- */

function readFixtureShaders() {
  const out = [];
  const stack = [path.join(FIXTURES, 'Assets')];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (/\.shader$/.test(e.name)) out.push(full);
    }
  }
  return out.sort();
}

const fixtureShaders = readFixtureShaders();
if (fixtureShaders.length < 2) fail(`夹具缺失：${FIXTURES} 只找到 ${fixtureShaders.length} 个 .shader`);

const fixtureEntries = [];
for (const f of fixtureShaders) {
  const text = fs.readFileSync(f, 'utf8');
  const t = treesFor(f, text);
  fixtureEntries.push(...analyzeVariants(t.labRoot, f, t.hlslRoot));
}
const explicitFixture = fixtureEntries.find((e) => e.shaderName === 'Gate/Variants/Explicit');
if (!explicitFixture) {
  fail('夹具：没解析出 `Shader "Gate/Variants/Explicit"`');
} else {
  if (explicitFixture.groups.length !== 4) fail(`夹具：显式组应 4，实得 ${explicitFixture.groups.length}`);
  if (explicitFixture.builtin.length !== 2) fail(`夹具：内置组应 2，实得 ${explicitFixture.builtin.length}`);
  if (explicitFixture.combinations !== 48) fail(`夹具：组合数应 48（4×3×2×2），实得 ${explicitFixture.combinations}`);
  if (explicitFixture.passCount !== 2) fail(`夹具：pass 数应 2，实得 ${explicitFixture.passCount}`);
  if (!variantSummaryLine(explicitFixture).includes('builtin-groups=2')) fail('夹具：摘要行缺 `builtin-groups=2`');
  if (!variantSummaryLine(explicitFixture).includes('unavailable')) fail('夹具：摘要行缺 `unavailable`');
}
const fallbackFixture = fixtureEntries.find((e) => e.shaderName === 'Gate/Variants/FallbackTarget');
if (!fallbackFixture) fail('夹具：没解析出 `Shader "Gate/Variants/FallbackTarget"`');

const fixtureSources = collectMaterialSources(FIXTURES);
const fixtureScan = scanMaterials(fixtureSources.materials, fixtureSources.metas);
if (fixtureScan.mapped !== 2) fail(`夹具：mat-mapped 应 2，实得 ${fixtureScan.mapped}`);
if (fixtureScan.unmapped !== 1) fail(`夹具：mat-unmapped 应 1，实得 ${fixtureScan.unmapped}`);
if (fixtureScan.evidence !== 'present') fail(`夹具：material-evidence 应 present，实得 ${fixtureScan.evidence}`);
if (!fixtureScan.defaultVariantInUse) fail('夹具：应有一个无关键字材质（默认变体在用）');
const fixtureSug = suggestStripping(fixtureEntries, fixtureScan);
if (fixtureSug.suggestions.length !== 3) fail(`夹具：建议应 3 条，实得 ${fixtureSug.suggestions.length}`);
// 内置组永远不进建议（建议只来自显式组；`shader_feature_local` 这类合法 directive 里也有下划线，
// 所以断言按「directive 必须是四个显式名之一」写，不按有没有下划线写）
const EXPLICIT_NAMES = new Set(['multi_compile', 'multi_compile_local', 'shader_feature', 'shader_feature_local']);
if (fixtureSug.suggestions.some((s) => !EXPLICIT_NAMES.has(s.directive))) fail('夹具：建议里出现了非显式组');

/* ---------------- ② + ③ 语料 ---------------- */

const groups = collectCorpus();
const corpus = Object.values(groups).flat().filter((f) => !isGeneratedFile(f));
const skipped = corpus.length === 0;
const selected = Number.isFinite(limit) && limit > 0 ? corpus.slice(0, limit) : corpus;

const perSource = { project: { files: 0, explicit: 0, builtin: 0 }, packageCache: { files: 0, explicit: 0, builtin: 0 }, cgIncludes: { files: 0, explicit: 0, builtin: 0 } };
const builtinNameTally = new Map();
let cstExplicit = 0;
let cstBuiltin = 0;
let mismatched = 0;

const parseBeforeIndex = { ...parseStats };
for (const [source, files] of Object.entries(
  Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, Number.isFinite(limit) && limit > 0 ? v.slice(0, limit) : v]))
)) {
  for (const f of files) {
    if (!selected.includes(f)) continue;
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const t = treesFor(f, text);
    const entries = analyzeVariants(t.labRoot, f, t.hlslRoot);
    const e = entries.reduce((n, x) => n + x.groups.length, 0);
    const b = entries.reduce((n, x) => n + x.builtin.reduce((m, g) => m + g.count, 0), 0);
    perSource[source].files++;
    perSource[source].explicit += e;
    perSource[source].builtin += b;
    cstExplicit += e;
    cstBuiltin += b;
    for (const x of entries) for (const g of x.builtin) builtinNameTally.set(g.name, (builtinNameTally.get(g.name) ?? 0) + g.count);

    // ② 与独立 grep 对照
    const grepExplicit = (text.match(EXPLICIT_RE) ?? []).length;
    const grepBuiltin = (text.match(BUILTIN_RE) ?? []).length;
    if (grepExplicit !== e || grepBuiltin !== b) {
      mismatched++;
      fail(`计数不一致：${f} CST=${e}/${b} grep=${grepExplicit}/${grepBuiltin}`);
    }
  }
}
const parseAfter = { shaderlab: parseStats.shaderlab - parseBeforeIndex.shaderlab, hlsl: parseStats.hlsl - parseBeforeIndex.hlsl };
const totalParses = parseAfter.shaderlab + parseAfter.hlsl;
// ③ 每个文件最多「外壳一次 + HLSL 一次」；分析段复用同一棵树 → 不得出现第三次数
if (totalParses > selected.length * 2) {
  fail(`parse 计数超标：${selected.length} 个文件却 parse 了 ${totalParses} 次（外壳+HLSL 上限 ${selected.length * 2}）`);
}

/* ---------------- 输出 ---------------- */

const payload = {
  skip: skipped || undefined,
  reason: skipped ? `语料缺失（设 BENCH_PROJECT / BENCH_EDITOR；当前 ${PROJECT} / ${EDITOR}）` : undefined,
  fixture: {
    shaders: fixtureEntries.length,
    explicitGroups: fixtureEntries.reduce((n, x) => n + x.groups.length, 0),
    builtinGroups: fixtureEntries.reduce((n, x) => n + x.builtin.length, 0),
    matMapped: fixtureScan.mapped,
    matUnmapped: fixtureScan.unmapped,
    materialEvidence: fixtureScan.evidence,
    suggestions: fixtureSug.suggestions.length,
  },
  corpus: {
    files: selected.length,
    perSource,
    cstExplicit,
    cstBuiltin,
    builtinNames: Object.fromEntries([...builtinNameTally.entries()].sort((a, b) => b[1] - a[1])),
    grepMismatched: mismatched,
    parses: parseAfter,
  },
  problems,
  pass: problems.length === 0,
};

if (asJson) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  if (skipped) {
    console.log(`gate SKIP: ${payload.reason}`);
    process.exit(0);
  }
  console.log(`夹具：shader ${payload.fixture.shaders}，显式组 ${payload.fixture.explicitGroups}，内置组 ${payload.fixture.builtinGroups}，材质 mapped=${payload.fixture.matMapped} unmapped=${payload.fixture.matUnmapped} evidence=${payload.fixture.materialEvidence}，建议 ${payload.fixture.suggestions} 条`);
  console.log(`语料：${selected.length} 文件（工程 ${perSource.project.files} / 包内 ${perSource.packageCache.files} / 内置 ${perSource.cgIncludes.files}）`);
  console.log(`  显式组 ${cstExplicit}，内置组 ${cstBuiltin}，与 grep 不一致 ${mismatched} 个文件`);
  console.log(`  内置组分布：${Object.entries(payload.corpus.builtinNames).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`  parse：外壳 ${parseAfter.shaderlab} + HLSL ${parseAfter.hlsl}（上限 ${selected.length * 2}）`);
  console.log(materialScanLine(fixtureScan));
  if (problems.length) {
    for (const p of problems) console.log(`  ✗ ${p}`);
    console.log(`gate FAIL：${problems.length} 项`);
    process.exit(1);
  }
  console.log('gate PASS');
}
process.exit(problems.length ? 1 : 0);
