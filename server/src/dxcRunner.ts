/**
 * T-049：DXC 编译器定位（ADR 0010、规格 feature-type-diagnostics 范围 4）。
 *
 * 优先级：`unityShader.dxcPath`（用户覆盖）→ `UNITYSHADER_DXC_HOME`（测试/CI 注入）→
 * 随扩展附带的产物（`third_party/dxc/<platform>-<arch>/`）。
 * 不做 PATH 查找、不用 Unity 的 `dxcompiler.dll`、不做首次运行下载（ADR 0010 已否）。
 *
 * 失败方向：定位不到 → 返回结构化失败，调用方**不产类型诊断**并给出明确提示（规格异常表
 * `dxc=missing`），绝不静默、绝不抛错打断其它功能。
 *
 * 实测事实（本机 v1.9.2609）：`dxc.exe` 1.3 MB + `dxcompiler.dll` 21.24 MB + `dxil.dll` 1.9 MB
 * —— dll 必须与 exe 同目录，否则 exe 加载失败；这是本模块把「同目录 dll 缺失」判为
 * `missing-bundled` 的原因。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

/** 附带产物所在目录名（仓库根下；由 `npm run dxc:fetch` 生成，不入库） */
export const DXC_ARTIFACT_DIR = 'third_party';

/** 官方有预编译产物的平台矩阵（ADR 0010：macOS 无官方产物 → 返回 null） */
export function dxcPlatformDir(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string | null {
  if (platform === 'win32' && (arch === 'x64' || arch === 'arm64')) return `win32-${arch}`;
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  return null;
}

export function dxcExecutableName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'dxc.exe' : 'dxc';
}

