/**
 * T-059 / T-060 / T-061 / T-062 / T-080 / T-081 / T-082 单测
 * （规格 feature-formatting 的验收标准逐条对应）。
 *
 * 门槛（`npm run gate:format`）管真实语料的硬断言；这里管**开关行为与边界**：
 * 外壳缩进、`state_command` 只改缩进不改 token、`ERROR` 区间原样、6 开关、
 * CG/GLSL 区间与 `.cginc` 排版、生成文件 / 大文件 / 抛错注入。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseShaderLab, parseHlslFile, walk } from '../../server/src/parser';
import { formatDocument, formatSkipReason, DEFAULT_MAX_FORMAT_FILE_SIZE } from '../../server/src/formatter';
import { DEFAULT_FORMAT_SWITCHES, resolveIndentOptions } from '../../server/src/formatSettings';

const indent = resolveIndentOptions({ tabSize: 4, insertSpaces: true });
const fmt = (
  file: string,
  text: string,
  switches: Partial<typeof DEFAULT_FORMAT_SWITCHES> = {},
  maxBytes?: number
) =>
  formatDocument({
    file,
    text,
    indent,
    switches: { ...DEFAULT_FORMAT_SWITCHES, ...switches },
    maxBytes,
  });

const tokensOf = (hlsl: boolean, text: string): string[] => {
  const tree = hlsl ? parseHlslFile(text) : parseShaderLab(text);
  const out: string[] = [];
  walk(tree.rootNode, (n) => {
    if (n.children.length === 0) out.push(`${n.type}\u0000${n.text}`);
  });
  return out;
};

const MESSY = [
  'Shader "Demo/Messy"',
  '{',
  '\t\tProperties',
  '    {',
  '_MainTex("Base Opacity", 2D) = "white" {}',
  '_Color("Color", Color) = (1,1,1,1)',
  '    }',
  '      SubShader',
  '   {',
  '  Tags { "RenderType"="Opaque" "Queue"="Geometry" }',
  'Pass',
  '{',
  'Blend   SrcAlpha    OneMinusSrcAlpha',
  '    Stencil {',
  'Ref 255',
  '        Comp Always Pass Replace',
  '   }',
  '        HLSLPROGRAM',
  'float4 vert(float4 p : POSITION) {',
  'float4 o = p;',
  'return o;',
  '}',
  '      ENDHLSL',
  '}',
  '   }',
  '}',
  '',
].join('\n');

describe('T-059 ShaderLab 外壳打印器', () => {
  it('按块深度缩进：Shader / Properties / SubShader / Tags / Pass', () => {
    const r = fmt('D:/x/a.shader', MESSY);
    expect(r.reason).toBeNull();
    const lines = r.text!.split('\n');
    expect(lines[0]).toBe('Shader "Demo/Messy"');
    expect(lines[2]).toBe('    Properties');
    expect(lines[4]).toBe('        _MainTex("Base Opacity", 2D) = "white" {}');
    expect(lines[7]).toBe('    SubShader');
    expect(lines[9]).toBe('        Tags { "RenderType"="Opaque" "Queue"="Geometry" }');
    expect(lines[10]).toBe('        Pass');
    expect(lines[12]).toBe('            Blend SrcAlpha OneMinusSrcAlpha');
  });

  it('`state_command` 只改空白不改 token：`Blend …` 与 `Stencil { … }` 两例（验收点名）', () => {
    const r = fmt('D:/x/a.shader', MESSY);
    const lines = r.text!.split('\n');
    // 2026-10-30 扩范围（范围 7）：token 之间的多余空白压成单空格；token 自身字节与 token 序列不变
    expect(lines[12]).toBe('            Blend SrcAlpha OneMinusSrcAlpha');
    expect(lines[13]).toBe('            Stencil {');
    expect(lines[14]).toBe('                Ref 255');
    expect(lines[15]).toBe('                Comp Always Pass Replace');
    expect(lines[16]).toBe('            }');
    // token 序列逐项相同
    expect(tokensOf(false, r.text!)).toEqual(tokensOf(false, MESSY));
  });

  it('HLSL 内部比 `HLSLPROGRAM` 深一级，函数体再深一级', () => {
    const r = fmt('D:/x/a.shader', MESSY);
    const lines = r.text!.split('\n');
    const i = lines.findIndex((l) => l.trim() === 'HLSLPROGRAM');
    expect(lines[i]).toBe('            HLSLPROGRAM');
    expect(lines[i + 1]).toBe('                float4 vert(float4 p : POSITION) {');
    expect(lines[i + 2]).toBe('                    float4 o = p;');
    expect(lines[i + 4]).toBe('                }');
    expect(lines[i + 5]).toBe('            ENDHLSL');
  });

  it('`CGPROGRAM` 内部排版（范围 2 扩范围；旧「CG 原样」口径作废）', () => {
    const text = [
      'Shader "C"',
      '{',
      'SubShader',
      '{',
      'Pass',
      '{',
      '        CGPROGRAM',
      '   float4   f()  {  return  0;  }',
      '        ENDCG',
      '}',
      '}',
      '}',
      '',
    ].join('\n');
    const r = fmt('D:/x/c.shader', text);
    expect(r.reason).toBeNull();
    const body = r.text!.split('\n').find((l) => l.includes('float4'));
    // 行内空白归一 + 按块深度缩进（`CGPROGRAM` 在 3 级，其内容深一级 = 16 空格）
    expect(body).toBe('                float4 f() { return 0; }');
    // ② token 序列不变是扩范围后的主判据
    expect(tokensOf(false, r.text!)).toEqual(tokensOf(false, text));
    // 范围 14：CG 实际排版字节进健康行
    expect(r.cgBytes).toBeGreaterThan(0);
  });
});

describe('T-061 原样输出区', () => {
  it('`ERROR` 区间字节不变、其余照常缩进（验收点名：未闭合结构）', () => {
    // 实测：`Properties { A {} B = 3 }`（两个属性挤一行）让 grammar 从 `_B` 起吞出 ERROR 节点；
    // 而「`Stencil {` 少闭合括号」这种反而不产 ERROR（grammar 补一个零宽 `}`）—— 夹具按实测选。
    const text = [
      'Shader "E"',
      '{',
      '    Properties { _A("a", 2D) = "white" {} _B(1,2) = 3 }',
      '      SubShader',
      '  {',
      '   Pass { }',
      '  }',
      '  Fallback  "Hidden/E"',
      '}',
    ].join('\n');
    const r = fmt('D:/x/e.shader', text);
    expect(r.reason).toBeNull();
    const before = text.split('\n');
    const after = r.text!.split('\n');
    // ERROR 覆盖的行必须字节不变（行号从树里取，不写死 —— 错误恢复的边界会随语法变）
    const errorRows = new Set<number>();
    walk(parseShaderLab(text).rootNode, (n) => {
      if (n.type !== 'ERROR' && !n.type.startsWith('MISSING')) return;
      for (let row = n.startPosition.row; row <= n.endPosition.row; row++) errorRows.add(row);
    });
    expect(errorRows.size).toBeGreaterThan(0);
    for (const row of errorRows) expect(after[row]).toBe(before[row]);
    expect(r.verbatimLines).toBeGreaterThanOrEqual(errorRows.size);
    // 其余行按块深度缩进
    expect(after[3]).toBe('    SubShader');
    expect(after[5]).toBe('        Pass { }');
    expect(tokensOf(false, r.text!)).toEqual(tokensOf(false, text));
  });

  it('跨行 token（块注释）内部行原样', () => {
    const text = [
      'Shader "B"',
      '{',
      'SubShader',
      '{',
      '/* 说明',
      '     第二行刻意缩进',
      '   */',
      'Fallback "X"',
      '}',
      '}',
    ].join('\n');
    const r = fmt('D:/x/b.shader', text);
    expect(r.reason).toBeNull();
    const after = r.text!.split('\n');
    // 注释**内部**行原样；起始行跟着块缩进（`/*` 之前的空白不属于 token）
    expect(after[5]).toBe('     第二行刻意缩进');
    expect(after[6]).toBe('   */');
    expect(after[4]).toBe('        /* 说明');
    expect(tokensOf(false, r.text!)).toEqual(tokensOf(false, text));
  });

  it('CRLF 与「注释 token 含行尾空格」都不动 token（实测两处回归）', () => {
    const text = 'Shader "R"\r\n{\r\n// 注释带尾空格   \r\nFallback "X"\r\n}\r\n';
    const r = fmt('D:/x/r.shader', text);
    expect(r.reason).toBeNull();
    expect(r.text).toContain('// 注释带尾空格   \r\n');
    expect(tokensOf(false, r.text!)).toEqual(tokensOf(false, text));
  });
});

