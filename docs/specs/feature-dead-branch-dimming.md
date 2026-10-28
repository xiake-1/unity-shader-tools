---
status: active
updated: 2026-10-28
---
# 规格 · `#if` 死分支灰化（dead branch dimming）

对应模块：`server/src/unityKeywordSource.ts`（新，读 Unity `Editor.log`）+ `server/src/preprocessorEval.ts`（新，三态求值）+ `server/src/inactiveRegions.ts`（新，分支 Range 收集）+ `server/src/server.ts`（能力协商、防抖、扩展通知）+ `client/src/extension.ts`、`client/package.json`（装饰、命令、配置项）。

> 定位：roadmap **M4** 的用户可见功能之二（M4 标题「语法诊断与死分支灰化」），对标产品的 Live Testing（Pro）。跨模块选型已由 **ADR 0008** 结清：关键字源 = Unity 全局 `Editor.log` 的 `Disabled keywords:`；求值在 server 侧基于唯一 CST；呈现走 LSP 扩展通知 + 客户端装饰；**不用诊断集合、不用 semantic tokens、不引入 `//! KEY:VALUE` 行内注释语法**。
> 范围经用户确认（2026-10-28）：**刷新 = 打开文档时读 + 定时轮询 mtime（变化才重读）**；**装饰只灰分支体，不含 `#if`/`#elif`/`#else`/`#endif` 条件行**；**提供「重新读取 Unity 关键字」命令 + Output 健康行**。
> 证据来源：[../分析/09-implementation-options.md](../分析/09-implementation-options.md) §0/§5（`%LOCALAPPDATA%\Unity\Editor\Editor.log` 里的 `Disabled keywords:` 实测存在）、[../分析/10-feature-feasibility.md](../分析/10-feature-feasibility.md) §5c（2～3 天、无需 Unity 包桥）、[../分析/02-vscode-client.md](../分析/02-vscode-client.md) §4.2（对标 = 服务端求值 + 客户端 `setDecorations`，debounce 700 ms）、[../分析/90-evidence-index.md](../分析/90-evidence-index.md)（`UNUSED_CODE_STYLE` 灰色装饰）、[../decisions/0008-dead-branch-dimming-editor-log.md](../decisions/0008-dead-branch-dimming-editor-log.md)。

## 范围

1. **关键字来源**：读 Unity 全局 `Editor.log` —— Windows `%LOCALAPPDATA%\Unity\Editor\Editor.log`、macOS `~/Library/Logs/Unity/Editor.log`、Linux `~/.config/unity3d/Editor.log`；解析 `Disabled keywords: A B C …` 行得到**确定关闭**集合。只解析这一行；不做 Unity 版本/包清单推断。
2. **三态求值**（ADR 0008/0009 的保守方向）：每个 `#if` 条件求为 **假 / 真 / 未知**。**只有确定为假的分支才灰**；未知一律不灰。求值输入：
   - 标识符：在 Disabled 集合 → 假；不在 → **未知**（不假设「启用」）；
   - 当前文件的 `#define`/`#undef`（含 `#define X 1`/`#define X`）参与求值；include 闭包内的 `#define` 首期不参与 → 记未知；
   - 整数常量 `0`/`1`、`defined(X)` / `defined X`、`!`/`&&`/`||`/括号、`==`/`!=`（仅两侧均可判定时）；
   - 任一子表达式未知导致整体不可判定 → 整体未知（不做部分求值灰化）。
