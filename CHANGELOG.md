# 更新日志

## v0.0.7 — 2026-10-30

- 更新插件列表页的更新日志样式：一行一条

## v0.0.6 — 2026-10-30

- 新增 `CGPROGRAM` / `GLSLPROGRAM` 代码块与 `.cginc` 文件的格式化
- 新增 `unityShader.formatting.intraLineSpacing` 设置，规范化行内空白（默认开启）
- 新增 `unityShader.formatting.braceSplitting` 设置，拆分行尾的 `}`（默认开启）
- 改进格式化：着色器代码块按块深度统一缩进
- 改进格式化性能：2001 行文档 p95 约 144 ms（ShaderLab 为主）/ 150 ms（HLSL 区域为主）
- 修复 `.shader` 文件按 `Shift+Alt+F` 没有反应的问题
- 新增 Output 通道的 `[format]` 状态行

## v0.0.5 — 2026-10-29

- 更新插件列表页与 README：中文优先，附英文版本
- 更新图标为 Unity 立方标风格

## v0.0.2 — 2026-10-29

- 修复从 Marketplace 安装后语言服务无法启动的问题（vsix 缺少运行时依赖）

## v0.0.1 — 2026-10-29

- 首个版本：转到定义、查找引用、重命名、补全、悬停
- 新增语法诊断与条件编译死分支灰化
- 新增 DXC 类型诊断（随扩展附带官方 `dxc`）
- 新增代码格式化与变体计数报告
- 附带 6 个平台的原生组件（win32-x64/arm64、linux-x64/arm64、darwin-x64/arm64）
