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

/** 已知声明宏的自写简述（T-025 文档兜底链：真实源码邻近注释 → 本表 → 空）。
 *  文本自行整理，不复制对标产品或 Unity 文档原文（设计原则 6）。 */
const MACRO_DESCRIPTIONS: Record<string, string> = {
  TEXTURE2D: '声明一个 2D 纹理（如 `TEXTURE2D(_MainTex);`），配合 `SAMPLER`/`SAMPLE_TEXTURE2D` 使用。',
  TEXTURE2D_ARRAY: '声明 2D 纹理数组。',
  TEXTURE2D_CUBE: '声明立方体纹理。',
  TEXTURE2D_MULTISAMPLE: '声明多重采样 2D 纹理（G-buffer 读取）。',
  TEXTURE2D_FLOAT: '声明浮点格式 2D 纹理。',
  TEXTURE2D_INT: '声明整型 2D 纹理。',
  TEXTURE2D_UINT: '声明无符号整型 2D 纹理。',
  TEXTURE2D_ARRAY_FLOAT: '声明浮点格式 2D 纹理数组。',
  TEXTURE3D: '声明 3D 纹理。',
  TEXTURE3D_FLOAT: '声明浮点格式 3D 纹理。',
  TEXTURE1D: '声明 1D 纹理（查找表常用）。',
  TEXTUREBUF: '声明结构化/原始缓冲。',
  SAMPLER: '声明采样器状态（如 `SAMPLER(sampler_MainTex);`）。',
  SAMPLER_CMP: '声明比较采样器（阴影贴常用）。',
  SAMPLER_LINEAR: '声明线性过滤采样器。',
  SAMPLER_MIN_POINT: '声明 min 过滤为点采样的采样器。',
  SAMPLER_MAG_POINT: '声明 mag 过滤为点采样的采样器。',
  SAMPLER_POINT: '声明点过滤采样器。',
  TEXTURE2D_ARGS: '函数参数里成对声明纹理 + 采样器。',
  TEXTURE2D_ARRAY_ARGS: '函数参数里成对声明纹理数组 + 采样器。',
  TEXTURE3D_ARGS: '函数参数里成对声明 3D 纹理 + 采样器。',
  UNITY_DECLARE_TEX2D: '旧式内置管线风格：成对声明 2D 纹理与采样器。',
  UNITY_DECLARE_TEX2D_NOSAMPLER: '旧式：只声明 2D 纹理。',
  UNITY_DECLARE_TEX2DARRAY: '旧式：成对声明 2D 纹理数组与采样器。',
  UNITY_DECLARE_TEX2DARRAY_NOSAMPLER: '旧式：只声明 2D 纹理数组。',
  UNITY_DECLARE_TEXCUBE: '旧式：成对声明立方体纹理与采样器。',
  UNITY_DECLARE_TEXCUBE_NOSAMPLER: '旧式：只声明立方体纹理。',
  UNITY_DECLARE_TEXCUBE_SHADOWS: '旧式：声明立方体阴影纹理组。',
  UNITY_DECLARE_TEX3D: '旧式：成对声明 3D 纹理与采样器。',
  UNITY_DECLARE_TEX3D_FLOAT: '旧式：成对声明浮点 3D 纹理与采样器。',
  DECLARE_TEXTURE: '更旧的纹理 + 采样器成对声明宏。',
  DECLARE_TEXTURE_ARRAY: '更旧的纹理数组成对声明宏。',
  CBUFFER_START: '开始常量缓冲（如 `CBUFFER_START(UnityPerMaterial)`），URP 合批关键。',
  CBUFFER_END: '结束常量缓冲。',
  UNITY_INSTANCING_BUFFER_START: '开始 GPU 实例化属性缓冲。',
  UNITY_INSTANCING_BUFFER_END: '结束 GPU 实例化属性缓冲。',
  DYNAMIC_UNIFORM_BUFFER_START: '开始动态 uniform 缓冲（DX12/Vulkan）。',
  DYNAMIC_UNIFORM_BUFFER_END: '结束动态 uniform 缓冲。',
  MH_START: 'Material HDRP 属性缓冲开始。',
  MH_END: 'Material HDRP 属性缓冲结束。',
  UNITY_DEFINE_INSTANCED_PROP: '在实例化缓冲里定义一个逐实例属性。',
  UNITY_INSTANCING_ARRAY_END: '结束实例化属性数组。',
  // 高频采样/变换宏（真实源码里无邻近注释，补全文档走本表兜底）
  SAMPLE_TEXTURE2D: '对 2D 纹理按 UV 采样：`SAMPLE_TEXTURE2D(tex, samplerTex, uv)`。',
  SAMPLE_TEXTURE2D_LOD: '对 2D 纹理采样并指定 mip 层级。',
  SAMPLE_TEXTURE2D_BIAS: '对 2D 纹理采样并施加 mip 偏移。',
  SAMPLE_TEXTURE2D_ARRAY: '对 2D 纹理数组按 UV + 层号采样。',
  SAMPLE_TEXTURECUBE: '对立方体纹理按方向向量采样。',
  SAMPLE_TEX3D: '对 3D 纹理按坐标采样。',
  LOAD_TEXTURE2D: '不经过采样器直接读取 2D 纹理的纹素。',
  TRANSFORM_TEX: '按 `名称_ST` 对 UV 做 tiling/offset 变换（内置管线风格）。',
};

export function macroDescription(name: string): string | undefined {
  return MACRO_DESCRIPTIONS[name];
}
