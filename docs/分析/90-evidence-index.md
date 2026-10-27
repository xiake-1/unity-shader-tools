# 90 · 证据索引

所有路径基于安装目录：

```
BASE = C:\Users\24722\.vscode\extensions\amlovey.amlovey-omnishader-vsc-1.2.1
```

分析手段（可复现）：

| 手段 | 说明 |
|---|---|
| 直接读文件 | `package.json`、`languages/*`、`unitypack/**/*.cs`、`sls/*/inc/*`、`Rocket.toml` |
| 美化 bundle | 用 20 行 JS 美化器把 `dist/extension.js`（单行 55KB）拆行后阅读；`watcher.js` 同理 |
| 二进制字符串提取 | Node 读 `sls/win/sls.exe`（31.8MB），按可打印 ASCII 切分，得 ~20 万条字符串，再 grep |
| 运行期探测 | 读 `%LOCALAPPDATA%\OmniShaderTools\*.PORT`；尝试 `GET http://127.0.0.1:<port>/basic`（当时服务未运行，连接失败） |

**未做**：反编译、调试器附加、hook、调用其云端接口、绕过授权。

---

## A. VSCode 端

| 结论 | 证据位置 |
|---|---|
| 扩展元数据、语言注册、5 个配置项、3 个命令 | `BASE/package.json`（138 行） |
| 语言 ID = `UnityShader`，`API_HOST = http://127.0.0.1`，`VERSION = 121`，`NEED_LICENSE_ERROR = "-1000001"`，扩展名白名单 8 项 | `dist/extension.js` 模块 `732` |
| 8 个 Provider 注册 + 触发字符 | 模块 `265` 的 `activate`，搜 `registerCompletionItemProvider` |
| 端口算法 `17892 + Math.floor(3e4*Math.random())`、`.PORT` 清理 | 模块 `265`，搜 `17892` |
| `spawn(sls, [port, workspace, incremental], {cwd, detached:true})` | 模块 `265`，搜 `Launching SLS` |
| stdout 匹配 `"launched from http://127.0.0.1"` → `fork(watcher.js, [port, workspace, disableCompiledShader], {detached:true})` | 模块 `265`，搜 `Launching watcher` |
| `deactivate` 用 `process.kill(pid,"SIGTERM")` | 模块 `265` 末尾 |
| 所有 `fetch*` 端点与 FormData 字段 | 模块 `309`，搜 `getAPI` / `FormData` |
| `osDiagnosticToDiagnostic`：`new Diagnostic(range, e.message, e.severity)` | 模块 `309` |
| 死分支灰化：`fetchBranches` → `setDecorations(UNUSED_CODE_STYLE, ranges)`，`UNUSED_CODE_STYLE = createTextEditorDecorationType({color:"grey"})` | 模块 `265` |
| debounce：诊断 900ms、分支/更新 700ms | 模块 `265`，搜 `setTimeout(async()=>{await` |
| 注释续行与 `/doc` 生成 | 模块 `265` 的 `T()` |
| `shouldLanguageFeatureDisabled`（`.std` / `Temp` / `compiled-` / `generatedfrom`） | 模块 `141` |
| `PathManager` 找 Unity 工程根（`\assets\`、`\packages\`、`\library\packagecache\`） | 模块 `141` |
| 授权：36 位校验、`api.amlovey.com/os/code`、`action:"reg"`、`src:"unityVSCwin121"`、`.lic.os/.lic.state/.lic.error/.mac` | 模块 `351` |
| 通知：`api.amlovey.com/os/notify`、12h 节流（`432e5`）、`.news` | 模块 `351` |
| i18n 8 语言字典 | 模块 `690` |
| watcher 自有逻辑（chokidar + `/update`） | `dist/watcher.js` 模块 `832`（文件末尾），搜 `process.argv` |
| 语法高亮全部规则 | `languages/UnityShader.tmLanguage.json`（391 行） |
| 35 个 snippets | `languages/snippets.json` |

## B. 语言服务器 `sls`

| 结论 | 证据（`sls.exe` 内字符串） |
|---|---|
| rocket 0.5.1 / tokio 1.46.1 / hyper 0.14.32 / tree-sitter 0.25.10 / winnow 0.7.12 / figment 0.10.19 / serde / reqwest / openssl | cargo 路径 `/Users/rockylai/.cargo/registry/src/index.crates.io-*/<crate>-<ver>/...` |
| 语法名 `tree_sitter_shaderlab` | 字符串 `tree_sitter_shaderlab` |
| 完整 node-type 表（`unity_shader_declaration` … `uff_binding_channels`） | 字符串区段（提取后约 237360–237850 行区间） |
| named fields（`name/type/parameters/…`） | 紧随 node 表之后 |
| 使用 tree-sitter Query（`#eq?/#match?/#any-of?`、`QueryMatch`、`CaptureLimitExceeded`） | tree-sitter `query.c` 错误文案 |
| 大小写枚举（`CustomEditorForRenderPipeline` 32 组合） | 同上区段 |
| 类型表（`float1x1…float4x4`、`sampler*`、修饰符） | 单条超长字符串（含 `Type mismatch:` 文案） |
| 诊断文案：`syntax error - `、`MISSING ;`、`Undefined symbol ''`、`Include file '' not found`、`Type mismatch: conditional must be a scalar` | 同上区段 |
| 自动注入的内置库：`inc/cg.std`、`inc/hlsl.std`、`inc/glsl.std`、`inc/sm5.std`、`inc/sm6.std`、`inc/unity.std`、`inc/values.std` | 字符串 `inc/cg.stdinc/hlsl.std…` |
| include 目标：`UnityCG.cginc`、`UnityPBSLighting.cginc`、`Lighting.cginc`、`Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl` | 同一条字符串 |
| 工程目录感知：`Library`、`Temp`、`ProjectSettings`、`Logs`、`PackageCache` | 独立字符串 |
| 读 `omnishader.json` + `all_shaders` | 字符串 `omnishader.jsonall_shaders` |
| 读 `inc/data/intellisense.json`（失败文案 `Failed to parse intellisense file`）、`inc/data/keywords.json`（`reg`/`normal`） | 相邻字符串 |
| Rocket 表单 DTO：`CompleteionParamater`(原文拼写)、`SymbolParameter`、`GoToDefinitionParameter`、`HoverInfoParameter`、`UpdateProgramParameter`、`ReferenceParameter`、`SignatureParameter`、`DiagnosticParameter`、`DocCommentParameter`、`BranchParameter` | `Data guard \`Form < X >\` failed:` 系列文案 |
| 响应字段：`active_parameter parameters signatures active_signature message severity node_kind condition_value if_branch elseif_branches else_branch` | 单条字符串 |
| `struct LicenseResult with 3 elements`、`machine_mismatch`、`Response indicated upgrade, but upgrade failed.` | 独立字符串 |
| 增量解析能力：`parse_with_options`、`get_changed_ranges`、`reusable_node.h` | 符号名 / 源文件名 |
| 服务端源码模块名：`src/language/service.rs`、`src/language/meta.rs` | panic 位置字符串 |
| 配置：`workers = 20`、`form/data-form/json = 20 MiB` | `sls/win/Rocket.toml` |
| 内置库写法 | `sls/win/inc/unity.std`、`values.std`、`types.std`、`cg.std`、`sm5.std`、`sm6.std`、`glsl.std`、`hlsl.std` |
| 数据文件内容 | `sls/win/inc/data/{keywords,intellisense}.json` |

