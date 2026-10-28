/**
 * T-050：编译单元切分与分块虚拟文档（规格 feature-type-diagnostics 范围 1/2、验收「坐标恒等」）。
 * T-051：一次编译与输出解析（真实附带 dxc，缺失时跳过）。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseShaderLab, parseHlslFile } from '../../server/src/parser';
import { isCgSource } from '../../server/src/tempFiles';
import { assertCoordinateIdentity, buildCompileUnits, wholeFileUnit } from '../../server/src/typeDiagnostics';
import { compileUnit, dxcArgList, dxcBaseArgs, parseDxcOutput, resolveDxc } from '../../server/src/dxcRunner';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const TWO_PASS = `Shader "A/B"
{
  SubShader
  {
    Pass
    {
      HLSLPROGRAM
      float4 vert(float4 p : POSITION) : SV_POSITION { return p; }
      ENDHLSL
    }
    Pass
    {
      HLSLPROGRAM
      float4 vert(float4 p : POSITION) : SV_POSITION { return p * 2; }
      ENDHLSL
    }
  }
}
`;

describe('T-050 编译单元切分', () => {
  it('两个 Pass → 两个单元（分块编译，消除跨 Pass 重复定义误报）', () => {
    const tree = parseShaderLab(TWO_PASS);
    const units = buildCompileUnits(TWO_PASS, tree);
    expect(units.length).toBe(2);
    expect(units[0].startLine).toBeLessThan(units[1].startLine);
  });

  it('坐标恒等：每个虚拟文档与原文等长、换行数相同', () => {
    const tree = parseShaderLab(TWO_PASS);
    for (const u of buildCompileUnits(TWO_PASS, tree)) {
      assertCoordinateIdentity(TWO_PASS, u.virtualText);
    }
  });

  it('单元 A 的虚拟文档只含 A 块内容（B 块被空白化）', () => {
    const tree = parseShaderLab(TWO_PASS);
    const [a, b] = buildCompileUnits(TWO_PASS, tree);
    expect(a.virtualText).toContain('return p;');
    expect(a.virtualText).not.toContain('return p * 2;');
    expect(b.virtualText).toContain('return p * 2;');
    expect(b.virtualText).not.toContain('HLSLPROGRAM');
    expect(b.virtualText).not.toContain('Shader "A/B"');
  });

  it('块内字符在虚拟文档里位置不变（行列 = 原文件行列）', () => {
    const tree = parseShaderLab(TWO_PASS);
    const units = buildCompileUnits(TWO_PASS, tree);
    for (const u of units) {
      const original = TWO_PASS.slice(u.startChar, u.endChar);
      expect(u.virtualText.slice(u.startChar, u.endChar)).toBe(original);
    }
  });

  it('CGPROGRAM / GLSLPROGRAM 块不产单元（CG 语义不在范围）', () => {
    const src = `Shader "C"\n{ SubShader { Pass { CGPROGRAM\nfloat4 f(){return 0;}\nENDCG\n} } }\n`;
    expect(buildCompileUnits(src, parseShaderLab(src))).toEqual([]);
  });

  it('独立 .hlsl → 整文件一个单元，虚拟文档 = 原文', () => {
    const u = wholeFileUnit('float4 f(){return 1;}\n');
    expect(u.wholeFile).toBe(true);
    expect(u.virtualText).toBe('float4 f(){return 1;}\n');
    const tree = parseHlslFile(u.virtualText);
    expect(tree.rootNode.childCount).toBeGreaterThan(0);
  });

  it('`.cginc` 判定为 CG 源（与 .hlsl 同语言 id，只能按扩展名区分）', () => {
    expect(isCgSource('D:/x/UnityCG.cginc')).toBe(true);
    expect(isCgSource('D:/x/Core.hlsl')).toBe(false);
    expect(isCgSource('D:/x/a.hlslinc')).toBe(false);
  });

  it('assertCoordinateIdentity 对长度漂移抛错（防未来改写破坏坐标恒等）', () => {
    expect(() => assertCoordinateIdentity('ab\nc', 'ab\nc ')).toThrow(/长度漂移/);
    expect(() => assertCoordinateIdentity('a\nb', 'a b')).toThrow(/换行数漂移/);
  });
});

describe('T-051 参数与输出解析（纯逻辑）', () => {
  it('库目标 + 不落盘 + 宏/include 注入', () => {
    expect(dxcBaseArgs('win32')).toEqual(['-T', 'lib_6_3', '-Fo', 'NUL']);
    expect(dxcBaseArgs('linux')).toEqual(['-T', 'lib_6_3', '-Fo', '/dev/null']);
    const args = dxcArgList('v.hlsl', ['SHADER_API_D3D11=1', 'A'], ['/inc']);
    expect(args).toEqual(['-T', 'lib_6_3', '-Fo', process.platform === 'win32' ? 'NUL' : '/dev/null', '-DSHADER_API_D3D11=1', '-DA', '-I/inc', 'v.hlsl']);
  });

  const sample = [
    "C:/tmp/v.hlsl:1:21: error: cannot initialize a variable of type 'vector<float, 4>' with an rvalue of type 'vector<float, 3>'",
    'float4 f() { float4 c = float3(1,1,1); }',
    '                    ^   ~~~~~~~~~~~~~',
    "C:/tmp/v.hlsl:2:8: error: redefinition of 'f'",
    'float4 f() { return 0; }',
    '       ^',
    'C:/tmp/v.hlsl:1:8: note: previous definition is here',
    "C:/tmp/v.hlsl:1:22: warning: implicit conversion from 'literal float' to 'int' changes value from 1.5 to 1 [-Wliteral-conversion]",
  ].join('\n');

  it('只取 error 行：2 条，note 与 caret 上下文行忽略', () => {
    const issues = parseDxcOutput(sample);
    const errors = issues.filter((i) => i.severity === 'error');
    expect(errors.length).toBe(2);
    expect(errors[0]).toMatchObject({ line: 1, col: 21, code: null });
    expect(errors[0].message).toContain('vector<float, 3>');
    expect(errors[1]).toMatchObject({ line: 2, col: 8 });
    expect(errors[1].message).toContain("redefinition of 'f'");
  });

  it('前端语义错误无错误码 → code=null（豁免表键以消息模式为主）', () => {
    const issues = parseDxcOutput(sample);
    expect(issues.every((i) => (i.severity === 'error' ? i.code === null : true))).toBe(true);
  });

  it('警告带 `[-Wflag]` → 拆成 code，消息里去掉 flag（实测 clang 风格）', () => {
    const w = parseDxcOutput(sample).find((i) => i.severity === 'warning');
    expect(w).toBeTruthy();
    expect(w?.code).toBe('-Wliteral-conversion');
    expect(w?.message).toBe("implicit conversion from 'literal float' to 'int' changes value from 1.5 to 1");
    expect(w?.line).toBe(1);
    expect(w?.col).toBe(22);
  });

  it('空输出 / 无关文本 → 零 issue', () => {
    expect(parseDxcOutput('')).toEqual([]);
    expect(parseDxcOutput('dxc failed : Required input file argument is missing.')).toEqual([]);
  });
});

describe('T-051 真实编译（附带 dxc，缺失则跳过）', () => {
  const res = resolveDxc({ env: {}, moduleDir: path.join(REPO_ROOT, 'server', 'src'), platform: 'win32', arch: 'x64' });
  const skip = !res.ok;

  it('合法 HLSL 库编译 → status=ok、零 issue', async () => {
    if (skip) return;
    const r = await compileUnit({
      exePath: (res as { path: string }).path,
      virtualText: '#pragma vertex vert\nfloat4 vert(float4 p : POSITION) : SV_POSITION { return p; }\n',
      label: 'ok',
    });
    expect(r.status).toBe('ok');
    expect(r.errorCount).toBe(0);
  });

  it('float4 = float3 → 1 条 error，行列就是原文行列', async () => {
    if (skip) return;
    const text = '\nfloat4 f() { float4 c = float3(1,1,1); return c; }\n';
    const r = await compileUnit({ exePath: (res as { path: string }).path, virtualText: text, label: 'bad' });
    expect(r.status).toBe('errors');
    expect(r.errorCount).toBe(1);
    expect(r.issues[0].line).toBe(2);
    expect(r.issues[0].col).toBe(21);
  });

  it('超时 → status=timeout、零 issue（规格：整块不产诊断）', async () => {
    if (skip) return;
    const big = 'float4 f(){return float4(1,1,1,1);}\n'.repeat(400);
    const r = await compileUnit({ exePath: (res as { path: string }).path, virtualText: big, timeoutMs: 1, label: 'slow' });
    expect(r.status).toBe('timeout');
    expect(r.issues).toEqual([]);
  });

  it('可执行文件不存在 → spawn-failed，不抛错', async () => {
    const r = await compileUnit({ exePath: path.join(REPO_ROOT, 'nope.exe'), virtualText: 'float4 f(){return 0;}' });
    expect(r.status).toBe('spawn-failed');
    expect(r.issues).toEqual([]);
  });
});
