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

## 2026-10-28 07:57 · 其他：M3 拆项入 backlog（T-021～T-033）
- 结果: 十三条功能任务拆自两份已确认规格——`spec:feature-completion` 七条（T-021 索引前缀查询与邻近注释存储、T-022 completion 核心与上下文判定、T-023 struct 成员、T-024 `#include` 路径、T-025 Unity API 与用户宏 + 文档兜底链、T-026 过滤/排序/截断、T-027 集成与 P95<150ms 基准）；`spec:feature-rename` 六条（T-028 occurrence 收集扩展、T-029 references 核心、T-030 rename 核心与新名校验、T-031 Properties/`sampler_` 联动与资产提示、T-032 零误改回归语料、T-033 集成与性能基准）。roadmap M3 置 active 并加「范围补充」行；backlog「尚未入 backlog」节只剩 M4～M6。未建 sprint-03（开迭代时再选入）
- 验证证据: 新 ID 起于历史最大号 T-020 之后（grep `T-0(2[1-9]|[3-9]\d)` 全 docs 仅命中 conventions.md 示例文本，无重复无复用）；十三条均含「依据: spec:<已确认规格> + 可验证验收」；两份规格 `docs/specs/feature-completion.md`、`docs/specs/feature-rename.md` 六节齐备且已在 `docs/README.md` 与 `docs/specs/README.md` 登记

## 2026-10-28 08:42 · 其他：开 sprint-03（M3 补全与引用），status 与根 README 承接
- 结果: 新建 `plan/sprint-03.md`（frontmatter active；只引用 ID，选入 T-021～T-033 全部十三条；边界节明确本轮不做 M4/M5/M6、一般标识符补全、宏展开、资产改写、内置改名、预处理器求值）；`docs/README.md` 计划区登记当前迭代；`progress/status.md` 重写为四段格式（进行中＝无、下一步＝前置 ID）；根 `README.md`「当前状态」行由「M3 待立规格」校正为「M3 经 sprint-03 进行中」
- 验证证据: `plan/sprint-03.md` 存在且选入 ID 与 `backlog.md` 待办 13 条 `- [ ]` 一一对应（grep 计数一致）、正文无任务状态描述；`status.md` 实测 22 行（≤40 上限）、「下一步」仅 ID；根 README 19 行（≤60 上限）

## 2026-10-28 08:53 · 任务完成：T-021 索引扩展：前缀查询 API + 邻近注释存储
- 任务: T-021 索引扩展：按前缀查名 API + `#define`/函数声明邻近注释随索引存储
- 结果: `symbolIndex.ts` 新增 `queryByPrefix`（惰性排序名表 + 二分定位，大小写敏感、字典序、limit；`indexFile`/`removeFile` 时失效重建）与 `fileNames()`（T-028 遍历用）；`SymbolInfo.doc` 由 `precedingComment()` 抓取 `preproc_def`/`function_definition` 上方连续注释兄弟（行注释去 `//`、块注释去界符与 `*` 对齐符），同名逻辑符号合并取第一个非空 doc
- 验证证据: `npx vitest run test/unit/completionIndex.test.ts test/unit/symbolIndex.test.ts` → 19 passed（新增 10 例：大小写敏感/字典序/空结果/limit/removeFile 失效/行注释/多行连续/块注释/无注释→undefined/kind 正确）；`node --expose-gc test/bench/run.mjs` → `bench PASS`（冷索引/增量/RSS/F12 各项无回退）

## 2026-10-28 09:11 · 任务完成：T-022 completion 核心：能力声明与上下文判定
- 任务: T-022 completion 核心：能力声明（`completionProvider` + triggerCharacters）与上下文判定（成员 / include 字符串 / 标识符 / 空结果面）
- 结果: 新建 `server/src/completion.ts`：`detectCompletionSite` 按光标前一 token 判四类站点（`.`/`.` 后部分名 → 成员；`preproc_include` 字符串内 → 路径；HLSL 侧标识符 → 宏/函数；注释、字面量、非 include 字符串、ShaderLab 外壳 → 空）；树选择与 F12 共用 `definition.ts` 的 `docTrees` 缓存（ShaderLab 外壳树 vs 虚拟 HLSL 树按 program body 偏移切换），无第二套解析。`server.ts` 声明 `completionProvider`（triggerCharacters `[".","\"","/","\\"]`、`resolveProvider:false`）并接 `onCompletion`（生成文件抑制、异常兜底空列表）
- 验证证据: `test/unit/completion.test.ts` T-022 组 5 例绿（含真实 stdio 握手断言 `initialize.capabilities.completionProvider.triggerCharacters == [".","\"","/","\\"]`——能力声明按 M2 先例走 stdio 而非 vscode-test）；`npx vitest run` 全量 154 passed

## 2026-10-28 09:11 · 任务完成：T-023 struct 成员补全
- 任务: T-023 struct 成员补全（复用 `scopeResolver` 单层浅推断，不写第二套）
- 结果: `symbolIndex.ts` 新增 `structFields` 视图（`indexFile` 按 `loc.owner` 维护、`removeFile` 按 `structOwners` 清理）与 `fieldsOfStruct()`；`completion.ts` 成员候选复用 `definition.ts` 导出的 `declaredTypeOf`（局部→全局浅推断）+ `rankOf`；链式 `g.uv.`（base 非 identifier）与未知变量 → 空列表
- 验证证据: completion.test.ts T-023 组 6 例绿（`i.` 全字段 kind=Field、前缀 `i.u` 只剩 uv、跨文件 `s.al`→inc.hlsl 的 alpha、链式/未知变量负例、字段与内置函数 `mul` 同名不吞候选）；全量 vitest 154 passed

## 2026-10-28 09:11 · 任务完成：T-024 `#include` 路径补全
- 任务: T-024 `#include` 路径补全（复用 `includeResolver` 四类 + 包内 ShaderLibrary 枚举）
- 结果: `includeCandidates` 按四类规则枚举（同目录 → rank0；`Assets/**`、嵌入 `Packages/**` → rank2；PackageCache `com.unity.render-pipelines.*` 的 `ShaderLibrary/**` 以 `Packages/<pkg>/ShaderLibrary/…` 形式 → rank3；CGIncludes 裸名 → rank4），目录枚举按 mtime 缓存（`clearCompletionCache` 可清）；候选以 `textEdit` 替换整段字符串内容；前缀正斜杠归一 + 大小写不敏感过滤
- 验证证据: completion.test.ts T-024 组 5 例绿（内置裸名/同目录/Assets 前缀/PackageCache 回退/textEdit range 覆盖内容段）；集成「include 路径补全」✓（fixture PackageCache 下命中 `Packages/com.unity.render-pipelines.core/ShaderLibrary/SpaceTransforms.hlsl`）

