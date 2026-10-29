/** 解析层封装（规格范围 3、T-009）
 *
 * 一套 CST 服务所有功能：ShaderLab 外壳用自写 grammar，程序块内容用 tree-sitter-hlsl。
 * 关键手法：把程序块之外的内容替换为等长空白，构造「虚拟 HLSL 文档」，
 * 于是 HLSL 节点的行列与 .shader 文件里的行列 **完全一致**，无需偏移换算。
 */
import Parser from 'tree-sitter';

const shaderlab = require('shaderlab-grammar');
const hlsl = require('tree-sitter-hlsl');

export type Tree = Parser.Tree;
export type SyntaxNode = Parser.SyntaxNode;

export interface Edit {
  startIndex: number;
  oldEndIndex: number;
  newEndIndex: number;
  startPosition: { row: number; column: number };
  oldEndPosition: { row: number; column: number };
  newEndPosition: { row: number; column: number };
}

export interface ProgramBody {
  /** 程序块类型：hlsl 走语义解析；cg/glsl 仅识别边界 */
  kind: 'hlsl' | 'cg' | 'glsl';
  /** 内容起止字节区间（不含起止关键字） */
  startByte: number;
  endByte: number;
}

export function createShaderLabParser(): Parser {
  const p = new Parser();
  p.setLanguage(shaderlab);
  return p;
}

/** 解析调用计数（测试与门槛脚本的可观测面）。
 *  规格 feature-shader-name-index-and-variant-report 约束「变体分析不得二次 parse」
 *  靠它断言：调用前后取增量，分析段的增量必须为 0。 */
export const parseStats = { shaderlab: 0, hlsl: 0 };

export function createHlslParser(): Parser {
  const p = new Parser();
  p.setLanguage(hlsl);
  return p;
}

/** 解析 ShaderLab 外壳；提供 oldTree + edits 时走 tree-sitter 增量重解析。
 *  tree-sitter 0.22 的 node 绑定：编辑先写回旧树（tree.edit），再把旧树交给 parse。 */
export function parseShaderLab(text: string, oldTree?: Tree, edits?: Edit[]): Tree {
  parseStats.shaderlab++;
  const parser = createShaderLabParser();
  if (oldTree && edits && edits.length > 0) {
    for (const e of edits) oldTree.edit(e as never);
    return parser.parse(text, oldTree);
  }
  return parser.parse(text);
}

/** 从 ShaderLab 树里取出各程序块的内容区间 */
export function extractProgramBodies(tree: Tree, text: string): ProgramBody[] {
  const out: ProgramBody[] = [];
  const visit = (node: SyntaxNode): void => {
    if (
      node.type === 'program_hlsl' ||
      node.type === 'program_hlsl_include' ||
      node.type === 'program_cg' ||
      node.type === 'program_cg_include' ||
      node.type === 'program_glsl'
    ) {
      const kids = node.children;
      const open = kids[0];
      const close = kids[kids.length - 1];
      if (open && close && open.endIndex < close.startIndex) {
        const kind: ProgramBody['kind'] = node.type.startsWith('program_hlsl')
          ? 'hlsl'
          : node.type === 'program_glsl'
            ? 'glsl'
            : 'cg';
        out.push({ kind, startByte: open.endIndex, endByte: close.startIndex });
      }
    }
    for (const c of node.children) visit(c);
  };
  visit(tree.rootNode);
  return out;
}

/** 构造虚拟 HLSL 文档：只保留 HLSL/CG 程序块内容，其余替换为等长空白（保留换行）。
 *  结果与原文等长，因此 HLSL 节点的行列即 .shader 文件里的行列。
 *  CG 块同样送入 HLSL grammar：Unity 的 CG 语法是 HLSL 的子集，符号提取需要它；
 *  GLSL 块不索引（Unity 已废弃，语法差异大）。 */
export function buildVirtualHlsl(text: string, bodies: ProgramBody[]): string {
  const indexed = bodies.filter((b) => b.kind === 'hlsl' || b.kind === 'cg');
  if (indexed.length === 0) return '';
  const chars = text.split('');
  for (let i = 0; i < chars.length; i++) {
    const inside = indexed.some((b) => i >= b.startByte && i < b.endByte);
    if (!inside) {
      const c = chars[i];
      if (c !== '\n' && c !== '\r') chars[i] = ' ';
    }
  }
  return chars.join('');
}

