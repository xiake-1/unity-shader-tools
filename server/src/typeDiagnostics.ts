/**
 * T-050：类型诊断的**编译单元切分**与分块虚拟文档（规格 feature-type-diagnostics 范围 1/2）。
 *
 * 两条实测/设计事实决定了这个模块的形状：
 *  1. **坐标恒等**：虚拟文档与原文**等长**（块外替换为等长空白、换行保留），所以 DXC 报的
 *     `(line, col)` 就是 `.shader` 里的坐标 —— 不需要 ADR 0004 担心的双向行号映射表。
 *     做法沿用 `parser.ts` 的 `buildVirtualHlsl`，但**按块**生成。
 *  2. **必须分块**：把多个 `HLSLPROGRAM` 合并进一份虚拟文档会让两个 Pass 的同名 `vert`/`frag`
 *     被 DXC 判成 `redefinition of 'f'`（本机 v1.9.2609 实测复现）→ 系统性误报。
 *
 * 索引口径（`buildVirtualHlsl` 把 CG 块也送进 HLSL grammar）与类型诊断口径**不同**：
 * 类型诊断只吃 `kind === 'hlsl'` 的块（CG 语义不在范围）。
 */
import type { Tree } from './parser';
import { extractProgramBodies, parseHlslFile, parseShaderLab } from './parser';
import * as path from 'path';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';
import { collectIncludeNodes, includePathNode, includeSpecOf } from './diagnostics';
import { resolveInclude, type IncludeContext } from './includeResolver';
import { isCgSource } from './tempFiles';
import { buildMacroArgs, extractFileDefines, NEVER_DEFINED_BY_DEFAULT } from './dxcMacroTable';
import { collectInactiveRegions } from './inactiveRegions';
import {
  compileUnit,
  type CompileOptions,
  type CompileResult,
  type DxcResolved,
} from './dxcRunner';
import { DxcExemptionTable, dxcContextOf } from './dxcExemption';

export interface CompileUnit {
  /** 块内容在原文件里的字符区间（不含 `HLSLPROGRAM` / `ENDHLSL` 关键字） */
  startChar: number;
  endChar: number;
  /** 与原文等长的虚拟文档：本块原样、其余等长空白 */
  virtualText: string;
  /** 块首/末行（0-based），诊断过滤与日志用 */
  startLine: number;
  endLine: number;
  /** 独立 `.hlsl`/`.hlslinc` 整文件单元时为 true（无 ShaderLab 外壳） */
  wholeFile: boolean;
}

/** 等长空白化：只把块外字符换成空格，换行符原样保留 → 长度与行数不变。 */
function blankOutside(text: string, start: number, end: number): string {
  const chars = text.split('');
  for (let i = 0; i < chars.length; i++) {
    if (i >= start && i < end) continue;
    const c = chars[i];
    if (c !== '\n' && c !== '\r') chars[i] = ' ';
  }
  return chars.join('');
}

