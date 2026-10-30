/**
 * T-059 / T-061 / T-062 / T-080 / T-081 / T-082 格式化编排：
 * ShaderLab 外壳打印器 + program 区域（HLSL / CG / GLSL）判定 + 原样输出区 + 失败即不改。
 *
 * 硬断言在这里**每次都复验**，任一不满足整次返回 `null`（范围 12）：
 * ① 幂等（对输出再排一次字节相同）；② token 序列不变（同一 grammar 重新解析后的叶子 token
 * 的 type 与 text 逐项相同）—— 扩范围后的**主判据**；
 * ③ 仅空白变化（**新口径**）：`intraLineSpacing` / `braceSplitting` / `braceOnNewLine` 任一开时
 *    行数与行内容允许变化，由 ② + 输出形状自检（`outputShapeViolations`）兜底；
 *    三个开关全关时仍走旧的「逐行 strip 后逐行相同」口径。
 */
import * as fs from 'fs';
import { parseShaderLab, parseHlslFile, type Tree, type SyntaxNode } from './parser';
import { isGeneratedFile } from './tempFiles';
import { buildLineModel, printHlslRegion, emitFormattedLine } from './hlslPrinter';
import { DEFAULT_FORMAT_SWITCHES, type FormatSwitches, type IndentOptions } from './formatSettings';
import { ExemptionTable, contextOf } from './errorExemption';

/** 默认大文件上限（范围 13） */
export const DEFAULT_MAX_FORMAT_FILE_SIZE = 1024 * 1024;

export interface FormatRequest {
  file: string;
  text: string;
  indent: IndentOptions;
  switches?: FormatSwitches;
  maxBytes?: number;
  /** 复用调用方已解析的树（`DocumentStore` 里有就别再解析一次，ADR 0001 唯一 CST） */
  trees?: { shaderlab?: Tree; hlsl?: Tree };
  /** 幂等复验用的豁免表（每次新建，命中计数不外泄） */
  exemptions?: ExemptionTable;
}

export interface FormatOutcome {
  /** `null` = 不改文档（范围 12 + 异常表） */
  text: string | null;
  /** 为什么没改 / 为什么失败（写进日志 `format-error=` 或 `format=`） */
  reason: string | null;
  verbatimBytes: number;
  changedBytes: number;
  /** 原样区行数（健康行与门槛用） */
  verbatimLines: number;
  /** CG/GLSL 区域与 `.cginc` 实际排版字节（范围 14 健康行 `cg=`） */
  cgBytes: number;
}

const HLSL_EXT = /\.(hlsl|hlslinc)$/i;
const CGINC_EXT = /\.cginc$/i;
const HLSL_DIALECT_EXT = /\.(hlsl|hlslinc|cginc)$/i;

export function isHlslSource(fsPath: string): boolean {
  return HLSL_EXT.test(fsPath);
}

/** 用 HLSL 树排的文件：`.cginc` 走**同一棵树**（范围 2 —— 方言差异只体现在覆盖率，不新增解析路径） */
export function isHlslDialectSource(fsPath: string): boolean {
  return HLSL_DIALECT_EXT.test(fsPath);
}

/** CG 方言（统计与健康行 `cg=` 用；不再用于跳过） */
export function isCgDialectSource(fsPath: string): boolean {
  return CGINC_EXT.test(fsPath);
}

/** 该文档是否该排（生成文件 / 非 shader 一律不排；`.cginc` 自 2026-10-29 起排） */
export function formatSkipReason(file: string, text: string, maxBytes = DEFAULT_MAX_FORMAT_FILE_SIZE): string | null {
  if (isGeneratedFile(file)) return 'generated'; // core §7：生成文件不改
  if (!/\.(shader|hlsl|hlslinc|cginc)$/i.test(file)) return 'not-shader';
  if (Buffer.byteLength(text, 'utf8') > maxBytes) return 'too-large'; // 范围 13
  return null;
}

interface Region {
  startRow: number;
  endRow: number;
  /** `hlsl`/`cg` = 用 HLSL 树排；`verbatim` = 整块原样（关键字与正文同行的畸形块） */
  kind: 'hlsl' | 'cg' | 'verbatim';
  baseDepth: number;
}

/**
 * 找出 `.shader` 里的 program 区间（范围 2 / 5：HLSL 与 CG/GLSL 都排，畸形块原样）。
 *
 * **实测**：`program_hlsl` 只有 `kw_hlslprogram` 与 `kw_endhlsl` 两个孩子 ——
 * scanner 吞掉的 HLSL 正文在 ShaderLab 树里**不是节点**（连隐藏叶子都没有）。
 * 所以区间只能按两个关键字所在的行界定；正文里没有任何 token 可依赖。
 */
