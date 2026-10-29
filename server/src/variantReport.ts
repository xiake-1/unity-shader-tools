/** 变体分析（规格 feature-shader-name-index-and-variant-report 范围 4/5/6，T-070）
 *
 * 纯函数、只读。两条硬口径：
 * 1. **走 CST 不走正则扫原文**：pragma 在 fork 的 HLSL 文法里没有专用节点（`hlsl/grammar.js:1-4`
 *    继承 tree-sitter-cpp），实测落在 `preproc_call` → `preproc_directive`(`#pragma`) +
 *    `preproc_arg`(`multi_compile _ A B`)，组名与关键字从 `preproc_arg` 文本切分（log 2026-10-29 09:10）。
 * 2. **计数口径四条钉死**（规格约束段）：每组 = 关键字数 + 1（含「全 off」组合）；`_` 是「全 off」的
 *    显式写法、不再额外 +1；同组重复关键字去重并记 `dedup=<n>`；内置组（`multi_compile_fwdbase` 等）
 *    不参与相乘，只列名与次数 + `unavailable`。
 *
 * 不解析文件、不读盘、不 parse —— HLSL 树由调用方给（复用索引已有的树，规格约束「不得二次 parse」）。
 */
import type { SyntaxNode } from './parser';
import { walkNodes } from './parser';

export type ExplicitDirective =
  | 'multi_compile'
  | 'multi_compile_local'
  | 'shader_feature'
  | 'shader_feature_local';

const EXPLICIT_DIRECTIVES = new Set<string>([
  'multi_compile',
  'multi_compile_local',
  'shader_feature',
  'shader_feature_local',
]);

/** 「全 off」的显式写法（URP core 实测形态：`multi_compile _ PROCEDURAL_INSTANCING_ON`） */
const OFF_MARKER = '_';

export interface KeywordGroup {
  directive: ExplicitDirective;
  /** 去重后的关键字（不含 `_`） */
  keywords: string[];
  /** 该组是否写了 `_`（全 off 显式写法） */
  offMarker: boolean;
  /** 被去掉的重复关键字个数（日志 `dedup=`） */
  dedup: number;
  /** 组大小 = 关键字数 + 1（含全 off） */
  size: number;
  /** 1 基行号（CST 位置，虚拟 HLSL 文档与原文行列一致） */
  line: number;
}

export interface BuiltinGroup {
  /** `multi_compile_fwdbase` → `fwdbase` */
  name: string;
  count: number;
  firstLine: number;
}

export interface ShaderVariantEntry {
  file: string;
  /** `Shader "A/B"` 的名字；独立 `.hlsl`/`.cginc` 没有外壳 → null */
  shaderName: string | null;
  /** `shader_block` 起始位置（跳转与报告定位用） */
  start: { row: number; column: number } | null;
  passCount: number;
  groups: KeywordGroup[];
  builtin: BuiltinGroup[];
  /** 显式组的笛卡尔积（内置组不参与） */
  combinations: number;
  dedupTotal: number;
  /** pragma 来源：`cst` = 拿到了 HLSL 树；`no-tree` = 调用方没给树（报告须显式说明，不得静默出空表） */
  pragmaSource: 'cst' | 'no-tree';
}

export interface PragmaSite {
  /** 1 基行号 */
  line: number;
  /** 该 `preproc_call` 在文档里的起始字符偏移（用于归属到 shader_block） */
  startIndex: number;
  /** `preproc_arg` 原文（断言 CST 口径用） */
  argText: string;
  parsed:
    | { kind: 'explicit'; directive: ExplicitDirective; rawKeywords: string[] }
    | { kind: 'builtin'; name: string };
}