function lineOf(text: string, index: number): number {
  let line = 0;
  const limit = Math.min(index, text.length);
  for (let i = 0; i < limit; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** `.shader`：每个 HLSL 程序块一个编译单元（CG/GLSL 块排除）。 */
export function buildCompileUnits(text: string, tree: Tree): CompileUnit[] {
  const bodies = extractProgramBodies(tree, text).filter((b) => b.kind === 'hlsl');
  return bodies.map((b) => ({
    startChar: b.startByte,
    endChar: b.endByte,
    virtualText: blankOutside(text, b.startByte, b.endByte),
    startLine: lineOf(text, b.startByte),
    endLine: lineOf(text, b.endByte),
    wholeFile: false,
  }));
}

/** 独立 `.hlsl`/`.hlslinc`：整文件一个单元（虚拟文档 = 原文）。 */
export function wholeFileUnit(text: string): CompileUnit {
  return {
    startChar: 0,
    endChar: text.length,
    virtualText: text,
    startLine: 0,
    endLine: lineOf(text, text.length),
    wholeFile: true,
  };
}

/** 虚拟文档必须与原文等长（规格约束；测试钉住，防未来改写破坏坐标恒等）。 */
export function assertCoordinateIdentity(original: string, virtual: string): void {
  if (original.length !== virtual.length) {
    throw new Error(`虚拟文档长度漂移：${virtual.length} != ${original.length}`);
  }
  const nl = (s: string): number => (s.match(/\n/g) ?? []).length;
  if (nl(original) !== nl(virtual)) {
    throw new Error(`虚拟文档换行数漂移：${nl(virtual)} != ${nl(original)}`);
  }
}

/* ---------------------------------------------------------------------------
 * T-053：include 闭包接入 DXC（规格 feature-type-diagnostics 范围 6）
 *
 * 权威源是 `includeResolver` 的四类规则（**不造第二套 include 解析**）。DXC 侧两条腿：
 *  1. `-I` 根集合：文档目录（相对 include）、工程根（`Assets/…` 与本地 `Packages/…`）、
 *     内置 `CGIncludes`（裸名）。这三类**原样保留**，坐标完全不动。
 *  2. 路径改写：`Packages/<pkg>/…` 经 PackageCache 解析后带 `@version` 后缀，`-I` 表达不了
 *     → 改写 `#include` 的路径字符串本身。规格硬约束：**不得增删行**（只允许改路径字符串），
 *     所以改写只发生在这一行内、该行之后的列会漂移（`#include` 行本身不产类型诊断，可接受）。
 *
 * 任一 include 解析失败 → **整块不产诊断** + `include-fail=<spec>`（宁可漏报，规格异常表）。
 * ------------------------------------------------------------------------- */

export interface IncludePlan {
  /** 改写后的虚拟文档（换行数不变） */
  virtualText: string;
  /** `-I` 根集合（去重、绝对路径） */
  includeRoots: string[];
  /** 解析失败的 spec（非空 → 整块不产诊断） */
  failures: string[];
  /** 改写条数（日志 `rewritten=`） */
  rewritten: number;
  /** 落在确定为假分支里、被跳过的 include 条数（日志 `include-dead=`） */
  deadSkipped: number;
  /** 解析成功的绝对路径（缓存键的 include 指纹用） */
  resolved: string[];
}

const normPath = (p: string): string => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
const pathEq = (a: string, b: string): boolean => normPath(a) === normPath(b);
const insideDir = (file: string, dir: string | null | undefined): boolean => {
  if (!dir) return false;
  const f = normPath(file);
  const d = normPath(dir);
  return f === d || f.startsWith(d + path.sep) || f.startsWith(d + '/');
};

/** 该 include 经 `-I` 根集合能否原样解析（能就不改写，坐标零漂移）。 */
function resolvableAsIs(spec: string, resolved: string, docDir: string | null, ctx: IncludeContext): boolean {
  const norm = spec.replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!norm) return false;
  if (!norm.includes('/')) {
    // 裸名：内置 CGIncludes（第 4 类）或同目录文件（第 1 类）
    return insideDir(resolved, ctx.cgIncludesDir) || insideDir(resolved, docDir);
  }
  if (ctx.projectRoot && pathEq(path.join(ctx.projectRoot, norm), resolved)) return true; // Assets/… 与本地 Packages/…
  if (docDir && pathEq(path.join(docDir, norm), resolved)) return true; // 相对路径
  return false; // 典型：Packages/<pkg>/… → Library/PackageCache/<pkg>@x/…
}

/** 为一个编译单元规划 include：`-I` 根 + 必要的行内改写 + 失败清单。
 *  `deadMacros`：本次编译里**确定为假**的宏名（Unity Disabled 集合 ∪ 刻意不定义的平台族）。
 *  落在确定为假分支里的 `#include` **不算失败也不改写** —— DXC 同样不会编译那个分支，
 *  把它算成 `include-fail` 会整块丢诊断（实测：URP `Common.hlsl` 的 xboxone/ps4/ps5 分支）。
 *  求值复用 M4 的 `collectInactiveRegions`（同一套三态口径，不造第二份预处理器）。 */
export function planUnitIncludes(
  unit: CompileUnit,
  file: string,
  ctx: IncludeContext | null,
  opts: { deadMacros?: ReadonlySet<string> } = {}
): IncludePlan {
  const emptyCtx: IncludeContext = { projectRoot: null, cgIncludesDir: null, packageCacheDir: null };
  const c = ctx ?? emptyCtx;
  const docDir = file ? path.dirname(file) : null;

  const roots: string[] = [];
  const pushRoot = (d: string | null | undefined): void => {
    if (!d) return;
    const abs = path.resolve(d);
    if (!roots.some((r) => pathEq(r, abs))) roots.push(abs);
  };
  pushRoot(docDir);
  pushRoot(c.projectRoot);
  pushRoot(c.cgIncludesDir);

  const tree = parseHlslFile(unit.virtualText);
  const dead = collectInactiveRegions(tree.rootNode, unit.virtualText, {
    disabled: opts.deadMacros ?? new Set<string>(),
  });
  const inDeadBranch = (row: number): boolean =>
    dead.some((r) => row >= r.start.line && row <= r.end.line);

  const edits: { start: number; end: number; text: string }[] = [];
  const failures: string[] = [];
  const resolved: string[] = [];
  let deadSkipped = 0;

  for (const node of collectIncludeNodes(tree.rootNode)) {
    if (inDeadBranch(node.startPosition.row)) {
      deadSkipped++;
      continue;
    }
    const spec = includeSpecOf(node);
    if (!spec) continue;
    const res = resolveInclude(spec, file, c);
    if (!res.resolved) {
      failures.push(spec);
      continue;
    }
    resolved.push(res.resolved);
    if (resolvableAsIs(spec, res.resolved, docDir, c)) continue;
    const pathNode = includePathNode(node);
    if (!pathNode) {
      failures.push(spec);
      continue;
    }
    // 改写：绝对路径 + 正斜杠 + 双引号；路径里不含换行 → 行数不变
    edits.push({
      start: pathNode.startIndex,
      end: pathNode.endIndex,
      text: `"${res.resolved.replace(/\\/g, '/')}"`,
    });
  }

  let virtualText = unit.virtualText;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    virtualText = virtualText.slice(0, e.start) + e.text + virtualText.slice(e.end);
  }
  return { virtualText, includeRoots: roots, failures, rewritten: edits.length, deadSkipped, resolved };
}

