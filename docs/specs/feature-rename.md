---
status: active
updated: 2026-10-28
---
# 规格 · 引用与重命名（references & rename）

对应模块：`server/src/`（`textDocument/references`、`prepareRename`、`textDocument/rename` 与符号解析复用）与 `client/src/`（仅能力声明与 documentSelector）。

> 定位：roadmap **M3** 的用户可见功能之二（M3 标题「补全与引用」）。Rename = 引用查找 + 批量 edit，与 F12 共用同一套符号解析（[feature-go-to-definition.md](feature-go-to-definition.md)），是「F12 的副产品」（分析 10 §2）。`textDocument/references` 经用户确认（2026-10-28）纳入本规格，不再另立。
> 范围经用户确认：**引用查找与改名范围 = 全工程（所有已索引 shader 系文件）**；**内置/包内符号拒绝改名**；**同一符号全部 occurrence 都改（含 `#if` 分支内，不求值）**；**Properties 属性改名联动全部代码并提示材质/场景资产将失效**。
> 证据来源：[../分析/10-feature-feasibility.md](../分析/10-feature-feasibility.md) §2（误改来源矩阵、A2/A3 前置）、[../分析/02-vscode-client.md](../分析/02-vscode-client.md)（prepareRename 两步流程）、[../分析/07-live-probe-results.md](../分析/07-live-probe-results.md)（对标产品 Rename 为 Pro 哨兵）。

## 范围

1. **LSP 能力**：server 在 `initialize` 声明 `referencesProvider: true` 与 `renameProvider: { prepareProvider: true }`；实现 `textDocument/references`、`textDocument/prepareRename`、`textDocument/rename`。客户端不注册独立 Provider（ADR 0002）。
2. **符号级引用识别（零文本匹配）**：token → 逻辑符号 —— 与 F12 完全同一条解析路径（CST + 符号索引 + `scopeResolver` 浅推断）；`Properties` 属性、HLSL 同名声明、宏生成声明（`TEXTURE2D(_MainTex)`、`SAMPLER(sampler_MainTex)`、`CBUFFER` 内声明）合并为**同一逻辑符号**（核心规格 §6），改名联动全部形态。
3. **查找范围**（经用户确认）：当前文件 + **全工程所有已索引的 shader 系文件**（`.shader/.hlsl/.hlslinc/.cginc`，含包内与内置源中的引用）；打开文档始终参与（未入索引的大文件按打开文档处理）。
4. **`textDocument/references`**：返回 `Location[]`，尊重 `context.includeDeclaration`；结果含声明与各使用处（宏参数内的 token 也是使用处）；上限 200 处，超限按优先级截断（当前文件 → include 闭包 → 工程内 → 包内 → 内置）、日志记 `truncated=<总数>`。
5. **`prepareRename`**：返回被改名的名字 token Range 与占位文本；**拒绝**（返回错误并带可读消息）场景见「异常与边界」。
6. **`textDocument/rename`**：返回单个 `WorkspaceEdit`（跨文件），每处只替换**名字 token 的 Range**，不动行内其余文本；一次提交、VSCode 原生单步撤销。
7. **改名联动与资产提示**（经用户确认）：
   - 改 Properties 属性 `_MainTex` → Properties 声明、HLSL 声明、宏参数处（`TEXTURE2D(_MainTex)`、`SAMPLE_TEXTURE2D(_MainTex, …)`）全部改；
   - **约定名联动**：`sampler_<旧名>` 的出现处一并改为 `sampler_<新名>`（`macroTable` 已把 `SAMPLER(sampler_X)` 与 X 关联；不遵循该约定的自定义采样器名不联动）；
   - 改名成功后 server 发 `window/showMessage(Info)`：提示该属性在 `.mat`/`.unity` 中的序列化值**不会自动迁移**，需在 Unity 中重新指定。
8. **`#if` 分支口径**（经用户确认）：同一逻辑符号在 `#if/#else` 各分支内的声明与使用**全部改名**；不做预处理器求值、不猜激活分支（与 F12 与核心规格「保留全部分支」一致）。回归语料防的是「不该改的被改」（注释、字符串、**别的**同名符号），不是漏改。
9. **新名字校验**：合法 HLSL 标识符（`[A-Za-z_][A-Za-z0-9_]*`）、非空、不与关键字/内置类型名冲突、不与**同一解析作用域**内另一符号同名；违反 → `rename` 返回错误消息，不产生半成品 edit。
10. **语言覆盖**：`unityshader`、`hlsl` 两个自有 id + ADR 0006 的 `UnityShader`。

## 不在范围

