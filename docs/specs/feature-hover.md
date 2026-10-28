---
status: active
updated: 2026-10-28
---
# 规格 · 悬停（hover）

对应模块：`server/src/hover.ts`（新）+ `server/src/semanticTable.ts`（新，自写语义表）；客户端仅能力转发（ADR 0002）。

> 定位：F12 与补全之后的下一个「查找」形态。触发来源：用户手动测试报告（2026-10-28）——`SV_Target`/`SV_POSITION` 等 HLSL 系统值语义**没有任何源码声明**（编译器保留字），F12 必然空结果（F12 规格已把关键字类归入空结果面），用户的「查找」诉求无处安放。经用户确认（2026-10-28）：**悬停文档 + 冒号后语义补全**成对做；后者作为 feature-completion 的修订项，不在本规格内重复。
> 证据来源：[../分析/02-vscode-client.md](../分析/02-vscode-client.md)（对标产品 hover = 声明代码块 + Markdown 文档两段）、[../分析/07-live-probe-results.md](../分析/07-live-probe-results.md)（`/hover` 返回 `{value, doc}`；对标对内置库故意不跳转）、[../分析/10-feature-feasibility.md](../分析/10-feature-feasibility.md)（真实源码索引路线：声明与注释都来自真源）。

## 范围

1. **LSP 能力**：server 在 `initialize` 声明 `hoverProvider: true`；客户端不注册独立 HoverProvider（走标准 LSP）。
2. **悬停对象**（标识符位置；复用 `definition.ts` 的 `nodeAtCursor`/`NAME_TYPES`/`closureOrder`/`rankOf`，不写第二套上下文判定）：
   - **符号**（变量/函数/struct/字段/宏/Properties 属性，符号索引可解析者）：内容两段——① fenced 代码块（```hlsl，声明所在**源文本行**：按最优声明位置的行号从文件文本切一行，打开文档优先、否则读盘；不反渲染 AST）；② 文档（索引邻近注释 → `macroTable` 兜底 → 空则省略该段）。多处声明按 F12 同一优先级（当前文件→闭包→包→内置）取最优一条，多于一条时代码块后注明「共 N 处声明」。
   - **语义**（光标在语义标识符上：struct 字段 `: SEM` = CST `bitfield_clause` 内 identifier；函数返回值 `: SEM` = CST `semantics` 节点内 identifier）：显示**自写语义表**（`semanticTable.ts`）描述——`SV_*` 系统值语义 + `POSITION`/`NORMAL`/`TANGENT`/`COLOR n`/`TEXCOORD n`/`UV n` 等约定数据流语义，含前缀规则（`TEXCOORD\d*` 等）；查名**大小写不敏感**（`SV_POSITION` 与 `SV_Position` 同一词条）。表内没有的语义 → 通用说明（「用户自定义数据流语义，非编译器保留字」），不返回 null。
3. **语言与文件覆盖**：与补全规格一致（`unityshader`/`hlsl`；`Temp/compiled-*`、`generatedFrom*` 生成文件不响应；ShaderLab 外壳标识符不悬停）。

## 不在范围

- **类型推断悬停**（悬停变量显示「类型 v2f」、悬停表达式显示类型）—— 属类型系统，M5 DXC（ADR 0004）。
- **关键字/内置类型名悬停**（`float4`、`struct`、`return`）→ null。
- **ShaderLab 外壳悬停**（`Tags`/`Pass`/Property drawer 说明）。
- **复制对标产品 `.std` 或微软官方文档文本**（设计原则 1）：语义表与宏描述全部自写。
- `completionItem/resolve` 式懒加载（文档内联）；hover 内嵌「跳转链接」可点击声明（v2 再议）。

## 约束

- 只读唯一 CST、符号索引与 includeResolver（设计原则 2）；hover 不触发第二套解析、不触发重建索引。
- 声明行只从文件文本切取（`DocumentStore` 打开文档优先 → `fs` 读盘），不 AST 反渲染。
- 性能：索引完成后单次 hover P95 < 150 ms（与补全同预算，bench 扩展项采样）。
- 索引进行中：按当前已索引结果回答，不等待、不报错。

## 异常与边界

| 场景 | 行为 |
|---|---|
| 光标在关键字、内置类型名、数字、注释、字符串上 | null，不报错、不记错误日志 |
| 标识符不在索引（未声明） | null（存在性校验属 M4 诊断） |
| 语义不在表内（如 `MY_CHANNEL0`） | 通用说明，非 null |
| 最优声明的文件已删除 | 顺延下一优先级声明；全部不可读 → 只回文档段或 null |
| 多行声明（函数跨行） | 代码块只含声明首行（v1 限制，记录于此） |
| 生成文件（Temp） | null |
| server 崩溃或无响应 | 核心规格重启策略；期间无悬停，不弹错误框 |

## 验收标准

语料策略沿用：真实 Unity 源样本 + 自包含 fixture（与 completion 同构）。

- [ ] 符号（函数，包内真源）：代码块含声明行、文档来自邻近注释（vitest）
- [ ] 符号（宏）：无邻近注释 → `macroTable` 描述（vitest）
- [ ] 符号（Properties 属性）：代码块含 Properties 声明行（vitest）
- [ ] 符号（多处声明）：按优先级取当前文件一条，注明共 N 处（vitest）
- [ ] 语义：`SV_Target`（函数返回值处）与 `SV_POSITION`（struct 字段处）→ 语义表描述非空；`SV_POSITION` 与 `SV_Position` 命中同词条（vitest）
- [ ] 语义（未知）：`MY_CHANNEL0` → 通用说明（vitest）
- [ ] 空结果面：`float4` 关键字、未声明标识符、ShaderLab 外壳 → null（vitest + 集成）
- [ ] 集成：`vscode.executeHoverProvider` 对 `SV_Target` 返回语义描述文本（vscode-test）
- [ ] 性能：bench 扩展项 hover 采样 20 次 P95 < 150 ms（`npm run bench`）

## 对应模块

- `specs/feature-hover.md` ↔ `server/src/hover.ts`（新）、`server/src/semanticTable.ts`（新）
- ↔ 复用 `definition.ts`（`nodeAtCursor`/`rankOf`/`closureOrder`）、`symbolIndex.ts`（`getByName`、邻近注释 doc）、`macroTable.ts`（兜底）、`documentStore.ts`（打开文档文本）
- ↔ `server/src/server.ts`：`hoverProvider: true` + `connection.onHover`
- 依赖：[feature-language-server-core.md](feature-language-server-core.md)（索引/文档同步/降级态）、[feature-go-to-definition.md](feature-go-to-definition.md)（同一解析与优先级口径）、ADR 0001（唯一 CST）、ADR 0003（真实源码索引）
