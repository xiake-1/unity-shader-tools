---
status: active
updated: 2026-10-28
---
# Backlog（未完成任务唯一权威）

格式与规则见 [../reference/conventions.md](../reference/conventions.md) §6。

历史：sprint-01 的 T-001～T-006、T-009～T-013，sprint-02 的 T-014～T-020，sprint-03 的 T-021～T-033，
T-035/T-036（悬停 + 补全），sprint-04 的 T-034、T-037～T-048（M4 语法诊断 + 死分支灰化），
sprint-05 的 T-049～T-058（M5 类型诊断：产物接入、分块编译单元、`dxcRunner`、宏表、include 闭包、
诊断核心、豁免表、接线、门槛、集成与 bench），sprint-05 的 T-059～T-065（M5 格式化：外壳与 HLSL
打印器、原样区、幂等与失败即不改、provider 接线与配置面、`gate:format`、集成用例与 bench），
sprint-05 的 T-066～T-067（发布流水线：`prebuildify` 多平台产物脚本、CI 矩阵、`.vscodeignore`、
`vsce package` 与实测体积口径）均已完成，
完成事件（含验证证据）见 [../progress/log.md](../progress/log.md)，条目已按规范 §7 从本文件移除。

## 待办

**无。** sprint-01～sprint-05 的全部任务（T-001～T-067）已完成，M1～M5 收口。
下一步是 M6（Unity 包侧），按规范 §6 须先写规格再拆任务（见下方「尚未入 backlog 的功能任务」）。

## 尚未入 backlog 的功能任务

以下功能已确认在范围内，但按规范 §6「功能需求必须基于已确认规格」，**须先写规格再拆入 backlog**，
对应里程碑见 [roadmap.md](roadmap.md)：

Unity 包侧（M6）。

另有一项已决策但**不可直接建功能任务**：

- ADR 0006 的第 2/3 层（运行时 `setTextDocumentLanguage` 自愈、`Fix file associations` 命令写用户设置）
  属用户可见行为，须先 `/project-spec` 立规格（其第 1 层 documentSelector 已随 T-019 落地）。
