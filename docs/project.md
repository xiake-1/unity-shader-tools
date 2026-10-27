---
status: active
updated: 2026-10-27
---
# 项目概览

## 目标

自研一个 Unity Shader 编程支持的 VSCode 插件，把对标产品 **Omni Shader Tools for Unity** 划入付费档的能力
（转到定义、引用与重命名、完整语义补全、代码格式化、错误诊断、Live Testing）做成本地可用的实现。

成功长什么样（在真实 Unity 工程里打开 `.shader` 文件）：

- `F12` 能跳到**工程内、包内（`Library/PackageCache`）、引擎内置（`Editor/Data/CGIncludes`）的真实声明行**
  —— 这一点要超过对标产品（它对内置库故意不跳转）
- 补全能识别 `#include` 路径、结构体成员、已知 Unity 宏
- `Rename` 不误改注释、字符串、未激活 `#if` 分支、同名不同作用域的符号
- 语法错误有红波浪线；类型错误由 DXC 给出编译器级诊断
- 官方 shader 语料（包内 80+ `.hlsl`、内置 56 个 include、工程内 50 个 shader）**零误报**

## 范围

- **在范围内**
  - `HLSLPROGRAM` / URP / HDRP 现代写法；`.shader`、`.hlsl`、`.hlslinc`、`.cginc`（后两者仅做 include 解析与索引，不做 CG 语义）
  - 转到定义、引用与重命名、完整语义补全、语法诊断、类型诊断（DXC）、`#if` 死分支灰化、代码格式化
  - Unity Editor 包：构建期变体裁剪规则、`IPreprocessShaders` 实现、工程元数据桥
- **不在范围内**
  - `CGPROGRAM` 与固定管线语法（`Cull`/`Blend`/`Stencil` 等 legacy Pass 状态）的语义支持
  - 自研 HLSL 类型系统（向量/矩阵维度、swizzle、重载解析）—— 外包给 DXC
  - 商业授权、订阅、机器绑定
  - 私有 HTTP 协议（走标准 LSP）
  - Visual Studio / Rider 客户端（走 LSP 使其将来可行，但首期不做）
  - ShaderGraph 资产支持

## 技术栈

- 客户端：TypeScript + VSCode Extension API + `vscode-languageclient`
- 传输：标准 LSP（stdio）
- 语言服务端：TypeScript / Node 进程
- 解析层：**tree-sitter** —— 现成 `tree-sitter-hlsl` + 自写 `shaderlab` grammar（ShaderLab 外壳 + 预处理器）
- 类型诊断：DirectX Shader Compiler（DXC）`IDxcIntelliSense`
- 内置符号来源：索引真实源码（`Editor/Data/CGIncludes`、`Library/PackageCache/com.unity.render-pipelines.*`、`Packages/`、`Assets/`）
- 测试：`vitest`（解析与索引单测）+ `@vscode/test-electron`（Provider 集成）
- Unity 侧：C# Editor 包，目标 Unity 2022.3+
- 打包与分发：client 用 esbuild bundle、server 用 tsc 不 bundle；grammar 与 tree-sitter 运行时以 **N-API prebuilds 随单一 VSIX 附带**（不在安装期编译、不走 WASM，见 ADR 0005）
- 语言 id：`.shader` → `unityshader`，`.hlsl/.hlslinc/.cginc` → `hlsl`；与 VSTU 的 `UnityShader` 共存策略见 ADR 0006

## 总体设计原则

1. **索引真实源码，不手写 stub 库** —— 内置符号来自引擎与包的真实 `.hlsl/.cginc`，随 Unity 版本自动更新，零维护成本。
2. **一套 AST/CST 服务所有功能** —— 解析层只有一个（tree-sitter），补全/跳转/引用/诊断/格式化共用，不允许各功能各自正则。
3. **语义正确性外包给编译器** —— HLSL 的类型与诊断交给 DXC；自研只做 ShaderLab 外壳、include 解析、Unity 关键字注入。
4. **误报零容忍门槛** —— 任何诊断类功能，官方语料达不到零误报就不默认开启（对标产品正是因为误报把诊断改成默认关闭）。
5. **走标准 LSP，不造私有协议** —— 换取跨编辑器接入与将来 Unity CLI 复用。
6. **不复制对标产品的闭源资产** —— grammar、`.std` 内容、文档文本一律自行整理；分析文档只作设计参考。
