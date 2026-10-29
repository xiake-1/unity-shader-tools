/**
 * T-073 Editor 路径发现新增「运行中进程」一级（规格 feature-shader-name-index-and-variant-report 范围 9）。
 *
 * 进程枚举用**注入假进程表**自动化（真机走手动清单，见规格验收）。
 * 命令行样本取自 2026-10-29 实测：主进程 PID 43656（只有 `-createproject`、无 `-projectPath`）、
 * 资源导入子进程 PID 34732 / 18640（`-batchMode … -name AssetImportWorkerN -projectPath …`）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  discoverUnityEnvironment,
  findEditorDirWithSource,
  isExcludedUnityProcess,
  projectPathOfCommandLine,
  runningEditorDirs,
  type UnityProcessInfo,
} from '../../server/out/unityProject.js';

let root: string;
let editorDir: string; // 带 Data/CGIncludes 的假编辑器目录
let projectRoot: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'm6b-unityproc-'));
  editorDir = path.join(root, 'UnityEditor', '2022.3.62f3c1', 'Editor');
  fs.mkdirSync(path.join(editorDir, 'Data', 'CGIncludes'), { recursive: true });
  projectRoot = path.join(root, 'Project');
  fs.mkdirSync(path.join(projectRoot, 'Assets'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'Library'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'ProjectSettings'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'ProjectSettings', 'ProjectVersion.txt'),
    'm_EditorVersion: 2022.3.62f3c1\n',
    'utf8'
  );
});

afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// `editorDir` 在 beforeAll 里才赋值 → 这些样本一律做成**工厂**，在用例内调用
const exe = (): string => path.join(editorDir, 'Unity.exe');
const proc = (pid: number, commandLine: string, executablePath: string | null = exe()): UnityProcessInfo => ({
  pid,
  commandLine,
  executablePath,
});

/** 实测主进程：没有 -projectPath，只有 -createproject */
const MAIN_CREATE = (): UnityProcessInfo => proc(43656, `"${exe()}" -createproject ${projectRoot} -logFile "C:\\Logs\\Editor.log"`);
/** 常规主进程：Hub 打开的工程带 -projectPath */
const MAIN_PROJ = (): UnityProcessInfo => proc(1111, `"${exe()}" -projectPath ${projectRoot} -logFile -`);
/** 实测资源导入子进程：必须排除 */
const WORKER = (): UnityProcessInfo =>
  proc(
    34732,
    `"${exe()}" -batchMode -no-upm -nographics -batchmode-socket-xpipe -name AssetImportWorker0 -projectPath ${projectRoot} -logFile "C:\\Logs\\AssetImportWorker0.log"`
  );
/** 属于别的工程的进程 */
const OTHER = (): UnityProcessInfo => proc(2222, `"${exe()}" -projectPath D:\\Work\\Unity\\Other`);

describe('T-073 命令行解析与排除', () => {
  it('`-projectPath` 优先，缺失时退 `-createproject`', () => {
    expect(projectPathOfCommandLine(MAIN_PROJ().commandLine)).toBe(projectRoot);
    expect(projectPathOfCommandLine(MAIN_CREATE().commandLine)).toBe(projectRoot);
    expect(projectPathOfCommandLine(`"${exe()}" -projectPath=${projectRoot}`)).toBe(projectRoot);
    expect(projectPathOfCommandLine(`"${exe()}" -logFile -`)).toBeNull();
  });

  it('`-batchMode` + `-name AssetImportWorker*` 被排除（实测 PID 34732 / 18640 即此类）', () => {
    expect(isExcludedUnityProcess(WORKER().commandLine)).toBe(true);
    expect(isExcludedUnityProcess(MAIN_PROJ().commandLine)).toBe(false);
    expect(isExcludedUnityProcess(MAIN_CREATE().commandLine)).toBe(false);
  });
});

