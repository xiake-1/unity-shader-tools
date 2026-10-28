---
status: active
updated: 2026-10-28
---
# sprint-05

## 迭代目标

完成 roadmap **M5 类型诊断（DXC）与格式化**：把每个 `program_hlsl` 块切成独立编译单元、经短命子进程调 DXC 做语义检查，
诊断坐标恒等落回 `.shader` 行列（官方语料零误报门槛达标前默认关闭、可手动开启）；全自写 CST 打印器做分层格式化
（ShaderLab 外壳 + `HLSLPROGRAM` 内部），未识别结构与 `ERROR` 区字节级原样输出，门槛不达标则不注册 formatting provider。
顺带把发布流水线（多平台 prebuild + dxc 产物 + vsce）落到可跑状态。

功能规格：[../specs/feature-type-diagnostics.md](../specs/feature-type-diagnostics.md)、[../specs/feature-formatting.md](../specs/feature-formatting.md)；
跨模块选型依据 [ADR 0010](../decisions/0010-dxc-subprocess-bundled-distribution.md)、[ADR 0011](../decisions/0011-self-written-cst-formatter.md)，
误报控制承接 [ADR 0009](../decisions/0009-syntax-diagnostics-error-exemption.md)，发布面承接 [ADR 0005](../decisions/0005-grammar-prebuild-distribution.md)。

**顺序约束**：T-049 先行 —— `dxc` 产物与定位不可用时，门槛脚本与诊断接线都跑不起来（ADR 0010）；
其后 T-050～T-053（编译单元 / runner / 宏表 / include）→ T-054～T-055（诊断核心与豁免表）→ T-056（接线）→ T-057（门槛）→ T-058（集成与 bench）。
T-057 的「每条豁免命中 > 0」断言依赖 T-055 的表存在。
格式化侧（T-059～T-065）**不依赖 DXC**，可与类型诊断并行；T-066/T-067 属发布面，不阻塞前两组，但 T-067 的 vsix 实测体积结论须在收口前给出（ADR 0010 已更正过体积口径）。

## 选入任务 ID

T-049、T-050、T-051、T-052、T-053、T-054、T-055、T-056、T-057、T-058、
T-059、T-060、T-061、T-062、T-063、T-064、T-065、T-066、T-067

（任务详情与状态一律以 [backlog.md](backlog.md) 为准。）

## 范围边界（本轮不做）

- Unity Editor 包侧（M6）：变体裁剪、工程元数据桥 —— 类型诊断的宏来自自写默认宏表，本轮不引入包桥（ADR 0008 / ADR 0010 登记的「M6 桥是否取代 Editor.log 与内置宏表」保持未决）
- **include 闭包内文件的诊断推送**：首期只推 Range 落在当前文档内的诊断（feature-type-diagnostics 范围 11）
- **DXC 接管补全 / hover / definition / 签名帮助**（ADR 0010 明确不接管，M2/M3 实现保持）
- `.cginc` 与 `CGPROGRAM`/`GLSLPROGRAM` 的类型诊断与内部排版（CG 语义不在范围）
- `rangeFormatting`、`onTypeFormatting`、`.editorconfig` 支持（feature-formatting 不在范围）
- 常驻编译服务、增量编译、`multi_compile`/`shader_feature` 逐变体编译（ADR 0010）
- macOS 附带 dxc 产物（官方无预编译产物；自备 `dxcPath` 是唯一路径，ADR 0010 未决项）
- LSP pull diagnostics（`diagnosticProvider`）、codeAction / quick fix、风格类 lint
- ADR 0006 第 2/3 层（运行时语言 id 自愈、`Fix file associations`，待规格）
- 第二个 HLSL 格式化器（shaderc `shader_format`）、WASM 或原生格式化依赖（ADR 0011 已否）

## 迭代验收条件

- roadmap M5 全部阶段标准通过（[roadmap.md](roadmap.md) M5 节）
- 两份规格「验收标准」节中与本迭代任务对应的条目通过，其中硬性项：
  - `npm run gate:type-diagnostics` 对三源语料（80+ 包内 / 56 内置 / 50 工程 shader）断言**类型诊断总数 = 0**，语料缺失或 dxc 不可用记 `SKIP` 而非 `PASS`；PASS → `configurationDefaults.unityShader.typeDiagnostics = true`，FAIL → `false` 且可手动开；
  - **坐标恒等**：每块虚拟文档与原文等长、换行数相同；两个 Pass 各定义 `vert` → 零类型诊断；
  - 已有语法 Error 的文档不跑 DXC（调用计数 = 0 + 日志 `skipped=syntax-error`）；`didChange` 不触发；
  - `npm run gate:format` 三条断言（两次格式化字节相同 / 去 trivia 叶子 token 序列不变 / 逐行 strip 空白后相同），FAIL → server 不宣告 `documentFormattingProvider`；
  - 原样输出区（`ERROR`、ADR 0007 不可修模式、CG/GLSL 内容）字节不变，日志 `verbatim=`
- 回归不劣化：语法诊断门槛 `gate:diagnostics` 仍 PASS、rename 零误改语料、F12 / 补全 / 悬停 / 灰化既有断言全绿；bench 既有项不劣化
- 验证命令：`npm run build`、`npm test`、`npm run test:vscode`、`npm run bench`、`npm run gate:diagnostics`、`npm run gate:type-diagnostics`、`npm run gate:format`
