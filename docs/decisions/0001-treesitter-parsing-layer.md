---
adr: 0001
date: 2026-10-27
title: 解析层采用 tree-sitter（自写 shaderlab grammar + 现成 tree-sitter-hlsl）
---
# ADR 0001 · 解析层采用 tree-sitter

## 背景

所有语言功能（跳转、引用、Rename、补全、语法诊断、格式化）都依赖解析层；roadmap 的 M4 语法诊断
（tree-sitter `ERROR`/`MISSING` 节点）与 M5 格式化（要求 CST 字节级无损、保留 trivia）只有 AST/CST 级
解析层才能承载。备选（详见 [../../分析/09-implementation-options.md](../../分析/09-implementation-options.md) 子问题 A）：

- **A1 正则/行级声明扫描**：3～5 天起步最快，但作用域感知与 trivia 保留缺失 → Rename/格式化质量不可接受（[../../分析/10-feature-feasibility.md](../../分析/10-feature-feasibility.md) §2/§4）；
- **A2 手写声明级递归下降 parser**：~97% 覆盖，1～2 周，但增量解析、错误恢复、trivia 全要自己造；
- **A3 tree-sitter：现成 `tree-sitter-hlsl` + 自写 `shaderlab` grammar**：完整 AST，增量解析免费，grammar 可跨编辑器复用；
- **A4 复用 pema99/UnityShaderParser（C#）**：与已确认的 TS 技术栈（ADR 0002）冲突，且对「只支持 HLSLPROGRAM」是过度投入。

## 决策

解析层采用 A3：HLSL 程序块用现成 `tree-sitter-hlsl`（MIT），ShaderLab 外壳（Shader/SubShader/Pass/Properties/Tags/程序块边界/预处理器）自写 `shaderlab` grammar；一套 CST 服务所有功能，不允许各功能另起解析路径。

## 后果

- 正面：语法诊断与格式化从此有地基；tree-sitter 增量解析免费；grammar 将来可给 Neovim/Zed 等复用；补全/跳转/引用共用 Query 抓字段，不必各写遍历。
- 负面（接受）：ShaderLab grammar 无现成件，约 500～900 行 `grammar.js`，调试曲线陡（3～5 周含调试）；`tree-sitter-hlsl` 对 Unity 特有语法（`CBUFFER_START(...)`、`TEXTURE2D(name)`）需扩展。
- 反面经验不照抄：对标产品用 grammar 枚举 32 种大小写组合实现 ShaderLab 大小写不敏感 —— 我们用外部 scanner / `#eq?`（见 [../../分析/06-feasibility-and-roadmap.md](../../分析/06-feasibility-and-roadmap.md) §1）。
- 未决（不在本 ADR 范围）：grammar 用 native 还是 WASM binding、打包工具 esbuild/tsup —— 待 T-001 落地时决策，如构成取舍再立新 ADR。
