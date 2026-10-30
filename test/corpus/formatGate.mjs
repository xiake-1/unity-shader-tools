/** T-064 / T-083 · 格式化门槛（roadmap M5 第三条 + M7 扩范围验收，规格 feature-formatting 范围 10/11）
 *
 * 对语料逐文件断言三条硬口径（**2026-10-30 扩范围后的新口径**）：
 * ① 幂等（对输出再排一次字节相同）；
 * ② token 序列不变（同一 grammar 重新解析后的叶子 token 的 type 与 text 逐项相同）—— 主判据；
 * ③ 仅空白变化（**新口径**）：两侧**去掉全部空白后的字符流逐字符相同**，行数与行内容允许变化。
 *    旧口径「逐行 strip 后逐行相同」在 `intraLineSpacing` / `braceSplitting` 下必然误报，已废。
 *
 * 另报**形状指标**（不断言，只报数）：输入与输出里「token 之间 2+ 空格」与「行尾粘连 `}`」的行数，
 * 用来证明范围 7/8 在真实语料上确实消除了形态（`shapeFixed = in − out`）。
 * 打印器内部对**自己排出的行**已断言过形状（违规整次返回 null），这里只统计原样区残留。
 *
 * CG 覆盖率（范围 11）：`cgBytes` 按组上报，**只报不设门槛**（Cg 语法覆盖率低是已知事实，
 * 见 log 2026-10-30 07:41 探针；门槛只保证「排出来的东西是对的」）。
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
// `.cginc` 与 `.hlsl` 走同一棵树（范围 2）
const HLSL_EXT = /\.(hlsl|hlslinc|cginc)$/i;

const tokensOf = (file, text) => {
  const tree = HLSL_EXT.test(file) ? parseHlslFile(text) : parseShaderLab(text);
  const out = [];
  walk(tree.rootNode, (n) => {
    if (n.children.length === 0) out.push(`${n.type}\u0000${n.text}`);
  });
  return out;
};

/** ③ 新口径：去掉全部空白后的字符流（行数可变、空白可变，非空白字符一个都不能变） */
const noWs = (text) => text.replace(/\s+/g, '');

/** 形状指标（只报趋势，不作断言）：token 之间 2+ 空格、或行尾粘连 `}`（一行内 `{…}` 与 `};` 不算） */
const shapeViolations = (text) => {
  let n = 0;
  for (const l of text.split('\n')) {
    const body = l.replace(/\r$/, '').trimStart();
    if (body === '') continue;
    if (/[^\s]  +[^\s]/.test(body) || /^[^{]*[^{}\s]\}$/.test(body)) n++;
  }
  return n;
};

const violations = [];
const skipReasons = new Map();
let formatted = 0;
let changedCount = 0;
let verbatimLinesTotal = 0;
let verbatimBytesTotal = 0;
let cgBytesTotal = 0;
let shapeIn = 0;
let shapeOut = 0;
const perGroup = {};

const t0 = Date.now();
for (const f of selected) {
  const text = fs.readFileSync(f, 'utf8');
  const group = Object.entries(groups).find(([, list]) => list.includes(f))?.[0] ?? 'other';
  perGroup[group] = perGroup[group] ?? { files: 0, formatted: 0, skipped: 0, changed: 0, cgBytes: 0 };
  perGroup[group].files++;

  const skipReason = formatSkipReason(f, text);
  if (skipReason) {
    skipReasons.set(skipReason, (skipReasons.get(skipReason) ?? 0) + 1);
    perGroup[group].skipped++;
    continue;
  }
  shapeIn += shapeViolations(text);
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
  cgBytesTotal += out.cgBytes;
  perGroup[group].cgBytes += out.cgBytes;
  shapeOut += shapeViolations(out.text);
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
  // ③ 仅空白变化（新口径）
  const wa = noWs(text);
  const wb = noWs(out.text);
  if (wa !== wb) {
    let at = 0;
    const n = Math.min(wa.length, wb.length);
    while (at < n && wa[at] === wb[at]) at++;
    violations.push({
      file: f,
      check: '③仅空白',
      detail: `非空白字符流 ${wa.length}→${wb.length} 首个差异@${at} ${JSON.stringify(wa.slice(at, at + 40))} → ${JSON.stringify(wb.slice(at, at + 40))}`,
    });
  }
}
const elapsed = Date.now() - t0;

// 门槛与能力注册联动（范围 11）：默认值必须与门槛结果一致
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'client', 'package.json'), 'utf8'));
const declaredDefault = pkg?.contributes?.configurationDefaults?.['unityShader.formatting.enable'];

// 自检失败类原因（带后缀的动态 reason 用前缀扫）：出现即 FAIL，不能被「失败即不改」掩盖
const fatalPrefixes = ['token-sequence-changed', 'not-idempotent', 'line-content-changed', 'output-shape', 'error:'];
const fatal = [...skipReasons.keys()].filter((k) => fatalPrefixes.some((p) => k.startsWith(p)));

// 范围 11：CG 语料**不得为了 PASS 被剔出语料集**。语料里既有工程 `.shader` 又有 CGIncludes 时，
// 必须真的排到 CG 字节；排到 0 说明 CG 侧被跳过或解析面塌了 → 门槛失去断言面，按 FAIL 处理。
const cgExpected = (perGroup.project?.files ?? 0) > 0 && (perGroup.cgIncludes?.files ?? 0) > 0;
const gatePass =
  violations.length === 0 && formatted > 0 && changedCount > 0 && fatal.length === 0 && (!cgExpected || cgBytesTotal > 0);

const report = {
  files: selected.length,
  formatted,
  changed: changedCount,
  skipped: Object.fromEntries(skipReasons),
  verbatimLines: verbatimLinesTotal,
  verbatimBytes: verbatimBytesTotal,
  cgBytes: cgBytesTotal,
  shape: { input: shapeIn, output: shapeOut, fixed: shapeIn - shapeOut },
  fatalSkipReasons: fatal,
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
  console.log(`原样区: 行=${verbatimLinesTotal} 字节=${verbatimBytesTotal}  CG 排版字节=${cgBytesTotal}`);
  console.log(`形状（2+ 空格 / 行尾粘连 '}'）: 输入 ${shapeIn} 行 → 输出 ${shapeOut} 行（消除 ${shapeIn - shapeOut}）`);
  for (const [g, s] of Object.entries(perGroup)) {
    console.log(`  ${g}: files=${s.files} formatted=${s.formatted} skipped=${s.skipped} changed=${s.changed} cgBytes=${s.cgBytes}`);
  }
  if (violations.length) {
    console.log(`违规 ${violations.length} 条：`);
    for (const v of violations.slice(0, show ? violations.length : 15)) {
      console.log(`  [${v.check}] ${path.relative(root, v.file)} :: ${v.detail}`);
    }
  }
  if (fatal.length) console.log(`自检失败原因（出现即 FAIL）: ${fatal.slice(0, 8).join('  ')}`);
  console.log(
    `configurationDefaults unityShader.formatting.enable: declared=${declaredDefault} expected=${gatePass}`
  );
}

if (!gatePass) {
  console.error(
    `gate FAIL: 违规 ${violations.length} / 排成 ${formatted} / 改动 ${changedCount} / 自检失败原因 ${fatal.length}` +
      `（要求 违规=0 且 排成>0 且 改动>0 且 无自检失败原因）`
  );
  process.exit(1);
}
console.log(`gate PASS: 格式化三条断言全部成立（幂等 / token 不变 / 非空白字符流不变）`);