3. **分支结构来源**：唯一 CST 的 `preproc_if`/`preproc_ifdef`/`preproc_ifndef`/`preproc_elif`/`preproc_else`/`preproc_endif` 节点（设计原则 2）；不新增文本级预处理器扫描。
4. **`#elif` 链与嵌套口径**：`#elif` 只有在其前面所有分支都确定为假时才参与求值；前面任一分支未知 → 该分支及其后所有分支不灰。嵌套 `#if`：外层分支已确定为假 → 整块外层分支体一次灰，内层不再单独求值、不产重复 Range。
5. **装饰 Range**（经用户确认）：**只覆盖分支体**，起点为条件行的下一行行首、终点为下一个 `#elif`/`#else`/`#endif` 前一行行末；条件行保持正常配色。
6. **server → client 契约**：自定义通知 **`unityshader/inactiveRegions`**，payload `{ uri, version, regions: [{ start, end, condition }] }`。命名沿用仓库既有自定义通知 `unityshader/indexProgress`（`server/src/server.ts:187`）；ADR 0008 决策段写的 `$/unityShader/inactiveRegions` 是 LSP 私有通知前缀的示例写法，**实际通知名以本规格为准**（命名属实现细节，不改 ADR 文件）。客户端在 `initialize` 的 `capabilities.experimental['unityshader/inactiveRegions'] = true` 声明支持；未声明 → server 不发。
7. **客户端装饰**：`createTextEditorDecorationType`，颜色取 `ThemeColor('disabledForeground')`，取不到时回退 `opacity: 0.45`；不硬编码具体色值（对标硬编码 `color:"grey"`，不照抄）。装饰只作用于活动编辑器可见文档；`didClose`、切换编辑器、切换文档版本时正确清理。
8. **刷新策略**（经用户确认）：`didOpen` 时读一次；此后 server 进程内定时器按 mtime 轮询（默认 5000 ms，`unityShader.keywordPollMs`，0 = 关闭轮询），**mtime 未变则不重读、不解析**；日志只读尾部窗口（默认 512 KiB，`unityShader.keywordLogScanBytes`）。关键字集合变化 → 对当前已打开文档重算并推送。
9. **命令与可观察性**（经用户确认）：命令 `unityshader.refreshShaderKeywords`（title `Unity Shader: Refresh Unity Keywords`）→ 强制重读日志、重算并推送；Output 通道健康行 `[keywords] source=<日志路径|none> disabled=<N> age=<mtime> regions=<M>`，日志缺失时 `source=none`。
10. **语言与文件覆盖**：`.shader`/`.hlsl`/`.hlslinc`/`.cginc`；`Temp/compiled-*`、`Temp/generatedFrom*` 不灰化；**非 Unity 降级态照常工作**（`Editor.log` 与工程发现无关）。
11. **防抖**：求值与推送独立于语法诊断，`didChange` 防抖默认 700 ms（`unityShader.branchDebounceMs`，对标同值）；`didOpen`/`didSave`/关键字变化立即推送。

## 不在范围

- **`//! KEY:VALUE` 行内注释覆盖语法**（对标 Live Testing 的手动覆盖）—— ADR 0008 明确不引入。
- **变体切换 / 重新编译 / 变体计数**（对标 Live Testing 的另一半）→ 依赖 M6 Unity 包侧，本规格不做。
- **Unity 关键字默认值表**（如「`SHADER_API_D3D11` 通常开启」）：首期不引入，未知即不灰；将来若要提覆盖度须先补规格（并评估误报）。
- **改变 F12 / 补全 / Rename 的行为**：M2/M3 已定「不求值、全分支都算」（feature-rename §8），本功能**只加装饰，不改**这些功能对死分支内符号的处理；回归语料须钉住这一点。
- 语法诊断与类型诊断 → [feature-syntax-diagnostics.md](feature-syntax-diagnostics.md)、M5 DXC（ADR 0004）。
- semantic tokens、`DiagnosticTag.Unnecessary`（ADR 0008 已否）；非 VSCode 客户端的灰化（不实现扩展通知即自然缺席）。
- 多工程/多 Unity 实例的关键字归属区分（ADR 0008 已登记为接受的负面）。

## 约束

