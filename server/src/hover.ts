/** 悬停（规格 feature-hover；T-035）
 *
 * 复用 definition.ts 的 nodeAtCursor/NAME_TYPES/closureOrder/rankOf（不写第二套上下文判定）。
 * 两类悬停：①语义（struct 字段 `bitfield_clause` / 函数返回值 `semantics` 内的标识符）→ 自写语义表；
 * ②符号（索引可解析）→ 声明首行代码块 + 文档（索引邻近注释 → macroTable 兜底）。
 * 只读唯一 CST、符号索引与打开文档/磁盘文本，不触发第二套解析（设计原则 2）。
 */
import * as fs from 'fs';
import { Hover, MarkupKind, type Range } from 'vscode-languageserver';
import type { DocumentStore } from './documentStore';
import type { SymbolIndex, SymbolLocation } from './symbolIndex';
import type { IncludeContext } from './includeResolver';
import { macroDescription } from './macroTable';
import { semanticDescription, GENERIC_SEMANTIC } from './semanticTable';
import { NAME_TYPES, closureOrder, nodeAtCursor, rankOf } from './definition';

export interface HoverContext {
  index: SymbolIndex;
  store: DocumentStore;
  includeCtx: IncludeContext;
  projectRoot: string | null;
  log: (msg: string) => void;
  indexing?: () => boolean;
}

const SEMANTIC_PARENTS = new Set(['semantics', 'bitfield_clause']);

function nodeRange(node: { startPosition: { row: number; column: number }; endPosition: { row: number; column: number } }): Range {
  return {
    start: { line: node.startPosition.row, character: node.startPosition.column },
    end: { line: node.endPosition.row, character: node.endPosition.column },
  };
}

function hover(node: Parameters<typeof nodeRange>[0], markdown: string): Hover {
  return { contents: { kind: MarkupKind.Markdown, value: markdown }, range: nodeRange(node) };
}

/** 声明所在源文本行（打开文档优先 → 读盘）；文件不可读返回 null */
function lineAt(file: string, row: number, store: DocumentStore): string | null {
  let text: string | null = store.get(file)?.text ?? null;
  if (text === null) {
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }
  const lines = text.split('\n');
  return row < lines.length ? lines[row] : null;
}

export function provideHover(
  file: string,
  line: number,
  character: number,
  ctx: HoverContext
): Hover | null {
  const hit = nodeAtCursor(file, line, character, ctx.store);
  if (!hit) return null;
  const node = hit.node;
  if (!NAME_TYPES.has(node.type)) return null;

  // 1) 语义：struct 字段 `: SEM`（bitfield_clause）/ 函数返回值 `: SEM`（semantics）
  const parent = node.parent;
  if (parent && SEMANTIC_PARENTS.has(parent.type)) {
    return hover(node, semanticDescription(node.text) ?? GENERIC_SEMANTIC);
  }

  // 2) 符号：按 F12 同一优先级取最优声明
  const info = ctx.index.getByName(node.text);
  if (!info || !info.locations.length) return null;
  const closure = closureOrder(file, ctx.index, ctx.includeCtx);
  const sorted: SymbolLocation[] = [...info.locations].sort(
    (a, b) =>
      rankOf(a, file, closure, ctx) - rankOf(b, file, closure, ctx) ||
      a.start.row - b.start.row ||
      a.start.column - b.start.column
  );
  const parts: string[] = [];
  for (const loc of sorted) {
    const declLine = lineAt(loc.file, loc.start.row, ctx.store);
    if (declLine === null) continue; // 声明文件已删除：顺延下一优先级（规格异常表）
    parts.push('```hlsl\n' + declLine.trim() + '\n```');
    break;
  }
  const doc = info.doc ?? macroDescription(info.name);
  if (doc) parts.push(doc);
  if (sorted.length > 1) parts.push(`（共 ${sorted.length} 处声明，显示优先级最高的一处）`);
  if (!parts.length) return null;
  return hover(node, parts.join('\n\n'));
}
