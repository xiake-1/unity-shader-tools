---
adr: 0011
date: 2026-10-28
title: "格式化引擎：全自写 CST 打印器，不引入第二个 HLSL 解析器或外部格式化依赖；未识别结构字节级原样输出"
---
# 0011 · 格式化用什么引擎

## 背景

roadmap M5 第三条要求「格式化分层（ShaderLab 外壳 / `HLSLPROGRAM` 内部），两次格式化幂等，官方语料 diff 仅空白变化」（[../plan/roadmap.md](../plan/roadmap.md) M5）。这条验收怎么实现，取决于一个尚未记录的选型：排版由谁产出。

forces：

- 格式化必须**保留全部 token 与 trivia**（注释、空行、原始空白），只有 CST 级解析层能承载（[../分析/10-feature-feasibility.md](../分析/10-feature-feasibility.md) §4）；地基已由 ADR 0001 定下（唯一 tree-sitter CST）。
- 现成件只有一个：shaderc 的 `shader_format`（shader-formatting，支持 HLSL/GLSL，有 WASM 版），**它不懂 ShaderLab，直接喂整个 `.shader` 会破坏 `Properties`/`Pass` 结构**（[../分析/10-feature-feasibility.md](../分析/10-feature-feasibility.md) §4）。
- 对标产品也是自己写打印器：「格式化基本得自己写」（[../分析/06-feasibility-and-roadmap.md](../分析/06-feasibility-and-roadmap.md) §M2）、「CST → 文本，带 4 个可配置开关」（[../分析/08-pro-feature-gap-analysis.md](../分析/08-pro-feature-gap-analysis.md)），开关争议之大见 [../分析/10-feature-feasibility.md](../分析/10-feature-feasibility.md) §4。
- **设计原则 2 / ADR 0001**：一套 AST/CST 服务所有功能，不允许各功能另起解析路径。委托 `shader_format` 等于让它**再 parse 一遍 HLSL** —— 第二个解析器、第二套结构知识。
- ADR 0005 已否 WASM（Node 里明显更慢 + 要引入第二运行时）→ 走 `shader_format` 要么 WASM（与 0005 的取向冲突）、要么原生 shaderc（第三个原生件，叠加 ADR 0010 刚更正的体积）。
- 风险定位：格式化是「错一次就要修 grammar」的最高风险功能（[../分析/10-feature-feasibility.md](../分析/10-feature-feasibility.md) §4）；与 M3 Rename 同构的信任判断 —— **改错比不改更伤**（同文档 §2）。

备选：

- **G1 全自写 CST 打印器**（选定）：ShaderLab 外壳与 `HLSLPROGRAM` 内部都从唯一 CST 重排。
- **G2 全委托 `shader_format`**：代码最省；但它不懂 ShaderLab，喂 `.shader` 会破坏结构，等于把最高风险功能交给一个不认识目标语言的组件 → 否。
- **G3 混合：外壳自写 + `HLSLPROGRAM` 内部委托 `shader_format`**：切块边界天然（grammar 已识别程序块边界），HLSL 排版质量外包；代价 = 第二个 HLSL 解析器（与设计原则 2 冲突）+ WASM/原生分发张力（与 ADR 0005 冲突面）+ 两套风格开关要强行统一语义 + shaderc 对 Unity 特有写法（`CBUFFER_START(...)`、裸宏声明、ADR 0007 的补丁面）的处理未知 → 否，留作复议项。
- **G4 只格式化 ShaderLab 外壳、`HLSLPROGRAM` 内部不动**：风险最低、最快交付；但「格式化 HLSL」正是对标产品划在付费墙上的能力（[../分析/08-pro-feature-gap-analysis.md](../分析/08-pro-feature-gap-analysis.md)），等于砍掉该功能的主要用户预期 → 否。

## 决策

格式化**全自写**：输入只有唯一 CST（tree-sitter 节点 + trivia），ShaderLab 外壳与 `HLSLPROGRAM` 内部由同一套打印器重排；**不引入第二个 HLSL 解析器、不引入 WASM 或原生格式化依赖**。硬约束：**未识别的 ShaderLab 结构与落在 `ERROR` 节点下的内容一律字节级原样输出**（保守不重排，与 ADR 0009「宁可漏报不可误报」同向）。

## 后果

- 正面：零新分发物 —— 不与 ADR 0010 的 DXC 体积叠加，ADR 0005 的 prebuild 面保持不变；与设计原则 2 / ADR 0001 一致，grammar 与格式化共用同一份结构知识：grammar 修好 → 格式化覆盖率立即受益，格式化用例也会暴露 grammar 缺口（与 ADR 0007/0009 的补丁面反馈回路同构）；4 个风格开关与 `.editorconfig` 的语义完全自控，不必迁就外部组件的默认风格；trivia 无损由 CST 保证。
- 负面（接受）：
  - HLSL 排版规则（换行、空格、大括号位置、宏缩进、注释与空行处理）全部自写，工期按 [../分析/10-feature-feasibility.md](../分析/10-feature-feasibility.md) §4 估 2～3 周，且是 M5 里风险最高的一项。
  - **格式化覆盖率的上限 = grammar 覆盖率**：`ERROR` 节点覆盖的区域与 ADR 0007 的三类不可修模式只能原样输出，用户会看到「有的块排了、有的没排」。这是本决策主动选择的失败方向（不排 > 排错）。
  - 风格争议不可能穷尽：只能靠开关 + 幂等 + 「语料 diff 仅空白变化」门槛兜底，无法让所有用户满意。
- 硬约束（交规格钉住，不属本 ADR 细节）：两次格式化幂等；官方语料 diff 仅空白变化（门槛脚本与 ADR 0009 的语料/聚合口径复用，不造第三套）；未识别块与 `ERROR` 区域字节原样；注释与空行的保留口径；`rangeFormatting` / `onTypeFormatting` 是否纳入首期属规格范围点。
- 与既有 ADR 的关系（均不取代）：**0001** 的唯一 CST 原则正是本决策的依据，本 ADR 是它在格式化上的应用；**0005** 无冲突（不新增原生件、不引入 WASM）；**0010** 与本决策相互独立（DXC 不参与格式化，格式化也不产诊断，不进诊断集合）。
- 复议条件（登记，不预写取代关系）：若自写打印器在「官方语料 diff 仅空白变化」门槛上长期不达标，可复议 G3（外壳自写 + HLSL 内部委托）；届时须另立 ADR 处理「第二解析器 vs 设计原则 2」的张力与 WASM/原生分发面。
- 落地边界（不在本 ADR 内）：须先由 /project-spec 立 `feature-formatting`（开关命名与默认值、trivia 与注释口径、「未识别块」的判定规则、覆盖的文件类别、门槛脚本与断言），排期（留在 M5 还是按 [../分析/10-feature-feasibility.md](../分析/10-feature-feasibility.md) §4/§6 的「优先级最低、建议排最后」挪到 M6 之后）交 /project-plan 判断。