- 求值只读唯一 CST（设计原则 2；ADR 0001）；不新增第二套预处理器解析路径。
- **只有确定为假才灰**（宁可不做不可做错，与设计原则 4 同源；ADR 0008/0009）。
- 关键字匹配**大小写敏感**（C 预处理语义），不做模糊/前缀匹配。
- 不引入独立 watcher 进程（core 规格「不在范围」保持）；轮询是 server 进程内定时器，mtime 未变不解析。
- 日志读取有上限（默认尾部 512 KiB）与失败降级；读日志失败**不得**弹窗、不得影响其它功能。
- 通知 payload 带文档 `version`；客户端丢弃 version 不匹配的推送（编辑后旧 Range 不得套到新文本上）。
- 性能：2000 行 shader 的「求值 + 推送」P95 < 150 ms（与 hover/completion 同预算，bench 扩展项）；轮询空转（mtime 未变）不得产生可测 CPU 峰值。
- 首期单根工作区（core 规格约束）；`Editor.log` 路径按平台推导，与 `unityShader.unityEditorPath` 无关。

## 异常与边界

| 场景 | 行为 |
|---|---|
| `Editor.log` 不存在（从未启动 Unity） | 不灰化、不报错；Output `[keywords] source=none`（roadmap M4「日志缺失时降级为不灰化且不报错」） |
| 日志存在但无 `Disabled keywords:` 行 | 视为空集合 → 全部未知 → 不灰化；Output `disabled=0` |
| 日志被占用 / 权限失败 / 读取异常 | 保留上一次集合继续工作，Output 记 `stale=true`；不弹窗、不崩溃 |
| 日志巨大（数十 MB） | 只扫尾部窗口；命中行在窗口外 → 视为未命中并记 `scanned=<bytes>` |
| 多 Unity 实例 / 多工程 | 读到的是全局最近一次 Editor 会话的关键字（ADR 0008 已接受）；Output 显示 `age=<mtime>` 供用户判断陈旧 |
| `#if UNKNOWN_MACRO`（不在 Disabled 集合、文件内无 `#define`） | 未知 → 不灰化 |
| `#if defined(A) && !defined(B)` 仅一侧可判定 | 整体未知 → 不灰化 |
| `#ifdef X` / `#ifndef X`，X 在 Disabled 集合 | `#ifdef` 分支体灰、`#else` 分支不灰；`#ifndef` 反之 |
| `#elif` 链中前面分支未知 | 当前及其后分支全部不灰（不猜激活分支） |
| 嵌套 `#if`，外层分支确定为假 | 只产外层 Range，内层不重复产（不重叠装饰） |
| ShaderLab 外壳里的 `#if`（ShaderLab 无预处理器） | 不处理（grammar 不产 `preproc_if`） |
| 客户端未声明 `experimental` 支持 | server 不发通知，功能静默缺席，无错误 |
| 编辑后收到旧 `version` 的推送 | 客户端丢弃，不产生装饰 |
| server 崩溃/无响应 | 走 core 规格重启策略；重连后 `didOpen` 重新触发读取与推送，旧装饰清空 |
| 灰化与语法诊断同时存在 | 互不影响（不同通道、不同集合） |

## 验收标准

每条映射到测试或可观察行为；基座为 T-006（vitest + vscode-test）。Editor.log 与工程都用自包含 fixture（合成日志文件 + fixture 工程），真实日志仅作补充样本。

