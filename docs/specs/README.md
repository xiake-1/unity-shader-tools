功能规格目录：一个功能一个文件，命名 `feature-<名>.md`，与 `src/` 模块对应。规范见 [../reference/conventions.md](../reference/conventions.md) §8。

- [feature-language-server-core.md](feature-language-server-core.md) — 语言服务器核心（解析/索引/include/生命周期），M2～M5 功能规格的共同地基
- [feature-go-to-definition.md](feature-go-to-definition.md) — 转到定义（M2）：工程内/包内/内置真实声明行、局部变量与成员访问、include 与 `#pragma` 跳转
