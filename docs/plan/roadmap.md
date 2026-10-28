---
status: active
updated: 2026-10-28
---
# 路线图

里程碑划分依据 [../分析/10-feature-feasibility.md](../分析/10-feature-feasibility.md) 的"价值/成本"排序，
范围来自 [../project.md](../project.md) 范围节。当前状态：M1～M5 已 done，M6 planned。

## M1 地基：工程骨架 + LSP 通道 + 解析层（done）

- 目标：把"能解析"这件事先做对，后续所有功能共用同一棵 CST。
- 范围补充：核心规格 [../specs/feature-language-server-core.md](../specs/feature-language-server-core.md) 的地基部分
  （文档同步、工程发现、include 解析、符号索引与性能基准）随 M1 一并实施（任务 T-009～T-013），
  其验收以规格为准，不另列入本节阶段标准。
- 验收标准：
  - [x] `npm run build` 产出 client 与 server 两个可加载产物；`npm test` 可运行
  - [x] VSCode 打开 `.shader` 后 LSP 握手成功，server 进程在窗口关闭后被回收、无残留
  - [x] 自写 `shaderlab` grammar 的 `tree-sitter test` 语料全绿，覆盖 `Shader`/`SubShader`/`Pass`/`Properties`/`Tags`/`HLSLPROGRAM…ENDHLSL`/`#include`/`CBUFFER_START`/`TEXTURE2D`
  - [x] 解析测试工程（`D:\Work\Unity\ShaderStudy\Assets`，50 个 shader）后，含 `ERROR` 节点的文件占比 < 2%

## M2 符号与索引：转到定义（done）

- 目标：F12 覆盖工程内、包内、引擎内置三类符号。
- 范围补充：功能规格 [../specs/feature-go-to-definition.md](../specs/feature-go-to-definition.md) 已确认，拆为 T-014～T-020 随 sprint-02 实施；
  细粒度验收以规格为准，本节只保留阶段级标准。
- 验收标准：
  - [x] 从 `_MainTex` 用法跳到 `Properties` 块声明（T-018：真实工程 stdio + vscode-test 各一例，log 00:35）
  - [x] 从 `TransformWorldToHClip` 跳到 `Library/PackageCache/com.unity.render-pipelines.core@*/ShaderLibrary/**` 内真实声明行（T-018，log 00:35）
  - [x] 从 `UnityObjectToClipPos` 跳到 `Editor/Data/CGIncludes/` 内真实声明行（实测 2022.3.62f3c1 声明在 `UnityShaderUtilities.cginc`，非 `UnityCG.cginc`；T-018，log 00:35）
  - [x] include 解析覆盖四类：相对路径、`Assets/…`、`Packages/…`、内置 `.cginc`（T-011，log 20:38：`includeResolver.test.ts` 10 例全绿）
  - [x] 冷启动索引（50 工程 shader + 80+ 包内 `.hlsl` + 56 内置 include）耗时 < 3 秒（T-013 实测 2002ms、经 LSP 全链路复测 1402ms，log 20:38 / 22:52；`npm run bench` 复测 1270ms）

## M3 补全与引用：语义补全 + Rename（done）

- 范围补充：功能规格 [../specs/feature-completion.md](../specs/feature-completion.md) 与 [../specs/feature-rename.md](../specs/feature-rename.md) 已确认（六个范围点经用户 2026-10-28 逐项确认），拆为 T-021～T-033；
  细粒度验收以规格为准，本节只保留阶段级标准。
- 验收标准：
  - [x] `i.` 在 `v2f i` 上给出该 struct 的字段候选（T-024 vitest + T-027 集成「`i.` 成员补全」，log 09:11 / 09:33）
  - [x] `#include "` 给出候选路径（同目录 / `Assets` / `Packages` / `PackageCache` / 内置）（T-025 vitest 五层来源 + T-027 集成 PackageCache 路径，log 09:11 / 09:33）
  - [x] 已知 Unity 宏（`SAMPLE_TEXTURE2D`、`TEXTURE2D`、`TransformWorldToHClip` 等）可补全并带文档（T-023 `preproc_function_def` 入索引 + T-026 文档三级回退，log 08:53 / 09:11）
  - [x] Rename 回归语料（含注释、字符串、未激活 `#if` 分支、同名不同作用域字段）零误改（T-032 逐处 Range 断言 + T-030 作用域/分支用例，log 09:52）

