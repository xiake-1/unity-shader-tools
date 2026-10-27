# 03 · 语言服务器 `sls` 逆向

> 证据来源：`sls/win/sls.exe` 的 ASCII 字符串提取（约 20 万条）、`sls/win/Rocket.toml`、`sls/win/inc/**`。
> 结论分两类：**【事实】**= 字符串/文件直接可见；**【推断】**= 由命名与结构合理推出。

## 1. 技术栈【事实】

从 cargo 路径与符号名可直接读出依赖及版本：

| 组件 | 版本 | 用途 |
|---|---|---|
| Rust toolchain | `/rustc/29483883eed69d...` | 主语言 |
| **rocket** | 0.5.1 | HTTP 框架（`Rocket.toml`、`Data guard Form<...> failed` 等日志文案） |
| tokio | 1.46.1 | 运行时 |
| hyper / h2 | 0.14.32 / 0.3.27 | 传输层 |
| figment | 0.10.19 | rocket 的配置加载（读 `Rocket.toml`） |
| **tree-sitter** | 0.25.10 | 增量解析 + Query |
| **自研语法** | `tree_sitter_shaderlab` | ShaderLab + HLSL/CG/GLSL 一体 |
| winnow | 0.7.12 | 解析器组合器（推断用于格式化输出 / 预处理器宏展开 / 命令行解析） |
| serde / serde_json / toml / toml_edit | — | DTO 与配置 |
| reqwest + openssl | — | 服务端自己访问 `api.amlovey.com` 做授权校验（离线缓存 + `machine_mismatch` 字符串） |
| smallvec, uuid, yansi, ctrlc | — | 杂项 |

编译者机器：`/Users/rockylai/.cargo/...`（macOS 上交叉编译 Windows 版）。

`Rocket.toml`：

```toml
[default]
workers = 20
[default.limits]
form = "20 MiB"
data-form = "20 MiB"
json = "20 MiB"
string = "2 MiB"
```

→ 20 个 worker 说明它按"并发请求"设计（一次输入可能触发多个 provider 调用）。20MiB 表单上限是为 `/update`、`/format` 传大文件（Unity 编译产物可达数 MB）准备的。

启动参数：`sls <port> <workspace_root> <incremental:true|false>`，启动后向 stdout 打印 rocket 标准行 `Rocket has launched from http://127.0.0.1:<port>`，客户端靠匹配这行触发后续动作。

## 2. 语法：`tree_sitter_shaderlab`【事实】

二进制里保留了完整的 node-type 符号表。这是整个产品最核心的资产。

### 2.1 ShaderLab 层节点

```
unity_shader_declaration        unity_subshader_declaration      unity_category
unity_custom_editor             unity_fallback                   unity_dependency
unity_pass_declaration          _unity_program_block             unity_include_hlsl
unity_include_cg                unity_include_glsl               unity_program_block_cg
unity_program_block_hlsl        unity_program_block_glsl         _unity_program_block_content
unity_property_block_declartion _unity_property_declaration      unity_property_declaration_texture
unity_property_declaration_vectors  unity_property_declaration_number
unity_property_declaration_range    unity_property_type_range
unity_tags_delcartion           unity_tag_item_declaration       unity_pragma_declaration
pragma_assignment               unity_pragma_declaration_link    unity_vector
```

（`declartion` / `delcartion` 这类拼写错误是原样存在的，说明这份 node 表就是他们手写 grammar 的产物。）

### 2.2 固定管线（legacy Pass 状态）节点 —— `uff_*`

```
_unity_fixed_function   uff_color_material  uff_colormask      uff_colormask_value
uff_material            uff_material_item   uff_material_value uff_set_texture
uff_set_texure_item     uff_lod             uff_cull           uff_cull_value
uff_on_off              uff_on_off_value    uff_fog            uff_fog_value
uff_true_false          uff_offset          uff_blend          uff_blend_options
uff_blendop             uff_stencil         uff_stencil_integer
uff_stencil_comparsion  uff_stencil_operation  stencil_op_value
uff_pass                uff_grab_pass       uff_ztest          uff_alpha_test
uff_binding_channels    unity_comparsion_op _uff_placeholder
```

这解释了为什么它能**格式化** `Blend SrcAlpha OneMinusSrcAlpha`、`Stencil{Ref 255 Comp Always Pass Replace}` 这类块，以及为什么 `intellisense.json` 里 `fixed_fucntions` 只有 14 项（`blend/zwrite/ztest/cull/comp/...`）—— 语法已经识别了语义，数据只补文档与取值列表。

### 2.3 HLSL/CG/GLSL 层 + 预处理器

