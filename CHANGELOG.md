# 更改日志 / Changelog

## 0.0.6 — 2026-10-30

**格式化现在覆盖 `CGPROGRAM` / `GLSLPROGRAM` 与 `.cginc`。**
此前 `.shader` 里的 CG 正文按原样输出——按 `Shift+Alt+F` 常常「没反应」；现在它和 `HLSLPROGRAM`
一样按块深度重排，`.cginc` 全文同样排版。

- 新增开关 `unityShader.formatting.intraLineSpacing`（默认开）：行内空白规范化——连续空格压成单空格、
  调用左括号前的空格删除、`.` 后的空格删除、`,` 后补一个空格。只动相邻 token 之间的空白，
  字符串、注释、宏体内部一律字节不变。
- 新增开关 `unityShader.formatting.braceSplitting`（默认开）：拆行尾 `}`（`return o;}` → 两行）。
  `};`、`} else {`、一行内的 `{…}` 不拆。
- 排版三条硬保证，对官方语料逐文件校验：连排两次结果字节相同；token 序列逐项不变；
  去掉全部空白后字符流完全一致。任何一条不成立 → **整篇不改**（失败即不改）。
- 解析不出结构的片段（宏定义的括号对、复杂预处理块等）保持字节原样；Output 通道每次排版给一行
  `[format] … cg=` 健康状态，索引统计里也有 `cgBytes`。
- 排版性能：2001 行文档 p95 —— ShaderLab 为主 144 ms、HLSL 区域为主 150 ms。

**Formatting now covers `CGPROGRAM` / `GLSLPROGRAM` and `.cginc`.** CG bodies in `.shader` used to be
emitted verbatim, so `Shift+Alt+F` often appeared to do nothing; they are now re-indented by block depth,
and `.cginc` files are formatted end-to-end. Two switches default to on: `intraLineSpacing`
(intra-line whitespace normalization) and `braceSplitting` (split a trailing `}`). Three guarantees are
verified file-by-file against the official corpus — formatting twice is byte-identical, the token sequence
is unchanged, and the non-whitespace character stream is unchanged; if any of them fails, nothing is
rewritten. Regions the parser can't structure (macro-defined brace pairs, complex preprocessor blocks)
stay byte-for-byte verbatim.

## 0.0.5 — 2026-10-29

- 列表页与 README 改版：中文优先 + 中英切换；图标改为 Unity 立方标风格。

## 0.0.2 — 2026-10-29

- 修复从 Marketplace 安装后语言服务起不来（`startFailed` / `write EPIPE`）：vsix 里缺 server 的运行时依赖闭包
  （`Cannot find module`）。打包改为把依赖闭包补写进 vsix。

## 0.0.1 — 2026-10-29

- 首个版本：转到定义 / 引用 / 重命名 / 补全 / 悬停（跨文件，跟随 `#include`，索引引擎内置与包内真实源码）、
  语法诊断与条件编译死分支灰化、DXC 类型诊断（随扩展附带官方 `dxc`）、代码格式化、变体计数报告、
  与 Unity for VS Code 共存的语言模式命令。原生组件按 6 个平台随 vsix 附带
  （win32-x64/arm64、linux-x64/arm64、darwin-x64/arm64）。
