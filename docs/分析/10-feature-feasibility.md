# 10 · 五项高级功能的可行性判定（只评估，不含开发）

> 前提：范围已确认为 **只需 `HLSLPROGRAM`**（URP/HDRP 现代写法）、**自定行为标准**（不用它的 Pro 试用）。
> 判定口径：**可做** = 有明确技术路径、风险可控；**有条件可做** = 依赖某个前置选型或需要接受覆盖度损失；**不建议** = 投入产出比明显不合理。

## 结论矩阵

| 功能 | 判定 | 最低解析层要求 | 工期（在 Basic 层之上） | 最大风险 |
|---|---|---|---|---|
| **F12 转到定义** | ✅ **可做**，且体验能超过它 | A1（正则）即可起步 | **1～1.5 周** | 宏声明（`TEXTURE2D(...)`、`CBUFFER_START`）需白名单展开 |
| **Rename 重命名** | ⚠️ **有条件可做** | **必须 A2/A3**（作用域感知） | +1～2 周 | 误改（注释/字符串/死分支/同名字段）比不改更糟 |
| **完整语义补全** | ⚠️ **拆三块：两块可做，一块有条件** | include: A1；struct: A2；宏展开: A3 | **2～3 周**（不含通用宏展开） | 通用宏展开引擎是深坑 |
| **HLSL 代码格式化** | ⚠️ **可做但建议排最后** | **必须 A3**（CST 保留 trivia） | 2～3 周 | 用户零容忍；必须分层格式化，否则会破坏 ShaderLab 结构 |
| **实时诊断** | 🔀 **语法诊断可做 / 类型诊断走 DXC 可做 / 自研类型系统不建议** | 语法: A3；类型: DXC | 语法 **1 周**；类型 **+3～5 周** | 误报率（这是 shader 工具的生死线） |

**一句话**：五项里 **F12 稳做、语法诊断稳做、include 补全和 struct 成员补全稳做**；**Rename 和格式化取决于解析层选型**；**类型诊断必须外包给 DXC，自研不划算**。

---

## 1. F12 Go To Definition — ✅ 可做

**能覆盖的符号类别**（按实现难度排序）：

| 类别 | 例子 | 难度 |
|---|---|---|
| 当前文件 HLSL 全局变量 | `float4 _MainTex_ST;` | 极低 |
| Properties 块属性 | `_MainTex ("Texture", 2D) = "white" {}` | 极低 |
| struct 字段 | `v2f.uv` | 低 |
| 函数（含重载） | `vert`、`frag`、`mul` | 低（重载返回 `Location[]`，VSCode 原生支持） |
| 跨文件（工程内 `.hlsl/.cginc`） | 自定义 include 里的函数 | 中（需 include 解析） |
| **包内真实声明** | URP `Core.hlsl` 里的 `TransformWorldToHClip` | 中（索引 `Library\PackageCache\...`） |
| **引擎内置声明** | `UnityCG.cginc` 里的 `UnityObjectToClipPos` | 中（索引 `Editor\Data\CGIncludes\`，56 个文件） |
| 局部变量 / 函数参数 | `float depth = …` | 中（需块级作用域） |

**关键优势**：走"索引真实源码"路线后，F12 能**真的跳进 `Core.hlsl:123`**，而 Omni Shader 对内置库是**故意不跳**（hover 返回 `.std` 行号但不带路径，definition 对 `.std` 直接返回 null）。这一项我们能做得比它好。

**必须处理的坑**：
1. **宏声明**：`TEXTURE2D(_MainTex);`、`CBUFFER_START(UnityPerMaterial) … CBUFFER_END`、`UNITY_DECLARE_TEX2D(...)` —— 这些不是普通声明语法。解法：维护一张 **Unity/URP 已知宏的展开规则表**（约 30～50 条，从包内源码里统计高频宏），命中就当声明处理。覆盖日常 90%+。
2. **`#if` 分支里的同名声明**（如 `#if SHADER_API_GLES30 float4 x; #else float3 x; #endif`）→ 返回多个 location，让编辑器列出来，别自己猜。
3. **Unity 版本/包版本差异** → 索引源要按 `ProjectVersion.txt` + `manifest.json` 动态定位，不能硬编码路径。

**工期**：A1 路线 1～1.5 周（含 include 解析与索引）。

---

