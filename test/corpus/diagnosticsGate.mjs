/** T-041 · 语法诊断零误报门槛（roadmap M4 第二条验收的测法，ADR 0009 第三层）
 *
 * 断言：真实语料上**语法诊断总数 = 0**（豁免表命中不算误报，未命中的 ERROR/MISSING 才算）。
 * 同时给出逐模式聚合表与逐条豁免命中计数，并断言**每条豁免命中 > 0**
 * （grammar 修好后豁免行不再命中 → 这里失败，提示删行，防豁免表变成永久债）。
 * 语料缺失 → `SKIP + 原因` 退出 0，绝不记 PASS（规格约束）。
 *
 * 语料与聚合口径与 test/corpus/errorAudit.mjs 完全共用（同一 treesForFile、同一签名函数）。
 * 用法：npm run gate:diagnostics  （--json 输出机器可读结果）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { treesForFile, computeFileDiagnostics, diagnosticLogLine } from '../../server/out/diagnostics.js';
import { ExemptionTable, DEFAULT_EXEMPTIONS, contextOf, normalizeShape } from '../../server/out/errorExemption.js';
import { collectErrorNodes } from '../../server/out/parser.js';
import { isGeneratedFile } from '../../server/out/tempFiles.js';
import { collectCorpus } from './corpus.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

/** 未豁免错误的签名：与 errorAudit 的签名同构（message + 祖先链 + 归一化形状） */
function signatureOf(node) {
  const ctx = contextOf(node);
  const chain = [];
  let p = node.parent;
  for (let i = 0; p && i < 3; i++) {
    chain.push(p.type);
    p = p.parent;
  }
  const kind = ctx.isMissing ? `MISSING:${ctx.missingToken}` : 'ERROR';
  return `${kind}[parent=${chain[0] ?? 'root'};chain=${chain.join('<')};shape=${normalizeShape(ctx.text)}]`;
}

const asJson = process.argv.includes('--json');
const groups = collectCorpus();
const files = Object.values(groups).flat().filter((f) => !isGeneratedFile(f));
if (files.length === 0) {
  console.log('gate SKIP: 语料缺失（设 BENCH_PROJECT / BENCH_EDITOR）');
  process.exit(0);
}

const table = new ExemptionTable();
const remaining = new Map();
const includeWarnings = new Map();
let syntaxTotal = 0;
let includeTotal = 0;
let scanned = 0;
const perGroup = {};

const t0 = performance.now();
for (const [group, list] of Object.entries(groups)) {
  let n = 0;
  for (const f of list) {
    if (isGeneratedFile(f)) continue;
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    scanned++;
    n++;
    const trees = treesForFile(f, text);
    const res = computeFileDiagnostics(trees, { file: f, exemptions: table });
    for (const d of res.diagnostics) {
      if (d.severity === 2) {
        includeTotal++;
        includeWarnings.set(path.relative(root, f), (includeWarnings.get(path.relative(root, f)) ?? 0) + 1);
        continue;
      }
      syntaxTotal++;
      // 逐模式聚合：用同一棵树重新取节点签名（诊断本身不带 CST）
      let sig = '(unmapped)';
      for (const t of trees) {
        for (const { node } of collectErrorNodes(t.tree.rootNode, true)) {
          if (!table.matches(contextOf(node, f))) {
            sig = signatureOf(node);
            break;
          }
        }
        if (sig !== '(unmapped)') break;
      }
      let m = remaining.get(sig);
      if (!m) {
        m = { signature: sig, count: 0, files: new Set() };
        remaining.set(sig, m);
      }
      m.count++;
      m.files.add(path.relative(root, f));
    }
  }
  perGroup[group] = n;
}
const ms = Math.round(performance.now() - t0);

// 逐条豁免命中断言（冗余可发现）
const unusedRules = DEFAULT_EXEMPTIONS.filter((r) => (table.hitsById.get(r.id) ?? 0) === 0);

// 默认值联动：门槛 PASS → configurationDefaults 里 unityShader.syntaxDiagnostics 应为 true；FAIL → 应为 false/缺省
const pkgPath = path.join(root, 'client', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const declaredDefault = pkg?.contributes?.configurationDefaults?.['unityShader.syntaxDiagnostics'];
const pass = syntaxTotal === 0;
const expectedDefault = pass ? true : false;
const defaultMismatch = declaredDefault !== expectedDefault;

const result = {
  pass,
  ms,
  scanned,
  perGroup,
  syntaxDiagnosticsTotal: syntaxTotal,
  includeWarningsTotal: includeTotal,
  exemptionHits: Object.fromEntries(table.hitsById),
  unusedExemptionRules: unusedRules.map((r) => r.id),
  remainingModes: [...remaining.values()]
    .map((m) => ({ signature: m.signature, count: m.count, files: [...m.files].slice(0, 5), fileCount: m.files.size }))
    .sort((a, b) => b.count - a.count),
  configurationDefaults: { declared: declaredDefault ?? null, expected: expectedDefault, mismatch: defaultMismatch },
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`语料 ${scanned} 文件（project=${perGroup.project} packageCache=${perGroup.packageCache} cgIncludes=${perGroup.cgIncludes}）/ ${ms}ms`);
  console.log(`语法诊断总数 = ${syntaxTotal}   include Warning = ${includeTotal}`);
  console.log(`\n豁免命中（共 ${DEFAULT_EXEMPTIONS.length} 条规则）：`);
  for (const r of DEFAULT_EXEMPTIONS) {
    const n = table.hitsById.get(r.id) ?? 0;
    console.log(`  ${n > 0 ? '✓' : '✗'} ${r.id.padEnd(34)} hits=${String(n).padStart(4)}  ${r.reason.split('不修')[0].trim().slice(0, 60)}`);
  }
  if (unusedRules.length) {
    console.log(`\n⚠ 零命中豁免行（grammar 已修或语料无样本 → 删行）：${unusedRules.map((r) => r.id).join(', ')}`);
  }
  if (remaining.size) {
    console.log(`\n未豁免的语法诊断（逐模式，共 ${remaining.size} 种）：`);
    for (const m of result.remainingModes.slice(0, 25)) {
      console.log(`  count=${String(m.count).padStart(4)} files=${String(m.fileCount).padStart(3)}  ${m.signature}`);
      for (const f of m.files.slice(0, 3)) console.log(`        ${f}`);
    }
  }
  console.log(`\nconfigurationDefaults unityShader.syntaxDiagnostics: declared=${JSON.stringify(result.configurationDefaults.declared)} expected=${expectedDefault}${defaultMismatch ? '  ⚠ 不一致' : ''}`);
  console.log(`\ngate ${pass ? 'PASS' : 'FAIL'}: 语法诊断总数 ${syntaxTotal}（要求 0）`);
}

if (!pass || defaultMismatch || unusedRules.length) process.exit(1);
