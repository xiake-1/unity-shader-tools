/** occurrence 收集（规格 feature-rename，T-028）：references / rename 的地基。
 *
 * 符号索引只存声明位；引用与改名需要**全部同名 token**。策略（规格「按需重解析」）：
 * 遍历已索引文件名 → 廉价文本 `includes(name)` 预筛 → 命中的文件用 `docTrees`
 * （与 F12/补全同一棵树与缓存，设计原则 2：不引入第二套解析）枚举名字 token。
 * 逻辑符号合并视图：Properties 与 HLSL 同名归并后，文本枚举天然覆盖两层。
 * 注释 / 字符串 / 语义不是名字 token，天然不计数；读不到或解析不了的记 unresolved。
 */
import * as fs from 'fs';
import type { Range } from 'vscode-languageserver';
import type Parser from 'tree-sitter';
import type { DocumentStore } from './documentStore';
import type { SymbolIndex } from './symbolIndex';
import { docTrees } from './definition';

type SyntaxNode = Parser.SyntaxNode;

/** 可作为符号名出现的叶子 token：HLSL 标识符族 + ShaderLab 外壳 word（Properties 名等） */
const NAME_TOKENS = new Set(['identifier', 'type_identifier', 'field_identifier', 'word']);

export interface Occurrence {
  file: string;
  range: Range;
  /** 该处是否同时是索引里的声明位 */
  decl: boolean;
}

export interface OccurrenceResult {
  occurrences: Occurrence[];
  /** 读不到 / 解析不了的文件数（规格：跳过并记日志 `unresolved=N`） */
  unresolved: number;
  /** 文本预筛后实际解析枚举的文件数（诊断与基准用） */
  scanned: number;
}

export interface OccurrenceContext {
  index: SymbolIndex;
  store: DocumentStore;
  log: (msg: string) => void;
}

function rangeOf(n: SyntaxNode): Range {
  return {
    start: { line: n.startPosition.row, character: n.startPosition.column },
    end: { line: n.endPosition.row, character: n.endPosition.column },
  };
}

function sameRange(a: Range, b: Range): boolean {
  return (
    a.start.line === b.start.line &&
    a.start.character === b.start.character &&
    a.end.line === b.end.line &&
    a.end.character === b.end.character
  );
}

function walkNames(root: SyntaxNode, name: string, out: SyntaxNode[]): void {
  const stack: SyntaxNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.childCount === 0) {
      if (NAME_TOKENS.has(n.type) && n.text === name) out.push(n);
      continue;
    }
    for (const c of n.children) stack.push(c);
  }
}

/** 收集 `name` 在全工程（已索引文件 + 打开文档）里的全部名字 token。
 *  大小写敏感：HLSL / ShaderLab 标识符区分大小写（规格约束）。 */
export function collectOccurrences(name: string, ctx: OccurrenceContext): OccurrenceResult {
  const occurrences: Occurrence[] = [];
  let unresolved = 0;
  let scanned = 0;

  const decls = ctx.index.getByName(name)?.locations ?? [];
  const declsByFile = new Map<string, Range[]>();
  for (const d of decls) {
    let arr = declsByFile.get(d.file);
    if (!arr) {
      arr = [];
      declsByFile.set(d.file, arr);
    }
    arr.push({
      start: { line: d.start.row, character: d.start.column },
      end: { line: d.end.row, character: d.end.column },
    });
  }

  for (const file of ctx.index.fileNames()) {
    // 廉价预筛：打开文档用内存文本，磁盘文件读一次
    let text: string | null = null;
    const doc = ctx.store.get(file);
    if (doc) text = doc.text;
    else {
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        unresolved++;
        continue;
      }
    }
    if (!text.includes(name)) continue;

    const trees = docTrees(file, ctx.store);
    if (!trees) {
      unresolved++;
      continue;
    }
    scanned++;

    const nodes: SyntaxNode[] = [];
    if (trees.labTree) walkNames(trees.labTree.rootNode, name, nodes);
    if (trees.hlslTree && trees.labTree) {
      // .shader：虚拟 HLSL 文本保持行列对齐，程序块内的 token 直接可用；
      // 外壳树里程序块是整体节点，不会重复计数。
      walkNames(trees.hlslTree.rootNode, name, nodes);
    } else if (trees.hlslTree) {
      walkNames(trees.hlslTree.rootNode, name, nodes);
    }

    const fileDecls = declsByFile.get(file) ?? [];
    for (const n of nodes) {
      const range = rangeOf(n);
      occurrences.push({
        file,
        range,
        decl: fileDecls.some((r) => sameRange(r, range)),
      });
    }
  }

  if (unresolved > 0) ctx.log(`occurrences: ${name} unresolved=${unresolved}`);
  occurrences.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.range.start.line - b.range.start.line ||
      a.range.start.character - b.range.start.character
  );
  return { occurrences, unresolved, scanned };
}

/** `sampler_<名>` 约定关联（规格：改名时联动收集）。
 *  Unity 约定：纹理 `_MainTex` 的采样器是 `sampler_MainTex`——前导下划线不重复。 */
export function samplerOccurrences(
  propertyName: string,
  ctx: OccurrenceContext
): OccurrenceResult {
  return collectOccurrences(`sampler_${propertyName.replace(/^_+/, '')}`, ctx);
}
