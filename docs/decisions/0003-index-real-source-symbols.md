---
adr: 0003
date: 2026-10-27
title: 内置与包内符号来自索引真实源码，不手写 stub 库
---
# ADR 0003 · 内置符号索引真实源码

## 背景

「Unity 引擎内建/包内符号」（`UnityObjectToClipPos`、`TransformWorldToHClip`、`UNITY_MATRIX_*` 等）从哪来，直接决定 F12 体验与长期维护成本。本机事实：内置 `Editor\Data\CGIncludes\` 56 个、包内 `Library\PackageCache\com.unity.render-pipelines.*` 80+ 个 `.hlsl/.hlslinc`（[../分析/09-implementation-options.md](../分析/09-implementation-options.md) §0）。备选（同文档子问题 B）：

- **B1 手写 stub 库**（对标产品路线：`unity.std`/`values.std` 等 8 个文件 + `///` 文档）：文档可控，但维护成本永久存在、Unity 版本一变即过时，且**跳不到真实声明行** —— 它对内置库故意不跳转（definition 对 `.std` 返回 null，见 [../分析/03-language-server.md](../分析/03-language-server.md) §4、[../分析/10-feature-feasibility.md](../分析/10-feature-feasibility.md) §1）；
- **B2 索引真实引擎与包源码**：复用 A3 解析层（ADR 0001），3～5 天，F12 真跳到 `Core.hlsl:123`；
- **B3 以 DXC IntelliSense 作符号来源**：语义最准，但 ShaderLab 外壳它不管，且分发/映射成本已归入类型诊断（ADR 0004），不承担符号索引。

## 决策

内置与包内符号一律通过索引真实源码获得：`Editor\Data\CGIncludes\*`、`Library\PackageCache\com.unity.render-pipelines.*\ShaderLibrary\**`、`Packages\`、`Assets\`；不手写、不维护任何 stub 声明库。

## 后果

- 正面：F12 跳进真实声明行 —— 这是 project.md 成功标准里明确要**超过对标产品**的一点；零维护成本，随 Unity/包版本自动更新；顺带免费获得 `#include` 路径补全、`#define` 宏补全与变体关键字提取（[../分析/09-implementation-options.md](../分析/09-implementation-options.md) §5）。
- 负面（接受）：内置源码里宏包裹声明（`CBUFFER_START(...)`、`TEXTURE2D(...)`）需维护约 30～50 条已知宏展开规则表；索引源路径必须按 `ProjectVersion.txt` + `manifest.json` 动态定位，不能硬编码；冷启动索引量上升 —— 已设 <3s 预算（规格 feature-language-server-core）。
- 合规：不复制对标产品的 `.std` 文件与文档文本（project.md 设计原则 6）。
