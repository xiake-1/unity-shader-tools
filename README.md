# Unity Shader Tools（自研）

> 给 Unity 开发者用的 VSCode 插件：为 `.shader` / `.hlsl` 提供转到定义、语义补全、重命名、语法与类型诊断。工作名，可改。

**当前状态**：M1～M5（T-001～T-067）与 **M6 插件端（T-068～T-073）** 全部完成，backlog 无待办；
实测 vsix 23.67 MB、四门槛（语法 / 类型 / 格式化 / 变体）全 PASS（2026-10-29 复跑，详见
[docs/progress/status.md](docs/progress/status.md)）。M6 的 Unity 包侧已移出范围（ADR 0014），
插件端对 Unity 工程只读不写。

## Agent 工作规则（必读）

- 任务开始按序读取：本文件 → [docs/README.md](docs/README.md) → docs/project.md → docs/plan/backlog.md → docs/progress/status.md
- 修改代码后先跑验证（`npm test`，即 vitest 单测；Provider 层用 `npm run test:vscode` 跑 vscode-test 集成），再按规则更新文档
- 任务收尾按实际改动更新：docs/plan/backlog.md、docs/progress/status.md、docs/progress/log.md
- 完整文档规范（唯一事实来源）：[docs/reference/conventions.md](docs/reference/conventions.md)

## 文档

文档索引与阅读顺序：[docs/README.md](docs/README.md)

其中 [docs/分析/](docs/分析/) 是对标产品 Omni Shader Tools for Unity 的逆向分析与可行性判定，
是所有技术选型决策的证据来源，做设计前应先读 09、10 两份。
