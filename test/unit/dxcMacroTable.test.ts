/** T-052：DXC 宏表（默认表 + 文件 #define + Disabled 只做减法；规格范围 3） */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  DEFAULT_MACROS,
  buildMacroArgs,
  defaultMacroNamesMinus,
  extractFileDefines,
  parseMacroOverrides,
} from '../../server/src/dxcMacroTable';
import { compileUnit, resolveDxc } from '../../server/src/dxcRunner';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('默认宏表（每条要有来源）', () => {
  it('非空，且每条都带 source 与可追溯证据', () => {
    expect(DEFAULT_MACROS.length).toBeGreaterThan(0);
    for (const m of DEFAULT_MACROS) {
      expect(m.name).toMatch(/^[A-Z_][A-Z0-9_]*$/);
      expect(m.source.length).toBeGreaterThan(10);
    }
  });
  it('hlscc 编译器身份与桌面平台族在表内（内置头按它们选路径）', () => {
    const names = DEFAULT_MACROS.map((m) => m.name);
    expect(names).toContain('UNITY_COMPILER_HLSLCC');
    expect(names).toContain('SHADER_API_D3D11');
    expect(names).toContain('SHADER_TARGET');
  });
});

describe('文件 #define 提取', () => {
  it('对象式宏取到 name/value；函数式宏跳过', () => {
    const text = ['#define A', '#define B 2', '#define C 3 // 尾注释', '#define F(x) ((x)*2)'].join('\n');
    const got = extractFileDefines(text);
    expect(got.map((d) => d.name)).toEqual(['A', 'B', 'C']);
    expect(got.find((d) => d.name === 'B')?.value).toBe('2');
    expect(got.find((d) => d.name === 'C')?.value).toBe('3');
  });
  it('注释行与 `#undef` 不算 define', () => {
    expect(extractFileDefines('// #define NOPE\n#undef A\n')).toEqual([]);
  });
  it('同名只取第一次（预处理语义：后写的会重定义，我们不重复注入）', () => {
    expect(extractFileDefines('#define A 1\n#define A 2\n').length).toBe(1);
  });
});

describe('Disabled 只做减法（ADR 0008 / 0010）', () => {
  it('Disabled 里的默认宏不注入', () => {
    const withAll = buildMacroArgs({ disabled: new Set<string>() });
    const minus = buildMacroArgs({ disabled: new Set(['SHADER_API_D3D11']) });
    expect(withAll.some((a) => a.startsWith('SHADER_API_D3D11'))).toBe(true);
    expect(minus.some((a) => a.startsWith('SHADER_API_D3D11'))).toBe(false);
    expect(minus.length).toBe(withAll.length - 1);
  });
  it('日志缺失（空集合）→ 不减，默认表全量注入', () => {
    expect(defaultMacroNamesMinus(new Set<string>()).length).toBe(DEFAULT_MACROS.length);
  });
  it('文件里显式 #define 的宏不被 Disabled 减掉（用户意图优先）', () => {
    const fileDefines = extractFileDefines('#define SHADER_API_D3D11');
    const args = buildMacroArgs({ disabled: new Set(['SHADER_API_D3D11']), fileDefines });
    expect(args).toContain('SHADER_API_D3D11');
  });
  it('文件 #define 与默认表同名 → 只出现一次（文件优先）', () => {
    const args = buildMacroArgs({ fileDefines: extractFileDefines('#define SHADER_TARGET 30') });
    const hits = args.filter((a) => a.startsWith('SHADER_TARGET'));
    expect(hits).toEqual(['SHADER_TARGET=30']);
  });
});

describe('真实 DXC：宏决定分支是否被编译（附带产物缺失则跳过）', () => {
  // 按当前平台定位（CI fetch --all 后 Linux 上也有 win32 产物，硬编码会 exec PE → crash）
  const res = resolveDxc({ env: {}, moduleDir: path.join(REPO_ROOT, 'server', 'src'), platform: process.platform, arch: process.arch });
  const skip = !res.ok;
  const src = '#if SHADER_API_D3D11\nfloat4 f() { float4 c = float3(1,1,1); return c; }\n#endif\n';

  it('默认宏注入 → `#if SHADER_API_D3D11` 分支内的类型错误能报出', async () => {
    if (skip) return;
    const r = await compileUnit({
      exePath: (res as { path: string }).path,
      virtualText: src,
      macros: buildMacroArgs({ disabled: new Set<string>() }),
      label: 'macro-on',
    });
    expect(r.errorCount).toBe(1);
  });

  it('该宏被 Disabled 减掉 → 分支不编译，零诊断（减法生效）', async () => {
    if (skip) return;
    const r = await compileUnit({
      exePath: (res as { path: string }).path,
      virtualText: src,
      macros: buildMacroArgs({ disabled: new Set(['SHADER_API_D3D11']) }),
      label: 'macro-off',
    });
    expect(r.errorCount).toBe(0);
  });
});