## 2. Rename — ⚠️ 有条件可做（前置：解析层必须到 A2/A3）

Rename = Find References + 批量 edit。难点全在"引用识别的准确性"：

| 误改来源 | 正则方案（A1）会怎样 | A2/A3 方案 |
|---|---|---|
| 注释里的同名 | ❌ 会改 | ✅ 不会 |
| 字符串里的同名（`#include "x"`、`"Queue"="..."`） | ❌ 会改 | ✅ 不会 |
| `#if` 死分支里的同名 | ❌ 会改 | ✅ 可判定 |
| 不同作用域的同名（struct 字段 `uv` vs 局部 `uv`） | ❌ 全改 | ✅ 作用域感知 |
| 宏内部 token（`#define M(x) x` 里的 `x`） | ❌ | ⚠️ 需要宏处理 |

**判定**：A1 路线**不建议做 Rename**——改错一次比不做更伤信任。走 A2（手写声明 parser，带作用域）或 A3（tree-sitter AST）后，Rename 是 F12 的副产品，**+1～2 周**。

**建议的安全措施**（无论哪种实现）：
- 只改"与 F12 解析出的同一符号"的 token，不做文本匹配
- 默认只改当前文件 + 当前文件的 include 闭包，跨工程引用单独确认
- 死分支内的引用默认不改，并在 UI 里提示"另有 N 处在未激活分支中"

---

## 3. 完整语义补全（#include / 宏 / 结构体）— ⚠️ 拆三块看

| 子项 | 判定 | 做法 | 工期 |
|---|---|---|---|
| **`#include` 路径补全** | ✅ **可做，很容易** | 枚举同目录 + `Assets\**` + `Packages\` + `Library\PackageCache\*\ShaderLibrary\**` + `Editor\Data\CGIncludes\` | **1～2 天** |
| **结构体成员补全**（`i.uv`） | ✅ **可做** | struct 定义解析 + 变量类型来自其声明（不需要完整类型推断） | **1～2 周** |
| **用户宏补全**（自己 `#define` 的） | ✅ **可做** | 扫 `preproc_def` 列表 | 数天 |
| **Unity/URP 宏补全**（`SAMPLE_TEXTURE2D`、`TransformWorldToHClip`…） | ✅ **可做** | 索引真实源码时顺带抓 `#define`（B2 的免费副产品） | 已含在 B2 |
| **宏展开级补全**（`TEXTURE2D(_MainTex)` 实际声明了什么、宏参数补全） | ⚠️ **有条件可做** | 靠"已知宏展开规则表"覆盖高频；通用宏展开引擎 = 数周且是诊断的共同前置 | 表驱动 1～2 周；通用引擎 3～5 周 |

**注意**：Omni Shader 把 `#include` 路径补全、tag 值补全、`#pragma` 补全、成员补全**全部划为 Pro**（实测 Basic 下返回空）。这几项在我们这里都是低成本项——**这是最容易做出"比它好"的地方**。

---

## 4. HLSL 代码格式化 — ⚠️ 可做，但建议排最后

**为什么必须 A3（tree-sitter）**：格式化要保留全部 token 与 trivia（注释、空行、原始空白），tree-sitter 的 CST 天然满足（字节级无损）。A1/A2 路线要么自己实现 trivia 保留（麻烦且易错），要么质量不可接受。

**必须分层**：
```
.shader 文件
 ├─ ShaderLab 外壳（Shader/SubShader/Pass/Properties/Tags/固定管线）→ 自己写打印器
 └─ HLSLPROGRAM … ENDHLSL 内部 → 可委托现成格式化器
      现成件：shader-formatting（shaderc 的 shader_format，支持 HLSL/GLSL，有 WASM 版）
      ⚠️ 它不懂 ShaderLab，直接喂整个 .shader 会破坏 Properties/Pass 结构
```

**风险等级最高**：格式化是"错一次就要修 grammar"的功能。它的实现里 4 个开关（`braceOnNewLine`/`tabSize`/`insertSpaces`/`macroIndent`）+ `.editorconfig` 支持，说明风格争议很大。

**判定**：技术上可做（A3 路线 2～3 周），但**优先级最低**——它不解决"写不出来"的问题，只解决"不好看"，而前四项解决的是"看不懂的代码/找不到定义/改错名字"。

---

## 5. 实时诊断（红波浪线）— 🔀 必须拆成两类

