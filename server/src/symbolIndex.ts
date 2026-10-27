/** 符号索引与查询 API（规格范围 6、T-012）
 *
 * 只索引声明，不索引表达式。来源：
 * - ShaderLab：`Properties` 块属性（property）
 * - HLSL（含 .hlsl/.cginc 独立文件与 .shader 内的程序块）：全局变量、函数（含重载）、
 *   struct 及其字段、`#define` 宏、已知宏声明表命中的宏声明
 * 同名符号（Properties 与 HLSL 的 `_MainTex`、`#if` 分支里的重复声明）合并为一条逻辑符号，
 * 保留全部 location —— 不猜激活分支（预处理器求值属 M4）。
 */
import * as path from 'path';
import type Parser from 'tree-sitter';
import type { Tree } from './parser';
import {
  parseShaderLab,
  parseHlslFile,
  extractProgramBodies,
  buildVirtualHlsl,
  countErrorNodes,
  walk,
} from './parser';
import { isDeclarationMacro, macroKind } from './macroTable';

export type SymbolKind = 'property' | 'variable' | 'function' | 'struct' | 'field' | 'macro';

export interface Position {
  row: number;
  column: number;
}

export interface SymbolLocation {
  file: string;
  startByte: number;
  endByte: number;
  start: Position;
  end: Position;
  /** 由哪个宏声明而来（TEXTURE2D / CBUFFER_START…），便于 UI 标注 */
  viaMacro?: string;
  /** 字段所属的 struct 名（M2 成员访问跳转据此过滤同名不同 struct 的字段） */
  owner?: string;
}

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  locations: SymbolLocation[];
}

export interface FileIndex {
  file: string;
  symbols: SymbolInfo[];
  /** 原始 include 规格文本（未解析），由 includeResolver 解析 */
  includes: string[];
  errorCount: number;
}

const HLSL_EXT = /\.(hlsl|hlslinc|cginc|compute|raytrace)$/i;

function loc(node: Parser.SyntaxNode, file: string, viaMacro?: string): SymbolLocation {
  return {
    file,
    startByte: node.startIndex,
    endByte: node.endIndex,
    start: { row: node.startPosition.row, column: node.startPosition.column },
    end: { row: node.endPosition.row, column: node.endPosition.column },
    ...(viaMacro ? { viaMacro } : {}),
  };
}

function textOf(node: Parser.SyntaxNode, text: string): string {
  return text.slice(node.startIndex, node.endIndex);
}

/** 声明节点里「被声明的名字」：跳过类型与参数列表/初始化表达式 */
const SKIP_IN_DECLARATOR = new Set([
  'call_expression',
  'initializer_list',
  'binary_expression',
  'conditional_expression',
  'parenthesized_expression',
  'argument_list',
  'parameter_list',
  'function_declarator',
  'struct_specifier',
  'compound_statement',
  'sizeof_expression',
  'comment',
  // `float2 uv : TEXCOORD0;` 里的语义名不是被声明的符号（bitfield_clause 是 HLSL 语义的载体）
  'bitfield_clause',
]);

function declaredNames(node: Parser.SyntaxNode, out: Parser.SyntaxNode[]): void {
  for (const c of node.children) {
    if (SKIP_IN_DECLARATOR.has(c.type)) continue;
    if (c.type === 'identifier' || c.type === 'field_identifier') {
      out.push(c);
      continue;
    }
    declaredNames(c, out);
  }
}

/** 宏声明的参数位是被声明的名字：`TEXTURE2D(_MainTex)` 里 `_MainTex` 被 HLSL grammar
 *  当作 parameter_declaration 下的 type_identifier（未知标识符默认按类型处理） */
function parameterIdentifiers(node: Parser.SyntaxNode, out: Parser.SyntaxNode[]): void {
  for (const c of node.children) {
    if (c.type === 'identifier' || c.type === 'type_identifier') {
      out.push(c);
      continue;
    }
    if (c.type === 'call_expression' || c.type === 'binary_expression') continue;
    parameterIdentifiers(c, out);
  }
}

/** ShaderLab 层：Properties 属性 + include 规格 */
function extractShaderLab(
  root: Parser.SyntaxNode,
  text: string,
  file: string
): { symbols: Array<{ name: string; kind: SymbolKind; loc: SymbolLocation }>; includes: string[] } {
  const symbols: Array<{ name: string; kind: SymbolKind; loc: SymbolLocation }> = [];
  const includes: string[] = [];
  walk(root, (n) => {
    if (n.type === 'property_decl') {
      const nameNode = n.children.find((c) => c.type === 'word');
      if (nameNode) {
        symbols.push({ name: textOf(nameNode, text), kind: 'property', loc: loc(nameNode, file) });
      }
    } else if (n.type === 'preproc_include') {
      const str = n.children.find((c) => c.type === 'string');
      if (str) includes.push(textOf(str, text).replace(/^"|"$/g, ''));
    }
  });
  return { symbols, includes };
}

