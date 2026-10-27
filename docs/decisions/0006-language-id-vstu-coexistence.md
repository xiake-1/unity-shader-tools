---
adr: 0006
date: 2026-10-27
title: 语言 id 保持自有 unityshader / hlsl，与 VSTU 的 UnityShader 按 documentSelector + 运行时自愈 + 修复命令共存
---
# ADR 0006 · 语言 id 与 VSTU 共存

同时把 log 22:00 已实施的语言 id 拆分（`.shader` → `unityshader`、`.hlsl/.hlslinc/.cginc` → `hlsl`）正式登记为决策。无取代关系。

## 背景

语言 id 是 VS Code 里 grammar、language-configuration、LSP `documentSelector`、snippets 的公共键；选错 id 会让「扩展装了但整屏无反应」。

已核实的事实：

- 我们的 id：`.shader` → `unityshader`（scope `source.shaderlab`）；`.hlsl/.hlslinc/.cginc` → `hlsl`（scope `source.hlsl`）。拆分动因见 log 22:00：VS Code 不内置 HLSL，`include: "source.hlsl"` 指向不存在的 grammar 时 TextMate 会**静默丢弃整条规则**，程序块整段无着色。
- VSTU 血统的工具链会在工程 `.vscode/settings.json` 里写 `files.associations`，把 `*.shader / *.cginc / *.cg / *.hlsl / *.compute` 关联到语言 id **`UnityShader`**（log 22:06 实测原始值）。
- `files.associations` 优先级**高于**扩展按 `extensions` 的语言注册；且 id 大小写敏感（[官方文档](https://code.visualstudio.com/docs/languages/overview)明确 `'Markdown' != 'markdown'`）→ `unityshader` ≠ `UnityShader`。
- 于是最坏现场：VSTU 不在装、关联残留 → 该 id 无人提供 → 回落 `Plain Text`，grammar 与 semantic tokens 全不可用（`Inspect Editor Tokens and Scopes` 报 "No grammar or semantic tokens available"）。而我们的扩展**仍会激活并在索引**（`workspaceContains` 激活事件，log 21:44）→ 后台在跑、前台零反馈。
- `UnityShader` 是**活的** id：微软「Unity for Visual Studio Code」扩展沿用 `visualstudiotoolsforunity.vstuc` 发布（[公告](https://devblogs.microsoft.com/visualstudio/announcing-the-unity-extension-for-visual-studio-code/)）。对标产品作者也公开承认这个 id 冲突在 VS Code 层未解，并说「让用户改 `files.associations`，很多用户不知道其用法，也不看文档」（[OmniShader ISSUES #9](https://github.com/OmniShader/ISSUES/issues/9)）。
- 手工修可行但不可规模化：测试工程 `D:\Work\Unity\ShaderStudy\.vscode\settings.json` 现已被改成 `"*.shader": "unityshader"`、`"*.hlsl/*.cginc/*.cg/*.compute": "hlsl"`。

备选：

- **L1 主 id 直接采用 `UnityShader`**：命中存量关联、开箱可用；但该 id 属于微软扩展（活的），两个扩展注册同一 id 时语言与 grammar 归属不确定（先到先得），大写违反 conventions §8 的全小写约定，还会把 `.cg`/`.compute` 一并拖进我们的语言 → 否。
- **L2 只靠文档让用户改 `files.associations`**：零实现，但对标产品已验证这是体验陷阱 → 否。
- **L3 `contributes.configurationDefaults` 提供关联默认值**：只改默认层，工作区/用户设置照样覆盖它 → 对 VSTU 生成的工程无效，只作辅助手段。
- **L4 自有 id + 三层共存**：选定。

## 决策

主 id 保持自有的 `unityshader`（`.shader`）与 `hlsl`（`.hlsl/.hlslinc/.cginc`），**不采用 `UnityShader`**；与 VSTU 的共存由三层组成：

1. **LSP `documentSelector` 额外接受 `UnityShader`** —— 对方扩展在装时，这些文档照样由我们的 server 提供定义/引用/补全/semantic tokens（semantic tokens 优先于对方 TextMate 着色），不改任何用户配置；
2. **运行时自愈** —— 对扩展名属于我们、`languageId === 'plaintext'`（即关联指向无人提供的 id）的文档，在激活时与 `onDidOpenTextDocument` 上调用 `vscode.languages.setTextDocumentLanguage` 切到我们的 id：只改当前会话的文档语言，**不写用户/工作区设置**；
3. **显式命令 `Unity Shader: Fix file associations`** —— 把 `files.associations` 里指向无人提供 id 的这几条改写为我们的 id，写入前需用户确认，默认写工作区。

## 后果

- 正面：三种现场都有解 —— 对方在装（靠 documentSelector 接管语义）、对方不在装但关联残留（会话内立刻恢复着色与智能）、想永久修（一条命令、经确认）；不 squatting 别人的 id，grammar 与 language-configuration 归属确定；id 全小写符合 conventions §8。
- 负面（接受）：documentSelector 里出现别人的 id，若对方也提供同名语义能力会重复注册（后到的 provider 生效，可接受）；`setTextDocumentLanguage` 可能覆盖用户「临时选 Plain Text」的意图 → 触发条件必须收窄到「扩展名属于我们 + `languageId === 'plaintext'` + 对应 glob 关联的 id 无人提供」；写设置属侵入用户配置，必须确认且只改这几条。
- `.cg` / `.compute`：**首期不新增语言注册**（CG 语义与 compute 不在 project.md 范围内）；但用户工程若已把它们关联到 `hlsl`（实测该测试工程就是），server 按 HLSL 解析、只索引不发诊断，不算范围扩张；要正式纳入须先改 project.md/规格（/project-spec）。
- id 撞车风险登记：Marketplace 上已有使用 `unityshader` 的扩展（如 [ashiqi.UnityShader](https://marketplace.visualstudio.com/items?itemName=ashiqi.UnityShader)），同名 id 同时安装时语言与 grammar 归属同样不确定 → 发布时用唯一 publisher 并在 README 声明；真出冲突再立 ADR。
- 验收口径（交 /project-plan 拆任务，依据 `ADR:0006`）：fixture 工程带 VSTU 残留关联（`*.shader` → `UnityShader`、VSTU 未装）时，打开 `.shader` 后 `languageId === 'unityshader'` 且 semantic tokens 可用；fixture 里 VSTU 在装时不改设置也能拿到转到定义；命令写回的 settings.json 只含这几条关联。
- 本 ADR 不改代码；documentSelector、自愈与命令属客户端改动，落地交 /project-plan，涉及用户可见行为的部分（`.cg`/`.compute` 是否纳入）交 /project-spec。
