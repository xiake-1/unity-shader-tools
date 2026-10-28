---
status: active
updated: 2026-10-28
---
# 规格 · 语法诊断（syntax diagnostics）

对应模块：`server/src/diagnostics.ts`（新）+ `server/src/errorExemption.ts`（新，ERROR 模式豁免表）+ `server/src/server.ts`（防抖与 `publishDiagnostics` 接线）+ `client/src/extension.ts`、`client/package.json`（配置项与默认值）。

> 定位：roadmap **M4** 的用户可见功能之一（M4 标题「语法诊断与死分支灰化」）。诊断来源已由 ADR 0004 结清（语法诊断由 tree-sitter `ERROR`/`MISSING` 自产，类型诊断才走 DXC）；本规格落地 **ADR 0009 的三层误报控制**（grammar 继续修 + ERROR 模式豁免表 + 语料零误报门槛测试）。
> 范围经用户确认（2026-10-28）：**「include 未找到」纳入本规格、severity = Warning**；**四类文件（`.shader`/`.hlsl`/`.hlslinc`/`.cginc`）都产语法诊断**；**编辑中间态走防抖（默认 800 ms，可配）**；**零误报门槛达标 → 默认开启；未达标 → 默认关闭但提供手动开启开关**。
> 证据来源：[../分析/10-feature-feasibility.md](../分析/10-feature-feasibility.md) §5a（tree-sitter 免费给 `ERROR`/`MISSING`，误报可控）、[../分析/03-language-server.md](../分析/03-language-server.md)（对标诊断文案形态 `syntax error - …`/`MISSING ;`/`Include file '' not found`、DTO `message/severity/node_kind`）、[../分析/05-api-contract.md](../分析/05-api-contract.md)（对标诊断 debounce 900 ms）、[../decisions/0009-syntax-diagnostics-error-exemption.md](../decisions/0009-syntax-diagnostics-error-exemption.md)、[../decisions/0007-fork-tree-sitter-hlsl-workspace.md](../decisions/0007-fork-tree-sitter-hlsl-workspace.md)（三类不可修模式）。

## 范围

1. **推送方式**：server 经 `textDocument/publishDiagnostics` 推送（push 模型，无需 capability 声明）；LSP pull diagnostics 不在范围。
2. **语法错误来源与映射**：`ERROR`/`MISSING` 节点 → `Diagnostic`（severity = **Error**）。
   - 文案自写、形态对齐产品级：`MISSING <token>`（取自 tree-sitter MISSING 节点的 token 名）、`syntax error - <节点类型>`；不复制对标文本资产（设计原则 6）。
   - Range：`ERROR` 取节点自身 Range；`MISSING` 取插入点（前一 token 末尾的零宽 Range）。
   - **只报最外层 `ERROR`**：其内部不再产子诊断（ADR 0007 的级联吞块会否则刷屏），日志记 `nested=<被抑制数>`。
   - 去重：同一节点重复发布不重复计入；单文件上限 `unityShader.maxDiagnosticsPerFile`（默认 200），超限按文档顺序截断并记 `truncated=<总数>`。
3. **「include 未找到」诊断**（经用户确认纳入，severity = **Warning**）：来源为 `includeResolver` 的结构化失败（`IncludeResult.resolved === null` + `IncludeFailureReason`，core 规格 §5 已按「M4 消费」预留）；Range 落在 `#include` 的路径字符串上；文案 `Include file '<spec>' not found`；四类解析成功时零诊断。
4. **文件覆盖**（经用户确认）：`.shader`、`.hlsl`、`.hlslinc`、`.cginc` 四类都产（grammar 对无 ShaderLab 外壳的文件按 HLSL 处理；CG 语义仍不做）；打开文档与磁盘已索引文件都产；`Temp/compiled-*`、`Temp/generatedFrom*` 不产（core 规格 §7）。
5. **ERROR 模式豁免表**（ADR 0009 第二层）：`errorExemption.ts` 数据表，键 = ERROR 节点特征（node kind + 父节点类型 + 触发 token 模式，可选文件特征），命中 → **不产诊断**；每条带 `id`、`reason`（「不修 + 理由」，对应 ADR 0007 三类模式与 ShaderGraph 模板 `$` 占位符）与**命中计数**；日志记 `exempted=<id>:<计数>`。grammar 修好后豁免不再命中 → 门槛测试的冗余断言失败，提示删行。
6. **发布时机与防抖**（经用户确认）：`didOpen`/`didSave`/`didChangeWatchedFiles` 立即发布；`didChange` 走防抖，默认 **800 ms**（`unityShader.diagnosticsDebounceMs`，0–5000，0 = 每次即时）；防抖窗口内不发布中间态；`didClose` 清空该文件诊断。
7. **默认开关与门槛联动**（经用户确认）：`unityShader.syntaxDiagnostics`（boolean）与 `unityShader.includeDiagnostics`（boolean）。默认值由**语料零误报门槛测试**决定：门槛 PASS → `configurationDefaults` 默认 `true`；FAIL → 默认 `false`（用户可手动开）。当前基线（T-034 未结清）预期为 FAIL → 语法诊断默认关闭。翻转为 `true` 是一次配置改动，须附门槛测试输出。
8. **零误报门槛测试**（roadmap M4 第二条的测法）：脚本 `test/corpus/diagnosticsGate.mjs`，命令 `npm run gate:diagnostics`。扫描三源语料（经 `BENCH_PROJECT`/`BENCH_EDITOR` 定位，与 bench 同一约定：50 工程 shader + 80+ 包内 `.hlsl` + 56 内置 include），输出**逐模式** ERROR 聚合表与语法诊断总数，断言总数 = 0；语料缺失时以 `SKIP + 原因` 退出而非 PASS。与 T-034 的审计脚本共用同一份语料与聚合口径（不造两套）。
9. **配置项**（扁平命名，沿用现有 `unityShader.trace`/`unityShader.index` 风格）：`unityShader.syntaxDiagnostics`、`unityShader.includeDiagnostics`、`unityShader.diagnosticsDebounceMs`、`unityShader.maxDiagnosticsPerFile`。

