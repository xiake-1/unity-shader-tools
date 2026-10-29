/** Unity 工程与环境发现（规格范围 4、T-010）
 *
 * 判定顺序（与规格一致）：
 * 1) 打开文档路径里的 Assets/ 、Packages/ 、Library/PackageCache/ 分段；
 * 2) 从文件所在目录向上找同时含 Assets/ 与 Library/ 的目录；
 * 3) 第一个 workspace folder；
 * 4) 失败 → 降级（内置/包内符号为空，外壳与工程内解析照常）。
 *
 * Editor 安装路径发现：ProjectSettings/ProjectVersion.txt + 用户配置项 /
 * Unity Hub 安装表 / 常见安装目录扫描；找不到 → 内置 include 不可用（降级）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

export interface UnityEnvironment {
  projectRoot: string | null;
  editorDir: string | null;
  cgIncludesDir: string | null;
  packageCacheDir: string | null;
  editorVersion: string | null;
  /** T-073：Editor 路径由哪一级给出（规格范围 9 的 `editor-path-source=` 口径） */
  editorPathSource: EditorPathSource;
  /** 降级原因（用于一次性提示；空数组 = 未降级） */
  degradedReasons: string[];
}

export interface DiscoveryOptions {
  /** 用户配置项 unityShader.unityEditorPath，最高优先级 */
  configuredEditorPath?: string;
  /** 测试注入：Hub 安装表路径（默认取 %APPDATA%/UnityHub） */
  hubSettingsDir?: string;
  /** 测试注入：额外扫描根 */
  extraEditorRoots?: string[];
  /** 仅测试用：关掉平台默认安装根扫描，保证结果确定 */
  noDefaultEditorRoots?: boolean;
  /** 测试注入：假进程表（thunk，便于断言「配置有值时一次都不调用」） */
  processList?: () => UnityProcessInfo[];
  /** 进程枚举超时（默认 1500 ms，规格约束） */
  processTimeoutMs?: number;
}

/** T-073：运行中 Unity 进程的一行信息（真机由 PowerShell / `ps` 提供，测试由假表注入） */
export interface UnityProcessInfo {
  pid: number;
  /** 完整命令行（Windows 取 `Win32_Process.CommandLine`，类 Unix 取 `ps args`） */
  commandLine: string;
  /** 可执行文件绝对路径（Windows `ExecutablePath`；取不到时为 null） */
  executablePath: string | null;
}

/** `editor-path-source=` 的五值口径（规格范围 9） */
export type EditorPathSource = 'config' | 'process' | 'hub' | 'scan' | 'none';

const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** 步骤 1：从文档路径分段判定工程根（返回值使用本机路径分隔符） */
export function projectRootFromPathSegments(fsPath: string): string | null {
  const norm = fsPath.replace(/\\/g, '/');
  const segs = norm.split('/');
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i].toLowerCase();
    if (s === 'assets' || s === 'packages') {
      return segs.length > 1 ? path.normalize(segs.slice(0, i).join('/')) : null;
    }
    if (s === 'library' && segs[i + 1] && segs[i + 1].toLowerCase() === 'packagecache') {
      return segs.length > 1 ? path.normalize(segs.slice(0, i).join('/')) : null;
    }
  }
  return null;
}

