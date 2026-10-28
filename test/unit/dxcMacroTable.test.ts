/** T-052：DXC 宏表（默认表 + 文件 #define + Disabled 只做减法；规格范围 3） */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  DEFAULT_MACROS,
  buildMacroArgs,
  defaultMacroNamesMinus,
  extractFileDefines,
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
  const res = resolveDxc({ env: {}, moduleDir: path.join(REPO_ROOT, 'server', 'src'), platform: 'win32', arch: 'x64' });
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
