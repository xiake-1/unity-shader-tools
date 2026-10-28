/** T-034 · HLSL 语料叶子 ERROR 模式审计（ADR 0007 已知限制的量化口径）
 *
 * 用途：把「哪些语法模式让 tree-sitter 产 ERROR/MISSING」变成可重复的聚合表，
 * 供三处共用：① T-034 决定「修 grammar 还是登记豁免」；② T-038 豁免表的模式 id 来源；
 * ③ T-041 `gate:diagnostics` 的逐模式聚合口径（同一份语料、同一套签名算法，不造两套）。
 *
 * 语料与 bench 同约定：BENCH_PROJECT（Assets + Library/PackageCache/render-pipelines ShaderLibrary）
 * + BENCH_EDITOR（Data/CGIncludes）。缺失 → 记 SKIP 并以 0 退出（不假装通过）。
 *
 * 用法：node test/corpus/errorAudit.mjs [--json] [--top N]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHlslFile, parseShaderLab, extractProgramBodies, buildVirtualHlsl } from '../../server/out/parser.js';
import { normalizeShape } from '../../server/out/errorExemption.js';
import { collectCorpus } from './corpus.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const HLSL_EXT = /\.(hlsl|hlslinc|cginc)$/i;

/** 文本 → 模式签名：直接用豁免表的 normalizeShape（同一口径，不造两套） */
const normalizeSnippet = (text, limit = 90) => normalizeShape(text, limit);

/** 一个 ERROR/MISSING 节点的签名：MISSING 记 `MISSING:<token>`（tree-sitter 里 MISSING 节点的
 *  type 就是缺失的 token 名、`isMissing` 为 true，`type === 'MISSING'` 永远不成立）；
 *  ERROR 记「父节点类型 + 内部 token 序列 + 归一化形状」——同模式跨文件可聚到一起。 */
function signatureOf(node) {
  if (node.isMissing) return `MISSING:${node.type}`;
  const kids = node.children;
  const tokenSeq = kids
    .slice(0, 6)
    .map((c) => c.type)
    .join(',');
  const snippet = normalizeSnippet(node.text);
  return `ERROR[parent=${node.parent?.type ?? 'root'};tokens=${tokenSeq};shape=${snippet}]`;
}

/** 叶子 ERROR：自身是 ERROR/MISSING 且子孙里没有第二个 ERROR/MISSING（级联只算最外层） */
function leafErrorNodes(root) {
  const out = [];
  const isErrorNode = (n) => n.type === 'ERROR' || n.isMissing;
  const visit = (n) => {
    if (isErrorNode(n)) {
      let inner = 0;
      const deep = (m) => {
        for (const c of m.children) {
          if (isErrorNode(c)) inner++;
          deep(c);
        }
      };
      deep(n);
      out.push({ node: n, nested: inner });
      return;
    }
    for (const c of n.children) visit(c);
  };
  visit(root);
  return out;
}

/** 一个文件的解析树：.hlsl/.cginc 直接 HLSL；.shader 取 ShaderLab 树 + 虚拟 HLSL 树 */
function treesFor(file, text) {
  if (HLSL_EXT.test(path.extname(file))) {
    return [{ kind: 'hlsl', tree: parseHlslFile(text), text }];
  }
  const lab = parseShaderLab(text);
  const bodies = extractProgramBodies(lab, text);
  const virtual = buildVirtualHlsl(text, bodies);
  const out = [{ kind: 'shaderlab', tree: lab, text }];
  if (virtual.trim().length > 0) out.push({ kind: 'hlsl', tree: parseHlslFile(virtual), text: virtual });
  return out;
}

export function auditCorpus(groups) {
  const modes = new Map();
  const perGroup = {};
  const filesWithError = new Map();

  for (const [group, files] of Object.entries(groups)) {
    let withError = 0;
    for (const f of files) {
      let text;
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      let hits = 0;
      for (const t of treesFor(f, text)) {
        for (const { node, nested } of leafErrorNodes(t.tree.rootNode)) {
          hits++;
          const sig = signatureOf(node);
          let m = modes.get(sig);
          if (!m) {
            m = { signature: sig, count: 0, files: new Set(), groups: new Set(), samples: [] };
            modes.set(sig, m);
          }
          m.count++;
          m.files.add(f);
          m.groups.add(group);
          if (m.samples.length < 3) {
            m.samples.push({
              file: path.relative(root, f),
              tree: t.kind,
              row: node.startPosition.row + 1,
              text: normalizeSnippet(node.text, 120),
            });
          }
        }
      }
      if (hits > 0) {
        withError++;
        filesWithError.set(path.relative(root, f), hits);
      }
    }
    perGroup[group] = { files: files.length, filesWithError: withError, errorRate: files.length ? withError / files.length : 0 };
  }

  return {
    perGroup,
    totalFiles: Object.values(perGroup).reduce((a, b) => a + b.files, 0),
    totalFilesWithError: filesWithError.size,
    modes: [...modes.values()]
      .map((m) => ({
        signature: m.signature,
        count: m.count,
        files: m.files.size,
        fileList: [...m.files].slice(0, 6),
        groups: [...m.groups],
        samples: m.samples,
      }))
      .sort((a, b) => b.count - a.count),
  };
}

const asJson = process.argv.includes('--json');
const topIdx = process.argv.indexOf('--top');
const top = topIdx > 0 ? Number(process.argv[topIdx + 1]) : 40;

const groups = collectCorpus();
const total = Object.values(groups).reduce((a, g) => a + g.length, 0);
if (total === 0) {
  console.log('audit SKIP: 语料缺失（设 BENCH_PROJECT / BENCH_EDITOR）');
  process.exit(0);
}

const t0 = performance.now();
const result = auditCorpus(groups);
const ms = Math.round(performance.now() - t0);

if (asJson) {
  console.log(JSON.stringify({ ms, ...result }, null, 2));
} else {
  console.log(`语料 ${result.totalFiles} 文件 / ${ms}ms；含 ERROR 文件 ${result.totalFilesWithError}`);
  for (const [g, s] of Object.entries(result.perGroup)) {
    console.log(`  ${g.padEnd(12)} files=${String(s.files).padStart(4)}  withERROR=${String(s.filesWithError).padStart(3)}  ${(s.errorRate * 100).toFixed(1)}%`);
  }
  console.log(`\n叶子 ERROR 模式（共 ${result.modes.length} 种，显示前 ${Math.min(top, result.modes.length)}）：`);
  result.modes.slice(0, top).forEach((m, i) => {
    console.log(`\n#${i + 1}  count=${m.count} files=${m.files} groups=${m.groups.join('/')}`);
    console.log(`    ${m.signature}`);
    for (const s of m.samples) console.log(`      e.g. ${s.file}:${s.row} [${s.tree}] ${s.text}`);
  });
}