## 2026-10-28 09:11 · 任务完成：T-025 Unity/URP API 与用户宏候选 + 文档兜底链
- 任务: T-025 Unity/URP API 与用户宏候选 + 文档兜底链（源码注释 → macroTable → 空）
- 结果: `identifierCandidates` = 用户宏（当前文件/闭包）+ Unity API（包内/内置的宏与函数），一般变量/struct 名/工程函数按规格排除；文档 = `SymbolInfo.doc`（T-021 邻近注释）→ `macroTable.macroDescription()`（新增 `MACRO_DESCRIPTIONS` 自写简述，含 `SAMPLE_TEXTURE2D` 等高频采样宏——真实源码处无注释）→ 空。修索引缺口：函数式宏是 `preproc_function_def` 节点，`extractHlsl` 此前只收 `preproc_def`，Unity 宏几乎全是函数式形态
- 验证证据: completion.test.ts T-025 组 6 例绿（TransformWorldToHClip 注释文档、SAMPLE_TEXTURE2D 注释文档、用户宏无注释→doc undefined、闭包宏 OrdInc rank1、TEXTURE2D→macroTable 兜底、范围外类别不出现）；集成「Unity 宏补全带文档」✓（文档=「对 2D 纹理按 UV 采样…」）；修 `preproc_function_def` 后全量 vitest 152→154 passed

## 2026-10-28 09:11 · 任务完成：T-026 服务端前缀过滤 / 五层排序 / 截断与 isIncomplete
- 任务: T-026 服务端前缀过滤 / 五层排序 / 截断与 `isIncomplete`
- 结果: 前缀过滤走 `queryByPrefix`（大小写敏感、二分）；候选以 `sortText = "rank|label"` 表达五层优先级（当前文件0→闭包1→工程2→包3→内置4；标识符候选实际只出现 0/1/3/4 层，工程层按范围规则不进候选）；>300 截断 → `isIncomplete:true` + 日志 `completion: truncated=<total> kept=300`；索引进行中照常返回并记日志
- 验证证据: completion.test.ts T-026 组 4 例绿（`SAM`/`sam` 大小写敏感、`Ord*` 排序 `[OrdCur,OrdInc,OrdPkg,OrdCg]`、351 候选→300 条 + `truncated=351`、索引进行中日志）；全量 vitest 154 passed

## 2026-10-28 09:33 · 任务完成：T-027 补全集成与性能基准
- 任务: T-027 补全集成与性能基准
- 结果: 新增 `test/src/suite/completion.test.js` 7 例并注册进 suite/index.js；`__indexStats` 增 `indexing` 标志供集成等待首轮扫描完成；集成 fixture（runTest.js）扩为合成 PackageCache（core@14.0.12 ShaderLibrary 两文件）+ `.vscode/settings.json` 指 `unityShader.unityEditorPath` 到本机 Editor（CGIncludes 可用，degraded=no）；bench 增「补全（中位数/p95）」采样（成员+标识符混合、内存文档）与「补全后索引规模变化」项。实测事实：**VS Code 内置 word-based 补全会混进 `executeCompletionItemProvider` 结果且也带 sortText**，集成断言按我们的 sortText 形态 `^\d\|` 过滤「我们的候选」
- 验证证据: `npm run test:vscode`（filter=T-027）→ 7/7 ✓；全量集成 → 19/19 ✓（definition/extension 无回归）；`node --expose-gc test/bench/run.mjs` → 补全中位数 1.88ms、p95 2.8ms（预算 150ms）、补全后索引变化 0、`bench PASS`；vitest 154 passed

## 2026-10-28 09:45 · 任务完成：T-028 索引 occurrence 收集扩展
- 任务: T-028 索引 occurrence 收集扩展：逻辑符号合并视图 + 按需重解析枚举同名 token（复用 `parser.ts`）
- 结果: 新建 `server/src/occurrences.ts`——`collectOccurrences(name)` 遍历已索引文件名 → 廉价文本 `includes` 预筛 → 命中文件走 `docTrees`（与 F12/补全同一棵树与缓存，无第二套解析）枚举名字叶子 token（`identifier`/`type_identifier`/`field_identifier`/ShaderLab `word`）；`decl` 标志与索引 location 对齐；注释/字符串/语义天然不是名字 token 故不计数；`samplerOccurrences` 按 Unity 约定 `sampler_<名>`（前导下划线不重复：`_MainTex`→`sampler_MainTex`）；读不到/解析不了记日志 `occurrences: <名> unresolved=N`
- 验证证据: `test/unit/occurrences.test.ts` 10 例绿（Properties word + HLSL 一次收齐、宏参数位 `TEXTURE2D(_MainTex)`、decl 三处对齐、注释两处不计数、大小写敏感、sampler 关联两处、新文件入索引即覆盖、打开文档编辑即时反映、unresolved=1 日志、无命中 scanned=0）；`npx vitest run` 全量 164 passed

## 2026-10-28 09:52 · 任务完成：T-029 references 核心
- 任务: T-029 references 核心：`referencesProvider`、`includeDeclaration`、优先级排序与 200 截断
- 结果: 新建 `server/src/references.ts`——`resolveSymbolAt`（与 F12 共用 `nodeAtCursor` + 索引 + 浅推断，token→逻辑符号一条路径）分 global/member/local 三类；全局走 T-028 `collectOccurrences`，成员走 owner 过滤声明 + 左侧浅推断可解析使用处（不可解析记 `unresolved=N`），局部限当前函数体；`includeDeclaration` 过滤声明；五层 `rankOf` 排序；200 截断 + 日志 `truncated=<总数>`；Temp/生成文件过滤。`definition.ts` 导出 `NAME_TYPES`/`LITERAL_TYPES`/`nodeAtCursor` 供复用；server 声明 `referencesProvider` 并接 `onReferences`
- 验证证据: `test/unit/references.test.ts` 8 例绿（`_MainTex` 收齐 Properties 声明/HLSL 声明/宏参数使用/跨文件/包内且注释不计数、`includeDeclaration:false` 只留使用处、当前文件→工程→包内排序、251 处→200 条 + `truncated=251`、Temp 误入索引仍被过滤、成员引用 v2f.uv 三处且 appdata.uv 不混入 + `unresolved=1`、空结果面、stdio 握手 `referencesProvider:true` 与 `renameProvider.prepareProvider:true`）；`npx vitest run` 全量 182 passed