## 不在范围

- **类型/语义诊断**（未定义符号、向量矩阵维度、swizzle、条件表达式标量检查）→ M5 DXC（ADR 0004）。
- **`#if` 死分支灰化** → [feature-dead-branch-dimming.md](feature-dead-branch-dimming.md)（ADR 0008）；本规格不求值预处理器。
- 风格类 lint（未使用变量、命名规范、缩进）、codeAction / quick fix（自动补 `;` 之类修复）。
- LSP pull diagnostics（`diagnosticProvider`）、`workspace/diagnostic` 工作区级拉取、`DiagnosticRelatedInformation`、诊断 `code` 链接文档站点。
- `CGPROGRAM` / 固定管线语法语义诊断（[../project.md](../project.md) 不在范围）。
- 复制对标产品的 `.std` 内容或文档文本作诊断文案来源（设计原则 6）。

## 约束

- 只读唯一 CST（`parser.ts`）与 `includeResolver`；诊断层不新增解析路径（设计原则 2；ADR 0001/0009）。
- **宁可漏报不可误报**（ADR 0009）：豁免命中即不产；无法归类的 ERROR 若落在已知不可修模式上按豁免处理，其余照常产。
- 语法诊断不依赖 Unity 工程发现（降级态照常产）；**include 未找到诊断在降级态下不产**（内置/包内路径不可用会必然刷屏），日志记 `degraded=skip-include-diag`。
- 门槛测试必须可重复：语料经环境变量定位，缺失即 SKIP 并打印原因；不得把「语料缺失」当 PASS。
- 性能：诊断计算在防抖后异步进行，不阻塞 `didChange` 返回；2000 行 shader 单文件诊断计算 P95 < 150 ms（与 hover/completion 同预算，bench 扩展项）。
- 索引大小上限（默认 2 MiB）只约束**未打开**的文件；打开的文档无论大小都产诊断。

## 异常与边界

| 场景 | 行为 |
|---|---|
| 正在输入半截括号/半截语句 | 防抖窗口（默认 800 ms）内不发布；窗口结束按最终文本发布 Error（经用户确认） |
| 未闭合 `{` 级联吞掉后续数十行 | 只产 **1** 条（最外层 `ERROR`），日志 `nested=<抑制数>` |
| 命中 ADR 0007 三类不可修模式（AutoLight.cginc 括号、顶层带 primitive 参数裸宏、`$` 占位符/ffx typedef） | 豁免表命中 → 不产诊断，日志 `exempted=<id>:<n>` |
| 豁免行在语料上零命中（grammar 已修） | 门槛测试的「每条豁免命中 > 0」断言失败 → 提示删除该豁免行 |
| `unityShader.syntaxDiagnostics = false` | 不产语法诊断；已发布的旧诊断在下一次文档事件清空，不残留 |
| 门槛未达标（默认 `false`） | 语法诊断默认关闭；include 未找到按其自身开关 |
| `#include` 目标不存在 / 四类规则均未命中 | 1 条 Warning，Range 覆盖路径字符串；该文件其余符号照常入索引（core 口径） |
| 非 Unity 降级态（无 `Assets/`+`Library/`、Editor 路径找不到） | 语法诊断照常产；include 未找到**不产**，日志记降级跳过 |
| `Temp/compiled-*`、`Temp/generatedFrom*` | 不产任何诊断（core §7） |
| 单文件诊断数超 `maxDiagnosticsPerFile` | 按文档顺序截断，日志 `truncated=<总数>` |
| 未打开且超索引大小上限的文件 | 不产诊断（未索引），日志记跳过；打开后照常产 |
| server 崩溃/无响应 | 走 core 规格重启策略（≤3 次）；重连后客户端重新 `didOpen` → 重新发布诊断，无残留旧诊断 |
| 外部修改磁盘文件（git 切分支） | `didChangeWatchedFiles` 驱动重算并发布；打开中的文档以其文本为准 |

