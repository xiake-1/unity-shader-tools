/** 语义补全（规格 feature-completion；T-022～T-026 的实现主体）
 *
 * 上下文判定（T-022）：`.` 后 → 成员；`#include "…"` 字符串内 → 路径；HLSL 标识符位置 → 宏/函数；
 * 注释、非 include 字符串、ShaderLab 外壳 → 空列表。
 * 候选组装：成员复用 definition 的浅推断（T-023）；路径复用 includeResolver 四类 + 目录枚举（T-024）；
 * 标识符候选 = 用户宏（当前文件 + include 闭包）+ Unity/URP API（包内/内置的宏与函数）（T-025）。
 * 服务端前缀过滤、五层排序（当前文件→闭包→工程→包→内置）、300 截断 + isIncomplete（T-026）。
 * 只读唯一 CST、符号索引与 includeResolver，不引入第二套解析（设计原则 2）。
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  CompletionItem,
  CompletionItemKind,
  CompletionList,
  type Range,
} from 'vscode-languageserver';
import type Parser from 'tree-sitter';
import { resolveInclude, type IncludeContext } from './includeResolver';
import type { DocumentStore } from './documentStore';
import type { SymbolIndex, SymbolInfo } from './symbolIndex';
import { macroDescription } from './macroTable';
import { semanticCandidates } from './semanticTable';
import {
  closureOrder,
  declaredTypeOf,
  docTrees,
  offsetAt,
  rankOf,
  type DocTrees,
} from './definition';

type SyntaxNode = Parser.SyntaxNode;

const HLSL_EXT = /\.(hlsl|hlslinc|cginc|compute|raytrace)$/i;
const SHADER_EXT = /\.(shader|hlsl|hlslinc|cginc)$/i;
const RP_PKG = /^com\.unity\.render-pipelines\./i;
const MAX_ITEMS = 300;
/** 目录枚举缓存上限与每目录文件上限（性能约束：补全不得每次按键全表扫描） */
const WALK_LIMIT = 4000;

const STRINGISH = new Set(['string_content', 'string_literal', 'string', 'system_lib_string']);
/** 这些 token 上没有可补全的语义 */
const NO_COMPLETION = new Set([
  'comment',
  'number_literal',
  'bool_literal',
  'char_literal',
  'primitive_type',
  'semantics',
  'bitfield_clause',
  'preproc_directive',
]);

export interface CompletionContext {
  index: SymbolIndex;
  store: DocumentStore;
  includeCtx: IncludeContext;
  projectRoot: string | null;
  log: (msg: string) => void;
  indexing?: () => boolean;
  maxItems?: number;
}

export type CompletionSite =
  | { kind: 'member'; base: string; prefix: string; node: SyntaxNode }
  | { kind: 'include'; prefix: string; replaceRange: Range }
  | { kind: 'semantic'; prefix: string }
  | { kind: 'identifier'; prefix: string }
  | { kind: 'none' };

/** 语义位置的两类 CST 父节点（struct 字段 / 函数返回值；与 hover.ts 同一口径） */
const SEMANTIC_PARENTS = new Set(['semantics', 'bitfield_clause']);

interface Candidate {
  label: string;
  kind: CompletionItemKind;
  rank: number;
  doc?: string;
  insertText?: string;
  textEdit?: { range: Range; newText: string };
}

function ancestor(node: SyntaxNode, type: string): SyntaxNode | null {
  let cur: SyntaxNode | null = node;
  while (cur) {
    if (cur.type === type) return cur;
    cur = cur.parent;
  }
  return null;
}

/** 打开文档/磁盘文件的树（复用 definition 的缓存），补全与跳转同一棵树 */
function treesFor(file: string, ctx: CompletionContext): DocTrees | null {
  return docTrees(file, ctx.store);
}

