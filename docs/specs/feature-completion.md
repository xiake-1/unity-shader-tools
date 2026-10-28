---
status: active
updated: 2026-10-28
---
# 规格 · 语义补全（completion）

对应模块：`server/src/`（`textDocument/completion` 处理与候选组装）与 `client/src/`（仅能力声明与 documentSelector）。

> 定位：roadmap **M3** 的用户可见功能之一，地基是 [feature-language-server-core.md](feature-language-server-core.md) 的符号索引、include 解析与文档同步，成员浅推断复用 [feature-go-to-definition.md](feature-go-to-definition.md) 的 `scopeResolver`。
> 范围经用户确认（2026-10-28）：**roadmap M3 三项 + 用户 `#define` 宏补全**；宏/函数文档来源 = **索引真实源码抓 `#define`/函数声明 + 邻近注释，`macroTable` 兜底**（ADR 0003 的副产品，不另建静态文档表）。
> **2026-10-28 手动测试后修订**（用户报告「自己声明的 `_MainTexture` 补不出来」「同名 struct 字段互相污染」）：标识符候选扩展**用户全局变量、Properties 属性、用户函数（当前文件 + include 闭包）与内置/包内全局变量**；成员候选按**可见性分层**（不再跨工程并集同名 struct 字段）；`unityshader`/`hlsl` 语言下默认关闭 VS Code 内置 word-based 补全（`configurationDefaults`）。同日二次修订（语义无处查找，见 [feature-hover.md](feature-hover.md)）：新增**冒号后语义补全**。
> 证据来源：[../分析/10-feature-feasibility.md](../分析/10-feature-feasibility.md) §3（拆块判定与「宏展开引擎是深坑」）、[../分析/07-live-probe-results.md](../分析/07-live-probe-results.md)（对标产品 98 KB 全表回传的教训 → 服务端过滤）、[../分析/02-vscode-client.md](../分析/02-vscode-client.md)（触发字符）。

## 范围

1. **LSP 能力**：server 在 `initialize` 声明 `completionProvider`（`triggerCharacters: [".", "\"", "/", "\\"]`），实现 `textDocument/completion`；客户端不注册独立 CompletionItemProvider（走标准 LSP，ADR 0002）。
2. **补全类别**（首期全部覆盖，经用户确认）：
   - **struct 成员补全**：`i.` 给出该变量声明类型的 struct 字段候选。类型来源 = 变量的显式声明（含 `v2f i`、`appdata v` 等），struct 定义可来自当前文件、include 闭包、工程内、包内、内置 —— 与 F12 规格 §2 的成员访问同一套**单层浅推断**（复用 `scopeResolver`，不写第二套）。**可见性分层**（2026-10-28 修订）：同名 struct 在 Unity 里每个编译单元各定义各的，字段候选不跨工程并集——当前文件/闭包(≤1)有定义就只用这一层，否则包内/内置(≥3)，再否则退回工程内(2) 兜底；
   - **`#include` 路径补全**：`#include "…"` 字符串内，按核心规格四类规则给候选：同目录相对路径、`Assets/**`、`Packages/<pkg>/…`（含 `Library/PackageCache/<pkg>@*/` 回退）、裸名内置（`Editor/Data/CGIncludes/**`）；另枚举包内 `ShaderLibrary/**`（`Core.hlsl` 等常以裸名/相对形式 include）；
   - **Unity/URP API 补全（宏 + 函数，带文档）**：索引到的包内与内置源中的 `#define` 宏与函数声明（`SAMPLE_TEXTURE2D`、`TEXTURE2D`、`TransformWorldToHClip` 等），`kind` 区分 Macro/Function；
   - **用户宏补全**：当前文件与 include 闭包内用户自己 `#define` 的宏（CST `preproc_def` 节点，索引副产品）；
   - **用户全局变量 / Properties 属性 / 用户函数**（2026-10-28 修订）：当前文件与 include 闭包内声明的 HLSL 全局变量（`float4 _MainTex_ST;`、`TEXTURE2D(_MainTex)` 等宏声明变量，`kind=Variable`）、当前文件 `Properties` 块声明的属性（`kind=Property`）、当前文件与闭包内的用户函数（`kind=Function`）；
   - **内置/包内全局变量**（2026-10-28 修订）：内置与包内源中的全局变量声明（`_Time`、`_WorldSpaceCameraPos` 等，`kind=Variable`，rank 3/4）；
   - **语义补全**（2026-10-28 二次修订）：struct 字段 `: ` 后与函数返回值 `: ` 后（CST `bitfield_clause`/`semantics` 位置）→ 自写语义表候选（`SV_Position`、`SV_Target0…`、`TEXCOORD0…7`、`POSITION`/`NORMAL`/`TANGENT`/`COLOR`/`UV` 等，`kind=Keyword`，rank 0；前缀过滤**大小写不敏感**——DX 语义本就大小写不敏感，`SV_POS` 命中 `SV_Position`，插入用 canonical 名；词条与文档复用 [feature-hover.md](feature-hover.md) 的 `semanticTable`，不写第二份表）。
