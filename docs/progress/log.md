# 进度日志（只追加）

## 2026-10-27 14:55 · 其他：docs 体系初始化
- 结果: 由 /project-docs-init 在 `VSCode/Shader/` 建立 docs 骨架（project.md、plan/roadmap.md、plan/backlog.md、
  progress/status.md、progress/log.md、reference/conventions.md、specs/、decisions/、archive/）与根 README.md；
  既有 `docs/分析/`（12 份对标产品逆向分析）原样保留，仅在新 docs/README.md 索引中登记
- 验证证据: `docs/README.md`、`docs/project.md`、`docs/plan/roadmap.md`、`docs/plan/backlog.md`、
  `docs/progress/status.md`、`docs/progress/log.md`、`docs/reference/conventions.md` 均已落盘；
  索引内链接目标全部存在

## 2026-10-27 14:50 · 重要变更：确认首期技术栈与范围
- 结果: 确认解析层选 A3（tree-sitter：现成 tree-sitter-hlsl + 自写 shaderlab grammar）；
  宿主走标准 LSP（TS 客户端 + TS LSP server）；首期范围含转到定义、语义补全、Rename、语法诊断、
  类型诊断（外包 DXC）、`#if` 死分支灰化、Unity 包侧；验证命令定为 vitest + @vscode/test-electron
- 验证证据: 决策依据见 `docs/分析/09-implementation-options.md` 与 `docs/分析/10-feature-feasibility.md`；
  尚未落 ADR，由 T-008 承接

## 2026-10-27 18:26 · 重要变更：ADR 0001 解析层采用 tree-sitter（自写 shaderlab grammar + 现成 tree-sitter-hlsl）
- 结果: 落 ADR 0001，记录 A1/A2/A3/A4 备选取舍与「一套 CST 服务所有功能」约束；grammar 的 native/WASM binding 明确留待 T-001 决策
- 验证证据: `docs/decisions/0001-treesitter-parsing-layer.md` 落盘；`docs/README.md` ADR 清单已登记

## 2026-10-27 18:26 · 重要变更：ADR 0002 宿主形态采用标准 LSP（stdio）+ TS 客户端与独立 TS server
- 结果: 落 ADR 0002，记录 C1（扩展内实现）与对标产品私有 HTTP 两条被否路线；崩溃重启策略指向规格 feature-language-server-core
- 验证证据: `docs/decisions/0002-standard-lsp-host.md` 落盘；`docs/README.md` ADR 清单已登记

## 2026-10-27 18:26 · 重要变更：ADR 0003 内置与包内符号来自索引真实源码，不手写 stub 库
- 结果: 落 ADR 0003，记录 B1（.std stub）/B3（DXC 作符号源）被否理由；宏展开规则表与动态路径定位作为已接受的代价登记
- 验证证据: `docs/decisions/0003-index-real-source-symbols.md` 落盘；`docs/README.md` ADR 清单已登记

## 2026-10-27 18:26 · 重要变更：ADR 0004 HLSL 类型诊断外包给 DXC，不自研类型系统
- 结果: 落 ADR 0004，记录自研类型系统/表驱动半自研被否理由；类型诊断零误报门槛前默认关闭或降级为 Hint 的策略随之确定
- 验证证据: `docs/decisions/0004-dxc-type-diagnostics.md` 落盘；`docs/README.md` ADR 清单已登记

## 2026-10-27 18:38 · 任务完成：T-007 编写规格 specs/feature-language-server-core.md
- 任务: T-007 编写规格 `specs/feature-language-server-core.md`
- 结果: 规格落盘，含范围/不在范围/约束/异常与边界/验收标准/对应模块六节；15 条验收标准逐条标注验证方式；五个歧义点（核心范围切分、索引时机、降级行为、崩溃策略、性能阈值）经用户逐项确认
- 验证证据: `docs/specs/feature-language-server-core.md` 存在且六节齐备；ask_user 五问全部获用户选择确认；`docs/README.md` 规格清单与 `docs/specs/README.md` 已登记

## 2026-10-27 18:38 · 任务完成：T-008 补记 4 条技术决策 ADR
- 任务: T-008 补记 4 条技术决策 ADR
- 结果: 落 ADR 0001（tree-sitter 解析层）、0002（标准 LSP 宿主）、0003（索引真实源码）、0004（类型诊断外包 DXC），各含背景/决策/后果与被否备选
- 验证证据: glob 实测 `docs/decisions/` 下 4 个 ADR 文件（0001～0004）与 README 一致；`docs/README.md` ADR 清单 4 行与实际文件一致；log 已含 4 条「重要变更：ADR」事件

## 2026-10-27 18:38 · 其他：M1 拆项入 backlog 并开 sprint-01
- 结果: 新增 T-009～T-013（文档同步/工程发现/include 解析/符号索引/性能基准，依据 spec:feature-language-server-core）；T-002 验收补崩溃重启策略；新建 `plan/sprint-01.md`（选入 T-001～T-006、T-009～T-013）；roadmap M1 置 active
- 验证证据: `docs/plan/backlog.md` 含 T-009～T-013 条目；`docs/plan/sprint-01.md` 存在；`docs/plan/roadmap.md` M1 节标 active

## 2026-10-27 20:38 · 任务完成：T-003 自写 shaderlab tree-sitter grammar
- 任务: T-003 自写 `shaderlab` tree-sitter grammar
- 结果: `grammar/grammar.js` + 外部扫描器 `grammar/src/scanner.c`（33 个命名外部 token，关键字大小写不敏感由 scanner 产生、上下文敏感性来自 parser 传入的 `valid_symbols`）；程序块体为隐藏外部叶子，只识别边界。语料 12 例覆盖 Shader/SubShader/Pass/Properties/Tags/HLSLPROGRAM…ENDHLSL/HLSLINCLUDE/CGINCLUDE/#include/#define/#ifdef/Fallback Off/UsePass/GrabPass/Category/Stencil 块/大小写混写/注释。修掉两类真实缺陷：`word` 与 `prop_name` 同形 token 导致 `MISSING "prop_name_token1"`；`pass_block` 漏出 `block_item` 导致 Pass 内全部报错
- 验证证据: `npm run grammar:test` → 12/12 ✓（`grammar/test/corpus/shaderlab.txt`）；`node grammar/scripts/corpus-check.js` → `files=50 withError=0 pct=0.0%`（阈值 <2%，语料为 `D:\Work\Unity\ShaderStudy\Assets`）；`grammar/build/Release/shaderlab_binding.node` 编译通过（node-gyp 13 + MSVC）