## 2026-10-28 09:52 · 任务完成：T-030 rename 核心
- 任务: T-030 rename 核心：`prepareRename`/`rename`、新名校验、WorkspaceEdit 组装、内置/包内拒绝、存在性校验
- 结果: 新建 `server/src/rename.ts`——`prepareRename` 返回名字 token Range + 占位符，内置/包内声明返回 `ResponseError(「内置/包内符号不可改名」)`，空结果面返回 null；`rename` 新名校验（`[A-Za-z_][A-Za-z0-9_]*`、HLSL 关键字/内置类型冲突、同作用域占用）违反即错误无 edit；WorkspaceEdit 每处只替换名字 token Range；包内/内置文件 edit 一律不生成；存在性校验（缺失跳过记日志，声明文件缺失→错误）；`#if` 各分支不求值全改；局部符号限函数体。server 声明 `renameProvider:{prepareProvider:true}` 并接两处理器
- 验证证据: `test/unit/rename.test.ts` T-030 组 8 例绿（跨文件 a.hlsl/b.shader/c.hlsl 五处 edit 逐 Range、作用域 `i.uv`→只改 v2f.uv 声明+使用且 appdata.uv/unknownVar.uv 零改动 + `unresolved=1`、`#if` 两分支四处全改、新名 `1abc`/`float`/空串/占用名四例拒绝、pkg 声明 prepareRename 错误含「不可改名」且 rename 同样拒绝、使用处文件删除后 unresolved 记日志且不在 edit、注释/状态命令 null、Temp null）；全量 vitest 182 passed

## 2026-10-28 09:52 · 任务完成：T-032 零误改回归语料（roadmap M3 核心）
- 任务: T-032 零误改回归语料（roadmap M3 核心验收）
- 结果: `test/unit/rename.test.ts` 新增语料 fixture `corpus.shader`：①`#include "uv"` 字符串 ②注释里的 `i.uv` ③未激活 `#if` 分支里另一符号（局部变量 `uv`）的声明与使用 ④`appdata` 与 `v2f` 同名字段——对 `i.uv`（v2f 字段）rename → 仅 `v2f.uv` 声明（5:48）与可解析的 `i.uv`（16:17）被改，其余六处逐 Range 断言不在 edit 集
- 验证证据: rename.test.ts T-032 组绿（`m.get('corpus.shader:5:48')==='texUV'`、`m.get('corpus.shader:16:17')==='texUV'`，`4:12`/`6:26`/`11:9`/`13:10`/`14:18`/`17:17` 六处 `m.has(...)===false`）；全量 vitest 182 passed

## 2026-10-28 10:22 · 任务完成：T-031 Properties / `sampler_` 联动改名 + 材质/场景资产失效提示
- 任务: T-031 Properties / `sampler_` 联动改名 + 材质/场景资产失效提示
- 结果: `rename.ts` property 分支联动 `samplerOccurrences(<旧名>)` → `sampler_<新名>`（Unity 约定名；自定义采样器名不联动），并发 Info 提示（文本含「材质（.mat）」「场景（.unity）」失效迁移指引）；server 接 `notifyInfo → connection.window.showInformationMessage`。资产提示断言走协议级拦截：LSP 请求方法名是 `window/showMessageRequest`、`MessageType` 1=Error/2=Warning/3=Info；测试侧替换 vscode API 不可行（`window.showInformationMessage` 为只读 getter，且 v9 LanguageClient 无 `setupConnection`）
- 验证证据: `rename.test.ts` T-031 两组绿（vitest：5 处 edit=Properties/TEXTURE2D/SAMPLE 参数/两处 `sampler_BaseMap`，其他属性零改动；真实 stdio：`window/showMessageRequest` type=3 且含「材质」「场景」）；集成用例「T-031：Properties 联动改名（vscode-test 一例）」绿（`vscode.executeDocumentRenameProvider` 5 处 edit）；全量 vitest 183 passed

## 2026-10-28 10:22 · 任务完成：T-033 rename / references 集成用例 + bench
- 任务: T-033 rename / references 集成用例 + bench（references P95 < 500ms、rename ≤50 处 < 1s）
- 结果: 新集成模块 `test/src/suite/rename.test.js` 4 例（Properties 联动 vscode-test、编辑后新使用处 rename 立即覆盖、`.hlsl` 第二语言 id references 2 处 + rename 2 处、Temp/compiled-* references 空 + rename 拒绝）；命令名按本机 VS Code 构建实测为 `vscode.executeDocumentRenameProvider`（该构建无 `executePrepareRenameProvider`/`executeRenameProvider`，拒绝时命令抛错）。bench 新增第 5 节：references（真实工程 `_MainTex` 143 处、200 截断）与 rename（真实工程属性 `_FogColor` 3 处，≤50 处预算口径）
- 验证证据: 集成 23/23 绿（含新 4 例）；`node --expose-gc test/bench/run.mjs` → references 中位数 57.7ms / p95 58.6ms（冷首查 111.3ms，limit 500）、rename 3 处 3 edits（limit 1000）、`bench PASS`

## 2026-10-28 10:26 · 迭代收口：sprint-03（M3）完成
- 任务: sprint-03 迭代收口（T-021～T-033 全部完成后）
- 结果: roadmap M3 →（done）四条阶段标准勾选并附任务/日志出处；sprint-03 frontmatter → done；backlog 的 M3 条目全部移除（待办清空，M4 起须先立规格）；status.md 重写（31 项完成、四条命令基线）；根 README 状态行更新；清理真实工程 `D:/Work/Unity/ShaderStudy/Assets` 的诊断残留（`comp2/comp3/comp5.shader` 及 `.meta`）
- 验证证据: `npm run build` 无错误；`npx vitest run` 183 passed（16 文件）；`npm run test:vscode` 23/23；`node --expose-gc test/bench/run.mjs` → `bench PASS`

