---
status: done
updated: 2026-10-28
---
# sprint-03

## 迭代目标

完成 roadmap **M3 补全与引用**：语义补全覆盖 struct 成员、`#include` 路径、Unity/URP API（宏+函数）带文档与用户 `#define` 宏；
references 与 Rename 做到符号级识别，回归语料**零误改**（注释、字符串、死分支内另一符号同名、不同 struct 同名字段）。
功能规格：[../specs/feature-completion.md](../specs/feature-completion.md)、[../specs/feature-rename.md](../specs/feature-rename.md)。

## 选入任务 ID

T-021、T-022、T-023、T-024、T-025、T-026、T-027、T-028、T-029、T-030、T-031、T-032、T-033

（任务详情与状态一律以 [backlog.md](backlog.md) 为准。）

## 范围边界（本轮不做）

- 语法诊断、`#if` 死分支灰化（M4）；类型诊断（DXC）、格式化（M5）；Unity Editor 包侧（M6）
- 一般标识符补全（当前文件/工程用户符号、局部变量、关键字、内置类型名）、宏展开级补全、
  链式与类型驱动成员补全（`i.uv.`、函数返回值成员，依赖 DXC，ADR 0004）、ShaderLab 外壳与 `#pragma` 补全
- 改写 `.mat`/`.unity` 资产文件（只发资产失效提示）；内置/包内符号改名（`prepareRename` 拒绝）
- 预处理器求值与激活分支判定（M4）：Rename 对同一逻辑符号全分支都改、不求值
- 悬停、签名帮助、documentSymbol/Outline、`workspace/symbol`
- ADR 0006 第 2/3 层（运行时自愈、`Fix file associations`，待规格）；ADR 0005 发布流水线（待排期）

## 迭代验收条件

- roadmap M3 全部阶段标准通过（[roadmap.md](roadmap.md) M3 节）
- 两份规格「验收标准」节中与本迭代任务对应的条目通过（含零误改回归语料、补全 P95 < 150 ms、
  references P95 < 500 ms、rename < 1 s 基准项）
- 验证命令：`npm run build`、`npm test`、`npm run test:vscode`、`npm run bench`