## C. Unity 包

| 结论 | 证据位置 |
|---|---|
| 包元数据（v1.0.2、unity 2021.3） | `unitypack/com.amlovey.omni-shader/package.json` |
| Editor-only asmdef | `com.amlovey.omni-shader.asmdef` |
| 启动钩子：生成元数据 + 解包 + chmod | `Editor/Features/OnLoad.cs` |
| `Library/omnishader.json` 内容与字段 | `Editor/Features/OmniShaderMetaData.cs` |
| `all_shaders` 来源（AssetDatabase ∪ `ShaderUtil.GetAllShaderInfo`） | `Editor/Features/AssetsExploerer.cs:112` |
| `os.dat` 解包：XOR `SEED = 131`、TLV 格式、`VERSION` 比对、目标 `%APPDATA%/OmniShaderTools/.omnishader` | `Editor/Common/Unpacker.cs` |
| CLI 调用：`Process` + `RedirectStandardOutput` + stdout 即结果 | `Editor/Features/Communicator.cs` |
| 子命令 `analysis` / `strip` 及参数顺序 | `Editor/Features/OSStripper.cs:40, 86-92` |
| ShaderGraph 反射：`ShaderGraphImporterEditor.GetGraphData` + `Generator.generatedShader` | `Editor/Features/OSStripper.cs:126-197` |
| 构建裁剪：`IPreprocessShaders`/`IPreprocessComputeShaders`、`callbackOrder => 0`、`data.RemoveAt(i)` | `Editor/Features/BuildSettings.cs:15-75` |
| 规则模型 `Filters/Comparisons/Rule`、关键字需 `IsEnabled` | `Editor/Features/BuildSettings.cs:77-140`、`Editor/Components/BuildPanel.cs:13-62` |
| 配置持久化 `ProjectSettings/OmniShaderBuildSetting.json` | `Editor/Features/BuildSettings.cs:151-189` |
| 窗口入口 `Tools/Omni Shader`、USS/主题 | `Editor/OmniShaderEditorWindow.cs` |
| 状态对象（`ScriptableObject` + `HideAndDontSave`）与字段 | `Editor/OmniShaderEditorState.cs` |
| 五个页签与装配 | `Editor/OmniShaderEditor.cs:40-50, 217-221` |
| 自研 UI 框架体量 | `Editor/Common/UI/Buttons.cs`(62KB)、`Theme.cs`、`Container.cs`、`UIExtensions.cs`、`Editor/Styles/MaterialIcons.ttf` |
| 功能文案（Build/Stripper 说明） | `Documents/Manual.md`、`Editor/Components/BuildPanel.cs:248`、`StripperContent.cs:250` |
| 安装命令把包复制到 `Packages/` | `dist/extension.js` 模块 `265`，搜 `installUnityPack` |

