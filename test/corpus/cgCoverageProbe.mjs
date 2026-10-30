/** T-080 第一步 · CG 排版覆盖率探针（sprint-07 顺序约束：**只测不改默认值**）
 *
 * 要回答的问题：把 `CGPROGRAM`/`GLSLPROGRAM` 内部与 `.cginc` 纳入排版后，
 * tree-sitter-hlsl 对 Cg 写法的解析覆盖率有多高 —— 即「纳入后有多少比例的行
 * 会落进原样区（`ERROR`/`MISSING`/跨行 token）」，以及**失败的是什么语法**。
 *
 * 数字决定 `intraLineSpacing` / `braceSplitting` 两个新开关的默认值
 * （覆盖率低 → 可排面小 → 开关默认值要保守），也决定 grammar 扩面要不要另立任务。
 *
 * 口径与打印器一致（`server/src/hlslPrinter.ts` 的 `buildLineModel`）：
 * 原样行 = `ERROR`/`MISSING` 节点覆盖的行 ∪ 跨行 token 的内部行。
 *
 * 用法：npm run probe:cg-coverage   （--json 机器可读；--show N 打印 N 条失败样本）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShaderLab, parseHlslFile, walk } from '../../server/out/parser.js';
import { collectCorpus } from './corpus.mjs';

const asJson = process.argv.includes('--json');
const showIdx = process.argv.indexOf('--show');
const showN = showIdx >= 0 ? Number(process.argv[showIdx + 1]) || 10 : 0;

const PROGRAM_TYPES = ['program_cg', 'program_cg_include', 'program_glsl'];
const OPEN_KW = /^(kw_hlslprogram|kw_cgprogram|kw_glslprogram)$/;
const CLOSE_KW = /^(kw_endhlsl|kw_endcg|kw_endglsl)$/;

/** 与打印器同口径：返回 { total, verbatim, blank } 行计数 + ERROR 样本 */
function analyze(regionText, samples) {
  const tree = parseHlslFile(regionText);
  const lines = regionText.split('\n');
  const verbatim = new Array(lines.length).fill(false);
  const errors = [];
  walk(tree.rootNode, (n) => {
    if (n.isError || n.isMissing) {
      for (let r = n.startPosition.row; r <= n.endPosition.row && r < lines.length; r++) verbatim[r] = true;
      errors.push(n);
    }
    if (n.children.length === 0) {
      const s = n.startPosition.row;
      const e = n.endPosition.row;
      if (e > s) for (let r = s + 1; r <= e && r < lines.length; r++) verbatim[r] = true;
    }
  });
  let total = 0;
  let blank = 0;
  let vb = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') {
      blank++;
      continue;
    }
    total++;
    if (verbatim[i]) vb++;
  }
  if (samples && errors.length) {
    for (const n of errors.slice(0, 3)) {
      const line = lines[n.startPosition.row] ?? '';
      samples.push({
        node: n.type,
        text: line.trim().slice(0, 70),
      });
    }
  }
  return { total, blank, verbatim: vb };
}

const groups = collectCorpus();
const files = Object.values(groups).flat();
if (files.length === 0) {
  console.log('probe SKIP: 语料缺失（设 BENCH_PROJECT / BENCH_EDITOR）');
  process.exit(0);
}

const samples = [];
const sig = new Map(); // 失败签名 → 次数
const stats = {
  shaderFiles: 0,
  cgNodesSeen: 0,
  cgBlocksNoKeyword: 0,
  cgBlocksEmpty: 0,
  cgBlocks: 0,
  cgBlocksMessy: 0,
  glslBlocks: 0,
  cgincFiles: 0,
  linesTotal: 0,
  linesVerbatim: 0,
  linesBlank: 0,
  bytesTotal: 0,
  bytesVerbatim: 0,
};
const perGroup = {};