## 2026-10-28 11:30 · 重要变更：ADR 0007 fork tree-sitter-hlsl + 手动测试三缺陷修复
- 任务: 手动测试缺陷修复（图1 `i.` 补全混入文档单词；图2/3 F12 找不到 `UnityObjectToWorldNormal`/`appdata_base`）
- 结果: ① 诊断：`UnityCG.cginc` 被 tree-sitter-hlsl@0.2.0 解析成整文件级联 ERROR——struct 体内裸宏成员（`UNITY_VERTEX_INPUT_INSTANCE_ID`）使收尾 `};` 变 ERROR 并吞掉整个 `#ifndef` 块，声明从索引消失；审计全 HLSL 语料（205 文件）确认第二根因：跨行宏 `\` 续行体内 `/* */` 块注释截断 `preproc_arg`（UnityPBSLighting/UnityLegacyTextureStack）。② 按 ADR 0007 把上游 fork 为 workspace 包 `hlsl/`（同名 `tree-sitter-hlsl`@0.2.1，npm workspaces 解析），grammar.js 补丁：`_field_declaration_list_item` 挂 `macro_member`（含 conflicts 与 `prec.dynamic(-1)`）+ `preproc_arg` 允许块注释；`tree-sitter generate` + `node-gyp rebuild`（ABI 14）；根脚本 `hlsl:generate/compile/test`。③ 图1 修复：client `contributes.configurationDefaults` 对 `unityshader`/`hlsl` 关闭 `editor.wordBasedSuggestions`（内置单词补全混入成员列表；我们的候选本就来自符号索引）。④ 回归：`hlsl/test/corpus/unity-macros.txt` 2 例；hlsl.test.ts +4 解析用例 +1 索引用例（宏名不混入 struct 字段）；definitionRealProject.test.ts 新增 ②b 工程 `appdata_base`→UnityCG.cginc、②c cginc 内 `UnityObjectToWorldNormal` 同文件跳；completion.test.js 新增 wordBasedSuggestions=off 断言。⑤ 已知限制登记 ADR 0007 后果段并入 backlog T-034：`#if` 块内外不平衡括号（AutoLight.cginc 等）、顶层带 primitive 参数裸宏调用、模板 `$` 占位符、ffx 宏 typedef
- 验证证据: `node test/bench/diag13.mjs` 修复前后对照（UnityCG.cginc ERROR 1→0，`appdata_base`/`UnityObjectToWorldNormal` 进索引）；`npm run build` 无错误；`npx vitest run` 190 passed（16 文件）；`npm run test:vscode` 全绿（含新 word-based 断言 filter 单跑 ✓）；`npm run bench` → 冷索引 1225ms、F12 p95 5.71ms、补全 p95 1.59ms、references p95 59.9ms、rename 17.29ms、RSS 218MB → `bench PASS`；`npm run hlsl:test` 语料 2/2 ✓

## 2026-10-28 11:55 · 重要变更：feature-completion 规格修订（标识符候选扩展 + 成员可见性分层）
- 任务: 手动测试缺陷修复第二轮（图1 同名 struct 字段互相污染：`i.` 混入工程内其他文件 v2f 的 color/grabPos/uv 等；图2 自己声明的 `_MainTexture` 不进补全候选）
- 结果: ① 诊断：成员候选取 `fieldsOfStruct(name)` 是**全工程同名 struct 字段的并集**（ShaderStudy 里 51 个文件各定义各的 `v2f`），标识符候选只放行 macro/function（变量与 Properties 被过滤，原 M3 范围）。② 规格修订（feature-completion 2026-10-28 修订段）：成员候选按可见性分层——当前文件+闭包(≤1)有定义就只用该层，否则包/内置(≥3)，再否则工程(2) 兜底；标识符候选扩展用户全局变量（Variable）、当前文件 Properties 属性（Property）、用户函数（当前文件+闭包）、内置/包内全局变量（`_Time` 类，rank 3/4）；可见性口径统一为「工程内非闭包文件(2) 不可见」（局部变量/参数/关键字仍不做）。③ 实现：`completion.ts` `memberCandidates` 分层过滤 + `identifierCandidates` kind 放行与 rank 规则。④ 回归：completion.test.ts 新增 5 例（同名 v2f 分层、当前文件变量、闭包变量、内置/包内变量、Properties）+ 负例改口径；集成 completion.test.js 新增 1 例（comp6.shader：`_Main`→`_MainTexture`、`i.` 只给 pos/normal 且不含 comp.shader 的 uv 与 comp6_other 的 grabPos/color）
- 验证证据: `npx vitest run` 195 passed（16 文件，completion 34 例）；`npm run test:vscode` 全绿（25 例，含新集成用例）；`npm run bench` → 补全中位数 1.35ms/p95 1.69ms（预算 150ms）、`bench PASS`

## 2026-10-28 12:45 · 任务完成：T-035 悬停 v1 + T-036 冒号后语义补全（含索引 init_declarator 修复）
- 任务: 用户手动测试报告「`SV_Target` 等语义无法查找到」。语义是编译器保留字、无任何源码声明，F12 天然无定义 → 经询问用户确认做「悬停文档 + 冒号后补全」成对形态。新规格 [specs/feature-hover.md](../specs/feature-hover.md)（符号悬停=声明行代码块+邻近注释/macroTable 文档；语义悬停=自写 `semanticTable`，未知语义给通用说明）；feature-completion 二次修订（`:` 后语义候选，前缀大小写不敏感）
- 结果: ① `server/src/semanticTable.ts`（新，自写 ~48 词条：SV_* 系统值 + POSITION/NORMAL/TEXCOORDn 等约定语义，查名大小写不敏感）；② `server/src/hover.ts`（新，复用 definition 的 nodeAtCursor/rankOf/closureOrder；struct 字段 `bitfield_clause` 与函数返回值 `semantics` 两处语义节点识别）；③ `completion.ts` 语义上下文与候选（kind=Keyword，rank 0）；④ `server.ts` 声明 `hoverProvider` + `onHover`；⑤ 顺带修复索引缺陷：`float4 q = expr;` 的**初始化表达式使用标识符**曾被 `declaredNames` 收为 variable 声明（污染 F12/补全/hover），`init_declarator` 只收 `=` 左侧声明名
- 验证证据: `npx vitest run` 213 passed（17 文件：hover.test.ts 14 例、completion 语义 4 例）；`npm run test:vscode` 全绿（26 例，含「悬停与语义补全」集成用例：SV_Target/SV_POSITION 语义悬停、变量声明行悬停、未声明空结果、`uv : ` 与 `pos : SV_` 补全带文档）；`npm run bench` → 悬停中位数 0.02ms/p95 0.43ms（预算 150ms）、`bench PASS`。T-035/T-036 已从 backlog 移除

