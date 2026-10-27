/** 作用域与成员访问解析（规格 feature-go-to-definition、T-015 / T-016）
 *
 * 只做两件事：①块级作用域与同名遮蔽（就近优先）；②`变量.字段` 的单层浅推断
 * （点号左侧取声明处的类型名 → 该类型若是 struct，则字段按 owner 过滤）。
 * 不做类型系统、不做链式推断、不求值 `#if`（那些属 M4/M5）。
 */
import type Parser from 'tree-sitter';
import type { SymbolLocation } from './symbolIndex';

type SyntaxNode = Parser.SyntaxNode;

function locOf(node: SyntaxNode, file: string): SymbolLocation {
  return {
    file,
    startByte: node.startIndex,
    endByte: node.endIndex,
    start: { row: node.startPosition.row, column: node.startPosition.column },
    end: { row: node.endPosition.row, column: node.endPosition.column },
  };
}

/** 声明语句里被声明的名字：`float d = i.uv.x;` 只取 `d`，不取初始化表达式里的名字 */
function declaredIds(decl: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (const c of decl.children) {
    if (c.type === 'identifier') {
      out.push(c);
      continue;
    }
    if (c.type === 'init_declarator') {
      for (const g of c.children) if (g.type === 'identifier') out.push(g);
    }
  }
  return out;
}

/** 函数参数名 */
function parameterIds(fnDef: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const fd = fnDef.children.find((c) => c.type === 'function_declarator');
  const pl = fd?.children.find((c) => c.type === 'parameter_list');
  if (!pl) return out;
  for (const pd of pl.children.filter((c) => c.type === 'parameter_declaration')) {
    for (const c of pd.children) if (c.type === 'identifier') out.push(c);
  }
  return out;
}

/** 声明处的类型名：`v2f i` → `v2f`；`float k` → null（内置类型不是 struct，成员访问无从推断） */
function typeOfDeclaration(decl: SyntaxNode): string | null {
  for (const c of decl.children) {
    if (c.type === 'type_identifier') return c.text;
    if (c.type === 'primitive_type') return null;
  }
  return null;
}

/** 从 node 向上收集同名局部声明：内层块 → 该层函数参数 → 外层块 → 外层参数（就近优先） */
export function findLocalDeclarations(node: SyntaxNode, file: string, name: string): SymbolLocation[] {
  const out: SymbolLocation[] = [];
  let cur: SyntaxNode | null = node;
  while (cur) {
    if (cur.type === 'compound_statement') {
      for (const stmt of cur.children) {
        if (stmt.type !== 'declaration') continue;
        for (const id of declaredIds(stmt)) if (id.text === name) out.push(locOf(id, file));
      }
    } else if (cur.type === 'function_definition') {
      for (const id of parameterIds(cur)) if (id.text === name) out.push(locOf(id, file));
    }
    cur = cur.parent;
  }
  return out;
}

/** 作用域链上 name 的声明类型（局部变量与参数） */
export function localDeclaredType(node: SyntaxNode, name: string): string | null {
  let cur: SyntaxNode | null = node;
  while (cur) {
    if (cur.type === 'compound_statement') {
      for (const stmt of cur.children) {
        if (stmt.type !== 'declaration') continue;
        if (!declaredIds(stmt).some((id) => id.text === name)) continue;
        const t = typeOfDeclaration(stmt);
        if (t) return t;
      }
    } else if (cur.type === 'function_definition') {
      const fd = cur.children.find((c) => c.type === 'function_declarator');
      const pl = fd?.children.find((c) => c.type === 'parameter_list');
      if (!pl) {
        cur = cur.parent;
        continue;
      }
      for (const pd of pl.children.filter((c) => c.type === 'parameter_declaration')) {
        if (!pd.children.some((c) => c.type === 'identifier' && c.text === name)) continue;
        const t = typeOfDeclaration(pd);
        if (t) return t;
      }
    }
    cur = cur.parent;
  }
  return null;
}

/** 文件级（translation_unit 顶层）声明的类型；块内局部不参与 */
export function globalDeclaredType(root: SyntaxNode, name: string): string | null {
  const stack: SyntaxNode[] = [root];
  while (stack.length) {
    const n = stack.shift()!;
    if (n.type === 'compound_statement') continue;
    if (n.type === 'declaration' && declaredIds(n).some((id) => id.text === name)) {
      const t = typeOfDeclaration(n);
      if (t) return t;
    }
    for (const c of n.children) stack.push(c);
  }
  return null;
}