/** 从 `preproc_arg` 文本切分 pragma（规格范围 5 的唯一入口）。 */
export function parsePragmaArg(argText: string): PragmaSite['parsed'] | null {
  const parts = argText.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const head = parts[0];
  if (EXPLICIT_DIRECTIVES.has(head)) {
    return { kind: 'explicit', directive: head as ExplicitDirective, rawKeywords: parts.slice(1) };
  }
  // 内置组：`multi_compile_<组名>` / `shader_feature_<组名>`（`_local` 已在上面命中显式，不会走到这里）
  const m = /^(multi_compile|shader_feature)_(.+)$/.exec(head);
  if (m) return { kind: 'builtin', name: m[2] };
  return null;
}

/** 关键字列表 → 组（`_` 口径 + 去重 + 大小）。 */
export function buildKeywordGroup(
  directive: ExplicitDirective,
  rawKeywords: string[],
  line: number
): KeywordGroup {
  const offMarker = rawKeywords.includes(OFF_MARKER);
  const seen = new Set<string>();
  const keywords: string[] = [];
  let dedup = 0;
  for (const k of rawKeywords) {
    if (k === OFF_MARKER) continue; // 不重复 +1：全 off 已由 size 的 +1 表达
    if (seen.has(k)) {
      dedup++;
      continue;
    }
    seen.add(k);
    keywords.push(k);
  }
  return { directive, keywords, offMarker, dedup, size: keywords.length + 1, line };
}

/** 从 HLSL 树收集 pragma（只认 `#pragma`，其余 `preproc_call` 忽略）。 */
export function collectPragmas(hlslRoot: SyntaxNode): PragmaSite[] {
  const out: PragmaSite[] = [];
  walkNodes(hlslRoot, (n) => {
    if (n.type !== 'preproc_call') return;
    let dir: SyntaxNode | null = null;
    let arg: SyntaxNode | null = null;
    for (const c of n.children) {
      if (c.type === 'preproc_directive') dir = c;
      else if (c.type === 'preproc_arg') arg = c;
    }
    if (!dir || !arg || dir.text !== '#pragma') return;
    const parsed = parsePragmaArg(arg.text);
    if (!parsed) return;
    out.push({ line: n.startPosition.row + 1, startIndex: n.startIndex, argText: arg.text, parsed });
  });
  return out;
}

interface ShaderBlockSpan {
  name: string | null;
  start: { row: number; column: number };
  startIndex: number;
  endIndex: number;
  passCount: number;
}

/** ShaderLab 树里的 `shader_block`（名字取 `string` 子节点原文，**保留空格与 `/`**）。 */
function collectShaderBlocks(labRoot: SyntaxNode): ShaderBlockSpan[] {
  const out: ShaderBlockSpan[] = [];
  const visit = (n: SyntaxNode): void => {
    if (n.type === 'shader_block') {
      let name: string | null = null;
      let passCount = 0;
      const countPasses = (m: SyntaxNode): void => {
        if (m.type === 'pass_block') passCount++;
        for (const c of m.children) countPasses(c);
      };
      for (const c of n.children) {
        if (c.type === 'string') name = c.text.replace(/^"|"$/g, '');
      }
      countPasses(n);
      out.push({
        name,
        start: { row: n.startPosition.row, column: n.startPosition.column },
        startIndex: n.startIndex,
        endIndex: n.endIndex,
        passCount,
      });
      return; // 嵌套 shader_block 不存在，不再下钻
    }
    for (const c of n.children) visit(c);
  };
  visit(labRoot);
  return out;
}

function emptyEntry(file: string, shaderName: string | null, start: ShaderBlockSpan['start'] | null): ShaderVariantEntry {
  return {
    file,
    shaderName,
    start,
    passCount: 0,
    groups: [],
    builtin: [],
    combinations: 1,
    dedupTotal: 0,
    pragmaSource: 'cst',
  };
}

function addBuiltin(entry: ShaderVariantEntry, name: string, line: number): void {
  const hit = entry.builtin.find((b) => b.name === name);
  if (hit) hit.count++;
  else entry.builtin.push({ name, count: 1, firstLine: line });
}

