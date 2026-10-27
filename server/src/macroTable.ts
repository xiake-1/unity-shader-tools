/** 已知 Unity/URP 宏声明表（规格范围 6：约 30～50 条，表驱动）
 *
 * HLSL 里 `TEXTURE2D(_MainTex);`、`CBUFFER_START(UnityPerMaterial)` 这类不是普通声明语法，
 * tree-sitter-hlsl 把它们解析成 call_expression。命中本表即按声明处理（其标识符参数视为被声明的符号）。
 * 表内容取自官方包与内置库的高频宏，随语料扩充。
 */
export type MacroDeclKind =
  | 'texture'
  | 'sampler'
  | 'texture-sampler-pair'
  | 'buffer-start'
  | 'buffer-end';

export const DECLARATION_MACROS: Record<string, MacroDeclKind> = {
  // 纹理声明
  TEXTURE2D: 'texture',
  TEXTURE2D_ARRAY: 'texture',
  TEXTURE2D_CUBE: 'texture',
  TEXTURE2D_MULTISAMPLE: 'texture',
  TEXTURE2D_FLOAT: 'texture',
  TEXTURE2D_INT: 'texture',
  TEXTURE2D_UINT: 'texture',
  TEXTURE2D_ARRAY_FLOAT: 'texture',
  TEXTURE3D: 'texture',
  TEXTURE3D_FLOAT: 'texture',
  TEXTURE1D: 'texture',
  TEXTUREBUF: 'texture',
  // 采样器声明
  SAMPLER: 'sampler',
  SAMPLER_CMP: 'sampler',
  SAMPLER_LINEAR: 'sampler',
  SAMPLER_MIN_POINT: 'sampler',
  SAMPLER_MAG_POINT: 'sampler',
  SAMPLER_POINT: 'sampler',
  // 纹理 + 采样器成对声明（参数里两个标识符都算声明）
  TEXTURE2D_ARGS: 'texture-sampler-pair',
  TEXTURE2D_ARRAY_ARGS: 'texture-sampler-pair',
  TEXTURE3D_ARGS: 'texture-sampler-pair',
  UNITY_DECLARE_TEX2D: 'texture-sampler-pair',
  UNITY_DECLARE_TEX2D_NOSAMPLER: 'texture',
  UNITY_DECLARE_TEX2DARRAY: 'texture-sampler-pair',
  UNITY_DECLARE_TEX2DARRAY_NOSAMPLER: 'texture',
  UNITY_DECLARE_TEXCUBE: 'texture-sampler-pair',
  UNITY_DECLARE_TEXCUBE_NOSAMPLER: 'texture',
  UNITY_DECLARE_TEXCUBE_SHADOWS: 'texture-sampler-pair',
  UNITY_DECLARE_TEX3D: 'texture-sampler-pair',
  UNITY_DECLARE_TEX3D_FLOAT: 'texture-sampler-pair',
  DECLARE_TEXTURE: 'texture-sampler-pair',
  DECLARE_TEXTURE_ARRAY: 'texture-sampler-pair',
  // cbuffer / 常量缓冲块
  CBUFFER_START: 'buffer-start',
  CBUFFER_END: 'buffer-end',
  UNITY_INSTANCING_BUFFER_START: 'buffer-start',
  UNITY_INSTANCING_BUFFER_END: 'buffer-end',
  DYNAMIC_UNIFORM_BUFFER_START: 'buffer-start',
  DYNAMIC_UNIFORM_BUFFER_END: 'buffer-end',
  MH_START: 'buffer-start',
  MH_END: 'buffer-end',
  // 其它常见声明型宏
  UNITY_DEFINE_INSTANCED_PROP: 'texture-sampler-pair',
  UNITY_INSTANCING_ARRAY_END: 'buffer-end',
};

export function macroKind(name: string): MacroDeclKind | undefined {
  return DECLARATION_MACROS[name];
}

export function isDeclarationMacro(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(DECLARATION_MACROS, name);
}
