/** T-010：Unity 工程与 Editor 路径发现；非 Unity 目录降级 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  discoverUnityEnvironment,
  defaultEditorRoots,
  findProjectRoot,
  projectRootFromPathSegments,
  readEditorVersion,
} from '../../server/src/unityProject';

let tmp: string;

function touch(p: string, content = ''): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unitydisc-'));
  // 假工程
  touch(path.join(tmp, 'Proj', 'Assets', 'a.shader'), 'Shader "A" { }');
  fs.mkdirSync(path.join(tmp, 'Proj', 'Library', 'PackageCache', 'com.unity.render-pipelines.core@14.0.0', 'ShaderLibrary'), { recursive: true });
  touch(path.join(tmp, 'Proj', 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3.62f3c1\n');
  // 假 Editor
  touch(path.join(tmp, 'Editor', 'Data', 'CGIncludes', 'UnityCG.cginc'), '// cg\n');
  // 假 Hub 安装表
  const hub = path.join(tmp, 'hub');
  fs.mkdirSync(hub, { recursive: true });
  fs.writeFileSync(
    path.join(hub, 'editors-v2.json'),
    JSON.stringify([{ name: 'Unity 2022.3.62f3c1', version: '2022.3.62f3c1', location: path.join(tmp, 'HubEditor') }]),
    'utf8'
  );
  fs.mkdirSync(path.join(tmp, 'HubEditor', 'Editor', 'Data', 'CGIncludes'), { recursive: true });
  // 假「常见安装根」：<root>/<version>/Editor
  fs.mkdirSync(path.join(tmp, 'scanRoot', '2022.3.62f3c1', 'Editor', 'Data', 'CGIncludes'), { recursive: true });
});

afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows 下偶发占用，忽略 */
  }
});

describe('工程根判定', () => {
  it('路径分段：Assets / Packages / Library/PackageCache', () => {
    expect(projectRootFromPathSegments('C:/P/Assets/a/b.shader')).toBe(path.normalize('C:/P'));
    expect(projectRootFromPathSegments('C:/P/Packages/com.x/y.hlsl')).toBe(path.normalize('C:/P'));
    expect(projectRootFromPathSegments('C:/P/Library/PackageCache/com.x@1.0/y.hlsl')).toBe(
      path.normalize('C:/P')
    );
    expect(projectRootFromPathSegments('C:/P/AssetsLib/x.shader')).toBeNull();
  });

  it('向上查找同时含 Assets 与 Library 的目录', () => {
    const f = path.join(tmp, 'Proj', 'Assets', 'a.shader');
    expect(findProjectRoot(f)).toBe(path.join(tmp, 'Proj'));
  });

  it('回退到含 Assets 的 workspace folder', () => {
    expect(findProjectRoot(null, [path.join(tmp, 'Proj')])).toBe(path.join(tmp, 'Proj'));
  });

  it('ProjectVersion.txt 解析编辑器版本', () => {
    expect(readEditorVersion(path.join(tmp, 'Proj'))).toBe('2022.3.62f3c1');
  });
});

describe('环境组装与降级', () => {
  it('完整环境：工程根 + Editor + CGIncludes + PackageCache', () => {
    const env = discoverUnityEnvironment(
      path.join(tmp, 'Proj', 'Assets', 'a.shader'),
      [],
      { configuredEditorPath: path.join(tmp, 'Editor') }
    );
    expect(env.projectRoot).toBe(path.join(tmp, 'Proj'));
    expect(env.editorVersion).toBe('2022.3.62f3c1');
    expect(env.cgIncludesDir).toBe(path.join(tmp, 'Editor', 'Data', 'CGIncludes'));
    expect(env.packageCacheDir).toContain('PackageCache');
    expect(env.degradedReasons).toEqual([]);
  });

  it('Hub 安装表可发现 Editor 目录', () => {
    const env = discoverUnityEnvironment(
      path.join(tmp, 'Proj', 'Assets', 'a.shader'),
      [],
      { hubSettingsDir: path.join(tmp, 'hub') }
    );
    expect(env.editorDir).toBe(path.join(tmp, 'HubEditor', 'Editor'));
  });

  it('非 Unity 目录：降级但不报错，外壳解析仍可用', () => {
    const env = discoverUnityEnvironment(path.join(tmp, 'Editor', 'Data', 'CGIncludes', 'UnityCG.cginc'), []);
    expect(env.projectRoot).toBeNull();
    expect(env.degradedReasons).toContain('not-a-unity-project');
  });

  it('Editor 路径未知：内置 include 不可用，记为降级原因', () => {
    const env = discoverUnityEnvironment(path.join(tmp, 'Proj', 'Assets', 'a.shader'), [], {
      hubSettingsDir: path.join(tmp, 'missing-hub'),
      noDefaultEditorRoots: true,
    });
    expect(env.cgIncludesDir).toBeNull();
    expect(env.degradedReasons).toContain('editor-path-unknown');
    expect(env.projectRoot).toBe(path.join(tmp, 'Proj'));
  });

  it('Hub 未登记时，常见安装根扫描可发现 <root>/<version>/Editor', () => {
    const env = discoverUnityEnvironment(path.join(tmp, 'Proj', 'Assets', 'a.shader'), [], {
      hubSettingsDir: path.join(tmp, 'missing-hub'),
      extraEditorRoots: [path.join(tmp, 'scanRoot')],
      noDefaultEditorRoots: true,
    });
    expect(env.editorDir).toBe(path.join(tmp, 'scanRoot', '2022.3.62f3c1', 'Editor'));
    expect(env.cgIncludesDir).toBe(path.join(tmp, 'scanRoot', '2022.3.62f3c1', 'Editor', 'Data', 'CGIncludes'));
    expect(env.degradedReasons).toEqual([]);
  });

  it('defaultEditorRoots 覆盖三平台的 Hub 默认位置', () => {
    const win = defaultEditorRoots({ ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32');
    expect(win).toContain(path.join('C:\\Program Files', 'Unity', 'Hub', 'Editor'));
    expect(win.some((p) => p.includes('AppData'))).toBe(true);
    const mac = defaultEditorRoots({}, 'darwin');
    expect(mac).toContain('/Applications/Unity/Hub/Editor');
    const linux = defaultEditorRoots({ HOME: '/home/u' }, 'linux');
    expect(linux).toContain('/opt/unity');
    expect(linux).toContain(path.join('/home/u', 'Unity', 'Hub', 'Editor'));
  });
});