describe('T-060 HLSL 打印器与开关（旧 4 开关；新增 2 开关见 T-081/T-082 组）', () => {
  const HLSL = ['float4 f(float4 a,', '   float4 b) {', 'return a + b;', '', '', '', '}'].join('\n');

  it('`braceOnNewLine` 两态（验收点名）', () => {
    const text = ['float4 f(float4 a, float4 b) {', '  return a + b;', '}', ''].join('\n');
    const same = fmt('D:/x/f.hlsl', text, { braceOnNewLine: false });
    expect(same.text!.split('\n')[0]).toBe('float4 f(float4 a, float4 b) {');
    const allman = fmt('D:/x/f.hlsl', text, { braceOnNewLine: true });
    expect(allman.text!.split('\n').slice(0, 2)).toEqual(['float4 f(float4 a, float4 b)', '{']);
    // 两态都幂等
    expect(fmt('D:/x/f.hlsl', allman.text!, { braceOnNewLine: true }).text).toBe(allman.text);
  });

  it('`macroMatchIndent` 开/关 → 多行调用续行对齐差异可断言（验收点名）', () => {
    const on = fmt('D:/x/m.hlsl', HLSL, { macroMatchIndent: true });
    const off = fmt('D:/x/m.hlsl', HLSL, { macroMatchIndent: false });
    // `float4 f(` 的左括号在第 8 列 → 续行对齐到第 9 列
    expect(on.text!.split('\n')[1]).toBe('         float4 b) {');
    // 关掉 → 按块深度（顶层 = 0 列）
    expect(off.text!.split('\n')[1]).toBe('float4 b) {');
    expect(on.text).not.toBe(off.text);
  });

  it('`keepBlankLines` 三档（0/1/2）', () => {
    const count = (t: string): number => t.split('\n').filter((l) => l.trim() === '').length;
    expect(count(fmt('D:/x/k.hlsl', HLSL, { keepBlankLines: 0 }).text!)).toBe(0);
    expect(count(fmt('D:/x/k.hlsl', HLSL, { keepBlankLines: 1 }).text!)).toBe(1);
    expect(count(fmt('D:/x/k.hlsl', HLSL, { keepBlankLines: 2 }).text!)).toBe(2);
  });

  it('独立 `.hlsl` 可格式化', () => {
    const r = fmt('D:/x/solo.hlsl', ['void g() {', 'int i = 1;', '}', ''].join('\n'));
    expect(r.reason).toBeNull();
    expect(r.text!.split('\n')[1]).toBe('    int i = 1;');
  });
});

