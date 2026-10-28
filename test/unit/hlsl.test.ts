/** T-004：tree-sitter-hlsl 集成 —— 常见 HLSL 构造的解析覆盖（≥20 例）
 *  验收：下列构造解析后无 ERROR 节点；程序块内符号能被提取。
 */
import { describe, it, expect } from 'vitest';
import { parseHlslFile, countErrorNodes, walk } from '../../server/src/parser';
import { SymbolIndex } from '../../server/src/symbolIndex';

const CASES: Array<[string, string]> = [
  ['函数定义', 'float4 Frag(float2 uv : TEXCOORD0) : SV_Target { return 0; }'],
  ['结构体', 'struct a2f { float4 pos : POSITION; float2 uv : TEXCOORD0; };'],
  ['CBUFFER 块', 'CBUFFER_START(UnityPerMaterial) float4 _ST; float _g; CBUFFER_END'],
  ['TEXTURE2D 宏', 'TEXTURE2D(_MainTex);'],
  ['SAMPLER 宏', 'SAMPLER(sampler_MainTex);'],
  ['纹理+采样器成对宏', 'TEXTURE2D_ARGS(_MainTex, sampler_MainTex);'],
  ['UNITY_DECLARE_TEX2D', 'UNITY_DECLARE_TEX2D(_CameraDepthTexture);'],
  ['全局变量', 'float4 _LightColor0;'],
  ['数组声明', 'float weights[4];'],
  ['静态常量', 'static const float kEpsilon = 1e-6;'],
  ['#define 宏', '#define MY_MACRO(a,b) ((a)*(b))'],
  ['#include', '#include "UnityCG.cginc"'],
  ['#pragma', '#pragma multi_compile_fwdbase'],
  ['#ifdef 分支', '#ifdef _A\nfloat x;\n#else\nfloat y;\n#endif'],
  ['for 循环', 'float s=0; for (int i=0;i<4;i++) { s += 1; }'],
  ['if/else', 'if (a > b) { c = 1; } else { c = 2; }'],
  ['三元表达式', 'float m = a > b ? a : b;'],
  ['函数调用与成员访问', 'float d = i.uv.x * _MainTex_TexelSize.y;'],
  ['采样调用', 'half4 c = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, uv);'],
  ['transform 函数', 'o.pos = TransformObjectToHClip(v.pos.xyz);'],
  ['嵌套块与作用域', '{ { int q = 1; q += 1; } }'],
  ['注释', '// line\n/* block\n   multi */\nfloat z;'],
  ['宏定义带续行', '#define LONG(a) \\\n  (a) + 1'],
  ['半精度类型', 'half3 n = normalize(v.normal);'],
  ['矩阵类型', 'float4x4 m = UNITY_MATRIX_M;'],
  ['实例化数组宏', 'UNITY_INSTANCING_BUFFER_START(Props) float4 _c[16]; UNITY_INSTANCING_BUFFER_END(Props)'],
  // grammar fork 补丁回归（2026-10-28，手动测试缺陷：UnityCG.cginc 整文件 ERROR）：
  ['struct 体内裸宏成员', 'struct appdata_base { float4 vertex : POSITION; UNITY_VERTEX_INPUT_INSTANCE_ID };'],
  ['struct 体内宏成员连排', 'struct v2f_img { float4 pos : SV_POSITION; half2 uv : TEXCOORD0; UNITY_VERTEX_INPUT_INSTANCE_ID UNITY_VERTEX_OUTPUT_STEREO };'],
  ['struct 体内宏调用成员', 'struct S { int a; MACRO_NAME(1, x) };'],
  ['跨行宏体内块注释', '#define M(x) \\\n    T g; /* note */ \\\n    g.a = (x);'],
];

describe('tree-sitter-hlsl 常见构造（T-004）', () => {
  it.each(CASES)('%s 解析无 ERROR', (_label, src) => {
    const tree = parseHlslFile(src);
    const errs = countErrorNodes(tree.rootNode);
    expect(errs, `${src}\n  errors=${errs}`).toBe(0);
  });

  it('用例数量满足 ≥20 的验收下限', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(20);
  });

  it('HLSL 符号可提取：函数 / struct 字段 / 宏声明 / #define', () => {
    const src = [
      'CBUFFER_START(UnityPerMaterial) float4 _MainTex_ST; CBUFFER_END',
      'TEXTURE2D(_MainTex); SAMPLER(sampler_MainTex);',
      'struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };',
      'float4 Frag(v2f i) : SV_Target { return 0; }',
      '#define _FEATURE_ON',
    ].join('\n');
    const idx = new SymbolIndex();
    idx.indexFile('mem://x.hlsl', src);
    const names = new Set(idx.names());
    for (const n of ['_MainTex_ST', '_MainTex', 'sampler_MainTex', 'v2f', 'pos', 'uv', 'Frag', '_FEATURE_ON']) {
      expect(names.has(n), n).toBe(true);
    }
    expect(idx.getByName('Frag')?.kind).toBe('function');
    expect(idx.getByName('v2f')?.kind).toBe('struct');
    expect(idx.getByName('_MainTex')?.locations[0].viaMacro).toBe('TEXTURE2D');
  });

  it('struct 体内裸宏成员：struct 与真实字段进索引，宏名不算字段（fork 补丁回归）', () => {
    const src = [
      'struct v2f_img { float4 pos : SV_POSITION; half2 uv : TEXCOORD0; UNITY_VERTEX_INPUT_INSTANCE_ID UNITY_VERTEX_OUTPUT_STEREO };',
      'float4 Frag(v2f_img i) : SV_Target { return i.pos; }',
    ].join('\n');
    const idx = new SymbolIndex();
    idx.indexFile('mem://macro-member.hlsl', src);
    expect(idx.getByName('v2f_img')?.kind).toBe('struct');
    const names = new Set(idx.names());
    expect(names.has('pos'), 'pos').toBe(true);
    expect(names.has('uv'), 'uv').toBe(true);
    // 宏成员不得混入字段（成员补全/改名都会受污染）
    expect(names.has('UNITY_VERTEX_INPUT_INSTANCE_ID'), 'UNITY_VERTEX_INPUT_INSTANCE_ID').toBe(false);
    expect(names.has('UNITY_VERTEX_OUTPUT_STEREO'), 'UNITY_VERTEX_OUTPUT_STEREO').toBe(false);
    // struct 的字段位置带 owner（成员解析依赖）
    const posLoc = idx.getByName('pos')?.locations.find((l) => l.owner === 'v2f_img');
    expect(posLoc, 'pos 应带 owner=v2f_img').toBeDefined();
  });

  it('程序块内 HLSL 符号的坐标与 .shader 文件一致', () => {
    const shader = [
      'Shader "S"',
      '{',
      '  SubShader',
      '  {',
      '    Pass',
      '    {',
      '      HLSLPROGRAM',
      '      float4 _MyVar;',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const idx = new SymbolIndex();
    idx.indexFile('mem://s.shader', shader);
    const info = idx.getByName('_MyVar');
    expect(info).toBeDefined();
    expect(info!.locations[0].start.row).toBe(7); // 0-based：`float4 _MyVar;` 所在行
    expect(info!.locations[0].start.column).toBe(13);
  });

  it('ERROR 节点在 HLSL 层可见（供 M4 语法诊断使用）', () => {
    const tree = parseHlslFile('float4 broken( { ;');
    let seen = false;
    walk(tree.rootNode, (n) => {
      if (n.type === 'ERROR') seen = true;
    });
    expect(seen).toBe(true);
  });
});
