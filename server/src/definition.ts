/** 转到定义（规格 feature-go-to-definition；T-014～T-017 的实现主体）
 *
 * 查询链：光标 token → 分类（`#include` 字符串 / `#pragma` 入口函数 / 成员访问 /
 * 局部作用域 / 全局符号）→ `Location[]`
 * 排序优先级：当前文件 → include 闭包（按 include 顺序）→ 工程内 → 包内 → 内置；
 * 同名 >10 截断并记日志；返回前对每个目标做存在性校验（规格约束）。
 * 只读核心规格的符号索引与 CST，不引入第二套解析路径（设计原则 2）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { Location } from 'vscode-languageserver';
import type Parser from 'tree-sitter';
import {
  buildVirtualHlsl,
  extractProgramBodies,
  parseHlslFile,
  parseShaderLab,
  type ProgramBody,
  type Tree,
} from './parser';
import { resolveInclude, type IncludeContext } from './includeResolver';
import type { DocumentStore } from './documentStore';
import type { SymbolIndex, SymbolLocation } from './symbolIndex';
import { findLocalDeclarations, globalDeclaredType, localDeclaredType } from './scopeResolver';

type SyntaxNode = Parser.SyntaxNode;

const HLSL_EXT = /\.(hlsl|hlslinc|cginc|compute|raytrace)$/i;
const DEFAULT_MAX_LOCATIONS = 10;
/** 成员访问跨文件找变量类型时，最多解析多少个 include 闭包文件 */
const TYPE_SEARCH_FILE_LIMIT = 40;

/** `#pragma vertex vert` 之类：关键字之后的名字是函数引用 */
const PRAGMA_FUNCTION_KEYWORDS = new Set([
  'vertex',
  'fragment',
  'geometry',
  'hull',
  'domain',
  'compute',
  'patch',
  'prefetch',
]);

/** 名字类 token（ShaderLab 的 `word` 单独处理：只有 Properties 属性名可跳） */
const NAME_TYPES = new Set(['identifier', 'field_identifier', 'type_identifier']);

/** 字面量 / 无语义 token：这些位置没有定义可言 */
const LITERAL_TYPES = new Set([
  'comment',
  'number_literal',
  'bool_literal',
  'char_literal',
  'string_literal',
  'string',
  'system_lib_string',
  'primitive_type',
  'semantics',
  'bitfield_clause',
  'preproc_directive',
]);

const STRINGISH = new Set(['string_content', 'string_literal', 'string', 'system_lib_string']);

export interface DefinitionContext {
  index: SymbolIndex;
  store: DocumentStore;
  includeCtx: IncludeContext;
  projectRoot: string | null;
  log: (msg: string) => void;
  /** 索引是否仍在进行（规格：立即返回当前已索引结果，不等待） */
  indexing?: () => boolean;
  maxLocations?: number;
}

interface DocTrees {
  text: string;
  labTree: Tree | null;
  hlslTree: Tree | null;
  bodies: ProgramBody[];
}

/** 打开文档按 store 的树对象缓存（编辑后换新树即失效）；磁盘文件按 mtime 缓存 */
const byStoreTree = new WeakMap<Tree, DocTrees>();
const byDisk = new Map<string, { mtimeMs: number; trees: DocTrees }>();
const hlslTreeByDisk = new Map<string, { mtimeMs: number; tree: Tree }>();

export function clearDefinitionCache(): void {
  byDisk.clear();
  hlslTreeByDisk.clear();
}

const norm = (p: string): string => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
const samePath = (a: string, b: string): boolean => norm(a) === norm(b);
const under = (file: string, dir: string | null): boolean =>
  !!dir && norm(file).startsWith(norm(dir) + path.sep);

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function offsetAt(text: string, line: number, character: number): number {
  let off = 0;
  let row = 0;
  while (row < line && off < text.length) {
    if (text[off] === '\n') row++;
    off++;
  }
  return off + character;
}

function buildTrees(file: string, text: string, storeTree: Tree | null): DocTrees {
  if (HLSL_EXT.test(path.extname(file))) {
    const hlslTree = storeTree ?? parseHlslFile(text);
    return { text, labTree: null, hlslTree, bodies: [] };
  }
  const labTree = storeTree ?? parseShaderLab(text);
  const bodies = extractProgramBodies(labTree, text);
  const virtual = buildVirtualHlsl(text, bodies);
  const hlslTree = virtual.trim().length > 0 ? parseHlslFile(virtual) : null;
  return { text, labTree, hlslTree, bodies };
}

function docTrees(file: string, ctx: DefinitionContext): DocTrees | null {
  const doc = ctx.store.get(file);
  if (doc) {
    if (doc.generated || !doc.tree) return null;
    const hit = byStoreTree.get(doc.tree);
    if (hit) return hit;
    const built = buildTrees(file, doc.text, doc.tree);
    byStoreTree.set(doc.tree, built);
    return built;
  }
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const hit = byDisk.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.trees;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const built = buildTrees(file, text, null);
  byDisk.set(file, { mtimeMs, trees: built });
  return built;
}

