/**
 * T-043：Unity 关键字来源 —— 读 Unity 全局 `Editor.log` 的 `Disabled keywords:` 行。
 *
 * 规格 feature-dead-branch-dimming 范围 1/8、异常表；ADR 0008。
 * 纪律：
 *  - 只解析 `Disabled keywords:` 这一行，不做版本/包清单推断；
 *  - 关键字大小写敏感（C 预处理语义），不做前缀/模糊匹配；
 *  - 只读尾部窗口（默认 512 KiB），窗口外的行**视为未命中**并记 `scanned=`；
 *  - mtime 未变 → 不重读、不解析（`readCount`/`parseCount` 可断言）；
 *  - 读取失败 → 保留上一次集合、记 `stale=true`，不抛错、不弹窗。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const DEFAULT_KEYWORD_LOG_SCAN_BYTES = 512 * 1024;

/** 三平台默认日志路径（规格范围 1）。与 `unityShader.unityEditorPath` 无关。 */
export function defaultKeywordLogPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir()
): string {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return path.join(local, 'Unity', 'Editor', 'Editor.log');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Logs', 'Unity', 'Editor.log');
  }
  return path.join(home, '.config', 'unity3d', 'Editor.log');
}

const DISABLED_PREFIX = 'Disabled keywords:';

/** 从日志文本里取**最后一条** `Disabled keywords:` 行（最后一次会话为准）。 */
export function parseDisabledKeywords(text: string): string[] {
  let found: string | null = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith(DISABLED_PREFIX)) found = trimmed.slice(DISABLED_PREFIX.length);
  }
  if (found === null) return [];
  // 大小写敏感：只按空白切分，不做归一化
  return found.split(/\s+/).map((k) => k.trim()).filter((k) => k.length > 0);
}

export interface KeywordSnapshot {
  /** 日志路径；null = 从未找到日志（Output `source=none`） */
  source: string | null;
  /** 确定关闭的关键字集合 */
  disabled: string[];
  set: ReadonlySet<string>;
  /** 日志 mtime（ms）；null = 无日志 */
  mtimeMs: number | null;
  /** 本次扫描的字节数（尾部窗口实际读取量） */
  scannedBytes: number;
  /** `Disabled keywords:` 行是否落在窗口内（窗口外 → 未命中，规格异常表） */
  foundInWindow: boolean;
  /** 读取失败：保留上一次集合继续工作 */
  stale: boolean;
  /** 实际读盘次数（mtime 未变时不增加） */
  readCount: number;
  /** 实际解析次数 */
  parseCount: number;
}

export interface KeywordSourceOptions {
  /** 覆盖日志路径（测试注入；不存在 → source=none） */
  logPath?: string | null;
  /** 尾部窗口字节数（`unityShader.keywordLogScanBytes`） */
  scanBytes?: number;
}

const EMPTY_SNAPSHOT: KeywordSnapshot = {
  source: null,
  disabled: [],
  set: new Set<string>(),
  mtimeMs: null,
  scannedBytes: 0,
  foundInWindow: false,
  stale: false,
  readCount: 0,
  parseCount: 0,
};

export class UnityKeywordSource {
  private last: KeywordSnapshot = { ...EMPTY_SNAPSHOT, set: new Set<string>() };
  private lastStatKey = '';

  constructor(private opts: KeywordSourceOptions = {}) {
    this.last.source = opts.logPath === null ? null : (opts.logPath ?? defaultKeywordLogPath());
  }

  get current(): KeywordSnapshot {
    return this.last;
  }

  /** 切换日志路径（集成测试指向 fixture / 不存在的日志；传 null 回到平台默认） */
  setLogPath(p: string | null | undefined): void {
    const next = p ?? undefined;
    if (next === this.opts.logPath) return;
    this.opts = { ...this.opts, logPath: next };
    this.lastStatKey = '';
  }

  /** 设置项变化时更新尾部窗口；窗口变了就必须重读（缓存键里含 scanBytes，这里显式失效） */
  setScanBytes(bytes: number): void {
    const v = Math.max(1024, bytes);
    if (v === (this.opts.scanBytes ?? DEFAULT_KEYWORD_LOG_SCAN_BYTES)) return;
    this.opts = { ...this.opts, scanBytes: v };
    this.lastStatKey = '';
  }

  /**
   * 刷新关键字集合。`force=false` 时先 stat：mtime 与上次一致 → 直接复用上次结果，
   * 不读盘也不解析（规格范围 8「mtime 未变则不重读、不解析」）。
   */
  refresh(force = false): KeywordSnapshot {
    const file = this.opts.logPath ?? defaultKeywordLogPath();
    const scanBytes = Math.max(1024, this.opts.scanBytes ?? DEFAULT_KEYWORD_LOG_SCAN_BYTES);
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      // 日志不存在：不灰化、不报错（roadmap M4 第三条）
      this.lastStatKey = '';
      this.last = { ...EMPTY_SNAPSHOT, set: new Set<string>(), source: null };
      return this.last;
    }
    const key = `${st.mtimeMs}:${st.size}:${scanBytes}`;
    if (!force && key === this.lastStatKey) {
      // mtime 未变：不重读、不解析（readCount/parseCount 不增加）
      return this.last;
    }

    let buf: Buffer;
    let windowStart = 0;
    try {
      const size = st.size;
      windowStart = Math.max(0, size - scanBytes);
      const len = size - windowStart;
      buf = Buffer.alloc(len);
      const fd = fs.openSync(file, 'r');
      try {
        fs.readSync(fd, buf, 0, len, windowStart);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // 读取失败：保留上一次集合（规格异常表）
      this.last = { ...this.last, stale: true, source: file, mtimeMs: st.mtimeMs };
      return this.last;
    }

    this.last.readCount++;
    // 窗口起点若落在行中间，丢掉这条残缺行：它等价于「命中行在窗口外」
    const text = windowStart > 0 ? buf.toString('utf8').replace(/^[^\n]*\n/, '') : buf.toString('utf8');
    this.last.parseCount++;
    const disabled = parseDisabledKeywords(text);
    this.last = {
      source: file,
      disabled,
      set: new Set(disabled),
      mtimeMs: st.mtimeMs,
      scannedBytes: buf.length,
      foundInWindow: disabled.length > 0,
      stale: false,
      readCount: this.last.readCount,
      parseCount: this.last.parseCount,
    };
    this.lastStatKey = key;
    return this.last;
  }
}

/** Output 健康行（规格范围 9）。日志缺失 → `source=none`。 */
export function keywordHealthLine(s: KeywordSnapshot, regions: number): string {
  const age = s.mtimeMs === null ? 'n/a' : new Date(s.mtimeMs).toISOString();
  const stale = s.stale ? ' stale=true' : '';
  const scanned = s.foundInWindow ? '' : ` scanned=${s.scannedBytes}`;
  return `[keywords] source=${s.source ?? 'none'} disabled=${s.disabled.length} age=${age}${stale}${scanned} regions=${regions}`;
}