describe('T-078 宏覆盖解析（feature-dxc-macro-overrides 范围 2/3）', () => {
  it('`NAME` → 值 1；`NAME=V` 按首个 `=` 拆分（值可含 `=` `:` `/`）', () => {
    const ov = parseMacroOverrides(['SHADER_API_VULKAN', 'SHADER_TARGET=60', 'A=x=y', 'B=a/b:c']);
    const get = (n: string) => ov.defines.find((d) => d.name === n)?.value;
    expect(get('SHADER_API_VULKAN')).toBe('1');
    expect(get('SHADER_TARGET')).toBe('60');
    expect(get('A')).toBe('x=y');
    expect(get('B')).toBe('a/b:c');
    expect(ov.invalid).toEqual([]);
  });
  it('`-NAME` → 移除集合；`-` 与 `--x` 非法', () => {
    const ov = parseMacroOverrides(['-SHADER_API_D3D11', '-', '--x']);
    expect([...ov.removes]).toEqual(['SHADER_API_D3D11']);
    expect(ov.invalid).toEqual(['-', '--x']);
  });
  it('非法判据逐条拒绝不整表作废：空串、含空白、名字非法、空值、值含空白', () => {
    const ov = parseMacroOverrides(['', 'bad name', '=5', '9X', 'NAME=', 'A=a b', 'GOOD=1']);
    expect(ov.invalid).toEqual(['', 'bad name', '=5', '9X', 'NAME=', 'A=a b']);
    expect(ov.defines.map((d) => d.name)).toEqual(['GOOD']);
  });
  it('重复条目 → 最后一条生效（define 覆盖 define；define 后 -NAME 则只剩移除）', () => {
    const a = parseMacroOverrides(['A=1', 'A=2']);
    expect(a.defines.map((d) => `${d.name}=${d.value}`)).toEqual(['A=2']);
    const b = parseMacroOverrides(['A=1', '-A']);
    expect(b.defines).toEqual([]);
    expect([...b.removes]).toEqual(['A']);
    const c = parseMacroOverrides(['-A', 'A=1']);
    expect([...c.removes]).toEqual([]);
    expect(c.defines.map((d) => `${d.name}=${d.value}`)).toEqual(['A=1']);
  });
});

describe('T-078 buildMacroArgs 应用覆盖（处置顺序＝默认表→Disabled 减法→覆盖）', () => {
  it('空覆盖输出与现状**字节相同**（门槛零漂移的回归钉）', () => {
    const base = buildMacroArgs({ disabled: new Set(['SHADER_API_DESKTOP']) });
    const withEmpty = buildMacroArgs({ disabled: new Set(['SHADER_API_DESKTOP']), overrides: parseMacroOverrides([]) });
    expect(withEmpty).toEqual(base);
  });
  it('`SHADER_API_VULKAN` 进 `-D`；`-SHADER_API_D3D11` 使其不出现', () => {
    const args = buildMacroArgs({ overrides: parseMacroOverrides(['SHADER_API_VULKAN', '-SHADER_API_D3D11']) });
    expect(args).toContain('SHADER_API_VULKAN=1');
    expect(args.some((a) => a.startsWith('SHADER_API_D3D11'))).toBe(false);
  });
  it('显式条目**豁免 Disabled 减法**：默认表名字被 Disabled 减掉后仍可显式加回；对照组缺席', () => {
    const disabled = new Set(['SHADER_API_D3D11']);
    const without = buildMacroArgs({ disabled });
    expect(without.some((a) => a.startsWith('SHADER_API_D3D11'))).toBe(false);
    const withOv = buildMacroArgs({ disabled, overrides: parseMacroOverrides(['SHADER_API_D3D11=1']) });
    expect(withOv).toContain('SHADER_API_D3D11=1');
  });
  it('显式定义 NEVER_DEFINED 名单里的名字（换平台族主场景）→ 进 `-D`；不写则不出现', () => {
    const without = buildMacroArgs({});
    expect(without.some((a) => a.startsWith('SHADER_API_VULKAN'))).toBe(false);
    const withOv = buildMacroArgs({ overrides: parseMacroOverrides(['SHADER_API_VULKAN']) });
    expect(withOv).toContain('SHADER_API_VULKAN=1');
  });
  it('`-NAME` 连块外文件 `#define` 的注入也剔除；同名覆盖改值（最后生效）', () => {
    const fd = extractFileDefines('#define SHADER_TARGET 30\n#define MY_FLAG 7');
    const removed = buildMacroArgs({ fileDefines: fd, overrides: parseMacroOverrides(['-MY_FLAG']) });
    expect(removed.some((a) => a.startsWith('MY_FLAG'))).toBe(false);
    expect(removed).toContain('SHADER_TARGET=30');
    const overridden = buildMacroArgs({ fileDefines: fd, overrides: parseMacroOverrides(['SHADER_TARGET=60']) });
    expect(overridden.filter((a) => a.startsWith('SHADER_TARGET'))).toEqual(['SHADER_TARGET=60']);
  });
});
