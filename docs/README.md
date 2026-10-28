---
status: active
updated: 2026-10-28
---
# 文档索引

阅读顺序：新读者按 ①→⑥；agent 冷启动按根 README 的四件套。

| 区 | 文件 | 职责 |
|---|---|---|
| ① 概览 | [project.md](project.md) | 目标、范围、技术栈、设计原则 |
| ② 计划 | [plan/roadmap.md](plan/roadmap.md) | 阶段、里程碑、验收标准 |
|    | [plan/backlog.md](plan/backlog.md) | 未完成任务唯一权威 |
|    | [plan/sprint-04.md](plan/sprint-04.md) | 已完成迭代（M4 语法诊断与死分支灰化） |
|    | [plan/sprint-03.md](plan/sprint-03.md) | 已完成迭代（M3 补全与引用） |
|    | [plan/sprint-02.md](plan/sprint-02.md) | 已完成迭代（M2 转到定义） |
|    | [plan/sprint-01.md](plan/sprint-01.md) | 已完成迭代（M1 地基） |
| ③ 规格 | [specs/](specs/) | 功能规格（见目录内列表） |
| ④ 进度 | [progress/status.md](progress/status.md) | 当前状态总览 |
|    | [progress/log.md](progress/log.md) | 事件与已完成任务历史 |
| ⑤ 参考 | [reference/conventions.md](reference/conventions.md) | 文档规范唯一事实来源 |
| ⑥ 分析 | [分析/README.md](分析/README.md) | 对标产品逆向分析与可行性判定（决策证据） |

## 规格清单

| 规格 | 对应模块 | 状态 |
|---|---|---|
| [specs/feature-language-server-core.md](specs/feature-language-server-core.md) | `src/server/`、`src/grammar/` | active |
| [specs/feature-go-to-definition.md](specs/feature-go-to-definition.md) | `src/server/`（definition + 作用域解析）、`src/client/`（能力声明） | active |
| [specs/feature-completion.md](specs/feature-completion.md) | `server/src/`（completion + 候选组装）、`client/src/`（能力声明） | active |
| [specs/feature-hover.md](specs/feature-hover.md) | `server/src/`（hover + 自写语义表）、`client/src/`（能力声明） | active |
| [specs/feature-rename.md](specs/feature-rename.md) | `server/src/`（references + rename + 联动改名）、`client/src/`（能力声明） | active |
| [specs/feature-syntax-diagnostics.md](specs/feature-syntax-diagnostics.md) | `server/src/`（diagnostics + errorExemption）、`client/src/`（配置项） | active |
| [specs/feature-dead-branch-dimming.md](specs/feature-dead-branch-dimming.md) | `server/src/`（unityKeywordSource + preprocessorEval + inactiveRegions）、`client/src/`（装饰 + 命令） | active |

## ADR 清单

| ADR | 决策 | supersedes |
|---|---|---|
| [0001-treesitter-parsing-layer.md](decisions/0001-treesitter-parsing-layer.md) | 解析层用 tree-sitter（自写 shaderlab grammar + 现成 tree-sitter-hlsl） | — |
| [0002-standard-lsp-host.md](decisions/0002-standard-lsp-host.md) | 宿主走标准 LSP（stdio）+ TS 客户端与独立 TS server | — |
| [0003-index-real-source-symbols.md](decisions/0003-index-real-source-symbols.md) | 内置/包内符号索引真实源码，不手写 stub 库 | — |
| [0004-dxc-type-diagnostics.md](decisions/0004-dxc-type-diagnostics.md) | HLSL 类型诊断外包 DXC，不自研类型系统 | — |
| [0005-grammar-prebuild-distribution.md](decisions/0005-grammar-prebuild-distribution.md) | grammar 与 tree-sitter 运行时以 N-API prebuilds 随单一 VSIX 附带（不安装期编译、不走 WASM） | — |
| [0006-language-id-vstu-coexistence.md](decisions/0006-language-id-vstu-coexistence.md) | 主 id 保持 `unityshader`/`hlsl`；与 VSTU 的 `UnityShader` 靠 documentSelector + 运行时自愈 + 修复命令共存 | — |
| [0007-fork-tree-sitter-hlsl-workspace.md](decisions/0007-fork-tree-sitter-hlsl-workspace.md) | fork tree-sitter-hlsl 为 workspace 包 `hlsl/`，struct 裸宏成员与跨行宏块注释补丁本地维护 | — |
| [0008-dead-branch-dimming-editor-log.md](decisions/0008-dead-branch-dimming-editor-log.md) | 死分支灰化：关键字取 Unity `Editor.log` 的 `Disabled keywords:`，求值在 server、呈现走 LSP 扩展通知 + 客户端装饰 | — |
| [0009-syntax-diagnostics-error-exemption.md](decisions/0009-syntax-diagnostics-error-exemption.md) | 语法诊断误报控制：grammar 继续修 + ERROR 模式豁免表 + 官方语料零误报门槛测试 | — |