function parseHlslFromDisk(file: string): Tree | null {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const hit = hlslTreeByDisk.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.tree;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const tree = parseHlslFile(text);
    hlslTreeByDisk.set(file, { mtimeMs, tree });
    return tree;
  } catch {
    return null;
  }
}

function ancestor(node: SyntaxNode, type: string): SyntaxNode | null {
  let cur: SyntaxNode | null = node;
  while (cur) {
    if (cur.type === type) return cur;
    cur = cur.parent;
  }
  return null;
}

/** `#include "A.hlsl"` / `#include <A.cginc>` 的规格文本 */
function includeSpec(inc: SyntaxNode): string | null {
  const lit = inc.children.find((c) =>
    ['string_literal', 'system_lib_string', 'string'].includes(c.type)
  );
  if (!lit) return null;
  if (lit.type === 'string_literal') {
    const content = lit.children.find((c) => c.type === 'string_content');
    return (content ? content.text : lit.text).replace(/^"|"$/g, '');
  }
  return lit.text.replace(/^[<"]|[>"]$/g, '');
}

/** `#pragma vertex vert` 里光标落在函数名段上时返回该名字 */
function pragmaFunctionName(node: SyntaxNode, character: number): string | null {
  const directive = node.parent?.children.find((c) => c.type === 'preproc_directive')?.text;
  if (directive !== '#pragma') return null;
  const text = node.text;
  const rel = character - node.startPosition.column;
  if (rel < 0) return null;
  const segments = [...text.matchAll(/\S+/g)];
  let keyword: string | null = null;
  for (let i = 0; i < segments.length; i++) {
    const start = segments[i].index ?? 0;
    const value = segments[i][0];
    if (i === 0) keyword = value.toLowerCase();
    if (rel >= start && rel < start + value.length) {
      if (i === 0) return null;
      return keyword && PRAGMA_FUNCTION_KEYWORDS.has(keyword) ? value : null;
    }
  }
  return null;
}

/** include 闭包：文件 → 顺序号（1 起），用于「include 闭包」这一档的内部排序 */
function closureOrder(file: string, ctx: DefinitionContext): Map<string, number> {
  const resolve = (spec: string, from: string): string | null =>
    resolveInclude(spec, from, ctx.includeCtx).resolved;
  const files = ctx.index.includeClosure(file, resolve);
  const map = new Map<string, number>();
  files.forEach((f, i) => map.set(norm(f), i + 1));
  return map;
}

function rankOf(loc: SymbolLocation, file: string, closure: Map<string, number>, ctx: DefinitionContext): number {
  if (samePath(loc.file, file)) return 0;
  if (closure.has(norm(loc.file))) return 1;
  if (under(loc.file, ctx.includeCtx.cgIncludesDir)) return 4;
  if (under(loc.file, ctx.includeCtx.packageCacheDir)) return 3;
  if (under(loc.file, ctx.projectRoot)) return 2;
  return 2;
}

function sortLocations(locs: SymbolLocation[], file: string, ctx: DefinitionContext): SymbolLocation[] {
  const closure = closureOrder(file, ctx);
  const key = (l: SymbolLocation): number => {
    const r = rankOf(l, file, closure, ctx);
    const inner = r === 1 ? (closure.get(norm(l.file)) ?? 0) : 0;
    return r * 100000 + Math.min(inner, 99999);
  };
  return [...locs].sort(
    (a, b) => key(a) - key(b) || norm(a.file).localeCompare(norm(b.file)) || a.start.row - b.start.row
  );
}

function toLocation(l: SymbolLocation): Location {
  return {
    uri: pathToFileURL(l.file).toString(),
    range: {
      start: { line: l.start.row, character: l.start.column },
      end: { line: l.end.row, character: l.end.column },
    },
  };
}

/** 存在性校验 + 截断（规格约束与异常表） */
function finalize(locs: SymbolLocation[], ctx: DefinitionContext, name: string): Location[] {
  const existing = locs.filter((l) => isFile(l.file));
  const dropped = locs.length - existing.length;
  if (dropped) ctx.log(`definition ${name}: 丢弃 ${dropped} 个不存在的目标文件`);
  const max = ctx.maxLocations ?? DEFAULT_MAX_LOCATIONS;
  if (existing.length > max) {
    ctx.log(`definition ${name}: truncated=${existing.length} kept=${max}`);
    return existing.slice(0, max).map(toLocation);
  }
  return existing.map(toLocation);
}

function globalLocations(name: string, file: string, ctx: DefinitionContext): SymbolLocation[] {
  const info = ctx.index.getByName(name);
  if (!info || info.locations.length === 0) return [];
  return sortLocations(info.locations, file, ctx);
}