```
function_declaration  function_declaration_parameter  function_declaration_body
function_declaration_parameters_List  parameter_array_declaration  overloading_operators
field_declaration  field_declaration_list  variable_declaration  variable_assignment
parameter_assignment  variable_declaration_array  generic_expression  bitfield_clause
resource_binding  buffer_statement  cbuffer  tbuffer  template_declaration
class_declaration  interface_declaration  struct_declaration  namespace_declaration
enum_declaration  implement_declaration  technique_declaration  technique_pass
macro_call  preproc_call_expression  preproc_def  preproc_function_def  preproc_params
preproc_if / preproc_elif / preproc_else / preproc_endif / preproc_ifdef / preproc_ifndef
preproc_elifdef / preproc_elifndef / preproc_defined / preproc_include / preproc_info
preproc_unary_expression / preproc_binary_expression / preproc_parenthesized_expression
switch_statement / case_statement / if_statement / else_clause / while_statement
do_statement / for_statement / return_statement / break_statement / continue_statement
call_expression / argument_list / subscript_expression / field_expression
assignment_expression / conditional_expression / comma_expression / binary_expression
unary_expression / update_expression / parenthesized_expression / initializer_list
new_expression / attribute_list / attribute / block / number_converter / string_literal
```

**一个 grammar 同时吃 ShaderLab 外壳 + 内嵌 HLSL/CG/GLSL 程序块 + C 预处理器 + D3D technique**。这是它相对同类工具（只做 tmLanguage 高亮，或只做 HLSL）最大的结构性优势：跨层跳转、把 `Properties` 里的 `_MainTex` 和 HLSL 里的采样关联、`#pragma vertex vert` 校验函数存在性，都只需一套 AST。

### 2.4 字段名（tree-sitter named fields）

```
name type typename parameters params parameter body condition consequence alternative
argument arguments field function generic index initializer left right modifer update value
display path
```

→ 说明符号提取、补全、签名帮助都是**基于 Query 抓字段**，而不是手写 AST 遍历。

### 2.5 使用 tree-sitter Query【事实】

二进制含 Query 引擎的完整错误文案：`Invalid node type`、`Invalid field name`、`#eq?/#match?/#any-of?` 的参数校验、`QueryMatch { id, pattern_index, captures }`、`CaptureLimitExceeded`。
→ 补全/hover/symbol 的规则以 `.scm` Query 形式实现（编译进二进制）。

### 2.6 大小写不敏感的 ShaderLab 关键字【事实】

node 表里 `CustomEditorForRenderPipeline` 的 **32 种大小写组合**全部枚举（2^5），`FallBack/Fallback/fallBack/fallback`、`Colormask/colorMask/...` 同理。
→ ShaderLab 关键字大小写不敏感，他们用 grammar 枚举而非外部 scanner 解决。代价是 grammar 体积和 token 数膨胀。**自己实现时应改用 tree-sitter 的 `alias` + 外部 scanner 或 `#eq?` 忽略大小写，别照抄这个做法。**

## 3. 类型系统【事实】

二进制里有一张完整的类型名表：

```
float half fixed double bool int uint dword vec mat  + 1..4 分量 + 1x1..4x4 矩阵
（float1x1 … float4x4、half2、fixed3x4、double4、bool4x4、int2x1、uint4、dword2 …）
GLSL 别名：vec2 vec3 vec4 mat2 mat3 mat4 bvec2.. uvec2.. ivec2..
采样器：sampler2D sampler2Dfloat/int/uint sampler2DArray(int/uint) sampler3D(int/uint)
        samplerCube samplerCubeArray samplerExternalOES sampler_state
修饰符：const static inline extern uniform volatile inout out in inout_modifer
        varying nointerpolation precise shared groupshared discard unroll loop
        packoffset numthreads globallycoherent min16float/min10float/min16int/min12int/min16uint
```

配套的诊断文案（可直接照抄的产品级错误信息）：

```
syntax error - …
MISSING ;
Undefined symbol ''
Include file '' not found
Type mismatch: Cannot convert '' to '…'
Type mismatch: Cannot convert from '…' to '…'
Type mismatch: conditional must be a scalar
swizzle …  （swizzle value / number literal 相关）
```

→ 说明它实现了：向量/矩阵维度检查、swizzle 合法性检查、条件表达式标量检查、include 解析失败、未定义符号、语法错误与缺失 token。**这就是 Pro 版"Error Diagnostics"的实际内容。**

## 4. 标准库与 include 解析【事实】

服务端按程序块类型自动注入内置库：

```
inc/cg.std      ← CGPROGRAM
inc/hlsl.std    ← HLSLPROGRAM
inc/glsl.std    ← GLSLPROGRAM
inc/sm5.std  inc/sm6.std
inc/unity.std  inc/values.std  inc/types.std
```