describe('T-081 行内空白四类 + T-082 拆行尾 `}`（范围 7/8）', () => {
  const HL = (lines: string[]): string => lines.join('\n') + '\n';

  it('四类各命中一次（验收点名）', () => {
    const text = HL([
      'float4   mul(float4 a,float4 b) {',
      '    return a . b;',
      '}',
    ]);
    const r = fmt('D:/x/s.hlsl', text);
    expect(r.reason).toBeNull();
    const out = r.text!.split('\n');
    expect(out[0]).toBe('float4 mul(float4 a, float4 b) {'); // ① 连续空白压单空格 + ④ 逗号后补空格
    expect(out[1]).toBe('    return a .b;'); // ③ `.` 与其后继之间的空白删除；`.` **前**的空白不在四类内
    expect(out[2]).toBe('}');
    expect(tokensOf(true, r.text!)).toEqual(tokensOf(true, text));
  });

  it('② 调用左括号前的空格删除：`mul (x)` → `mul(x)`', () => {
    const r = fmt('D:/x/s2.hlsl', HL(['float4 mul (float4 a) {', '    return a;', '}']));
    expect(r.reason).toBeNull();
    expect(r.text!.split('\n')[0]).toBe('float4 mul(float4 a) {');
  });

  it('`intraLineSpacing: false` → 行内空白逐字节不动（开关关 = 扩范围前行为）', () => {
    const text = HL(['float4   mul(float4 a,float4 b) {', '    return a;', '}']);
    const r = fmt('D:/x/s3.hlsl', text, { intraLineSpacing: false, braceSplitting: false });
    expect(r.reason).toBeNull();
    expect(r.text).toBe(text);
  });

  it('拆行尾 `}`：`return v;}` → 两行，且幂等（验收点名）', () => {
    const text = HL(['v2f vert(v2f v)', '{', '    return   v;}', '']);
    const r = fmt('D:/x/b1.hlsl', text);
    expect(r.reason).toBeNull();
    expect(r.text!.split('\n')).toEqual(['v2f vert(v2f v)', '{', '    return v;', '}', '']);
    expect(fmt('D:/x/b1.hlsl', r.text!).text).toBe(r.text);
  });

  it('`};`、一行内 `{…}` 不拆（范围 8 边界；拆了会破幂等）', () => {
    const text = HL(['struct s { int a; };', 'void f(int x) {', '    if (x) { return; }', '}', '']);
    const r = fmt('D:/x/b2.hlsl', text);
    expect(r.reason).toBeNull();
    const out = r.text!.split('\n');
    expect(out[0]).toBe('struct s { int a; };');
    expect(out[2]).toBe('    if (x) { return; }');
    expect(fmt('D:/x/b2.hlsl', r.text!).text).toBe(r.text);
  });

  it('`braceSplitting: false` → 行尾 `}` 不拆', () => {
    const text = HL(['void f() {', '    return;}', '']);
    const r = fmt('D:/x/b3.hlsl', text, { braceSplitting: false, intraLineSpacing: false });
    expect(r.reason).toBeNull();
    expect(r.text!.split('\n')[1]).toBe('    return;}');
  });
});