/** T-022：上下文判定 */
export function detectCompletionSite(
  file: string,
  line: number,
  character: number,
  ctx: CompletionContext
): CompletionSite {
  const trees = treesFor(file, ctx);
  if (!trees) return { kind: 'none' };
  const { text, labTree, hlslTree, bodies } = trees;
  const offset = offsetAt(text, line, character);
  const inProgram = bodies.some(
    (b) => (b.kind === 'hlsl' || b.kind === 'cg') && offset >= b.startByte && offset < b.endByte
  );
  const tree = labTree && !inProgram ? labTree : hlslTree;
  if (!tree) return { kind: 'none' };
  const hlslSide = inProgram || !labTree; // .hlsl 系文件全文都是 HLSL 侧
  if (character === 0) return hlslSide ? { kind: 'identifier', prefix: '' } : { kind: 'none' };

  const before = tree.rootNode.descendantForPosition({ row: line, column: character - 1 });

  // 1) `#include "…"` 字符串内 → 路径候选
  if (ancestor(before, 'preproc_include') && STRINGISH.has(before.type)) {
    const raw = before.text;
    const quoteLead = raw.startsWith('"') ? 1 : 0;
    const quoteTail = raw.endsWith('"') && before.type !== 'string_content' ? 1 : 0;
    const contentStartCol = before.startPosition.column + quoteLead;
    const contentEndCol = before.endPosition.column - quoteTail;
    if (character < contentStartCol || character > contentEndCol) return { kind: 'none' };
    const prefix = raw.slice(quoteLead, character - before.startPosition.column);
    return {
      kind: 'include',
      prefix,
      replaceRange: {
        start: { line, character: contentStartCol },
        end: { line, character: contentEndCol },
      },
    };
  }

  // 2) 成员访问：光标紧跟 `.`，或 `.` 后已输入部分字段名
  if (before.type === '.') {
    const fe = before.parent;
    const base = fe?.children[0];
    if (fe && base?.type === 'identifier' && (fe.type === 'field_expression' || fe.type === 'ERROR')) {
      return { kind: 'member', base: base.text, prefix: '', node: before };
    }
    return { kind: 'none' };
  }
  if (
    (before.type === 'identifier' || before.type === 'field_identifier') &&
    before.parent?.type === 'field_expression' &&
    before !== before.parent.children[0]
  ) {
    const base = before.parent.children[0];
    const hasDot = before.parent.children.some((c) => c.type === '.');
    if (base?.type === 'identifier' && hasDot) {
      const prefix = before.text.slice(0, Math.max(0, character - before.startPosition.column));
      return { kind: 'member', base: base.text, prefix, node: before };
    }
  }

  // 3) 语义位置（2026-10-28 二次修订）：struct 字段 / 函数返回值 `:` 后 → 语义候选
  //    （先于 NO_COMPLETION：`pos : ` 空格处 descendantForPosition 落在 bitfield_clause/semantics 本身）
  if (before.type === 'bitfield_clause' || before.type === 'semantics') {
    return { kind: 'semantic', prefix: '' };
  }
  if (before.type === ':' && before.parent && SEMANTIC_PARENTS.has(before.parent.type)) {
    return { kind: 'semantic', prefix: '' };
  }
  if (
    (before.type === 'identifier' || before.type === 'type_identifier') &&
    before.parent &&
    SEMANTIC_PARENTS.has(before.parent.type)
  ) {
    const prefix = before.text.slice(0, Math.max(0, character - before.startPosition.column));
    return { kind: 'semantic', prefix };
  }

  // 4) 空结果面：注释、字面量、非 include 字符串
  if (NO_COMPLETION.has(before.type) || STRINGISH.has(before.type)) return { kind: 'none' };

  // 5) 标识符位置（仅 HLSL 侧；ShaderLab 外壳补全不在 M3）
  if (!hlslSide) return { kind: 'none' };
  if (before.type === 'identifier' || before.type === 'type_identifier') {
    const prefix = before.text.slice(0, Math.max(0, character - before.startPosition.column));
    return { kind: 'identifier', prefix };
  }
  return { kind: 'identifier', prefix: '' };
}

/** T-023：struct 成员候选（浅推断与 F12 同一实现）
 *  可见性分层（2026-10-28 手动测试修复）：同名 struct 在多个文件各定义各的（Unity 每个
 *  编译单元一份），字段不跨工程并集——当前文件+include 闭包(≤1)有定义就只用这一层；
 *  否则包内/内置(≥3)；再否则退回工程内(2)（闭包解析不全时兜底，保持旧行为可用）。 */
