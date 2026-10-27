# 项目文档规范（唯一事实来源）

> 本文件是本项目 docs 体系的完整规则。所有技能与人工维护都以本文为准；
> 修改本文本身属于架构级变更，应通过 /project-decision 记录 ADR。

## 1. 目录结构

```
项目根/
├── README.md                # 薄入口（≤60 行）：一句话定位 + 一行当前状态
│                            # + 文档索引指针 + agent 工作规则
└── docs/
    ├── README.md            # docs 唯一索引 + 阅读顺序
    ├── project.md           # 项目目标、范围、技术栈、总体设计原则
    ├── plan/
    │   ├── roadmap.md       # 阶段、里程碑、阶段验收标准
    │   ├── backlog.md       # 未完成任务的唯一权威来源
    │   └── sprint-NN.md     # 迭代：目标、选入任务 ID、范围边界、验收条件
    ├── specs/               # 功能规格，一功能一文件，与 src/ 模块对应
    ├── decisions/           # ADR：4 位编号，只追加，旧文件永不修改
    ├── progress/
    │   ├── status.md        # 项目级当前状态总览（≤一屏）
    │   └── log.md           # 已发生事件 + 已完成任务的历史结果权威来源
    ├── reference/
    │   └── conventions.md   # 本文件
    └── archive/             # 过期文档移入（移动而非删除）
```

## 2. 各文档的唯一职责

| 文档 | 唯一职责 | 更新方式 / 频率 |
|---|---|---|
| `project.md` | 目标、范围、技术栈、设计原则 | 重写 / 低 |
| `plan/roadmap.md` | 阶段、里程碑、验收标准 | 重写 / 低 |
| `plan/backlog.md` | **未完成任务状态的唯一权威来源** | 高频 |
| `progress/status.md` | 项目级总览：进度、进行中、阻塞、下一步 | 重写 / 高 |
| `progress/log.md` | 已发生事件 + **已完成任务的历史结果权威来源** | 只追加 |

## 3. Frontmatter 按文档类型区分

| 文档类型 | Frontmatter | 更新规则 |
|---|---|---|
| `project.md`、`status.md`、规格、计划 | `status: draft\|active\|archived` + `updated: YYYY-MM-DD` | 可重写 |
| `log.md` | **无 frontmatter**；日期写在每个条目内 | 仅末尾追加 |
| ADR | 固定创建元数据（`adr`、`date`、`title`，可选 `supersedes`） | 只追加；旧 ADR 永不修改 |
| 根 `README.md`、`docs/README.md` | 不要求 | 保持薄/索引职责 |

- `status` 字段只表达**文档自身**的生命周期（draft/active/archived），不表达架构决策是否仍为当前方案。
- 架构决策的时效性完全由新 ADR 的 `supersedes: NNNN` 单向链接表达；「已被取代」由扫描 supersedes 链计算，**不回写旧文件**。

## 4. 单一事实来源

- **未完成任务** → `plan/backlog.md` 唯一权威；**已完成任务** → `log.md` 完成事件权威。
- 已完成任务定期离开 backlog（归档动作由 /project-status 完成事件承接），追溯靠 log 完成事件。
- `status.md` 的「下一步」与 `sprint-NN.md` 的选入项**只引用任务 ID**，不复制任务详情和状态。
- **重写式与追加式严格分离**：快照类可重写；`log.md` 与 ADR 只追加。

## 5. 任务 ID 生命周期

- 格式 `T-NNN`，递增分配，**永不复用**——即使任务被删除或取消。
- 取消、拆分、合并任务时：保留原 ID 的历史，并在 `log.md` 记录关联关系
  （例：`T-012 拆分为 T-030、T-031`）。
- 任何被 sprint / status / log 引用、但既不在 backlog 又没有完成/取消/拆分事件的任务 ID，
  视为**悬空 ID**，是不一致，由 /docs-sync 报告。

## 6. backlog 条目格式

```
- [ ] T-014 任务标题（依据: spec:feature-login；验收: 登录集成测试全绿）
```

- `- [ ]` 未完成（进行中的具体状态见 `status.md`）；`- [x]` 已完成（等待归档，
  归档 = /project-status 写完成事件后从 backlog 移除该行）。
- 阻塞：行尾追加 `[blocked: 一句话原因]`。
- **依据**必填，三选一：`spec:<规格名>` / `指令`（用户明确指令）/ `问题:<一句话+证据>`。
- **验收**必填且可验证（测试名、命令、可观察行为）。
- 任务来源规则：**功能需求与用户可见行为变更必须基于已确认规格**；维护、测试、
  缺陷修复、工程任务可基于明确用户指令或已确认问题建立，但必须有可验证验收条件。

## 7. log.md 条目模板（结构化，供追溯与校验）

```
## YYYY-MM-DD HH:MM · <事件类型>：<一句话标题>
- 任务: T-NNN <任务名>          （任务类事件必填）
- 结果: <发生了什么、产出什么>
- 验证证据: <测试/命令/提交/路径> （完成事件必填）
```

事件类型：`任务完成` / `任务取消` / `任务拆分` / `任务合并` / `重要变更` / `其他`。

## 8. 命名与对应关系

- 全小写 kebab-case；ADR 用 4 位编号（`0001-标题.md`）。
- 文档↔代码对应：`specs/feature-xxx.md` ↔ `src/xxx/`（或等价模块路径）。
- 模块删除 → 对应规格移入 `archive/`（frontmatter `status: archived`），不删除。

## 9. Agent 冷启动与收尾协议

**任务开始**（按序读取）：
1. 根 `README.md`（工作规则）
2. `docs/README.md`（索引）
3. `docs/project.md` + `docs/plan/backlog.md` + `docs/progress/status.md`

**任务收尾**（按实际改动更新）：
- 任务状态变化 → `plan/backlog.md`；
- 项目状态变化 → 重写 `progress/status.md`（≤一屏）；
- 有事件发生 → 追加 `progress/log.md`；
- 修改代码后先跑验证（测试/构建），验证结果写入完成事件的「验证证据」。

## 10. 篇幅上限（可被 /docs-sync 检查）

- 根 `README.md` ≤ 60 行；
- `progress/status.md` ≤ 一屏（约 40 行）；超限说明它开始吸收任务细节了。