/** 步骤 2：向上找同时含 Assets/ 与 Library/ 的目录 */
export function projectRootByWalkUp(fsPath: string): string | null {
  let dir = path.dirname(fsPath);
  for (let depth = 0; depth < 12; depth++) {
    if (isDir(path.join(dir, 'Assets')) && isDir(path.join(dir, 'Library'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function findProjectRoot(
  fsPath: string | null,
  workspaceFolders: string[] = []
): string | null {
  if (fsPath) {
    const bySegment = projectRootFromPathSegments(fsPath);
    if (bySegment) return bySegment;
    const byWalk = projectRootByWalkUp(fsPath);
    if (byWalk) return byWalk;
  }
  for (const wf of workspaceFolders) {
    if (isDir(path.join(wf, 'Assets'))) return wf;
  }
  return null;
}

export function readEditorVersion(projectRoot: string): string | null {
  const f = path.join(projectRoot, 'ProjectSettings', 'ProjectVersion.txt');
  if (!isFile(f)) return null;
  try {
    const txt = fs.readFileSync(f, 'utf8');
    const m = /m_EditorVersion(?:WithRevision)?:\s*(\S+)/.exec(txt);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** 从 Unity Hub 的安装表里找编辑器目录 */
function editorsFromHub(version: string, hubDir: string): string[] {
  const out: string[] = [];
  const v2 = path.join(hubDir, 'editors-v2.json');
  const v1 = path.join(hubDir, 'editors.json');
  for (const f of [v2, v1]) {
    if (!isFile(f)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      const list = Array.isArray(data) ? data : (data.editors ?? []);
      for (const e of list) {
        const dir: string | undefined = e.location ?? e.path ?? e.folder;
        const ver: string | undefined = e.version;
        if (dir && ver && ver === version) out.push(dir);
      }
    } catch {
      /* 安装表格式随 Hub 版本变化：解析失败即忽略该来源 */
    }
  }
  return out;
}

/** 常见安装目录扫描：`<root>/**\/<version>\Editor` */
function editorsFromScan(version: string, roots: string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    if (!isDir(root)) continue;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      const cand = path.join(root, e, 'Editor');
      if (e.toLowerCase() === version.toLowerCase().replace(/[a-z]\d*$/, '') && isDir(cand)) {
        out.push(cand);
      }
      const exact = path.join(root, version, 'Editor');
      if (isDir(exact)) out.push(exact);
    }
  }
  return out;
}

/** 平台默认安装根（Hub 默认位置）。便携/自定义安装靠 unityShader.unityEditorPath 兜底 */
export function defaultEditorRoots(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string[] {
  if (platform === 'win32') {
    const pf = env.ProgramFiles ?? 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'];
    const roots = [path.join(pf, 'Unity', 'Hub', 'Editor'), path.join(pf, 'Unity')];
    if (pf86) roots.push(path.join(pf86, 'Unity', 'Hub', 'Editor'));
    if (env.LOCALAPPDATA) roots.push(path.join(env.LOCALAPPDATA, 'Programs', 'Unity', 'Hub', 'Editor'));
    return roots;
  }
  if (platform === 'darwin') {
    return ['/Applications/Unity/Hub/Editor', '/Applications/Unity'];
  }
  const home = env.HOME ?? '';
  return [home ? path.join(home, 'Unity', 'Hub', 'Editor') : '', '/opt/unity', '/usr/share/unity3d'].filter(
    (p) => p.length > 0
  );
}

/* ---------------- T-073：运行中 Unity 进程一级（规格范围 9） ----------------
 * 优先级固定：用户配置 > **运行中进程** > Hub 安装表 > 平台默认安装根扫描。
 * 进程枚举是**短命工具子进程**（ADR 0010 的界定）：超时 1500 ms、结果缓存 ≥ 5 s、
 * 失败/超时直接降级到 Hub + 安装根链，不重试成环、不常驻。
 */
const PROCESS_TIMEOUT_MS = 1500;
const PROCESS_CACHE_TTL_MS = 5000;
let processCache: { expiresAt: number; infos: UnityProcessInfo[] | null } | null = null;

/** 测试用：清掉进程枚举缓存（默认 5 s TTL，用例之间必须互不污染） */
export function clearUnityProcessCache(): void {
  processCache = null;
}

const samePathLoose = (a: string, b: string): boolean => {
  const n = (p: string): string =>
    p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase().replace(/^([a-z]):/, '$1:');
  return n(a) === n(b);
};

/** 命令行切词（保留引号内整体），用于取 `-projectPath` 之类参数 */
function tokenizeCommandLine(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

/** 进程所属工程：优先 `-projectPath`，缺失时退 `-createproject`（实测主进程只有后者） */
export function projectPathOfCommandLine(cmd: string): string | null {
  const t = tokenizeCommandLine(cmd);
  for (let i = 0; i < t.length; i++) {
    const tok = t[i];
    const eq = /^-(projectPath|createproject)=(.+)$/i.exec(tok);
    if (eq) return eq[2];
    if (/^-(projectPath|createproject)$/i.test(tok) && t[i + 1]) return t[i + 1];
  }
  return null;
}

/** 排除规则：批处理模式与资源导入子进程都不是「用户正在用的编辑器」 */
export function isExcludedUnityProcess(cmd: string): boolean {
  const t = tokenizeCommandLine(cmd);
  if (t.some((x) => /^-batchMode$/i.test(x))) return true;
  for (let i = 0; i < t.length; i++) {
    if (/^-name$/i.test(t[i]) && /^AssetImportWorker/i.test(t[i + 1] ?? '')) return true;
  }
  return false;
}

/** 从 exe 路径向上找 `<dir>/Data/CGIncludes`（Windows 布局；macOS 属 ADR 0010 未决项 ①） */
function editorDirFromExecutable(exe: string): string | null {
  let dir = path.dirname(exe);
  for (let depth = 0; depth < 6; depth++) {
    if (isDir(path.join(dir, 'Data', 'CGIncludes'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 一次性枚举 Unity 进程（真机路径；测试用 `processList` 注入假表，不走这里） */
function listUnityProcesses(timeoutMs: number): UnityProcessInfo[] | null {
  if (processCache && Date.now() < processCache.expiresAt) return processCache.infos;
  let infos: UnityProcessInfo[] | null = null;
  try {
    if (process.platform === 'win32') {
      const ps =
        'Get-CimInstance Win32_Process -Filter "Name=\'Unity.exe\'" | ' +
        'ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; cmd=$_.CommandLine; exe=$_.ExecutablePath } } | ' +
        'ConvertTo-Json -Compress';
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      }).trim();
      if (out) {
        const parsed = JSON.parse(out.startsWith('[') ? out : `[${out}]`);
        infos = (Array.isArray(parsed) ? parsed : [parsed])
          .filter((x: { pid?: number }) => typeof x?.pid === 'number')
          .map((x: { pid: number; cmd?: string; exe?: string }) => ({
            pid: x.pid,
            commandLine: x.cmd ?? '',
            executablePath: x.exe ?? null,
          }));
      } else {
        infos = [];
      }
    } else {
      const out = execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8', timeout: timeoutMs });
      infos = out
        .split(/\r?\n/)
        .map((line) => {
          const m = /^\s*(\d+)\s+(.*)$/.exec(line);
          if (!m) return null;
          const argv = tokenizeCommandLine(m[2])[0] ?? '';
          return {
            pid: Number(m[1]),
            commandLine: m[2],
            executablePath: argv.startsWith('/') ? argv : null,
          };
        })
        .filter((x): x is UnityProcessInfo => x !== null)
        .filter((x) => /(^|\/)Unity$/.test(x.commandLine.trim().split(/\s+/)[0] ?? ''));
    }
  } catch {
    infos = null; // 超时 / 无权限 / 命令不存在 → 降级，不抛错
  }
  processCache = { expiresAt: Date.now() + PROCESS_CACHE_TTL_MS, infos };
  return infos;
}

/** 运行中且属于**当前 workspace** 的编辑器目录（对不上工程的一律不用） */
export function runningEditorDirs(
  opts: DiscoveryOptions = {},
  workspaceRoots: string[] = []
): Array<{ dir: string; pid: number }> {
  const infos = opts.processList
    ? opts.processList()
    : listUnityProcesses(opts.processTimeoutMs ?? PROCESS_TIMEOUT_MS);
  if (!infos) return [];
  const out: Array<{ dir: string; pid: number }> = [];
  for (const p of infos) {
    if (isExcludedUnityProcess(p.commandLine)) continue;
    const proj = projectPathOfCommandLine(p.commandLine);
    if (!proj) continue;
    if (!workspaceRoots.some((r) => r && samePathLoose(r, proj))) continue;
    if (!p.executablePath) continue;
    const dir = editorDirFromExecutable(p.executablePath);
    if (dir) out.push({ dir, pid: p.pid });
  }
  return out;
}

/** 发现链 + 来源标记（规格范围 9 的五值口径）。
 *  注意 `configuredEditorPath` 有值时**进程一级完全不参与**（规格异常表）：
 *  即便配置的路径无效、后面几级把目录救回来了，来源仍记 `config`——
 *  用户的显式配置不该被进程探测「救」，日志要能看出这一点。 */
export function findEditorDirWithSource(
  version: string | null,
  opts: DiscoveryOptions = {},
  workspaceRoots: string[] = []
): { dir: string | null; source: EditorPathSource } {
  if (opts.configuredEditorPath) {
    const p = opts.configuredEditorPath;
    const valid = isDir(path.join(p, 'Data', 'CGIncludes')) || (isDir(p) && path.basename(p).toLowerCase() === 'editor');
    if (valid) return { dir: p, source: 'config' };
    // 无效配置：按既有降级继续找目录，但来源仍记 config（不用进程一级）
    const fallback = findEditorDirFromHubOrScan(version, opts);
    return { dir: fallback.dir, source: 'config' };
  }

  for (const r of runningEditorDirs(opts, workspaceRoots)) {
    return { dir: r.dir, source: 'process' };
  }
  const rest = findEditorDirFromHubOrScan(version, opts);
  return rest;
}

function findEditorDirFromHubOrScan(
  version: string | null,
  opts: DiscoveryOptions = {}
): { dir: string | null; source: EditorPathSource } {
  if (!version) return { dir: null, source: 'none' };

  const hubDir =
    opts.hubSettingsDir ??
    path.join(process.env.APPDATA ?? '', 'UnityHub');
  const fromHub = editorsFromHub(version, hubDir);
  for (const dir of fromHub) {
    const editorDir = isDir(path.join(dir, 'Editor')) ? path.join(dir, 'Editor') : dir;
    if (isDir(path.join(editorDir, 'Data', 'CGIncludes'))) return { dir: editorDir, source: 'hub' };
  }

  const roots = [
    ...(opts.extraEditorRoots ?? []),
    ...(opts.noDefaultEditorRoots ? [] : defaultEditorRoots()),
  ];
  for (const dir of editorsFromScan(version, roots)) {
    if (isDir(path.join(dir, 'Data', 'CGIncludes'))) return { dir, source: 'scan' };
  }
  return { dir: null, source: 'none' };
}

export function findEditorDir(version: string | null, opts: DiscoveryOptions = {}): string | null {
  return findEditorDirWithSource(version, opts).dir;
}

/** 组装完整环境；任何缺失都记录为降级原因，不抛错、不弹窗 */
export function discoverUnityEnvironment(
  fsPath: string | null,
  workspaceFolders: string[] = [],
  opts: DiscoveryOptions = {}
): UnityEnvironment {
  const reasons: string[] = [];
  const projectRoot = findProjectRoot(fsPath, workspaceFolders);
  if (!projectRoot) reasons.push('not-a-unity-project');

  const packageCacheDir = projectRoot ? path.join(projectRoot, 'Library', 'PackageCache') : null;
  if (packageCacheDir && !isDir(packageCacheDir)) reasons.push('package-cache-missing');

  const version = projectRoot ? readEditorVersion(projectRoot) : null;
  const roots = [...new Set([...workspaceFolders, ...(projectRoot ? [projectRoot] : [])].filter(Boolean))];
  const found = findEditorDirWithSource(version, opts, roots);
  const editorDir = found.dir;
  if (!editorDir) reasons.push('editor-path-unknown');

  const cgIncludesDir = editorDir ? path.join(editorDir, 'Data', 'CGIncludes') : null;
  if (cgIncludesDir && !isDir(cgIncludesDir)) reasons.push('cgincludes-missing');

  return {
    projectRoot,
    editorDir,
    cgIncludesDir: cgIncludesDir && isDir(cgIncludesDir) ? cgIncludesDir : null,
    packageCacheDir: packageCacheDir && isDir(packageCacheDir) ? packageCacheDir : null,
    editorVersion: version,
    editorPathSource: found.source,
    degradedReasons: reasons,
  };
}
