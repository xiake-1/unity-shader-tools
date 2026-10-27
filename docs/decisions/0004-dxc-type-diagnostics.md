---
adr: 0004
date: 2026-10-27
title: HLSL 类型诊断外包给 DXC，不自研类型系统
---
# ADR 0004 · 类型诊断外包 DXC

## 背景

类型/语义诊断（维度不匹配、非法 swizzle、未定义符号）是对标产品真正的护城河，其自研类型系统占 L3 层 1～3 个月工作量（[../../分析/06-feasibility-and-roadmap.md](../../分析/06-feasibility-and-roadmap.md) §0）。三条路判定完全不同（[../../分析/10-feature-feasibility.md](../../分析/10-feature-feasibility.md) §5b）：

- **完整自研类型系统**（向量/矩阵维度、swizzle、重载解析、隐式转换全套）：1～3 月，按已确认范围（只 HLSLPROGRAM）明显不划算；
- **表驱动半自研**（只做未定义符号 + 明显维度错误）：4～8 周，误报风险高 —— 必须先有宏展开 + include 闭包，否则 `SAMPLE_TEXTURE2D` 这类宏里的标识符会刷屏；
- **DXC `IDxcIntelliSense`**：+3～5 周，编译器级质量（DXC 就是 Unity 2021+ 实际使用的 HLSL 编译器）。

硬约束：误报零容忍（project.md 设计原则 4）—— 对标产品 CHANGELOG 曾因误报把诊断默认关闭。

## 决策

HLSL 类型与语义诊断外包给 DirectX Shader Compiler 的 `IDxcIntelliSense`；语法诊断由 tree-sitter `ERROR`/`MISSING` 节点自产（ADR 0001）；不自研 HLSL 类型系统。

## 后果

- 正面：诊断质量是编译器级而非启发式；无需长期维护类型系统；自带 `dxc.exe` 仅几 MB 量级（Unity 只有 `dxcompiler.dll`、无独立 exe，见 [../../分析/09-implementation-options.md](../../分析/09-implementation-options.md) §0），远小于对标产品的 31MB 引擎。
- 负面（接受）：工程量集中在胶水层 —— `HLSLPROGRAM` 抽成虚拟 `.hlsl` 与 `.shader` 的**双向行号映射**、`SHADER_API_*` 等宏注入、include 路径映射；DXC 无增量解析，需结果缓存；多一个原生分发物。
- 默认策略随之确定：类型诊断在官方语料（80+ 包内 + 56 内置 + 50 工程 shader）达到零误报前默认关闭或降级为 Hint（roadmap M5 验收口径）。
