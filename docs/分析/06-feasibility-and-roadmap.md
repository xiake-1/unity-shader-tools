# 06 · 能不能自己做？可行性评估与路线

## 0. 直接回答

**能做。** 而且不需要一开始就做它那种 31MB 的 Rust 引擎。

把它的功能按"依赖什么能力"拆开，难度是分层的：

| 层级 | 功能 | 依赖的核心能力 | 单人工作量 | 有现成积木吗 |
|---|---|---|---|---|
| L0 | 高亮、括号、注释、折叠、snippets | 无（正则语法） | **1～3 天** | 有（可直接抄结构） |
| L1 | 文档符号、基础补全、悬停、签名 | 单文件 AST + 关键字/内建库 | **1～2 周** | 有（tree-sitter-hlsl / 自写 grammar） |
| L2 | 跳转、引用、重命名、格式化 | 跨文件符号表 + 预处理器 + include 解析 + CST 打印 | **2～4 周** | 部分（格式化基本得自己写） |
| L3 | 诊断：未定义符号、类型/维度不匹配、swizzle、include 失败 | 类型系统 + 宏求值 + 工程索引 | **1～3 个月** | 几乎没有（这是它的护城河） |
| L4 | Unity 侧：变体裁剪、构建规则、ShaderGraph、元数据桥 | Unity Editor API | **2～6 周** | 有（官方 API 足够） |
| L5 | 商业：授权、试用、多 IDE 复用 | 工程 | 2～4 周 | — |

**L0～L2 一个周末到两周就能出可用版本；L3 才是它真正卖钱的地方。**

---

## 1. 值得直接照搬的 6 个设计决策

这 6 条是它架构里"聪明且低成本"的部分，复刻成本极低、收益明确：

1. **`.std` 内置库用 shader 语言本身写**（`float4 UnityObjectToClipPos(float3 pos) { }` + `///` 文档注释）。
   → 内置函数与用户函数走同一条解析/补全/hover 路径，**零额外代码**。重载靠重复声明。
   → 抄这个，你的内建库就从"一张 JSON 表"升级成"能签名帮助、能类型检查"。

2. **语法已识别语义，数据文件只补文档与取值**。`intellisense.json` 只有 14 个 fixed function、12 个 tag、15 个 drawer、36 个 `#pragma` 指令。
   → 数据文件小、可维护、易翻译。

3. **`Library/omnishader.json` 做 IDE↔Unity 桥**（一个 JSON 文件，`[InitializeOnLoadMethod]` 写）。
   → 比 socket/IPC 简单一个数量级，还能被 CI/离线场景复用。

4. **同一引擎两种宿主**：IDE 侧常驻 HTTP 服务，Unity 侧一次性 CLI（`os analysis` / `os strip`）。
   → 只要核心是"无状态纯函数库"，加个 CLI 入口就是白送的能力。

5. **死分支灰化 = 服务端求值 + 客户端 decoration**（`/branch` + `setDecorations`）。
   → 不需要 semantic tokens，不需要改语法，几十行就有"高级感"。

6. **对 `Temp/compiled-*`、`Temp/generatedFrom*` 关闭语言服务**（一行 `shouldLanguageFeatureDisabled`）。
   → Unity 用户一定会遇到，不做就会被"打开生成代码后卡死"的 issue 淹没。

另外两条**反面**经验（别抄）：
- 用 grammar 枚举 32 种大小写组合来支持 ShaderLab 大小写不敏感 → 应该用外部 scanner / `#eq?` 忽略大小写。
- 三平台二进制全塞一个 VSIX（78MB）→ 用 `targetPlatform` 或首次运行下载。

---

## 2. 三条可选技术路线

### 路线 A：纯 TypeScript，无解析引擎（最快上线）

```
VSCode 扩展（TS）
 ├─ tmLanguage 高亮 + language-configuration + snippets
 ├─ 正则/手写 tokenizer 做 symbol / completion / hover
 └─ 内置库用 JSON 表（照抄它的 intellisense.json 结构，内容自己整理）
```

