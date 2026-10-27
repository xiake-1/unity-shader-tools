# Omni Shader Tools for Unity — 逆向分析报告

> 分析对象：`amlovey.amlovey-omnishader-vsc` **v1.2.1**（displayName: *Omni Shader Tools for Unity*，publisher: `amlovey`）
> 安装位置：`C:\Users\24722\.vscode\extensions\amlovey.amlovey-omnishader-vsc-1.2.1`
> 分析方式：静态阅读已安装文件（打包后的 JS、Unity 包 C# 源码、语法/数据文件）+ 对 `sls.exe` 做字符串提取。**没有反编译二进制、没有 hook 调试、没有调用其云端接口、没有绕过授权。**
> 第二阶段（2026-10-27 12:16 起）：在真实运行的 VSCode 上对 `sls` 服务做了 14 个端点的只读 HTTP 实测，结果见 [07-live-probe-results.md](07-live-probe-results.md)。
> 分析时间：2026-10-27

## 一句话结论

它不是一个"VSCode 插件"，而是**三件套产品**：

```
VSCode 扩展（薄客户端，~56KB JS）
   ↕ 本机 HTTP（FormData POST，随机端口）
原生语言服务器 sls(.exe)（Rust + Rocket + 自研 tree-sitter grammar，31MB）
   ↕ 文件桥 Library/omnishader.json + CLI 子进程
Unity 编辑器包 com.amlovey.omni-shader（C# + 内嵌混淆的 os(.exe) 9.5MB）
```

**能不能自己做？能。** 但"能不能做"和"能不能做到同等水平"是两件事：
- **语法高亮 / 补全 / 悬停 / 代码片段 / 文档符号**：1～2 周可做到可用（有现成积木）。
- **跳转 / 引用 / 重命名 / 格式化**：2～4 周（需要真正的 AST + 跨文件符号表）。
- **诊断（未定义符号、类型不匹配、include 解析、预处理器求值）**：1～3 个月，这是它真正的护城河。
- **Unity 侧（变体剥离、构建规则、ShaderGraph 支持）**：2～6 周，技术难度低、坑多。

详细可行性判断、技术选型对比和分阶段路线见 [06-feasibility-and-roadmap.md](06-feasibility-and-roadmap.md)。

## 文档索引

| 文档 | 内容 |
|---|---|
| [01-architecture.md](01-architecture.md) | 总体架构、进程模型、启动时序、目录与体积 |
| [02-vscode-client.md](02-vscode-client.md) | VSCode 端实现：语言注册、8 个 Provider、进程/端口管理、编辑器增强、授权与 i18n |
| [03-language-server.md](03-language-server.md) | `sls` 服务端逆向：技术栈、tree-sitter 语法节点全表、类型系统、诊断、include 解析、数据文件 |
| [04-unity-package.md](04-unity-package.md) | Unity 包实现：`os.dat` 解包、CLI 通信、Stripper、`IPreprocessShaders` 构建裁剪、ShaderGraph 反射、自研 UIElements 框架 |
| [05-api-contract.md](05-api-contract.md) | 客户端↔服务端完整 API 契约表（可直接照着实现） |
| [06-feasibility-and-roadmap.md](06-feasibility-and-roadmap.md) | 可行性评估、开源积木对比、值得照搬的 6 个设计决策、分阶段路线与工作量 |
| [07-live-probe-results.md](07-live-probe-results.md) | **运行期实测**：真实响应样本、Basic 模式门控矩阵、性能观测、被推翻的推断 |
| [08-pro-feature-gap-analysis.md](08-pro-feature-gap-analysis.md) | **差距分析**：现有分析够/不够什么、每个 Pro 功能的缺口与规模、硬阻塞（观测不到 Pro 行为）、三条实现路线对比 |
| [09-implementation-options.md](09-implementation-options.md) | **实现方案枚举**：解析层/语义来源/宿主形态各自的选项、四个可执行组合与工期、本机事实核实 |
| [10-feature-feasibility.md](10-feature-feasibility.md) | **五项高级功能逐项判定**：F12 / Rename / 语义补全 / 格式化 / 实时诊断，各自的前置条件、工期与坑 |
| [90-evidence-index.md](90-evidence-index.md) | 证据索引：文件路径、关键代码片段、二进制字符串，便于复核 |

## 关键事实速查

| 项 | 值 |
|---|---|
| VSCode 引擎要求 | `^1.95.0` |
| 语言 ID / scope | `UnityShader` / `source.shader.unity` |
| 支持扩展名 | `.shader .cginc .compute .hlsl .raytrace .std .glsl .glslinc` |
| 服务端技术栈 | Rust、rocket 0.5.1、tokio 1.46.1、hyper 0.14.32、**tree-sitter 0.25.10**、winnow 0.7.12、serde、reqwest、openssl |
| 语法名 | `tree_sitter_shaderlab`（自研，ShaderLab + HLSL/CG/GLSL + 预处理器 + technique/pass 一体） |
| 通信协议 | **不是 LSP**，是自定义 `http://127.0.0.1:<随机端口>/<endpoint>` + `FormData` |
| 端口范围 | `17892 + floor(rand*30000)` |
| 服务端二进制体积 | win 31.8MB / mac 16.0MB / linux 19.1MB（三平台全打包，安装后 78.6MB） |
| 内置标准库 | `inc/{cg,hlsl,glsl,sm5,sm6,unity,values,types}.std`（用 shader 语法本身写的 stub + `///` 文档注释） |
| 数据文件 | `inc/data/keywords.json`（reg 210 + normal 360）、`inc/data/intellisense.json`（fixed_fucntions 14 / tags 12 / drawers 15 / directives 36 / hlsl_require 22） |
| 商业分层 | Basic 免费（高亮/基础补全/悬停/片段/文档符号/注释/签名）；Pro/Enterprise（完整补全/格式化/跳转/引用/诊断/重命名/Live Testing） |
| 授权 | 36 位 key，`api.amlovey.com/os/code`，机器指纹 `.mac`(UUID)，本地 `.lic.os`，服务端返回错误码 `-1000001` 表示"需要授权" |
| Unity 包 | `com.amlovey.omni-shader` v1.0.2，`unity: 2021.3`，Editor-only asmdef |