const PROGRAM_NODE_TYPES = [
  'program_hlsl',
  'program_hlsl_include',
  'program_cg',
  'program_cg_include',
  'program_glsl',
];

function collectProgramRegions(tree: Tree, src: string[], shellDepthAt: (row: number) => number): Region[] {
  const regions: Region[] = [];
  // 原生 `descendantsOfType` 而不是 JS 遍历：2001 行文档上整树回调一遍要 ~15ms，
  // 而这里只关心 5 种 program 节点（grammar 里就这五个名字）
  for (const n of tree.rootNode.descendantsOfType(PROGRAM_NODE_TYPES)) {
    if (!n.type.startsWith('program_')) continue;
    const open = n.children.find((c) => /^(kw_hlslprogram|kw_cgprogram|kw_glslprogram)$/.test(c.type));
    const close = n.children.find((c) => /^(kw_endhlsl|kw_endcg|kw_endglsl)$/.test(c.type));
    if (!open || !close) continue;
    const openRow = open.endPosition.row;
    const closeRow = close.startPosition.row;
    // 关键字与正文同行（`HLSLPROGRAM float4 f(){}`）→ 整块原样，不冒险
    const openTail = (src[openRow] ?? '').slice(open.endPosition.column);
    const closeHead = (src[closeRow] ?? '').slice(0, close.startPosition.column);
    const messy = openTail.trim() !== '' || closeHead.trim() !== '';
    const startRow = openTail.trim() === '' ? openRow + 1 : openRow;
    const endRow = closeHead.trim() === '' ? closeRow - 1 : closeRow;
    if (endRow < startRow) continue;
    const kind: Region['kind'] = messy ? 'verbatim' : n.type.includes('hlsl') ? 'hlsl' : 'cg';
    regions.push({
      startRow,
      endRow,
      kind,
      // program 内容比关键字那一行深一级
      baseDepth: kind === 'verbatim' ? 0 : shellDepthAt(openRow) + 1,
    });
  }
  return regions;
}

/** 硬断言 ② 的口径：叶子 token 的 `type` 与文本逐项相同（不拼字符串，20k token 时省掉一批分配） */
function sameLeafSeq(a: SyntaxNode[], b: SyntaxNode[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].type !== b[i].type) return false;
    if (a[i].text !== b[i].text) return false;
  }
  return true;
}