function memberCandidates(
  site: { base: string; prefix: string; node: SyntaxNode },
  file: string,
  trees: DocTrees,
  ctx: CompletionContext
): Candidate[] {
  const structName = declaredTypeOf(site.base, site.node, file, trees, {
    index: ctx.index,
    includeCtx: ctx.includeCtx,
  });
  if (!structName) return [];
  const closure = closureOrder(file, ctx.index, ctx.includeCtx);
  const ranked: Array<{ f: { name: string; doc?: string }; rank: number }> = [];
  for (const f of ctx.index.fieldsOfStruct(structName)) {
    if (site.prefix && !f.name.startsWith(site.prefix)) continue;
    const locs = f.locations.filter((l) => l.owner === structName);
    if (!locs.length) continue;
    const rank = Math.min(...locs.map((l) => rankOf(l, file, closure, ctx)));
    ranked.push({ f, rank });
  }
  const tier = (r: number): number => (r <= 1 ? 0 : r >= 3 ? 1 : 2);
  const minTier = ranked.length ? Math.min(...ranked.map((x) => tier(x.rank))) : 0;
  const out: Candidate[] = [];
  for (const x of ranked) {
    if (tier(x.rank) !== minTier) continue;
    out.push({ label: x.f.name, kind: CompletionItemKind.Field, rank: x.rank, doc: x.f.doc, insertText: x.f.name });
  }
  return out;
}

/** 目录枚举缓存（按 mtime 失效）：dir → 该目录下 shader 系文件的相对路径（正斜杠） */
const walkCache = new Map<string, { mtimeMs: number; rels: string[] }>();

function walkShaderFiles(dir: string): string[] {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(dir).mtimeMs;
  } catch {
    return [];
  }
  const hit = walkCache.get(dir);
  if (hit && hit.mtimeMs === mtimeMs) return hit.rels;
  const rels: string[] = [];
  const stack: Array<{ abs: string; rel: string }> = [{ abs: dir, rel: '' }];
  while (stack.length && rels.length < WALK_LIMIT) {
    const { abs, rel } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === 'Temp' || e.name === 'obj' || e.name === '.git') continue;
        stack.push({ abs: path.join(abs, e.name), rel: rel ? `${rel}/${e.name}` : e.name });
      } else if (SHADER_EXT.test(e.name)) {
        rels.push(rel ? `${rel}/${e.name}` : e.name);
      }
    }
  }
  walkCache.set(dir, { mtimeMs, rels });
  return rels;
}

function listDirNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((e) => SHADER_EXT.test(e));
  } catch {
    return [];
  }
}

/** T-024：`#include` 路径候选（四类规则同源：同目录 / Assets / Packages(+PackageCache) / 内置裸名） */
function includeCandidates(
  site: { prefix: string; replaceRange: Range },
  file: string,
  ctx: CompletionContext
): Candidate[] {
  const specs = new Map<string, number>(); // spec → 最小 rank
  const put = (spec: string, rank: number): void => {
    const prev = specs.get(spec);
    if (prev === undefined || rank < prev) specs.set(spec, rank);
  };

  for (const name of listDirNames(path.dirname(file))) put(name, 0);
  if (ctx.projectRoot) {
    for (const rel of walkShaderFiles(path.join(ctx.projectRoot, 'Assets'))) put(`Assets/${rel}`, 2);
    for (const rel of walkShaderFiles(path.join(ctx.projectRoot, 'Packages'))) put(`Packages/${rel}`, 2);
  }
  const pc = ctx.includeCtx.packageCacheDir;
  if (pc) {
    let pkgs: string[] = [];
    try {
      pkgs = fs.readdirSync(pc).filter((e) => RP_PKG.test(e));
    } catch {
      pkgs = [];
    }
    for (const pkgDir of pkgs) {
      const pkg = pkgDir.split('@')[0];
      const lib = path.join(pc, pkgDir, 'ShaderLibrary');
      for (const rel of walkShaderFiles(lib)) put(`Packages/${pkg}/ShaderLibrary/${rel}`, 3);
    }
  }
  for (const name of listDirNames(ctx.includeCtx.cgIncludesDir ?? '')) put(name, 4);

  const normPrefix = site.prefix.replace(/\\/g, '/').toLowerCase();
  const out: Candidate[] = [];
  for (const [spec, rank] of specs) {
    if (normPrefix && !spec.toLowerCase().startsWith(normPrefix)) continue;
    out.push({ label: spec, kind: CompletionItemKind.File, rank, insertText: spec, textEdit: { range: site.replaceRange, newText: spec } });
  }
  return out;
}

