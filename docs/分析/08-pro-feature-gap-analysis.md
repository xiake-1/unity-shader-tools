# 08 · 复刻 Pro 级功能的差距分析

> 问题：现有分析够不够开发一个**包含 Pro 级功能**（完整补全 / 格式化 / 跳转 / 引用 / 重命名 / 诊断 / Live Testing）的同类插件？
> 答案：**够搭骨架，不够搭引擎。** 而且有一个硬阻塞：**没有 Pro 授权，连要复刻的目标行为都观测不到。**

---

## 1. 现有分析能直接复用的部分（约 30% 工作量）

| 资产 | 状态 | 来源 |
|---|---|---|
| 产品分层与功能边界 | ✅ 完整 | README 功能表 + 实测门控矩阵 |
| 进程/端口/生命周期模型 | ✅ 完整 | `dist/extension.js` 明文 |
| API 契约（14 端点、字段、坐标语义） | ✅ 完整且实测 | [05](05-api-contract.md) + [07](07-live-probe-results.md) |
| 8 个 Provider 的客户端实现套路 | ✅ 完整 | 打包 JS 可读 |
| 编辑器增强（注释生成、死分支装饰、`Temp/` 关闭智能） | ✅ 完整 | 打包 JS 可读 |
| Unity 包全部 C# 源码 | ✅ **明文可读** | `unitypack/**/*.cs` |
| 语法节点名词表（≈200 个 node type + 24 个 field） | ✅ 完整 | 二进制字符串 |
| 类型名表、诊断文案、include 搜索路径线索 | ✅ 完整 | 二进制字符串 |
| 内置库的**写法**（`.std` = 语言本身 + `///`） | ✅ 方法已知 | `inc/*.std` 明文 |
| 数据文件的**结构**（tags/drawers/directives/hlsl_require） | ✅ 结构已知 | `inc/data/*.json` 明文 |

**这一层的价值**：省掉 2～3 个月的架构试错。产品形态、协议、Unity 集成、UX 细节都不用重新发明。

---

## 2. 缺的部分：Pro 功能的引擎实现

| Pro 功能 | 已知 | **缺（必须自己实现）** | 规模 | 能否观测参考行为 |
|---|---|---|---|---|
| **Full Completion**（`i.` 成员、`#pragma`、tag 值、blend 因子、include 路径、drawer、Fallback） | 响应字段、Basic 只给全局表、数据文件结构 | **上下文判定规则**：光标在哪个 node type 下给哪类候选；成员访问要 struct 解析；include 路径要工程索引 | 1～2 周 | ❌ Basic 下返回空 |
| **Go To Definition** | 响应形状、`.std` 不跳转、服务端按需读盘 | **符号表与作用域规则**：include 图、重载消歧、Properties 属性 ↔ CG 变量合并、跨文件同名解析优先级 | 2～3 周 | ❌ 哨兵 |
| **Find References** | 同上 | **引用索引策略**（全量索引 vs 懒索引）、宏内引用是否计入 | 1～2 周 | ❌ 哨兵 |
| **Rename** | 只返回位置列表，edit 由客户端生成 | 同 References | 数天 | ❌ 哨兵 |
| **Code Formatting** | 入参 4 个开关、返回全文、支持 `.editorconfig` | **整个 CST 打印器**：ShaderLab 缩进、固定管线块、`#if` 宏缩进对齐、空行保留策略、注释对齐 | 2～4 周 | ❌ 哨兵 |
| **Error Diagnostics** | 诊断文案 6 条、类型名表、自动注入哪些 `.std`、include 搜索路径 | **类型推断 + 重载解析 + 宏求值器 + Unity 关键字注入集**（`SHADER_API_*`/`UNITY_UV_STARTS_AT_TOP`/`multi_compile` 声明的关键字）；误报控制策略 | **1～3 月** | ❌ 返回空数组 |
| **Live Testing**（死分支灰化） | `//! KEY;KEY:VAL` 语法、`/branch` 响应结构 | **预处理器求值器**（与诊断共用）；Unity 当前关键字从哪来 | 2～3 周（含在诊断里） | ❌ 返回空数组 |
| **Unity Stripper** | 完整 C# UI 与流程 | **引擎侧 `analysis`/`strip` 行为**：关键字提取规则、pass 识别、删码后语法是否仍合法 | 2～4 周 | ⚠️ 可观测（Unity 包明文，能跑） |

**合计：净开发 4～7 人月**（不含 UI 打磨、测试、多平台分发）。