describe('T-062 幂等、失败即不改与边界', () => {
  const FIXTURES: [string, string][] = [
    ['D:/x/a.shader', MESSY],
    ['D:/x/solo.hlsl', ['struct s { int a;', 'float4 b; };', 'float4 f(s x) { return x.b; }', ''].join('\n')],
  ];

  it('连跑两次字节相同 + token 序列不变（全 fixture）', () => {
    for (const [file, text] of FIXTURES) {
      const first = fmt(file, text);
      expect(first.reason).toBeNull();
      const second = fmt(file, first.text!);
      expect(second.text).toBe(first.text);
      expect(tokensOf(file.endsWith('.hlsl'), first.text!)).toEqual(tokensOf(file.endsWith('.hlsl'), text));
    }
  });

  it('`.cginc` 现在排版（范围 2 扩范围；旧「`.cginc` → null」口径作废）', () => {
    expect(formatSkipReason('D:/x/a.cginc', 'float4 f(){return 0;}\n')).toBeNull();
    const r = fmt('D:/x/a.cginc', 'float4 f(){  return  0;  }\n');
    expect(r.reason).toBeNull();
    // `{` **前**补空格不在四类内 → `f(){` 保持粘连（要改就得先改规格范围 7）
    expect(r.text).toBe('float4 f(){ return 0; }\n');
    expect(r.cgBytes).toBeGreaterThan(0);
  });

  it('`Temp/compiled-x.shader` → null（core §7）', () => {
    expect(formatSkipReason('D:/p/Temp/compiled-x.shader', 'Shader "A"{}\n')).toBe('generated');
  });

  it('超 `maxFormatFileSize` → null + 原因（范围 11）', () => {
    expect(DEFAULT_MAX_FORMAT_FILE_SIZE).toBe(1024 * 1024);
    const big = 'Shader "B"\n{\n' + 'Fallback "X"\n'.repeat(200) + '}';
    expect(fmt('D:/x/big.shader', big, {}, 200).text).toBeNull();
    expect(fmt('D:/x/big.shader', big, {}, 200).reason).toBe('too-large');
  });

  it('注入打印器抛错 → 整次 null、文档零改动（范围 10 + 验收「失败即不改」）', async () => {
    const flag = path.join(os.tmpdir(), `unityshader-format-fail-${process.pid}.flag`);
    fs.writeFileSync(flag, 'x', 'utf8');
    process.env.UNITYSHADER_FORMAT_FAIL_FILE = flag;
    const r = fmt('D:/x/a.shader', MESSY);
    fs.rmSync(flag, { force: true });
    delete process.env.UNITYSHADER_FORMAT_FAIL_FILE;
    expect(r.text).toBeNull();
    expect(r.reason).toMatch(/^error:/);
    // 标志文件删掉后恢复正常（同一进程内可开关）
    expect(fmt('D:/x/a.shader', MESSY).reason).toBeNull();
  });

  it('整文件几乎全是 ERROR（root 无有效结构）→ null', () => {
    const r = fmt('D:/x/broken.shader', 'Shader "Z" { SubShader { Pass { float4 f(\n');
    expect(r.text).toBeNull();
    expect(r.reason).toBe('no-structure');
  });
});
