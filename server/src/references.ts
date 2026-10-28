/** 引用查找（规格 feature-rename，T-029）：符号级、全工程、零文本匹配。
 *
 * token → 逻辑符号与 F12 同一条路径（`nodeAtCursor` + 符号索引 + `scopeResolver` 浅推断）；
 * 全局符号的 occurrence 用 `collectOccurrences`（按需重解析，T-028）；
 * 成员字段只收「左侧可浅推断到该 struct」的 token + owner 过滤的声明（宁漏勿错，`unresolved=N`）；
 * 局部符号只收当前文件所在函数体内的 token。
 * 上限 200，按五层优先级截断并记 `truncated=<总数>`。
 */
import { pathToFileURL } from 'url';
import type { Location } from 'vscode-languageserver';
import type Parser from 'tree-sitter';
import { findLocalDeclarations } from './scopeResolver';
import { isGeneratedFile } from './tempFiles';
import type { SymbolLocation, SymbolIndex } from './symbolIndex';
import type { DocumentStore } from './documentStore';
import type { IncludeContext } from './includeResolver';
import {
  LITERAL_TYPES,
  NAME_TYPES,
  closureOrder,
  declaredTypeOf,
  docTrees,
  nodeAtCursor,
  rankOf,
} from './definition';
import { collectOccurrences } from './occurrences';

type SyntaxNode = Parser.SyntaxNode;

const DEFAULT_MAX_REFERENCES = 200;

export interface ReferenceContext {
  index: SymbolIndex;
  store: DocumentStore;
  includeCtx: IncludeContext;
  projectRoot: string | null;
  log: (msg: string) => void;
  indexing?: () => boolean;
  maxLocations?: number;
}

export type SymbolAtCursor =
  | { kind: 'global'; name: string; node: SyntaxNode }
  | { kind: 'member'; name: string; structName: string | null; node: SyntaxNode }
  | { kind: 'local'; name: string; locals: SymbolLocation[]; fnNode: SyntaxNode; node: SyntaxNode };

/** 光标 → 逻辑符号（references / rename 共用的第一步） */
export function resolveSymbolAt(
  file: string,
  line: number,
  character: number,
  ctx: ReferenceContext
): SymbolAtCursor | null {
  const at = nodeAtCursor(file, line, character, ctx.store);
  if (!at) return null;
  const { trees, node } = at;

  if (!node.isNamed || LITERAL_TYPES.has(node.type)) return null;
  if (node.parent && (node.parent.type === 'semantics' || node.parent.type === 'bitfield_clause')) {
    return null;
  }
  if (node.type === 'word') {
    // ShaderLab 外壳里只有 Properties 属性名是符号（状态命令不是）
    if (node.parent?.type !== 'property_decl') return null;
    return { kind: 'global', name: node.text, node };
  }
  if (!NAME_TYPES.has(node.type)) return null;
  const name = node.text;

  if (node.type === 'field_identifier' && node.parent?.type === 'field_expression') {
    const base = node.parent.child(0);
    if (!base || base.type !== 'identifier') return { kind: 'member', name, structName: null, node };
    const structName = declaredTypeOf(base.text, node, file, trees, {
      index: ctx.index,
      includeCtx: ctx.includeCtx,
    });
    return { kind: 'member', name, structName, node };
  }

  const locals = findLocalDeclarations(node, file, name);
  if (locals.length) {
    const fn = node.closest('function_definition');
    if (fn) return { kind: 'local', name, locals, fnNode: fn, node };
  }
  return { kind: 'global', name, node };
}

function toLocation(file: string, start: { line: number; character: number }, end: { line: number; character: number }): Location {
  return { uri: pathToFileURL(file).toString(), range: { start, end } };
}

function pseudoLoc(file: string, range: { start: { line: number; character: number }; end: { line: number; character: number } }): SymbolLocation {
  return {
    file,
    startByte: 0,
    endByte: 0,
    start: { row: range.start.line, column: range.start.character },
    end: { row: range.end.line, column: range.end.character },
  };
}

export interface MemberOccurrence {
  file: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  decl: boolean;
  resolvable: boolean;
}

/** 成员字段的 occurrence：owner 过滤的声明 + 「左侧浅推断到该 struct」的使用 token。
 *  不可解析的同名成员 token 计入 unresolved（规格：宁漏勿错）。rename 共用（T-030）。 */