## 2026-10-27 20:38 · 任务完成：T-004 集成 tree-sitter-hlsl 到程序块
- 任务: T-004 集成现成 `tree-sitter-hlsl` 到程序块
- 结果: `server/src/parser.ts` 用「虚拟 HLSL 文档」手法——把程序块外内容替换为等长空白（保留换行），使 HLSL 节点行列与 `.shader` 文件完全一致，无需偏移换算；CG 块同样送入 HLSL grammar（CG 是 HLSL 子集），GLSL 块不索引。`tree-sitter-hlsl@0.2.0` 自带 win32-x64 prebuild，无需编译
- 验证证据: `npx vitest run test/unit/hlsl.test.ts` → 30 例全绿（26 个构造用例 ≥20 验收下限：函数/struct/CBUFFER/TEXTURE2D/SAMPLER/成对宏/#define/#include/#pragma/#ifdef/for/if/三元/数组/静态常量/宏续行/矩阵/实例化缓冲等）；符号断言含 `Frag=function`、`v2f=struct`、`_MainTex.viaMacro=TEXTURE2D`；坐标一致性用例断言 `.shader` 第 8 行第 13 列

## 2026-10-27 20:38 · 任务完成：T-001 建立工程骨架（client/server/grammar/test）
- 任务: T-001 建立工程骨架（client / server / grammar / test 四个包）
- 结果: 根 `package.json` 以 npm workspaces 串起四包；`build` = server(tsc→out) + client(esbuild→dist)；`test`=vitest、`test:vscode`=vscode-test、`bench`=node 脚本、`grammar:generate|test`。client 为扩展清单所在包（languages/grammars/snippets/configuration 贡献点）
- 验证证据: `npm run build` exit 0 → `server/out/server.js` 11987B、`client/dist/extension.js` 793424B；`node --check` 两个产物均通过；`npm test` → `Test Files 8 passed / Tests 79 passed`

## 2026-10-27 20:38 · 任务完成：T-009 文档同步与解析管线（增量重解析 + Temp 关闭智能）
- 任务: T-009 文档同步与解析管线（didOpen/didChange 增量 + tree-sitter 增量重解析 + Temp 生成文件关闭智能）
- 结果: `server/src/documentStore.ts` 把 LSP 全量/增量 contentChanges 换算为 tree-sitter edit（注意 0.22.4 node 绑定要求 `newEndPosition`/`newEndIndex` 命名，且 `parse` 第三参不是 edits 数组——先 `tree.edit()` 再传旧树）。修掉真实接线缺陷：`documents.listen()` 在 `start()` 末尾注册会覆盖自定义 `onDidChangeTextDocument`，导致增量编辑不进符号表
- 验证证据: `npx vitest run test/unit/documentStore.test.ts` → 9 例全绿（增量树与全量解析 `rootNode.toString()` 相等；`Temp/compiled-*`、`Temp/generatedFrom*`、`Temp/__Generated` 判定 5 例；生成文件不解析不索引）；`test/unit/lspServer.test.ts` 增量用例：真实 stdio 握手后 didChange 插入 `float _Renamed;`，`__indexStats` 符号数由 2 增至 ≥3

## 2026-10-27 20:38 · 任务完成：T-010 Unity 工程根与 Editor 路径发现 + 非 Unity 降级
- 任务: T-010 Unity 工程根与 Editor 路径发现 + 非 Unity 文件夹降级
- 结果: `server/src/unityProject.ts` 按规格四级判定（路径分段 → 向上找 `Assets`+`Library` → 首个 workspace folder → 降级），Editor 目录兜底链为「配置项 → Unity Hub `editors-v2.json`/`editors.json` → 安装根扫描」；缺失只记 `degradedReasons`，不抛错。server 侧降级提示经 `notifyDegraded()` 保证只发一次
- 验证证据: `npx vitest run test/unit/unityProject.test.ts` → 8 例全绿（分段/向上查找/workspace 回退/`ProjectVersion.txt` 解析/完整环境组装/Hub 发现/非工程降级/Editor 未知降级）；`test/unit/lspServer.test.ts` 真实 stdio：`window/showMessageRequest` 恰 1 条 Information「未识别到完整 Unity 工程」，`proc.exitCode` 保持 null（不崩溃）。说明：规格写的 vscode-test 路径改为更严格的真实 stdio 断言，VS Code 集成用例另行覆盖语言注册与重启策略

## 2026-10-27 20:38 · 任务完成：T-011 include 解析四类与结构化失败记录
- 任务: T-011 include 解析四类与结构化失败记录
- 结果: `server/src/includeResolver.ts` 实现相对路径 / `Assets/…` / `Packages/<pkg>/…`（本地 `Packages/` 与 `Library/PackageCache/<pkg>@*` 双候选）/ 裸名 → `Editor/Data/CGIncludes`；候选按优先级有序，未命中返回 `{reason, spec, tried[]}` 结构化记录（`empty-spec`/`no-search-root`/`not-found`），不发诊断（属 M4）
- 验证证据: `npx vitest run test/unit/includeResolver.test.ts` → 10 例全绿（四类各命中、Windows 反斜杠写法、`not-found` 带 tried 列表、无搜索根、空规格、同名文件相对路径优先于内置目录）

