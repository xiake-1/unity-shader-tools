---
status: active
updated: 2026-10-28
---
# 规格 · 代码格式化（formatting）

对应模块：`server/src/formatter.ts`（新：ShaderLab 外壳打印器 + 原样输出区判定）+ `server/src/hlslPrinter.ts`（新：`HLSLPROGRAM` 内部与独立 `.hlsl` 的打印器）+ `server/src/formatSettings.ts`（新：开关归一与 `FormattingOptions` 合并）+ `server/src/server.ts`（`documentFormattingProvider` 接线与门槛联动）+ `client/package.json`（四个配置项与 `configurationDefaults`）+ `test/corpus/formatGate.mjs`（新）。

> 定位：roadmap **M5** 第三条（[../plan/roadmap.md](../plan/roadmap.md) M5）。引擎选型已由 **ADR 0011** 结清：**全自写 CST 打印器**，ShaderLab 外壳与 `HLSLPROGRAM` 内部同一套；**不引入第二个 HLSL 解析器、不引入 WASM 或原生格式化依赖**（shaderc `shader_format` 已否）；**未识别结构与 `ERROR` 区域字节级原样输出**。
> 范围经用户确认（2026-10-28）：**只做 `textDocument/formatting`（不做 range / onType）**；**覆盖 `.shader`（外壳 + HLSL 内部）与独立 `.hlsl`/`.hlslinc`，`.cginc` 不排**；**专属 4 开关 + 缩进宽度/空格读 VSCode 内置 `editor.tabSize`/`editor.insertSpaces`**（经 LSP `FormattingOptions` 传入，不重复造配置）；**门槛不达标 → 不注册 formatting provider**。
> 证据来源：[../decisions/0011-self-written-cst-formatter.md](../decisions/0011-self-written-cst-formatter.md)、[../分析/10-feature-feasibility.md](../分析/10-feature-feasibility.md) §4（必须 A3、必须分层、风险最高）、[../分析/08-pro-feature-gap-analysis.md](../分析/08-pro-feature-gap-analysis.md)（对标 4 开关形态）、[../分析/06-feasibility-and-roadmap.md](../分析/06-feasibility-and-roadmap.md) §M2（「格式化基本得自己写」）。

## 范围