export function collectMemberOccurrences(
  structName: string,
  fieldName: string,
  ctx: ReferenceContext
): { occurrences: MemberOccurrence[]; unresolved: number } {
  const occurrences: MemberOccurrence[] = [];
  let unresolved = 0;

  const info = ctx.index.getByName(fieldName);
  const decls = (info?.locations ?? []).filter((l) => l.owner === structName);
  const declRanges = new Map<string, Set<string>>(
    [...new Set(decls.map((l) => l.file))].map((f) => [
      f,
      new Set(decls.filter((l) => l.file === f).map((l) => `${l.start.row}:${l.start.column}`)),
    ])
  );
  for (const d of decls) {
    occurrences.push({
      file: d.file,
      range: {
        start: { line: d.start.row, character: d.start.column },
        end: { line: d.end.row, character: d.end.column },
      },
      decl: true,
      resolvable: true,
    });
  }

  for (const file of ctx.index.fileNames()) {
    if (isGeneratedFile(file)) continue;
    const trees = docTrees(file, ctx.store);
    if (!trees) continue;
    const hits: SyntaxNode[] = [];
    const walk = (n: SyntaxNode): void => {
      if (n.childCount === 0) {
        if (n.type === 'field_identifier' && n.text === fieldName) hits.push(n);
        return;
      }
      for (const c of n.children) walk(c);
    };
    if (trees.hlslTree) walk(trees.hlslTree.rootNode);
    for (const n of hits) {
      // struct 声明里的字段 token 等「不是成员访问」的位置：由索引声明覆盖，不参与解析计数
      if (n.parent?.type !== 'field_expression') continue;
      const base = n.parent.child(0);
      if (!base || base.type !== 'identifier') {
        unresolved++;
        continue;
      }
      const t = declaredTypeOf(base.text, n, file, trees, {
        index: ctx.index,
        includeCtx: ctx.includeCtx,
      });
      if (t === structName) {
        const key = `${n.startPosition.row}:${n.startPosition.column}`;
        if (declRanges.get(file)?.has(key)) continue; // 声明位已收
        occurrences.push({
          file,
          range: {
            start: { line: n.startPosition.row, character: n.startPosition.column },
            end: { line: n.endPosition.row, character: n.endPosition.column },
          },
          decl: false,
          resolvable: true,
        });
      } else if (t === null) {
        unresolved++;
      }
      // t 为其他 struct → 是别的字段，静默排除（不是 unresolved）
    }
  }
  return { occurrences, unresolved };
}

function localOccurrences(
  sym: { name: string; locals: SymbolLocation[]; fnNode: SyntaxNode },
  file: string
): MemberOccurrence[] {
  const out: MemberOccurrence[] = [];
  const declKeys = new Set(sym.locals.map((l) => `${l.start.row}:${l.start.column}`));
  const walk = (n: SyntaxNode): void => {
    if (n.childCount === 0) {
      if (NAME_TYPES.has(n.type) && n.text === sym.name) {
        const key = `${n.startPosition.row}:${n.startPosition.column}`;
        out.push({
          file,
          range: {
            start: { line: n.startPosition.row, character: n.startPosition.column },
            end: { line: n.endPosition.row, character: n.endPosition.column },
          },
          decl: declKeys.has(key),
          resolvable: true,
        });
      }
      return;
    }
    for (const c of n.children) walk(c);
  };
  walk(sym.fnNode);
  return out;
}

export function provideReferences(
  file: string,
  line: number,
  character: number,
  ctx: ReferenceContext,
  includeDeclaration: boolean
): Location[] {
  const sym = resolveSymbolAt(file, line, character, ctx);
  if (!sym) return [];

  type Entry = { file: string; range: MemberOccurrence['range']; decl: boolean };
  let entries: Entry[] = [];
  let unresolved = 0;

  if (sym.kind === 'global') {
    const r = collectOccurrences(sym.name, { index: ctx.index, store: ctx.store, log: ctx.log });
    unresolved = r.unresolved;
    entries = r.occurrences
      .filter((o) => !isGeneratedFile(o.file))
      .filter((o) => includeDeclaration || !o.decl);
  } else if (sym.kind === 'member') {
    if (!sym.structName) return [];
    const r = collectMemberOccurrences(sym.structName, sym.name, ctx);
    unresolved = r.unresolved;
    if (unresolved > 0) ctx.log(`references: ${sym.name} unresolved=${unresolved}`);
    entries = r.occurrences
      .filter((o) => !isGeneratedFile(o.file))
      .filter((o) => includeDeclaration || !o.decl);
  } else {
    entries = localOccurrences(sym, file).filter((o) => includeDeclaration || !o.decl);
  }

  // 五层优先级排序（与 F12 同一 rankOf 口径）
  const closure = closureOrder(file, ctx.index, ctx.includeCtx);
  const rank = (e: Entry): number => rankOf(pseudoLoc(e.file, e.range), file, closure, ctx);
  entries.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.file.localeCompare(b.file) ||
      a.range.start.line - b.range.start.line ||
      a.range.start.character - b.range.start.character
  );

  const max = ctx.maxLocations ?? DEFAULT_MAX_REFERENCES;
  if (entries.length > max) {
    ctx.log(`references: ${sym.name} truncated=${entries.length} kept=${max}`);
    entries = entries.slice(0, max);
  }
  if (ctx.indexing?.() && entries.length) {
    ctx.log('references: 索引进行中，返回当前已索引结果');
  }
  return entries.map((e) => toLocation(e.file, e.range.start, e.range.end));
}