## 验收标准

每条映射到测试或可观察行为；基座为 T-006（vitest + vscode-test），语料策略沿用既有规格（自包含 fixture + 真实工程样本）。

- [ ] 三类语法错误各产 1 条 Error：缺 `;`、括号不匹配、`HLSLPROGRAM` 缺 `ENDHLSL` —— Range 落在预期位置（vitest + vscode-test 各一例）
- [ ] 级联抑制：未闭合 `{` 吞掉 20 行 → 只产 1 条，日志含 `nested=`（vitest）
- [ ] 文案形态：`MISSING ;` 前缀断言（vitest）
- [ ] 豁免表生效：fixture 造 ADR 0007 模式①（`#if` 内开括号、块外闭括号）→ 零诊断 + 日志 `exempted=`（vitest）
- [ ] 豁免冗余可发现：门槛脚本对每条豁免断言命中计数 > 0（`npm run gate:diagnostics`）
- [ ] include 未找到：`#include "nope.hlsl"` → 1 条 Warning 且 Range 覆盖 spec 字符串；四类解析成功时零诊断（vitest）
- [ ] 降级态：无 Unity 工程 fixture → include 未找到零诊断、语法诊断照常产（vitest + vscode-test）
- [ ] 防抖：连续 5 次 `didChange` → 只收到 1 次 `publishDiagnostics`；`diagnosticsDebounceMs=0` 时每次即时（vscode-test 计数）
- [ ] 开关与清空：`syntaxDiagnostics=false` → 无新诊断且旧诊断被清空（vscode-test）
- [ ] 四类文件覆盖：`.shader`/`.hlsl`/`.hlslinc`/`.cginc` 各产语法诊断（vitest 四例 + 集成至少两类）
- [ ] 生成文件：`Temp/compiled-x.shader` 含语法错误 → 零诊断（vitest 路径判定）
- [ ] 截断：造 250 个错误 → 返回 200 条 + 日志 `truncated=250`（vitest）
- [ ] **零误报门槛**（roadmap M4 核心）：`npm run gate:diagnostics` 对真实语料（80+ 包内 + 56 内置 + 50 工程 shader）断言语法诊断总数 = 0，并打印逐模式 ERROR 聚合表；语料缺失时 SKIP 而非 PASS（脚本 + CI）
- [ ] 门槛与默认值联动：门槛 PASS → `configurationDefaults` 为 `true`；FAIL → 为 `false`（脚本比对 `client/package.json` 与门槛结果，或 CI 断言）
- [ ] 性能：bench 扩展项「单文件语法诊断」2000 行 shader 采样 20 次 P95 < 150 ms（`npm run bench` 输出 JSON 与 PASS/FAIL）

## 对应模块

- `specs/feature-syntax-diagnostics.md` ↔ `server/src/diagnostics.ts`（新：ERROR/MISSING 收集与最外层抑制、文案与 Range 组装、include 未找到 Warning、去重与截断、防抖调度）
- ↔ `server/src/errorExemption.ts`（新：豁免表数据 + 匹配器 + 命中计数）
- ↔ 复用 `server/src/parser.ts`（`walk`；`countErrorNodes` 扩展为收集节点而非只计数）、`server/src/includeResolver.ts`（`IncludeResult`/`IncludeFailureReason`）、`server/src/documentStore.ts`、`server/src/tempFiles.ts`、`server/src/symbolIndex.ts`（`errorCount` 作语料健康口径）
- ↔ `server/src/server.ts`：`connection.sendDiagnostics`、防抖定时器、`onDidChangeConfiguration` 读取四个配置项
- ↔ `client/src/extension.ts` + `client/package.json`：四个 `unityShader.*` 配置项与 `configurationDefaults`（默认值随门槛）
- ↔ 测试：`test/unit/diagnostics.test.ts`、`test/unit/errorExemption.test.ts`、`test/src/suite/diagnostics.test.js`、`test/corpus/diagnosticsGate.mjs`（新，与 T-034 审计脚本共用聚合口径）
- 依赖：[feature-language-server-core.md](feature-language-server-core.md)（唯一 CST、include 四类、降级态、Temp 关闭智能）、[../decisions/0009-syntax-diagnostics-error-exemption.md](../decisions/0009-syntax-diagnostics-error-exemption.md)（三层误报控制）、ADR 0004（语法诊断自产 / 类型走 DXC）、ADR 0007（不可修模式来源）、ADR 0001（唯一 CST）