1. **能力面**（经用户确认）：只实现 `textDocument/formatting`，返回**单个覆盖全文的 `TextEdit`**；`textDocument/rangeFormatting` 与 `textDocument/onTypeFormatting` 首期不做。
2. **文件覆盖**（经用户确认）：`.shader`（ShaderLab 外壳 + `program_hlsl`/`program_hlsl_include` 内部）与独立 `.hlsl`/`.hlslinc`（整文件按 HLSL 排）。`.cginc` 与 `program_cg`/`program_glsl` 的**内容不排**（`.shader` 外壳仍排）；按扩展名判定，与 `server/src/tempFiles.ts` 同类路径判定（新增 `isCgSource()`）。
3. **输入只有 CST**（设计原则 2 / ADR 0011）：外壳用 shaderlab 树（含 trivia）；`program_hlsl` 的 `_hlsl_block` 字节区间用 **tree-sitter-hlsl** 的 CST —— 即 T-004 索引已在用的那棵树（`createHlslParser`/`parseHlslFile`，`server/src/parser.ts:38,104`），**不是新引入的解析器**。已知节点：`shader_block`、`subshader_block`、`pass_block`、`properties_block`、`tags_block`、`state_command`（含 `_braced_body`）、`fallback`、`program_*`。
4. **外壳排版**：按块深度缩进（`shader_block` → `subshader_block` → `pass_block` → 块内语句）；`Properties` 每属性一行；`Tags` 每键值一行；`state_command`（`Cull`/`Blend`/`Stencil { … }` 等固定管线写法）**只重排空白与缩进，不改 token 内容与顺序** —— 语义不支持（[../project.md](../project.md) 不在范围）但结构已知，可安全缩进。
5. **原样输出区**（ADR 0011 硬约束）：以下区间**字节级原样输出**（不重排、不增删空白、不动注释）：`ERROR`/`MISSING` 节点覆盖的区间；ADR 0007 三类不可修模式命中的区间（复用 `errorExemption` 的匹配结果）；`program_cg`/`program_glsl` 内容；打印器无法归类的节点。日志记 `verbatim=<字节数>`。
6. **HLSL 内部排版**：缩进按块/函数体深度；`braceOnNewLine` 控制函数与控制流的左括号位置；`macroMatchIndent` 控制续行宏（`\`）与多行宏调用的对齐；`keepBlankLines` 控制连续空行折叠上限。token 本身不改（不加/去括号、不动逗号位置以外的东西）。
7. **配置面**（经用户确认）：专属 4 项 `unityShader.formatting.enable`（bool，默认 `true`）、`unityShader.formatting.braceOnNewLine`（bool，默认 `false`）、`unityShader.formatting.macroMatchIndent`（bool，默认 `true`）、`unityShader.formatting.keepBlankLines`（int 0–2，默认 1）。**缩进宽度与空格来源不重复造轮子**：直接取 LSP `FormattingOptions`（`params.options.tabSize` / `insertSpaces`），即 VSCode 按 `[unityshader]`/`[hlsl]` 作用域算好的内置 `editor.tabSize`/`editor.insertSpaces`。
8. **幂等与无损（硬约束，可测）**：① 两次格式化结果**字节相同**；② **token 序列不变** —— 原文与输出经同一 grammar 重新解析后的**叶子 token 序列（去 trivia）必须逐项相同**；③ 逐行 strip 空白后与原文逐行相同（「diff 仅空白变化」的机器口径）。
9. **门槛与能力注册联动**（经用户确认）：`test/corpus/formatGate.mjs`（命令 `npm run gate:format`）对三源语料（复用 `diagnosticsGate.mjs` 的 `collectCorpus`，不造第三套）逐文件断言 ①②③；**FAIL → 不注册 formatting provider**：server 在 `onInitialize` 里按 `settings.formatting.enable` 决定是否宣告 `documentFormattingProvider`，而 `configurationDefaults` 的默认值由门槛结果决定（PASS → `true`，FAIL → `false`），脚本断言两者一致；语料缺失 → `SKIP + 原因`（exit 0），绝不记 PASS。
10. **失败即不改**：打印器内部异常或断言不通过 → 返回 `null`（编辑器不改文档），日志记 `format-error=<原因>`；**绝不返回部分结果**。
11. **大文件保护**：文档字节数 > `unityShader.maxFormatFileSize`（默认 1 MiB）→ 返回 `null` + 日志 `format=too-large`。
12. **可观察性**：Output 通道健康行 `[format] files=<n> verbatim=<字节> changed=<字节>`（每次请求一行）。

## 不在范围

- `rangeFormatting`、`onTypeFormatting`（经用户确认首期不做）。
- `.cginc` 与 `CGPROGRAM`/`GLSLPROGRAM` 内部排版（CG/GLSL 语义不在范围）。
- 任何**语义**改写：移动或排序声明、排序 `Properties`、展开宏、增删语句、改大小写关键字。
- 第二个 HLSL 格式化器（shaderc `shader_format`）、WASM、原生格式化依赖（ADR 0011 已否）。
- `.editorconfig` 支持（ADR 0011 登记为未决项，首期不做）。
- codeAction 类修复、`editor.codeActionsOnSave` 联动。
- 与对标产品的格式化输出逐字节一致（设计原则 6：自定行为标准）。
- 诊断产出（格式化不产诊断、不进诊断集合，ADR 0011）。

## 约束

- 只读唯一 CST 与其 trivia；不新增解析路径（设计原则 2、ADR 0001、ADR 0011）。
- 输出必须满足范围 8 的三条（token 序列不变 / 幂等 / 仅空白变化），任一不满足即整次返回 `null`。
- 原样输出区字节级不变（范围 5）。
- 不依赖 Unity 工程发现：降级态照常格式化。
- 格式化不改动 `Temp/compiled-*`、`Temp/generatedFrom*`（返回 `null`，core 规格 §7）。
- 能力宣告在 `initialize` 时定死：门槛或用户改 `unityShader.formatting.enable` 后需**重载窗口**才生效，须在文档与日志里写明。
- 性能（2026-10-28 按 ADR 0013 细化为两档）：2001 行文档格式化 P95 —— **ShaderLab 为主**（program 块为 CG/GLSL 原样区，即本机语料 `.shader` 的真实形状）< 150 ms；**HLSL 区域为主**（最坏形状：HLSL 正文单独解析 + 建行模型）< 250 ms。两档都由 bench 扩展项度量；排版返回 `null` 记跳过，不记通过。双遍复验（幂等 + token 不变）是这个预算的必要代价，省它需要先另立 ADR。

## 异常与边界

| 场景 | 行为 |
|---|---|
| 文件含语法 Error（未闭合 `{` 等） | `ERROR` 区间原样输出，其余照常排；日志 `verbatim=`；不报错 |
| 整文件几乎全是 `ERROR`（root 无有效结构） | 返回 `null`（不改文档） |
| grammar 未覆盖的新写法 | 归入原样输出区（保守不排），日志计入 `verbatim` |
| ADR 0007 三类不可修模式（`AutoLight.cginc` 括号、顶层裸宏、`$` 占位符） | 命中即原样输出（复用 `errorExemption` 匹配） |
| 行尾注释 / 独占行注释 | 行尾注释跟随其锚定 token；独占行注释保持在其原所属块层级，**不跨语句搬移**；无法判定锚定时随所在行原样输出 |
| 连续空行 > `keepBlankLines` | 折叠到上限；`keepBlankLines=0` 时块内空行全清（块边界仍保留一个换行） |
| `HLSLPROGRAM` 内部含不可修模式 | 该区间原样，块内其余部分正常排 |
| 用户开 `editor.formatOnSave` 且文件有语法错 | 只排可排区，不弹错误、不产诊断 |
| 文档超 `maxFormatFileSize` | 返回 `null` + `format=too-large` |
| `.cginc` 文件请求格式化 | 返回 `null`（provider 已注册但该文档不改） |
| 门槛 FAIL（`configurationDefaults` 为 `false`） | 不宣告 `documentFormattingProvider`，`Shift+Alt+F` 由 VSCode 原生提示无提供者 |
| 用户把 `unityShader.formatting.enable` 从 `false` 改回 `true` | 需重载窗口才生效（能力在 initialize 定死），日志记 `format=capability-reload-required` |
| 非 Unity 降级态 | 照常格式化（与工程发现无关） |
| 打印器抛错 | 返回 `null` + `format-error=`，文档零改动 |

## 验收标准

每条映射到测试或可观察行为；基座为既有 vitest + vscode-test；语料策略沿用既有规格。

- [ ] `textDocument/formatting` 返回**单个覆盖全文**的 TextEdit（vscode-test）
- [ ] **幂等**：对工程 50 个 shader fixture 连跑两次，第二次输出与第一次字节相同（vitest）
- [ ] **token 序列不变**：格式化前后经同一 grammar 解析的叶子 token 序列（去 trivia）逐项相同（vitest，全 fixture）
- [ ] **仅空白变化**：逐行 strip 空白后与原文逐行相同（门槛脚本断言）
- [ ] `ERROR` 区间原样：造未闭合 `{` 的文件 → 该区间字节不变、其余缩进正确（vitest）
- [ ] 不可修模式原样：fixture 造 ADR 0007 模式① → 该区间字节不变（vitest）
- [ ] 外壳缩进：`Shader`/`SubShader`/`Pass`/`Properties`/`Tags` 按块深度缩进（vitest 快照）
- [ ] `state_command` 只改缩进不改 token：`Blend SrcAlpha OneMinusSrcAlpha`、`Stencil { Ref 255 Comp Always Pass Replace }` 两例（vitest）
- [ ] `braceOnNewLine=true` → HLSL 函数左括号换行；`false` → 同行（vitest 两例）
- [ ] `macroMatchIndent` 开/关 → 多行宏调用实参对齐差异可断言（vitest）
- [ ] `keepBlankLines` 三档（0/1/2）行为可断言（vitest）
- [ ] 缩进来自 `FormattingOptions`：集成里设 `[hlsl] editor.tabSize: 2` → 输出缩进 2 空格（vscode-test）
- [ ] 独立 `.hlsl` 可格式化；`.cginc` 返回 `null`（vitest + vscode-test）
- [ ] 失败即不改：注入打印器抛错的 fixture → 文档字节不变（vscode-test）
- [ ] 大文件：超 `maxFormatFileSize` → `null` + 日志（vitest）
- [ ] `Temp/compiled-x.shader` → `null`（vitest 路径判定）
- [ ] **门槛**：`npm run gate:format` 对三源语料断言幂等 + token 不变 + 仅空白变化，语料缺失记 SKIP 而非 PASS（脚本 + CI）
- [ ] 门槛与能力注册联动：FAIL → `configurationDefaults.unityShader.formatting.enable=false` 且 server 不宣告 `documentFormattingProvider`；PASS → 两者为真（脚本断言 + 集成断言 capability）
- [ ] 性能：bench 扩展项两项都过 —— 「格式化（ShaderLab 为主 2001 行，p95）」< 150 ms、「格式化（HLSL 区域为主 2001 行，p95）」< 250 ms（口径见 ADR 0013；`npm run bench` 输出 PASS/FAIL）

## 对应模块

- `specs/feature-formatting.md` ↔ `server/src/formatter.ts`（外壳打印器、原样输出区判定与 `verbatim` 统计、整次请求的失败即不改）
- ↔ `server/src/hlslPrinter.ts`（`program_hlsl` 内部与独立 `.hlsl` 的打印器、4 开关应用）
- ↔ `server/src/formatSettings.ts`（`unityShader.formatting.*` 与 LSP `FormattingOptions` 的合并与校验）
- ↔ 复用 `server/src/parser.ts`（`parseShaderLab`、`createHlslParser`/`parseHlslFile`、`walk`、`isErrorNode`/`collectErrorNodes`）、`server/src/errorExemption.ts`（不可修模式匹配 → 原样区）、`server/src/documentStore.ts`、`server/src/tempFiles.ts`（+ 新增 `isCgSource()`）
- ↔ `server/src/server.ts`：`documentFormattingProvider` 按 `settings.formatting.enable` 宣告、`onFormatting` 接线、配置项读取、`[format]` 健康行
- ↔ `client/package.json`：四个 `unityShader.formatting.*` 配置项 + `unityShader.maxFormatFileSize` + `configurationDefaults`（默认值随门槛）
- ↔ 测试：`test/unit/formatter.test.ts`、`test/unit/hlslPrinter.test.ts`、`test/src/suite/formatting.test.js`、`test/corpus/formatGate.mjs`（复用 `diagnosticsGate.mjs` 的 `collectCorpus`）
- 依赖：[feature-language-server-core.md](feature-language-server-core.md)（唯一 CST、Temp 判定、降级态）、[feature-syntax-diagnostics.md](feature-syntax-diagnostics.md)（`ERROR` 与豁免匹配是原样区的判定来源）、[../decisions/0011-self-written-cst-formatter.md](../decisions/0011-self-written-cst-formatter.md)、ADR 0001（唯一 CST）、ADR 0007（不可修模式来源）
