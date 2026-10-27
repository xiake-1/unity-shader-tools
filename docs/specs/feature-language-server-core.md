---
status: active
updated: 2026-10-27
---
# 规格 · 语言服务器核心（language-server-core）

对应模块：`src/server/`（LSP server 核心）与 `src/grammar/`（shaderlab grammar），即 T-001 骨架中的 `server` 与 `grammar` 两个包。

> 定位：M2～M5 全部功能规格（转到定义、补全、Rename、语法/类型诊断、格式化）共用的地基。
> 核心交付「解析 + 索引 + 查询 API」，不直接交付任何用户可见语言功能。
> 证据来源：[../分析/09-implementation-options.md](../分析/09-implementation-options.md)、
> [../分析/10-feature-feasibility.md](../分析/10-feature-feasibility.md)、
> [../分析/01-architecture.md](../分析/01-architecture.md) §4、[../分析/06-feasibility-and-roadmap.md](../分析/06-feasibility-and-roadmap.md) §1。

## 范围

1. **LSP 生命周期与进程管理**
   - 客户端（`vscode-languageclient`）经 stdio 拉起并握手 TS/Node server；`initialize` 协商能力，`shutdown`/`exit` 正常退出。
   - server 崩溃后客户端自动重启，≤3 次；超限停止并状态栏提示手动重启。
   - 日志输出到独立 Output 通道。
2. **文档同步**
   - 打开/编辑 `.shader`、`.hlsl`、`.hlslinc`、`.cginc` 时 `didOpen`/`didChange`（增量）/`didSave`/`didClose` 正确维护文档文本。
   - `Assets/`、`Packages/` 下的磁盘文件经 `workspace/didChangeWatchedFiles` 进入索引（编辑保存与外部修改同一路径）。
3. **解析层（唯一 CST）**
   - 自写 `shaderlab` tree-sitter grammar（T-003）覆盖 Shader/SubShader/Pass/Properties/Tags/`HLSLPROGRAM…ENDHLSL`/`#include`/`CBUFFER_START`/`TEXTURE2D`；关键字大小写不敏感用外部 scanner/`#eq?` 实现，不枚举大小写组合。
   - `HLSLPROGRAM` 块内嵌现成 `tree-sitter-hlsl`（T-004）。
   - tree-sitter 增量重解析（编辑范围复用旧树）。
   - CST 是唯一解析产物，后续所有功能共用；核心内不允许出现第二套解析路径（设计原则 2）。
4. **Unity 工程与环境发现**
   - 工程根判定顺序：打开文档路径中的 `Assets/`、`Packages/`、`Library/PackageCache/` 分段 → 从文件目录向上找同时含 `Assets/` 与 `Library/` 的目录 → 第一个 workspace folder → 失败则降级（见异常与边界）。
   - Unity Editor 安装路径发现：`ProjectSettings/ProjectVersion.txt` + Unity Hub 安装表 / 运行中进程 / 用户配置项兜底；内置 include 取 `<EditorDir>/Data/CGIncludes`。
   - 包内 HLSL 取 `<工程根>/Library/PackageCache/com.unity.render-pipelines.*/ShaderLibrary/**`；路径按 `ProjectVersion.txt` + `Packages/manifest.json` 动态定位，不硬编码版本号。
5. **include 解析**（四类，与 roadmap M2 一致）
   - 相对当前文件；`Assets/…` 前缀 → 工程根；`Packages/<pkg>/…` → `Packages/` 或回退 `Library/PackageCache/<pkg>@*/`；裸文件名（如 `UnityCG.cginc`）→ `Editor/Data/CGIncludes/`。
   - 解析结果（含失败）以结构化记录暴露，供 M4「include 未找到」诊断消费；核心自身不发诊断。
