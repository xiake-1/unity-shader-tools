# 07 · 运行期实测结果（2026-10-27）

> 环境：VSCode 已打开 `D:\Work\Unity\ShaderStudy`，活动文件
> `Assets\Shaders\4.深度和法线纹理\3.运动模糊\MotionBlurWithDepthTexture.shader`（72 行 CG shader）
> 探测方式：Node 直接对 `http://127.0.0.1:39196/*` 发 `FormData` POST。**只读探测**：所有 `/update` 都只改服务端内存，脚本结束时已把文档状态恢复为磁盘原文；未改动任何磁盘文件。

## 1. 进程与端口（实测）

```
PID 37476  sls.exe
  命令行: ...\sls\win\sls  39196  d:\Work\Unity\ShaderStudy\  true
           └ 参数[1]=端口  └ 参数[2]=工作区根  └ 参数[3]=incrementalParsing
%LOCALAPPDATA%\OmniShaderTools\39196.PORT   内容: "39196"（就是端口号本身）
```

**意外发现：`watcher.js` 子进程没有运行。** 全进程列表里只有 `sls.exe`，没有 `fork` 出去的 watcher。结合 CHANGELOG 1.1.5「Fix a bug that backend file watcher are broken by moudle not found error」，这条路径在真实环境里确实会静默失效 —— 而且**没有用户可见的报错**（状态栏仍显示 "Omni Shader: On"）。

## 2. 授权状态

```
GET /basic  →  200  "true"      ← 当前处于 Basic（免费）模式
```

## 3. 端点实测矩阵

| 端点 | HTTP | 实测结果 | 判定 |
|---|---|---|---|
| `GET /basic` | 200 | `"true"` | 可用 |
| `POST /update` | 200 | 空 body，长度 0 | 可用 |
| `POST /symbol` | 200 | 13 个符号 | **Basic 可用** |
| `POST /hover` | 200 | 带官方文档文本 | **Basic 可用** |
| `POST /signature` | 200 | `mul` 全部重载（36 KB） | **Basic 可用** |
| `POST /completion` | 200 | 全局扁平符号表 936～953 项 / **98 KB** | **仅基础补全** |
| `POST /definition` | 200 | `{"path":"-1000001",...}` | **Pro 拦截（哨兵）** |
| `POST /reference` | 200 | `[{"path":"-1000001",...}]` | **Pro 拦截（哨兵）** |
| `POST /rename` | 200 | `[{"path":"-1000001",...}]` | **Pro 拦截（哨兵）** |
| `POST /format` | 200 | `{"code":"-1000001"}` | **Pro 拦截（哨兵）** |
| `POST /diagnostics` | 200 | `[]`（注入 3 处错误后仍 `[]`） | **Pro 拦截（静默空）** |
| `POST /branch` | 200 | `[]` | **Pro 拦截（静默空）** |
| `POST /doc` | 200 | `""` | **Pro 拦截（静默空）** |

**两种拦截方式并存**，这是实现细节上的不一致：
- 返回哨兵 `-1000001` → 客户端能弹"该功能需要订阅，是否试用？"
- 返回空 → 客户端**无法区分"没有结果"和"没权限"**，用户只会觉得"没反应"

诊断/分支/文档生成走的是后者。自研时应统一成哨兵（或 LSP 的 `code` 字段 + 自定义 error）。

## 4. 响应结构（实测修正版）

### `/symbol` —— 扁平列表 + `container` 表达层级
```jsonc
[ { "name": "_MainTex", "container": "",     "kind": "Property",
    "location": { "path": "D:\\...\\MotionBlurWithDepthTexture.shader",
                  "start": {"row":4,"column":8}, "end": {"row":4,"column":45} } },
  { "name": "uv",       "container": "v2f",  "kind": "Field", ... },
  { "name": "vert",     "container": "",     "kind": "Function",
    "location": { "start": {"row":31,"column":12}, "end": {"row":43,"column":13} } } ]
```
实测 kind：`Property`（Properties 块里的属性）、`Variable`（CG 全局变量）、`Function`、`Class`（struct 归为 Class）、`Field`。
注意 `_MainTex` 同时以 `Property`（Properties 块）和 `Variable`（CG 声明）出现两次 —— 它没有把两者合并成一个语义实体。

### `/hover` —— `{value, start, end, doc}`
```jsonc
// 光标在 UnityObjectToClipPos 上
{ "value": "float4 UnityObjectToClipPos(float3 pos)",
  "start": {"row":15,"column":0}, "end": {"row":15,"column":43},
  "doc": "Transforms a point from object space to the camera’s clip space…" }
```
**`start/end` 是声明位置，不是光标位置**，而且内置函数的声明位置指向 `inc/unity.std` 的第 16 行（对照文件确认：`float4 UnityObjectToClipPos(float3 pos) { }`）。响应里**不带路径** —— 这就是客户端必须对 `.std` 后缀的 definition 结果直接返回 `null` 的原因。

用户变量与 Properties 属性也有 hover：
```jsonc
{ "value": "sampler2D _MainTex", "start":{"row":24,"column":12}, "end":{"row":24,"column":30}, "doc": "" }
{ "value": "Float _BlurSize",    "start":{"row":5,"column":8},   "end":{"row":5,"column":42},  "doc": "" }
```
→ 说明 hover 的 `value` 是**从 AST 反渲染的声明文本**，不是原文切片（`Float` 大写来自 Properties 语法）。

### `/definition` `/reference` `/rename` —— 扁平 `{path, start, end}`
```jsonc
{ "path": "...", "start": {"row":26,"column":12}, "end": {"row":26,"column":21} }
```
**没有嵌套 `location`**（此前文档写错了，已在 05 修正）。客户端 `osLocationToLocation(e) = new Location(Uri.file(e.path), new Range(p(e.start), p(e.end)))` 与此一致。