3. **文档来源**（经用户确认）：宏与函数的 `documentation` 取**索引真实源码时抓取的邻近注释**（声明上方连续 `//` 或 `/* */` 块，索引时随符号一并存储）；无注释的已知宏回退 `macroTable`（40 条）自带描述；两者皆无 → 候选仍出现、文档为空。
4. **服务端前缀过滤**：按已输入前缀过滤候选（HLSL 大小写敏感），不照抄对标产品「每次回传 98 KB 全表靠客户端过滤」的做法（分析 07 实测）；候选总数上限 300，超限截断并置 `isIncomplete: true`、日志记 `truncated=<总数>`。
5. **排序**：当前文件 → include 闭包 → 工程内 → 包内 → 内置（与 F12 多结果优先级一致），经 `sortText` 表达；同类内按名字典序。
6. **上下文判定**：`.` 后 → 成员候选；`#include "` 字符串内 → 路径候选；其余标识符位置 → 宏/函数候选。标识符位置**不**依赖触发字符（普通打字即请求）。
7. **语言覆盖**：`unityshader`（`.shader`）与 `hlsl`（`.hlsl/.hlslinc/.cginc`），并按 ADR 0006 在 `documentSelector` 里额外接受 `UnityShader`。补全上下文仅在 `HLSLPROGRAM` 块内与 `.hlsl` 系文件全文生效；`CGPROGRAM` 块尽力而为（与 F12 规格对 CG 块的口径一致：按 HLSL grammar 解析，不承诺 CG 遗留宏覆盖）。

## 不在范围

- **一般标识符补全**（局部变量、函数参数、关键字、内置类型名 `float4` 等候选）—— 经用户确认不做；**工程内非闭包文件**的变量/函数/宏同样不进候选（不同编译单元不可见，2026-10-28 修订确立可见性口径）。
- **宏展开级补全**：`TEXTURE2D(_MainTex)` 实际声明了什么、宏参数位置补全 —— 通用宏展开引擎是深坑（分析 10 §3），不做；表驱动展开属诊断/灰化的将来议题。
- **链式与类型驱动成员补全**：`i.uv.`（向量成员 `.xy`/`.rgb`）、函数返回值取成员、内置类型（`Texture2D` 等）成员 —— 属类型系统，M5 DXC（ADR 0004），与 F12 规格「只做单层」一致。
- **ShaderLab 外壳补全**：`Tags` 取值（`Queue` 等）、`LightMode`、`Fallback`、Property drawer —— 不在 M3。
- **`#pragma` 补全**（指令名与 `multi_compile`/`shader_target` 取值）、签名帮助、snippet、`completionItem/resolve` 二段拉取（M3 文档内联）、自动导入。
- `CGPROGRAM`/固定管线语义、`.usf/.ush`/`.cg`/`.compute` 语言注册（ADR 0006 首期不注册）。

## 约束

