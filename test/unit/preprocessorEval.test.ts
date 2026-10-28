/** T-044：预处理条件三态求值（假 / 真 / 未知） */
import { describe, it, expect } from 'vitest';
import { parseHlslFile, type SyntaxNode } from '../../server/src/parser';
import {
  collectDefines,
  definedState,
  definesBefore,
  evalExpression,
  evalIfdef,
  identifierState,
  type EvalContext,
} from '../../server/src/preprocessorEval';

/** 取源码里第一个 `#if`/`#ifdef`/`#ifndef` 块的条件节点 */
function firstBlock(src: string): SyntaxNode {
  const tree = parseHlslFile(src);
  const stack: SyntaxNode[] = [tree.rootNode];
  while (stack.length) {
    const n = stack.shift() as SyntaxNode;
    if (['preproc_if', 'preproc_ifdef', 'preproc_ifndef'].includes(n.type)) return n;
    stack.push(...n.children);
  }
  throw new Error('fixture 里没有 preproc 块');
}

function conditionNode(block: SyntaxNode): SyntaxNode {
  const directive = block.children[0];
  const c = block.children.find((x) => x !== directive && x.type.trim() !== '' && !x.type.startsWith('#'));
  if (!c) throw new Error('条件节点缺失');
  return c;
}

const ctx = (disabled: string[], defines: Record<string, string> = {}): EvalContext => ({
  disabled: new Set(disabled),
  defines: new Map(Object.entries(defines)),
});

describe('标识符与 defined() 的三态', () => {
  it('关键字在 Disabled 集合 → 假', () => {
    const b = firstBlock('#if SHADER_API_GLES30\nfloat a;\n#endif\n');
    expect(evalExpression(conditionNode(b), ctx(['SHADER_API_GLES30']))).toBe('false');
  });
  it('不在集合 → 未知（不假设「启用」）', () => {
    const b = firstBlock('#if SOME_UNKNOWN\nfloat a;\n#endif\n');
    expect(evalExpression(conditionNode(b), ctx(['OTHER']))).toBe('unknown');
  });
  it('`defined(X)`：在集合 → 假；不在 → 未知；文件内 #define → 真', () => {
    const b = firstBlock('#if defined(A)\nfloat a;\n#endif\n');
    const n = conditionNode(b);
    expect(evalExpression(n, ctx(['A']))).toBe('false');
    expect(evalExpression(n, ctx([]))).toBe('unknown');
    expect(evalExpression(n, ctx([], { A: '1' }))).toBe('true');
  });
  it('`!defined(B)`：B 在集合 → 真', () => {
    const b = firstBlock('#if !defined(B)\nfloat a;\n#endif\n');
    expect(evalExpression(conditionNode(b), ctx(['B']))).toBe('true');
  });
});

describe('#ifdef / #ifndef 四例', () => {
  it('#ifdef X，X 在集合 → 假', () => {
    expect(evalIfdef(firstBlock('#ifdef X\nfloat a;\n#endif\n'), ctx(['X']), false)).toBe('false');
  });
  it('#ifdef X，X 不在集合 → 未知', () => {
    expect(evalIfdef(firstBlock('#ifdef X\nfloat a;\n#endif\n'), ctx(['Y']), false)).toBe('unknown');
  });
  it('#ifndef X，X 在集合 → 真', () => {
    expect(evalIfdef(firstBlock('#ifndef X\nfloat a;\n#endif\n'), ctx(['X']), true)).toBe('true');
  });
  it('#ifndef X，X 不在集合 → 未知', () => {
    expect(evalIfdef(firstBlock('#ifndef X\nfloat a;\n#endif\n'), ctx(['Y']), true)).toBe('unknown');
  });
});