（无取代关系。ADR 0005 结清 0001 留下的「native/WASM + 打包工具」未决项；ADR 0006 把 log 22:00 的语言 id 拆分登记为决策；ADR 0007 调整 0001 中「现成 tree-sitter-hlsl」的含义（现为本地 fork workspace 包），并要求 0005 的 prebuild 从 fork 出产物。ADR 0008 界定 0002 的「不造私有协议」＝不脱离 LSP 通道（`$/…` 扩展通知允许），并把「M6 桥是否取代 Editor.log 作关键字源」登记为未决项；ADR 0009 承接 0004 与 0007 的后果，只补「误报怎么控」。**更正（2026-10-28）**：ADR 0007 后果段写的「`parser.c`（约 20 MB）随仓库提交」与仓库实际不符——`.gitignore` 忽略 `grammar/src/parser.c` 与 `hlsl/src/parser.c`，两者均为生成物、由 `npm run grammar:generate` / `hlsl:generate` 重建（做法见 `hlsl/README.md`「重新生成 / 编译」）；MSVC 链接中间产物（`*.obj`/`*.lib`/`*.exp`）同样不入库。按规范 §3 旧 ADR 不改写，以本条为准。将来若支持 vscode.dev，需 WASM + 非 stdio 宿主，届时另立 ADR 取代 0005 与 0002 的相关部分。）

## 分析文档（`分析/`，只读证据，不参与状态流转）

| 文件 | 内容 |
|---|---|
| [分析/README.md](分析/README.md) | 索引 + 关键事实速查 |
| [分析/01-architecture.md](分析/01-architecture.md) | 对标产品总体架构、进程模型、启动时序 |
| [分析/02-vscode-client.md](分析/02-vscode-client.md) | 客户端 8 个 Provider、端口管理、授权与 i18n |
| [分析/03-language-server.md](分析/03-language-server.md) | 服务端逆向：tree-sitter 语法节点全表、类型系统、诊断文案 |
| [分析/04-unity-package.md](分析/04-unity-package.md) | Unity 包：os.dat 解包、CLI、构建期变体裁剪、ShaderGraph 反射 |
| [分析/05-api-contract.md](分析/05-api-contract.md) | 14 端点 API 契约（实测修正版） |
| [分析/06-feasibility-and-roadmap.md](分析/06-feasibility-and-roadmap.md) | 可行性评估、值得照搬的 6 个设计决策 |
| [分析/07-live-probe-results.md](分析/07-live-probe-results.md) | 运行期实测：真实响应样本、门控矩阵、性能观测 |
| [分析/08-pro-feature-gap-analysis.md](分析/08-pro-feature-gap-analysis.md) | Pro 功能差距分析 |
| [分析/09-implementation-options.md](分析/09-implementation-options.md) | 实现方案枚举 + 本机事实核实 |
| [分析/10-feature-feasibility.md](分析/10-feature-feasibility.md) | 五项高级功能逐项判定（roadmap 的依据） |
| [分析/90-evidence-index.md](分析/90-evidence-index.md) | 证据索引 |