/* ---------------------------------------------------------------------------
 * T-054：类型诊断核心（语法 Error 互斥、缓存键、截断、与语法诊断合并发布）
 * ------------------------------------------------------------------------- */

export const DEFAULT_MAX_TYPE_DIAGNOSTICS_PER_FILE = 100;

/** 编译单元 + 宏 + include 计划：一次「准备」，缓存键与编译共用同一份，避免二次解析。 */
export interface PreparedRun {
  units: CompileUnit[];
  plans: IncludePlan[];
  macros: string[];
  /** 任一单元的 include 失败清单（非空 → 该单元不产） */
  includeFailures: string[];
  /** 降级态（无 include 根）→ 整文件不产（规格约束 `degraded=skip-type-diag`） */
  degraded: boolean;
  /** 不含文档版本的缓存键片段 */
  key: string;
}

const hash = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

const HLSL_FILE_EXT = /\.(hlsl|hlslinc)$/i;

/** 取一个文件的编译单元：`.shader` 按块、`.hlsl/.hlslinc` 整文件、`.cginc` 与 CG/GLSL 零单元。 */
export function unitsForFile(file: string, text: string, tree?: Tree): CompileUnit[] {
  if (isCgSource(file)) return [];
  if (HLSL_FILE_EXT.test(file)) return [wholeFileUnit(text)];
  const lab = tree ?? parseShaderLab(text);
  return buildCompileUnits(text, lab);
}

/** 准备一次类型诊断：单元、宏（默认表 − Disabled + 文件 `#define`）、include 计划、缓存键片段。 */
export function prepareTypeRun(
  file: string,
  text: string,
  opts: { tree?: Tree; includeCtx: IncludeContext | null; disabled?: ReadonlySet<string>; dxcVersion?: string | null }
): PreparedRun {
  const units = unitsForFile(file, text, opts.tree);
  const macros = buildMacroArgs({
    disabled: opts.disabled,
    fileDefines: extractFileDefines(text),
  });
  const hasRoots = !!(
    opts.includeCtx &&
    (opts.includeCtx.projectRoot || opts.includeCtx.cgIncludesDir || opts.includeCtx.packageCacheDir)
  );
  const plans: IncludePlan[] = [];
  const includeFailures: string[] = [];
  // 「确定为假」的宏名：Unity Disabled 集合 + 刻意不定义的平台族（dxcMacroTable 的防误加清单）
  const deadMacros = new Set<string>([...(opts.disabled ?? []), ...NEVER_DEFINED_BY_DEFAULT]);
  for (const u of units) {
    const p = planUnitIncludes(u, file, opts.includeCtx, { deadMacros });
    plans.push(p);
    includeFailures.push(...p.failures);
  }
  const key = hash(
    [
      units.map((u) => `${u.startChar}-${u.endChar}:${u.wholeFile ? 'f' : 'b'}`).join(','),
      macros.join(','),
      plans.map((p) => p.resolved.join('|') + `#${p.rewritten}`).join(';'),
      opts.dxcVersion ?? 'unknown',
    ].join('\u0002')
  );
  return { units, plans, macros, includeFailures, degraded: !hasRoots && units.length > 0, key };
}

