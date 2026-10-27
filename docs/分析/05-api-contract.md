# 05 · 客户端 ↔ 服务端 API 契约

Base URL：`http://127.0.0.1:<随机端口>`
除 `GET /basic` 外全部是 **`POST` + `FormData`（multipart）**，响应是 JSON 文本（个别是纯文本）。
坐标一律 **0-based**：`row = Position.line`，`column = Position.character`（客户端 `osPointToPosition = new Position(p.row, p.column)` 直接映射）。

位置对象是**扁平**的（实测确认，不是嵌套 `location`）：

```jsonc
{ "path": "D:\\a\\b\\x.shader",
  "start": { "row": 12, "column": 4 },
  "end":   { "row": 12, "column": 11 } }
```

> 例外：`/symbol` 的条目把位置包在 `location` 里，`/diagnostics` 也是 `{location:{start,end}, …}`。同一个协议里两种形状并存。

授权哨兵：受限功能返回哨兵值 `-1000001`（`NEED_LICENSE_ERROR`）。实测有**两种**拦截形态：

| 端点 | Basic 下的响应 |
|---|---|
| `definition` / `reference` / `rename` | `path` 字段 = `"-1000001"` |
| `format` | `code` 字段 = `"-1000001"` |
| `diagnostics` / `branch` / `doc` / 上下文补全 | **空数组 / 空字符串**（客户端无法区分"无结果"与"无权限"） |

实测数据见 [07-live-probe-results.md](07-live-probe-results.md)。

## 端点总表

| 端点 | 请求字段 | 响应 | 备注 |
|---|---|---|---|
| `GET /basic` | — | `"true"` / `"false"` | 是否处于 Basic（免费）模式 |
| `POST /update` | `path`, `code`, `remove` | 忽略 | 推送**全文**；`remove=true` 表示文件关闭/删除，`code` 传空串 |
| `POST /symbol` | `path` | `SymbolInformation[]` | `{name, kind, container, location:{path,start,end}}`（实测） |
| `POST /definition` | `path`, `row`, `column` | `{path,start,end}` 或字面量 `"null"` | 客户端对 `"null"` 走 reject |
| `POST /hover` | `path`, `row`, `column` | `{value, start, end, doc}` 或 `null` | `start/end` = **声明位置**（内置函数指向 `.std` 内行号，不带路径）；`value` 按 shader 语言着色，`doc` 走 Markdown |
| `POST /completion` | `path`, `row`, `column`, `trigger` | `{label, kind, detail, documentation, insert_text}[]` | `trigger` = 光标前一个字符；**服务端不按前缀过滤**，Basic 实测单次 936～953 项 / 98 KB |
| `POST /reference` | `path`, `row`, `column` | `{path,start,end}[]` | 未授权时首元素 `path="-1000001"` |
| `POST /rename` | `path`, `row`, `column` | `{path,start,end}[]` | 只给位置，改名由客户端生成 edit |
| `POST /signature` | `path`, `row`, `column`, `trigger` | `SignatureHelp` | 见下 |
| `POST /format` | `code`, `brace_on_new`, `tab_size`, `insert_space`, `macro_indent` | `{code}` | **传全文、返回全文**；未授权时 `code == "-1000001"` |
| `POST /diagnostics` | `path` | `Diagnostic[]` | `{location, message, severity}` |
| `POST /doc` | `path`, `row`, `column`, `trigger`, `indent_prefix` | JSON 字符串（带 `\n`/`\t` 转义） | 客户端手动剥首尾引号再反转义 |
| `POST /branch` | `path`, `keywords` | `Branch[]` | 见下 |
| `POST /quicktrial` | （空 form） | JSON | 1 天试用签发 |

## kind 枚举（服务端字符串 → VSCode）

服务端用字符串枚举，客户端做映射（`osKindToSymbolKind` / `osKindToCompletionKind`）：

```
Class Interface Field Function Keyword Method Property Struct
Value Variable File Folder Enum
```

