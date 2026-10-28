---
status: active
updated: 2026-10-28
---
# 规格 · 类型诊断（type diagnostics，DXC）

对应模块：`server/src/typeDiagnostics.ts`（新：编译单元切分、诊断映射、缓存与互斥）+ `server/src/dxcRunner.ts`（新：子进程调用与输出解析）+ `server/src/dxcMacroTable.ts`（新：内置默认宏表）+ `server/src/dxcExemption.ts`（新：按消息模式的豁免表）+ `server/src/server.ts`（触发、并发与 `publishDiagnostics` 合并）+ `client/src/extension.ts`、`client/package.json`（配置项与默认值）+ `test/corpus/typeDiagnosticsGate.mjs`（新）。

> 定位：roadmap **M5** 第一条（[../plan/roadmap.md](../plan/roadmap.md) M5）。选型已由 **ADR 0010** 结清：短命子进程调**随扩展附带的官方预编译 `dxc`**、库编译目标（无需入口点）、不绑 `IDxcIntelliSense`、不用 Unity 的 `dxcompiler.dll`、不做首次运行下载；宏的权威源 = **自写内置默认宏表 + 当前文件 `#define`**，ADR 0008 的 `Editor.log` Disabled 集合**只做减法**；DXC **不接管** definition/completion/hover。误报控制承接 **ADR 0009** 的三层机制，但豁免键换成 **消息模式（+ 可选 `-W` 警告 flag）**——实测 v1.9.2609 的语义错误**不带错误码**（机制同构、表另立一份，语料与聚合口径不造第三套）。
> 范围经用户确认（2026-10-28）：**覆盖 `.shader` 的 HLSLPROGRAM + 独立 `.hlsl`/`.hlslinc`（不含 `.cginc`）**；**已有语法 Error 时不跑 DXC**；**`didOpen`/`didSave` 触发、`didChange` 不触发**；**零误报硬门槛，PASS → 默认开**；**include 闭包内（内置/包内）的错误默认不推给用户，误报控制用按消息模式的豁免表**。
> 证据来源：[../decisions/0010-dxc-subprocess-bundled-distribution.md](../decisions/0010-dxc-subprocess-bundled-distribution.md)、[../decisions/0004-dxc-type-diagnostics.md](../decisions/0004-dxc-type-diagnostics.md)、[../decisions/0009-syntax-diagnostics-error-exemption.md](../decisions/0009-syntax-diagnostics-error-exemption.md)、[../分析/10-feature-feasibility.md](../分析/10-feature-feasibility.md) §5b、[../分析/09-implementation-options.md](../分析/09-implementation-options.md) §0（本机 Unity 只有 `dxcompiler.dll`、无 `dxc.exe`）。

## 范围

