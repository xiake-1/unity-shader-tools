# Unity Shader Tools（自研）

> 给 Unity 开发者用的 VSCode 插件：为 `.shader` / `.hlsl` 提供转到定义、语义补全、重命名、语法与类型诊断。工作名，可改。

## Features — ShaderLab (`.shader`)

- Syntax highlighting (keywords, properties, passes, semantics)
- Document formatting (idempotent; never rewrites on failure)
- Go to definition / peek definition — cross-file, follows `#include` (Unity CGIncludes and package paths)
- Hover definition info (shader names, properties, HLSL symbols; common Unity built-ins via the bundled CGIncludes index)
- Find all references
- Rename symbol (shader names, two-step prepare/rename)
- Completion — shader names in `Fallback` / `UsePass`, `#include` paths, HLSL members after `.`
- Syntax diagnostics + dead-branch graying for conditional compilation
- DXC type diagnostics — official `dxc` bundled per platform (win32-x64/arm64, linux-x64, darwin-x64/arm64)
- Variant count report with material evidence (command palette)
- Convert language mode command — coexists with Unity for VS Code (VSTU) without touching user settings

## Features — HLSL (`.hlsl` / `.hlslinc` / `.cginc`)

- Syntax highlighting and formatting
- Cross-file go to definition, hover, find all references
- Completion (members after `.`, include paths)

## 功能 — ShaderLab（`.shader`）

- 语法高亮（关键字、属性、Pass、语义）
- 格式化文档（幂等，失败即不改）
- 转到定义 / 速览定义（跨文件，跟随 `#include`，支持 CGIncludes 与 Unity 包路径）
- 悬停查看定义（着色器名、属性、HLSL 符号；常见 Unity 内置函数经随包 CGIncludes 索引）
- 查找所有引用
- 重命名符号（着色器名，两步流程）
- 补全（`Fallback`/`UsePass` 着色器名、`#include` 路径、`.` 后的 HLSL 成员）
- 语法诊断 + 条件编译死分支灰化
- DXC 类型诊断（按平台附带官方 `dxc`，无需安装）
- 变体计数报告（含材质证据，命令面板）
- 转换语言模式命令（与 Unity for VS Code 共存，不改用户设置）

## 功能 — HLSL（`.hlsl` / `.hlslinc` / `.cginc`）

- 语法高亮与格式化
- 跨文件转到定义、悬停、查找所有引用
- 补全（`.` 后成员、include 路径）

**当前状态**：M1～M6 全部完成，backlog 清空；已上架 Marketplace（发布者 `xiake-1`），
四门槛（语法 / 类型 / 格式化 / 变体）全 PASS（详见 [docs/progress/status.md](docs/progress/status.md)）。
M6 的 Unity 包侧已移出范围（ADR 0014），插件端对 Unity 工程只读不写。

## Agent 工作规则（必读）

- 任务开始按序读取：本文件 → [docs/README.md](docs/README.md) → docs/project.md → docs/plan/backlog.md → docs/progress/status.md
- 修改代码后先跑验证（`npm test`，即 vitest 单测；Provider 层用 `npm run test:vscode` 跑 vscode-test 集成），再按规则更新文档
- 任务收尾按实际改动更新：docs/plan/backlog.md、docs/progress/status.md、docs/progress/log.md
- 完整文档规范（唯一事实来源）：[docs/reference/conventions.md](docs/reference/conventions.md)

## 文档

文档索引与阅读顺序：[docs/README.md](docs/README.md)

其中 [docs/分析/](docs/分析/) 是对标产品 Omni Shader Tools for Unity 的逆向分析与可行性判定，
是所有技术选型决策的证据来源，做设计前应先读 09、10 两份。