const t0 = Date.now();
for (const [gname, list] of Object.entries(groups)) {
  for (const f of list) {
    const text = fs.readFileSync(f, 'utf8');
    const isShader = /\.shader$/i.test(f);
    const isCginc = /\.cginc$/i.test(f);
    if (!isShader && !isCginc) continue;
    perGroup[gname] = perGroup[gname] ?? { regions: 0, linesTotal: 0, linesVerbatim: 0 };

    const regions = [];
    if (isShader) {
      stats.shaderFiles++;
      const tree = parseShaderLab(text);
      const src = text.split('\n');
      for (const n of tree.rootNode.descendantsOfType(PROGRAM_TYPES)) {
        stats.cgNodesSeen++;
        const open = n.children.find((c) => OPEN_KW.test(c.type));
        const close = n.children.find((c) => CLOSE_KW.test(c.type));
        if (!open || !close) {
          stats.cgBlocksNoKeyword++;
          continue;
        }
        const openRow = open.endPosition.row;
        const closeRow = close.startPosition.row;
        const openTail = (src[openRow] ?? '').slice(open.endPosition.column);
        const closeHead = (src[closeRow] ?? '').slice(0, close.startPosition.column);
        const messy = openTail.trim() !== '' || closeHead.trim() !== '';
        const startRow = openTail.trim() === '' ? openRow + 1 : openRow;
        const endRow = closeHead.trim() === '' ? closeRow - 1 : closeRow;
        if (endRow < startRow) {
          stats.cgBlocksEmpty++;
          continue;
        }
        if (messy) {
          stats.cgBlocksMessy++;
          continue;
        }
        if (n.type === 'program_glsl') stats.glslBlocks++;
        else stats.cgBlocks++;
        regions.push(src.slice(startRow, endRow + 1).join('\n'));
      }
    } else {
      stats.cgincFiles++;
      regions.push(text);
    }

    for (const r of regions) {
      const a = analyze(r, samples);
      stats.linesTotal += a.total;
      stats.linesVerbatim += a.verbatim;
      stats.linesBlank += a.blank;
      stats.bytesTotal += Buffer.byteLength(r, 'utf8');
      stats.bytesVerbatim += a.verbatim; // 行计数口径，字节另列时用 total
      perGroup[gname].regions++;
      perGroup[gname].linesTotal += a.total;
      perGroup[gname].linesVerbatim += a.verbatim;
    }
  }
}
const elapsed = Date.now() - t0;

for (const s of samples) {
  const k = `${s.node} :: ${s.text}`;
  sig.set(k, (sig.get(k) ?? 0) + 1);
}
const top = [...sig.entries()].sort((a, b) => b[1] - a[1]).slice(0, showN || 15);

const ratio = stats.linesTotal === 0 ? 0 : stats.linesVerbatim / stats.linesTotal;
const report = {
  ...stats,
  verbatimRatio: Number(ratio.toFixed(4)),
  formattableLines: stats.linesTotal - stats.linesVerbatim,
  elapsedMs: elapsed,
  perGroup,
  topFailures: top,
};

if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`CG 语料探针（tree-sitter-hlsl 对 Cg 的覆盖率）· ${elapsed}ms`);
  console.log(
    `  .shader 文件=${stats.shaderFiles}  program_cg/glsl 节点=${stats.cgNodesSeen}（缺开闭关键字=${stats.cgBlocksNoKeyword} 空块=${stats.cgBlocksEmpty} 畸形=${stats.cgBlocksMessy}）  纳入排版块=${stats.cgBlocks}+GLSL ${stats.glslBlocks}  .cginc 文件=${stats.cgincFiles}`
  );
  console.log(
    `  区域内非空行=${stats.linesTotal}  原样行(ERROR/MISSING/跨行token)=${stats.linesVerbatim}  可排行=${stats.linesTotal - stats.linesVerbatim}  原样占比=${(ratio * 100).toFixed(1)}%`
  );
  for (const [g, s] of Object.entries(perGroup)) {
    const r = s.linesTotal ? ((s.linesVerbatim / s.linesTotal) * 100).toFixed(1) : '0.0';
    console.log(`  ${g}: regions=${s.regions} lines=${s.linesTotal} verbatim=${s.linesVerbatim} (${r}%)`);
  }
  console.log(`  失败签名 top ${top.length}：`);
  for (const [k, n] of top) console.log(`    ${n}× ${k}`);
}
