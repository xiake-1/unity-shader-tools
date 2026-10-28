---
adr: 0007
date: 2026-10-28
title: fork tree-sitter-hlsl 为 workspace 包 hlsl/，grammar 补丁本地维护
---

# 0007 · fork tree-sitter-hlsl 为 workspace 包 hlsl/，grammar 补丁本地维护

## 背景

手动测试（2026-10-28）暴露：F12 找不到 `UnityObjectToWorldNormal`、`appdata_base`。
诊断事实：`UnityCG.cginc` 被 tree-sitter-hlsl@0.2.0 解析成整文件级联 ERROR——struct 体内的
「裸宏成员」（`UNITY_VERTEX_INPUT_INSTANCE_ID`，无类型无分号）使 `field_declaration` 失败，
收尾 `};` 变 ERROR 并级联吞掉整个 `#ifndef` 块，声明全部从索引消失。审计全 HLSL 语料
（CGIncludes + PackageCache + 真实工程，205 个 `.hlsl/.cginc/.hlslinc`）还发现第二根因：
跨行宏（`\` 续行）体内的 `/* */` 块注释使 `preproc_arg` 截断（UnityPBSLighting /
UnityLegacyTextureStack 等）。

上游 [tree-sitter-grammars/tree-sitter-hlsl](https://github.com/tree-sitter-grammars/tree-sitter-hlsl)
最新即 0.2.0（2025-03），无修复；提 PR 不可控排期。备选：

1. **fork 为 workspace 包本地打补丁**（选定）；
2. 索引侧对含 ERROR 文件做文本兜底解析——违反 ADR 0001 单 CST 原则，否决；
3. 换 grammar（tree-sitter-c 直用 / 自写 HLSL grammar）——成本与风险远大于补丁，否决；
4. 等上游——用户可见缺陷不能挂起，否决。

## 决策

把 tree-sitter-hlsl@0.2.0 复制为 workspace 包 `hlsl/`（同名 `tree-sitter-hlsl`，版本 0.2.1），
server 依赖经 npm workspaces 解析到本地包；grammar.js 打两处补丁——
① `_field_declaration_list_item` 扩展点挂 `macro_member`（struct 体内裸宏成员/宏调用成员）；
② `preproc_arg` 字符类允许 `/* */` 块注释（跨行宏体）——`tree-sitter generate` +
`node-gyp rebuild` 重新生成 `src/parser.c` 与原生绑定（ABI 14，与运行时 tree-sitter@0.22 兼容）。

## 后果

- 正：修复 UnityCG.cginc 等内置库整文件级联 ERROR，F12/补全/引用/改名的符号覆盖恢复；
  补丁有语料测试（`hlsl/test/corpus/unity-macros.txt`）与单测回归钉住；仍是单 CST（ADR 0001 不破）。
- 负：从此 hlsl grammar 由本项目维护——升级上游需重新对补丁 rebase（`hlsl/README.md` 记录
  来源版本与补丁清单）；ADR 0005 的 prebuild 分发流水线（M5）必须从本 fork 出产物而不是 npm 包；
  `parser.c`（约 20 MB）随仓库提交。
- 已知限制（补丁未覆盖，登记 backlog）：`#if` 块内开括号块外闭括号的 C 预处理模式
  （AutoLight.cginc、UnityStandardCore.cginc 参数列表）不预处理无法解析；文件作用域带
  primitive 参数的裸宏调用（`UNITY_DEFINE_INSTANCED_PROP(float, x)`）与 cpp 顶层文法冲突面过大；
  ShaderGraph 模板文件的 `$` 占位符与 ffx 的宏 typedef 非合法 HLSL。