## 2026-10-28 13:05 · 重要变更：ADR 0008 死分支灰化——关键字取 Unity Editor.log，呈现走 LSP 扩展通知 + 客户端装饰
- 结果: 落 ADR 0008（M4 第三条验收的前置选型）。① 关键字源三选一确认取 **Unity 全局 `Editor.log` 的 `Disabled keywords:`**（M4 不依赖 M6 桥）；被否：等 M6 工程元数据桥（灰化被阻塞、roadmap 验收挪期）、对标产品的 `//! KEY:VALUE` 行内注释覆盖语法（要新定义注释语法与优先级，且不解决默认关键字集）、自研预处理器求值/试编译。② 呈现机制确认取 **server 侧基于唯一 CST 的 `preproc_if`/`preproc_elif`/`preproc_else` 求值 + LSP 扩展通知 `$/unityShader/inactiveRegions` + 客户端 `setDecorations`**；被否：`publishDiagnostics` + `DiagnosticTag.Unnecessary`（灰化进 Problems 面板、污染 ADR 0004 与 roadmap 的零误报口径）、semantic tokens（全链路成本最高、与自带 grammar 高亮职责重叠）。③ 界定与 ADR 0002 的张力：**不取代 0002**，「不造私有协议」＝不脱离 LSP 通道与生命周期，`$/…` 属 LSP 允许的扩展；将来若需 LSP 之外的传输须另立 ADR。④ 登记负面与未决：Editor.log 全局非 per-project、可能陈旧、多实例、workspace 外（`didChangeWatchedFiles` 覆盖不到 → 轮询或客户端传入，仍不起独立 watcher 进程）、三平台路径与 `Editor-prev.log` 轮转；**M6 桥是否取代 Editor.log 作权威关键字源**登记为未决项，不预写取代关系。⑤ 落地边界：灰化本体须先 `/project-spec` 立 `feature-dead-branch-dimming`，再 `/project-plan` 拆任务
- 验证证据: `docs/decisions/0008-dead-branch-dimming-editor-log.md` 落盘（frontmatter `adr: 0008`/`date`/`title`，背景含 D1–D4 与 P1–P3 备选、决策一句话、后果含正负与未决项）；`docs/README.md` ADR 清单与 `docs/decisions/README.md` 已登记；三个选型经 ask_user 逐项由用户确认（均选 Editor.log 为主 / LSP 扩展通知 / 三层组合）；旧 ADR 0001–0007 文件未改动

## 2026-10-28 13:05 · 重要变更：ADR 0009 语法诊断误报控制——grammar 继续修 + ERROR 模式豁免表 + 语料零误报门槛测试
- 结果: 落 ADR 0009（M4 前两条验收的前置选型；诊断来源已由 ADR 0004 结清，本 ADR 只补「误报怎么控」）。① 事实核对：现有地基只有计数没有按模式判定 —— `countErrorNodes()`（`server/src/parser.ts:118-125`）、`FileIndex.errorCount`（`server/src/symbolIndex.ts:55`）；core 规格仅承诺「错误节点计数暴露给 M4」「解析失败结构化记录供 M4 消费」。② 推论：直接把每个 `ERROR`/`MISSING` 转 Diagnostic 必然在官方语料误报（ADR 0007 三类不可修模式落在 AutoLight.cginc / UnityStandardCore.cginc / ShaderGraph 模板 / ffx 上）→ roadmap「零误报否则不默认开启」永远达不到。③ 三层组合确认：grammar 继续修可修模式（T-034）+ **按 ERROR 模式（node kind + 上下文特征）的豁免表**（仓库内一等公民、数据表 + 解析测试钉住、命中即不产诊断）+ 官方语料离线扫描脚本给出逐模式计数作零误报门槛；被否：只靠 grammar 修（长期默认关闭）、文件/路径级白名单（门槛被掏空）、仅手动触发。④ 接受的代价：豁免表是与 grammar 补丁耦合的第二份知识（每条须带命中计数断言与「不修+理由」）、粒度启发式且默认方向为**宁可漏报不可误报**、门槛测试依赖本机 Unity/PackageCache 需固定快照或经 `unityShader.unityEditorPath` 定位、**T-034 成为语法诊断的前置而非并行项**（排期交 /project-plan）。⑤ 不取代 0001/0004/0007；落地边界：须先 `/project-spec` 立 `feature-syntax-diagnostics`（含 ERROR→Diagnostic 映射/severity/debounce/配置项/只读与生成文件是否产诊断/零误报测法，以及「include 未找到」是否属 M4 —— core 规格已按 M4 消费预留但 roadmap 未列）
- 验证证据: `docs/decisions/0009-syntax-diagnostics-error-exemption.md` 落盘（背景含 E1–E4 备选与代码事实引用、决策一句话、后果含正负与落地边界）；`docs/README.md` ADR 清单与 `docs/decisions/README.md` 已登记；误报控制策略经 ask_user 由用户确认；`docs/decisions/README.md` 顺带补登记此前缺失的 0007 行；旧 ADR 0001–0007 文件未改动

## 2026-10-28 13:20 · 重要变更：规格 feature-syntax-diagnostics 落盘（M4 语法诊断）
- 结果: 新规格 [specs/feature-syntax-diagnostics.md](../specs/feature-syntax-diagnostics.md) 落盘，六段齐备。① 四个范围点经 ask_user 逐项确认：**「include 未找到」纳入本规格 severity=Warning**（core 规格 §5 已按「M4 消费」预留，Range 落在 `#include` 路径字符串上）；**四类文件 `.shader/.hlsl/.hlslinc/.cginc` 都产语法诊断**；**编辑中间态走防抖默认 800 ms 可配**（对标 900 ms）；**零误报门槛达标→默认开、未达标→默认关 + 提供手动开启**。② 落地 ADR 0009 三层控制：`ERROR`/`MISSING` → Error（文案自写、形态对齐 `MISSING ;`/`syntax error - <节点>`）、**只报最外层 ERROR**（级联不刷屏，日志 `nested=`）、`errorExemption.ts` 豁免表（键=node kind+父节点+token 模式，带 `reason` 与命中计数，对应 ADR 0007 三类不可修模式与 ShaderGraph `$` 占位符）。③ **roadmap M4「零误报」验收的测法定死**：`test/corpus/diagnosticsGate.mjs` + `npm run gate:diagnostics`，经 `BENCH_PROJECT`/`BENCH_EDITOR` 定位三源语料，断言语法诊断总数=0 并打印逐模式聚合表，语料缺失时 SKIP 而非 PASS；与 T-034 审计脚本共用口径。④ 新增四个扁平配置项 `unityShader.syntaxDiagnostics`/`includeDiagnostics`/`diagnosticsDebounceMs`/`maxDiagnosticsPerFile`（默认值随门槛）。⑤ 关键边界：**降级态不产 include 未找到诊断**（内置/包内路径不可用必然刷屏）、语法诊断不依赖工程发现照常产、`Temp/compiled-*` 不产、单文件默认 200 条截断
- 验证证据: 文件存在且含 范围/不在范围/约束/异常与边界（13 行场景表）/验收标准（15 条逐条标注 vitest·vscode-test·脚本·bench）/对应模块 六段；`docs/README.md` 规格清单与 `docs/specs/README.md` 已登记（后者顺带补登记此前缺失的 `feature-hover.md` 行）；四个范围点经 ask_user 由用户确认；引用事实核对 `server/src/parser.ts:118-125`、`server/src/includeResolver.ts:15-23`（`IncludeResult`/`IncludeFailureReason`）、`server/src/symbolIndex.ts:55`