## D. 产品演进史（用于判断功能优先级）

`BASE/CHANGELOG.md`（293 行，0.0.1b → 1.2.1）。几条关键节点：

- `0.0.10b` 加入 include 错误 / 未定义符号 / 语法错误诊断；明确"脱离工程时缺少 Unity editor version 信息"
- `0.0.11b` **诊断改为默认关闭**（说明误报是主要投诉源）
- `0.0.12b` cbuffer/tbuffer；`0.0.15b` 类型不匹配诊断（赋值/二元/条件）
- `0.0.16b` 固定函数大小写不敏感；`0.0.21b` `.editorconfig` 支持
- `0.0.26b` `#include` 路径补全；`0.0.29b` `#pragma` 补全与悬停
- `1.0.5` **增量解析**（默认开）；`1.0.0` namespace/enum
- `1.0.8`/`1.0.9` 文档注释体系（C# XML / javadoc / doxygen 标签）
- `1.1.2`/`1.1.3` **Live Testing**（`//! KEY:VALUE` 灰化死分支，Pro 专属）
- `1.1.6` 启动时不再扫描全部 shader（性能）
- `1.2.1` `Fallback` 补全（依赖 Unity 包）+ `installUnityPack` 命令

## E. 同类/可复用项目（联网检索，2026-10-27）

| 项目 | 许可证 | 用途 |
|---|---|---|
| [tree-sitter-grammars/tree-sitter-hlsl](https://github.com/tree-sitter-grammars/tree-sitter-hlsl) | MIT | HLSL grammar（tree-sitter-cpp 扩展），不含 ShaderLab |
| [antaalt/shader-validator](https://github.com/antaalt/shader-validator) | MIT | Rust shader-language-server + LSP；inactive region、variant 切换、依赖树 |
| [pema99/UnityShaderParser](https://github.com/pema99/UnityShaderParser/) | BSD-3 | C# ShaderLab + HLSL 解析器 + 预处理器 + visitor |
| [KStocky/HLSL-LSP](https://github.com/KStocky/HLSL-LSP) | MIT | 基于 DXC `IDxcIntelliSense` 的 HLSL LSP |
| [shader-ls/vscode-shader](https://github.com/shader-ls/vscode-shader) | MIT | TS 客户端骨架 |
| [SardineFish/UnityShaderSupport](https://github.com/SardineFish/UnityShaderSupport) | MIT | ShaderLab 语言支持（纯 TS） |
| [tgjones/shaders-tmLanguage](https://github.com/tgjones/shaders-tmLanguage) | MIT | HLSL/ShaderLab 着色 grammar |