export interface TypeCounts {
  units: number;
  compiled: number;
  /** 推给用户的类型诊断条数（只含 Range 落在当前文档内的 error 级） */
  produced: number;
  /** 因语法 Error 互斥而跳过（日志 `skipped=syntax-error`） */
  skippedSyntaxError: boolean;
  degraded: boolean;
  /** dxc 定位失败原因（日志 `dxc=missing reason=…`） */
  dxcMissing: string | null;
  includeFailures: string[];
  timeouts: number;
  cancelled: number;
  unparsed: number;
  exempted: Record<string, number>;
  /** 截断前的总数（日志 `truncated=<总数>`） */
  truncated: number;
  /** 编译失败摘要（`crash`/`spawn-failed`/`output-too-large`），日志用 */
  failures: string[];
  cacheHit: boolean;
}

export const emptyTypeCounts = (): TypeCounts => ({
  units: 0,
  compiled: 0,
  produced: 0,
  skippedSyntaxError: false,
  degraded: false,
  dxcMissing: null,
  includeFailures: [],
  timeouts: 0,
  cancelled: 0,
  unparsed: 0,
  exempted: {},
  truncated: 0,
  failures: [],
  cacheHit: false,
});

export interface ComputeOptions {
  file: string;
  text: string;
  dxc: DxcResolved;
  timeoutMs?: number;
  maxPerFile?: number;
  exemptions?: DxcExemptionTable;
  /** 注入点：单测用 spy 断言调用计数（规格验收「调用计数 = 0」） */
  compile?: (opts: CompileOptions) => Promise<CompileResult>;
  tmpDir?: string;
  signal?: AbortSignal;
  label?: string;
  /** 门槛脚本用：false = 不按「当前文档」过滤（规格范围 11：闭包内错误**计入门槛统计**与豁免命中）。 */
  onlyCurrentDocument?: boolean;
  /** 门槛脚本用：逐条 error 级 issue 回调（含被豁免的），用于逐错误签名聚合表。 */
  onIssue?: (issue: import('./dxcRunner').DxcIssue, normalized: string, exempted: boolean) => void;
}

/** DXC 的「include 文件找不到」错误：整块不产（宁可漏报，规格异常表）。 */
const FILE_NOT_FOUND_RE = /'[^']*'\s+file not found/i;

/** 诊断 Range：起点 `(line-1, col-1)`，终点取该行从起点起的第一个非空白 token（规格范围 7）。 */
function rangeFor(text: string, line1: number, col1: number): Diagnostic['range'] {
  const line = Math.max(0, line1 - 1);
  const start = Math.max(0, col1 - 1);
  const lines = text.split('\n');
  const src = lines[line] ?? '';
  if (start >= src.length) {
    const p = { line, character: Math.max(0, src.length) };
    return { start: p, end: { ...p } };
  }
  let end = start;
  while (end < src.length && !/\s/.test(src[end])) end++;
  if (end === start) end = Math.min(start + 1, src.length);
  return { start: { line, character: start }, end: { line, character: end } };
}

