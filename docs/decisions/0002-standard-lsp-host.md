---
adr: 0002
date: 2026-10-27
title: 宿主形态采用标准 LSP（stdio）+ TS 客户端与独立 TS server
---
# ADR 0002 · 宿主形态走标准 LSP

## 背景

语言智能放在哪里、用什么协议通信，决定跨编辑器接入与 Unity 侧复用能力。备选（详见 [../分析/09-implementation-options.md](../分析/09-implementation-options.md) 子问题 C）：

- **C1 纯扩展内实现（无 server）**：成本最低，测试工程规模（≈几千符号）单进程完全够；但语义逻辑绑死 VSCode API，将来做 CLI / Unity 侧复用要重构；
- **C2 标准 LSP（`vscode-languageclient` + 独立 Node/TS server 进程）**：+3～5 天，白拿其它编辑器接入；
- **对标产品的私有 HTTP + FormData**：历史上为同时服务 VS/Unity/CLI 而造；自研没有理由重造（[../分析/01-architecture.md](../分析/01-architecture.md) §6），且失去 LSP 生态（进度、取消、半开事务、其它编辑器免费接入）。

## 决策

宿主采用 C2：`vscode-languageclient`（stdio）+ 独立 TypeScript/Node LSP server；核心逻辑不依赖 VSCode API，保持无状态纯函数库形态，为将来 CLI / Unity 侧复用同一 server 留口。

## 后果

- 正面：Rider/Neovim/Zed 等编辑器按 LSP 免费接入；客户端 Provider 代码几乎为零（vscode-languageclient 代劳）；调试可用 LSP inspector；进程边界天然隔离解析崩溃。
- 负面（接受）：多一个进程与生命周期管理（崩溃重启 ≤3 次、窗口关闭回收，已写入规格 [../specs/feature-language-server-core.md](../specs/feature-language-server-core.md)）；打包两个产物；LSP 协议层带来少量序列化开销。
- 不照抄：对标产品三平台原生二进制全塞 VSIX（78MB）—— 我们是纯 TS，无此问题；不起对标产品那样的独立 watcher 进程，文件监听走 LSP `workspace/didChangeWatchedFiles`。
