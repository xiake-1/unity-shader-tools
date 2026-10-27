---
status: active
updated: 2026-10-27
---
# 规格 · 转到定义（go-to-definition）

对应模块：`src/server/`（`textDocument/definition` 处理与符号定位）与 `src/client/`（仅能力声明与 documentSelector）。

> 定位：roadmap **M2** 的用户可见功能，地基是 [feature-language-server-core.md](feature-language-server-core.md) 的符号索引、include 解析与文档同步。
> 目标（project.md 成功标准）：F12 能跳到**工程内、包内、引擎内置的真实声明行** —— 这一点要超过对标产品（它对内置库故意不跳）。
> 证据来源：[../分析/10-feature-feasibility.md](../分析/10-feature-feasibility.md) §1、[../分析/09-implementation-options.md](../分析/09-implementation-options.md) 方案 B2、
> [../分析/07-live-probe-results.md](../分析/07-live-probe-results.md)（`/definition` 响应形状与 `.std` 不跳的原因）、[../分析/02-vscode-client.md](../分析/02-vscode-client.md)（跳转健壮性）。

## 范围

1. **LSP 能力**：server 在 `initialize` 声明 `definitionProvider`，实现 `textDocument/definition`；客户端不注册 VSCode 专用 Provider（走标准 LSP，ADR 0002）。
2. **符号类别**（首期全部覆盖，经用户逐项确认）：
   - 当前文件 HLSL 全局变量、函数（含重载）、`struct` 及其字段、`#define` 宏；
   - `Properties` 块属性 —— 与同名 HLSL 声明合并为同一逻辑符号（核心规格 §6），从采样处跳回属性声明行；
   - **宏生成的声明**：`TEXTURE2D(_MainTex)`、`SAMPLER(sampler_MainTex)`、`CBUFFER_START(UnityPerMaterial)…CBUFFER_END`、`UNITY_DECLARE_TEX2D(…)` 等，按已知宏表（`macroTable.ts`，40 条）当声明处理；
   - 跨文件：当前文件 include 闭包内的工程内 `.hlsl/.hlslinc/.cginc`；
   - **包内真实声明**：`<工程根>/Library/PackageCache/com.unity.render-pipelines.*/ShaderLibrary/**`；
   - **引擎内置声明**：`<EditorDir>/Data/CGIncludes/**`（56 文件）—— 必须真跳进文件；
   - **局部变量与函数参数**：块级作用域，同名遮蔽取最近作用域（innermost）；
   - **struct 成员访问**：`v2f i;` 后 `i.uv` → `struct v2f` 内 `uv` 的声明行（浅推断：点号左侧是已声明变量，取其声明的类型名查 struct）；
   - **`#pragma vertex vert` / `#pragma fragment frag`** 上的函数名 → 该函数定义（Unity 特有，对标产品未做）；
   - **`#include "…"` 字符串**上的 F12 → 打开目标文件（复用核心规格四类规则）。
3. **多结果策略**：返回 `Location[]`，按优先级排序 —— 当前文件 → include 闭包（按 include 出现顺序）→ 工程内 → 包内 → 内置；重载与 `#if` 分支同名**全部保留**（不求值、不猜激活分支）；同名超过 10 处截断到 10 条并在日志记 `truncated=<总数>`。
4. **位置语义**：返回**声明中符号名 token 的 Range**（不是整条声明、不是光标处）。
5. **索引联动**：只查核心规格的符号索引与 include 闭包 API；编辑（`didChange`）后新声明立即可跳，无需手动重建。
6. **语言覆盖**：`unityshader`（`.shader`）与 `hlsl`（`.hlsl/.hlslinc/.cginc`），并按 ADR 0006 在 `documentSelector` 里额外接受 `UnityShader`。

## 不在范围

