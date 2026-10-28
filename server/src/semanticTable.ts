/** HLSL 语义表（自写；规格 feature-hover：不复制对标产品/官方文档文本，设计原则 1）。
 *  查名大小写不敏感（DX 语义本就大小写不敏感：`SV_POSITION` ≡ `SV_Position`）。
 *  补全候选（semanticCandidates）与悬停文档（semanticDescription）共用这一份表。 */

/** 精确词条（canonical 大小写按 Unity 社区惯用写法） */
const EXACT = new Map<string, string>([
  ['sv_position', '系统值语义：裁剪空间位置。顶点着色器输出，光栅化器据此插值（也作像素插值输入）。'],
  ['sv_depth', '系统值语义：手动写像素深度（覆盖光栅化插值结果）。'],
  ['sv_depthgreatequal', '系统值语义：声明像素深度只允许 ≥ 深度缓冲现值，用于 early-Z 优化。'],
  ['sv_depthlessequal', '系统值语义：声明像素深度只允许 ≤ 深度缓冲现值，用于 early-Z 优化。'],
  ['sv_vertexid', '系统值语义：顶点索引（顶点着色器输入，来自 DrawArrays/DrawElements）。'],
  ['sv_instanceid', '系统值语义：实例索引（GPU Instancing / DrawInstanced 时顶点着色器输入）。'],
  ['sv_isfrontface', '系统值语义：当前三角形是否正面（像素着色器输入，剔除阶段判定结果）。'],
  ['sv_coverage', '系统值语义：MSAA 覆盖掩码（像素着色器可读可写）。'],
  ['sv_rendertargetarrayindex', '系统值语义：几何着色器输出，选择渲染目标数组（RT Array）的层。'],
  ['sv_viewportarrayindex', '系统值语义：几何着色器输出，选择视口索引。'],
  ['sv_dispatchthreadid', '系统值语义：计算着色器全局线程 ID（GroupID×GroupSize+GroupThreadID）。'],
  ['sv_groupthreadid', '系统值语义：计算着色器线程组内线程 ID。'],
  ['sv_groupid', '系统值语义：计算着色器线程组 ID。'],
  ['sv_groupindex', '系统值语义：计算着色器线程组内线性索引。'],
  ['sv_outputcontrolpointid', '系统值语义：hull 着色器输出的控制点索引。'],
  ['sv_domainlocation', '系统值语义：曲面片上的域点重心/UV 坐标（hull→domain 传递）。'],
  ['sv_range', '系统值语义：曲面细分参数范围（hull→domain 传递）。'],
  ['sv_tessfactor', '系统值语义：hull 着色器输出的边曲面细分因子。'],
  ['sv_insidetessfactor', '系统值语义：hull 着色器输出的内部曲面细分因子。'],
  ['sv_basevertexindex', '系统值语义：DrawIndexed 的 baseVertex 偏移（顶点着色器输入）。'],
  ['vpos', '系统值语义（DX9 时代遗留）：渲染目标内的像素坐标。'],
  ['vface', '遗留语义（DX9）：正/背面符号（+1 正面 / -1 背面）。'],
  ['position', '约定数据流语义：顶点位置输入（Unity appdata 惯例）。'],
  ['normal', '约定数据流语义：法线（Unity appdata/v2f 惯例）。'],
  ['tangent', '约定数据流语义：切线（Unity appdata_base/appdata_full 惯例，xyzw 含手性符号）。'],
  ['binormal', '约定数据流语义：副切线（惯例命名，非编译器保留字）。'],
  ['bitangent', '约定数据流语义：副切线（惯例命名，非编译器保留字）。'],
  ['fog', '约定数据流语义：雾因子（v2f→frag 传递）。'],
  ['psize', '约定数据流语义：点精灵尺寸。'],
]);

/** 前缀规则（带索引的语义族）：正则 → 描述 */
const PREFIX: Array<[RegExp, string]> = [
  [/^SV_Target\d*$/i, '系统值语义：渲染目标（MRT）颜色输出；`SV_TargetN` 对应第 N 个渲染目标。'],
  [/^SV_ClipDistance\d*$/i, '系统值语义：用户裁剪距离（逐顶点插值），≤0 的一侧被裁剪。'],
  [/^SV_CullDistance\d*$/i, '系统值语义：用户剔除距离（逐顶点插值），≤0 的图元被剔除且不写深度。'],
  [/^TEXCOORD\d*$/i, '约定数据流语义：纹理坐标/通用插值器。Unity 里 v2f→frag 最常用的插值通道（非编译器保留字，名字自定义即可）。'],
  [/^COLOR\d*$/i, '约定数据流语义：顶点颜色通道。'],
  [/^UV\d*$/i, '约定数据流语义：纹理坐标（Unity 惯例命名）。'],
];

/** 表内没有的语义 → 通用说明（规格：不返回 null） */
export const GENERIC_SEMANTIC =
  '用户自定义数据流语义：shader 阶段间传递数据的通道名，非编译器保留字；输入/输出两侧名字一致即可。';

/** 语义名 → 描述；大小写不敏感；未知语义返回 null（调用方用 GENERIC_SEMANTIC 兜底） */
export function semanticDescription(name: string): string | null {
  const exact = EXACT.get(name.toLowerCase());
  if (exact) return exact;
  for (const [re, doc] of PREFIX) if (re.test(name)) return doc;
  return null;
}

export function isSemanticKnown(name: string): boolean {
  return semanticDescription(name) !== null;
}

/** 补全候选（canonical 名 + 常用带索引实例） */
const CANDIDATE_NAMES: string[] = [
  'SV_Position',
  'SV_Target',
  'SV_Target0',
  'SV_Target1',
  'SV_Target2',
  'SV_Target3',
  'SV_Depth',
  'SV_DepthGreaterEqual',
  'SV_DepthLessEqual',
  'SV_VertexID',
  'SV_InstanceID',
  'SV_IsFrontFace',
  'SV_Coverage',
  'SV_ClipDistance',
  'SV_CullDistance',
  'SV_RenderTargetArrayIndex',
  'SV_ViewportArrayIndex',
  'SV_DispatchThreadID',
  'SV_GroupThreadID',
  'SV_GroupID',
  'SV_GroupIndex',
  'SV_OutputControlPointID',
  'SV_DomainLocation',
  'SV_TessFactor',
  'SV_InsideTessFactor',
  'POSITION',
  'NORMAL',
  'TANGENT',
  'BINORMAL',
  'COLOR',
  'COLOR0',
  'COLOR1',
  'TEXCOORD',
  'TEXCOORD0',
  'TEXCOORD1',
  'TEXCOORD2',
  'TEXCOORD3',
  'TEXCOORD4',
  'TEXCOORD5',
  'TEXCOORD6',
  'TEXCOORD7',
  'UV',
  'UV1',
  'UV2',
  'UV3',
  'FOG',
  'PSIZE',
  'VPOS',
  'VFACE',
];

export function semanticCandidates(): Array<{ name: string; doc: string }> {
  return CANDIDATE_NAMES.map((name) => ({ name, doc: semanticDescription(name) ?? GENERIC_SEMANTIC }));
}