/** 硬断言 ③ 的旧口径（三个改行形的开关全关时才用）：逐行 strip 空白后逐行相同 */
function sameLineContent(a: string, b: string): boolean {
  const norm = (s: string): string[] =>
    s
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
  const x = norm(a);
  const y = norm(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

function parseFor(file: string, text: string, trees?: FormatRequest['trees']): { tree: Tree; kind: 'hlsl' | 'shaderlab' } {
  if (isHlslDialectSource(file)) {
    return { tree: trees?.hlsl ?? parseHlslFile(text), kind: 'hlsl' };
  }
  return { tree: trees?.shaderlab ?? parseShaderLab(text), kind: 'shaderlab' };
}

/**
 * 测试注入点（与 `UNITYSHADER_KEYWORD_LOG` 同一先例：测试注入走环境变量，不进 contributes）。
 * `UNITYSHADER_FORMAT_FAIL_FILE` 指向一个**标志文件**：文件存在时打印器抛错。
 * 用文件而不是布尔量，是为了让集成用例能在同一进程里开关它，不影响其它用例。
 */
function shouldInjectFailure(): boolean {
  const f = process.env.UNITYSHADER_FORMAT_FAIL_FILE;
  return !!f && fs.existsSync(f);
}

interface PrintResult {
  text: string;
  verbatimLines: number;
  verbatimBytes: number;
  cgBytes: number;
  /** 输出形状自检的违规原因（范围 10 的 ③ 新口径在打印器内的落地）；`null` = 通过 */
  shape: string | null;
  tree: Tree;
  leaves: SyntaxNode[];
}

/** 排一次（不含复验）；`null` = 结构不足以排版。返回用的树，复验不再重新解析 */
function printOnce(req: FormatRequest): PrintResult | null {
  if (shouldInjectFailure()) throw new Error('injected printer failure');
  const { file, text } = req;
  const switches = req.switches ?? DEFAULT_FORMAT_SWITCHES;
  const parsed = parseFor(file, text, req.trees);
  const src = text.split('\n');

  // 异常表：整文件几乎全是 ERROR（root 无有效结构）→ 不改
  if (parsed.kind === 'shaderlab' && !parsed.tree.rootNode.children.some((c) => c.type === 'shader_block')) {
    return null;
  }
  if (parsed.tree.rootNode.children.length === 0) return null;

  const shellLeaves: SyntaxNode[] = [];
  /** 形状自检（范围 10）：打印器自己排出来的行里，token 之间的 gap 若还有 2+ 空白 → 整次不改 */
  const shapeIssues: string[] = [];
  const shellModel = buildLineModel(
    text,
    parsed.tree,
    {
      macroMatchIndent: switches.macroMatchIndent,
      intraLineSpacing: switches.intraLineSpacing,
      braceSplitting: switches.braceSplitting,
    },
    shellLeaves,
    shapeIssues
  );

  // ADR 0007 不可修模式：复用 `errorExemption` 的匹配结果标原样（范围 5）
  const exemptions = req.exemptions ?? new ExemptionTable();
  // 只取 ERROR 节点（原生查询）：MISSING 行的原样已由 `buildLineModel` 覆盖，
  // ADR 0007 的不可修模式针对的是 ERROR 恢复区
  for (const n of parsed.tree.rootNode.descendantsOfType('ERROR')) {
    if (exemptions.matches(contextOf(n, file))) {
      for (let r = n.startPosition.row; r <= n.endPosition.row && r < shellModel.length; r++) shellModel[r].verbatim = true;
    }
  }

  const regions = parsed.kind === 'shaderlab' ? collectProgramRegions(parsed.tree, src, (row) => shellModel[row]?.depth ?? 0) : [];
  // 畸形块（关键字与正文同行）：整块原样（范围 5）
  for (const r of regions) {
    if (r.kind !== 'verbatim') continue;
    for (let row = r.startRow; row <= r.endRow && row < shellModel.length; row++) shellModel[row].verbatim = true;
  }
  const regionByStart = new Map<number, { region: Region; lines: string[]; formatted: number[] }>();
  for (const r of regions) {
    if (r.kind === 'verbatim') continue;
    const regionText = src.slice(r.startRow, r.endRow + 1).join('\n');
    const hlslTree = parseHlslFile(regionText);
    regionByStart.set(
      r.startRow,
      { region: r, ...printHlslRegion(regionText, hlslTree, switches, req.indent, r.baseDepth, shapeIssues) }
    );
  }

  const out: string[] = [];
  let verbatimLines = 0;
  let verbatimBytes = 0;
  let cgBytes = 0;
  let blanks = 0;
  for (let i = 0; i < src.length; i++) {
    const region = regionByStart.get(i);
    if (region) {
      out.push(...region.lines);
      if (region.region.kind === 'cg') cgBytes += Buffer.byteLength(region.lines.join('\n'), 'utf8');
      // 区间内已排，跳到区间末
      i = region.region.endRow;
      blanks = 0;
      continue;
    }
    const raw = src[i];
    const m0 = shellModel[i];
    if (raw.trim() === '') {
      // **原样区（含 ERROR 区间）内的空行不折叠**：折叠会移动行号，而 grammar 的错误恢复边界
      // 按行号划定 —— 第二遍就会把原样区套到别的内容上，幂等直接破（实测 22 个语料文件因此自检失败）
      if (m0.verbatim) {
        out.push(raw);
        continue;
      }
      blanks++;
      if (blanks <= switches.keepBlankLines) out.push(/\r$/.test(raw) ? '\r' : '');
      continue;
    }
    blanks = 0;
    const m = m0;
    if (m.verbatim) {
      out.push(raw);
      verbatimLines++;
      verbatimBytes += Buffer.byteLength(raw, 'utf8');
      continue;
    }
    emitFormattedLine(raw, m, switches, req.indent, out, parsed.kind === 'hlsl');
  }

  // 独立 `.cginc` 全文都是 CG 方言
  if (parsed.kind === 'hlsl' && isCgDialectSource(file)) cgBytes = Buffer.byteLength(out.join('\n'), 'utf8');

  return {
    text: out.join('\n'),
    verbatimLines,
    verbatimBytes,
    cgBytes,
    shape: shapeIssues[0] ?? null,
    tree: parsed.tree,
    leaves: shellLeaves,
  };
}

/** 格式化一个文档（范围 1：整篇一次；失败即不改，范围 12） */
export function formatDocument(req: FormatRequest): FormatOutcome {
  const skip = formatSkipReason(req.file, req.text, req.maxBytes);
  const zero = { verbatimBytes: 0, changedBytes: 0, verbatimLines: 0, cgBytes: 0 };
  if (skip) return { text: null, reason: skip, ...zero };

  let first: PrintResult | null;
  try {
    first = printOnce(req);
  } catch (err) {
    return { text: null, reason: `error:${(err as Error).message}`, ...zero };
  }
  if (!first) return { text: null, reason: 'no-structure', ...zero };
  if (first.shape) {
    return { text: null, reason: `output-shape:${first.shape}`, verbatimBytes: first.verbatimBytes, changedBytes: 0, verbatimLines: first.verbatimLines, cgBytes: first.cgBytes };
  }

  const switches = req.switches ?? DEFAULT_FORMAT_SWITCHES;
  const outText = first.text;

  // ① 幂等：第二遍自己解析输出文本（顺带得到输出的叶子）。
  // **必须丢掉 `req.trees`**：调用方缓存的树属于输入文本，拿它去排输出文本会让
  // 行模型按错位的坐标切 token（2026-10-30 由输出形状自检抓到：`SubShader { Pass { } }`
  // 被切成 `SubSh d r` 这类乱码行）。
  let second: PrintResult | null;
  try {
    second = printOnce({ ...req, text: outText, trees: undefined });
  } catch (err) {
    return { text: null, reason: `error:idempotence:${(err as Error).message}`, verbatimBytes: first.verbatimBytes, changedBytes: 0, verbatimLines: first.verbatimLines, cgBytes: first.cgBytes };
  }
  if (!second) {
    return { text: null, reason: 'not-idempotent', verbatimBytes: first.verbatimBytes, changedBytes: 0, verbatimLines: first.verbatimLines, cgBytes: first.cgBytes };
  }
  if (second.shape) {
    return { text: null, reason: `output-shape:idempotence:${second.shape}`, verbatimBytes: first.verbatimBytes, changedBytes: 0, verbatimLines: first.verbatimLines, cgBytes: first.cgBytes };
  }
  // ② token 序列不变：复用两遍各自收集到的叶子，不再第三次走树
  // （实测 2001 行文档上「4 次解析 + 3 次走树」把格式化推到 319ms，压到 150ms 以内靠的就是这些复用）
  if (!sameLeafSeq(first.leaves, second.leaves)) {
    return { text: null, reason: 'token-sequence-changed', verbatimBytes: first.verbatimBytes, changedBytes: 0, verbatimLines: first.verbatimLines, cgBytes: first.cgBytes };
  }
  if (second.text !== outText) {
    return { text: null, reason: 'not-idempotent', verbatimBytes: first.verbatimBytes, changedBytes: 0, verbatimLines: first.verbatimLines, cgBytes: first.cgBytes };
  }
  // ③ 仅空白变化：三个会改行形的开关全关时才用旧口径；否则由 ② + 输出形状自检兜底
  const shapeChanging = switches.braceOnNewLine || switches.intraLineSpacing || switches.braceSplitting;
  if (!shapeChanging && !sameLineContent(req.text, outText)) {
    return { text: null, reason: 'line-content-changed', verbatimBytes: first.verbatimBytes, changedBytes: 0, verbatimLines: first.verbatimLines, cgBytes: first.cgBytes };
  }

  const beforeLines = req.text.split('\n');
  const afterLines = outText.split('\n');
  let changedBytes = 0;
  for (let i = 0; i < Math.max(beforeLines.length, afterLines.length); i++) {
    if (beforeLines[i] === afterLines[i]) continue;
    changedBytes += Math.abs(Buffer.byteLength(beforeLines[i] ?? '', 'utf8') - Buffer.byteLength(afterLines[i] ?? '', 'utf8')) + 1;
  }
  return { text: outText, reason: null, verbatimBytes: first.verbatimBytes, changedBytes, verbatimLines: first.verbatimLines, cgBytes: first.cgBytes };
}

/**
 * **只给测试与门槛用**：跑第一遍排版、不做三条复验。
 * 门槛用它区分「打印器主动拒绝」（`no-structure` 等）与「打印器排错了」——
 * 后者必须 FAIL，不能被「失败即不改」掩盖成「没改所以没错」。
 */
export function formatProbe(req: FormatRequest): string | null {
  const first = printOnce(req);
  return first ? first.text : null;
}

/** 健康行（范围 14）：每次请求一行 */
export function formatHealthLine(file: string, o: FormatOutcome): string {
  const state = o.text === null ? `skip=${o.reason}` : 'ok';
  return `[format] file=${file} state=${state} verbatim=${o.verbatimBytes} changed=${o.changedBytes} cg=${o.cgBytes}`;
}