`File/Folder` 说明**文档符号树里包含 include 的文件/目录节点**（便于在 Outline 里看到依赖）。

## SignatureHelp 响应

```jsonc
{
  "active_signature": 1,
  "active_parameter": 2,
  "signatures": [
    { "label": "float4 UnityObjectToClipPos(float3 pos)",
      "doc": "Transforms a point from object space to the camera's clip space…",
      "active_parameter": 0,
      "parameters": [ { "label": "float3 pos", "doc": "" } ] }
  ]
}
```

## Diagnostic 响应

```jsonc
[ { "location": { "start": {"row":20,"column":8}, "end": {"row":20,"column":16} },
    "message": "Undefined symbol 'foo'",
    "severity": 0 } ]
```

`severity` 直接就是 VSCode `DiagnosticSeverity`（0=Error,1=Warning,2=Information,3=Hint）—— 说明服务端 DTO 是按 VSCode 语义设计的（**移植到 LSP 时要重新映射**）。二进制里另有 `node_kind` 字段，用于按语法节点类型分类诊断。

## Branch（预处理器求值）响应

```jsonc
[ { "if_branch":     { "condition_value": 1, "start": {"row":30,"column":0}, "end": {"row":40,"column":1} },
    "elseif_branches":[ { "condition_value": 0, "start": {…}, "end": {…} } ],
    "else_branch":   { "start": {…}, "end": {…} } } ]
```

`condition_value != 0` 视为真。客户端按 C 语义（if/elif 短路）算出"永不执行"的区间，用 `createTextEditorDecorationType({color:"grey"})` 置灰。
`keywords` 参数来自文件里的 `//! KEY;KEY2:VALUE` 注释（`;` 分隔，`:` 赋值）。

## 时序约定（容易踩的坑）

1. **completion / signatureHelp 之前必须先 `/update`**：服务端按它缓存的文档状态解析，若不同步就会给出错位结果。客户端写法：
   ```js
   updateProgramToServer(doc).then(() => fetchCompletion(doc, pos, trigger))
   ```
2. **格式化之后也要 `/update`**（`updateProgramToServer2`），否则下一次 `/diagnostics` 用的是旧文本。
3. **诊断 debounce 900ms、死分支 debounce 700ms**，且都在 `onDidChangeTextDocument` 上触发；`onDidCloseTextDocument` 清 collection。
4. **`/format` 与 `/update` 传全文**，其它端点只传 `path + 坐标` —— 意味着服务端**有状态**，客户端崩溃重启后必须重新喂文档（这也是 watcher 进程存在的意义）。

## 与标准 LSP 的对照

| 它的端点 | LSP 等价 | 差异 |
|---|---|---|
| `/update` | `didOpen`/`didChange`（增量） | 它传全文，简单但费带宽 |
| `/symbol` | `documentSymbol` | 它返回扁平 `SymbolInformation`，无层级 |
| `/definition` `/reference` `/rename` | 同名 | 一致 |
| `/completion` | `completion` + `resolve` | 无 resolve、无 detail/labelDetails/排序字段 |
| `/hover` | `hover` | 一致（value + markdown） |
| `/signature` | `signatureHelp` | 一致 |
| `/format` | `formatting` | 全文替换，非 TextEdit 列表 |
| `/diagnostics` | `publishDiagnostics`（服务端推） | 它改成**客户端拉**，配合 debounce 定时器 |
| `/branch` | 无（近似 semantic tokens / 自定义请求） | 私有扩展 |
| `/doc` | 无（近似 code action 生成注释） | 私有扩展 |

**结论**：它的协议是"LSP 的 80% 子集 + 两个私有扩展 + 拉模型诊断"。自研时**建议直接实现标准 LSP**，把 `/branch`、`/doc` 作为 `$/` 前缀的自定义请求，这样能白拿 Neovim / Emacs / Zed / Visual Studio / Rider 的接入能力。