- **改写 `.mat`/`.unity` 等资产文件**（经用户确认：只提示，不动 YAML 资产）；C# 脚本里的字符串引用、ShaderGraph 关联同理只覆盖 shader 系文件。
- **内置与包内符号改名**（经用户确认拒绝）：`Editor/Data/CGIncludes/**`、`Library/PackageCache/**` 中的声明不可改；对它们的引用**可查**（references 照常返回）。
- **预处理器求值 / 死分支判定**（M4）：不判定哪个分支激活；死分支内**目标符号**的 occurrence 照常改。
- **类型驱动消歧**：链式成员（`i.uv.xy`）、函数返回值成员、宏展开后的符号 —— 属 M5 DXC（ADR 0004）；左侧类型无法浅推断的同名成员按「不可解析」处理（见异常表），不猜。
- **宏定义体内部改名**（`#define M(x) (x)` 里的参数 `x`）：`prepareRename` 拒绝；宏整体改名只改宏名自身出现处。
- 文本查找替换、文件/目录改名、符号跨文件移动、codeAction 重构菜单。
- `CGPROGRAM`/固定管线语义、`.usf/.ush`/`.cg`/`.compute` 语言注册（ADR 0006）。

## 约束

- 符号解析只复用 F12/核心规格的**唯一 CST + 符号索引 + scopeResolver**，rename/references 路径上不允许第二套解析或正则文本匹配（设计原则 2）；「只改与 F12 解析出的同一符号的 token」（分析 10 §2 安全措施）。
- 引用收集允许**按需重解析**已索引文件以枚举同名 token occurrence（复用 `parser.ts`，tree-sitter 增量），但不得引入文本匹配捷径；重解析不得触发全量重建索引。
- 只修改**工程用户源**（`Assets/`、`Packages/` 内嵌包）；对包内/内置文件的 rename edit 一律不生成（设计原则 1 的镜像：引擎源只读）。
- 存在性校验：生成 WorkspaceEdit 前对每个目标文件做存在性校验（沿用 F12 规格约束），缺失的跳过并记日志。
- 不可解析 occurrence 的口径：**宁漏勿错** —— 不生成该处 edit，日志记 `unresolved=<数量>`；UI 不阻断改名。
- 性能：真实工程（50 工程 shader + 80+ 包内 + 56 内置）索引完成后，`references` 请求 P95 < 500 ms；≤50 处 occurrence 的单符号 rename 端到端（请求→WorkspaceEdit 返回）< 1 s。
- 索引进行中：基于已索引部分工作，日志记「索引进行中」，不阻塞请求（核心规格口径）。
- 首期单根工作区（核心规格约束）。

## 异常与边界

| 场景 | 行为 |
|---|---|
| 光标在注释、字符串（含 `#include "x"`、`"Queue"="…"`）、关键字、内置类型名（`float4`）上 | `prepareRename` 返回 null（不可改名），无错误弹窗 |
| 目标是内置/包内源的声明（如 `TransformWorldToHClip`） | `prepareRename` 返回错误消息「内置/包内符号不可改名」；references 照常可查 |
| 新名非法（空、`1abc`、含空格）、与关键字/内置类型冲突、同作用域被占 | `rename` 返回错误消息，不产生任何 edit |
| 不同 struct 的同名字段（`v2f.uv` vs `appdata.uv`） | 只改可解析到该字段的 occurrence（左侧变量浅推断）；不可解析处不改，日志 `unresolved=N` |
| 同名符号跨 `#if` 分支重复声明（同一逻辑符号） | 全部分支的声明与使用都改（不求值，经用户确认） |
| 注释/字符串里的同名 token | 永不改（CST token 类别判定，非文本匹配）—— 回归语料必测 |
| Properties 属性改名 | 代码全联动（Properties/HLSL/宏参数/`sampler_<旧名>`）+ Info 资产提示；自定义采样器名不联动 |
| 已索引文件在改名前被删/移（切分支、PackageCache 重算） | 存在性校验：缺失文件跳过并记日志；声明所在文件本身缺失 → 错误，不产生 edit |
| 索引尚未完成 | 打开文档照常；未索引的工程文件不参与查找，日志「索引进行中」 |
| 单文件超过索引大小上限（默认 2 MiB） | 打开的文档按打开文档参与；未打开则不在查找范围，日志记跳过 |
| 引用 > 200 处（如内置 `mul`） | references 按优先级截断到 200，日志 `truncated=<总数>`；rename 不适用（内置不可改名） |
| `Temp/compiled-*`、`Temp/generatedFrom*` | 不参与查找、不可改名（核心规格 §7） |
| server 崩溃或无响应 | 走核心规格重启策略（≤3 次）；rename 请求失败，VSCode 显示错误，无半成品 edit 落盘 |
| 多根工作区 | 只服务第一个 Unity 工程根，其余文档按降级态处理 |