/** 从 server 模块目录向上找 `third_party/dxc`：仓库内开发、vsix 内两种布局都覆盖。 */
export function dxcSearchRoots(moduleDir: string): string[] {
  const roots = new Set<string>();
  let cur = path.resolve(moduleDir);
  for (let i = 0; i < 5; i++) {
    roots.add(path.join(cur, DXC_ARTIFACT_DIR, 'dxc'));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return [...roots];
}

export type DxcSource = 'configured' | 'env' | 'bundled';

export interface DxcResolved {
  ok: true;
  /** dxc 可执行文件绝对路径 */
  path: string;
  /** 所在目录（dll 同目录检查用） */
  dir: string;
  source: DxcSource;
  platformDir: string;
}

export type DxcFailureReason = 'unsupported-platform' | 'missing-configured' | 'missing-bundled';

export interface DxcFailed {
  ok: false;
  reason: DxcFailureReason;
  /** 人可读的失败细节（进日志与客户端提示） */
  detail: string;
  /** 尝试过的位置（只含 bundled 情形） */
  tried?: string[];
}

export type DxcResolution = DxcResolved | DxcFailed;

export interface ResolveDxcOptions {
  /** `unityShader.dxcPath`（空串/未设 = 不覆盖） */
  configuredPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  /** server 模块所在目录（默认为本文件编译产物所在目录） */
  moduleDir?: string;
  existsSync?: (p: string) => boolean;
}

function isFile(existsSync: (p: string) => boolean, p: string): boolean {
  return existsSync(p);
}

/** 定位 dxc。纯函数式：文件系统与平台都可注入，便于测试。 */
export function resolveDxc(opts: ResolveDxcOptions = {}): DxcResolution {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const existsSync = opts.existsSync ?? ((p: string) => fs.existsSync(p));
  const moduleDir = opts.moduleDir ?? __dirname;

  const configured = (opts.configuredPath ?? '').trim();
  if (configured) {
    const p = path.resolve(configured);
    if (!isFile(existsSync, p)) {
      return {
        ok: false,
        reason: 'missing-configured',
        detail: `unityShader.dxcPath 指向的文件不存在：${p}`,
      };
    }
    return { ok: true, path: p, dir: path.dirname(p), source: 'configured', platformDir: dxcPlatformDir(platform, arch) ?? 'custom' };
  }

  const platformDir = dxcPlatformDir(platform, arch);
  if (!platformDir) {
    return {
      ok: false,
      reason: 'unsupported-platform',
      detail: `${platform}-${arch} 无官方 DXC 预编译产物（ADR 0010）；可设 unityShader.dxcPath 自备编译器`,
    };
  }

  const exe = dxcExecutableName(platform);

  const envHome = (env.UNITYSHADER_DXC_HOME ?? '').trim();
  if (envHome) {
    const p = path.join(path.resolve(envHome), platformDir, exe);
    if (isFile(existsSync, p)) {
      return { ok: true, path: p, dir: path.dirname(p), source: 'env', platformDir };
    }
  }

  const roots = dxcSearchRoots(moduleDir);
  for (const root of roots) {
    const dir = path.join(root, platformDir);
    const p = path.join(dir, exe);
    if (!isFile(existsSync, p)) continue;
    // win32：dxcompiler.dll 必须与 exe 同目录，否则 exe 直接加载失败
    if (platform === 'win32' && !isFile(existsSync, path.join(dir, 'dxcompiler.dll'))) {
      return {
        ok: false,
        reason: 'missing-bundled',
        detail: `找到 ${exe} 但同目录缺少 dxcompiler.dll：${dir}（跑一次 npm run dxc:fetch 修复）`,
        tried: roots.map((r) => path.join(r, platformDir)),
      };
    }
    return { ok: true, path: p, dir, source: 'bundled', platformDir };
  }

  return {
    ok: false,
    reason: 'missing-bundled',
    detail: `未找到附带 dxc 产物（${platformDir}）；跑一次 npm run dxc:fetch，或设 unityShader.dxcPath`,
    tried: roots.map((r) => path.join(r, platformDir)),
  };
}

/** `dxc --version` 输出里的版本串（用于缓存键与门槛报告）。实测形态：
 *  `Version: dxcompiler.dll: 1.9(5512-01b62ad4)(1.9.2609.5) - 1.9.2609.5 (01b62ad47)` */
export function parseDxcVersion(text: string): string | null {
  const m = /(\d+\.\d+\.\d+\.\d+)/.exec(text);
  if (m) return m[1];
  const m2 = /Version:\s*dxc(?:compiler\.dll)?:\s*([0-9.]+)/.exec(text);
  return m2 ? m2[1] : null;
}

export type DxcProbe =
  | { ok: true; version: string | null; stdout: string }
  | { ok: false; reason: 'spawn-failed' | 'timeout'; detail: string };

/** 跑一次 `--version`：证明产物可加载（dll 缺失/损坏在这里暴露），并取版本号。 */
export function probeDxc(exePath: string, timeoutMs = 5000): Promise<DxcProbe> {
  return new Promise((resolve) => {
    execFile(exePath, ['--version'], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const text = `${stdout ?? ''}\n${stderr ?? ''}`;
      if (err && (err as { killed?: boolean }).killed) {
        resolve({ ok: false, reason: 'timeout', detail: `--version 超时（${timeoutMs} ms）` });
        return;
      }
      if (err && !parseDxcVersion(text)) {
        resolve({ ok: false, reason: 'spawn-failed', detail: String((err as Error).message).split('\n')[0] });
        return;
      }
      resolve({ ok: true, version: parseDxcVersion(text), stdout: text.trim() });
    });
  });
}

/** Output 健康行（与 `[keywords]` 同风格）。`res = null` = 尚未定位（启动早期）。 */
export function dxcHealthLine(res: DxcResolution | null, probe?: DxcProbe | null): string {
  if (!res) return '[dxc] state=not-probed';
  if (!res.ok) return `[dxc] state=missing reason=${res.reason} detail=${res.detail}`;
  const v = probe?.ok ? probe.version ?? 'unknown' : probe ? 'probe-failed' : 'unprobed';
  return `[dxc] state=ok source=${res.source} dir=${res.dir} version=${v}`;
}

/* ---------------------------------------------------------------------------
 * T-051：一次编译（短命子进程）+ 输出解析。ADR 0010：库编译目标、无入口点、
 * 不常驻、可 kill、超时即整块不产诊断。
 * ------------------------------------------------------------------------- */

/** 实测（本机 v1.9.2609）：`-T lib_6_3` 不需要入口点，Unity 的 `#pragma vertex/fragment/
 *  multi_compile` 在库目标下**不产生任何警告**；`-Fo NUL`（Windows）不落盘。 */
export function dxcBaseArgs(platform: NodeJS.Platform = process.platform): string[] {
  return ['-T', 'lib_6_3', '-Fo', platform === 'win32' ? 'NUL' : '/dev/null'];
}

export function dxcArgList(
  inputPath: string,
  macros: readonly string[] = [],
  includeRoots: readonly string[] = []
): string[] {
  const args = dxcBaseArgs();
  for (const m of macros) args.push(`-D${m}`);
  for (const r of includeRoots) args.push(`-I${r}`);
  args.push(inputPath);
  return args;
}

