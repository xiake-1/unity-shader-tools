# Unity Shader Tools（自研）

> 给 Unity 开发者用的 VSCode 插件：为 `.shader` / `.hlsl` 提供转到定义、语义补全、重命名、语法与类型诊断。工作名，可改。

**当前状态**：M1 地基与 M2 转到定义已完成（F12 覆盖工程内 / 包内 / 引擎内置符号），M3 待立规格（详见 [docs/progress/status.md](docs/progress/status.md)）

## Agent 工作规则（必读）

- 任务开始按序读取：本文件 → [docs/README.md](docs/README.md) → docs/project.md → docs/plan/backlog.md → docs/progress/status.md
- 修改代码后先跑验证（`npm test`，即 vitest 单测；Provider 层用 `npm run test:vscode` 跑 vscode-test 集成），再按规则更新文档
- 任务收尾按实际改动更新：docs/plan/backlog.md、docs/progress/status.md、docs/progress/log.md
- 完整文档规范（唯一事实来源）：[docs/reference/conventions.md](docs/reference/conventions.md)

## 文档

文档索引与阅读顺序：[docs/README.md](docs/README.md)

其中 [docs/分析/](docs/分析/) 是对标产品 Omni Shader Tools for Unity 的逆向分析与可行性判定，
是所有技术选型决策的证据来源，做设计前应先读 09、10 两份。