6. **符号索引与查询 API**
   - 启动全量索引：工程内（`Assets/`、`Packages/`）+ 包内 + 内置三类源；索引只抓声明，不抓表达式。
   - 索引内容：`Properties` 块属性、HLSL 全局变量/函数（含重载）、`struct` 及其字段、`#define` 宏、已知 Unity/URP 宏声明表（`TEXTURE2D(…)`、`CBUFFER_START(…)`、`UNITY_DECLARE_TEX2D(…)` 等，约 30～50 条，表驱动）。
   - 查询 API：按名查声明位置、按文件取符号表、计算文件 include 闭包、索引变更事件订阅。
   - `Properties` 的 `_MainTex` 与 HLSL 同名声明合并为同一逻辑符号。
7. **生成文件关闭智能**：路径匹配 `Temp/compiled-*`、`Temp/generatedFrom*` 的文件不索引、不解析、不响应请求。
8. **配置面**：`unityShader.` 命名空间下定义 trace 级别、索引开关、单文件索引大小上限（默认 2 MiB）。

## 不在范围

- 一切用户可见语言功能：转到定义、引用、Rename、补全、悬停、documentSymbol/Outline、签名帮助、语法诊断、类型诊断、`#if` 死分支灰化、格式化 —— 各写独立功能规格（见 backlog「尚未入 backlog 的功能任务」与 roadmap M2～M5）。
- HLSL 类型系统与语义（类型检查、swizzle、重载解析）—— 外包 DXC，属 M5 规格。
- `CGPROGRAM` / GLSLPROGRAM / 固定管线语法语义（仅 grammar 识别外壳，不做语义）。
- Unity Editor 包（元数据桥 `Library/*.json`、变体裁剪）—— M6。
- 授权、计费、i18n、营销通知。
- 非 LSP 传输（私有 HTTP 等）与非 VSCode 客户端。
- 独立文件监听进程（对标产品的 watcher.js；本方案用 LSP `didChangeWatchedFiles`，不起额外进程）。

## 约束

- 传输只走标准 LSP（stdio），不造私有协议（设计原则 5）。
- 解析层只有 tree-sitter：自写 `shaderlab` grammar + 现成 `tree-sitter-hlsl`（设计原则 2；选型依据见分析 09 方案 A3）。
- 内置符号来自索引真实源码，不手写 stub 库、不使用对标产品的 `.std`（设计原则 1、6）。
- server 为 TypeScript / Node 进程；核心逻辑不依赖 VSCode API，保持可被将来 CLI/Unity 侧复用。
- 性能预算（已确认）：测试工程（50 工程 shader + 80+ 包内 `.hlsl` + 56 内置 include）冷启动全量索引 < 3 s；对 ≤2000 行 shader 单次编辑的「增量重解析 + 符号表更新」< 100 ms；索引全程 server RSS < 500 MB。
- 索引在 `initialize` 之后后台进行，不阻塞握手与文档事件。
- 首期只支持单根工作区；多根时取第一个 Unity 工程根，其余忽略并记日志。
- grammar 与 tree-sitter 运行时以 **N-API prebuilds 随单一 VSIX 附带**；client esbuild bundle、server tsc 不 bundle —— 原「native 还是 WASM 未定」项已由 ADR 0005 结清。
- 不复制对标产品闭源资产（grammar、`.std`、文档文本）。

## 异常与边界

