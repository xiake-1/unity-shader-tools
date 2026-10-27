---
status: active
updated: 2026-10-28
---
# 路线图

里程碑划分依据 [../分析/10-feature-feasibility.md](../分析/10-feature-feasibility.md) 的"价值/成本"排序，
范围来自 [../project.md](../project.md) 范围节。全部里程碑尚未启动。

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

## M3 补全与引用：语义补全 + Rename（planned）

- 验收标准：
  - [ ] `i.` 在 `v2f i` 上给出该 struct 的字段候选
  - [ ] `#include "` 给出候选路径（同目录 / `Assets` / `Packages` / `PackageCache` / 内置）
  - [ ] 已知 Unity 宏（`SAMPLE_TEXTURE2D`、`TEXTURE2D`、`TransformWorldToHClip` 等）可补全并带文档
  - [ ] Rename 回归语料（含注释、字符串、未激活 `#if` 分支、同名不同作用域字段）零误改

## M4 语法诊断与死分支灰化（planned）

- 验收标准：
  - [ ] 括号不匹配、缺 `;`、`HLSLPROGRAM` 缺 `ENDHLSL` 出红波浪线
  - [ ] 官方语料（80+ 包内 `.hlsl` + 56 内置 include + 50 工程 shader）**零误报**，达不到则不默认开启
  - [ ] 读取 Unity `Editor.log` 的 `Disabled keywords:` 列表，把未激活 `#if` 分支置灰；日志缺失时降级为不灰化且不报错

## M5 类型诊断（DXC）与格式化（planned）

- 验收标准：
  - [ ] 注入类型错误（`float4 = float3`、非法 swizzle）出诊断，且位置正确回映射到 `.shader` 的行列
  - [ ] DXC 诊断在官方语料上的误报低于设定阈值，达标前默认关闭或降级为 Hint
  - [ ] 格式化分层（ShaderLab 外壳 / `HLSLPROGRAM` 内部），两次格式化幂等，官方语料 diff 仅空白变化

## M6 Unity 包侧（planned）

- 验收标准：
  - [ ] 构建时按规则删除 shader 变体，日志输出删除数量；规则配置存 `ProjectSettings/` 可随工程提交
  - [ ] Editor 启动时写工程元数据（workspace、editor path、全部 shader 名），插件读取用于版本判定与清单补全