describe('T-073 运行中进程一级', () => {
  let calls: number;
  const table = (list: UnityProcessInfo[]) => () => {
    calls++;
    return list;
  };

  beforeEach(() => {
    calls = 0;
  });

  it('进程工程与 workspace 一致 → 取该进程 exe 的编辑器目录，source=process', () => {
    const r = findEditorDirWithSource('2022.3.62f3c1', { processList: table([MAIN_PROJ()]) }, [projectRoot]);
    expect(r).toEqual({ dir: editorDir, source: 'process' });
    expect(calls).toBe(1);
  });

  it('只有 `-createproject` 的主进程也认（实测 PID 43656 形态）', () => {
    const r = findEditorDirWithSource('2022.3.62f3c1', { processList: table([MAIN_CREATE()]) }, [projectRoot]);
    expect(r.source).toBe('process');
    expect(r.dir).toBe(editorDir);
  });

  it('进程属于别的工程 → 一律不用，降级到 Hub/安装根链', () => {
    const r = findEditorDirWithSource('2022.3.62f3c1', { processList: table([OTHER()]) }, [projectRoot]);
    expect(r.dir).not.toBe(editorDir);
    expect(['hub', 'scan', 'none']).toContain(r.source);
  });

  it('只有 AssetImportWorker 在跑 → 排除后降级（不当主编辑器）', () => {
    const r = findEditorDirWithSource('2022.3.62f3c1', { processList: table([WORKER()]) }, [projectRoot]);
    expect(r.source).not.toBe('process');
    expect(r.dir).not.toBe(editorDir);
  });

  it('无 Unity 进程 → 降级，不抛错', () => {
    const r = findEditorDirWithSource('2022.3.62f3c1', { processList: table([]), noDefaultEditorRoots: true, hubSettingsDir: path.join(root, 'no-hub') }, [projectRoot]);
    expect(r).toEqual({ dir: null, source: 'none' });
  });

  it('用户配置有值（有效）→ source=config 且**进程枚举一次都不调用**', () => {
    const r = findEditorDirWithSource('2022.3.62f3c1', { configuredEditorPath: editorDir, processList: table([MAIN_PROJ()]) }, [projectRoot]);
    expect(r).toEqual({ dir: editorDir, source: 'config' });
    expect(calls).toBe(0);
  });

  it('用户配置有值但指向不存在目录 → 仍 source=config，进程一级不参与，也不用进程结果救它', () => {
    const bogus = path.join(root, 'does-not-exist');
    const r = findEditorDirWithSource('2022.3.62f3c1', { configuredEditorPath: bogus, processList: table([MAIN_PROJ()]), noDefaultEditorRoots: true, hubSettingsDir: path.join(root, 'no-hub') }, [projectRoot]);
    expect(calls).toBe(0);
    expect(r.source).toBe('config');
    expect(r.dir).toBeNull();
  });

  it('进程 exe 路径取不到 → 不用该进程', () => {
    const noExe = proc(3333, MAIN_PROJ().commandLine, null);
    expect(runningEditorDirs({ processList: () => [noExe] }, [projectRoot])).toEqual([]);
  });

  it('exe 不在带 `Data/CGIncludes` 的目录树下 → 不用（宁缺毋滥）', () => {
    const stray = proc(4444, MAIN_PROJ().commandLine, path.join(root, 'Tools', 'Unity.exe'));
    expect(runningEditorDirs({ processList: () => [stray] }, [projectRoot])).toEqual([]);
  });
});

describe('T-073 环境组装与日志口径', () => {
  it('discoverUnityEnvironment 带出 editorPathSource=process', () => {
    const env = discoverUnityEnvironment(path.join(projectRoot, 'Assets', 'a.shader'), [projectRoot], {
      processList: () => [MAIN_PROJ()],
    });
    expect(env.projectRoot && path.resolve(env.projectRoot)).toBe(path.resolve(projectRoot));
    expect(env.editorPathSource).toBe('process');
    expect(env.cgIncludesDir).toBe(path.join(editorDir, 'Data', 'CGIncludes'));
  });

  it('没有工程 → editorPathSource=none 且降级原因含 not-a-unity-project', () => {
    const env = discoverUnityEnvironment(null, [], { processList: () => [] });
    expect(env.editorPathSource).toBe('none');
    expect(env.degradedReasons).toContain('not-a-unity-project');
  });
});
