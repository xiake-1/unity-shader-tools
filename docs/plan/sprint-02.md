---
status: done
updated: 2026-10-28
---
# sprint-02

## 迭代目标

完成 roadmap **M2 转到定义**：F12 覆盖工程内、包内（`Library/PackageCache`）、引擎内置（`Editor/Data/CGIncludes`）
三类真实声明行，并把「跳进内置库」做到超过对标产品（它对内置库故意不跳）。
功能规格：[../specs/feature-go-to-definition.md](../specs/feature-go-to-definition.md)。

## 选入任务 ID

T-014、T-015、T-016、T-017、T-018、T-019、T-020

（任务详情与状态一律以 [backlog.md](backlog.md) 为准。）

## 范围边界（本轮不做）

- 引用（find references）、Rename、悬停、补全、documentSymbol/Outline、签名帮助、`workspace/symbol`（M3，须先写规格）
- 语法诊断、类型诊断（DXC）、`#if` 死分支灰化、格式化（M4/M5）
- 类型驱动的成员跳转：链式 `i.uv.xy`、函数返回值成员、swizzle（依赖 DXC，ADR 0004）
- 预处理器求值与「未定义符号」提示（M4）；同名多义只排序与截断，不求值激活分支
- ADR 0006 的运行时自愈与 `Fix file associations` 命令（用户可见行为，待规格）；本轮只做 `documentSelector` 一层
- ADR 0005 的发布流水线（prebuilds + CI + vsce），另排期
- Unity Editor 包侧（M6）

## 迭代验收条件

- roadmap M2 全部阶段标准通过（[roadmap.md](roadmap.md) M2 节）
- 规格「验收标准」节中与本迭代任务对应的条目通过（含 F12 P95 < 200 ms 基准项）
- 验证命令：`npm run build`、`npm test`、`npm run test:vscode`、`npm run bench`