/** 编译并映射一个文件的类型诊断（纯计算 + 注入的 compile；缓存与并发在 Provider 里）。 */
export async function computeTypeDiagnostics(
  prepared: PreparedRun,
  opts: ComputeOptions
): Promise<{ diagnostics: Diagnostic[]; counts: TypeCounts }> {
  const counts = emptyTypeCounts();
  counts.units = prepared.units.length;
  counts.degraded = prepared.degraded;
  const exemptions = opts.exemptions ?? new DxcExemptionTable();
  const maxPerFile = opts.maxPerFile ?? DEFAULT_MAX_TYPE_DIAGNOSTICS_PER_FILE;
  const compile = opts.compile ?? compileUnit;
  const out: Diagnostic[] = [];

  if (prepared.degraded) return { diagnostics: [], counts }; // `degraded=skip-type-diag`

  for (let i = 0; i < prepared.units.length; i++) {
    const unit = prepared.units[i];
    const plan = prepared.plans[i];
    if (plan.failures.length) {
      counts.includeFailures.push(...plan.failures);
      continue; // 整块不产（规格异常表）
    }
    if (opts.signal?.aborted) {
      counts.cancelled++;
      break;
    }
    const res = await compile({
      exePath: opts.dxc.path,
      virtualText: plan.virtualText,
      macros: prepared.macros,
      includeRoots: plan.includeRoots,
      timeoutMs: opts.timeoutMs ?? 5000,
      tmpDir: opts.tmpDir,
      label: opts.label ?? 'unityshader-unit',
      signal: opts.signal,
    });
    counts.compiled++;
    counts.unparsed += res.unparsed ?? 0;
    if (res.status === 'timeout') {
      counts.timeouts++;
      continue;
    }
    if (res.status === 'cancelled') {
      counts.cancelled++;
      continue;
    }
    if (res.status === 'crash' || res.status === 'spawn-failed' || res.status === 'output-too-large') {
      counts.failures.push(`${res.status}:${(res.detail ?? '').slice(0, 120)}`);
      continue; // 编译整体失败 → 整块不产
    }
    // include 闭包内报出的 file-not-found：同样整块不产（不猜、不部分推）
    if (res.issues.some((i) => FILE_NOT_FOUND_RE.test(i.message))) {
      const spec = /'([^']*)'/.exec(res.issues.find((i) => FILE_NOT_FOUND_RE.test(i.message))!.message)?.[1];
      counts.includeFailures.push(spec ?? 'unknown');
      continue;
    }
    const onlyCurrent = opts.onlyCurrentDocument ?? true;
    for (const issue of res.issues) {
      if (issue.severity !== 'error') continue; // 警告首期不推（规格范围 7）
      // 只推 Range 落在当前文档内的（规格范围 11）：虚拟文件路径即当前文档
      const inCurrentDoc = !res.virtualFile || pathEq(issue.file, res.virtualFile);
      const ctx = dxcContextOf(issue, opts.file);
      const exempted = exemptions.match(ctx) !== null; // 命中即计数（门槛断言每条 > 0）
      opts.onIssue?.(issue, ctx.normalized, exempted);
      if (exempted) continue; // 豁免命中 → 不产（ADR 0009）
      if (onlyCurrent && !inCurrentDoc) continue;
      const range = rangeFor(opts.text, issue.line, issue.col);
      if (inCurrentDoc && (range.start.line < unit.startLine || range.start.line > unit.endLine)) continue;
      out.push({
        range,
        severity: DiagnosticSeverity.Error,
        message: issue.message,
        source: 'Unity Shader (DXC)',
        ...(issue.code ? { code: issue.code } : {}),
      });
    }
  }

  for (const [id, n] of exemptions.hitsById) counts.exempted[id] = n;

  out.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
  let final = out;
  if (out.length > maxPerFile) {
    counts.truncated = out.length;
    final = out.slice(0, maxPerFile);
  }
  counts.produced = final.length;
  return { diagnostics: final, counts };
}

/** 日志行（与 `[diagnostics]` 同风格；口径来自规格异常表）。 */
export function typeDiagnosticLogLine(file: string, c: TypeCounts): string {
  const parts = [`[type-diagnostics] ${file} units=${c.units} compiled=${c.compiled} errors=${c.produced}`];
  if (c.skippedSyntaxError) parts.push('skipped=syntax-error');
  if (c.dxcMissing) parts.push(`dxc=missing reason=${c.dxcMissing}`);
  if (c.degraded) parts.push('degraded=skip-type-diag');
  if (c.includeFailures.length) parts.push(`include-fail=${c.includeFailures.slice(0, 3).join(',')}`);
  if (c.timeouts) parts.push(`dxc=timeout x${c.timeouts}`);
  if (c.cancelled) parts.push(`cancelled=${c.cancelled}`);
  if (c.unparsed) parts.push(`unparsed=${c.unparsed}`);
  const ex = Object.entries(c.exempted)
    .map(([id, n]) => `${id}:${n}`)
    .join(',');
  if (ex) parts.push(`exempted=${ex}`);
  if (c.truncated > 0) parts.push(`truncated=${c.truncated}`);
  if (c.failures.length) parts.push(`failed=${c.failures.slice(0, 2).join(' | ')}`);
  return parts.join(' ');
}

