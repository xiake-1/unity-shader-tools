/** T-064 · 格式化门槛（roadmap M5 第三条验收的测法，规格 feature-formatting 范围 8/9）
 *
 * 对三源语料逐文件断言三条硬口径：
 * ① 幂等（对输出再排一次字节相同）；
 * ② token 序列不变（同一 grammar 重新解析后的叶子 token 逐项相同）；
 * ③ 仅空白变化（逐行 strip 空白后逐行相同；两侧先丢掉空行 → 空行折叠不算内容变化）。
 *
 * 防「门槛被掏空」（ADR 0009 的同一条纪律）：断言**实际排成的文件数 > 0** 且**实际改动数 > 0**，
 * 否则一个「什么都返回 null」的打印器也能 PASS。跳过原因逐个列计数，不静默。
 *
 * 语料缺失 → `SKIP + 原因` 退出 0，绝不记 PASS。
 * 与 `gate:diagnostics` / `gate:type-diagnostics` 共用 `corpus.mjs` 的同一 `collectCorpus`。
 *
 * 用法：npm run gate:format  （--json 机器可读；--limit N 只跑前 N 个文件，迭代用；--show 打印违规样本）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatDocument, formatSkipReason } from '../../server/out/formatter.js';
import { DEFAULT_FORMAT_SWITCHES, resolveIndentOptions } from '../../server/out/formatSettings.js';
import { parseShaderLab, parseHlslFile, walk } from '../../server/out/parser.js';
import { isGeneratedFile } from '../../server/out/tempFiles.js';
import { collectCorpus } from './corpus.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const asJson = process.argv.includes('--json');
const show = process.argv.includes('--show');
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

const indent = resolveIndentOptions({ tabSize: 4, insertSpaces: true });
const HLSL_EXT = /\.(hlsl|hlslinc)$/i;

const tokensOf = (file, text) => {
  const tree = HLSL_EXT.test(file) ? parseHlslFile(text) : parseShaderLab(text);
  const out = [];
  walk(tree.rootNode, (n) => {
    if (n.children.length === 0) out.push(`${n.type}\u0000${n.text}`);
  });
  return out;
};

const lineContent = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');

const violations = [];
const skipReasons = new Map();
let formatted = 0;
let changedCount = 0;
let verbatimLinesTotal = 0;
let verbatimBytesTotal = 0;
const perGroup = {};

const t0 = Date.now();
for (const f of selected) {
  const text = fs.readFileSync(f, 'utf8');
  const group = Object.entries(groups).find(([, list]) => list.includes(f))?.[0] ?? 'other';
  perGroup[group] = perGroup[group] ?? { files: 0, formatted: 0, skipped: 0, changed: 0 };
  perGroup[group].files++;

  const skipReason = formatSkipReason(f, text);
  if (skipReason) {
    skipReasons.set(skipReason, (skipReasons.get(skipReason) ?? 0) + 1);
    perGroup[group].skipped++;
    continue;
  }
  const out = formatDocument({ file: f, text, indent, switches: DEFAULT_FORMAT_SWITCHES });
  if (out.text === null) {
    skipReasons.set(out.reason, (skipReasons.get(out.reason) ?? 0) + 1);
    perGroup[group].skipped++;
    if (show) violations.push({ file: f, check: 'skip', detail: out.reason });
    continue;
  }
  formatted++;
  perGroup[group].formatted++;
  verbatimLinesTotal += out.verbatimLines;
  verbatimBytesTotal += out.verbatimBytes;
  if (out.text !== text) {
    changedCount++;
    perGroup[group].changed++;
  }

  // ① 幂等
  const again = formatDocument({ file: f, text: out.text, indent, switches: DEFAULT_FORMAT_SWITCHES });
  if (again.text !== out.text) {
    violations.push({ file: f, check: '①幂等', detail: again.reason ?? 'second-pass-differs' });
    continue;
  }
  // ② token 序列不变
  const a = tokensOf(f, text);
  const b = tokensOf(f, out.text);
  if (a.length !== b.length) {
    let at = a.length;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        at = i;
        break;
      }
    }
    violations.push({
      file: f,
      check: '②token',
      detail: `len ${a.length}→${b.length} first-diff@${at} ${JSON.stringify((a[at] ?? '').slice(0, 60))} vs ${JSON.stringify((b[at] ?? '').slice(0, 60))}`,
    });
    continue;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      violations.push({
        file: f,
        check: '②token',
        detail: `first-diff@${i} ${JSON.stringify(a[i].slice(0, 60))} vs ${JSON.stringify(b[i].slice(0, 60))}`,
      });
      break;
    }
  }
  // ③ 仅空白变化
  const la = lineContent(text);
  const lb = lineContent(out.text);
  if (la.length !== lb.length) {
    violations.push({ file: f, check: '③仅空白', detail: `非空行数 ${la.length}→${lb.length}` });
    continue;
  }
  for (let i = 0; i < la.length; i++) {
    if (la[i] !== lb[i]) {
      violations.push({ file: f, check: '③仅空白', detail: `第 ${i + 1} 个非空行 ${JSON.stringify(la[i].slice(0, 60))} → ${JSON.stringify(lb[i].slice(0, 60))}` });
      break;
    }
  }
}
const elapsed = Date.now() - t0;

// 门槛与能力注册联动（范围 9）：默认值必须与门槛结果一致
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'client', 'package.json'), 'utf8'));
const declaredDefault = pkg?.contributes?.configurationDefaults?.['unityShader.formatting.enable'];

const gatePass =
  violations.length === 0 &&
  formatted > 0 &&
  changedCount > 0 &&
  !skipReasons.has('token-sequence-changed') &&
  !skipReasons.has('not-idempotent') &&
  !skipReasons.has('line-content-changed');

const report = {
  files: selected.length,
  formatted,
  changed: changedCount,
  skipped: Object.fromEntries(skipReasons),
  verbatimLines: verbatimLinesTotal,
  verbatimBytes: verbatimBytesTotal,
  violations: violations.length,
  elapsedMs: elapsed,
  perGroup,
  configurationDefaults: { declared: declaredDefault, expected: gatePass },
};

if (asJson) {
  console.log(JSON.stringify({ ...report, violations: violations.slice(0, 40) }, null, 2));
} else {
  console.log(`语料 ${selected.length} 文件 / 排成 ${formatted} / 实际改动 ${changedCount} / ${elapsed}ms`);
  console.log(`跳过原因: ${skipReasons.size ? [...skipReasons].map(([k, v]) => `${k}=${v}`).join('  ') : '无'}`);
  console.log(`原样区: 行=${verbatimLinesTotal} 字节=${verbatimBytesTotal}`);
  for (const [g, s] of Object.entries(perGroup)) {
    console.log(`  ${g}: files=${s.files} formatted=${s.formatted} skipped=${s.skipped} changed=${s.changed}`);
  }
  if (violations.length) {
    console.log(`违规 ${violations.length} 条：`);
    for (const v of violations.slice(0, show ? violations.length : 15)) {
      console.log(`  [${v.check}] ${path.relative(root, v.file)} :: ${v.detail}`);
    }
  }
  console.log(
    `configurationDefaults unityShader.formatting.enable: declared=${declaredDefault} expected=${gatePass}`
  );
}

if (!gatePass) {
  console.error(
    `gate FAIL: 违规 ${violations.length} / 排成 ${formatted} / 改动 ${changedCount}` +
      `（要求 违规=0 且 排成>0 且 改动>0）`
  );
  process.exit(1);
}
console.log(`gate PASS: 格式化三条断言全部成立（幂等 / token 不变 / 仅空白变化）`);