## M4 语法诊断与死分支灰化（done）

- 范围补充：功能规格 [../specs/feature-syntax-diagnostics.md](../specs/feature-syntax-diagnostics.md) 与
  [../specs/feature-dead-branch-dimming.md](../specs/feature-dead-branch-dimming.md) 已确认（七个范围点经用户 2026-10-28 逐项确认），
  拆为 T-037～T-048；细粒度验收以规格为准，本节只保留阶段级标准。
  **T-034 是语法诊断的前置**（豁免表与零误报门槛共用其 ERROR 模式聚合口径，ADR 0009）；灰化侧无此前置。
- 验收标准：
  - [x] 括号不匹配、缺 `;`、`HLSLPROGRAM` 缺 `ENDHLSL` 出红波浪线
  - [x] 官方语料（80+ 包内 `.hlsl` + 56 内置 include + 50 工程 shader）**零误报**，达不到则不默认开启
        （测法已定：`npm run gate:diagnostics` 断言语法诊断总数 = 0 并打印逐模式 ERROR 聚合表，见规格 §范围 8。
        实测 166 文件语法诊断总数 = 0 → 默认开启）
  - [x] 读取 Unity `Editor.log` 的 `Disabled keywords:` 列表，把未激活 `#if` 分支置灰；日志缺失时降级为不灰化且不报错

## M5 类型诊断（DXC）与格式化（done：T-049～T-067，2026-10-28）

- 范围补充：功能规格 [../specs/feature-type-diagnostics.md](../specs/feature-type-diagnostics.md) 与
  [../specs/feature-formatting.md](../specs/feature-formatting.md) 已确认（类型诊断六个范围点、格式化四个范围点
  经用户 2026-10-28 逐项确认），拆为 T-049～T-065；发布流水线（ADR 0005 落地 + ADR 0010 的第二个原生件）拆为 T-066～T-067。
  细粒度验收以规格为准，本节只保留阶段级标准。
  **T-049 是类型诊断的前置**（`dxc` 产物与定位不可用时，门槛测试与诊断接线都跑不起来，ADR 0010）；
  格式化侧不依赖 DXC，可与类型诊断并行；T-066/T-067 属发布面，不阻塞前两组。
- 验收标准：
  - [ ] 注入类型错误（`float4 = float3`、非法 swizzle）出诊断，且位置正确回映射到 `.shader` 的行列
        （测法已定：**分块虚拟文档与原文等长 → 坐标恒等**，DXC 的 `(line,col)` 就是 `.shader` 坐标，
        不需要自建双向映射表；见规格范围 1/2，T-050/T-058）
  - [ ] DXC 诊断在官方语料（80+ 包内 `.hlsl` + 56 内置 include + 50 工程 shader）上**零误报**，达不到则默认关闭
        （测法已定：`npm run gate:type-diagnostics` 断言类型诊断总数 = 0 并打印**逐错误签名**聚合表
        （归一化消息 + 可选 `-W` flag；实测 DXC 语义错误无错误码），语料缺失或 dxc 不可用记 SKIP 而非 PASS；
        默认值随门槛，见规格范围 12/13。误报控制 = 按消息模式的豁免表 + 「编译失败即整块不产」，ADR 0009 机制同构）
  - [ ] 格式化分层（ShaderLab 外壳 / `HLSLPROGRAM` 内部），两次格式化幂等，官方语料 diff 仅空白变化
        （测法已定：`npm run gate:format` 断言幂等 + 去 trivia 的叶子 token 序列不变 + 逐行 strip 空白后与原文相同；
        **未达标 → 不注册 formatting provider**，见规格范围 8/9，ADR 0011）

## M6 Unity 包侧（planned）

- 验收标准：
  - [ ] 构建时按规则删除 shader 变体，日志输出删除数量；规则配置存 `ProjectSettings/` 可随工程提交
  - [ ] Editor 启动时写工程元数据（workspace、editor path、全部 shader 名），插件读取用于版本判定与清单补全