1. **编译单元**：`.shader` 里**每个 `program_hlsl` / `program_hlsl_include` 块单独编译一次**（`extractProgramBodies`，`server/src/parser.ts:56`）；独立 `.hlsl`/`.hlslinc` 整文件为一个编译单元。`program_cg`/`program_glsl` 与 `.cginc` **不产类型诊断**（[../project.md](../project.md) 不在范围：CG 语义）。
2. **虚拟文档与坐标恒等**：复用 `buildVirtualHlsl`（`server/src/parser.ts:88`）的**等长空白化**思路，但按块生成：目标块内容原样保留，**其余全部字节（含其它程序块与 ShaderLab 外壳）替换为等长空白、换行保留**。因此 DXC 报告的 `(line, col)` **就是** `.shader` 里的坐标，**不需要自建双向行号映射表**（ADR 0004 后果段最担心的胶水面在此消解）。分块编译同时消除「两个 Pass 各有一个 `vert` 被当成重复定义」这类假诊断。
3. **执行形态**（ADR 0010）：`dxcRunner` 以短命子进程调用 `dxc`；用**库编译目标**（不要求入口点，Unity 的 `#pragma vertex/fragment` 属 ShaderLab 层，DXC 侧只当未知 pragma）；宏经 `-D`、include 根经 `-I` 注入；**只把 error 级输出转诊断**，未知 pragma 一类警告默认抑制；超时（`unityShader.dxcTimeoutMs`，默认 5000）→ 该块不产诊断并记 `dxc=timeout`。具体参数组合属实现细节，但必须满足：库目标、无入口点、警告抑制、错误可解析。
4. **编译器定位**：优先用随扩展附带的产物（win32-x64 / linux-x64，ADR 0010），`unityShader.dxcPath` 可覆盖为自备编译器；macOS 无官方预编译产物 → 类型诊断不可用并**显式提示**（不静默无智能，与 ADR 0005 的加载失败口径同构）。
5. **宏注入**：`dxcMacroTable.ts` 是仓库内数据表（自写内置默认宏，如 `SHADER_API_*` 一类），每条带来源与 Unity 版本注记，**默认项一律带值**（内置头里有 `#if SHADER_API_D3D11` 这种不带 `defined()` 的写法，空值宏会让表达式为空）；叠加当前文件的对象式 `#define`（块内的经文本原样生效，块外的经 `-D` 注入；函数式 `#define F(x)` 不注入，`#undef` 由 DXC 在块内自然处理）；ADR 0008 的 Disabled 集合里的宏**一律不定义**（只做减法；文件里显式 `#define` 的不减，用户意图优先）。宏不可判定或编译整体失败 → **整块不产诊断**（宁可漏报，ADR 0009 同向）。
6. **include**：以 `includeResolver` 的四类规则为权威（相对 / `Assets/…` / `Packages/…` / 内置 `.cginc`），DXC 侧经 `-I` 根集合与必要的路径改写使同一份解析结果生效；**改写不得增删行**（坐标恒等的前提，只允许改路径字符串本身）；解析失败 → 记 `include-fail=<spec>` 且该块不产诊断。
7. **诊断映射**（输出格式经 2026-10-28 本机 v1.9.2609 实测更正）：DXC 前端输出是 **clang 风格** —— `<file>:<line>:<col>: error: <message>`，警告为 `<file>:<line>:<col>: warning: <message> [-Wflag]`；**语义错误没有错误码**，只有警告带 `[-Wflag]`。映射为 `Diagnostic`：`severity = Error`（警告首期不推）、`source = 'Unity Shader (DXC)'`、`code = <-W flag>`（无 flag 时不设 `code`）；Range 起点 `(line-1, col-1)`，列缺失或零宽时取该行首个非空白 token 的 Range。`note:` 行与 caret/源码上下文行忽略；**无法按该格式解析的行一律忽略**（不猜）。文案取 DXC 原文，不复制对标产品文案（设计原则 6）。
8. **与语法诊断互斥**（经用户确认）：所在文档若已有**语法诊断 Error**（feature-syntax-diagnostics），该文档的编译单元**不跑 DXC**，日志记 `skipped=syntax-error`；「include 未找到」Warning 不触发跳过。语法修好后下一次 `didSave` 自动恢复。
9. **触发与缓存**（经用户确认）：`didOpen`/`didSave`/`didChangeWatchedFiles` 触发；**`didChange` 不触发**（DXC 无增量，ADR 0010）。缓存键 = 文档版本 + 块字节区间 + 宏集指纹 + include 闭包指纹 + dxc 版本，命中则不 spawn。命令 `unityshader.runTypeDiagnostics`（title `Unity Shader: Run Type Diagnostics`）强制重算当前文档。并发上限 2，同一文档重算时 kill 掉未完成的子进程。
10. **豁免表**（经用户确认，ADR 0009 机制同构）：`dxcExemption.ts` 数据表，键 = **消息模式（必填）+ 可选 `-W` flag + 可选文件特征**（实测语义错误无错误码，故消息模式是主键；模式按**归一化后的消息**匹配：去掉数字、引号内标识符与类型参数后比较，避免 `vector<float, 4>` 这类变体各写一条）；命中 → 不产诊断；每条带 `id`、`reason`（「不豁免 + 理由」的反向记录：为什么这条错误在 Unity 写法下不可信）与**命中计数**；门槛脚本断言每条命中 > 0（grammar/宏表修好后删行，防豁免变永久债）。
11. **推送面**（经用户确认）：首期**只推 Range 落在当前文档内**的诊断；内置 `CGIncludes` 与包内文件里报出的错误不推给用户，但**计入门槛语料统计与豁免命中**。
12. **默认开关与门槛联动**（经用户确认）：`unityShader.typeDiagnostics`（boolean）。`npm run gate:type-diagnostics` PASS → `configurationDefaults` 为 `true`；FAIL → 为 `false`（用户可手动开）。当前基线预期 FAIL（DXC 尚未接入）→ 默认关闭。
13. **零误报门槛测试**（roadmap M5 第二条的测法，经用户确认为**零误报硬门槛**）：`test/corpus/typeDiagnosticsGate.mjs`，命令 `npm run gate:type-diagnostics`。语料复用 `diagnosticsGate.mjs`/`errorAudit.mjs` 的同一 `collectCorpus`（`BENCH_PROJECT`/`BENCH_EDITOR` 定位，50 工程 shader + 80+ 包内 `.hlsl` + 56 内置 include，**不造第三套**）；断言三源语料上**类型诊断总数 = 0**；打印**逐错误签名**聚合表（签名 = 归一化消息 + 可选 `-W` flag）与逐条豁免命中；语料缺失或本机 `dxc` 不可用 → `SKIP + 原因`（exit 0），绝不记 PASS；并断言 `client/package.json` 的 `configurationDefaults` 与门槛结果一致。
14. **配置项**（扁平命名，沿用现有 `unityShader.*` 风格）：`unityShader.typeDiagnostics`、`unityShader.dxcPath`、`unityShader.dxcTimeoutMs`、`unityShader.maxTypeDiagnosticsPerFile`（默认 100，超限按文档顺序截断并记 `truncated=`）。

