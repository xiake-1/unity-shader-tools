# 09 · 实现方案枚举（目标：补全 + F12 转到定义，仅 HLSLPROGRAM）

> 已确认范围：
> - 功能：**自动补全** + **F12 转到定义**（含 shader 内声明的变量、Unity 内建/包内声明的变量）
> - 语法：**只需 `HLSLPROGRAM`**（URP/HDRP 现代写法），不需要 CGPROGRAM / 固定管线
> - 行为标准：**自己定**，不用它的 Pro 试用
>
> 这个范围比"完整 Pro"小一个数量级：**不需要类型系统、不需要诊断引擎、不需要格式化器**。
> 真正需要的只有三件事：① 声明级解析 ② include 解析 ③ 符号索引。

## 0. 本机事实（已核实，决定方案可行性）

| 事实 | 值 | 用途 |
|---|---|---|
| 测试工程 | `D:\Work\Unity\ShaderStudy`，Unity **2022.3.62f1c1** | — |
| Unity 编辑器 | `D:\Soft\Work\Unity\UnityEditor\2022.3.62f3c1\Editor` | 内置 include 来源 |
| 内置 CG include | `Editor\Data\CGIncludes\` **56 个**（含 `UnityCG.cginc`、`HLSLSupport.cginc`、`Lighting.cginc`） | 内建变量/函数真实声明 |
| 包内 HLSL | `Library\PackageCache\com.unity.render-pipelines.core@14.0.12\` **80+ 个 `.hlsl/.hlslinc`** | URP/Core.hlsl 真实声明 |
| 工程 shader | `Assets\` 下 **50 个** `.shader/.cginc/.hlsl` | 规模很小 |
| DXC | `Editor\Data\Tools\dxcompiler.dll` 存在，**无独立 `dxc.exe`** | 走 DXC 需自带编译器 |
| 关键字注入源 | `%LOCALAPPDATA%\Unity\Editor\Editor.log` 里有 **`Disabled keywords: SHADER_API_GLES30 UNITY_COLORSPACE_GAMMA …`** | 后续做 `#if` 死分支灰化的免费数据源 |

**规模结论**：50 个工程 shader + 56 个内置 cginc + 80 个包内 hlsl ≈ 几千个符号。**单进程 TypeScript 就能吃下，不需要原生二进制、不需要独立 server 进程。**

---

## 1. 三个子问题，每个的可选方案

### 子问题 A：解析层（怎么从文件里拿到声明）

| 方案 | 做法 | 覆盖度 | 成本 | 上限 |
|---|---|---|---|---|
| **A1 正则/行级声明扫描** | 只匹配声明形态：`float4 _MainTex_ST;`、`struct v2f {…}`、`void vert(appdata v)`、`#include`、`Properties{ _Tex("x",2D)=… }` | 声明级 **~90%**（跨行声明、宏生成声明会漏） | **3～5 天** | 补全/F12 够用；做引用/重命名会开始漏 |
| **A2 手写递归下降 parser（只解析声明子集）** | 自己写 tokenizer + 声明级 parser，跳过函数体 | **~97%** | 1～2 周 | 可控，可增量演进到引用/重命名 |
| **A3 tree-sitter：现成 `tree-sitter-hlsl` + 自写 ShaderLab 外壳 grammar** | HLSL 部分用现成 grammar，`Shader{SubShader{Pass{HLSLPROGRAM…}}}` 外壳自己写 grammar | **完整 AST** | 3～5 周（含 grammar 调试） | 所有 LSP 功能的地基；跨编辑器复用 |
| **A4 复用 `pema99/UnityShaderParser`（C#）** | 用它做 C# LSP server 的解析层 | ShaderLab+HLSL 完整 | 2～3 周（含 server 壳） | 只适合走 C# 技术栈；对"只要 HLSLPROGRAM"是过度投入 |

### 子问题 B："Unity 编辑器变量"从哪来（这是他们要的第二类变量）