export interface DxcIssue {
  /** 1-based（DXC 口径）；调用方按坐标恒等直接减 1 用 */
  line: number;
  col: number;
  severity: 'error' | 'warning';
  /** 实测（本机 v1.9.2609）DXC 前端输出是 **clang 风格**：
   *  `file:line:col: error: <msg>` / `file:line:col: warning: <msg> [-Wflag]`。
   *  语义错误**没有错误码**，只有警告带 `[-Wflag]` → 豁免表的键以**消息模式**为主，
   *  `code` 仅在警告里存在（规格 feature-type-diagnostics 范围 10 据此落地）。 */
  code: string | null;
  message: string;
  /** DXC 报告的文件（虚拟文件 = 当前文档；include 闭包内是别的文件） */
  file: string;
}

const ISSUE_RE = /^(.+?):(\d+):(\d+):\s+(error|warning)\s*:\s*(.*)$/;
const WARN_FLAG_RE = /\[(-W[A-Za-z0-9_-]+)\]\s*$/;
/** 「像诊断但缺位置」的行才计入 `unparsed=`（规格异常表的意图：抓编译器噪声，不是抓源码上下文行）。
 *  实测：clang 的宏展开上下文行会顶格出现（`#define GRA_UNORM 1`），按「所有不匹配行」计数会虚高到 200+。 */
const LOOKS_LIKE_DIAGNOSTIC_RE = /(^|\s)(fatal error|error|warning)\s*:/;

export interface DxcParseResult {
  issues: DxcIssue[];
  /** 像诊断但不符合 clang 位置格式、被忽略的行数（规格异常表 `unparsed=<n>`） */
  unparsed: number;
}

/** 解析 DXC 输出并统计被忽略的行（规格范围 7 + 异常表「不符合格式的行忽略 + `unparsed=`」）。 */
export function parseDxcOutputDetailed(text: string): DxcParseResult {
  const out: DxcIssue[] = [];
  let unparsed = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line || /^\s/.test(line)) continue; // caret/源码上下文行以空白开头
    if (/\bnote:/.test(line)) continue;
    const m = ISSUE_RE.exec(line);
    if (!m) {
      if (LOOKS_LIKE_DIAGNOSTIC_RE.test(line)) unparsed++;
      continue; // 其余是源码上下文行，不计
    }
    const [, file, ln, col, sev, rest] = m;
    if (!file || /^\d+$/.test(file.trim())) {
      unparsed++;
      continue;
    }
    let message = (rest ?? '').trim();
    let code: string | null = null;
    const flag = WARN_FLAG_RE.exec(message);
    if (flag) {
      code = flag[1];
      message = message.slice(0, flag.index).trim();
    }
    out.push({
      line: Number(ln),
      col: Number(col),
      severity: sev as 'error' | 'warning',
      code,
      message,
      file: file.trim(),
    });
  }
  return { issues: out, unparsed };
}

/** 解析 DXC 输出：只取 `error:` / `warning:` 行；`note:` 与 caret 上下文行忽略。 */
export function parseDxcOutput(text: string): DxcIssue[] {
  return parseDxcOutputDetailed(text).issues;
}

export type CompileStatus =
  | 'ok'
  | 'errors'
  | 'timeout'
  | 'cancelled'
  | 'spawn-failed'
  | 'crash'
  | 'output-too-large';

export interface CompileOptions {
  exePath: string;
  /** 分块虚拟文档（与原文等长） */
  virtualText: string;
  macros?: readonly string[];
  includeRoots?: readonly string[];
  timeoutMs?: number;
  /** 虚拟文件写到哪（默认 os.tmpdir()） */
  tmpDir?: string;
  /** 文件名前缀（含文档标识，便于日志与 include 相对路径调试） */
  label?: string;
  platform?: NodeJS.Platform;
  /** T-054：同一文档重算时 kill 掉未完成的子进程（规格范围 9）。
   *  取消与超时的区别必须可分辨：取消记 `cancelled`，超时记 `timeout`。 */
  signal?: AbortSignal;
}