## 2026-10-27 20:38 · 任务完成：T-012 符号索引与查询 API（含宏声明表）
- 任务: T-012 符号索引与查询 API（含 Unity/URP 已知宏声明表 30～50 条）
- 结果: `server/src/symbolIndex.ts` 提取 `Properties` 属性、全局变量、函数（含原型与定义）、struct 及字段、`#define`、宏声明；`server/src/macroTable.ts` 40 条 Unity/URP 宏。同名符号合并为一条逻辑符号保留全部 location（`_MainTex` 的 Properties 与 HLSL 声明归并，kind 取 property）；`#if` 分支同名声明保留两处不求值。踩到的真实语法事实：`CBUFFER_END` 换行后 `TEXTURE2D(_MainTex);` 被 HLSL grammar 解析成「类型 + function_declarator」，且宏参数位是 `parameter_declaration` 下的 `type_identifier`——两处都已在提取器处理
- 验证证据: `npx vitest run test/unit/symbolIndex.test.ts` → 9 例全绿（属性 kind/行号、变量/函数/struct/字段 kind、同名合并 2 处 location、`#if` 重复 2 处、`TEXTURE2D`/`SAMPLER`/`TEXTURE2D_ARGS` 宏声明带 `viaMacro`、重索引不残留、`removeFile`、include 闭包递归到 `c.hlsl`）；bench 实测 164 文件产出 4101 符号

## 2026-10-27 20:38 · 任务完成：T-013 性能基准
- 任务: T-013 性能基准：冷启动全量索引 <3s、增量重解析 <100ms、RSS <500MB
- 结果: `test/bench/run.mjs`（`npm run bench`）对真实工程 `D:\Work\Unity\ShaderStudy` + 2022.3 内置 `CGIncludes` 采样，输出 JSON 与 PASS/FAIL；可用 `BENCH_PROJECT`/`BENCH_EDITOR` 覆盖语料
- 验证证据: `node --expose-gc test/bench/run.mjs` → `files=164 symbols=4101`；冷启动全量索引 2002.47ms（<3000）；增量编辑中位数 1.93ms、p95 4.05ms（<100）；索引后 RSS 187.68MB、结束 191.62MB（<500）；末行 `bench PASS`

## 2026-10-27 20:38 · 其他：实现期确定的两处技术做法（不改 ADR）
- 结果: ①程序块内 HLSL 的坐标对齐采用「虚拟 HLSL 文档」（块外替换等长空白）而非偏移换算，符合 ADR 0001「一套 CST」且不引入第二套解析路径；②ShaderLab 状态命令是行导向的，但 newline 不作为 token，故 `Cull Off ZWrite On` 会并入同一命令的参数序列——结构偏粗、零 ERROR，已写入 `grammar.js` 注释，不影响符号索引与后续诊断
- 验证证据: `server/src/parser.ts` 的 `buildVirtualHlsl` 与 `test/unit/parser.test.ts` 等长/坐标一致性断言；`grammar/grammar.js` `state_command` 上方注释；`grammar/test/corpus/shaderlab.txt` 第 7 例（Stencil 块）通过

## 2026-10-27 21:24 · 任务完成：T-002 打通 LSP 通道与生命周期（含崩溃重启 ≤3 次）
- 任务: T-002 打通 LSP 通道与生命周期
- 结果: client 以 stdio 起独立 server 进程（宿主 Node/Electron + 显式 `ELECTRON_RUN_AS_NODE=1`）；`RestartGuard(3)` + `UnityShaderErrorHandler` 实现「崩溃自动重启 ≤3 次、超限停止并提示」；server 自报 pid（`__indexStats`）以便外部断言进程身份。修掉两个真实接线缺陷：① v9 的 `clientOptions.errorHandler` 要 **ErrorHandler 实例**，传工厂函数会让 `closed()` 变 undefined、异常被吞后回落 DoNotRestart；② `closed()` 返回**裸枚举**时 client 读的是 `handlerResult.action`（undefined），两个分支都不匹配 → 既不重启也不提示、状态还停在 Running，属静默失效；两处均改为 `{ action }` 对象形式
- 验证证据: `npm run test:vscode` → 6/6 ✓ exit 0（独立副本 VS Code 1.143.1）：`LSP server 启动并持有进程` ✓；外部 `taskkill` 后 2.2s 内出现新 boot（`server-boot.log`: `boot pid=32168 | boot pid=33648`），输出通道三次 `Connection to server got closed. Server will restart.`，第四次 `Server will not be restarted.`，其后 12s 观察期无新 pid ✓；`npx vitest run test/unit/lspServer.test.ts` 真实 stdio 握手：`initialize` 返回 `textDocumentSync=2`、`shutdown`/`exit` 后进程退出 ✓；`Get-CimInstance Win32_Process` 按命令行匹配 `server\out\server.js` → 无残留进程

## 2026-10-27 21:24 · 任务完成：T-005 高亮 grammar + snippets + language-configuration
- 任务: T-005 高亮 grammar + snippets + language-configuration
- 结果: 自写 `client/syntaxes/shaderlab.tmLanguage.json`（properties/tags/stencil 仓库，程序块内 embed `source.hlsl`）、`client/snippets/shaderlab.code-snippets`（8 个片段）、`client/language-configuration.json`（括号/注释/缩进/`wordPattern`，并补 `folding.markers` 支持 `//#region`/`//#endregion`）；语言 id `unityshader` 绑定 `.shader/.hlsl/.hlslinc/.cginc`
- 验证证据: 集成用例 `打开 .shader 文件后语言为 unityshader` ✓、`T-005：#region/#endregion 折叠可用` ✓（`vscode.executeFoldingRangeProvider` 返回 ≥1 区间）、`T-005：shader 片段可插入` ✓（补全项 `insertText` 含 `Shader "`）；四个 JSON 资产 `JSON.parse` 全部通过；视觉项「高亮无错色」留人工，新增 `npm run vscode:playground` 用独立副本打开 `D:\Work\Unity\ShaderStudy` 核对

## 2026-10-27 21:24 · 任务完成：T-006 配置测试基座 vitest + vscode-test
- 任务: T-006 配置测试基座 vitest + vscode-test
- 结果: `vitest.config.ts`（`test/unit/**`，fork 池）+ `test/src/runTest.js`（vscode-test，独立副本 `.vscode-test/standalone`，不碰本机安装；临时 Unity fixture 作 workspace）+ 迷你 runner `test/src/suite/index.js`。关键环境事实：宿主（DSH 自身是 Electron）注入 `ELECTRON_RUN_AS_NODE=1`，继承给 `Code.exe` 会让它退化成纯 Node 并把首个参数当模块加载（报 `Cannot find module <工作目录>`），runTest 入口必须清除该变量
- 验证证据: `npm test` → `Test Files 8 passed / Tests 79 passed`；`npm run test:vscode` → 6 例全绿 exit 0；`npm run bench` → `bench PASS`。验收原文「断言一个 Provider 返回结果」按 M1 实际能力替换为断言语言注册 + LSP 生命周期 + 折叠/片段贡献点（M1 无 Provider，属规格范围外）