- 只走标准 LSP `textDocument/completion`，客户端不得旁路 server 做文本匹配补全（设计原则 5）。
- 候选只读**唯一 CST、符号索引与 includeResolver**（核心规格），补全路径上不允许第二套解析或正则扫描（设计原则 2）；`scopeResolver` 与 F12 共用同一实现。
- 文档内容只来自索引真实源码的注释与自写 `macroTable`；不复制对标产品 `.std`/文档文本（设计原则 1、6），不生成 stub。
- 索引需支持**按前缀查名**（排序名表 + 二分），补全不得每次按键全表扫描；补全请求不得触发全量重建索引。
- 性能：索引完成后，对 ≤2000 行文件单次补全（请求→响应，含 LSP 往返）P95 < 150 ms（补全比 F12 更高频，预算更紧）。
- 索引进行中：立即返回当前已索引结果，不等待、不报错（与核心规格异常表一致）。
- 注释内、非 include 字符串内不发候选；未激活 `#if` 分支内的标识符位置照常给候选（不求值，与 F12 口径一致）。
- 首期单根工作区（核心规格约束）；多根时只服务第一个 Unity 工程根。

## 异常与边界

| 场景 | 行为 |
|---|---|
| `.` 左侧类型未知（宏声明的变量、未声明标识符、链式 `i.uv.`） | 成员候选为空列表（非报错），不弹窗 |
| 光标在注释、非 include 字符串、ShaderLab 状态命令（`Cull Off`）内 | 返回空列表，server 不异常退出、不记错误日志 |
| `#include "` 已输入前缀无任何匹配 | 空列表；include 未找到的结构化失败记录仍由核心规格产出（M4 消费），本功能不发诊断 |
| PackageCache 不存在 / Editor 路径缺失（核心规格降级态） | 内置与包内候选为空；同目录/`Assets`/`Packages` 候选照常；无错误弹窗 |
| 索引尚未完成 | 返回当前已索引部分，日志记「索引进行中」，不阻塞请求 |
| 候选总数 > 300 | 按优先级截断到 300，`isIncomplete: true`，日志 `truncated=<总数>` |
| 字段名与宏/函数同名（如自定义 `mul`） | 全部给出，`kind` 区分，按来源优先级排序（与 F12「不猜、全保留」一致） |
| 宏无邻近注释且不在 `macroTable` | 候选照常出现，`documentation` 为空 |
| 单文件超过索引大小上限（默认 2 MiB，未入索引） | 当前文件候选照常（打开的文档已有 CST：本地 struct、`#define`）；跨文件候选为空 |
| 未激活 `#if` 分支内的标识符位置 | 照常给候选（不求值） |
| `Temp/compiled-*`、`Temp/generatedFrom*` | 不响应请求（核心规格 §7） |
| server 崩溃或无响应 | 走核心规格重启策略（≤3 次）；期间补全无结果，不弹错误框 |
| 多根工作区 | 只服务第一个 Unity 工程根，其余文档按降级态处理 |

## 验收标准

每条映射到测试或可观察行为；基座为 T-006（vitest + vscode-test）。语料策略沿用 F12 规格：**Unity API 与 include 路径各取真实工程 `D:\Work\Unity\ShaderStudy` 样本**，其余边界与异常用自包含 fixture。