- 引用（find references）、Rename、悬停、补全、documentSymbol/Outline、签名帮助、`workspace/symbol`（按名搜符号）—— 各写独立规格。
- **类型驱动**的成员跳转：函数返回值取成员（`GetMainTex().mipmaps`）、swizzle（`_MainTex_ST.xy`）、嵌套/链式推断（`i.uv.xy`）—— 属 M5 DXC（ADR 0004）。
- 预处理器求值：不判定哪个 `#if` 分支激活（M4）；不做通用宏展开，只认已知宏表（分析 10 坑 1）。
- 「未定义符号」提示与 include 未找到的诊断（M4 消费核心规格的结构化失败记录）。
- `CGPROGRAM` / GLSL 块的 CG/GLSL 特有语义：CG 块按 HLSL grammar 尽力解析并索引（T-004 事实），GLSL 块不索引 → 不跳转；固定管线状态命令（`Cull`/`Blend`/`Stencil`）无跳转。
- 生成或改写 stub / `.std` 类文件；跳转目标一律是磁盘真实文件。
- 非 HLSL 语言（`.usf/.ush`、C#）与 `.cg`/`.compute` 的语言注册（ADR 0006：首期不注册）。

## 约束

- 只走标准 LSP `textDocument/definition`，不得在客户端旁路 server 做文本匹配跳转（设计原则 5）。
- 符号定位只读**唯一 CST 与符号索引**（核心规格），definition 路径上不允许出现第二套解析或正则扫描（设计原则 2）。
- 跳转目标必须**磁盘上真实存在**：返回前对每个 location 做存在性校验（对标产品 CHANGELOG 1.0.0 修过「打开不存在的文件」）；不照抄它对 `.std` 直接返回 null 的回避做法。
- 内置/包内路径按 `ProjectVersion.txt` + `Packages/manifest.json` 动态定位，不硬编码版本号（分析 10 坑 3）。
- 作用域判定用 tree-sitter 节点区间（innermost containing function/block 的声明表），不实现完整作用域演算，不做类型系统。
- 成员访问只做**单层** `变量.字段`；点号左侧类型未知时返回 null。
- 性能：索引完成后，对 ≤2000 行文件单次 F12 端到端（含 LSP 往返）P95 < 200 ms；F12 不得触发全量重建索引。
- 索引进行中：立即返回当前已索引结果，不等待、不报错（与核心规格异常表一致）。
- 首期单根工作区（核心规格约束）；多根时只服务第一个 Unity 工程根。

## 异常与边界

| 场景 | 行为 |
|---|---|
| 光标在注释、字符串（非 include）、数字、关键字、内置类型名（`float4`）上 | 返回 null，不报错、不记错误日志 |
| 光标在 ShaderLab 状态命令（`Cull Off`）或未知 ShaderLab token 上 | 返回 null |
| 符号只在未激活 `#if` 分支里声明 | 照常返回该 location（不求值） |
| 同名符号 >10 处（如内置 `mul` 的 30+ 重载） | 按优先级返回前 10 条，日志记 `truncated=<总数>` |
| include 目标不存在 / 四类规则均未命中 | F12 返回 null；结构化失败记录已由核心规格产出（M4 消费），本功能不发诊断 |
| 已索引的目标文件被删/移（切分支、Unity 重算 PackageCache） | 返回前存在性校验：缺失的 location 剔除；全部缺失返回 null 并记日志 |
| 索引尚未完成 | 返回当前已索引部分；未命中时返回 null，日志记「索引进行中」，不阻塞请求 |
| 非 Unity 文件夹 / Editor 路径缺失（核心规格降级态） | 当前文件与工程内符号照常；内置与包内符号为空 → `UnityObjectToClipPos` 返回 null，无错误弹窗 |
| 单文件超过索引大小上限（默认 2 MiB，未入索引） | 文件内跳转仍可用（打开的文档已有 CST）；跨文件符号查不到 → null |
| `Temp/compiled-*`、`Temp/generatedFrom*` 生成文件 | 不响应请求（核心规格 §7） |
| `#pragma vertex vert` 但 `vert` 未声明 | 返回 null（存在性校验属 M4 语法/语义诊断） |
| 成员访问左侧变量类型未知（宏声明的参数、未知类型） | 返回 null |
| server 崩溃或无响应 | 走核心规格重启策略（≤3 次）；期间 F12 无结果，不弹错误框 |
| 多根工作区 | 只服务第一个 Unity 工程根，其余文档按降级态处理 |

## 验收标准

每条映射到测试或可观察行为；基座为 T-006（vitest + vscode-test）。语料策略（经用户确认）：**三个真实跳转样本跑真实工程 `D:\Work\Unity\ShaderStudy`**，其余边界与异常用自包含 fixture。