## 验收标准

每条映射到测试或可观察行为；基座为 T-006（vitest + vscode-test）。语料策略沿用 F12 规格：真实工程样本 + 自包含 fixture；**回归语料（roadmap M3「零误改」）为必测项**。

- [ ] **零误改回归语料**（roadmap M3 核心）：fixture 含 ①注释里的同名 ②`#include "uv"` 与 `"Queue"="Geometry"` 字符串 ③未激活 `#if` 分支里**另一符号**的同名 ④不同 struct 的同名字段 —— 对 `v2f` 的字段 `uv` 执行 rename → 仅可解析的 `i.uv` occurrence 被改，其余全部原样（vitest 断言逐处 Range）
- [ ] **Properties 联动**：改 Properties 的 `_MainTex` → Properties 声明、`TEXTURE2D(_MainTex)`、`SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex)` 两参数、`sampler_MainTex` 全部改为新名；其他属性零改动（vitest + vscode-test 各一例）
- [ ] **资产提示**：Properties 属性改名后收到 `window/showMessage(Info)`，文本含「材质」「场景」字样（vscode-test 拦截 window/showMessage）
- [ ] **内置拒绝**：对 `TransformWorldToHClip` 的声明处 `prepareRename` → 错误消息含「不可改名」；其 references 仍返回包内使用处（vscode-test + vitest）
- [ ] 跨文件：fixture 工程 `Assets/a.hlsl` 声明、`Assets/b.shader` 与 `Assets/c.hlsl` 使用 → rename 的 WorkspaceEdit 覆盖三文件全部 occurrence（vitest）
- [ ] 作用域：两个 struct 均有 `uv`，改 `v2f.uv` → `appdata.uv` 处零改动，日志含 `unresolved=`（vitest）
- [ ] `#if` 分支：同一逻辑符号在 `#if`/`#else` 两分支各有声明与使用 → 全部被改（vitest）
- [ ] 新名校验：`1abc`、`float`、空串、同作用域已有名 → `rename` 返回错误且无 edit（vitest 四例）
- [ ] references：`_MainTex` 返回 Properties 声明 + HLSL 声明 + 宏参数使用处；`includeDeclaration: false` 时不含声明（vitest）
- [ ] references 截断：fixture 造 250 处同名 → 返回 200 条、日志 `truncated=250`（vitest）
- [ ] 空结果面：注释/字符串/关键字/`Cull Off` 上 `prepareRename` 返回 null，server 不崩溃（vitest + 集成）
- [ ] 存在性校验：删除一个已索引使用处文件后 rename → 不报错、该文件不在 edit 中、日志记跳过（vitest）
- [ ] 编辑即时性：`didChange` 新增使用处后 rename 立即覆盖该处（vscode-test）
- [ ] 性能：真实工程 `D:\Work\Unity\ShaderStudy` 索引完成后，references 采样 20 次 P95 < 500 ms；单符号 rename（≤50 处）端到端 < 1 s（`npm run bench` 扩展项，输出 JSON 与 PASS/FAIL）
- [ ] 语言 id 覆盖：`unityshader`、`hlsl` 两个自有 id 下 references/rename 均可用（vscode-test，`vscode.executeReferenceProvider`/`executeRenameProvider`）
- [ ] `Temp/compiled-*` 文件：references 不返回其 location、prepareRename 拒绝（vitest 路径判定）

## 对应模块

- `specs/feature-rename.md` ↔ `server/src/rename.ts`（新：prepareRename 校验、新名校验、WorkspaceEdit 组装、Properties/`sampler_` 联动、资产提示消息）
- ↔ `server/src/references.ts`（新：全工程同名 occurrence 收集（按需重解析复用 `parser.ts`）、includeDeclaration、优先级排序与截断）
- ↔ 复用/扩展 `server/src/definition.ts` 与 `scopeResolver.ts` 的 token→逻辑符号解析（同一实现，不复制）、`symbolIndex.ts`（需扩展：按名查 occurrence / 逻辑符号合并视图）、`macroTable.ts`（`sampler_` 约定联动）、`documentStore.ts`
- ↔ `client/src/extension.ts`：仅 `referencesProvider`/`renameProvider` 能力与 `documentSelector`（含 `UnityShader`，ADR 0006），无独立 Provider
- 依赖：[feature-language-server-core.md](feature-language-server-core.md)（索引/逻辑符号合并/降级态/生命周期）、[feature-go-to-definition.md](feature-go-to-definition.md)（符号解析与浅推断，M2 已交付）、ADR 0001（唯一 CST）、ADR 0003（真实源码索引）、ADR 0006（语言 id）
