/**
 * T-044：预处理条件三态求值（假 / 真 / 未知）。
 *
 * 规格 feature-dead-branch-dimming 范围 2 与约束「**只有确定为假才灰**」；ADR 0008/0009。
 * 求值输入只有两样：Unity `Disabled keywords:` 集合（确定关闭）与**当前文件**的
 * `#define`/`#undef`（include 闭包内的 `#define` 首期不参与 → 记未知）。
 * 任一子表达式未知导致整体不可判定 → 整体未知，不做部分求值灰化。
 */
import type { SyntaxNode } from './parser';

export type TriState = 'true' | 'false' | 'unknown';

export interface EvalContext {
  /** Unity `Disabled keywords:` 集合（大小写敏感） */
  disabled: ReadonlySet<string>;
  /** 当前文件里、条件之前生效的 `#define`：名字 → 替换文本（空串 = 无值宏） */
  defines: ReadonlyMap<string, string>;
}

export interface DefineEntry {
  name: string;
  /** `#define X` 无值 → ''；`#define X 0` → '0' */
  value: string;
  /** `#undef` 为 true */
  undef: boolean;
  start: number;
}

/**
 * 收集当前文件的 `#define`/`#undef`。
 * 注意文法形态：`#define` 是 `preproc_def`（`identifier` + 可选 `preproc_arg`），
 * 而 `#undef` 没有专用节点，是 `preproc_call`（`preproc_directive` 文本为 `#undef`）。
 */
export function collectDefines(root: SyntaxNode): DefineEntry[] {
  const out: DefineEntry[] = [];
  const visit = (n: SyntaxNode): void => {
    if (n.type === 'preproc_def') {
      const id = n.children.find((c) => c.type === 'identifier');
      if (id) {
        const arg = n.children.find((c) => c.type === 'preproc_arg');
        out.push({ name: id.text, value: (arg?.text ?? '').trim(), undef: false, start: n.startIndex });
      }
    } else if (n.type === 'preproc_call') {
      const dir = n.children.find((c) => c.type === 'preproc_directive');
      if (dir && dir.text.trim() === '#undef') {
        const arg = n.children.find((c) => c.type === 'preproc_arg');
        const name = (arg?.text ?? '').trim().split(/\s+/, 1)[0];
        if (name) out.push({ name, value: '', undef: true, start: n.startIndex });
      }
    }
    for (const c of n.children) visit(c);
  };
  visit(root);
  return out.sort((a, b) => a.start - b.start);
}

/** 条件之前生效的宏表（C 语义：只认条件之前的 `#define`/`#undef`）。 */
export function definesBefore(entries: DefineEntry[], beforeIndex: number): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of entries) {
    if (e.start >= beforeIndex) break;
    if (e.undef) map.delete(e.name);
    else map.set(e.name, e.value);
  }
  return map;
}

/** `defined(X)` / `defined X` 的三态。 */
export function definedState(name: string, ctx: EvalContext): TriState {
  if (ctx.defines.has(name)) return 'true';
  // Unity 明确关闭的关键字 ⇒ 确定未定义
  if (ctx.disabled.has(name)) return 'false';
  return 'unknown';
}

/** 裸标识符在 `#if` 里的三态（宏值只认 0/1 这类整数常量，其它不展开）。 */
export function identifierState(name: string, ctx: EvalContext): TriState {
  if (ctx.defines.has(name)) {
    const v = ctx.defines.get(name) ?? '';
    if (v === '') return 'true'; // `#define X` 无值 ⇒ 1
    if (/^\d+$/.test(v)) return v === '0' ? 'false' : 'true';
    return 'unknown'; // 非整数替换：不猜
  }
  if (ctx.disabled.has(name)) return 'false';
  return 'unknown';
}

const UNKNOWN: TriState = 'unknown';

/**
 * `&&`/`||` 采用**严格未知传播**，不做短路吸收：
 * 规格异常表明确「`#if defined(A) && !defined(B)` 仅一侧可判定 → 整体未知 → 不灰化」，
 * 即「不做部分求值灰化」。短路会把 `false && UNKNOWN` 判成假并灰化，属规格禁止的方向。
 */
function and3(a: TriState, b: TriState): TriState {
  if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
  return a === 'true' && b === 'true' ? 'true' : 'false';
}

function or3(a: TriState, b: TriState): TriState {
  if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
  return a === 'true' || b === 'true' ? 'true' : 'false';
}

function not3(a: TriState): TriState {
  if (a === UNKNOWN) return UNKNOWN;
  return a === 'true' ? 'false' : 'true';
}

/**
 * 对一个条件表达式节点求三态。文法里条件可以是
 * `identifier` / `number_literal` / `preproc_defined` / `binary_expression` /
 * `unary_expression` / `parenthesized_expression` 等。
 */
export function evalExpression(node: SyntaxNode | null, ctx: EvalContext): TriState {
  if (!node) return UNKNOWN;
  switch (node.type) {
    case 'condition':
    case 'parenthesized_expression': {
      const inner = node.children.find((c) => !['(', ')'].includes(c.type) && c.type !== 'condition');
      return evalExpression(inner ?? node.namedChildren[0] ?? null, ctx);
    }
    case 'preproc_defined': {
      const id = node.children.find((c) => c.type === 'identifier');
      return id ? definedState(id.text, ctx) : UNKNOWN;
    }
    case 'defined_identifier':
      return definedState(node.text, ctx);
    case 'identifier':
      return identifierState(node.text, ctx);
    case 'number_literal':
      return /^0+$/.test(node.text.trim()) ? 'false' : 'true';
    case 'unary_expression': {
      const op = node.children[0]?.text;
      const operand = node.children.slice(1).find((c) => c.type !== ' ');
      if (op === '!') return not3(evalExpression(operand ?? null, ctx));
      return UNKNOWN; // `+`/`-`/`~` 之类不参与布尔判定
    }
    case 'binary_expression': {
      const opNode = node.children.find((c) => ['&&', '||', '==', '!='].includes(c.text));
      if (!opNode) return UNKNOWN;
      const idx = node.children.indexOf(opNode);
      const left = evalExpression(node.children.slice(0, idx).find((c) => c.type.trim() !== '') ?? null, ctx);
      const right = evalExpression(node.children.slice(idx + 1).find((c) => c.type.trim() !== '') ?? null, ctx);
      switch (opNode.text) {
        case '&&':
          return and3(left, right);
        case '||':
          return or3(left, right);
        case '==':
          return left === UNKNOWN || right === UNKNOWN ? UNKNOWN : left === right ? 'true' : 'false';
        case '!=':
          return left === UNKNOWN || right === UNKNOWN ? UNKNOWN : left !== right ? 'true' : 'false';
        default:
          return UNKNOWN; // `+`/`<`/位运算等：不猜
      }
    }
    default:
      return UNKNOWN;
  }
}

/** `#ifdef X` / `#ifndef X`：取指令后的标识符。 */
export function evalIfdef(block: SyntaxNode, ctx: EvalContext, negate: boolean): TriState {
  const id = block.children.find((c) => c.type === 'identifier' || c.type === 'defined_identifier');
  if (!id) return UNKNOWN;
  const s = definedState(id.text, ctx);
  return negate ? not3(s) : s;
}
