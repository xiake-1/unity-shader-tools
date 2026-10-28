/**
 * T-045：死分支 Range 收集（只读唯一 CST 的 `preproc_*` 节点，不新增文本级预处理器扫描）。
 *
 * 规格 feature-dead-branch-dimming 范围 3/4/5 与异常表：
 *  - **只灰分支体**：起点 = 条件行的下一行行首，终点 = 下一个 `#elif`/`#else`/`#endif` 前一行行末；
 *  - `#elif` 只有在其前面所有分支都确定为假时才参与求值；前面任一分支未知 → 该分支及其后全部不灰；
 *  - 嵌套：外层分支已确定为假 → 整块一次灰，内层不再单独求值、不产重复 Range。
 *
 * 文法形态（实测，见 test/unit/inactiveRegions.test.ts）：`preproc_elif` 是**右嵌套**链——
 * `preproc_if` 的 children 里只有一个 `preproc_elif`（它自己再挂下一个 `preproc_elif`/`preproc_else`），
 * `#endif` 挂在最外层块上；`preproc_else` 挂在最后一个 `preproc_elif` 上。
 */
import type { SyntaxNode } from './parser';
import {
  collectDefines,
  definesBefore,
  evalExpression,
  evalIfdef,
  type EvalContext,
  type TriState,
} from './preprocessorEval';

export interface Position {
  line: number;
  character: number;
}

export interface InactiveRegion {
  start: Position;
  end: Position;
  /** 条件源文本（`#ifdef A` → `defined(A)`，`#ifndef D` → `!defined(D)`） */
  condition: string;
}

export interface InactiveRegionsOptions {
  /** Unity `Disabled keywords:` 集合 */
  disabled: ReadonlySet<string>;
}

const CHAIN_START = new Set(['preproc_if', 'preproc_ifdef', 'preproc_ifndef']);

interface Segment {
  kind: 'if' | 'ifdef' | 'ifndef' | 'elif' | 'else';
  condNode: SyntaxNode | null;
  condLine: number;
  bodyNodes: SyntaxNode[];
  /** 终止本分支体的指令行（`#elif`/`#else`/`#endif` 所在行） */
  terminatorRow: number;
  block: SyntaxNode;
}

/** 把一个块（或链上的 `preproc_elif`）拆成有序分支段。 */
function segmentsOf(block: SyntaxNode): Segment[] {
  const out: Segment[] = [];
  let node: SyntaxNode | null = block;
  // 最外层块的 `#endif`：else 段的终止符
  const endif = block.children.find((c) => c.type === '#endif');
  let endifRow = endif ? endif.startPosition.row : block.endPosition.row;

  while (node && (CHAIN_START.has(node.type) || node.type === 'preproc_elif')) {
    const directive = node.children[0];
    // 文法里 `#ifdef` 与 `#ifndef` **共用 `preproc_ifdef` 节点**（实测），
    // 所以分支种类必须看指令 token 文本，不能只看 node.type。
    const directiveText = (directive?.text ?? '').trim();
    const kind: Segment['kind'] =
      node.type === 'preproc_elif'
        ? 'elif'
        : directiveText === '#ifndef'
          ? 'ifndef'
          : directiveText === '#ifdef'
            ? 'ifdef'
            : 'if';
    // 条件节点：指令后第一个非空白命名子节点（ifdef/ifndef 是 identifier，if/elif 是表达式）
    const condNode =
      node.children.find((c) => c !== directive && c.type.trim() !== '' && !c.type.startsWith('#')) ?? null;
    const condLine = condNode ? condNode.startPosition.row : directive.startPosition.row;
    const next: SyntaxNode | undefined = node.children.find(
      (c) => c.type === 'preproc_elif' || c.type === 'preproc_else'
    );
    const terminatorRow = next ? next.startPosition.row : endifRow;
    const bodyNodes = node.children.filter(
      (c) =>
        c !== directive &&
        c !== condNode &&
        c !== next &&
        c.type !== '#endif' &&
        c.type.trim() !== '' &&
        c.startPosition.row >= condLine
    );
    out.push({ kind, condNode, condLine, bodyNodes, terminatorRow, block: node });

    if (!next) break;
    if (next.type === 'preproc_else') {
      const elseDirective = next.children[0];
      const elseBody: SyntaxNode[] = next.children.filter((c) => c !== elseDirective && c.type.trim() !== '');
      out.push({
        kind: 'else',
        condNode: null,
        condLine: next.startPosition.row,
        bodyNodes: elseBody,
        terminatorRow: endifRow,
        block: next,
      });
      break;
    }
    node = next;
  }
  return out;
}

function conditionText(seg: Segment): string {
  if (seg.kind === 'else') return 'else';
  if (seg.kind === 'ifdef' || seg.kind === 'ifndef') {
    const name = seg.condNode?.text ?? '';
    return seg.kind === 'ifdef' ? `defined(${name})` : `!defined(${name})`;
  }
  return (seg.condNode?.text ?? '').replace(/\s+/g, ' ').trim();
}

