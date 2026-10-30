# Unity Shader Tools

**简体中文** | [English](README.en.md)

为 Unity 开发者打造的 VSCode 插件：让 `.shader` / `.hlsl` 文件拥有完整的语言智能——转到定义、补全、
重命名、悬停、语法与类型诊断、格式化。解析采用自研 tree-sitter ShaderLab 语法与 HLSL 方言支持，
类型检查调用随扩展附带的官方 `dxc` 编译器——开箱即用，无需安装任何外部工具。

## 功能 — ShaderLab（`.shader`）

- 语法高亮（关键字、属性、Pass、语义）
- 格式化文档（幂等，失败即不改）：ShaderLab 外壳与 `CGPROGRAM` / `HLSLPROGRAM` / `GLSLPROGRAM` 内部
  按块深度重排；行内空白规范化与行尾 `}` 拆行（各有开关）
- 转到定义 / 速览定义（跨文件，跟随 `#include`，支持 CGIncludes 与 Unity 包路径）
- 悬停查看定义（着色器名、属性、HLSL 符号；常见 Unity 内置函数经随包 CGIncludes 索引）
- 查找所有引用
- 重命名符号（着色器名，两步流程）
- 补全（`Fallback` / `UsePass` 着色器名、`#include` 路径、`.` 后的 HLSL 成员）
- 语法诊断 + 条件编译死分支灰化
- DXC 类型诊断（按平台附带官方 `dxc`，无需安装）
- 变体计数报告（含材质证据，命令面板）
- 转换语言模式命令（与 Unity for VS Code 共存，不改用户设置）

## 功能 — HLSL（`.hlsl` / `.hlslinc` / `.cginc`）

- 语法高亮与格式化（`.cginc` 全文同样排版）
- 跨文件转到定义、悬停、查找所有引用
- 补全（`.` 后成员、include 路径）

## 说明

- 原生组件按平台随 vsix 附带：win32-x64/arm64、linux-x64/arm64、darwin-x64/arm64；
  未覆盖的平台会明确报加载失败，而不是静默失去智能
- 与 Unity for VS Code（VSTU）可共存：默认不改任何用户设置，需要时可用「转换语言模式」命令接管

源码与问题反馈：<https://github.com/xiake-1/unity-shader-tools>
