/**
 * T-060 / T-080 / T-081 / T-082 打印器（规格 feature-formatting 范围 6/7/8；ADR 0011「全自写 CST 打印器」）。
 *
 * 口径（为什么是「逐行重缩进 + 只在 token 边界改空白」而不是 token 流重建）：
 * 硬断言 ② 要求叶子 token 的 type 与 text 逐项相同，所以任何空白增删都必须落在
 * **相邻 token 之间**；行尾空白（注释 token 含行尾空格、CRLF 的 `\r`）与 token 内部字节一律不碰。
 * 2026-10-29 扩范围后允许两类**跨行**变化：`braceOnNewLine` 拆左括号、`braceSplitting` 拆行尾 `}`；
 * 两者都只在**非原样行**发生，且第二遍复验按输出重新解析（幂等靠这个）。
 * 跨行 token（块注释、带 `\` 续行的宏）覆盖的行**原样输出**：改它们等于改 token 自身 → 违反 ②。
 */
import { walk, type Tree, type SyntaxNode } from './parser';
import type { FormatSwitches, IndentOptions } from './formatSettings';
import { indentPrefix } from './formatSettings';

export interface LineModel {
  /** 目标缩进深度（绝对值，已含 baseDepth） */
  depth: number;
  /** 该行必须字节级原样输出（范围 5） */
  verbatim: boolean;
  /** 续行对齐：深度 + 行内相对偏移（`macroMatchIndent`）；`alignDepth < 0` = 不按列对齐 */
  alignDepth: number;
  alignExtra: number;
  /** `intraLineSpacing` 归一化后的行体（从第一个非空白字符到行尾，含行尾 trivia）；`undefined` = 用原文 tail */
  body?: string;
  /** 行尾 `}` 拆到下一行时该 `}` 的缩进深度；`-1` = 不拆（范围 8） */
  tailBraceDepth: number;
}

export interface LineModelOptions {
  baseDepth?: number;
  macroMatchIndent?: boolean;
  /** 范围 7：token 边界空白归一化（需要按行收集 token 区间） */
  intraLineSpacing?: boolean;
  /** 范围 8：行尾 `}` 拆行（需要判定「该行最后一个 token 是不是 `}`」） */
  braceSplitting?: boolean;
}

/**
 * 用 CST 的 token 序列算逐行模型。`tree` 必须是**同一份 text** 的树（调用方保证）。
 * 只读 CST，不重新解析（设计原则 2 / ADR 0001）。
 */