| 场景 | 行为 |
|---|---|
| 识别不到 Unity 工程（无 `Assets/`+`Library/`、Editor 路径找不到、`PackageCache` 不存在） | **降级**：ShaderLab 外壳解析与工程内符号仍工作；内置/包内符号为空；经 `window/showMessage`（Info）或状态栏提示一次，不弹窗报错、不崩溃 |
| server 崩溃 | 客户端自动重启 ≤3 次；第 4 次崩溃停止重启并提示重载窗口；重启后重建索引 |
| server 无响应 | LSP 客户端超时按崩溃处理，走同一重启策略 |
| include 目标不存在 / 四类规则均未命中 | 记录「未解析 include」结构化结果；不发诊断（M4 消费）；不影响该文件其余符号入索引 |
| 文件含 tree-sitter `ERROR`/`MISSING` 节点 | 解析尽力而为，可识别的声明照常入索引；错误节点计数暴露给 M4 |
| 非 Unity 文件（`.hlsl` 在工程外、纯 HLSL 文件） | 仍解析与索引（grammar 对无 ShaderLab 外壳的文件直接按 HLSL 处理） |
| 单文件超过索引大小上限（默认 2 MiB） | 跳过索引，日志警告；上限可配置 |
| 索引期间收到查询 | 返回当前已索引部分（不等待、不报错），日志记「索引进行中」 |
| 同名符号跨 `#if` 分支重复声明 | 索引保留全部声明位置（多 location），不自行猜激活分支（预处理器求值属 M4） |
| 工程根在索引期间被增删（切分支、删包） | `didChangeWatchedFiles` 驱动增量更新；无法定位的源从符号表移除 |

## 验收标准

每条映射到测试或可观察行为；验证基座为 T-006（vitest + vscode-test）。

- [ ] 打开 `.shader` 后 LSP 握手成功，Output 通道可见 server 启动日志（vscode-test 集成）
- [ ] 关闭窗口后 server 进程被回收，无残留进程（vscode-test：断言 pid 消失）
- [ ] 手动 kill server 进程后客户端自动重启并恢复功能；连续 4 次崩溃后不再重启且出现提示（vscode-test 集成）
- [ ] `tree-sitter test` shaderlab 语料全绿，覆盖 `Shader`/`SubShader`/`Pass`/`Properties`/`Tags`/`HLSLPROGRAM…ENDHLSL`/`#include`/`CBUFFER_START`/`TEXTURE2D`（grammar 测试）
- [ ] `HLSLPROGRAM` 内 function / struct / 全局变量声明识别单测 ≥ 20 例（vitest）
- [ ] 解析测试工程（`D:\Work\Unity\ShaderStudy\Assets`，50 个 shader）后含 `ERROR` 节点的文件占比 < 2%（vitest 语料测试）
- [ ] include 四类解析各有单测：相对路径、`Assets/…`、`Packages/…`（含 PackageCache 回退）、裸名内置 `.cginc`（vitest）
- [ ] Unity 工程根判定四级顺序、Editor 路径发现兜底链各有单测（vitest，用 fixture 目录树）
- [ ] 符号索引单测：`Properties` 属性、全局变量、函数重载、struct 字段、`#define`、`TEXTURE2D(_MainTex)`/`CBUFFER_START(UnityPerMaterial)` 宏声明均可查得声明位置；`_MainTex` 的 Properties 与 HLSL 声明合并为一条逻辑符号（vitest）
- [ ] 冷启动索引基准：测试工程全量索引 < 3 s，基准测试可重复运行并输出耗时（vitest bench）
- [ ] 增量重解析基准：对 2000 行 shader 单次编辑「解析 + 符号表更新」< 100 ms（vitest bench）
- [ ] 索引全程 RSS < 500 MB（基准测试采样进程内存）
- [ ] 在非 Unity 文件夹打开 `.shader`：外壳解析与工程内符号查询可用，内置/包内符号为空，提示恰好出现一次，无异常弹窗、server 不崩溃（vscode-test 集成）
- [ ] 打开 `Temp/compiled-*` 文件：不索引、不响应请求（vitest 路径判定单测）
- [ ] `#if` 分支同名声明：查询 API 返回全部位置，不丢任何一个（vitest）

## 对应模块

- `specs/feature-language-server-core.md` ↔ `src/server/`（生命周期、文档同步、发现、include 解析、符号索引与查询 API）
- ↔ `src/grammar/`（`shaderlab` grammar、`tree-sitter-hlsl` 集成、增量解析封装）
- 客户端侧仅 `src/client/` 的启动/重启/配置薄层，功能 Provider 属各功能规格。