- [ ] 成员：fixture `struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; }; v2f i;` 后 `i.` → 候选含 `pos`、`uv`（`kind=Field`），不含无关符号（vitest）
- [ ] 成员（跨文件）：变量类型为 include 闭包/包内定义的 struct → 字段候选照常（vitest）
- [ ] 成员（可见性分层，2026-10-28 修订）：当前文件定义 `v2f {pos,uv}`、工程内另一文件定义 `v2f {grabPos,color}` → 当前文件 `i.` 只给 pos/uv，不给 grabPos/color（vitest + vscode-test）
- [ ] 标识符（用户变量，2026-10-28 修订）：当前文件 `float4 _MyMainTexture;` → `_My` 命中（kind=Variable）；当前文件 Properties `_MainTexture` → `_Main` 命中（kind=Property）；闭包变量与内置/包内变量各一例；工程内非闭包变量不进候选（vitest + vscode-test）
- [ ] 语义（2026-10-28 二次修订）：struct 字段 `pos : SV` → 候选含 `SV_Position`、`SV_Target`；`pos : ` 空前缀 → 含 `TEXCOORD0`；函数返回值 `: TEX` → 含 `TEXCOORD0`；候选带语义表文档（vitest + vscode-test）
- [ ] 成员（负例）：`i.uv.` 与 `.` 左侧未声明 → 空列表，无异常（vitest）
- [ ] include 四类各一例：`#include "Unity` → 候选含 `UnityCG.cginc`（内置裸名）；同目录、`Assets/…`、`Packages/…`（含 PackageCache 回退）各断言候选插入文本（vitest）
- [ ] include（真实工程）：`#include "Li` → 候选含 `Library` 下 URP `ShaderLibrary` 路径或 `Lighting.hlsl` 所在可解析路径（vscode-test 或 vitest 真实工程）
- [ ] Unity API（真实工程）：`SAMPLE_TEXTURE2D` 可补全且 `documentation` 非空（来自包内源注释或 `macroTable` 兜底）；`TransformWorldToHClip` 可补全且文档来自 `SpaceTransforms.hlsl` 邻近注释（vitest 真实索引）
- [ ] 用户宏：当前文件 `#define MY_FOG 1` → `MY_` 补全命中；include 闭包内 `#define` 同样命中（vitest）
- [ ] 文档兜底链：有注释 → 注释；无注释但在 `macroTable` → 表描述；两者皆无 → 文档为空但候选存在（vitest 三例）
- [ ] 前缀过滤：输入 `SAM` 的响应不含 `TEXTURE2D`；大小写敏感（`sam` 不命中 `SAMPLE_TEXTURE2D`）（vitest）
- [ ] 截断：fixture 造 >300 同名前缀候选 → 返回 300 条、`isIncomplete: true`、日志含 `truncated=`（vitest）
- [ ] 排序：同名候选跨当前文件/include 闭包/工程/包/内置五层时，返回顺序符合优先级（vitest 断言 sortText/顺序）
- [ ] 空结果面：注释内、`"Queue"="Geo"` 字符串内、`Cull Off` 上 → 空列表，server 不崩溃（vitest + 集成）
- [ ] 降级态：非 Unity 文件夹打开 `.shader`，`#include "` 仍给同目录/`Assets` 候选、内置候选为空、无错误弹窗（vscode-test）
- [ ] 编辑即时性：`didChange` 新增 `#define NEW_MACRO` 后立即补全命中（vscode-test）
- [ ] 性能：真实工程索引完成后，混合 `i.`/标识符补全采样 20 次 P95 < 150 ms（`npm run bench` 扩展项，输出 JSON 与 PASS/FAIL）
- [ ] 语言 id 覆盖：`unityshader`、`hlsl` 两个自有 id 下补全均可用（vscode-test）
- [ ] `Temp/compiled-*` 文件：补全无响应（vitest 路径判定）

## 对应模块

- `specs/feature-completion.md` ↔ `server/src/completion.ts`（新：上下文判定 → 候选组装 → 前缀过滤/排序/截断）
- ↔ 复用 `server/src/scopeResolver.ts`（成员浅推断，与 F12 同一实现）、`symbolIndex.ts`（需扩展：前缀查询 API、`#define`/函数声明的邻近注释随索引存储）、`includeResolver.ts`（路径候选）、`macroTable.ts`（文档兜底）、`documentStore.ts`、`parser.ts`，不新增解析路径
- ↔ `client/src/extension.ts`：仅 `completionProvider` 能力与 `documentSelector`（含 `UnityShader`，ADR 0006），无独立 CompletionItemProvider
- 依赖：[feature-language-server-core.md](feature-language-server-core.md)（索引/include/降级态/生命周期）、[feature-go-to-definition.md](feature-go-to-definition.md)（`scopeResolver` 浅推断）、ADR 0001（唯一 CST）、ADR 0003（真实源码索引 = 宏与文档来源）、ADR 0006（语言 id）