---

## 3. 硬阻塞：观测不到目标行为

Pro 端点在 Basic 模式下返回哨兵或空 → **无法黑盒采集参考实现的行为规格**。具体拿不到的东西：

- 格式化：它的输出风格基线（哪些块换行、宏怎么对齐、注释怎么处理）→ 只能自己定标准
- 诊断：**误报率、severity 分级、去重与抑制策略** —— 这是 shader 工具最容易翻车的地方（CHANGELOG 0.0.11b 专门把诊断改成默认关闭，说明他们被误报咬过）
- 补全：上下文过滤规则、排序、`detail`/`documentation` 怎么填
- 跳转：同名符号优先级、重载选哪个

**可行的解法（按性价比排序）**：

1. **官方 14 天免费试用**（需注册账号，README 明确提供）。拿到后我可以写行为采集脚本，对同一批 shader 批量抓取 Pro 端点的真实响应，形成"参考行为规格表"。这是**正当使用试用授权**，不是绕过保护。
2. 用它的**同类开源实现**做行为参照：`antaalt/shader-language-server`（Rust+LSP，已实现 inactive region / variant / 依赖树）、`pema99/UnityShaderParser`（ShaderLab+HLSL+预处理器）、DXC `IDxcIntelliSense`。
3. 自己定标准 + 用 Unity 官方 shader 语料做回归测试（URP/Built-in 包内几百个 shader 是天然的"必须零误报"测试集）。

---

## 4. 无论怎么分析都得自己写的四样东西

这四样是真正的护城河，任何分析都拿不到：

1. **tree-sitter grammar（ShaderLab 外壳）** —— 约 500～900 行 `grammar.js`，含大小写不敏感关键字、固定管线块、程序块嵌入、预处理器。现成的 `tree-sitter-hlsl` 只覆盖 HLSL，外壳必须自己加。
2. **预处理器求值器** —— `#define`（含宏函数）、`#if/#ifdef/#elif/#else`、`defined()`、短路语义、Unity 关键字注入。**诊断和 Live Testing 都靠它。**
3. **类型系统** —— 向量/矩阵维度、swizzle、赋值与二元运算维度匹配、重载解析。或者**外包给 DXC**（见下）。
4. **格式化打印器** —— CST → 文本，带 4 个可配置开关。

---

## 5. 三条实现路线（针对"要 Pro 级功能"这个目标）

| 路线 | 做法 | 到 Pro 级的距离 | 风险 |
|---|---|---|---|
| **A. 全自研引擎**（照它的架构） | 自写 grammar + 预处理器 + 类型系统 + 打印器，Rust/Go | 4～7 人月 | 诊断误报是生死线；类型系统容易做成"半对"反而更烦人 |
| **B. 拼装：外壳自研 + HLSL 语义外包 DXC** ⭐ 推荐 | ShaderLab 外壳 + 预处理器自研（轻量手写 parser 即可，不必 tree-sitter）；HLSL 内部的补全/跳转/诊断交给 **DXC `IDxcIntelliSense`**（微软维护，SM6.6 语义准确） | 2～4 人月 | DXC 只吃 HLSL，CG/旧语法不覆盖；需要把 ShaderLab 程序块抽成虚拟 .hlsl 喂给 DXC（行号映射是主要工程量） |
| **C. 复用开源 shader-language-server** | 基于 `antaalt/shader-language-server` 扩展 ShaderLab 层 | 3～5 人月 | 它的架构不是为 ShaderLab 设计的，改造成本可能超过重写 |

**推荐 B**，理由：Pro 功能里最难、最容易误报的是 **HLSL 语义正确性**，而这恰好是微软已经解决的部分（DXC 是 Unity 2021+ 实际使用的 HLSL 编译器）。把力气花在 ShaderLab 外壳、Unity 关键字注入、include 解析、Unity 集成上——这些 DXC 不做、也只有做 Unity 工具的人需要。

---

## 6. 决策前需要确认的三件事

1. **目标形态**：只做 VSCode，还是要同时支持 Visual Studio / JetBrains Rider（决定必须走标准 LSP 还是私有协议）
2. **CG 旧语法支持度**：只支持 HLSLPROGRAM（可用 DXC），还是必须支持 CGPROGRAM/固定管线（必须自研类型系统）
3. **是否接受先用 14 天试用采集参考行为**（否则所有 Pro 功能的行为标准都得自己定，返工概率显著上升）
