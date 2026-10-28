---
adr: 0009
date: 2026-10-28
title: "语法诊断误报控制：grammar 继续修 + ERROR 模式豁免表 + 语料零误报门槛测试"
---

# 0009 · 语法诊断的误报控制与 grammar 豁免机制

## 背景

roadmap M4 前两条验收：「括号不匹配、缺 `;`、`HLSLPROGRAM` 缺 `ENDHLSL` 出红波浪线」与「官方语料（80+ 包内 `.hlsl` + 56 内置 include + 50 工程 shader）**零误报**，达不到则不默认开启」（[../plan/roadmap.md](../plan/roadmap.md) M4）。诊断的来源选型**已由 ADR 0004 结清**：语法诊断由 tree-sitter `ERROR`/`MISSING` 节点自产，类型诊断才外包 DXC（[0004-dxc-type-diagnostics.md](0004-dxc-type-diagnostics.md)）。本 ADR 不重开选型，只解决它没回答的那一半：**误报怎么控**。

forces：

- 设计原则 4「误报零容忍」—— 任何诊断类功能，官方语料达不到零误报就不默认开启（[../project.md](../project.md)）；对标产品正因被误报咬过而把诊断改成默认关闭（[../分析/10-feature-feasibility.md](../分析/10-feature-feasibility.md) §5b）。
- **官方语料里必然存在不可修的 ERROR**：ADR 0007 已登记三类无法用 grammar 补丁解决的模式 —— `#if` 块内外不平衡括号（AutoLight.cginc、UnityStandardCore.cginc 参数列表）、文件作用域带 primitive 参数的裸宏调用（`UNITY_DEFINE_INSTANCED_PROP(float, x)`）、ShaderGraph 模板 `$` 占位符与 ffx 宏 typedef（[0007-fork-tree-sitter-hlsl-workspace.md](0007-fork-tree-sitter-hlsl-workspace.md) 已知限制段），它们落在官方语料文件里，对应待办 T-034（[../plan/backlog.md](../plan/backlog.md)）。
- 现有地基只有**计数**，没有**按模式的判定**：`countErrorNodes()`（`server/src/parser.ts:118-125`）与 `FileIndex.errorCount`（`server/src/symbolIndex.ts:55`）服务于语料健康检查；core 规格也只承诺「错误节点计数暴露给 M4」「解析失败结构化记录供 M4 消费」（[../specs/feature-language-server-core.md](../specs/feature-language-server-core.md) 异常与边界表、§5）。
- 推论：把每个 `ERROR`/`MISSING` 直接转成 `Diagnostic`，官方语料必然误报 → roadmap「零误报否则不默认开启」这条验收永远达不到 → M4 验收长期挂空。

备选：

- **E1 只靠 grammar 修，不设豁免机制**：诊断实现最干净；但 ADR 0007 已判定三类模式修不掉，语法诊断只能长期默认关闭，M4 拿不到用户可见价值。
- **E2 文件/路径级白名单**（内置与包内只读文件不产诊断）：实现最省事、误报面立刻收敛；但「官方语料零误报」退化成「不测」，工程内同类错误模式照样误报，门槛口径被掏空，且用户改不了的内置文件恰恰是最需要真实反馈的地方。
- **E3 三层组合**（选定）：grammar 继续修可修模式 + 按 ERROR 模式的豁免表 + 语料级零误报门槛测试。
- **E4 语法诊断默认关闭、仅手动触发**：把误报责任推给用户，与「红波浪线」的产品预期相悖，否决。

## 决策

语法诊断的误报控制采用三层组合：grammar 侧继续修可修模式（T-034）；对 ADR 0007 判定不可修的模式建立**按 ERROR 模式（node kind + 上下文特征）的豁免表**，作为仓库内一等公民（数据表 + 解析测试钉住），命中即不产诊断；官方语料离线扫描脚本给出**逐模式**的 ERROR/诊断计数，作为零误报门槛测试 —— 门槛不达则语法诊断默认关闭。

## 后果

- 正面：M4 的「零误报」从主观判断变成可测命令（扫描脚本 + 断言），与 M2/M3 已有的 bench/语料测试同构；T-034 的审计脚本与 M4 门槛测试共用同一份语料与聚合口径，不造两套；豁免是显式、可审计、可回收的 —— grammar 修好后删掉豁免行，「豁免未被命中」的断言会暴露冗余；内置与包内只读文件仍能得到真实语法反馈。
- 负面（接受）：
  - 豁免表是**第二份知识**，与 grammar 补丁面耦合：grammar 一改，豁免可能失效（误报回归）或过度豁免（漏报）。要求每条豁免带命中计数断言与「不修 + 理由」记录（T-034 验收已含此项）。
  - 按模式豁免的粒度是启发式：过宽则同类真实错误被吞，过窄则误报回归。规格须定义豁免键（node kind / 父节点 / 文件特征）与默认方向 —— **宁可漏报不可误报**（与设计原则 4 一致）。
  - 门槛测试要跑 186+ 文件，依赖本机 Unity 安装与 `Library/PackageCache` 版本 → 需要固定语料快照或经 `unityShader.unityEditorPath` 定位，否则门槛不可重复、CI 时长上升。
  - 三层都要在 M4 内落地，工作量大于「直接吐 ERROR」；**T-034 因此是语法诊断的前置而非并行项**（排期判断交 /project-plan，灰化侧不受此约束）。
- 不取代任何既有 ADR：ADR 0004 的「语法诊断自产 / 类型诊断走 DXC」不变；ADR 0007 的三类不可修模式判定不变，本 ADR 只承接其后果；ADR 0001 的单 CST 原则不变（豁免发生在诊断层，不新增解析路径）。
- 落地边界（不在本 ADR 内）：须先由 /project-spec 立 `feature-syntax-diagnostics`（`ERROR`/`MISSING` → `Diagnostic` 的映射与文案、severity、编辑中间态与 debounce、配置项命名与默认开关、只读内置/包内文件与 `Temp/compiled-*` 是否产诊断、零误报门槛的测法，以及「include 未找到」是否属 M4 —— core 规格已按「M4 消费」预留但 roadmap 未列），再由 /project-plan 拆任务（依据可写 `spec:feature-syntax-diagnostics` + `ADR:0009`）。