- [ ] 求值三态：`#if SHADER_API_GLES30` 在 Disabled 集合 → 分支体 1 条 Range；不在集合 → 零 Range（vitest）
- [ ] `#ifdef`/`#ifndef`：关键字在集合 → 分别灰 `#ifdef` 体 / `#else` 体；不在集合 → 零 Range（vitest 四例）
- [ ] `#elif` 链：前支真 → 后支不灰；前支假且当前支假 → 当前支灰；前支未知 → 全不灰（vitest 三例）
- [ ] 复合表达式：`defined(A) && !defined(B)` 可判定 → 灰；一侧未知 → 零 Range（vitest）
- [ ] 当前文件 `#define X 0` → `#if X` 分支灰；`#undef X` 后 → 未知不灰（vitest）
- [ ] 嵌套：外层假 → 只产外层 Range，断言无重叠 Range（vitest）
- [ ] Range 边界：起点 = 条件行下一行行首、终点 = 下一个 `#elif`/`#else`/`#endif` 前一行行末；条件行不在任何 Range 内（vitest 逐处断言，经用户确认口径）
- [ ] 日志解析：fixture 含 `Disabled keywords: A B C` → 集合 {A,B,C}；无该行 → 空集合；文件不存在 → `source=none`（vitest）
- [ ] 尾部窗口：fixture 造 2 MB 日志，关键字行在尾部 → 命中；在窗口外 → 不命中且记 `scanned=`（vitest）
- [ ] 轮询：mtime 变化 → 重读并推送新 Range；mtime 未变 → 不重读（vitest 断言解析调用次数）
- [ ] 通知契约：vscode-test 断言客户端收到 `unityshader/inactiveRegions`，payload 含 `uri`/`version`/`regions`（含 `condition` 文本）
- [ ] 装饰落地：vscode-test 断言活动编辑器上该 Range 有装饰（客户端暴露的调试计数），且切换编辑器后清空
- [ ] version 丢弃：编辑后旧 `version` 的推送不产生装饰（vitest 客户端逻辑 / 集成）
- [ ] 命令与 Output：执行 `unityshader.refreshShaderKeywords` → Output 出现 `[keywords] source=… disabled=N regions=M`（vscode-test 读 Output 通道）
- [ ] 日志缺失降级（roadmap M4 第三条）：fixture 指向不存在的日志路径 → 无装饰、无错误弹窗、Output `source=none`（vscode-test）
- [ ] 不影响既有功能（回归）：沿用 rename 零误改语料，死分支内**目标符号**的 occurrence 仍被改名、F12 仍可跳 → 行为不变（vitest）
- [ ] 性能：bench 扩展项「死分支求值」2000 行 shader 采样 20 次 P95 < 150 ms；轮询空转 60 s 无可测 CPU 峰值（`npm run bench` + 脚本）

## 对应模块

- `specs/feature-dead-branch-dimming.md` ↔ `server/src/unityKeywordSource.ts`（新：三平台日志路径、尾部窗口、mtime 轮询、Disabled 行解析）
- ↔ `server/src/preprocessorEval.ts`（新：三态求值、`defined`/逻辑算子、当前文件 `#define`/`#undef`）
- ↔ `server/src/inactiveRegions.ts`（新：`preproc_*` 节点遍历、`#elif` 链与嵌套口径、分支体 Range 组装）
- ↔ 复用 `server/src/parser.ts`（`walk`）、`server/src/documentStore.ts`、`server/src/tempFiles.ts`
- ↔ `server/src/server.ts`：`capabilities.experimental` 协商、`unityshader/refreshKeywords` 内部命令、防抖定时器、`connection.sendNotification('unityshader/inactiveRegions', …)`
- ↔ `client/src/extension.ts` + `client/package.json`：装饰类型、`experimental` 能力声明、命令 `unityshader.refreshShaderKeywords`、三个配置项（`unityShader.keywordPollMs`、`unityShader.keywordLogScanBytes`、`unityShader.branchDebounceMs`）
- ↔ 测试：`test/unit/preprocessorEval.test.ts`、`test/unit/unityKeywordSource.test.ts`、`test/unit/inactiveRegions.test.ts`、`test/src/suite/deadBranch.test.js`
- 依赖：[feature-language-server-core.md](feature-language-server-core.md)（唯一 CST、文档同步、降级态、Temp 关闭智能）、[../decisions/0008-dead-branch-dimming-editor-log.md](../decisions/0008-dead-branch-dimming-editor-log.md)（关键字源与呈现机制）、ADR 0002（LSP 宿主与扩展通知边界）、[feature-syntax-diagnostics.md](feature-syntax-diagnostics.md)（同属 M4，互不依赖）