## 2026-10-28 13:20 · 重要变更：规格 feature-dead-branch-dimming 落盘（M4 死分支灰化）
- 结果: 新规格 [specs/feature-dead-branch-dimming.md](../specs/feature-dead-branch-dimming.md) 落盘，六段齐备，跨模块选型全部承接 ADR 0008。① 三个范围点经 ask_user 逐项确认：**刷新 = `didOpen` 读一次 + 定时轮询 mtime（默认 5000 ms，mtime 未变不重读不解析）**；**装饰只灰分支体，不含 `#if`/`#elif`/`#else`/`#endif` 条件行**；**提供 `unityshader.refreshShaderKeywords` 命令 + Output 健康行 `[keywords] source=… disabled=N age=… regions=M`**。② 求值口径：**三态（假/真/未知），只有确定为假才灰**；不在 Disabled 集合的标识符是**未知**而非「启用」；不引入 Unity 关键字默认值表（列入不在范围）；`#elif` 链前面任一分支未知 → 其后全不灰；嵌套外层假 → 只产外层 Range 不重叠。③ 契约：自定义通知 `unityshader/inactiveRegions`（沿用既有 `unityshader/indexProgress` 命名，`server/src/server.ts:187`），payload 带文档 `version`、客户端丢弃过期版本；客户端经 `capabilities.experimental` 声明支持，未声明则 server 不发。④ 日志侧：三平台路径、尾部窗口默认 512 KiB、读失败保留上次集合并记 `stale=true`、日志缺失 → `source=none` 不报错（roadmap M4 第三条降级口径）。⑤ 一致性声明：**只加装饰，不改 F12/补全/Rename 对死分支的处理**（沿用 rename §8「不求值、全分支都算」），并列入回归验收
- 验证证据: 文件存在且六段齐备（异常与边界 15 行场景表、验收标准 16 条逐条标注 vitest/vscode-test/bench）；`docs/README.md` 与 `docs/specs/README.md` 已登记；三个范围点经 ask_user 由用户确认；通知命名差异已登记在规格范围 §6（ADR 0008 决策段的 `$/unityShader/inactiveRegions` 为 LSP 私有前缀示例写法，实际名以规格为准，属实现细节故不改 ADR 文件）

## 2026-10-28 13:35 · 重要变更：更正 ADR 0007 关于「parser.c 随仓库提交」的表述（旧 ADR 本体不改写）
- 结果: 核对发现 ADR 0007 后果段写的「`parser.c`（约 20 MB）随仓库提交」与仓库实际相反：`.gitignore` 忽略 `grammar/src/parser.c` 与 `hlsl/src/parser.c`，`git ls-files` 确认两者均未被跟踪，`hlsl/README.md`「重新生成 / 编译」段早已写明「`src/parser.c` 是生成物（同 `grammar/`，不入库）」并给出 `npm run hlsl:generate` → `hlsl:compile` 的重建路径（全新克隆须先 `npm install --ignore-scripts`）。按规范 §3「旧 ADR 永不修改」，**不改写 0007 文件**，更正落在两处：① `docs/README.md` ADR 清单说明段加「更正（2026-10-28）」条目；② `docs/project.md` 技术栈「打包与分发」行补写生成物与 MSVC 中间产物不入库、由 generate/compile 重建
- 验证证据: `git ls-files grammar/src/parser.c hlsl/src/parser.c` 输出为空；磁盘上 `hlsl/src/parser.c` 20,049 KB、`grammar/src/parser.c` 339 KB 均存在但被忽略；`hlsl/README.md:20-26` 与 `.gitignore:6-7` 为事实来源；更正文本已落 `docs/README.md` ADR 清单段与 `docs/project.md` 技术栈行

## 2026-10-28 13:35 · 其他：仓库清理——MSVC 链接中间产物不再入库（8 个文件解除跟踪）
- 结果: 判定 `parser.obj`/`parser.lib`/`parser.exp`/`scanner.obj` **不重要**：无任何脚本或配置引用（全仓 grep 零命中），`hlsl/binding.gyp` 的 `sources` 只有 `bindings/node/binding.cc` + `src/parser.c` + `src/scanner.c`，运行时加载的是 `build/Release/*.node`（`build/` 已忽略）；且 `src/parser.c` 本身是生成物不入库 → 这些 `.obj` 在新克隆里既不可用也无法复现，属纯链接副产物。据此 `git rm --cached` 解除跟踪 8 个文件（`grammar/` 4 个来自初始提交、`hlsl/` 4 个随 M3 提交误入库，合计约 4.25 MB，其中 `hlsl/parser.obj` 4,147 KB），文件保留在工作区；`.gitignore` 新增 `*.obj`/`*.lib`/`*.exp`/`*.iobj`/`*.ipdb`。**历史里仍留有这些 blob**（已推送），若要清除需 `git filter-repo` 重写历史 + 强推，属仓库策略变更，未擅自执行
- 验证证据: `git rm --cached` 后 `git status --short` 显示 8 个 `D`（暂存删除）且 `Test-Path hlsl/parser.obj`/`grammar/parser.obj` 均为 True（工作区文件未删）；解除跟踪后 `npm test` → 213 passed / 17 文件、`npm run build` 无错误（运行时用的 `build/Release/*.node` 不受影响）

## 2026-10-28 13:35 · 其他：M4 拆项入 backlog（T-037～T-048）
- 结果: 按规范 §6 把两份已确认规格拆成 12 条功能任务：**语法诊断 T-037～T-042**（T-037 诊断核心与最外层抑制、T-038 ERROR 模式豁免表、T-039 include 未找到 Warning、T-040 防抖与发布管线 + 四配置项、T-041 语料零误报门槛脚本与默认值联动、T-042 集成用例 + bench）；**死分支灰化 T-043～T-048**（T-043 Editor.log 关键字源、T-044 三态求值、T-045 分支体 Range 组装、T-046 server 契约与 experimental 协商、T-047 client 装饰 + 命令 + 三配置项、T-048 集成 + 回归 + bench）。依据全部写 `spec:<规格名>`，涉及跨模块选型的加 `ADR:0008`/`ADR:0009`；验收逐条取自规格「验收标准」节的可测口径（含 `nested=`、`exempted=`、`truncated=250`、`source=none`、P95 < 150 ms 等断言）。**T-034 保留为 M4 前置**并写明依赖（T-037/T-038/T-041 共用其 ERROR 模式聚合口径）。backlog「尚未入 backlog」段移除 M4 两项（剩 M5 类型诊断与格式化、M6 Unity 包侧 + ADR 0005/0006 两项待决）。roadmap M4 节补「范围补充」并给零误报验收挂上测法 `npm run gate:diagnostics`
- 验证证据: 新 ID 连续 T-037～T-048，与历史最大号 T-036（log 12:45 完成事件）无重叠、无复用；12 条条目均含 `依据:` 与可验证 `验收:`；未新建/未改动 sprint 文件（**sprint-04 尚未开**，选入与否待指令）；`docs/plan/backlog.md` 与 `docs/plan/roadmap.md` 已落盘

