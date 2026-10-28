功能规格目录：一个功能一个文件，命名 `feature-<名>.md`，与 `src/` 模块对应。规范见 [../reference/conventions.md](../reference/conventions.md) §8。

- [feature-language-server-core.md](feature-language-server-core.md) — 语言服务器核心（解析/索引/include/生命周期），M2～M5 功能规格的共同地基
- [feature-go-to-definition.md](feature-go-to-definition.md) — 转到定义（M2）：工程内/包内/内置真实声明行、局部变量与成员访问、include 与 `#pragma` 跳转
- [feature-completion.md](feature-completion.md) — 语义补全（M3）：struct 成员、`#include` 路径、Unity/URP 宏与函数带文档、用户 `#define` 宏；服务端前缀过滤
- [feature-rename.md](feature-rename.md) — 引用与重命名（M3）：references、prepareRename/rename、Properties/宏/`sampler_` 联动、内置拒绝、资产失效提示
- [feature-hover.md](feature-hover.md) — 悬停（M3 后补）：符号声明行 + 邻近注释/宏文档、自写语义表（`SV_*` 等系统值语义）
- [feature-syntax-diagnostics.md](feature-syntax-diagnostics.md) — 语法诊断（M4）：tree-sitter ERROR/MISSING → Error、include 未找到 → Warning、ERROR 模式豁免表、语料零误报门槛
- [feature-dead-branch-dimming.md](feature-dead-branch-dimming.md) — `#if` 死分支灰化（M4）：Editor.log `Disabled keywords:`、三态求值、LSP 扩展通知 + 客户端装饰