## 2026-10-27 21:24 · 其他：sprint-01 全部 11 项完成，roadmap M1 置 done
- 结果: T-001～T-006、T-009～T-013 全部完成并从 backlog 移除；roadmap M1 四条阶段验收标准勾选；新增 `npm run vscode:playground` 作为人工视觉核对入口
- 验证证据: `npm run grammar:test` 12/12；`node grammar/scripts/corpus-check.js` → `files=50 withError=0 pct=0.0%`；`npm run build` exit 0；`npm test` → 79 passed；`npm run test:vscode` → 6/6 exit 0；`node --expose-gc test/bench/run.mjs` → `bench PASS`（RSS 192.3MB）；`docs/plan/backlog.md` 待办节已空

## 2026-10-27 21:44 · 其他：激活事件补 `workspaceContains`，playground 加隔离与可辨识标记
- 结果: `client/package.json` 激活事件由单一 `onLanguage:unityshader` 扩为再加 `workspaceContains:**/*.shader` 与 `**/*.hlsl`——打开含 shader 的工程窗口即激活并开始后台索引，不必先点开一个文件（此前命令面板搜不到任何命令、扩展面板看不到插件，均因「已加载未激活」）；`test/src/playground.js` 额外传 `--extensions-dir` 并给 profile 写入显眼窗口标题 `🧪 Shader Playground | ${rootName}`，避免与本机 VS Code 同名文件夹窗口混淆
- 验证证据: 独立副本日志 `正在 d:\...\client 处加载开发扩展程序`（`playground-profile/logs/.../window1/renderer.log`）证明 dev extension 已加载；改后 `npm run test:vscode` → 6/6 ✓ exit 0（`index done ... files=1 symbols=2` 在打开文件前即出现）；`Win32_Process` 命令行核对 playground 实例带 `--user-data-dir=...playground-profile --extensions-dir=...`，且 `playground-profile\extensions` 为空 → 不含本机已装扩展

## 2026-10-27 22:00 · 其他：修高亮失效——自带 HLSL grammar 并拆分语言 id
- 结果: 根因是 `shaderlab.tmLanguage.json` 里 `{ "include": "source.hlsl" }` 指向一个**不存在的 grammar**（VS Code 不内置 HLSL），TextMate 对解析不到的 include 会**静默丢弃整条规则**，于是 `CGPROGRAM…ENDCG` 整段（含边界关键字与块内 HLSL）无任何 scope、全部显示为白色。新增自写 `client/syntaxes/hlsl.tmLanguage.json`（scopeName `source.hlsl`：预处理/语义/关键字/类型/Unity 函数与宏/字符串/数字）；语言 id 拆分：`.shader` → `unityshader`（`source.shaderlab`），`.hlsl/.hlslinc/.cginc` → `hlsl`（`source.hlsl`），客户端 `documentSelector` 同步加 `hlsl`，snippets 对两种语言都贡献
- 验证证据: 新增 `test/unit/tmLanguage.test.ts` 用 `vscode-textmate` + `vscode-oniguruma` 真实分词断言：`Shader/SubShader/Pass/CGPROGRAM/ENDCG`→`keyword.other.shaderlab`、`fixed4`→`storage.type.hlsl`、`struct`→`keyword.other.hlsl`、`SV_POSITION`→`support.type.semantic.hlsl`、`UnityObjectToClipPos`→`support.function.unity.hlsl`、程序块内裸 token 数为 0；`npx vitest run` → `Test Files 9 passed / Tests 84 passed`；`npm run build` exit 0；`npm run test:vscode` → 6/6 ✓ exit 0。默认主题 `dark_vs` 对 `keyword`/`storage` 给 #569cd6，故 scope 落地即可见色

## 2026-10-27 22:06 · 其他：playground 里 `.shader` 显示为 Plain Text 的根因＝工程 `files.associations`
- 结果: 测试工程 `D:\Work\Unity\ShaderStudy\.vscode\settings.json`（VSTU 生成）把 `*.shader/*.cginc/*.cg/*.hlsl/*.compute` 关联到语言 id **`UnityShader`**（VSTU 的 id），而 `files.associations` 优先级高于扩展按扩展名的语言注册；隔离实例里该 id 无人提供 → 回落 `Plain Text`，故 grammar 与 semantic tokens 全不可用（`Inspect Editor Tokens and Scopes` 显示 "No grammar or semantic tokens available"）。我们的 id 是 `unityshader`，与 VSTU 的 `UnityShader` 不互通。附带查清：`--user-data-dir` 不改变扩展目录（仍是 `~/.vscode/extensions`），只有 `--extensions-dir` 才隔离——这解释了 21:31 那次独立副本为何加载了本机扩展
- 验证证据: 读取该 settings.json 得到上述 5 条关联；用户截图状态栏为 `Plain Text`；`npm run test:vscode` 首条断言「打开 `.shader` 文件后语言为 unityshader」在同一独立副本下通过（临时工作区无该 settings），证明差异来自工程关联而非插件注册

