---
status: active
updated: 2026-10-28
---
# Backlog（未完成任务唯一权威）

格式与规则见 [../reference/conventions.md](../reference/conventions.md) §6。

历史：sprint-01 的 T-001～T-006、T-009～T-013 与 sprint-02 的 T-014～T-020 已全部完成，
完成事件（含验证证据）见 [../progress/log.md](../progress/log.md)，条目已按规范 §7 从本文件移除。

## 待办

无。下一批功能任务（语义补全 / Rename / 诊断等）须先写规格再拆入，见下一节。

## 尚未入 backlog 的功能任务

以下功能已确认在范围内，但按规范 §6「功能需求必须基于已确认规格」，**须先写规格再拆入 backlog**，
对应里程碑见 [roadmap.md](roadmap.md)：

语义补全（M3）、Rename（M3）、语法诊断（M4）、`#if` 死分支灰化（M4）、
类型诊断 DXC（M5）、代码格式化（M5）、Unity 包侧（M6）。

另有两项已决策但**不可直接建功能任务**，原因各异：

- ADR 0006 的第 2/3 层（运行时 `setTextDocumentLanguage` 自愈、`Fix file associations` 命令写用户设置）
  属用户可见行为，须先 `/project-spec` 立规格（其第 1 层 documentSelector 已随 T-019 落地）。
- ADR 0005 的发布流水线（`prebuildify --napi` + CI 多平台矩阵 + `.vscodeignore` + vsce）属工程任务，
  可基于指令建立，但不在 M2 范围内 —— 待排期再拆 ID。
