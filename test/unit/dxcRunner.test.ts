/**
 * T-049：DXC 编译器定位（ADR 0010、规格 feature-type-diagnostics 范围 4 / 异常表）。
 *
 * 依赖附带产物的用例在产物缺失时跳过（`npm run dxc:fetch` 生成，不入库）；
 * 纯逻辑用例（平台矩阵、覆盖路径、缺失降级）不依赖产物，任何机器都跑。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  dxcExecutableName,
  dxcHealthLine,
  dxcPlatformDir,
  dxcSearchRoots,
  parseDxcVersion,
  probeDxc,
  resolveDxc,
} from '../../server/src/dxcRunner';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUNDLED_EXE = path.join(REPO_ROOT, 'third_party', 'dxc', 'win32-x64', 'dxc.exe');
const hasBundled = fs.existsSync(BUNDLED_EXE);

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxcres-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeTree(platformDir: string, files: string[]): string {
  const home = path.join(dir, 'dxc');
  const d = path.join(home, platformDir);
  fs.mkdirSync(d, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(d, f), '');
  return home;
}

describe('平台矩阵（ADR 0010：官方只有 win/linux 产物）', () => {
  it('win32-x64 / win32-arm64 / linux-x64 有产物目录', () => {
    expect(dxcPlatformDir('win32', 'x64')).toBe('win32-x64');
    expect(dxcPlatformDir('win32', 'arm64')).toBe('win32-arm64');
    expect(dxcPlatformDir('linux', 'x64')).toBe('linux-x64');
  });
  it('macOS 与 linux-arm64 → null（无官方产物，未决项）', () => {
    expect(dxcPlatformDir('darwin', 'arm64')).toBeNull();
    expect(dxcPlatformDir('darwin', 'x64')).toBeNull();
    expect(dxcPlatformDir('linux', 'arm64')).toBeNull();
  });
  it('可执行文件名按平台', () => {
    expect(dxcExecutableName('win32')).toBe('dxc.exe');
    expect(dxcExecutableName('linux')).toBe('dxc');
  });
});

describe('unityShader.dxcPath 覆盖', () => {
  it('指向不存在的文件 → missing-configured，detail 带该路径', () => {
    const r = resolveDxc({ configuredPath: path.join(dir, 'nope.exe'), moduleDir: dir });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('missing-configured');
      expect(r.detail).toContain('nope.exe');
    }
  });
  it('存在 → source=configured（优先于附带产物）', () => {
    const p = path.join(dir, 'my-dxc.exe');
    fs.writeFileSync(p, '');
    const r = resolveDxc({ configuredPath: p, moduleDir: REPO_ROOT, platform: 'win32', arch: 'x64' });
    expect(r.ok && r.source).toBe('configured');
  });
  it('空串/空白 = 不覆盖', () => {
    const r = resolveDxc({ configuredPath: '   ', moduleDir: dir, platform: 'win32', arch: 'x64' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing-bundled');
  });
});

describe('附带产物定位', () => {
  it('UNITYSHADER_DXC_HOME 注入的产物树 → source=env', () => {
    const home = fakeTree('win32-x64', ['dxc.exe', 'dxcompiler.dll']);
    const r = resolveDxc({ env: { UNITYSHADER_DXC_HOME: home }, moduleDir: dir, platform: 'win32', arch: 'x64' });
    expect(r.ok && r.source).toBe('env');
    expect(r.ok && path.basename(r.path)).toBe('dxc.exe');
  });
  it('仓库内附带产物可定位（third_party/dxc/win32-x64）', () => {
    const r = resolveDxc({ env: {}, moduleDir: path.join(REPO_ROOT, 'server', 'out'), platform: 'win32', arch: 'x64' });
    if (!hasBundled) {
      expect(r.ok).toBe(false);
      return;
    }
    expect(r.ok && r.source).toBe('bundled');
    expect(r.ok && fs.existsSync(r.path)).toBe(true);
  });
  it('找不到产物 → missing-bundled，detail 指路 dxc:fetch 并列出尝试位置', () => {
    const r = resolveDxc({ env: {}, moduleDir: dir, platform: 'win32', arch: 'x64' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('missing-bundled');
      expect(r.detail).toContain('dxc:fetch');
      expect(r.tried?.length).toBeGreaterThan(0);
    }
  });
  it('exe 在但 dxcompiler.dll 不在同目录 → missing-bundled（实测失败模式）', () => {
    const home = fakeTree('win32-x64', ['dxc.exe']);
    const r = resolveDxc({ env: { UNITYSHADER_DXC_HOME: home }, moduleDir: dir, platform: 'win32', arch: 'x64' });
    // env 命中的是 UNITYSHADER_DXC_HOME 分支；同目录检查在 bundled 分支，故这里用 moduleDir 布局
    expect(r.ok).toBe(true);
    const root = path.join(dir, 'third_party', 'dxc');
    fs.mkdirSync(path.join(root, 'win32-x64'), { recursive: true });
    fs.writeFileSync(path.join(root, 'win32-x64', 'dxc.exe'), '');
    const r2 = resolveDxc({ env: {}, moduleDir: path.join(dir, 'server', 'out'), platform: 'win32', arch: 'x64' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.reason).toBe('missing-bundled');
      expect(r2.detail).toContain('dxcompiler.dll');
    }
  });
  it('macOS → unsupported-platform，提示自备 dxcPath', () => {
    const r = resolveDxc({ env: {}, moduleDir: REPO_ROOT, platform: 'darwin', arch: 'arm64' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('unsupported-platform');
      expect(r.detail).toContain('unityShader.dxcPath');
    }
  });
  it('搜索根从模块目录向上找（仓库内与 vsix 内布局都覆盖）', () => {
    const roots = dxcSearchRoots(path.join(REPO_ROOT, 'server', 'out'));
    expect(roots).toContain(path.join(REPO_ROOT, 'third_party', 'dxc'));
    expect(roots.length).toBeGreaterThan(1);
  });
});

describe('版本探测', () => {
  const realOutput =
    'Version: dxcompiler.dll: 1.9(5512-01b62ad4)(1.9.2609.5) - 1.9.2609.5 (01b62ad47)\n';
  it('解析实测 --version 输出', () => {
    expect(parseDxcVersion(realOutput)).toBe('1.9.2609.5');
  });
  it('无版本串 → null', () => {
    expect(parseDxcVersion('dxc failed : Required input file argument is missing.')).toBeNull();
  });
  it('对附带产物跑 --version 成功（证明 dll 能加载）', async () => {
    if (!hasBundled) return;
    const p = await probeDxc(BUNDLED_EXE);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.version).toMatch(/^1\.9\./);
  });
  it('路径不存在 → spawn-failed，不抛错', async () => {
    const p = await probeDxc(path.join(dir, 'nope.exe'));
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toBe('spawn-failed');
  });
});

describe('健康行', () => {
  it('失败：state=missing reason=…', () => {
    const r = resolveDxc({ env: {}, moduleDir: dir, platform: 'win32', arch: 'x64' });
    expect(dxcHealthLine(r)).toMatch(/^\[dxc\] state=missing reason=missing-bundled/);
  });
  it('成功：state=ok source=… version=…', () => {
    const p = fakeTree('win32-x64', ['dxc.exe', 'dxcompiler.dll']);
    const r = resolveDxc({ env: { UNITYSHADER_DXC_HOME: p }, moduleDir: dir, platform: 'win32', arch: 'x64' });
    expect(dxcHealthLine(r, { ok: true, version: '1.9.2609.5', stdout: '' })).toContain(
      'state=ok source=env'
    );
  });
});
