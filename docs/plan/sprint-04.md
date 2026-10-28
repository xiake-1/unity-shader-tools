---
status: done
updated: 2026-10-28
---
# sprint-04

## 迭代目标

完成 roadmap **M4 语法诊断与死分支灰化**：tree-sitter `ERROR`/`MISSING` 转红波浪线（官方语料零误报门槛达标前默认关闭、可手动开启），
`#include` 未找到给 Warning；读 Unity `Editor.log` 的 `Disabled keywords:` 做三态求值，把**确定为假**的 `#if` 分支体置灰（只灰分支体、不含条件行），
日志缺失时降级为不灰化且不报错。

功能规格：[../specs/feature-syntax-diagnostics.md](../specs/feature-syntax-diagnostics.md)、[../specs/feature-dead-branch-dimming.md](../specs/feature-dead-branch-dimming.md)；
跨模块选型依据 [ADR 0008](../decisions/0008-dead-branch-dimming-editor-log.md)、[ADR 0009](../decisions/0009-syntax-diagnostics-error-exemption.md)。

**顺序约束**：T-034 先行 —— 语法诊断的豁免表与零误报门槛共用它的 ERROR 模式聚合口径（ADR 0009）；
灰化侧（T-043～T-048）不依赖 T-034、也不依赖 DXC，可并行先交付。

## 选入任务 ID

T-034、T-037、T-038、T-039、T-040、T-041、T-042、T-043、T-044、T-045、T-046、T-047、T-048

（任务详情与状态一律以 [backlog.md](backlog.md) 为准。）

## 范围边界（本轮不做）

- 类型/语义诊断（未定义符号、向量矩阵维度、swizzle、条件表达式标量检查）与 DXC 接入（M5，ADR 0004）；代码格式化（M5）
- Unity Editor 包侧（M6）：变体裁剪、工程元数据桥 —— 灰化只读 `Editor.log`，本轮不引入包桥（ADR 0008 的「M6 是否取代 Editor.log」保持未决）
- `//! KEY:VALUE` 行内注释覆盖语法、Unity 关键字默认值表、变体切换/重新编译（ADR 0008 与规格「不在范围」）
- LSP pull diagnostics（`diagnosticProvider`）、`workspace/diagnostic`、codeAction / quick fix、风格类 lint（未使用变量、命名规范）
- **改变 F12 / 补全 / Rename 对死分支的处理**：沿用「不求值、全分支都算」（feature-rename §8），本轮只加装饰
- 非 VSCode 客户端的灰化（不实现扩展通知即自然缺席）；semantic tokens、`DiagnosticTag.Unnecessary`（ADR 0008 已否）
- ADR 0006 第 2/3 层（运行时自愈、`Fix file associations`，待规格）；ADR 0005 发布流水线（待排期）

## 迭代验收条件

- roadmap M4 全部阶段标准通过（[roadmap.md](roadmap.md) M4 节）
- 两份规格「验收标准」节中与本迭代任务对应的条目通过，其中硬性项：
  - `npm run gate:diagnostics` 对三源语料（80+ 包内 / 56 内置 / 50 工程 shader）断言语法诊断总数 = 0，语料缺失记 `SKIP` 而非 `PASS`；
  - 门槛 FAIL 时语法诊断默认关闭且用户可手动开启（默认值与门槛结果联动）；
  - 灰化 Range 不含 `#if`/`#elif`/`#else`/`#endif` 条件行、嵌套不重叠；未知关键字一律不灰；
  - `Editor.log` 缺失 → 无装饰、无错误弹窗、Output 记 `source=none`
- 回归不劣化：rename 零误改语料、F12 / 补全 / 悬停既有断言全绿（死分支内目标符号行为不变）
- 验证命令：`npm run build`、`npm test`、`npm run test:vscode`、`npm run bench`、`npm run gate:diagnostics`