| 方案 | 做法 | F12 体验 | 成本 | 评价 |
|---|---|---|---|---|
| **B1 手写 stub 库**（Omni Shader 路线） | 自己整理 `unity.std`/`values.std`：`float4x4 UNITY_MATRIX_MVP;` + `///` 文档 | **跳不到真实源码**（它就是靠对 `.std` 返回 null 回避的） | 2～4 周整理 | 文档可控，但维护成本永久存在，且 Unity 版本一变就过时 |
| **B2 索引真实引擎与包源码** ⭐ | 直接解析 `Editor\Data\CGIncludes\*.cginc`（56）+ `Library\PackageCache\com.unity.render-pipelines.*\ShaderLibrary\*.hlsl`（80+）+ `Packages\` + `Assets\**\*.hlsl` | **F12 真跳到 `Core.hlsl:123` 的声明行** | 3～5 天（复用 A 的解析层） | **比 Omni Shader 更好**，零维护成本，随 Unity 版本自动更新。缺点：内置 cginc 里的声明带宏（`CBUFFER_START(UnityPerFrame)`），解析层要能处理 |
| **B3 DXC `IDxcIntelliSense`** | 把 `HLSLPROGRAM` 内容抽成虚拟 `.hlsl` 喂给 DXC，补全/跳转/成员访问全用它 | 真·HLSL 语义（重载解析、struct 成员） | 3～5 周（COM 绑定 + 行号映射） | 语义最准，但要自带 `dxc.exe`（Unity 只有 `dxcompiler.dll`），且 ShaderLab 外壳它不管 |

> **B2 是这次分析里最值钱的发现**：Omni Shader 对内置库选择"跳不过去"，而真实源码就在 `PackageCache` 和 `CGIncludes` 里，索引它比手写 stub 库更准、更省、还更强。

### 子问题 C：宿主形态

| 方案 | 做法 | 成本 | 取舍 |
|---|---|---|---|
| **C1 纯扩展内实现（无 server）** | Provider 直接在扩展进程里查内存符号表 | 最低 | 这个规模完全够；缺点：语义逻辑绑死 VSCode API，将来做 CLI/Unity 侧要重构 |
| **C2 标准 LSP（`vscode-languageclient` + 独立 server）** | server 可以是 Node/TS 进程（不必是原生二进制） | +3～5 天 | 白拿 Rider/Neovim/Zed 接入；将来 Unity 侧 CLI 复用同一 server；调试用 LSP inspector |

> Omni Shader 用私有 HTTP 是历史选择（要同时服务 VS/Unity/CLI）。**自研没有理由不走标准 LSP。**

---

## 2. 组合出的四个可执行方案

### 方案 1 · 最小可用（推荐先做这个）
**A1 正则声明扫描 + B2 真实源码索引 + C1 单进程 TS**

- 工期：**2～3 周**（含 tmLanguage、snippets、测试）
- 交付：补全（当前文件符号 + 工程符号 + 内置/包内声明，带文档）+ F12（含跳进 `Core.hlsl`）
- 代码量：约 1500～2500 行 TS
- 风险：跨行声明、宏包裹声明（`CBUFFER_START`）漏解析 → 用"多行拼接 + 宏白名单"缓解
- **为什么先做它**：它 100% 命中你要的两个功能，且 Provider 层代码在后续任何方案里都不用重写

### 方案 2 · 稳态（方案 1 的解析层换成 tree-sitter）
**A3 tree-sitter + B2 真实源码索引 + C2 标准 LSP**

- 工期：在方案 1 之上 **+4～6 周**
- 新增能力：引用、重命名、格式化、悬停类型信息都有了地基
- 风险：ShaderLab grammar 调试曲线；`tree-sitter-hlsl` 对 Unity 特有语法（`CBUFFER_START(...)`、`TEXTURE2D(name)` 宏声明）需要扩展
- 演进路径干净：Provider 代码不变，只换解析层

### 方案 3 · 语义外包（要真·HLSL 语义时）
**方案 2 + B3 DXC**

- 工期：**+3～5 周**
- 新增能力：struct 成员补全（`i.` 这种，Omni Shader 在 Basic 下返回空）、重载解析、真实 HLSL 诊断
- 工程量核心：把 `HLSLPROGRAM` 块抽成虚拟 `.hlsl` 并做**双向行号映射**（DXC 返回的位置要映射回 `.shader` 文件）
- 分发成本：自带 `dxc.exe`（win/linux/mac 各几 MB），比 Omni Shader 的 31MB 小得多

### 方案 4 · 全自研引擎（Omni Shader 同构）
**A3 + B1 + C2 + 自研类型系统/预处理器/格式化器**

- 工期：**4～7 人月**
- 只有在"必须支持 CGPROGRAM + 固定管线 + 完整诊断"时才值得
- 按你确认的范围（只 HLSLPROGRAM、只要补全+F12），**不建议**

---

## 3. 无论选哪个方案都要做的公共件

| 公共件 | 说明 | 规模 |
|---|---|---|
| **include 解析器** | `#include "UnityCG.cginc"` → `Editor\Data\CGIncludes\`；`#include "Packages/com.unity.render-pipelines.core/ShaderLibrary/Core.hlsl"` → `Packages\` 或 `Library\PackageCache\<pkg>\`；相对路径 → 同目录；`Assets\...` 前缀 → 工程根 | 2～3 天 |
| **Unity 编辑器路径发现** | 从 `ProjectSettings\ProjectVersion.txt` + Unity Hub 安装表 / 运行中进程 / 用户配置项兜底 | 1～2 天 |
| **符号索引（懒索引）** | 只索引声明，不索引表达式；当前文件的 include 闭包优先；后台增量 | 3～5 天 |
| **Properties ↔ HLSL 变量关联** | `_MainTex` 在 Properties 块和 HLSL 里是同一个逻辑符号，Outline/补全应合并（Omni Shader 没合并，出现两次） | 1 天 |
| **`Temp/compiled-*`、`Temp/generatedFrom*` 关闭智能** | 一行判定，避免打开生成代码时卡顿 | 10 分钟 |
| **tmLanguage + snippets + language-configuration** | 高亮与片段，独立于解析层 | 2～3 天 |

