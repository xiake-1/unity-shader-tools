/** T-057 · 类型诊断零误报门槛（roadmap M5 第二条验收的测法，规格 feature-type-diagnostics 范围 13）
 *
 * 断言：三源语料上**类型诊断总数 = 0**（豁免命中不算误报）。
 * 同时打印**逐错误签名**聚合表（签名 = 归一化消息 + 可选 `-W` flag；实测 DXC 语义错误无错误码）
 * 与逐条豁免命中，并断言**每条豁免命中 > 0**（宏表/豁免表修好后删行，防豁免变永久债）。
 *
 * 与 `gate:diagnostics` 的关键差异（规格范围 11）：门槛统计**不按「当前文档」过滤** ——
 * include 闭包内（内置/包内）报出的错误不推给用户，但**计入门槛统计与豁免命中**。
 *
 * 语料缺失或本机 `dxc` 不可用 → `SKIP + 原因` 退出 0，绝不记 PASS（规格约束）。
 * 语料与 `gate:diagnostics` / `audit:errors` 共用 `corpus.mjs` 的同一 `collectCorpus`（不造第三套）。
 *
 * 用法：npm run gate:type-diagnostics  （--json 机器可读；--limit N 只跑前 N 个文件，迭代用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareTypeRun, computeTypeDiagnostics } from '../../server/out/typeDiagnostics.js';
import {
  DxcExemptionTable,
  DEFAULT_DXC_EXEMPTIONS,
} from '../../server/out/dxcExemption.js';
import { resolveDxc, probeDxc } from '../../server/out/dxcRunner.js';
import { isGeneratedFile } from '../../server/out/tempFiles.js';
import { collectCorpus, cgIncludesDir, PROJECT, EDITOR } from './corpus.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const asJson = process.argv.includes('--json');
const limitIdx = process.argv.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : Infinity;

const skip = (reason) => {
  if (asJson) console.log(JSON.stringify({ skip: true, reason }, null, 2));
  else console.log(`gate SKIP: ${reason}`);
  process.exit(0);
};

const groups = collectCorpus();
let selected = Object.values(groups).flat().filter((f) => !isGeneratedFile(f));
if (selected.length === 0) skip('语料缺失（设 BENCH_PROJECT / BENCH_EDITOR）');
if (Number.isFinite(limit) && limit > 0) selected = selected.slice(0, limit);
const wanted = new Set(selected);

const dxc = resolveDxc({ moduleDir: path.join(root, 'server', 'out') });
if (!dxc.ok) skip(`dxc 不可用：${dxc.reason} — ${dxc.detail}`);
const probe = await probeDxc(dxc.path);
if (!probe.ok) skip(`dxc 无法加载：${probe.reason} — ${probe.detail}`);
const dxcVersion = probe.version ?? 'unknown';

const includeCtx = {
  projectRoot: fs.existsSync(PROJECT) ? PROJECT : null,
  cgIncludesDir: cgIncludesDir(),
  packageCacheDir: fs.existsSync(path.join(PROJECT, 'Library', 'PackageCache'))
    ? path.join(PROJECT, 'Library', 'PackageCache')
    : null,
};

const table = new DxcExemptionTable();
/** 逐错误签名聚合：签名 = 归一化消息 + 可选 `-W` flag */
const signatures = new Map();
let total = 0;
let units = 0;
let compiled = 0;
let includeFailTotal = 0;
let unparsedTotal = 0;
let filesWithFailures = 0;
const perGroup = {};

const t0 = performance.now();
for (const [group, list] of Object.entries(groups)) {
  let n = 0;
  for (const f of list) {
    if (!wanted.has(f)) continue;
    if (isGeneratedFile(f)) continue;
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    n++;
    const prepared = prepareTypeRun(f, text, { includeCtx, dxcVersion });
    units += prepared.units.length;
    if (prepared.includeFailures.length) includeFailTotal += prepared.includeFailures.length;
    if (!prepared.units.length) continue;
    const res = await computeTypeDiagnostics(prepared, {
      file: f,
      text,
      dxc,
      onlyCurrentDocument: false, // 规格范围 11：闭包内错误计入门槛统计
      exemptions: table,
      onIssue: (issue, normalized, exempted) => {
        if (exempted) return;
        const sig = `${normalized}${issue.code ? ` [${issue.code}]` : ''}`;
        let m = signatures.get(sig);
        if (!m) {
          m = { signature: sig, code: issue.code, count: 0, samples: [], files: new Set() };
          signatures.set(sig, m);
        }
        m.count++;
        if (m.samples.length < 3) m.samples.push(issue.message);
        m.files.add(path.relative(root, f));
      },
    });
    compiled += res.counts.compiled;
    unparsedTotal += res.counts.unparsed;
    total += res.diagnostics.length;
    if (res.diagnostics.length) {
      filesWithFailures++;
      if (process.env.DXC_GATE_VERBOSE) {
        console.log(`  ${path.relative(root, f)}: ${res.diagnostics.length} 条`);
        for (const d of res.diagnostics.slice(0, 5)) {
          console.log(`      ${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}`);
        }
      }
    }
  }
  perGroup[group] = n;
}
const ms = Math.round(performance.now() - t0);