describe('复合表达式', () => {
  it('两侧均可判定 → 可判定（假）', () => {
    const b = firstBlock('#if defined(A) && !defined(B)\nfloat a;\n#endif\n');
    expect(evalExpression(conditionNode(b), ctx(['A', 'B']))).toBe('false');
  });
  it('一侧未知 → 整体未知（规格异常表：不做部分求值灰化）', () => {
    const b = firstBlock('#if defined(A) && !defined(B)\nfloat a;\n#endif\n');
    expect(evalExpression(conditionNode(b), ctx(['A']))).toBe('unknown');
  });
  it('`||` 一侧未知 → 未知', () => {
    const b = firstBlock('#if 0 || UNKNOWN_THING\nfloat a;\n#endif\n');
    expect(evalExpression(conditionNode(b), ctx([]))).toBe('unknown');
  });
  it('括号与 `==`：两侧可判定才比较', () => {
    const b = firstBlock('#if (A == B)\nfloat a;\n#endif\n');
    expect(evalExpression(conditionNode(b), ctx(['A', 'B']))).toBe('true'); // 都假 → 相等
    const c = firstBlock('#if (A != B)\nfloat a;\n#endif\n');
    expect(evalExpression(conditionNode(c), ctx(['A']))).toBe('unknown');
  });
  it('整数常量与不认识的算子', () => {
    expect(evalExpression(conditionNode(firstBlock('#if 0\nfloat a;\n#endif\n')), ctx([]))).toBe('false');
    expect(evalExpression(conditionNode(firstBlock('#if 1\nfloat a;\n#endif\n')), ctx([]))).toBe('true');
    expect(evalExpression(conditionNode(firstBlock('#if (A & B)\nfloat a;\n#endif\n')), ctx(['A', 'B']))).toBe('unknown');
  });
});

describe('当前文件的 #define / #undef 参与求值', () => {
  it('`#define X 0` → `#if X` 为假', () => {
    const src = '#define X 0\n#if X\nfloat a;\n#endif\n';
    const root = parseHlslFile(src).rootNode;
    const entries = collectDefines(root);
    const b = firstBlock(src);
    const defines = definesBefore(entries, conditionNode(b).startIndex);
    expect([...defines]).toEqual([['X', '0']]);
    expect(evalExpression(conditionNode(b), ctx([], Object.fromEntries(defines)))).toBe('false');
  });

  it('`#undef X` 之后 → 未知（不再当已定义）', () => {
    const src = '#define X 0\n#undef X\n#if X\nfloat a;\n#endif\n';
    const root = parseHlslFile(src).rootNode;
    const entries = collectDefines(root);
    const b = firstBlock(src);
    const defines = definesBefore(entries, conditionNode(b).startIndex);
    expect(defines.size).toBe(0);
    expect(evalExpression(conditionNode(b), ctx([], Object.fromEntries(defines)))).toBe('unknown');
  });

  it('`#define X`（无值）当 1；`#define X 1` 为真；非整数替换不猜', () => {
    const root = parseHlslFile('#define A\n#define B 1\n#define C SOMETHING\n').rootNode;
    const entries = collectDefines(root);
    const defines = definesBefore(entries, Number.MAX_SAFE_INTEGER);
    const c = ctx([], Object.fromEntries(defines));
    expect(identifierState('A', c)).toBe('true');
    expect(identifierState('B', c)).toBe('true');
    expect(identifierState('C', c)).toBe('unknown');
  });

  it('只认条件之前的宏（条件之后的 `#define` 不影响前面的条件）', () => {
    const src = '#if Y\nfloat a;\n#endif\n#define Y 0\n';
    const root = parseHlslFile(src).rootNode;
    const entries = collectDefines(root);
    const b = firstBlock(src);
    expect(definesBefore(entries, conditionNode(b).startIndex).size).toBe(0);
    expect(evalExpression(conditionNode(b), ctx([], {}))).toBe('unknown');
  });

  it('collectDefines 认得 `#undef`（文法里它是 preproc_call，不是专用节点）', () => {
    const entries = collectDefines(parseHlslFile('#define A 1\n#undef A\n').rootNode);
    expect(entries.map((e) => [e.name, e.undef])).toEqual([
      ['A', false],
      ['A', true],
    ]);
    expect(definedState('A', ctx([], Object.fromEntries(definesBefore(entries, 9999)) ))).toBe('unknown');
  });
});
