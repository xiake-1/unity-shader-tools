ADR 目录：4 位编号命名 `NNNN-标题.md`，只追加，旧文件永不修改；取代关系仅由新 ADR 的 `supersedes` 单向表达。规范见 [../reference/conventions.md](../reference/conventions.md) §3。

- [0001-treesitter-parsing-layer.md](0001-treesitter-parsing-layer.md) — 解析层采用 tree-sitter
- [0002-standard-lsp-host.md](0002-standard-lsp-host.md) — 宿主走标准 LSP + TS 客户端/server
- [0003-index-real-source-symbols.md](0003-index-real-source-symbols.md) — 内置符号索引真实源码
- [0004-dxc-type-diagnostics.md](0004-dxc-type-diagnostics.md) — 类型诊断外包 DXC
- [0005-grammar-prebuild-distribution.md](0005-grammar-prebuild-distribution.md) — grammar 分发：N-API prebuilds 随 VSIX
- [0006-language-id-vstu-coexistence.md](0006-language-id-vstu-coexistence.md) — 语言 id 与 VSTU 共存