const unusedRules = DEFAULT_DXC_EXEMPTIONS.filter((r) => (table.hitsById.get(r.id) ?? 0) === 0);

// 默认值联动：PASS → configurationDefaults 里 unityShader.typeDiagnostics 应为 true；FAIL → false/缺省
const pkgPath = path.join(root, 'client', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const declaredDefault = pkg?.contributes?.configurationDefaults?.['unityShader.typeDiagnostics'];
const pass = total === 0;
const expectedDefault = pass ? true : false;
const defaultMismatch = declaredDefault !== expectedDefault;

const result = {
  pass,
  dxc: { path: dxc.path, source: dxc.source, version: dxcVersion },
  ms,
  scanned: Object.values(perGroup).reduce((a, b) => a + b, 0),
  perGroup,
  units,
  compiled,
  unparsed: unparsedTotal,
  includeFailures: includeFailTotal,
  filesWithTypeDiagnostics: filesWithFailures,
  typeDiagnosticsTotal: total,
  exemptionHits: Object.fromEntries(table.hitsById),
  unusedExemptionRules: unusedRules.map((r) => r.id),
  signatures: [...signatures.values()]
    .map((m) => ({
      signature: m.signature,
      count: m.count,
      fileCount: m.files.size,
      files: [...m.files].slice(0, 5),
      samples: m.samples,
    }))
    .sort((a, b) => b.count - a.count),
  configurationDefaults: { declared: declaredDefault ?? null, expected: expectedDefault, mismatch: defaultMismatch },
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`dxc: ${dxc.source} ${dxc.path} version=${dxcVersion}`);
  console.log(
    `语料 ${result.scanned} 文件（project=${perGroup.project} packageCache=${perGroup.packageCache} cgIncludes=${perGroup.cgIncludes}）` +
      ` / 编译单元 ${units} / 实际编译 ${compiled} / ${ms}ms`
  );
  console.log(`类型诊断总数 = ${total}   include-fail=${includeFailTotal}   unparsed=${unparsedTotal}`);
  console.log(`\n豁免命中（共 ${DEFAULT_DXC_EXEMPTIONS.length} 条规则）：`);
  for (const r of DEFAULT_DXC_EXEMPTIONS) {
    const n = table.hitsById.get(r.id) ?? 0;
    console.log(`  ${n > 0 ? '✓' : '✗'} ${r.id.padEnd(38)} hits=${String(n).padStart(5)}  ${r.reason.split('不豁免')[0].trim().slice(0, 56)}`);
  }
  if (unusedRules.length) {
    console.log(`\n⚠ 零命中豁免行（语料已不再报该错 → 删行）：${unusedRules.map((r) => r.id).join(', ')}`);
  }
  if (signatures.size) {
    console.log(`\n未豁免的类型诊断（逐错误签名，共 ${signatures.size} 种）：`);
    for (const m of result.signatures.slice(0, 25)) {
      console.log(`  count=${String(m.count).padStart(5)} files=${String(m.fileCount).padStart(3)}  ${m.signature}`);
      for (const f of m.files.slice(0, 3)) console.log(`        ${f}`);
      for (const s of m.samples.slice(0, 1)) console.log(`        e.g. ${s.slice(0, 140)}`);
    }
  }
  console.log(
    `\nconfigurationDefaults unityShader.typeDiagnostics: declared=${JSON.stringify(
      result.configurationDefaults.declared
    )} expected=${expectedDefault}${defaultMismatch ? '  ⚠ 不一致' : ''}`
  );
  console.log(`\ngate ${pass ? 'PASS' : 'FAIL'}: 类型诊断总数 ${total}（要求 0）`);
}

if (!pass || defaultMismatch || unusedRules.length) process.exit(1);