### `/signature` —— `{signatures, active_signature, active_parameter}`
```jsonc
{ "signatures": [
    { "label": "float4 mul(float4x4 M, float4 v)",
      "doc": "multiply a matrix by a column vector, row vector by a matrix, or matrix by a matrix",
      "active_parameter": 0,
      "parameters": [ {"label":"float4x4 M","doc":""}, {"label":"float4 v","doc":""} ] },
    … 共 30+ 个 mul 重载 …
  ],
  "active_signature": 0, "active_parameter": 0 }
```
实测体积 **36 KB / 一次调用**。它把 `mul` 的所有重载全列出来，没有按实参类型筛选，`active_signature` 恒为 0。
→ 可改进点：按 `float4x4 × float4` 先做重载解析，只返回候选并把 `active_signature` 指对。

### `/completion` —— `{label, kind, detail, documentation, insert_text}`
```jsonc
{ "label": "_MainTex", "kind": "Property", "detail": "", "documentation": "", "insert_text": "_MainTex" }
```
**服务端算了 `detail` / `documentation` / `insert_text`，但 VSCode 客户端只读 `label` + `kind`**（`new CompletionItem(e.label, osKindToCompletionKind(e.kind))`）。这三个字段大概率是给它的 Visual Studio 客户端用的。

实测 Basic 模式补全行为：

| 场景 | 结果 |
|---|---|
| 函数体内 `Unity` 前缀 | 947 项：`{Property:2, Function:245, Variable:59, Struct:51, Keyword:590}` |
| 类型前缀 `flo` | 953 项（同上 + 局部变量 `depth/nowClipPos/worldPos/…`） |
| Properties 块内 `[` | 936 项（**不是 drawer 列表**，仍是全局表） |
| `i.` / `o.` 成员访问 | **0 项** |
| `#pragma ` 之后 | **0 项** |
| Pass 内 `Blend ` 之后 | **0 项** |
| `Tags { "Queue" = "` | **0 项** |
| `#include "UnityC` | 939 项（**不是路径补全**，仍是全局表） |
| `Fallback ` 之后 | **0 项** |

结论：
1. **Basic 补全 = 一张不分上下文的全局符号表**（当前文件符号 + 内建函数 245 + 类型 51 + 关键字 590 + 局部变量），**服务端不做前缀过滤**，靠 VSCode 客户端按 `label` 过滤。
2. **上下文相关补全（成员、`#pragma`、tag 值、blend 因子、include 路径、drawer、Fallback）全部是 Pro**，Basic 下返回空数组。
3. **每次按键回传 98 KB JSON** —— 这是可测量的性能缺陷（无过滤、无 `isIncomplete` 分页、无 resolve 二段拉取）。

## 5. 服务端按需读盘（推翻此前推断）

对**从未在编辑器打开过**的文件直接查 `/symbol`：

```
ForwordLighting.shader      → 200, symbols=23
Half_LambertFrag.shader     → 200, symbols=7
Half_LambertVertex.shader   → 200, symbols=7
```

→ **服务端自己会读磁盘**，watcher 进程只是预热/缓存失效通知，不是跨文件能力的必要条件。本次会话 watcher 未运行，跨文件解析依然工作。
（01-architecture.md 已按此修正。）

## 6. 与 README 功能表的对照（实测一致）

| 功能 | README 声明 | 实测 |
|---|---|---|
| Syntax Highlighting | Basic ✅ | ✅（tmLanguage，与服务端无关） |
| Basic Code Completion | Basic ✅ | ✅ 全局符号表 |
| Full Code Completion | Basic ❌ | ✅ 确实返回空 |
| Hover | Basic ✅ | ✅ 带文档 |
| Document Symbols | Basic ✅ | ✅ |
| Signature Help | Basic ✅ | ✅ |
| Code Formatting | Basic ❌ | ✅ `-1000001` |
| Go To Definition | Basic ❌ | ✅ `-1000001` |
| Find References | Basic ❌ | ✅ `-1000001` |
| Rename | Basic ❌ | ✅ `-1000001` |
| Error Diagnostics | Basic ❌ | ✅ 空数组 |
| Live Testing | Basic ❌ | ✅ 空数组 |

**README 没有夸大**，功能门控与服务端实现完全对齐。

## 7. 对自研的直接启示

1. **门控要统一**：所有受限端点返回同一个可识别错误（LSP 里用 `code` + 自定义错误），否则客户端无法引导付费/试用。
2. **补全必须服务端过滤 + 二段 resolve**：98 KB/按键在移动端或远程开发下会明显卡顿。
3. **hover 的声明位置要带路径**，否则内置库跳转无法实现（它选择了对 `.std` 不跳转，是回避而非解决）。
4. **重载解析值得做**：`mul` 返回 30+ 重载且 `active_signature=0`，用户看到的是噪音。
5. **后台进程要有健康检查**：watcher 静默死亡没有任何提示。自研时用 LSP 的 `workspace/didChangeWatchedFiles`（由 VSCode 自己管），根本不引入这个失败面。
6. **Properties 属性与 CG 全局变量应合并成同一符号**（现在 `_MainTex` 在 Outline 里出现两次）。

## 8. 复现脚本

- `probe.js`（第一轮，14 个端点）与 `probe2.js`（第二轮，补全上下文矩阵）位于
  `%TEMP%\omnishader-analysis\`；第一轮原始输出另存为 `%TEMP%\omnishader-analysis\probe-result.md`。
- 端口从 `%LOCALAPPDATA%\OmniShaderTools\*.PORT` 读取，进程命令行用 `Get-CimInstance Win32_Process` 核对。