/** HLSL 层：变量 / 函数 / struct 与字段 / 宏 / 宏声明 */
function extractHlsl(
  root: Parser.SyntaxNode,
  text: string,
  file: string
): { symbols: Array<{ name: string; kind: SymbolKind; loc: SymbolLocation; viaMacro?: string }>; includes: string[] } {
  const symbols: Array<{ name: string; kind: SymbolKind; loc: SymbolLocation; viaMacro?: string }> = [];
  const includes: string[] = [];

  walk(root, (n) => {
    switch (n.type) {
      case 'preproc_include': {
        const lit = n.children.find((c) =>
          ['string_literal', 'system_lib_string', 'string', 'path'].includes(c.type)
        );
        if (!lit) break;
        if (lit.type === 'string_literal') {
          const content = lit.children.find((c) => c.type === 'string_content');
          includes.push(textOf(content ?? lit, text).replace(/^"|"$/g, ''));
        } else {
          includes.push(textOf(lit, text).replace(/^[<"]|[>"]$/g, ''));
        }
        break;
      }
      case 'preproc_def': {
        const id = n.children.find((c) => c.type === 'identifier');
        if (id) symbols.push({ name: textOf(id, text), kind: 'macro', loc: loc(id, file) });
        break;
      }
      case 'struct_specifier': {
        const name = n.children.find((c) => c.type === 'type_identifier');
        if (name) symbols.push({ name: textOf(name, text), kind: 'struct', loc: loc(name, file) });
        const list = n.children.find((c) => c.type === 'field_declaration_list');
        if (list) {
          const owner = name ? textOf(name, text) : undefined;
          for (const field of list.children.filter((c) => c.type === 'field_declaration')) {
            const names: Parser.SyntaxNode[] = [];
            declaredNames(field, names);
            for (const id of names) {
              const l = loc(id, file);
              if (owner) l.owner = owner;
              symbols.push({ name: textOf(id, text), kind: 'field', loc: l });
            }
          }
        }
        break;
      }
      case 'function_definition': {
        // 函数名在 function_declarator 里（可能嵌在 pointer_declarator 之下）
        const stack: Parser.SyntaxNode[] = [n];
        let pushed = false;
        while (stack.length && !pushed) {
          const cur = stack.shift()!;
          if (cur.type === 'function_declarator') {
            const id = cur.children.find((c) => c.type === 'identifier');
            if (id) {
              symbols.push({ name: textOf(id, text), kind: 'function', loc: loc(id, file) });
              pushed = true;
            }
            continue;
          }
          if (cur.type === 'compound_statement') continue;
          for (const c of cur.children) stack.push(c);
        }
        break;
      }
      case 'declaration': {
        // `CBUFFER_END TEXTURE2D(_MainTex);` 这类会被 HLSL grammar 解析成
        // 「类型 + 函数声明」：命中宏表时按宏声明处理，否则视为函数原型。
        for (const fd of n.children.filter((c) => c.type === 'function_declarator')) {
          const id = fd.children.find((c) => c.type === 'identifier');
          if (!id) continue;
          const macroName = textOf(id, text);
          if (isDeclarationMacro(macroName)) {
            const params = fd.children.find((c) => c.type === 'parameter_list');
            if (params) {
              const ids: Parser.SyntaxNode[] = [];
              parameterIdentifiers(params, ids);
              for (const p of ids) {
                symbols.push({
                  name: textOf(p, text),
                  kind: 'variable',
                  loc: loc(p, file, macroName),
                  viaMacro: macroName,
                });
              }
            }
          } else {
            symbols.push({ name: macroName, kind: 'function', loc: loc(id, file) });
          }
        }
        const names: Parser.SyntaxNode[] = [];
        declaredNames(n, names);
        for (const id of names) {
          symbols.push({ name: textOf(id, text), kind: 'variable', loc: loc(id, file) });
        }
        break;
      }
      case 'call_expression': {
        // 宏声明：`TEXTURE2D(_MainTex);` 之类
        const callee = n.child(0);
        if (!callee || callee.type !== 'identifier') break;
        const macroName = textOf(callee, text);
        if (!isDeclarationMacro(macroName)) break;
        const kind = macroKind(macroName);
        if (kind === 'buffer-start' || kind === 'buffer-end') break;
        const args = n.children.find((c) => c.type === 'argument_list');
        if (!args) break;
        for (const id of args.children.filter((c) => c.type === 'identifier')) {
          symbols.push({
            name: textOf(id, text),
            kind: 'variable',
            loc: loc(id, file, macroName),
            viaMacro: macroName,
          });
        }
        break;
      }
      default:
        break;
    }
  });
  return { symbols, includes };
}