- 工期：**3～10 天**出 L0+L1。
- 上限：跳转/引用只能靠 workspace symbol（正则索引），诊断只能做"括号匹配 + 明显拼写"。
- 适合：先解决"高亮 + 补全 Unity 内建 + 常用片段"，验证需求。
- 同类先例：[SardineFish/UnityShaderSupport](https://github.com/SardineFish/UnityShaderSupport)（ShaderLab 语法 + 补全 + 格式化，纯 TS）。

### 路线 B：tree-sitter + 独立语言服务器（推荐，与 Omni Shader 同构）

```
tree-sitter grammar
 ├─ tree-sitter-hlsl（现成，MIT，基于 tree-sitter-cpp 扩展）
 └─ 自写 shaderlab grammar（unity_shader/subshader/pass/properties/tags/uff_* + 预处理器）
        ↓
语言服务器（Rust 或 Go 或 TS）
 ├─ 标准 LSP（stdio）：didOpen/didChange(documentSymbol…formatting)
 ├─ Query(.scm) 驱动 symbol/hover/completion
 ├─ 预处理器：#define/#if 求值 + include 解析（Assets/Packages/Library/PackageCache）
 ├─ 类型系统：float/half/fixed ×N ×M + swizzle 检查
 └─ 内置库 .std（用语言本身写）
        ↓
VSCode 客户端（vscode-languageclient，几乎零自研代码）
Unity 包（写 omnishader.json + IPreprocessShaders + 调 CLI）
```

- 工期：L0+L1 **2～3 周**；L2 **+3～4 周**；L3 **+1～3 月**。
- 优点：增量解析免费拿到；性能可控；同一 grammar 可给 Neovim/Zed 用；LSP 白拿其它编辑器。
- 风险：tree-sitter 的 ShaderLab grammar 要自己写（约 500～900 行 `grammar.js`），调试曲线陡（`tree-sitter test`、`ERROR`/`MISSING` 定位）。
- 现成件：[tree-sitter-grammars/tree-sitter-hlsl](https://github.com/tree-sitter-grammars/tree-sitter-hlsl)（MIT，140+ commits，成熟度尚可）。**注意它是 HLSL，不含 ShaderLab 外壳**，`Shader{SubShader{Pass{}}}` 这层必须自己加。

### 路线 C：复用现成 shader 语言服务器（最省力，但天花板低）

| 项目 | 语言/协议 | 覆盖 | 可借鉴点 |
|---|---|---|---|
| [antaalt/shader-validator](https://github.com/antaalt/shader-validator) + shader-language-server | Rust + **标准 LSP** | HLSL/GLSL/WGSL | **inactive region 灰化**、variant entry point 切换、include 依赖树 —— 与 Omni Shader 的 Live Testing 高度同构，且开源 |
| [shader-ls/vscode-shader](https://github.com/shader-ls/vscode-shader) | TS 客户端 + 外部 server | shaderlab/hlsl/glsl | 客户端骨架 |
| [KStocky/HLSL-LSP](https://github.com/KStocky/HLSL-LSP) | C++ + LSP，包 **DXC `IDxcIntelliSense`** | 现代 HLSL/SM6.6 | **用 DXC 做真·HLSL 语义**（诊断/补全/hover/跳转），比自己实现类型系统省力得多 |
| [pema99/UnityShaderParser](https://github.com/pema99/UnityShaderParser/) | C#（BSD-3） | **ShaderLab + HLSL + 预处理器 + visitor** | 唯一较完整的开源 ShaderLab 解析器；若走 C# 路线（Unity 内工具 / VS 扩展）直接用它 |
| [tgjones/shaders-tmLanguage](https://github.com/tgjones/shaders-tmLanguage) | tmLanguage | HLSL/ShaderLab 着色 | 高亮起点 |

- 组合建议：**路线 B 做 ShaderLab 外壳 + 预处理器 + Unity 语义，HLSL 内部语义外包给 DXC IntelliSense**（Omni Shader 是自己全做了类型系统；用 DXC 是另一条更"正确"但受限于工具链的路）。

---

## 3. 分阶段落地路线（建议）

### M0 · 一周内：能装能用的"高亮 + 补全"包
- [ ] `package.json`：语言注册（`.shader/.cginc/.hlsl/.hlsli/.compute/.raytrace`）、tmLanguage、snippets、`language-configuration`（含 `#region` 折叠）
- [ ] 补全：Unity 内建变量/函数（`unity.std`/`values.std` 等价物）+ `Tags`/`Property drawer`/`#pragma` 取值表（照 `intellisense.json` 结构自建）
- [ ] `shouldLanguageFeatureDisabled`：跳过 `Temp/compiled-*`、`Temp/generatedFrom*`
- [ ] snippets：Shader/SubShader/Pass/Blend/Tags/Property/include
- **验收**：打开一个 URP shader，高亮正确、`_MainTex`/`UnityObjectToClipPos` 能补全带文档、不卡。

### M1 · 2～3 周：真 AST + 文档符号 + 悬停 + 签名
- [ ] tree-sitter grammar（ShaderLab 外壳 + 程序块 + 预处理器），或先用 tree-sitter-hlsl + 外壳预处理
- [ ] `.std` 内置库（用语言本身写，先覆盖 `UnityObjectToClipPos`、`UnityPerMaterial/Frame/Draw`、URP `Core.hlsl` 常用函数）
- [ ] `documentSymbol`（Shader→SubShader→Pass→Function 层级）、`hover`、`signatureHelp`
- [ ] `///` / `//*` 文档骨架自动生成（纯客户端 + 一个服务端端点）
- **验收**：Outline 面板显示 shader 结构；悬停内建函数显示官方文档文本；输入 `///` 自动展开模板。

### M2 · 3～4 周：跨文件 + 格式化
- [ ] 工程索引（`Assets/`、`Packages/`、`Library/PackageCache/`）+ include 解析
- [ ] `definition` / `reference` / `rename`
- [ ] `formatting`（CST → 打印器：`braceOnNewLine`、`tabSize`、`insertSpaces`、宏缩进）
- [ ] 文件监听（`workspace/didChangeWatchedFiles`，不必像它那样另起进程）
- **验收**：从 `.shader` 跳到 `.hlsl` 里的函数；改一个变量名，跨文件引用全改；格式化后 diff 不超过 5% 意外改动。

### M3 · 1～3 月：诊断（真正的差异化）
- [ ] 预处理器：`#define/#undef/#if/#ifdef/#elif/#else` 求值，`defined()`，宏函数
- [ ] Unity 关键字注入：`SHADER_API_*`、`UNITY_VERSION`、`multi_compile`/`shader_feature` 声明的关键字、`#pragma require`
- [ ] 类型系统：向量/矩阵维度、swizzle、赋值与二元运算维度匹配、条件必须标量
- [ ] 诊断：`Undefined symbol`、`Include file not found`、`MISSING ;`、`Type mismatch`
- [ ] 死分支灰化（`//! KEY:VALUE` 或读 Unity 当前关键字集）
- **验收**：故意写错 `float4 x = float3(1,2,3);`、`if (someFloat3) {}`、`#include "Nope.hlsl"` 都能报错且不误报；URP 官方 shader 全量扫描误报 < 1%。

### M4 · 2～6 周：Unity 包
- [ ] `Library/<tool>.json` 元数据（workspace/editor path/all shaders）
- [ ] `IPreprocessShaders` + `IPreprocessComputeShaders` 规则裁剪，配置存 `ProjectSettings/`
- [ ] 变体分析报表（**这里可以做得比它好**：用 `ShaderUtil.GetShaderData`/`GetShaderVariantCount` 做变体计数、按材质统计引用、按 pass 统计关键字组合）
- [ ] Stripper（关键字/pass 级代码删除）—— 依赖 M2/M3 的 AST
- [ ] ShaderGraph：优先用公开导入器 API，反射只作兜底
- **验收**：构建一次，日志显示裁剪掉 N 个变体、构建时间下降；strip 出的 shader 能在 Unity 里正常编译。

---

## 4. 风险与成本清单

| 风险 | 说明 | 缓解 |
|---|---|---|
| **ShaderLab 语法没有现成 grammar** | tree-sitter 生态只有 HLSL/GLSL，ShaderLab 外壳得自己写 | 先做"外壳用轻量解析 + 程序块交给 tree-sitter-hlsl"的混合方案 |
| **Unity 版本差异** | 内置 `.cginc` 路径、包名（`com.unity.render-pipelines.universal`）、`#pragma require` 取值随版本变 | 用 `Library/PackageCache` 实测解析 + 按 editor 版本分档；Omni Shader 也是这么做的（读 `unity_editor_path`） |
| **内置库文档版权** | `cg.std`/`hlsl.std` 里的文档文本源自 MS/Unity 文档 | 自己整理、注明来源；不要复制它的 `.std` 文件 |
| **VSIX 体积** | 三平台二进制 → 78MB，Marketplace 有大小与审核摩擦 | `targetPlatform` 分包 / 首次运行下载 / WASM 单文件 |
| **误报是 shader 工具的生死线** | shader 里宏满天飞，任何"未定义符号"误报都会让用户关掉诊断 | 默认关闭诊断（它也是默认 `false`）+ 分级 severity + 白名单 |
| **Unity 侧反射 ShaderGraph** | 版本一变就崩 | 加特性检测、失败降级为"仅支持 .shader" |
| **性能** | 大工程（数千 shader）索引；实测它自己也有这个问题：**每次补全回传 98 KB 未过滤的全局符号表**（936～953 项），`mul` 签名帮助回传 36 KB / 30+ 重载 | 服务端按前缀过滤 + `isIncomplete` 分页 + `completionItem/resolve` 二段拉取；懒索引（只索引当前文件的 include 闭包）+ 后台增量 |

---

## 5. 合规提醒

- 本报告基于**已安装文件的静态阅读**（打包 JS、C# 源码、语法/数据文件、二进制字符串）。`sls.exe` / `os.dat` 是闭源商业资产，**不要反编译、不要提取其中的 `.std` 文档文本或 grammar 产物**用于自己的产品。
- 它的授权机制（`.lic.os`、`-1000001` 哨兵、机器指纹）属于技术保护措施，研究思路可以，**绕过不可**。
- 可自由使用的是第 2/3 节列出的 MIT / BSD 开源项目（各自遵守其许可证）。