## 不在范围

- **语法诊断**与「include 未找到」Warning → [feature-syntax-diagnostics.md](feature-syntax-diagnostics.md)（已交付）。
- **DXC 接管补全 / hover / definition / 签名帮助**（ADR 0010 明确不接管；M2/M3 的实现保持）。
- `.cginc`、`CGPROGRAM`、`GLSLPROGRAM` 的类型诊断（CG 语义不在范围）。
- **include 闭包内文件的诊断推送**（首期不推，见范围 11）。
- LSP pull diagnostics（`diagnosticProvider`）、`codeAction`/quick fix、诊断 `code` 链接文档站。
- 常驻编译服务、增量编译、编译结果跨文档共享（ADR 0010 已否）。
- macOS 自带产物（无官方预编译产物；自备 `dxcPath` 是唯一路径，ADR 0010 未决项）。
- 变体关键字（`multi_compile`/`shader_feature`）展开与逐变体编译。
- 复制对标产品的诊断文案或 `.std` 内容（设计原则 6）。

## 约束

- 只读唯一 CST（`parser.ts`）与 `includeResolver`；类型诊断层不新增解析路径（设计原则 2、ADR 0001）。
- **虚拟文档必须与原文等长**：换行数与每行字节数不变，坐标恒等是硬约束；任何路径改写只允许发生在同一行内。
- **宁可漏报不可误报**（ADR 0009）：编译失败、超时、宏不可判定、include 解析失败、`dxc` 缺失 → 一律整块不产诊断并记日志，不产「编译器不可用」这类诊断。
- 语法 Error 存在时不跑 DXC（范围 8）；类型诊断与语法诊断共用同一 URI 的一次 `publishDiagnostics`，两类合并推送、不互相覆盖残留。
- 子进程：不接交互式 stdin、不常驻、`kill` 可取消；stderr/stdout 有字节上限（超限视为编译失败）。
- 降级态（非 Unity 工程 / Editor 路径找不到）：include 根缺失 → 该块不产诊断，日志记 `degraded=skip-type-diag`（与语法诊断的 include 降级口径同构）。
- 性能：`didChange` 不触发所以不阻塞编辑；单编译单元编译 P95 < 1500 ms（bench 扩展项）；门槛脚本自报总耗时但不设硬断言（166 文件 × 编译，时长随机器变化）。
- 只对**已打开**的文档跑；未打开的磁盘文件不产类型诊断（与语法诊断不同）。

