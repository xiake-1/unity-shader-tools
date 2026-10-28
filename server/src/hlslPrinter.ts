/**
 * T-060 HLSL 打印器（规格 feature-formatting 范围 6；ADR 0011「全自写 CST 打印器」）。
 *
 * 口径（为什么是「逐行重缩进」而不是 token 流重建）：规格的三条硬断言里
 * ③「逐行 strip 空白后与原文逐行相同」要求**行数与每行内容不变**，
 * 所以打印器只能改每行的**前导空白 / 行尾空白 / 空行折叠**，不能合并或拆分行。
 * 缩进深度由 CST 的 `{` token 驱动（ShaderLab 外壳与 HLSL 同一套规则 —— 两者都是 `{}` 块），
 * 跨行的 token（块注释、多行字符串、带 `\` 续行的宏）覆盖的行**原样输出**：
 * 改它们等于改 token 自身，会直接违反 ②。
 */
import { walk, type Tree, type SyntaxNode } from './parser';
import type { FormatSwitches, IndentOptions } from './formatSettings';
import { indentPrefix } from './formatSettings';

export interface LineModel {
  /** 目标缩进深度（绝对值，已含 baseDepth） */
  depth: number;
  /** 该行必须字节级原样输出（范围 5） */
  verbatim: boolean;
  /** 续行对齐：深度 + 行内相对偏移（`macroMatchIndent`）；`alignDepth < 0` = 不按列对齐 */
  alignDepth: number;
  alignExtra: number;
}

export interface LineModelOptions {
  baseDepth?: number;
  macroMatchIndent?: boolean;
}

/**
 * 用 CST 的 token 序列算逐行模型。`tree` 必须是**同一份 text** 的树（调用方保证）。
 * 只读 CST，不重新解析（设计原则 2 / ADR 0001）。
 */
export function buildLineModel(
  text: string,
  tree: Tree,
  opts: LineModelOptions = {},
  /** 顺带交出收集到的叶子：复验（硬断言 ②）不再重新走一遍树，2001 行文档省 ~13ms */
  leavesOut?: SyntaxNode[]
): LineModel[] {
  const lines = text.split('\n');
  const base = opts.baseDepth ?? 0;
  const model: LineModel[] = lines.map(() => ({ depth: base, verbatim: false, alignDepth: -1, alignExtra: 0 }));

  // **一次游标遍历**同时收集叶子与 `ERROR`/`MISSING` 行区间：
  // ① `walk` 的 `node.children` 会物化子节点数组，2001 行文档上是 123ms 的大头；
  // ② `ERROR` 是**复合节点**（有子节点），只在叶子层判定会完全漏掉原样区（范围 5）；
  // ③ MISSING 节点的 `type` 是缺失的 token 名（`;`、`}`…），`type.startsWith('MISSING')` 永不成立
  //    —— 与 `parser.isErrorNode` 的 T-034 实测修正同一口径，必须用 `isMissing`。
  const leaves: SyntaxNode[] = [];
  const cur = tree.rootNode.walk();
  outer: for (;;) {
    const n = cur.currentNode;
    // `isError`/`isMissing` 是布尔属性：比 `n.type === 'ERROR'` 少一次字符串分配（每节点都走这条）
    if (n.isError || n.isMissing) {
      for (let r = n.startPosition.row; r <= n.endPosition.row && r < model.length; r++) model[r].verbatim = true;
    }
    if (cur.gotoFirstChild()) continue outer;
    leaves.push(n);
    for (;;) {
      if (cur.gotoNextSibling()) continue outer;
      if (!cur.gotoParent()) break outer;
    }
  }
  if (leavesOut) for (const l of leaves) leavesOut.push(l);

  const leadOf = (row: number): number => {
    const l = lines[row] ?? '';
    return l.length - l.trimStart().length;
  };

  let open = 0; // 未闭合 `{` 数
  /**
   * 未闭合 `(`/`[`：存**深度 + 行内相对偏移**而不是绝对列。
   * 实测教训：按绝对列对齐时，第一遍把含左括号的行缩进后，第二遍的基准列就漂了
   * （语料 22 个文件因此 `not-idempotent`）。「深度 + 行内偏移」两遍都稳定。
   */
  const parens: { depth: number; extra: number }[] = [];
  const assigned: boolean[] = new Array(lines.length).fill(false);
  let prevEndRow = -1;
  for (const t of leaves) {
    // 每个叶子只取一次 position/type：绑定层每次访问都新建对象/字符串，
    // 2001 行文档（1.4 万叶子）上这决定了格式化能不能压进 150ms
    const sp = t.startPosition;
    const ep = t.endPosition;
    const ty = t.type;
    const sRow = sp.row;
    const eRow = ep.row;

    if (ty === '}' || ty === ')') {
      if (ty === '}') open = Math.max(0, open - 1);
      else parens.pop();
    }

    if (sRow < model.length && !assigned[sRow]) {
      // 该行第一个 token 决定整行深度
      model[sRow].depth = base + open;
      assigned[sRow] = true;
      // 续行（上一行的最后一个 token 落在上一行）且有未闭合左括号 → 对齐到左括号
      const isContinuation = prevEndRow === sRow - 1 && parens.length > 0;
      if (isContinuation && opts.macroMatchIndent) {
        const p = parens[parens.length - 1];
        model[sRow].alignDepth = p.depth;
        model[sRow].alignExtra = p.extra;
      }
    }

    if (ty === '{') open++;
    if (ty === '(' || ty === '[') {
      parens.push({ depth: base + open, extra: sp.column - leadOf(sRow) + 1 });
    }

    // 跨行 token：内部行原样（改它们 = 改 token 自身 → 违反 ②）
    if (eRow > sRow) {
      for (let r = sRow + 1; r <= eRow && r < model.length; r++) model[r].verbatim = true;
    }
    prevEndRow = eRow;
  }
  return model;
}

