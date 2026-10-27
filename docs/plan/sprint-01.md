---
status: done
updated: 2026-10-27
---
# sprint-01

## 迭代目标

完成 roadmap M1 地基（工程骨架 + LSP 通道 + 解析层），并落地核心规格
[../specs/feature-language-server-core.md](../specs/feature-language-server-core.md) 的地基部分
（文档同步、Unity 工程发现、include 解析、符号索引、性能基准），为 M2「转到定义」铺平。

## 选入任务 ID

T-001、T-002、T-003、T-004、T-005、T-006、T-009、T-010、T-011、T-012、T-013

（任务详情与状态一律以 [backlog.md](backlog.md) 为准。）

## 范围边界（本轮不做）

- 任何用户可见语言功能：转到定义、补全、Rename、诊断、灰化、格式化、documentSymbol（M2～M5，须先写各自功能规格）
- Unity Editor 包侧（M6）
- DXC 集成（ADR 0004 仅记录决策，不在本轮实施）
- grammar native/WASM binding 的最终选型作为 T-001 内部待决事项，需要取舍时另立 ADR

## 迭代验收条件

- roadmap M1 全部阶段标准通过（[roadmap.md](roadmap.md) M1 节）
- 核心规格「验收标准」节中与本迭代任务对应的条目通过（含三项性能基准达标）
- 验证命令：`npm run build`、`npm test`、`npm run test:vscode`