export class SymbolIndex {
  private byName = new Map<string, SymbolInfo>();
  private byFile = new Map<string, FileIndex>();

  /** 索引一个文件；重复索引会先清除旧条目。
   *  传入已解析的 tree 可避免二次解析（编辑路径上 DocumentStore 已有增量树）。 */
  indexFile(file: string, text: string, preParsedTree?: Tree | null): FileIndex {
    this.removeFile(file);

    const raw: Array<{
      name: string;
      kind: SymbolKind;
      loc: SymbolLocation;
      viaMacro?: string;
    }> = [];
    const includes: string[] = [];
    let errorCount = 0;

    if (HLSL_EXT.test(path.extname(file))) {
      const tree = preParsedTree ?? parseHlslFile(text);
      errorCount = countErrorNodes(tree.rootNode);
      const r = extractHlsl(tree.rootNode, text, file);
      raw.push(...r.symbols);
      includes.push(...r.includes);
    } else {
      const tree = preParsedTree ?? parseShaderLab(text);
      errorCount = countErrorNodes(tree.rootNode);
      const lab = extractShaderLab(tree.rootNode, text, file);
      raw.push(...lab.symbols);
      includes.push(...lab.includes);
      const bodies = extractProgramBodies(tree, text);
      const virtualText = buildVirtualHlsl(text, bodies);
      if (virtualText.trim().length > 0) {
        const hTree = parseHlslFile(virtualText);
        const r = extractHlsl(hTree.rootNode, virtualText, file);
        raw.push(...r.symbols);
        includes.push(...r.includes);
      }
    }

    const symbols: SymbolInfo[] = [];
    for (const s of raw) {
      let info = this.byName.get(s.name);
      if (!info) {
        info = { name: s.name, kind: s.kind, locations: [] };
        this.byName.set(s.name, info);
      }
      info.locations.push(s.loc);
      // 同名合并为一条逻辑符号：Properties 与 HLSL 的 `_MainTex` 归并为 property
      if (info.kind !== s.kind && info.kind === 'variable' && s.kind === 'property') {
        info.kind = 'property';
      }
    }

    const seen = new Set<string>();
    for (const s of raw) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      const info = this.byName.get(s.name)!;
      symbols.push(info);
    }

    const fi: FileIndex = { file, symbols, includes, errorCount };
    this.byFile.set(file, fi);
    return fi;
  }

  removeFile(file: string): void {
    const old = this.byFile.get(file);
    if (!old) return;
    for (const info of old.symbols) {
      info.locations = info.locations.filter((l) => l.file !== file);
      if (info.locations.length === 0) this.byName.delete(info.name);
    }
    this.byFile.delete(file);
  }

  getByName(name: string): SymbolInfo | undefined {
    return this.byName.get(name);
  }

  getFileSymbols(file: string): SymbolInfo[] {
    return this.byFile.get(file)?.symbols ?? [];
  }

  getFileIndex(file: string): FileIndex | undefined {
    return this.byFile.get(file);
  }

  includesOf(file: string): string[] {
    return this.byFile.get(file)?.includes ?? [];
  }

  names(): Iterable<string> {
    return this.byName.keys();
  }

  get fileCount(): number {
    return this.byFile.size;
  }

  get symbolCount(): number {
    return this.byName.size;
  }

  /** 当前文件的 include 闭包（解析后的文件集合），供懒索引与 M2 使用 */
  includeClosure(
    file: string,
    resolve: (spec: string, from: string) => string | null,
    limit = 500
  ): string[] {
    const seen = new Set<string>([file]);
    const queue = [file];
    const out: string[] = [];
    while (queue.length && out.length < limit) {
      const cur = queue.shift()!;
      for (const spec of this.includesOf(cur)) {
        const resolved = resolve(spec, cur);
        if (resolved && !seen.has(resolved)) {
          seen.add(resolved);
          out.push(resolved);
          queue.push(resolved);
        }
      }
    }
    return out;
  }
}