/** T-025：标识符候选 = 用户宏（当前文件 + 闭包）+ Unity/URP API（包内/内置宏与函数）；
 *  文档兜底链：真实源码邻近注释 → macroTable 描述 → 空。
 *  2026-10-28 手动测试扩展（feature-completion §2 修订）：用户声明的全局变量
 *  （当前文件/闭包）、Properties 属性（当前文件）、包内/内置全局变量（_Time 等）也进候选；
 *  可见性口径与宏一致——工程内非闭包文件(2) 的变量/函数/宏都不进（不同编译单元不可见）。 */
function identifierCandidates(site: { prefix: string }, file: string, ctx: CompletionContext): Candidate[] {
  const closure = closureOrder(file, ctx.index, ctx.includeCtx);
  const out: Candidate[] = [];
  for (const info of ctx.index.queryByPrefix(site.prefix, 2000)) {
    if (info.kind === 'struct' || info.kind === 'field') continue; // struct 名/字段不作标识符候选
    let best = Infinity;
    for (const l of info.locations) {
      const r = rankOf(l, file, closure, ctx);
      // 可见层：当前文件(0)/闭包(1)/包(3)/内置(4)；property 只认当前文件+闭包；
      // 工程内其他文件(2) 一律不进（编译单元不可见）。
      const relevant = info.kind === 'property' ? r <= 1 : r <= 1 || r >= 3;
      if (relevant) best = Math.min(best, r);
    }
    if (best === Infinity) continue;
    const kind =
      info.kind === 'function'
        ? CompletionItemKind.Function
        : info.kind === 'variable'
          ? CompletionItemKind.Variable
          : info.kind === 'property'
            ? CompletionItemKind.Property
            : CompletionItemKind.Class;
    out.push({
      label: info.name,
      kind,
      rank: best,
      doc: info.doc ?? macroDescription(info.name),
      insertText: info.name,
    });
  }
  return out;
}

/** 2026-10-28 二次修订：语义候选（struct 字段 / 函数返回值 `:` 后；词条复用 semanticTable，不写第二份表）
 *  前缀过滤大小写不敏感（DX 语义本就大小写不敏感：`SV_POS` 应命中 `SV_Position`），插入用 canonical 名。 */
function semanticSiteCandidates(site: { prefix: string }): Candidate[] {
  const p = site.prefix.toLowerCase();
  const out: Candidate[] = [];
  for (const c of semanticCandidates()) {
    if (p && !c.name.toLowerCase().startsWith(p)) continue;
    out.push({ label: c.name, kind: CompletionItemKind.Keyword, rank: 0, doc: c.doc, insertText: c.name });
  }
  return out;
}

function toItem(c: Candidate): CompletionItem {
  const item: CompletionItem = {
    label: c.label,
    kind: c.kind,
    sortText: `${c.rank}|${c.label}`,
  };
  if (c.doc) item.documentation = { kind: 'markdown', value: c.doc };
  if (c.textEdit) item.textEdit = c.textEdit;
  else item.insertText = c.insertText;
  return item;
}

export function provideCompletion(
  file: string,
  line: number,
  character: number,
  ctx: CompletionContext
): CompletionList {
  const site = detectCompletionSite(file, line, character, ctx);
  let candidates: Candidate[] = [];
  if (site.kind === 'member') {
    const trees = treesFor(file, ctx);
    if (trees) candidates = memberCandidates(site, file, trees, ctx);
  } else if (site.kind === 'include') {
    candidates = includeCandidates(site, file, ctx);
  } else if (site.kind === 'semantic') {
    candidates = semanticSiteCandidates(site);
  } else if (site.kind === 'identifier') {
    candidates = identifierCandidates(site, file, ctx);
  }

  candidates.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  const cap = ctx.maxItems ?? MAX_ITEMS;
  const incomplete = candidates.length > cap;
  if (incomplete) {
    ctx.log(`completion: truncated=${candidates.length} kept=${cap}`);
    candidates = candidates.slice(0, cap);
  }
  if (ctx.indexing?.() && candidates.length) {
    ctx.log('completion: 索引进行中，返回当前已索引结果');
  }
  return { isIncomplete: incomplete, items: candidates.map(toItem) };
}

export function clearCompletionCache(): void {
  walkCache.clear();
}