---

## 4. 关于"unity 编辑器变量"的两种理解（都覆盖）

| 理解 | 实现 | 成本 |
|---|---|---|
| **Unity 引擎内建变量**（`UNITY_MATRIX_MVP`、`_Time`、`_WorldSpaceCameraPos`、URP `GetCameraPosition()`） | 方案 B2 索引真实源码即可，F12 跳到声明行 | 已含在 B2 |
| **材质上的 property**（Properties 块里的 `_MainTex`，即 Inspector 里能调的那些） | 同文件内解析 `Properties{}` 块 + 与 HLSL 声明合并；若要跨文件（哪个材质用了它）需 Unity 包桥（写 `Library/*.json`，照它的做法） | 文件内 1 天；跨文件 +1 周 |

---

## 5. 顺手可得的加分项（分析中发现，成本极低）

1. **`Editor.log` 里的 `Disabled keywords:` 列表** → 无需 Unity 包桥就能知道哪些 `UNITY_*`/`SHADER_API_*` 关键字当前是关的 → 直接实现"`#if` 死分支灰化"（Omni Shader 的 Live Testing，Pro 功能）。实测本机日志里就有完整列表。成本：**2～3 天**。
2. **索引真实源码后，`#include` 路径补全和"跳到 include 定义"是免费的** —— Omni Shader 的 include 路径补全还是 Pro 功能。
3. **变体关键字提取**（`multi_compile`/`shader_feature` 声明）从 AST 里直接读，是 Unity 侧 Stripper 的前置能力，Omni Shader 也是 Pro/Unity 包侧功能。