以及真实 Unity 文件名的解析目标（字符串直接出现）：

```
UnityCG.cginc   UnityPBSLighting.cginc   Lighting.cginc
Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl
.cginc  .hlsl
Library  Temp  ProjectSettings  Logs  PackageCache
```

`.std` 文件的写法极聪明 —— **用 shader 语言本身写 stub 声明 + `///` 文档注释**：

```c
// inc/unity.std
/// Transforms a point from object space to the camera's clip space…
float4 UnityObjectToClipPos(float3 pos) { }

// inc/types.std
struct Texture1D {
    /// Samples a texture.
    float4 Sample(sampler_state S, float Location, int Offset) { }
    …
};

// inc/values.std
/// Current model * view * projection matrix.
float4x4 UNITY_MATRIX_MVP;
```

→ **零额外代码**：内置库走的是和用户代码完全相同的解析/补全/hover 路径。重载靠重复声明（`abs(float)`、`abs(float2)`…`abs(half4)` 各写一遍，`cg.std` 因此 172KB）。

include 解析策略【推断，由字符串与 CHANGELOG 支撑】：
1. 相对当前文件；
2. 同目录 `.cginc/.hlsl`；
3. `Assets/` 开头（CHANGELOG 0.0.27b）；
4. `Packages/<pkg>/...`；
5. `Library/PackageCache/...`（内置包）；
6. 内置 `.std`。

## 5. 数据文件

### `inc/data/keywords.json`
```jsonc
{ "Version": 1,
  "reg":    [210 个语义/寄存器关键字: POSITION, TEXCOORD0.., SV_TARGET, BLENDINDICES…],
  "normal": [360 个: do else for if switch while ifdef endif … ADDRESSU MAXLOD FOG …] }
```

### `inc/data/intellisense.json`
```jsonc
{ "version": 1,
  "fixed_fucntions": [14 项: blend/zwrite/ztest/cull/comp/… 每项带 doc + values[]],
  "tags":            [12 项: RenderType/Queue/DisableBatching/… 带取值与文档],
  "drawers":         [15 项: HideInInspector/NoScaleOffset/Normal/Toggle/Enum/…],
  "directives":      [36 项: #pragma 的 vertex/fragment/geometry/hull/domain/require/multi_compile…],
  "hlsl_require":    [22 项: interpolators10/15/32, integers, …] }
```

→ 这是"语法已识别结构、数据只补语义文档"的分工。补全 `Tags { "Queue" = "|` 时直接查 `tags` 表。

## 6. 与 Unity 工程的桥：`Library/omnishader.json`【事实】

二进制里有字符串 `omnishader.json` + `all_shaders`；Unity 包（见 04）在 `[InitializeOnLoadMethod]` 里写：

```jsonc
{ "workspace_path": "...", "unity_editor_path": "...", "all_shaders": ["Legacy Shaders/Diffuse", …] }
```

用途【推断】：
- `all_shaders` → `Fallback <补全>`（CHANGELOG 1.2.1 明确说该功能需要装 Unity 包）；
- `unity_editor_path` → 推断 Unity 版本 → 决定内置 `.cginc`/包路径与关键字集合（CHANGELOG 0.0.10b 提到"脱离工程时缺少 unity editor version 信息，智能不完整"）。

## 7. 增量解析【事实 + 推断】

- 客户端把 `omnishader.incrementalParsing` 作为第 3 个参数传给 sls；
- 二进制含 `parse_with_options`、`get_changed_ranges`、`reusable_node.h` 等 tree-sitter 增量能力符号；
- `/update` 每次都传**全文**，所以"增量"更可能发生在服务端内部（复用旧 tree 的 changed ranges），而不是靠客户端发 diff。

## 8. 服务端也承担授权校验【事实】

字符串含 `machine_mismatch`、`struct LicenseResult with 3 elements`、`Response succeeded.`、`Response indicated upgrade, but upgrade failed.`，且链接了 reqwest + openssl。
→ 授权校验在**服务端进程内**完成（客户端只传 key 到 api，再把结果交给 sls，或 sls 自己复核）。这解释了为什么"重启 VSCode 才生效"：sls 需要重启才能换授权态。

## 9. 响应 DTO 结构【事实】

二进制里保留了 serde 派生的字段名列表：

```
active_parameter  parameters  signatures  active_signature      ← SignatureHelp
message  severity  node_kind                                    ← Diagnostic
condition_value  if_branch  elseif_branches  else_branch        ← 预处理器分支求值结果
struct LicenseResult with 3 elements
```

完整 API 契约见 [05-api-contract.md](05-api-contract.md)。
