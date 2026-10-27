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

export interface UnityEnvironment {
  projectRoot: string | null;
  editorDir: string | null;
  cgIncludesDir: string | null;
  packageCacheDir: string | null;
  editorVersion: string | null;
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
}

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

export function findEditorDir(
  version: string | null,
  opts: DiscoveryOptions = {}
): string | null {
  if (opts.configuredEditorPath) {
    const p = opts.configuredEditorPath;
    if (isDir(path.join(p, 'Data', 'CGIncludes'))) return p;
    if (isDir(p) && path.basename(p).toLowerCase() === 'editor') return p;
  }
  if (!version) return null;

  const hubDir =
    opts.hubSettingsDir ??
    path.join(process.env.APPDATA ?? '', 'UnityHub');
  const fromHub = editorsFromHub(version, hubDir);
  for (const dir of fromHub) {
    const editorDir = isDir(path.join(dir, 'Editor')) ? path.join(dir, 'Editor') : dir;
    if (isDir(path.join(editorDir, 'Data', 'CGIncludes'))) return editorDir;
  }

  const roots = [
    ...(opts.extraEditorRoots ?? []),
    ...(opts.noDefaultEditorRoots ? [] : defaultEditorRoots()),
  ];
  for (const dir of editorsFromScan(version, roots)) {
    if (isDir(path.join(dir, 'Data', 'CGIncludes'))) return dir;
  }
  return null;
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
  const editorDir = findEditorDir(version, opts);
  if (!editorDir) reasons.push('editor-path-unknown');

  const cgIncludesDir = editorDir ? path.join(editorDir, 'Data', 'CGIncludes') : null;
  if (cgIncludesDir && !isDir(cgIncludesDir)) reasons.push('cgincludes-missing');

  return {
    projectRoot,
    editorDir,
    cgIncludesDir: cgIncludesDir && isDir(cgIncludesDir) ? cgIncludesDir : null,
    packageCacheDir: packageCacheDir && isDir(packageCacheDir) ? packageCacheDir : null,
    editorVersion: version,
    degradedReasons: reasons,
  };
}