export function buildLineModel(
  text: string,
  tree: Tree,
  opts: LineModelOptions = {},
  /** 顺带交出收集到的叶子：复验（硬断言 ②）不再重新走一遍树，2001 行文档省 ~13ms */
  leavesOut?: SyntaxNode[],
  /** 顺带交出形状自检的问题（范围 10 的 ③ 新口径落地）；只收前几条，够定位就行 */
  issuesOut?: string[]
): LineModel[] {
  const lines = text.split('\n');
  const base = opts.baseDepth ?? 0;
  const model: LineModel[] = lines.map(() => ({
    depth: base,
    verbatim: false,
    alignDepth: -1,
    alignExtra: 0,
    tailBraceDepth: -1,
  }));

  // **游标只物化叶子**：`cur.currentNode` 每次访问都新建一个 SyntaxNode 代理对象，
  // 内部节点（region 树上 15283 节点 vs 10614 叶子）不需要它。
  // `ERROR` 是复合节点 → 用原生 `descendantsOfType('ERROR')` 单独取（实测 0.6ms，比逐节点判便宜）；
  // `MISSING` 一定是零宽叶子 → 在叶子层判。
  // 口径与 `parser.isErrorNode` 的 T-034 实测修正一致：`type.startsWith('MISSING')` 永不成立，必须用 `isMissing`。
  const leaves: SyntaxNode[] = [];
  const cur = tree.rootNode.walk();
  outer: for (;;) {
    if (cur.gotoFirstChild()) continue outer;
    leaves.push(cur.currentNode);
    for (;;) {
      if (cur.gotoNextSibling()) continue outer;
      if (!cur.gotoParent()) break outer;
    }
  }
  if (leavesOut) for (const l of leaves) leavesOut.push(l);

  // 行起始索引表：把 `startPosition`/`endPosition`（每次跨 WASM 边界新建 Point 对象）
  // 换成 `startIndex`/`endIndex`（纯 int）+ 本地行表。1.4 万叶子 × 2 = 2.8 万次对象分配，
  // 是 T-085 里 ShaderLab 档超预算的另一半。顺带把列口径统一成 JS 字符串下标（切片用的就是它）。
  const lineStarts: number[] = new Array(lines.length + 1);
  {
    let acc = 0;
    for (let r = 0; r < lines.length; r++) {
      lineStarts[r] = acc;
      acc += lines[r].length + 1;
    }
    lineStarts[lines.length] = acc;
  }
  let rowHint = 0;
  const rowOf = (index: number): number => {
    let r = rowHint;
    if (r >= lineStarts.length) r = lineStarts.length - 1;
    if (index >= lineStarts[r]) {
      // 叶子按文档序 → 从上次位置线性推进，绝大多数一步命中
      while (r + 1 < lineStarts.length && index >= lineStarts[r + 1]) r++;
      rowHint = r;
      return r;
    }
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  // **一次性把叶子的坐标/类型/isMissing 读进 typed array**：后面两个循环（token 区间、深度）
  // 都不再碰树。
  const nLeaves = leaves.length;
  const lRow = new Int32Array(nLeaves);
  const lCol = new Int32Array(nLeaves);
  const lEndRow = new Int32Array(nLeaves);
  const lEndCol = new Int32Array(nLeaves);
  const lTy: string[] = new Array(nLeaves);
  for (let i = 0; i < nLeaves; i++) {
    const t = leaves[i];
    const s = t.startIndex;
    const e = t.endIndex;
    const sr = rowOf(s);
    const er = rowOf(e);
    lRow[i] = sr;
    lCol[i] = s - lineStarts[sr];
    lEndRow[i] = er;
    lEndCol[i] = e - lineStarts[er];
    lTy[i] = t.type;
    if (t.isMissing) {
      for (let r = sr; r <= er && r < model.length; r++) model[r].verbatim = true;
    }
  }
  for (const en of tree.rootNode.descendantsOfType('ERROR')) {
    const sr = rowOf(en.startIndex);
    const er = rowOf(en.endIndex);
    for (let r = sr; r <= er && r < model.length; r++) model[r].verbatim = true;
  }

  // 范围 7：按行收集 token 区间（`[start, end]` 扁平对），再归一化 token 之间的空白。
  // 只有 `intraLineSpacing` 开时才收集 —— 关掉时连分配都不发生（开关关 = 行为与扩范围前逐字节一致）。
  // `leafNormCol[i]` = 叶子 i 在**归一化后行体**里的起始列；`macroMatchIndent` 的续行对齐列
  // 必须按归一化后的坐标算，否则第一遍把 `f (x)` 的空格删掉后，续行对齐基准会漂 1 列 → 幂等破。
  const leafNormCol: number[] | undefined = opts.intraLineSpacing ? new Array(nLeaves).fill(-1) : undefined;
  if (leafNormCol) {
    // 叶子按文档序收集 → **按行增量处理并复用同一个 scratch 数组**
    // （按行建 `spansByRow`/`leafIdxByRow` = 2001 行文档上 4002 次分配，实测贵）。
    const spans: number[] = [];
    const idx: number[] = [];
    let curRow = -1;
    const flush = (row: number): void => {
      if (spans.length === 0 || row < 0) {
        spans.length = 0;
        idx.length = 0;
        return;
      }
      const raw = lines[row];
      // 绝大多数行本来就没有要归一的空白 → 整行跳过（不建 body、不回填列）
      if (lineNeedsSpacing(raw, spans)) {
        const norm = normalizeBody(raw, spans);
        model[row].body = norm.body;
        if (norm.gapIssue && issuesOut && issuesOut.length < 5) {
          issuesOut.push(`intra-line-gap:行${row + 1} ${JSON.stringify(norm.gapIssue)}`);
        }
        for (let k = 0; k < norm.cols.length && k < idx.length; k++) leafNormCol[idx[k]] = norm.cols[k];
      }
      spans.length = 0;
      idx.length = 0;
    };
    for (let i = 0; i < nLeaves; i++) {
      const row = lRow[i];
      if (row >= lines.length) continue;
      if (row !== curRow) {
        flush(curRow);
        curRow = row;
      }
      // 跨行 token 只登记到该行行尾；其内部行已被上面标成原样，不会被碰
      const end = lEndRow[i] === row ? Math.min(lEndCol[i], lines[row].length) : lines[row].length;
      spans.push(lCol[i], end);
      idx.push(i);
    }
    flush(curRow);
  }

  const leadOf = (row: number): number => {
    const l = lines[row] ?? '';
    return l.length - l.trimStart().length;
  };

  let open = 0; // 未闭合 `{` 数
  /**
   * 未闭合 `(`/`[`：存**深度 + 行内相对偏移**而不是绝对列。
   * 实测教训：按绝对列对齐时，第一遍把含左括号的行缩进后，第二遍的基准列就漂了
   * （语料 22 个文件因此 `not-idempotent`）。「深度 + 行内偏移」两遍都稳定。
   */
  const parens: { depth: number; extra: number }[] = [];
  const assigned: boolean[] = new Array(lines.length).fill(false);
  const hasBraceOpen: boolean[] = new Array(lines.length).fill(false);
  let prevEndRow = -1;
  let prevTy = '';
  for (let i = 0; i < nLeaves; i++) {
    // 坐标与类型全部来自上面的 typed array：这里**不再碰树**（跨 WASM 边界的代价见上）
    const ty = lTy[i];
    const sRow = lRow[i];
    const eRow = lEndRow[i];

    if (ty === '}' || ty === ')') {
      if (ty === '}') open = Math.max(0, open - 1);
      else parens.pop();
    }

    // 范围 8：行尾 `}` 候选。`}` 之后同还有 token 起始于该行 → 不是行尾（`};`、`} else {`）→ 清掉；
    // `}}` 连排不拆（拆一次后 head 仍以 `}` 收尾 → 第二遍再拆 → 幂等破）。
    if (opts.braceSplitting) {
      if (ty !== '}' && sRow < model.length) model[sRow].tailBraceDepth = -1;
      if (ty === '}' && eRow < model.length) {
        const gluedPrevBrace = prevTy === '}' && prevEndRow === eRow;
        model[eRow].tailBraceDepth = gluedPrevBrace || hasBraceOpen[eRow] ? -1 : base + open;
      }
    }

    if (sRow < model.length && !assigned[sRow]) {
      // 该行第一个 token 决定整行深度
      model[sRow].depth = base + open;
      assigned[sRow] = true;
      // 续行（上一行的最后一个 token 落在上一行）且有未闭合左括号 → 对齐到左括号
      const isContinuation = prevEndRow === sRow - 1 && parens.length > 0;
      if (isContinuation && opts.macroMatchIndent) {
        const p = parens[parens.length - 1];
        model[sRow].alignDepth = p.depth;
        model[sRow].alignExtra = p.extra;
      }
    }

    if (ty === '{') {
      open++;
      if (sRow < model.length) hasBraceOpen[sRow] = true;
    }
    if (ty === '(' || ty === '[') {
      // 归一化开时按**归一化后**的列算对齐基准（见上）
      const normCol = leafNormCol ? leafNormCol[i] : -1;
      const extra = normCol >= 0 ? normCol + 1 : lCol[i] - leadOf(sRow) + 1;
      parens.push({ depth: base + open, extra });
    }

    // 跨行 token：内部行原样（改它们 = 改 token 自身 → 违反 ②）
    if (eRow > sRow) {
      for (let r = sRow + 1; r <= eRow && r < model.length; r++) model[r].verbatim = true;
    }
    prevEndRow = eRow;
    prevTy = ty;
  }
  return model;
}

/**
 * 范围 7 的四类归一化，**只在相邻 token 之间的 trivia 上操作**：
 * ① 连续空白 → 一个空格；② **调用**左括号 `(` 前的空白 → 删除（前一个 token 是标识符/`)`/`]`，
 * 不含 `if`/`for`/`while`/`return` 这类关键字 —— 规格说的是调用括号，控制流的 `if (x)` 不动）；
 * ③ `.` 与其后继 token 之间的空白 → 删除；④ `,` 后无空白 → 补一个空格。
 * 不动：行首空白（由缩进模型负责）、最后一个 token 之后的全部字节（行尾空白、注释 token 内的
 * 行尾空格、CRLF 的 `\r` 都属于 token 自身或必须保留的 trivia）、`.` **前**的空白与 `{` **前**的空白
 * （都不在四类内，别顺手加规则 —— 规格范围 7 是四类，多一类就要先改规格）。
 */
const KEYWORD_BEFORE_PAREN = new Set([
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'catch',
  'return',
  'sizeof',
  'new',
  'delete',
  'throw',
  'and',
  'or',
  'not',
  'assert',
]);

/** `(` 前一个 token 是不是「调用目标」：标识符 / `)` / `]`（单字符走字符判定，避免切片） */
function isCallTarget(raw: string, prevS: number, prevE: number): boolean {
  if (prevE - prevS === 1) {
    const c = raw[prevS];
    return c === ')' || c === ']' || c === '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
  }
  const prevTok = raw.slice(prevS, prevE);
  return /^[A-Za-z_]\w*$/.test(prevTok) && !KEYWORD_BEFORE_PAREN.has(prevTok);
}

/**
 * 该行有没有需要归一的空白（纯字符判定、零切片）。假 → 整行跳过归一：
 * 语料里绝大多数行本来就是单空格，热路径上「先判断再重建」比「无条件重建」便宜一个量级。
 */
function lineNeedsSpacing(raw: string, spans: number[]): boolean {
  for (let i = 2; i + 1 < spans.length; i += 2) {
    const prevS = spans[i - 2];
    const prevE = spans[i - 1];
    const s = spans[i];
    const e = spans[i + 1];
    const gap = s - prevE;
    if (gap >= 2) return true; // ① 连续空白
    const single = prevE - prevS === 1;
    const prevChar = raw[prevE - 1];
    if (gap === 0 && single && prevChar === ',') return true; // ④ 逗号后补空格
    if (gap >= 1) {
      if (single && prevChar === '.') return true; // ③ `.` 后删空白
      if (e - s === 1 && raw[s] === '(' && isCallTarget(raw, prevS, prevE)) return true; // ② 调用括号前删空白
    }
  }
  return false;
}

function normalizeBody(raw: string, spans: number[]): { body: string; cols: number[]; gapIssue: string | null } {
  const first = spans[0] ?? 0;
  if (spans.length < 4) {
    // 0 或 1 个 token：token 之间没有空白可归一
    return { body: raw.slice(first), cols: spans.length >= 2 ? [0] : [], gapIssue: null };
  }
  let body = '';
  const cols: number[] = [];
  for (let i = 0; i + 1 < spans.length; i += 2) {
    const s = spans[i];
    const e = spans[i + 1];
    if (i > 0) {
      const prevS = spans[i - 2];
      const prevE = spans[i - 1];
      const single = prevE - prevS === 1;
      const prevChar = raw[prevE - 1];
      let rep: string;
      if (e - s === 1 && raw[s] === '(' && isCallTarget(raw, prevS, prevE)) rep = '';
      else if (single && prevChar === '.') rep = '';
      else if (single && prevChar === ',') rep = ' ';
      else rep = s === prevE ? '' : ' ';
      body += rep;
    }
    cols.push(body.length);
    body += raw.slice(s, e);
  }
  const lastEnd = spans[spans.length - 1];
  body += raw.slice(lastEnd); // 行尾 trivia 原样
  // 自检（范围 10）：**token 之间**的 gap 必须 ≤1 个空白字符。
  // 只查 gap、不查 token 内部 —— 注释与宏体是**单个 token**，里面的对齐空格不属于我们
  // （2026-10-30 第一版按整行正则自检，误杀 58 个语料文件：`//  对齐注释`、`#define TEXTURE2D_PARAM(…)`）。
  let gapIssue: string | null = null;
  for (let i = 0; i + 1 < cols.length; i++) {
    const gapStart = cols[i] + (spans[2 * i + 1] - spans[2 * i]);
    const gap = body.slice(gapStart, cols[i + 1]);
    if (gap.length >= 2) {
      gapIssue = `${JSON.stringify(raw.slice(spans[2 * i], spans[2 * i + 3]).slice(0, 40))} gap=${JSON.stringify(gap)}`;
      break;
    }
  }
  return { body, cols, gapIssue };
}

/**
 * 输出一行（可能拆成两行）。`verbatim` 行由调用方原样推送，不进这里。
 * `hlslBrace` = 该行属于 program 区域 / HLSL 方言文件：`braceOnNewLine` 只管 HLSL 函数与控制流
 * （规格范围 6），ShaderLab 外壳的 `{` 位置不动。返回是否发生了拆行。
 */
export function emitFormattedLine(
  raw: string,
  m: LineModel,
  switches: FormatSwitches,
  indent: IndentOptions,
  out: string[],
  hlslBrace = false
): boolean {
  const tail = m.body ?? raw.slice(raw.length - raw.trimStart().length);
  const prefix =
    m.alignDepth >= 0
      ? indentPrefix(m.alignDepth, indent) + ' '.repeat(Math.max(0, m.alignExtra))
      : indentPrefix(m.depth, indent);
  const cr = /\r$/.test(tail) ? '\r' : '';
  const body = cr ? tail.slice(0, -1) : tail;
  // `braceOnNewLine`：把行尾的 `{` 挪到下一行（Allman）。孤立的 `{` 行不再拆 → 幂等。
  if (hlslBrace && switches.braceOnNewLine && body.endsWith('{') && body.trimEnd().length > 1) {
    const head = body.slice(0, -1).replace(/[ \t]+$/, '');
    if (head !== '') {
      out.push(prefix + head + cr);
      out.push(indentPrefix(m.depth, indent) + '{' + cr);
      return true;
    }
  }
  // 范围 8：行尾 `}` 拆到下一行（`return o;}` → 两行）。孤立 `}` 行不拆 → 幂等。
  if (switches.braceSplitting && m.tailBraceDepth >= 0 && body.endsWith('}')) {
    const head = body.slice(0, -1).replace(/[ \t]+$/, '');
    if (head !== '') {
      out.push(prefix + head + cr);
      out.push(indentPrefix(m.tailBraceDepth, indent) + '}' + cr);
      return true;
    }
  }
  out.push(prefix + tail);
  return false;
}

/**
 * 排一个 program 区域（`HLSLPROGRAM`/`CGPROGRAM`/`GLSLPROGRAM` 内部）或独立文件全文
 * （`.hlsl`/`.hlslinc`/`.cginc`）。
 * `lines` = 逐行输出（不含换行符）；`formatted` = 其中**由打印器产出**（非原样）的行下标，
 * 供输出形状自检（`outputShapeViolations`）用 —— 原样行不参与断言。
 */
export function printHlslRegion(
  text: string,
  tree: Tree,
  switches: FormatSwitches,
  indent: IndentOptions,
  baseDepth = 0,
  issuesOut?: string[]
): { lines: string[]; formatted: number[] } {
  const model = buildLineModel(
    text,
    tree,
    {
      baseDepth,
      macroMatchIndent: switches.macroMatchIndent,
      intraLineSpacing: switches.intraLineSpacing,
      braceSplitting: switches.braceSplitting,
    },
    undefined,
    issuesOut
  );
  const src = text.split('\n');
  const out: string[] = [];
  const formatted: number[] = [];
  let blanks = 0;
  for (let i = 0; i < src.length; i++) {
    const raw = src[i];
    const m = model[i];
    if (raw.trim() === '') {
      // 原样区内的空行不折叠（折叠会移行号，错误恢复边界随之下移 → 幂等破）
      if (m.verbatim) {
        out.push(raw);
        continue;
      }
      blanks++;
      if (blanks <= switches.keepBlankLines) out.push(/\r$/.test(raw) ? '\r' : '');
      continue;
    }
    blanks = 0;
    if (m.verbatim) {
      out.push(raw);
      continue;
    }
    formatted.push(out.length);
    emitFormattedLine(raw, m, switches, indent, out, true);
  }
  return { lines: out, formatted };
}