## 2026-10-28 13:40 · 其他：开 sprint-04（M4 语法诊断与死分支灰化），status 与根 README 承接
- 结果: 新建 `docs/plan/sprint-04.md`（frontmatter `status: active`），四节齐备：① 迭代目标 = roadmap M4 全部三条阶段标准，并写明**顺序约束**（T-034 先行，语法诊断的豁免表与零误报门槛共用其 ERROR 模式聚合口径；灰化侧 T-043～T-048 不依赖 T-034 也不依赖 DXC，可并行先交付）；② 选入任务 ID = T-034 + T-037～T-048（13 项，与 backlog 待办完全一致，沿用「一个 sprint 对应一个里程碑」的既有做法）；③ 范围边界（本轮不做）：M5 类型诊断与 DXC 接入、格式化、M6 Unity 包侧与包桥、`//! KEY:VALUE` 注释语法与 Unity 关键字默认值表与变体切换、pull diagnostics 与 codeAction 与风格 lint、**改变 F12/补全/Rename 对死分支的处理**（只加装饰）、非 VSCode 客户端灰化、ADR 0006 第 2/3 层与 ADR 0005 发布流水线；④ 迭代验收条件含硬性项（`gate:diagnostics` 语料零误报且缺失记 SKIP、门槛 FAIL 时默认关闭可手动开、灰化 Range 不含条件行且嵌套不重叠、日志缺失 `source=none` 无报错）与回归不劣化要求。承接改动：roadmap M4 `planned` → **`active`**；`docs/README.md` 计划表加 sprint-04 行、sprint-03 改标已完成迭代；`docs/progress/status.md` 重写（进行中 = sprint-04，阻塞 = 无并注明门槛 FAIL 属 ADR 0009 口径而非阻塞，下一步仍 T-034）；根 `README.md` 当前状态行更新
- 验证证据: `docs/plan/sprint-04.md` 存在且只含目标/选入 ID/范围边界/验收条件四节（无任务详情与状态描述，符合规范 §4）；选入 13 个 ID 与 `docs/plan/backlog.md` 待办逐一对应；`status.md` 26 行 ≤ 40 行上限（规范 §10）；roadmap M4 节状态已置 active 且未塞入具体任务（规范 §3）

## 2026-10-28 14:33 · 功能：语法诊断半边完成（T-034、T-037～T-042），语料零误报门槛 PASS
- 任务: T-034、T-037、T-038、T-039、T-040、T-041、T-042
- 结果: ① **T-034**：fork 文法补 `macro_statement`（带 `expression` 实参）与 `macro_bare`（字面白名单 `UNITY_BRANCH`/`UNITY_FLATTEN`/`FLATTEN`/`allow_uav_condition`/`CBUFFER_END`），挂进 `_non_case_statement` 与 `_top_level_item`，`prec.dynamic(-1)` 只在原路径失败时生效；顺带修掉潜伏 bug——`countErrorNodes` 用 `node.type === 'MISSING'` 判定，而 MISSING 节点的 `type` 是**缺失的 token 名**（`;`/`}`/`#endif`/`::`）且 `isMissing === true`，导致 219 处 `MISSING:;` 从未被计入健康度。审计脚本固化为 `test/corpus/errorAudit.mjs`（`npm run audit:errors`，逐文件 ERROR 率 + 叶子 ERROR 模式签名）。语料含 ERROR 文件占比 32/166 → **21/166**，工程侧 52 文件 **0 ERROR**；`MISSING:;` 219 → 89，模式数 51 → 43。ADR 0007 ③ 的 ShaderGraph `$` 占位符**本机语料无样本**，故不建豁免行（空转规则会被门槛断言拒绝）——这是「不修+理由」记录而非豁免条目。② **T-037/T-038**：`server/src/diagnostics.ts`（只报最外层、`MISSING <token>` 与 `syntax error - <首个子节点>` 文案、MISSING 零宽 Range、去重、按位置排序、超上限截断记 `truncated=`）+ `server/src/errorExemption.ts`（9 条豁免，每条带 `reason` 含「不修」理由与命中计数，`match()` 计数 / `matches()` 不计数两套口径）。③ **T-039**：include 未找到 → Warning，Range 覆盖 `system_lib_string`/`string_literal`；环境降级时不产并记 `degraded=skip-include-diag`。④ **T-040**：`didOpen`/`didSave`/`didChangeWatchedFiles` 即时发布、`didChange` 防抖（默认 800 ms，0 = 即时）、`didClose` 与删除清空、开关关闭即清空旧诊断、`Temp/compiled-*` 不产诊断；新增四配置项 `unityShader.syntaxDiagnostics`/`includeDiagnostics`/`diagnosticsDebounceMs`/`maxDiagnosticsPerFile`，并给 client 补 `synchronize.configurationSection = 'unityShader'`（否则 `change.settings` 为空对象，开关改了不生效）。⑤ **T-041**：`test/corpus/diagnosticsGate.mjs`（`npm run gate:diagnostics`）对 166 文件三源语料断言语法诊断总数 = 0、逐规则命中必须 > 0、语料缺失记 SKIP(exit 0)、并断言 `client/package.json` 的 `configurationDefaults` 与门槛结果联动。门槛 PASS → `configurationDefaults` 置 `unityShader.syntaxDiagnostics: true`。⑥ **T-042**：`test/src/suite/diagnostics.test.js` 7 例（.shader/.hlsl 两类 + include Warning + `Temp/compiled-*` 零诊断 + 防抖只发 1 次 + `debounceMs=0` 即时 + 关开关清空）；发布次数用 server 在 `unityshader/__indexStats` 自报的 `diagnosticsPublished` 计数断言（LanguageClient 不公开诊断事件）。bench 加「语法诊断（2001 行）」两项
- 验证证据: `npm run gate:diagnostics` → **gate PASS：语法诊断总数 = 0 / include Warning = 0**（166 文件 / 937 ms），9 条豁免命中 19/13/17/3/2/9/80/7/1 全部 > 0，`configurationDefaults unityShader.syntaxDiagnostics: declared=true expected=true`；`npm test` → **248 passed / 19 文件**（新增 `diagnostics.test.ts` 15 例、`errorExemption.test.ts` 12 例、`parser.test.ts` T-034 3 例）；`npm run hlsl:test` → 5/5；`npm run test:vscode` 全量 → 34 例中语法诊断 7 例全 ✓（含防抖 delta=1、debounce=0 delta≥3）；`npm run bench` → **bench PASS**，语法诊断 2001 行 median 82.25 ms / p95 **102.25 ms** < 150 ms；`npm run build` 无 TS 错误