## 2026-10-27 22:20 · 其他：HLSL grammar 补 Unity 内置符号；澄清配色差异来自 2026 Dark 主题
- 结果: 用户实测高亮已生效但 `UNITY_LIGHTMODEL_AMBIENT` 无色、`SV_Target` 无色——`hlsl.tmLanguage.json` 新增 `unity-builtins` 规则组：`UNITY_*`/`unity_*`→`support.constant.unity.hlsl`、`_WorldSpaceLightPos0`/`_Time`/`_ScreenParams` 等全局 uniform→`support.variable.unity.hlsl`、`appdata(_base|_full)`/`a2f`/`v2f`/`SurfaceOutput*`→`support.type.unity.hlsl`；语义规则改为大小写不敏感并补 `TARGET/INSTANCE_ID/COVERATE`。另澄清「颜色与预期不符」不是 bug：该 VS Code 1.143 默认主题是 **2026 Dark**（`2026-dark.json` → dark_modern → dark_plus → dark_vs），其 `keyword`/`storage storage.type`→#ff7b72、`entity.name.function`→#d2a8ff、`support`→#79c0ff，先前按 dark_vs 的 #569cd6 预测故不符
- 验证证据: 像素采样 + 3 倍裁剪确认 `fixed4/fixed3/struct` 鲑红、`SV_POSITION/NORMAL` 青绿、`UnityObjectToClipPos` 卡其、数字 #BACDA3、字符串 #A5D6FF；`npx vitest run` → `Test Files 9 passed / Tests 85 passed`（新增 Unity 内置符号断言：`UNITY_LIGHTMODEL_AMBIENT`/`_WorldSpaceLightPos0`/`appdata_base`/`SV_Target` 各有 scope）

## 2026-10-27 22:36 · 其他：`#region` 补 scope；Editor 发现补默认安装根；playground 预填编辑器路径
- 结果: ① `#region/#endregion` 此前无任何 scope（`preprocessor` 规则不含 region），新增 `region-marker` 规则到 ShaderLab 与 HLSL 两份 grammar：标记→`keyword.other.region.*`、区域标题→`entity.name.section.region.*`。② 查清 `findEditorDir` 的扫描分支在生产中**从未启用**（`extraEditorRoots` 默认 `[]`），新增 `defaultEditorRoots()`（win32：`%ProgramFiles%\Unity\Hub\Editor`、`%ProgramFiles%\Unity`、`%ProgramFiles(x86)%\Unity\Hub\Editor`、`%LOCALAPPDATA%\Programs\Unity\Hub\Editor`；darwin：`/Applications/Unity/Hub/Editor`；linux：`$HOME/Unity/Hub/Editor`、`/opt/unity`、`/usr/share/unity3d`），测试用 `noDefaultEditorRoots` 保持确定性。③ `test/src/playground.js` 复用 server 同一套发现，把结果预填进 **`.vscode-test/playground-profile/User/settings.json`**（gitignore 内的开发 profile，不进扩展包、不碰用户 profile），便携安装用 `.vscode-test/dev.local.json` 或 `UNITYSHADER_EDITOR` 兜底
- 验证证据: `npx vitest run` → `Test Files 9 passed / Tests 88 passed`（新增 3 例：region scope、`<root>/<version>/Editor` 扫描发现、`defaultEditorRoots` 三平台）；`npm run build` exit 0；`node -e` 调 `discoverUnityEnvironment` → `editorDir=D:\Soft\Work\Unity\UnityEditor\2022.3.62f3c1\Editor cg=…\Data\CGIncludes degraded=无`；`npm run vscode:playground` 输出「探测到 Unity Editor…→ 预填进 profile」，profile settings.json 已含 `unityShader.unityEditorPath`

## 2026-10-27 22:40 · 其他：T-005 视觉项人工复核结果与仍待复核项
- 任务: T-005 语言注册与 TextMate grammar（已归档任务的视觉验收项承接）
- 结果: 用户在带 `🧪` 标题的 playground 实例里复核：ShaderLab 与 HLSL 着色正常、`#region/#endregion` 可折叠。复核过程中报出两处缺陷并已修复——`#region` 无着色（22:36）、`UNITY_LIGHTMODEL_AMBIENT`/`SV_Target` 无着色（22:20）。仍待人工确认三项：片段插入（输入 `shader`/`blend` 出片段）、`.cginc/.hlsl` 走新的 `hlsl` 语言、修复后 region 与 Unity 内置符号的最终着色及 `Show Index Stats` 中 `degraded` 清空 / `includeRoots` 含 CGIncludes 与 PackageCache
- 验证证据: 用户两张截图（状态栏 `Unity Shader`；`#region Test` 行左侧折叠箭头）；此前 `Inspect Editor Tokens and Scopes` 报 "No grammar or semantic tokens available" 出现在语言关联修复之前（见 22:06 事件）；对应修复的测试证据见 22:00 / 22:20 / 22:36 三条事件（`npx vitest run` 88 例全绿、`npm run build` exit 0、`npm run test:vscode` 6/6 exit 0）

## 2026-10-27 22:52 · 其他：M1 人工复核结清；真实工程经 LSP 全链路的索引实测
- 任务: T-005 语言注册与 TextMate grammar（视觉项结清）
- 结果: 用户复核确认片段插入、`.cginc/.hlsl` 走新的 `hlsl` 语言、`Show Index Stats` 与着色折叠均正常 → 22:40 列出的三项待复核全部结清，M1 无遗留人工项。另用一次性 stdio 探针走真实 LSP 链路（`initialize` → `initialized` → `workspace/executeCommand unityshader/__indexStats`）对 `D:\Work\Unity\ShaderStudy` 实测：Editor 已发现后 `degraded` 为空、`includeRoots` 三类齐全（projectRoot / `Editor\Data\CGIncludes` / `Library\PackageCache`），索引 **164 文件 / 4101 符号**，冷索引 **1402ms**（`initialize` 往返 96ms）——已低于 roadmap M2 的「< 3 秒」门槛，可作 M2 全量语料 bench 的基线
- 验证证据: 探针输出 `index done in 1402ms: files=164 symbols=4101 degraded=no`、`includeRoots.cgIncludesDir=D:\Soft\Work\Unity\UnityEditor\2022.3.62f3c1\Editor\Data\CGIncludes`；探针文件 `test/tmp-indexstats.cjs` 已删除；`Get-Process node` 复核残留 server 进程数 0