/** 变量声明处的类型名：先看当前作用域链，再看当前文件顶层，最后按 include 闭包限量解析 */
function declaredTypeOf(
  base: string,
  node: SyntaxNode,
  file: string,
  trees: DocTrees,
  ctx: DefinitionContext
): string | null {
  const local = localDeclaredType(node, base);
  if (local) return local;
  if (trees.hlslTree) {
    const t = globalDeclaredType(trees.hlslTree.rootNode, base);
    if (t) return t;
  }
  const resolve = (spec: string, from: string): string | null =>
    resolveInclude(spec, from, ctx.includeCtx).resolved;
  for (const f of ctx.index.includeClosure(file, resolve).slice(0, TYPE_SEARCH_FILE_LIMIT)) {
    if (samePath(f, file)) continue;
    const tree = parseHlslFromDisk(f);
    if (!tree) continue;
    const t = globalDeclaredType(tree.rootNode, base);
    if (t) return t;
  }
  return null;
}

function memberLocations(
  base: string,
  field: string,
  node: SyntaxNode,
  file: string,
  trees: DocTrees,
  ctx: DefinitionContext
): SymbolLocation[] {
  const structName = declaredTypeOf(base, node, file, trees, ctx);
  if (!structName) return [];
  const info = ctx.index.getByName(field);
  if (!info) return [];
  const owned = info.locations.filter((l) => l.owner === structName);
  if (owned.length) return sortLocations(owned, file, ctx);
  // 兜底：字段没有 owner 标记时，退化为「与 struct 声明同文件」的弱匹配
  const struct = ctx.index.getByName(structName);
  if (!struct) return [];
  const structFiles = new Set(struct.locations.map((l) => norm(l.file)));
  return sortLocations(
    info.locations.filter((l) => structFiles.has(norm(l.file))),
    file,
    ctx
  );
}

export function provideDefinition(
  file: string,
  line: number,
  character: number,
  ctx: DefinitionContext
): Location[] {
  const trees = docTrees(file, ctx);
  if (!trees) return [];
  const { text, labTree, hlslTree, bodies } = trees;

  const offset = offsetAt(text, line, character);
  const inProgram = bodies.some(
    (b) => (b.kind === 'hlsl' || b.kind === 'cg') && offset >= b.startByte && offset < b.endByte
  );
  const tree = labTree && !inProgram ? labTree : hlslTree;
  if (!tree) return [];

  const node = tree.rootNode.descendantForPosition({ row: line, column: character });

  // 1) `#include "…"` 字符串 → 打开目标文件（复用四类 include 规则）
  const inc = ancestor(node, 'preproc_include');
  if (inc && STRINGISH.has(node.type)) {
    const spec = includeSpec(inc);
    if (!spec) return [];
    const r = resolveInclude(spec, file, ctx.includeCtx);
    if (!r.resolved) {
      ctx.log(`definition: include "${spec}" 未解析（${r.failure?.reason ?? 'unknown'}）`);
      return [];
    }
    return [toLocation({ file: r.resolved, startByte: 0, endByte: 0, start: { row: 0, column: 0 }, end: { row: 0, column: 0 } })];
  }

  // 2) `#pragma vertex vert` 的函数名
  if (node.type === 'preproc_arg') {
    const name = pragmaFunctionName(node, character);
    if (!name) return [];
    return finalize(globalLocations(name, file, ctx), ctx, name);
  }

  // 3) 注释、字面量、匿名标点、语义名 → 无定义
  if (!node.isNamed || LITERAL_TYPES.has(node.type)) return [];
  if (node.parent && (node.parent.type === 'semantics' || node.parent.type === 'bitfield_clause')) return [];

  // 4) ShaderLab：只有 Properties 属性名可跳；状态命令（`Cull Off`）等一律无定义
  if (node.type === 'word') {
    if (node.parent?.type !== 'property_decl') return [];
    return finalize(globalLocations(node.text, file, ctx), ctx, node.text);
  }

  if (!NAME_TYPES.has(node.type)) return [];
  const name = node.text;

  // 5) 成员访问 `变量.字段`（单层；链式与函数返回值成员属 M5）
  if (node.type === 'field_identifier' && node.parent?.type === 'field_expression') {
    const base = node.parent.child(0);
    if (!base || base.type !== 'identifier') return [];
    return finalize(memberLocations(base.text, name, node, file, trees, ctx), ctx, name);
  }

  // 6) 局部变量 / 函数参数：命中即只返回局部（遮蔽语义）
  const locals = findLocalDeclarations(node, file, name);
  if (locals.length) return finalize(locals, ctx, name);

  // 7) 全局符号（工程内 / 包内 / 内置）
  const globals = globalLocations(name, file, ctx);
  if (!globals.length && ctx.indexing?.()) {
    ctx.log(`definition: ${name} 未命中且索引进行中，返回当前已索引结果`);
  }
  return finalize(globals, ctx, name);
}