## 2026-10-28 15:12 · 功能：死分支灰化完成（T-043～T-048），sprint-04 收官
- 任务: T-043、T-044、T-045、T-046、T-047、T-048
- 结果: ① **T-043** `server/src/unityKeywordSource.ts`：三平台日志路径（win `%LOCALAPPDATA%\Unity\Editor`、mac `~/Library/Logs/Unity`、linux `~/.config/unity3d`）、尾部窗口（默认 512 KiB，窗口起点落在行中时丢掉残缺行 = 「命中行在窗口外」口径并记 `scanned=`）、只认**最后一条** `Disabled keywords:` 行且大小写敏感、mtime+size+窗口做缓存键（未变则不读盘不解析，`readCount`/`parseCount` 可断言）、读失败保留上次集合并记 `stale=true`、`keywordHealthLine()` 出 `[keywords] source=… disabled=… age=… regions=…`。② **T-044** `preprocessorEval.ts`：三态求值（假/真/未知），输入只有 Disabled 集合与**当前文件**的 `#define`/`#undef`（`#undef` 在文法里是 `preproc_call` 而非专用节点）；**`&&`/`||` 采用严格未知传播、不做短路吸收**——规格异常表明确「仅一侧可判定 → 整体未知」，短路会把 `false && UNKNOWN` 判成假并灰化，属规格禁止的方向。③ **T-045** `inactiveRegions.ts`：只读唯一 CST；实测两处文法事实钉进代码注释——`#ifdef` 与 `#ifndef` **共用 `preproc_ifdef` 节点**（分支种类必须看指令 token 文本），`preproc_elif` 是**右嵌套**链（`#endif` 只挂最外层块）。`#else` 体只在「前面某支确定为真」时才灰（规格异常表 `#ifndef` 反之那一行），前面全假时它是激活分支不灰；`#elif` 在链被真/未知终止后一律不灰不求值（范围 4）。Range 只覆盖分支体，嵌套外层假 → 只产外层。④ **T-046** server：`capabilities.experimental['unityshader/inactiveRegions']` 协商（未声明 → 静默不发）、700 ms 独立防抖、`unityshader/inactiveRegions` 通知（`{uri,version,regions:[{start,end,condition}]}`）、内部命令 `unityshader/refreshKeywords`、mtime 轮询定时器（`keywordPollMs`，0 = 关）。测试注入点两处并写明理由：环境变量 `UNITYSHADER_KEYWORD_LOG` 与命令可选参数 `{logPath}`——规格要求「Editor.log 用自包含 fixture」「fixture 指向不存在的日志路径」，而公开设置面只有三项不含路径，故不进 `contributes`。⑤ **T-047** client：装饰 `color: ThemeColor('disabledForeground')` + `opacity: '0.45'` 同时给（两者是独立渲染属性，主题没那个色时 opacity 兜底，不硬编码色值）；活动编辑器切换时清空、`didClose` 清理、`version` 不匹配的推送丢弃；命令 `unityshader.refreshShaderKeywords` + 三配置项。**踩坑记录**：v9 `ClientOptions` 无 `capabilities` 字段、`Middleware` 也没有 `initialize` 钩子（`initialize` 直连 connection 不过中间件），先前写的 `middleware.initialize` 是空转且 esbuild 不做类型检查所以没报错；改为覆盖实例方法 `computeClientCapabilities()`，代码里写明属 v9 实现细节、升级要复查，且集成用例「灰化协商」会第一时间发现失效。⑥ **T-048**：`test/src/suite/deadBranch.test.js` 7 例（协商 / 装饰落地且 Range 不含条件行 / 未知宏不灰 / 切换编辑器清空 / 命令健康行 / 日志缺失 `source=none` / 死分支内 F12 仍可用）+ `test/unit/deadBranchRegression.test.ts` 钉住「灰化只加装饰」：同一死分支语料上 occurrence、F12、Rename 三处行为不变，且死分支里的真实笔误仍产诊断。bench 加「死分支求值」与「关键字轮询空转」两项；**规格的「轮询空转 60 s 无可测 CPU 峰值」用等价口径实现**（200 次空转轮询的 CPU 时间 < 20 ms），60 s 墙钟在 CI 里不现实，已在此登记
- 验证证据: `npm test` → **301 passed / 23 文件**（新增 `unityKeywordSource.test.ts` 16、`preprocessorEval.test.ts` 18、`inactiveRegions.test.ts` 17、`deadBranchRegression.test.ts` 2）；`npm run test:vscode` 全量 → **40 例全 ✓**（灰化 7 例全绿，M1～M4 既有用例无回归）；`npm run bench` → **bench PASS**，死分支求值 2080 行 median 67.18 ms / p95 **71.43 ms** < 150 ms，关键字轮询空转 200 次 CPU **0 ms** < 20 ms；`npm run gate:diagnostics` 复跑仍 **PASS**（语法诊断总数 0、`configurationDefaults` 联动 true）；`npm run audit:errors` → 含 ERROR 文件 20/166（工程侧 52 文件 0.0%）；`npm run hlsl:test` → 5/5；`npm run build` 无 TS 错误

## 2026-10-28 15:28 · 其他：log 事件类型更正（14:33 与 15:12 两条应属「任务完成」）
- 结果: 规范 §7 的事件类型枚举只有 任务完成 / 任务取消 / 任务拆分 / 任务合并 / 重要变更 / 其他。本文件 14:33「功能：语法诊断半边完成（T-034、T-037～T-042）」与 15:12「功能：死分支灰化完成（T-043～T-048）」用了未列入枚举的「功能」，且 `- 任务:` 行只列 ID 未带任务名。按「只追加、不改写旧条目」在此登记更正：两条均按**任务完成**事件解读（14:33 = T-034 + T-037～T-042；15:12 = T-043～T-048），各自的验证证据已在条目内，无需重述。同时登记既有同类漂移：本文件另有 1 条历史条目用了未列入枚举的类型「迭代收口」（应归「其他」或「重要变更」），同样只登记不改写
- 验证证据: 追加前 `Get-Content docs/progress/log.md | Select-String '^## '` 的类型分布 = 任务完成 34 / 其他 19 / 重要变更 17 / 功能 2 / 迭代收口 1（共 73 条）；本条为第 74 条，追加后「其他」计数 +1；`docs/progress/status.md` 重写为四段（进度/进行中/阻塞/下一步）共 25 行 ≤ 40，「进行中」「阻塞」均为「无」，「下一步」不含任务详情；`docs/plan/backlog.md` 的 `- [ ]` 计数 = 0