## 2026-10-27 23:10 · 重要变更：ADR 0005 grammar 分发采用随 VSIX 附带的 N-API prebuilds
- 结果: 结清 ADR 0001 留下的「native 还是 WASM、打包工具」未决项（不取代 0001）。决策 = 发布流程用 `prebuildify --napi --strip` 产出 `grammar/prebuilds/<platform>-<arch>/shaderlab_binding.node`，与上游同构、随**单一 vsix** 附带；不在安装期编译（VSIX 不跑 `npm install`）、不走 WASM（Node 内明显更慢 + 要第二套运行时 API）、不做首次运行下载；打包面同时确定：client esbuild bundle、**server tsc 不 bundle**（bundle 破坏 `node-gyp-build` 基于 `__dirname` 的 prebuild 查找）、`@vscode/vsce` + `.vscodeignore`。已否：E1 安装期 node-gyp、E2 WASM 单文件、E3 首次运行下载、E4 native+WASM 兜底（musl 报告出现再议）
- 验证证据: `docs/decisions/0005-grammar-prebuild-distribution.md` 落盘、`docs/README.md` ADR 清单已登记、`docs/project.md` 技术栈占位符 `{{待补…}}` 已填；依据事实实测：`node_modules/tree-sitter/prebuilds/` 与 `node_modules/tree-sitter-hlsl/prebuilds/` 各含 6 平台 `.node`、`grammar/bindings/node/index.js` 走 `node-gyp-build`（prebuilds → build/Release）、`.gitignore` 忽略 `build/` 与生成物 `grammar/src/parser.c`、仓库无 `.vscodeignore` 与 vsce 脚本；N-API 在 Electron-as-node 宿主可用由 `npm run test:vscode` 6/6 佐证（log 21:24）

## 2026-10-27 23:12 · 重要变更：ADR 0006 语言 id 保持 unityshader/hlsl，与 VSTU 的 UnityShader 三层共存
- 结果: 主 id **不采用** VSTU 的 `UnityShader`（该 id 属微软 Unity 扩展、活的，双注册时语言与 grammar 归属不确定，大写违反 conventions §8）；共存三层 = ① LSP `documentSelector` 额外接受 `UnityShader`（对方在装时我们仍接管定义/引用/补全/semantic tokens）② 运行时自愈：对扩展名属于我们且 `languageId === 'plaintext'` 的文档调 `vscode.languages.setTextDocumentLanguage` 切到我们的 id，只改会话不改设置 ③ 命令 `Unity Shader: Fix file associations`（用户确认后写工作区）。`.cg`/`.compute` 首期不新增注册，已被关联到 `hlsl` 时按 HLSL 解析、只索引不发诊断。已否：L1 采用 `UnityShader`、L2 只靠文档、L3 `configurationDefaults`（只改默认层，工作区设置照样覆盖）。同时把 log 22:00 的语言 id 拆分登记为决策
- 验证证据: `docs/decisions/0006-language-id-vstu-coexistence.md` 落盘、`docs/README.md` ADR 清单已登记；事实来源 log 22:00（id 拆分与 TextMate 静默丢规则）、22:06（VSTU 关联 → 回落 Plain Text、`unityshader` 与 `UnityShader` 不互通）、21:44（`workspaceContains` 激活故后台仍在索引）；现读 `D:\Work\Unity\ShaderStudy\.vscode\settings.json` 确认关联已被手工改为 `unityshader` / `hlsl`；外部佐证 VS Code 文档「casing matters for exact identifier matching」与对标产品作者对该 id 冲突未解的说明（OmniShader ISSUES #9）

## 2026-10-27 23:19 · 重要变更：规格 feature-go-to-definition 落盘（M2 转到定义）
- 结果: 新建 `docs/specs/feature-go-to-definition.md`，六段齐备。范围含 10 类符号：当前文件 HLSL 声明、`Properties` 属性（与同名 HLSL 声明合并）、宏生成声明（`TEXTURE2D`/`SAMPLER`/`CBUFFER_START`，走 40 条已知宏表）、include 闭包内工程内文件、包内 `PackageCache` 与内置 `CGIncludes` 真实声明行、局部变量与函数参数（遮蔽取最近作用域）、`变量.字段` 单层浅推断、`#pragma vertex/fragment` 入口函数、`#include` 字符串。多义策略 = 全部返回并按「当前文件 → include 闭包 → 工程内 → 包内 → 内置」排序，>10 截断并记 `truncated=`；返回前对每个 location 做存在性校验。明确不做：类型驱动成员跳转（`i.uv.xy`、函数返回值成员、swizzle）与预处理器求值（归 M5 DXC / M4）
- 验证证据: 五个歧义点经用户逐项确认（符号面全选含局部变量与成员访问、多义全部返回排序、F12 P95 < 200 ms、索引未完成立即返回、语料 = 真实工程 + fixture）；`docs/README.md` 规格清单与 `docs/specs/README.md` 已登记；roadmap M2 五条验收标准全部映射进验收节（`_MainTex` / `TransformWorldToHClip` / `UnityObjectToClipPos` / include 四类；冷索引 <3 s 由核心规格承接，实测 1402ms 见 log 22:52）；19 条验收逐条标注验证方式（vitest / vscode-test / bench）

## 2026-10-27 23:20 · 重要变更：规格 feature-language-server-core 一处待决项由 ADR 0005 结清
- 结果: 约束节原「grammar 的 native 还是 WASM binding、打包工具（esbuild/tsup）未定 —— 属 T-001/T-008 待决事项」改为「N-API prebuilds 随单一 VSIX 附带；client esbuild bundle、server tsc 不 bundle —— 已由 ADR 0005 结清」。范围与验收标准未变
- 验证证据: `docs/specs/feature-language-server-core.md` 约束节改动；受影响任务扫描：`plan/backlog.md` 待办为空、无引用该规格的未完成条目 → 无受影响任务 ID；不需要新 ADR（ADR 0005 已落，见 23:10 事件）