function finalize(entry: ShaderVariantEntry): void {
  // 笛卡尔积：只乘显式组（内置组不参与，规格范围 6）
  let combos = 1;
  let dedup = 0;
  for (const g of entry.groups) {
    combos *= g.size;
    dedup += g.dedup;
  }
  entry.combinations = entry.groups.length ? combos : 0;
  entry.dedupTotal = dedup;
}

/**
 * 分析一个文档的变体规模。
 *
 * @param labRoot  ShaderLab 树（`.shader`）或 HLSL 树（独立 `.hlsl`/`.cginc`，此时无 shader_block）
 * @param file     文件路径（只用于报告标注，不读盘）
 * @param hlslRoot pragma 来源的 HLSL 树；**必须由调用方复用已有树**，缺树时不静默出空表
 *                 → `pragmaSource='no-tree'`，报告里写 `pragma=unavailable`
 */
export function analyzeVariants(
  labRoot: SyntaxNode,
  file: string,
  hlslRoot?: SyntaxNode | null
): ShaderVariantEntry[] {
  const blocks = collectShaderBlocks(labRoot);
  const pragmas = hlslRoot ? collectPragmas(hlslRoot) : [];

  if (blocks.length === 0) {
    // 独立 HLSL/CG 源：没有 shader_block，整文件算一条（工程汇总里按文件列）
    const entry = emptyEntry(file, null, null);
    entry.pragmaSource = hlslRoot ? 'cst' : 'no-tree';
    for (const p of pragmas) {
      if (p.parsed.kind === 'explicit') {
        entry.groups.push(buildKeywordGroup(p.parsed.directive, p.parsed.rawKeywords, p.line));
      } else {
        addBuiltin(entry, p.parsed.name, p.line);
      }
    }
    finalize(entry);
    return [entry];
  }

  const entries = blocks.map((b) => {
    const entry = emptyEntry(file, b.name, b.start);
    entry.passCount = b.passCount;
    entry.pragmaSource = hlslRoot ? 'cst' : 'no-tree';
    for (const p of pragmas) {
      if (p.startIndex < b.startIndex || p.startIndex >= b.endIndex) continue;
      if (p.parsed.kind === 'explicit') {
        entry.groups.push(buildKeywordGroup(p.parsed.directive, p.parsed.rawKeywords, p.line));
      } else {
        addBuiltin(entry, p.parsed.name, p.line);
      }
    }
    finalize(entry);
    return entry;
  });
  return entries;
}

/** 一行摘要（Output 通道与门槛脚本共用口径）。
 *  `builtin-groups=<n>` 与 `unavailable` 同时出现：内置组的关键字空间无可读来源（ADR 0003）。 */
export function variantSummaryLine(e: ShaderVariantEntry): string {
  const parts = [
    `[variants] ${e.file}`,
    `shader=${e.shaderName === null ? '<no-shader-block>' : `"${e.shaderName}"`}`,
    `passes=${e.passCount}`,
    `groups=${e.groups.length}`,
    `combinations=${e.combinations}`,
  ];
  if (e.dedupTotal) parts.push(`dedup=${e.dedupTotal}`);
  if (e.builtin.length) {
    parts.push(`builtin-groups=${e.builtin.length}`);
    parts.push(`builtin-occurrences=${e.builtin.reduce((n, b) => n + b.count, 0)}`);
    parts.push('unavailable');
  }
  if (e.pragmaSource === 'no-tree') parts.push('pragma=unavailable');
  return parts.join(' ');
}

/** 明细行：逐组列出关键字与大小，内置组只列名。 */
export function variantDetailLines(e: ShaderVariantEntry): string[] {
  const lines: string[] = [];
  for (const g of e.groups) {
    const flag = g.offMarker ? ' (含全 off)' : '';
    lines.push(`  L${g.line} ${g.directive}: ${g.keywords.join(' ') || '<无关键字>'} → ${g.size}${flag}`);
  }
  for (const b of e.builtin) {
    lines.push(`  L${b.firstLine} 内置组 ${b.name} ×${b.count} → 不参与计数（关键字空间 unavailable）`);
  }
  return lines;
}