export interface CompileResult {
  status: CompileStatus;
  issues: DxcIssue[];
  errorCount: number;
  warningCount: number;
  exitCode: number | null;
  durationMs: number;
  /** 失败细节（进日志，不进诊断） */
  detail?: string;
  /** 虚拟文件路径（诊断按它过滤「属于当前文档」） */
  virtualFile?: string;
  /** 被忽略的非 clang 风格行数（日志 `unparsed=`） */
  unparsed?: number;
}

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** 跑一次编译。任何失败都返回结构化结果，**不抛错**（规格：编译失败即整块不产诊断）。 */
export async function compileUnit(opts: CompileOptions): Promise<CompileResult> {
  const platform = opts.platform ?? process.platform;
  const timeoutMs = Math.max(1, opts.timeoutMs ?? 5000);
  const started = Date.now();
  const tmpDir = opts.tmpDir ?? os.tmpdir();
  const label = (opts.label ?? 'unityshader-unit').replace(/[^\w.-]/g, '_');
  const virtualFile = path.join(tmpDir, `${label}-${Buffer.from(opts.virtualText).length}-${Date.now()}.hlsl`);

  const finish = (r: Omit<CompileResult, 'durationMs'>): CompileResult => ({ ...r, durationMs: Date.now() - started });

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(virtualFile, opts.virtualText, 'utf8');
  } catch (e) {
    return finish({
      status: 'spawn-failed',
      issues: [],
      errorCount: 0,
      warningCount: 0,
      exitCode: null,
      detail: `写虚拟文件失败：${(e as Error).message}`,
    });
  }

  const args = dxcArgList(virtualFile, opts.macros ?? [], opts.includeRoots ?? []);
  const signal = opts.signal;

  const result = await new Promise<{
    code: number | null;
    text: string;
    killed: boolean;
    enobufs: boolean;
    spawnCode: string | null;
  }>((resolve) => {
    execFile(
      opts.exePath,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, cwd: tmpDir, signal },
      (err, stdout, stderr) => {
        const e = err as (Error & { killed?: boolean; code?: unknown }) | null;
        // 进程正常退出但退出码非零 → e.code 是数字；spawn 层失败（ENOENT/EACCES…）→ e.code 是字符串
        const spawnCode = e && typeof e.code === 'string' ? e.code : null;
        resolve({
          code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
          text: `${stdout ?? ''}\n${stderr ?? ''}`,
          killed: Boolean(e?.killed),
          enobufs: String(e?.message ?? '').includes('maxBuffer'),
          spawnCode,
        });
      }
    );
  });

  try {
    fs.rmSync(virtualFile, { force: true });
  } catch {
    /* 临时文件删不掉不影响结果 */
  }

  // 取消优先于超时判定：两者都会 killed=true，但日志口径不同（`cancelled` vs `dxc=timeout`）
  if (signal?.aborted) {
    return finish({
      status: 'cancelled',
      issues: [],
      errorCount: 0,
      warningCount: 0,
      exitCode: null,
      detail: '编译被取消（同一文档重算）',
      virtualFile,
    });
  }
  if (result.killed) {
    return finish({
      status: 'timeout',
      issues: [],
      errorCount: 0,
      warningCount: 0,
      exitCode: null,
      detail: `编译超时（${timeoutMs} ms）`,
      virtualFile,
    });
  }
  if (result.enobufs) {
    return finish({
      status: 'output-too-large',
      issues: [],
      errorCount: 0,
      warningCount: 0,
      exitCode: result.code,
      detail: `输出超 ${MAX_OUTPUT_BYTES} 字节，视为编译失败`,
      virtualFile,
    });
  }
  if (result.spawnCode) {
    return finish({
      status: 'spawn-failed',
      issues: [],
      errorCount: 0,
      warningCount: 0,
      exitCode: null,
      detail: `spawn 失败 ${result.spawnCode}：${opts.exePath}`,
      virtualFile,
    });
  }

  const parsed = parseDxcOutputDetailed(result.text);
  const issues = parsed.issues;
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.length - errorCount;

  // 非零退出但没有可解析的 error 行 = 编译器自身失败（参数/加载问题）→ 整块不产
  if (result.code !== 0 && errorCount === 0) {
    return finish({
      status: 'crash',
      issues: [],
      errorCount: 0,
      warningCount,
      exitCode: result.code,
      detail: result.text.trim().split('\n').slice(0, 3).join(' | ').slice(0, 300),
      virtualFile,
      unparsed: parsed.unparsed,
    });
  }

  return finish({
    status: errorCount > 0 ? 'errors' : 'ok',
    issues,
    errorCount,
    warningCount,
    exitCode: result.code,
    virtualFile,
    unparsed: parsed.unparsed,
  });
}
