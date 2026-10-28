---
adr: 0008
date: 2026-10-28
title: "#if 死分支灰化：关键字取自 Unity Editor.log，呈现走 LSP 扩展通知 + 客户端装饰"
---

# 0008 · 死分支灰化的关键字来源与呈现机制

## 背景

roadmap M4 第三条验收要求「读取 Unity `Editor.log` 的 `Disabled keywords:` 列表，把未激活 `#if` 分支置灰；日志缺失时降级为不灰化且不报错」（[../plan/roadmap.md](../plan/roadmap.md) M4）。可行性判定给的是 2～3 天、性价比极高，且对标产品把该能力（Live Testing）划在 Pro（[../分析/10-feature-feasibility.md](../分析/10-feature-feasibility.md) §5c、[../分析/08-pro-feature-gap-analysis.md](../分析/08-pro-feature-gap-analysis.md)）。

要落地必须先回答两个跨模块问题：

**① 「当前哪些关键字是关的」从哪来。** 这是运行时事实，不是源码可推出的。实测事实：`%LOCALAPPDATA%\Unity\Editor\Editor.log` 里有 `Disabled keywords: SHADER_API_GLES30 UNITY_COLORSPACE_GAMMA UNITY_PBS_USE_BRDF2 …` 完整列表（[../分析/09-implementation-options.md](../分析/09-implementation-options.md) §0/§5）。备选：

- **D1 读 Unity 全局 `Editor.log`**（选定）：无需 Unity 包，M4 独立可交付；代价是数据全局、可能陈旧（见后果）。
- **D2 等 M6 工程元数据桥**（roadmap M6「Editor 启动时写工程元数据」）：数据 per-project 且准确，但灰化被 M6 阻塞，M4 只剩语法诊断，roadmap 验收要挪期。
- **D3 文件内 `//! KEY:VALUE` 行内注释覆盖语法**（对标产品做法，CHANGELOG 1.1.2；[../分析/02-vscode-client.md](../分析/02-vscode-client.md) §4.2）：用户可控、可手动灰化任意分支，但要新定义一套注释语法与优先级，且它本身不解决「默认状态下当前关键字是什么」。
- **D4 自己求值/试编译**：等价于自研预处理器求值 + 关键字推断，成本远超本功能价值，否决。

**② 求值结果怎么呈现。** 设计原则 2 要求 CST 只有一个（[../project.md](../project.md)），`preproc_if` 节点只在 server 侧存在 → 求值必在 server。但标准 LSP 没有「未使用区域」这种推送。对标产品是私有 HTTP `/branch` + 客户端 `setDecorations(UNUSED_CODE_STYLE)`（[../分析/02-vscode-client.md](../分析/02-vscode-client.md) §4.2、[../分析/90-evidence-index.md](../分析/90-evidence-index.md)）。备选：

- **P1 LSP 扩展通知 + 客户端 `setDecorations`**（选定）：数据仍走 LSP 通道与生命周期，只是用协议允许的 `$/…` 自定义通知命名空间。
- **P2 `publishDiagnostics` + `DiagnosticTag.Unnecessary`**：零协议扩展、纯标准 LSP；但灰化会进 Problems 面板、可被用户单独忽略，且与语法/类型诊断的误报统计混在同一集合里 —— 直接污染 ADR 0004 与 roadmap 的「零误报」口径（设计原则 4）。
- **P3 semantic tokens**：可复用主题配色、跨编辑器可移植；但要为灰化引入 semantic tokens 全链路，与自带 grammar 高亮职责重叠，成本最高。

与 ADR 0002 的张力必须挑明：0002 说「走标准 LSP、不造私有协议」，针对的是对标产品的私有 HTTP（[0002-standard-lsp-host.md](0002-standard-lsp-host.md)）。P1 是否越界需要一句话界定，否则将来 /docs-sync 会判冲突。

## 决策

死分支灰化的关键字来源取 Unity 全局 `Editor.log` 的 `Disabled keywords:` 行（M4 不依赖 M6 桥）；求值在 server 侧基于唯一 CST 的 `preproc_if`/`preproc_elif`/`preproc_else` 节点完成，结果经 LSP 扩展通知（`$/unityShader/inactiveRegions`）发给客户端，由客户端 `setDecorations` 做灰色装饰 —— 不用诊断集合、不用 semantic tokens、不引入行内注释覆盖语法。

## 后果

- 正面：M4 与 M6 解耦，灰化可在语法诊断之前独立交付（它不依赖 grammar 修复，也不依赖 DXC）；灰化不进 Problems 面板，与语法/类型诊断的「零误报」门槛完全隔离，ADR 0004 的「类型诊断默认关闭或降级为 Hint」策略不被稀释；装饰是纯客户端表现，客户端不认这条通知时自然降级为「无灰化」，不破坏 ADR 0002 换来的跨编辑器接入。
- 负面（接受）：
  - `Editor.log` 是**全局、非 per-project**：多工程或多 Unity 实例时可能读到别的工程的关键字；日志陈旧（切分支、改 shader 关键字后未重新编译）会让灰化基于过期集合。规格必须定义刷新策略，且求值遇到未知/无法判定关键字时**保守不灰化**（宁可不做，不可做错 —— 设计原则 4 同源）。
  - `Editor.log` 在 workspace 之外，LSP `workspace/didChangeWatchedFiles` 覆盖不到 → 需要 server 侧定时轮询或客户端读取后经请求传入；**不引入独立 watcher 进程**（feature-language-server-core 的「不在范围」保持有效）。
  - 平台与体积：Windows `%LOCALAPPDATA%\Unity\Editor\Editor.log`、macOS `~/Library/Logs/Unity/Editor.log`、Linux `~/.config/unity3d/Editor.log`；Unity 会把上一轮日志轮转为 `Editor-prev.log`，单文件可达数十 MB → 扫描范围（尾部/分段）与解析失败降级属规格细节。
  - 扩展通知不在标准 LSP 能力协商里：非 VSCode 客户端拿不到灰化（其余标准能力不受影响）；需在 `initialize` 里按客户端能力决定是否发送，未注册时不发。
  - **不取代 ADR 0002**：本 ADR 把「不造私有协议」界定为「不脱离 LSP 通道与生命周期、不用 LSP 之外的传输」；`$/…` 自定义通知属 LSP 允许的扩展。若将来需要 HTTP/IPC 之类 LSP 之外的通道传这类数据，须另立 ADR 取代 0002 的相关部分。
- 未决项（登记，不预写取代关系）：M6 工程元数据桥落地后，是否由它取代 `Editor.log` 作为权威关键字源。若取代，届时另立 ADR 并在其 `supersedes` 里指向本 ADR。
- 落地边界（不在本 ADR 内）：灰化本体须先由 /project-spec 立 `feature-dead-branch-dimming`（关键字刷新与陈旧策略、未知宏保守不灰化、`#elif` 链与嵌套求值口径、装饰 range 是否含 `#if` 行本身、日志缺失/无该行/巨大日志的降级、验收 fixture 与可观察断言），再由 /project-plan 拆任务（依据可写 `spec:feature-dead-branch-dimming` + `ADR:0008`）。