/* ---------------------------------------------------------------------------
 * T-054 接线用的 Provider：缓存（规格范围 9 的缓存键）、并发上限 2、
 * 同一文档重算时 kill 掉未完成的子进程。
 * ------------------------------------------------------------------------- */

export interface TypeRunOptions {
  version: number;
  /** 语法诊断的 Error 条数（互斥，规格范围 8） */
  syntaxErrorCount: number;
  dxc: DxcResolved | null;
  dxcVersion?: string | null;
  includeCtx: IncludeContext | null;
  disabled?: ReadonlySet<string>;
  tree?: Tree;
  timeoutMs?: number;
  maxPerFile?: number;
  exemptions?: DxcExemptionTable;
  compile?: (opts: CompileOptions) => Promise<CompileResult>;
  tmpDir?: string;
}

export class TypeDiagnosticsProvider {
  private cache = new Map<string, { key: string; diagnostics: Diagnostic[] }>();
  private controllers = new Map<string, AbortController>();
  private running = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly maxConcurrent = 2) {}

  get cachedFiles(): number {
    return this.cache.size;
  }

  clear(file: string): void {
    this.cache.delete(file);
    const c = this.controllers.get(file);
    if (c) c.abort();
    this.controllers.delete(file);
  }

  clearAll(): void {
    for (const c of this.controllers.values()) c.abort();
    this.controllers.clear();
    this.cache.clear();
  }

  private async slot(): Promise<() => void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return () => {
        this.running--;
        const next = this.queue.shift();
        if (next) next();
      };
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.running++;
    return () => {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    };
  }

  /** 跑一次（含互斥判定、缓存命中、并发与取消）。返回的 diagnostics 已按文档顺序截断。 */
  async run(file: string, text: string, opts: TypeRunOptions): Promise<{ diagnostics: Diagnostic[]; counts: TypeCounts }> {
    const counts = emptyTypeCounts();
    if (opts.syntaxErrorCount > 0) {
      counts.skippedSyntaxError = true;
      this.cache.delete(file); // 已有类型诊断清空（规格异常表）
      return { diagnostics: [], counts };
    }
    if (!opts.dxc) {
      counts.dxcMissing = 'not-resolved';
      return { diagnostics: [], counts };
    }
    if (isCgSource(file)) return { diagnostics: [], counts };

    const prepared = prepareTypeRun(file, text, {
      tree: opts.tree,
      includeCtx: opts.includeCtx,
      disabled: opts.disabled,
      dxcVersion: opts.dxcVersion,
    });
    counts.units = prepared.units.length;
    counts.degraded = prepared.degraded;
    counts.includeFailures = [...prepared.includeFailures];

    const key = `${opts.version}:${prepared.key}`;
    const cached = this.cache.get(file);
    if (cached && cached.key === key) {
      counts.cacheHit = true;
      counts.produced = cached.diagnostics.length;
      return { diagnostics: cached.diagnostics, counts };
    }

    // 同一文档重算：kill 掉未完成的子进程，只发布最新版本（规格范围 9 + 验收「并发与取消」）
    const prev = this.controllers.get(file);
    if (prev) prev.abort();
    const ctrl = new AbortController();
    this.controllers.set(file, ctrl);

    const release = await this.slot();
    try {
      const res = await computeTypeDiagnostics(prepared, {
        file,
        text,
        dxc: opts.dxc,
        timeoutMs: opts.timeoutMs,
        maxPerFile: opts.maxPerFile,
        exemptions: opts.exemptions,
        compile: opts.compile,
        tmpDir: opts.tmpDir,
        signal: ctrl.signal,
      });
      if (!ctrl.signal.aborted && !res.counts.cancelled) {
        this.cache.set(file, { key, diagnostics: res.diagnostics });
      }
      return res;
    } finally {
      release();
      if (this.controllers.get(file) === ctrl) this.controllers.delete(file);
    }
  }
}
