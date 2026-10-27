/** T-011：include 解析四类 + 结构化失败记录 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveInclude, includeCandidates, type IncludeContext } from '../../server/src/includeResolver';

let tmp: string;
let ctx: IncludeContext;

function touch(p: string, content = '// x\n'): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unityinc-'));
  const root = path.join(tmp, 'Proj');
  touch(path.join(root, 'Assets', 'Shaders', 'main.shader'));
  touch(path.join(root, 'Assets', 'Shaders', 'lib', 'common.hlsl'));
  touch(path.join(root, 'Assets', 'Shaders', 'lib', 'Common.cginc'));
  touch(path.join(root, 'Assets', 'Shaders', 'Common.cginc'));
  touch(path.join(root, 'Packages', 'com.my.pkg', 'ShaderLibrary', 'lighting.hlsl'));
  touch(
    path.join(root, 'Library', 'PackageCache', 'com.unity.render-pipelines.core@14.0.0', 'ShaderLibrary', 'Common.hlsl')
  );
  touch(path.join(tmp, 'Editor', 'Data', 'CGIncludes', 'UnityCG.cginc'));
  ctx = {
    projectRoot: root,
    cgIncludesDir: path.join(tmp, 'Editor', 'Data', 'CGIncludes'),
    packageCacheDir: path.join(root, 'Library', 'PackageCache'),
  };
});

afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const from = (): string => path.join(tmp, 'Proj', 'Assets', 'Shaders', 'main.shader');

describe('include 四类解析', () => {
  it('1) 相对当前文件', () => {
    const r = resolveInclude('lib/common.hlsl', from(), ctx);
    expect(r.resolved).toBe(path.join(tmp, 'Proj', 'Assets', 'Shaders', 'lib', 'common.hlsl'));
  });

  it('2) Assets/ 前缀 → 工程根', () => {
    const r = resolveInclude('Assets/Shaders/lib/common.hlsl', from(), ctx);
    expect(r.resolved).toBe(path.join(tmp, 'Proj', 'Assets', 'Shaders', 'lib', 'common.hlsl'));
  });

  it('3a) Packages/<pkg>/ → 本地 Packages 目录', () => {
    const r = resolveInclude('Packages/com.my.pkg/ShaderLibrary/lighting.hlsl', from(), ctx);
    expect(r.resolved).toBe(path.join(tmp, 'Proj', 'Packages', 'com.my.pkg', 'ShaderLibrary', 'lighting.hlsl'));
  });

  it('3b) Packages/<pkg>/ → Library/PackageCache/<pkg>@*', () => {
    const r = resolveInclude(
      'Packages/com.unity.render-pipelines.core/ShaderLibrary/Common.hlsl',
      from(),
      ctx
    );
    expect(r.resolved).toContain(path.join('PackageCache', 'com.unity.render-pipelines.core@14.0.0'));
  });

  it('4) 裸名 → Editor/Data/CGIncludes', () => {
    const r = resolveInclude('UnityCG.cginc', from(), ctx);
    expect(r.resolved).toBe(path.join(tmp, 'Editor', 'Data', 'CGIncludes', 'UnityCG.cginc'));
  });

  it('Windows 反斜杠写法同样可解析', () => {
    const r = resolveInclude('lib\\common.hlsl', from(), ctx);
    expect(r.resolved).toBe(path.join(tmp, 'Proj', 'Assets', 'Shaders', 'lib', 'common.hlsl'));
  });
});

describe('失败的结构化记录', () => {
  it('找不到：reason=not-found，并给出尝试过的候选路径', () => {
    const r = resolveInclude('lib/nope.hlsl', from(), ctx);
    expect(r.resolved).toBeNull();
    expect(r.failure?.reason).toBe('not-found');
    expect(r.failure!.tried.length).toBeGreaterThan(0);
    expect(r.failure!.tried[0]).toContain('nope.hlsl');
  });

  it('无搜索根（非 Unity 工程）：reason=no-search-root', () => {
    const r = resolveInclude('UnityCG.cginc', from(), {
      projectRoot: null,
      cgIncludesDir: null,
      packageCacheDir: null,
    });
    expect(r.resolved).toBeNull();
    expect(r.failure?.reason).toBe('no-search-root');
  });

  it('空规格：reason=empty-spec', () => {
    const r = resolveInclude('   ', from(), ctx);
    expect(r.failure?.reason).toBe('empty-spec');
  });

  it('候选顺序：相对路径优先于内置目录（同名文件不被内置覆盖）', () => {
    const cands = includeCandidates('Common.cginc', from(), ctx);
    const relIdx = cands.findIndex((c) => c.endsWith(path.join('Shaders', 'Common.cginc')));
    const cgIdx = cands.findIndex((c) => c.includes('CGIncludes'));
    expect(relIdx).toBeGreaterThanOrEqual(0);
    if (cgIdx >= 0) expect(relIdx).toBeLessThan(cgIdx);
  });
});