## 异常与边界

| 场景 | 行为 |
|---|---|
| 多 Pass 各有一个 `vert`/`frag` | 分块编译 → 零类型诊断（不报重复定义） |
| 文件里有语法 Error | 不跑 DXC，日志 `skipped=syntax-error`；已有类型诊断清空 |
| `dxc` 缺失 / macOS / 产物加载失败 | 零类型诊断 + 客户端一次性明确提示 + 日志 `dxc=missing`；其余功能不受影响 |
| 编译超时 | 该块零诊断 + `dxc=timeout` |
| 内置写法导致 DXC 整体编译失败 | 整块零诊断（不猜、不部分推），日志记失败摘要 |
| DXC 输出行不符合 clang 风格 | 忽略该行、不产诊断，日志记 `unparsed=<n>`（防把编译器内部噪声当诊断推给用户） |
| 命中豁免表 | 不产该条，日志 `exempted=<id>:<计数>` |
| 豁免行在语料上零命中 | 门槛脚本断言失败 → 提示删该行 |
| `#include` 四类规则均未命中 | 该块零诊断 + `include-fail=<spec>`（include 未找到 Warning 仍由语法诊断规格负责） |
| 编译期间文档被关闭或再次保存 | 结果按版本丢弃（版本不匹配不发布） |
| `unityShader.typeDiagnostics = false` | 不跑 DXC，已发布的类型诊断清空 |
| 门槛 FAIL（默认 `false`） | 默认关闭；用户手动开启后仍要过豁免与「整块失败即不产」 |
| `Temp/compiled-*`、`Temp/generatedFrom*` | 不产（core 规格 §7） |
| 单文件类型诊断超 `maxTypeDiagnosticsPerFile` | 按文档顺序截断 + `truncated=<总数>` |
| 非 Unity 降级态 | 该块不产类型诊断并记降级；语法诊断照常（不受影响） |
| server 崩溃重启 | 客户端重新 `didOpen` → 重新计算，无旧诊断残留 |

## 验收标准

每条映射到测试或可观察行为；基座为既有 vitest + vscode-test；语料策略沿用既有规格（自包含 fixture + 真实工程样本）。

- [ ] 注入 `float4 c = float3(1,1,1);` → 恰好 1 条 Error，Range 落在该行（vitest + vscode-test）
- [ ] 非法 swizzle（`c.wwwz`）→ 1 条 Error（vitest）
- [ ] **坐标恒等**：断言每块虚拟文档与原文等长、换行数相同；HLSLPROGRAM 内容在第 N 行 → 诊断行号 = N-1（vitest）
- [ ] **分块编译**：两个 Pass 各定义 `vert` → 零类型诊断（vitest）
- [ ] 语法 Error 互斥：造缺 `;` 的文件 → `dxcRunner` 调用计数 = 0 + 日志含 `skipped=syntax-error`（vitest spy）
- [ ] 触发面：`didChange` 后调用计数不变、`didSave` 后 +1（vscode-test 经 server 自报计数断言）
- [ ] 缓存：同版本重复 `didSave` → 调用计数不变（vitest spy）
- [ ] 超时：`unityShader.dxcTimeoutMs = 1` → 零诊断 + 日志 `dxc=timeout`（vscode-test）
- [ ] 编译器缺失：`unityShader.dxcPath` 指向不存在路径 → 零诊断 + 提示 + `dxc=missing`，F12/补全/语法诊断不受影响（vscode-test）
- [ ] 宏注入：`#if SHADER_API_D3D11` 分支内的符号可解析（默认宏表命中）→ 该分支内注入错误能报出（vitest）
- [ ] Disabled 只做减法：某宏在 Disabled 集合 → 其分支按未定义处理（vitest，复用 `unityKeywordSource` fixture）
- [ ] 豁免表：fixture 造命中 → 零诊断 + 日志 `exempted=`（vitest）
- [ ] 豁免冗余可发现：门槛脚本断言每条豁免命中 > 0（`npm run gate:type-diagnostics`）
- [ ] include 四类各一例经 `-I`/改写后 DXC 可解析（或明确记 `include-fail`，不得刷屏）（vitest）
- [ ] `.cginc` 与 `CGPROGRAM` 块 → 零类型诊断（vitest）
- [ ] 开关关闭 → 旧类型诊断清空、无新调用（vscode-test）
- [ ] 命令：`unityshader.runTypeDiagnostics` 强制重算并刷新计数（vscode-test）
- [ ] 并发与取消：连续两次 `didSave` → 第一次子进程被 kill，只发布最新版本（vitest）
- [ ] **零误报门槛**：`npm run gate:type-diagnostics` 对三源语料断言类型诊断总数 = 0、逐错误签名聚合表（归一化消息 + 可选 `-W` flag）、语料缺失或 dxc 不可用记 SKIP 而非 PASS（脚本 + CI）
- [ ] 输出解析：clang 风格 `error:`/`warning: … [-Wflag]` 各一例；`note:` 与 caret/源码上下文行忽略；不符合格式的行忽略不产诊断（vitest，用实测输出做 fixture）
- [ ] 门槛与默认值联动：PASS → `configurationDefaults` 为 `true`；FAIL → `false`（脚本断言 `client/package.json`）
- [ ] 性能：bench 扩展项「单编译单元 DXC 编译」P95 < 1500 ms（`npm run bench` 输出 PASS/FAIL）