## 2026-10-27 23:24 · 其他：M2 拆项入 backlog（T-014～T-020）并开 sprint-02
- 结果: 七条功能任务全部取依据自已确认规格 `spec:feature-go-to-definition` —— T-014 definition 核心（多义按「当前文件→include 闭包→工程内→包内→内置」排序、>10 截断、返回前存在性校验）、T-015 局部变量与参数作用域与遮蔽、T-016 `变量.字段` 单层浅推断、T-017 `#pragma vertex/fragment` 与 `#include` 四类跳转、T-018 真实工程三条跳转与编辑即时性、T-019 语言 id 覆盖（`documentSelector` 含 `UnityShader`，ADR 0006 第 1 层）与降级/非响应面、T-020 F12 P95 基准。新建 `plan/sprint-02.md`（只引用 ID）；roadmap M2 置 active，并按既有证据勾选其两条阶段标准（include 四类、冷索引 <3 s）。**未建任务**：ADR 0006 第 2/3 层（运行时自愈、`Fix file associations` 写用户设置）属用户可见行为须先 `/project-spec`；ADR 0005 发布流水线属工程任务但不在 M2 范围，待排期
- 验证证据: 新 ID 起于历史最大号 T-013 之后（grep `T-0\d\d` 核对 backlog/sprint/log/spec：历史仅 T-001～T-013，新增 T-014～T-020 无重复无复用）；七条均含「依据 + 可验证验收」；`plan/backlog.md` 待办 7 条与 `plan/sprint-02.md` 选入 ID 一致；`docs/README.md` 计划区登记 sprint-02 并把 sprint-01 标为已完成迭代；roadmap 勾选依据 = log 20:38（`includeResolver.test.ts` 10 例全绿）与 log 20:38 / 22:52（冷索引 2002ms → 1402ms < 3s）

## 2026-10-28 00:35 · 任务完成：T-014 definition 核心（多义排序、截断、存在性校验）
- 任务: T-014 `textDocument/definition` 核心
- 结果: 新增 `server/src/definition.ts`（光标 token → 分类：include 字符串 / `#pragma` 入口 / 成员访问 / 局部作用域 / 全局符号 → `Location[]`）并在 `server/src/server.ts` 注册 `connection.onDefinition` + `definitionProvider` 能力。排序键 = 当前文件(0) → include 闭包(1，按 include 出现顺序) → 工程内(2) → 包内 PackageCache(3) → 内置 CGIncludes(4)；>10 截断并记 `truncated=<n>`；返回前逐个 `fs.statSync` 存在性校验并记丢弃数。打开文档按 store 的树对象缓存虚拟 HLSL 树、磁盘文件按 mtime 缓存。顺带修 `symbolIndex` 两处：struct 字段带 `owner`（同名不同 struct 不串味）、`bitfield_clause` 不再当声明（`float2 uv : TEXCOORD0` 的语义名此前会被索引成字段）
- 验证证据: 新增 `test/unit/definition.test.ts` 21 例全绿 —— `SharedFn` 跨层顺序断言 `[inc.hlsl, SpaceTransforms.hlsl, UnityCG.cginc]`、`Dup2` 闭包顺序 inc→inc2、12 处同名返回 10 条且日志含 `truncated=12`、删除已索引目标文件后该 location 不出现；`npm test` → `Test Files 11 passed / Tests 115 passed`

## 2026-10-28 00:35 · 任务完成：T-015 局部变量与函数参数（就近作用域与遮蔽）
- 任务: T-015 局部变量与函数参数跳转
- 结果: 新增 `server/src/scopeResolver.ts` 的 `findLocalDeclarations`：从光标节点沿 `parent` 向上，依次收内层块声明 → 该层函数参数 → 外层块 → 外层参数，天然就近优先；命中局部即只返回局部（遮蔽语义）。局部与参数不入符号索引，全部从打开文档的实时 CST 取（`declaredIds` 只取 `init_declarator` 的直接 identifier，不取初始化表达式里的名字）
- 验证证据: `definition.test.ts` 三例：内层 `float d = 2.0;` 遮蔽外层（命中行 25）、外层引用命中行 22、`IN.uv` 的 `IN` 命中参数行 20 且 range 文本为 `IN`

## 2026-10-28 00:35 · 任务完成：T-016 `变量.字段` 成员访问（单层浅推断）
- 任务: T-016 `变量.字段` 成员访问跳转
- 结果: `scopeResolver.localDeclaredType` / `globalDeclaredType` 取点号左侧的声明类型（局部 → 参数 → 当前文件顶层 → include 闭包内最多 40 个文件按需解析），再用符号索引里字段位置的 `owner` 过滤到该 struct；点号左侧不是裸 identifier（链式 `i.uv.x`）或类型未知（`primitive_type`、未声明变量）一律返回空，类型驱动成员留 M5
- 验证证据: `definition.test.ts`：`i.uv` 命中 `struct v2f` 内 `uv`（断言 range 文本 `uv`）、`i.uv.x` 返回 0 条、`UnknownVar.uv` 返回 0 条、另一 struct 的同名字段不串味（`Other o; o.uv` 只回 `Other` 那条）

## 2026-10-28 00:35 · 任务完成：T-017 `#pragma` 入口函数与 include 四类跳转
- 任务: T-017 ShaderLab 侧跳转（`#pragma vertex/fragment`、`#include`）
- 结果: `#pragma` 走 `preproc_arg` 按空白分段定位光标所在段，关键字在 `vertex/fragment/geometry/hull/domain/compute/patch/prefetch` 集合内才把后续名字当函数引用（`only_renderers` 等不跳）；include 字符串复用 `includeResolver.resolveInclude` 四类规则，未解析只记日志不发诊断（诊断属 M4）
- 验证证据: `definition.test.ts`：`#pragma vertex vert` → `inc.hlsl` 第 3 行且 range 文本 `vert`；`#pragma only_renderers d3d11` 返回空；四类 include（`inc.hlsl` / `Assets/Shaders/inc2.hlsl` / `Packages/com.unity.render-pipelines.core/…` 回退到 PackageCache / `UnityCG.cginc` 回退到 CGIncludes）各得目标 URI；`#include "Nope.hlsl"` 返回空