### 5a. 语法诊断 — ✅ 可做，1 周，低风险

tree-sitter 免费给 `ERROR` / `MISSING` 节点，直接转成 `Diagnostic`：
- 括号不匹配、缺分号、未知 ShaderLab 块、`HLSLPROGRAM` 没有 `ENDHLSL`
- 它的文案 `MISSING ;`、`syntax error - …` 就是这个思路
- 误报可控（语法层错误是客观的）

### 5b. 类型/语义诊断 — 三条路，判定完全不同

| 路线 | 判定 | 质量 | 成本 | 说明 |
|---|---|---|---|---|
| **外包 DXC `IDxcIntelliSense`** | ✅ **可做（推荐）** | **编译器级**（DXC 就是 Unity 2021+ 实际用的 HLSL 编译器） | **+3～5 周** | 工程量在：宏注入（`SHADER_API_*`）、include 路径映射、**虚拟 .hlsl ↔ .shader 双向行号映射**、结果缓存（DXC 无增量）。分发要自带 `dxc.exe`（Unity 只有 `dxcompiler.dll`，几 MB 量级，远小于它的 31MB） |
| **表驱动半自研**（只做未定义符号 + 明显维度错误） | ⚠️ 有条件 | 中等，**误报风险高** | 4～8 周 | 必须先有宏展开 + include 闭包，否则 `SAMPLE_TEXTURE2D` 这类宏里的"未定义符号"会刷屏 |
| **完整自研类型系统** | ❌ **不建议** | 需长期投入才可信 | **1～3 月** | 向量/矩阵维度、swizzle、重载解析、隐式转换全套。按你的范围（只 HLSLPROGRAM）不值得 |

**为什么"未定义符号"比看上去难**：Unity shader 里标识符来自 ①当前文件 ②include 闭包 ③宏展开 ④Unity 全局关键字（`SHADER_API_*`、`UNITY_*`）。任何一环缺了就刷屏。它的 CHANGELOG 0.0.11b **专门把诊断改成默认关闭** —— 说明被误报咬过。

**自建验收标准**（因为没有它的 Pro 参考行为）：
- 语料：`Library\PackageCache\com.unity.render-pipelines.*\ShaderLibrary\**`（80+ 文件）+ `Editor\Data\CGIncludes\`（56 文件）+ 工程内 50 个 shader
- 门槛：**这些官方文件必须零误报**，达不到就不该默认开启
- 默认策略：语法诊断默认开；类型诊断默认关或降级为 Hint

### 5c. 顺带：`#if` 死分支灰化（它的 Live Testing，Pro）

实测发现 `%LOCALAPPDATA%\Unity\Editor\Editor.log` 里有
```
Disabled keywords: SHADER_API_GLES30 UNITY_COLORSPACE_GAMMA UNITY_PBS_USE_BRDF2 …
```
→ **不需要 Unity 包桥**就能拿到当前关闭的关键字集合，配合 tree-sitter 的 `preproc_if` 节点 + 编辑器装饰即可实现。**2～3 天，性价比极高**，且是它的付费功能。

---

## 6. 依赖关系与建议顺序

```
解析层选型（决定后面一切）
   A1 正则 ──→ F12(文件内+跨文件+内置) ✅、#include 补全 ✅、struct 成员补全 ⚠️
   A2 手写声明 parser ──→ 解锁 Rename ✅、局部变量 F12 ✅
   A3 tree-sitter ──→ 解锁 语法诊断 ✅、格式化 ✅、宏/分支处理质量 ↑
   + DXC ──→ 解锁 类型诊断 ✅、重载解析、成员补全质量 ↑
```

**建议顺序（按"价值/成本"降序）**：

1. F12（含内置与包内真实声明）— 1～1.5 周，**体验直接超过它**
2. `#include` 路径补全 — 1～2 天，它的 Pro 功能
3. struct 成员补全 — 1～2 周，它的 Pro 功能
4. 语法诊断（tree-sitter ERROR/MISSING）— 1 周，它的 Pro 功能
5. `#if` 死分支灰化（读 Editor.log）— 2～3 天，它的 Pro 功能
6. Rename — 1～2 周（需 A2/A3）
7. 类型诊断（接 DXC）— 3～5 周
8. 格式化 — 2～3 周，最后做

前 5 项合计 **约 4～6 周**，全部命中它的付费墙功能，且都不需要类型系统。