/**
 * 排一个 HLSL 区间（`HLSLPROGRAM` 内部或独立 `.hlsl` 全文）。
 * 返回**逐行输出**（不含换行符），行数与输入相同或更少（空行折叠 / `braceOnNewLine` 拆行）。
 */
export function printHlslRegion(
  text: string,
  tree: Tree,
  switches: FormatSwitches,
  indent: IndentOptions,
  baseDepth = 0
): string[] {
  const model = buildLineModel(text, tree, { baseDepth, macroMatchIndent: switches.macroMatchIndent });
  const src = text.split('\n');
  const out: string[] = [];
  let blanks = 0;
  for (let i = 0; i < src.length; i++) {
    const raw = src[i];
    const m = model[i];
    if (raw.trim() === '') {
      // 原样区内的空行不折叠（折叠会移行号，错误恢复边界随之下移 → 幂等破）
      if (m.verbatim) {
        out.push(raw);
        continue;
      }
      blanks++;
      if (blanks <= switches.keepBlankLines) out.push(/\r$/.test(raw) ? '\r' : '');
      continue;
    }
    blanks = 0;
    if (m.verbatim) {
      out.push(raw);
      continue;
    }
    // 只换前导空白，行尾原样（comment token 含行尾空格与 `\r`，剥掉即改 token → 违反 ②）
    const lead = raw.length - raw.trimStart().length;
    const tail = raw.slice(lead);
    const prefix =
      m.alignDepth >= 0
        ? indentPrefix(m.alignDepth, indent) + ' '.repeat(Math.max(0, m.alignExtra))
        : indentPrefix(m.depth, indent);
    // `braceOnNewLine`：把行尾的 `{` 挪到下一行（Allman）。孤立的 `{` 行不再拆 → 幂等。
    if (switches.braceOnNewLine && tail.endsWith('{') && tail.trimEnd().length > 1) {
      const head = tail.trimEnd().slice(0, -1).replace(/[ \t]+$/, '');
      if (head !== '') {
        const cr = /\r$/.test(tail) ? '\r' : '';
        out.push(prefix + head + cr);
        out.push(indentPrefix(m.depth, indent) + '{' + cr);
        continue;
      }
    }
    out.push(prefix + tail);
  }
  return out;
}