## 2026-10-28 00:36 · 任务完成：T-018 真实工程三段跳转与编辑即时性
- 任务: T-018 真实工程三条跳转 + 编辑即时性
- 结果: 新增 `test/unit/definitionRealProject.test.ts`（真实 stdio LSP 全链路，语料 `D:\Work\Unity\ShaderStudy` + 真实 Editor，抽公共客户端 `test/unit/lspClient.ts`）与 `test/src/suite/definition.test.js`（vscode-test）。两处事实修正：① 2022.3.62f3c1 里 `UnityObjectToClipPos` 声明在 `UnityShaderUtilities.cginc`（两个重载）加 `UnityInstancing.cginc` 的 `#define`，**不在** `UnityCG.cginc`；② 该工程 Assets 无 URP include，故包内跳转用临时探针文档（`Packages/…` 按 workspace 根解析），不往用户工程写文件
- 验证证据: stdio 5 例全绿：`_MainTex` → 同文件 Properties 行且 range 文本 `_MainTex`；`UnityObjectToClipPos` → `…\Data\CGIncludes\UnityShaderUtilities.cginc` 第 43 行；`TransformWorldToHClip` → `Library\PackageCache\com.unity.render-pipelines.core@14.0.12\ShaderLibrary\SpaceTransforms.hlsl` 第 114 行；F12 后 `__indexStats` 的 files/symbols 不变。vscode-test：`T-018：F12 从 _MainTex 用法跳回 Properties 声明（落在名字本身）` ✓、`T-018：编辑后新声明立即可跳`（`applyEdit` 插入 `float _Inserted;` 后 F12 命中该行）✓

## 2026-10-28 00:36 · 任务完成：T-019 语言 id 覆盖与降级/非响应面
- 任务: T-019 语言 id 覆盖与降级/非响应面
- 结果: `client/src/extension.ts` 的 `documentSelector` 增加 `{ scheme: 'file', language: 'UnityShader' }`（ADR 0006 第 1 层，id 大小写原样），`client/package.json` 加 `onLanguage:UnityShader` 激活事件；`server.ts` 对生成文件（`Temp/compiled-*` 等）直接返回空并记日志。修一处潜伏缺陷：`documentStore.parse()` 此前对 `.hlsl` 也走 ShaderLab grammar（与其自身注释相反），现按扩展名分派，并让 `parseHlslFile` 支持 tree-sitter 增量重解析 —— 否则打开的 `.hlsl` 拿不到 HLSL 树，跳转与成员访问全失效
- 验证证据: vscode-test 6 例：`.hlsl` 文档 F12 ✓、打包产物 `client/dist/extension.js` 含 `language: "UnityShader"` 与 `language: "unityshader"` ✓、注释 / `Cull Off` / 数字字面量返回空 ✓、`Temp/compiled-generated.shader` 返回空（server 日志 `definition suppressed for generated file`）✓；vitest `lspServer.test.ts` 新增降级态一例（同文件 `_V` 可跳、`UnityObjectToClipPos` 返回空、`window/showMessageRequest` 仍只 1 条、进程存活）

## 2026-10-28 00:37 · 任务完成：T-020 F12 性能基准
- 任务: T-020 F12 性能基准
- 结果: `test/bench/run.mjs` 增 F12 段：真实工程索引完成后，对 ≤2000 行的 6 个 `.shader` 采样 20 次 `provideDefinition`（预热 3 次），新增阈值项「F12 中位数 / P95 < 200 ms」与「F12 后索引规模变化 = 0」
- 验证证据: `npm run bench` → `bench PASS`：F12 中位数 0.40ms、P95 5.76ms、`samples=20 hits=20`、索引变化 0；同次冷索引 1270ms、增量编辑 p95 3.64ms、RSS 191→194MB。真实 stdio 端到端另测 median 1.2ms / p95 8.5ms（`definitionRealProject.test.ts` 打印 `[bench] F12 端到端 …`）

## 2026-10-28 00:38 · 重要变更：规格 feature-go-to-definition 三条验收按实测校正
- 结果: ① 内置跳转落点由 `UnityCG.cginc` 改为「CGIncludes 目录内 + 名字 token」（实测声明在 `UnityShaderUtilities.cginc`）；② 「索引进行中」项由 vscode-test 改 vitest（索引分片让出、真实窗口时序不可控），并以 `indexing()` 注入断言日志含「索引进行中」；③ 语言 id 覆盖项拆出「VSTU 残留关联 → plaintext 回落」——该项依赖 ADR 0006 第 2/3 层，须另立规格后再验收，本轮只验收 `unityshader`/`hlsl` 与打包产物含 `UnityShader` selector。另记实测事实：**VS Code 会把多结果按 URI 重排**，故「当前文件优先」的顺序断言只在服务端（vitest / stdio）做，vscode-test 只断言集合与落点
- 验证证据: `docs/specs/feature-go-to-definition.md` 三条改动；同一 fixture 两侧对照 —— 服务端 stdio 返回 `[def.shader:2, def.shader:8, bench.shader:2]`，vscode-test 的 `[def-integration]` 日志返回 `[bench.shader:2, def.shader:2, def.shader:8]`

## 2026-10-28 00:40 · 其他：sprint-02 全部 7 项完成，roadmap M2 置 done
- 结果: T-014～T-020 完成并按规范 §7 从 backlog 移除；roadmap M2 五条阶段标准全部勾选；`plan/sprint-02.md` 置 done。测试基建两处改动：`test/src/suite/index.js` 支持 `UNITYSHADER_TEST_FILTER` 子串过滤（崩溃用例很慢，迭代时用它只跑定义用例）、用例模块顺序改为 definition 在前（extension.test.js 的崩溃用例会永久杀掉 server）
- 验证证据: `npm run build` exit 0；`npm test` → `Test Files 11 passed / Tests 115 passed`；`npm run test:vscode` → 12/12 ✓ exit 0（`集成测试全部通过`）；`npm run bench` → `bench PASS`

## 2026-10-28 00:41 · 其他：状态文档按规范收敛，根 README 的「当前状态」行校正
- 结果: `progress/status.md` 重写为规范 §2 的四段格式（进度 3 行、进行中/阻塞为「无」、下一步只给 ID 指向）；`plan/sprint-02.md` 删掉临时加的「迭代结果」段——结果与证据归 log，sprint 只留目标 / ID / 边界 / 验收条件；根 `README.md` 的「当前状态」行自 M1 起一直写着「docs 骨架已建立，尚未开始编码」，校正为「M1 地基与 M2 转到定义已完成，M3 待立规格」
- 验证证据: `status.md` 实测 24 行（≤40 上限）；`backlog.md` 中 `- [ ]` 计数为 0；`plan/sprint-02.md` frontmatter `status: done` 且正文无任务状态描述；roadmap M2 节标题为 `（done）`