## 对应模块

- `specs/feature-type-diagnostics.md` ↔ `server/src/typeDiagnostics.ts`（编译单元切分与虚拟文档生成、语法 Error 互斥、缓存键与并发/取消、诊断映射与截断、与语法诊断的合并发布）
- ↔ `server/src/dxcRunner.ts`（编译器定位、子进程 spawn/kill/超时、输出解析为 `{line,col,severity,code,message,file}` 列表，`code` 仅警告带 `[-Wflag]` 时存在）
- ↔ `server/src/dxcMacroTable.ts`（内置默认宏数据表 + Disabled 减法）、`server/src/dxcExemption.ts`（按消息模式的豁免表 + 命中计数，机制与 `errorExemption.ts` 同构）
- ↔ 复用 `server/src/parser.ts`（`extractProgramBodies`、`buildVirtualHlsl` 的等长空白化思路）、`server/src/includeResolver.ts`、`server/src/unityKeywordSource.ts`（Disabled 集合）、`server/src/diagnostics.ts`（语法 Error 判定与语料聚合口径）、`server/src/documentStore.ts`、`server/src/tempFiles.ts`
- ↔ `server/src/server.ts`：`didOpen`/`didSave`/`didChangeWatchedFiles` 接线、`unityshader/runTypeDiagnostics` 内部命令、`unityshader/__indexStats` 增加类型诊断计数、四个配置项读取
- ↔ `client/src/extension.ts` + `client/package.json`：四个 `unityShader.*` 配置项与 `configurationDefaults`（默认值随门槛）、编译器缺失提示
- ↔ 测试：`test/unit/typeDiagnostics.test.ts`、`test/unit/dxcRunner.test.ts`、`test/unit/dxcExemption.test.ts`、`test/src/suite/typeDiagnostics.test.js`、`test/corpus/typeDiagnosticsGate.mjs`（复用 `diagnosticsGate.mjs` 的 `collectCorpus`）
- 依赖：[feature-language-server-core.md](feature-language-server-core.md)（唯一 CST、include 四类、降级态、Temp 判定）、[feature-syntax-diagnostics.md](feature-syntax-diagnostics.md)（语法 Error 互斥、门槛语料与聚合口径）、[feature-dead-branch-dimming.md](feature-dead-branch-dimming.md)（Disabled 集合）、[../decisions/0010-dxc-subprocess-bundled-distribution.md](../decisions/0010-dxc-subprocess-bundled-distribution.md)、ADR 0004、ADR 0009、ADR 0005（原生分发面）