/** 解析 .hlsl/.cginc 等独立文件（无 ShaderLab 外壳）。
 *  与 parseShaderLab 一样支持 tree-sitter 增量重解析（M2：打开的 .hlsl 也要能跳）。 */
export function parseHlslFile(text: string, oldTree?: Tree, edits?: Edit[]): Tree {
  parseStats.hlsl++;
  const parser = createHlslParser();
  if (oldTree && edits && edits.length > 0) {
    for (const e of edits) oldTree.edit(e as never);
    return parser.parse(text, oldTree);
  }
  return parser.parse(text);
}

export function walk(node: SyntaxNode, fn: (n: SyntaxNode) => void): void {
  fn(node);
  for (const c of node.children) walk(c, fn);
}

/**
 * 游标版遍历：不物化 `children` 数组。
 * 实测：2001 行文档上 `walk` 的 `node.children` 是格式化 123ms 的大头
 * （每个节点都新建一批 SyntaxNode 包装），热路径（格式化、token 比对）必须用这个。
 */
export function walkNodes(node: SyntaxNode, fn: (n: SyntaxNode) => void): void {
  const c = node.walk();
  outer: for (;;) {
    fn(c.currentNode);
    if (c.gotoFirstChild()) continue outer;
    for (;;) {
      if (c.gotoNextSibling()) continue outer;
      if (!c.gotoParent()) break outer;
    }
  }
}

/** 游标版叶子收集（前序、按源码顺序，无需再排序） */
export function collectLeafNodes(root: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const c = root.walk();
  if (!c.gotoFirstChild()) {
    out.push(root);
    return out;
  }
  for (;;) {
    const n = c.currentNode;
    if (c.gotoFirstChild()) continue;
    out.push(n);
    for (;;) {
      if (c.gotoNextSibling()) break;
      if (!c.gotoParent()) return out;
    }
  }
}

/** 错误节点判定：ERROR 或 MISSING。
 *  **MISSING 节点的 `type` 是缺失的 token 名（`;`、`}`、`#endif`…），`isMissing` 为 true；
 *  `type === 'MISSING'` 永远不成立** —— 2026-10-28 T-034 实测修正：此前的写法让 MISSING
 *  从未被计入，语料里 219 处 `MISSING:;` 因此长期隐形（见 docs/progress/log.md）。 */
export function isErrorNode(node: SyntaxNode): boolean {
  return node.type === 'ERROR' || node.isMissing;
}

/** 统计 ERROR / MISSING 节点（M4 语法诊断与语料健康检查共用） */
export function countErrorNodes(root: SyntaxNode): number {
  let n = 0;
  walk(root, (node) => {
    if (isErrorNode(node)) n++;
  });
  return n;
}

export interface ErrorNode {
  node: SyntaxNode;
  /** 该节点内部被抑制的错误节点数（级联吞块的规模，写进日志 `nested=`） */
  nested: number;
}

/** 收集错误节点（T-037）。`outermostOnly = true`（语法诊断口径，ADR 0009）时只返回最外层，
 *  其内部级联计入 `nested`；`false` 时逐个返回（语料审计口径）。 */
export function collectErrorNodes(root: SyntaxNode, outermostOnly = true): ErrorNode[] {
  const out: ErrorNode[] = [];
  const countInner = (n: SyntaxNode): number => {
    let c = 0;
    for (const ch of n.children) {
      if (isErrorNode(ch)) c++;
      c += countInner(ch);
    }
    return c;
  };
  const visit = (n: SyntaxNode): void => {
    if (isErrorNode(n)) {
      out.push({ node: n, nested: countInner(n) });
      if (outermostOnly) return;
    }
    for (const c of n.children) visit(c);
  };
  visit(root);
  return out;
}

export function nodeText(node: SyntaxNode, text: string): string {
  return text.slice(node.startIndex, node.endIndex);
}