function regionOf(seg: Segment, lines: string[]): InactiveRegion | null {
  if (seg.bodyNodes.length === 0) return null;
  const startLine = seg.condLine + 1;
  const endLine = seg.terminatorRow - 1;
  if (endLine < startLine) return null; // 空分支体：不产 Range
  const lastLine = lines[endLine] ?? '';
  return {
    start: { line: startLine, character: 0 },
    end: { line: endLine, character: lastLine.length },
    condition: conditionText(seg),
  };
}

function evalSegment(seg: Segment, ctx: EvalContext): TriState {
  if (seg.kind === 'ifdef') return evalIfdef(seg.block, ctx, false);
  if (seg.kind === 'ifndef') return evalIfdef(seg.block, ctx, true);
  return evalExpression(seg.condNode, ctx);
}

function walkBlock(
  block: SyntaxNode,
  lines: string[],
  defineEntries: ReturnType<typeof collectDefines>,
  disabled: ReadonlySet<string>,
  out: InactiveRegion[]
): void {
  const segments = segmentsOf(block);
  // 链状态：`stoppedBy` = 链已被「确定为真的分支」或「未知分支」终止，其后分支不再求值。
  let stoppedBy: 'true' | 'unknown' | null = null;
  /** 让链终止的那条「确定为真」的条件：`#else` 体的 `condition` 用它（说明它为什么是死分支） */
  let trueCondition: string | null = null;
  for (const seg of segments) {
    if (seg.kind === 'else') {
      // `#else` 体只有在**前面某支确定为真**时才是死分支
      // （规格异常表：`#ifndef X` 且 X 在 Disabled 集合 → 灰 `#else` 体）。
      // 前面全假 → `#else` 就是激活分支；前面有未知 → 不可判定。两种都不灰。
      if (stoppedBy === 'true') {
        const r = regionOf(seg, lines);
        if (r) {
          if (trueCondition) r.condition = trueCondition;
          out.push(r);
        }
      } else {
        recurse(seg.bodyNodes, lines, defineEntries, disabled, out);
      }
      continue;
    }
    if (stoppedBy !== null) {
      // 链已终止（前支真 / 前支未知）：其后分支不灰也不求值（规格范围 4 与验收「前支真 → 后支不灰」）
      recurse(seg.bodyNodes, lines, defineEntries, disabled, out);
      continue;
    }
    void 0; // 求值门槛由 stoppedBy 表达：未知或真即停链
    const ctx: EvalContext = {
      disabled,
      defines: definesBefore(defineEntries, seg.condNode?.startIndex ?? block.startIndex),
    };
    const tri = evalSegment(seg, ctx);
    if (tri === 'false') {
      const r = regionOf(seg, lines);
      if (r) out.push(r); // 外层已整块灰：内层不再单独求值（规格范围 4）
      continue; // 确定为假 → 继续看下一分支
    }
    if (tri === 'true') {
      recurse(seg.bodyNodes, lines, defineEntries, disabled, out);
      stoppedBy = 'true';
      trueCondition = conditionText(seg);
      continue;
    }
    // 未知：本支与其后分支全部不灰（不猜激活分支）
    recurse(seg.bodyNodes, lines, defineEntries, disabled, out);
    stoppedBy = 'unknown';
  }
}

function recurse(
  bodyNodes: SyntaxNode[],
  lines: string[],
  defineEntries: ReturnType<typeof collectDefines>,
  disabled: ReadonlySet<string>,
  out: InactiveRegion[]
): void {
  for (const n of bodyNodes) {
    const stack: SyntaxNode[] = [n];
    const visit = (node: SyntaxNode): void => {
      if (CHAIN_START.has(node.type)) {
        walkBlock(node, lines, defineEntries, disabled, out);
        return; // 块内部由 walkBlock 自己递归
      }
      for (const c of node.children) visit(c);
    };
    visit(stack[0]);
  }
}

/**
 * 收集死分支 Range。`text` 必须是与 `root` 同源的文档文本（Range 终点要取行末）。
 */
export function collectInactiveRegions(
  root: SyntaxNode,
  text: string,
  opts: InactiveRegionsOptions
): InactiveRegion[] {
  const lines = text.split('\n');
  const defineEntries = collectDefines(root);
  const out: InactiveRegion[] = [];
  const visit = (node: SyntaxNode): void => {
    if (CHAIN_START.has(node.type)) {
      walkBlock(node, lines, defineEntries, opts.disabled, out);
      return;
    }
    for (const c of node.children) visit(c);
  };
  visit(root);
  return out.sort((a, b) => a.start.line - b.start.line || a.start.character - b.start.character);
}