- [ ] 真实工程：从用法处 F12 `_MainTex` → 落到该 shader `Properties` 块声明行（vscode-test `vscode.executeDefinitionProvider` 断言 URI 与行号）
- [ ] 真实工程：F12 `TransformWorldToHClip` → `Library/PackageCache/com.unity.render-pipelines.core@*/ShaderLibrary/SpaceTransforms.hlsl` 的真实声明行
- [ ] 真实工程：F12 `UnityObjectToClipPos` → `<EditorDir>/Data/CGIncludes/` 内的真实声明行（实测 2022.3.62f3c1 声明在 `UnityShaderUtilities.cginc` 而非 `UnityCG.cginc`，故断言只钉到 CGIncludes 层 + 名字 token；对标产品此处返回 null）
- [ ] 宏声明：`SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex)` 里的 `_MainTex` 跳回 `TEXTURE2D(_MainTex);` 声明行（vitest + 集成各一例）
- [ ] 局部变量：fixture 中外层与内层同名 `float depth`，F12 命中**最近作用域**那条（vitest）
- [ ] 函数参数：F12 参数用法 → 该参数声明 token（vitest）
- [ ] struct 成员：`v2f i;` 后 `i.uv` → `struct v2f` 内 `uv` 声明行；`i.uv.xy` 返回 null（vitest）
- [ ] `#pragma vertex vert` 上的 `vert` → 函数定义行（vitest + 集成）
- [ ] include 跳转四类各一例：相对路径、`Assets/…`、`Packages/…`（含 PackageCache 回退）、裸名内置 `.cginc`（vitest 断言目标 URI）
- [ ] 多义：重载与 `#if` 分支同名全部返回，且顺序为 当前文件 → include 闭包 → 工程内 → 包内 → 内置（vitest 断言数组顺序）
- [ ] 截断：fixture 造 12 处同名 → 返回 10 条且日志含 `truncated=12`（vitest）
- [ ] 存在性校验：fixture 中删除一个已索引目标文件后 F12 → 该 location 不出现；全部缺失时返回 null（vitest）
- [ ] 空结果面：注释 / 字符串 / 关键字 / 数字 / `Cull Off` 上 F12 返回 null，server 不异常退出（vitest + 集成）
- [ ] 降级态：非 Unity 文件夹打开 `.shader`，工程内符号可跳、`UnityObjectToClipPos` 返回 null、无错误弹窗（vscode-test）
- [ ] 索引进行中：在索引未完成的窗口内发 F12，请求立即返回（断言响应 <100 ms、无挂起），日志含「索引进行中」（vitest：`indexing()` 注入 + 日志断言；vscode-test 侧的时序窗口不可控，改由 vitest 覆盖）
- [ ] 性能：真实工程索引完成后，对 ≤2000 行 shader 采样 20 次 F12，P95 < 200 ms（`npm run bench` 扩展项，输出 JSON 与 PASS/FAIL）
- [ ] 编辑即时性：`didChange` 插入新声明后立刻 F12 命中该声明（vscode-test）
- [ ] `Temp/compiled-*` 文件：F12 无响应（vscode-test / vitest 路径判定）
- [ ] 语言 id 覆盖：`unityshader`、`hlsl` 两个自有 id 下 F12 均可用（vscode-test），且打包产物的 `documentSelector` 含 `UnityShader`（ADR 0006 第 1 层，vscode-test 读产物断言）。「VSTU 残留关联 → plaintext 回落」场景依赖 ADR 0006 第 2/3 层，另立规格后再验收，不在本迭代

## 对应模块

- `specs/feature-go-to-definition.md` ↔ `src/server/src/definition.ts`（新：token → 符号 → `Location[]`，排序与截断、存在性校验）
- ↔ `src/server/src/scopeResolver.ts`（新：局部变量/参数作用域与遮蔽、`变量.字段` 浅推断、`#pragma` 入口函数与 include 字符串定位）
- ↔ 复用核心规格的 `src/server/src/symbolIndex.ts`、`includeResolver.ts`、`parser.ts`、`macroTable.ts`、`documentStore.ts`，不新增解析路径
- ↔ `src/client/src/extension.ts`：仅 `definitionProvider` 能力与 `documentSelector`（含 `UnityShader`，ADR 0006），无独立 DefinitionProvider
- 依赖：[feature-language-server-core.md](feature-language-server-core.md)（索引/include/生命周期/降级态）、ADR 0001（唯一 CST）、ADR 0006（语言 id）
