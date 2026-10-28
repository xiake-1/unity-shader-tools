---
adr: 0005
date: 2026-10-27
title: grammar 分发采用随 VSIX 附带的 N-API prebuilds（不在安装期编译、不走 WASM、不做首次运行下载）
---
# ADR 0005 · grammar 分发：N-API prebuilds 随 VSIX

结清 ADR 0001 留下的未决项（「grammar 用 native 还是 WASM binding、打包工具 esbuild/tsup」）。**不取代 0001**，只补上它的分发面。

## 背景

解析层（ADR 0001）在运行时依赖三个原生件：自写 `shaderlab` grammar、`tree-sitter` 运行时、`tree-sitter-hlsl`。它们怎么到用户机器上，决定安装体验、性能口径和发布复杂度。

已核实的事实：

- 三个原生件都是 **N-API**：`grammar/binding.gyp` 依赖 `node-addon-api`；加载入口 `grammar/bindings/node/index.js` 用 `node-gyp-build`，查找顺序是 `prebuilds/<platform>-<arch>/` → `build/Release/`。
- 上游已经这么发：`tree-sitter@0.22.4` 与 `tree-sitter-hlsl@0.2.0` 的 npm 包里各带 6 平台 prebuilds（win32-x64/arm64、darwin-x64/arm64、linux-x64/arm64），`tree-sitter-hlsl` 的发布脚本就是 `prebuildify --napi --strip`。
- 我们自己的 grammar **目前没有任何可分发产物**：只有本机 `grammar/build/Release/shaderlab_binding.node`（node-gyp 13 + MSVC，log 20:38），而 `build/` 与生成物 `grammar/src/parser.c` 都在 `.gitignore` 里。
- server 由 VS Code 的 Electron 二进制以 `ELECTRON_RUN_AS_NODE=1` 拉起（ADR 0002、log 21:24）。N-API 在 Node 与 Electron 里 ABI 通用，已被实测：`npm run test:vscode` 6/6 在 Electron-as-node 宿主里加载原生绑定通过。
- **VSIX 安装不执行 `npm install`**（扩展包自带依赖），所以「安装期编译」在 VSIX 这条路径上根本不成立。
- 性能门槛由 native 达成：真实工程冷索引 1402ms（<3s）、增量 p95 4.05ms、RSS 192MB（log 22:52、20:38）。
- 对照与风险登记：对标产品三平台原生二进制全塞 VSIX → 78MB（[../分析/01-architecture.md](../分析/01-architecture.md)），[../分析/06-feasibility-and-roadmap.md](../分析/06-feasibility-and-roadmap.md) §4 给的缓解是「`targetPlatform` 分包 / 首次运行下载 / WASM 单文件」。

备选：

- **E1 安装期 `node-gyp` 编译**：用户机要 MSVC/Xcode/clang，VSIX 路径不跑 npm，Remote/WSL 与 CI 更糟 → 否。
- **E2 WASM 单文件**（`tree-sitter build --wasm` + `web-tree-sitter`）：单产物、无 ABI/平台矩阵、将来可支持 vscode.dev；但官方明确「在 Node 里跑 wasm 比 node 绑定明显慢」，要引入第二套运行时 API（`Parser.init`/`Language.load`，与 `server/src/parser.ts`、`documentStore.ts` 现用绑定不同），`tree-sitter-hlsl` 上游不发 wasm 得我们自己编，且 `tree-sitter-cli ^0.25` 下 `build --wasm` 还要自备 wasi-sdk（自动下载是 0.26.1 起）。ADR 0002 已定 stdio 本地进程，web 场景短期用不到 → 否。
- **E3 首次运行下载二进制**：vsix 最小，但引入网络依赖与「下载产物版本 ≠ 扩展版本」的漂移，离线工程直接不可用 → 否。
- **E4 native 为主 + WASM 兜底**：覆盖面最广，但两条运行时路径都要长期测；6 平台 prebuilds 已覆盖 VS Code 官方 `targetPlatform` 面（musl/Alpine 例外）→ 暂不采用，真收到 musl 报告再立 ADR。
- **E5 N-API prebuilds 随 VSIX**：选定。

## 决策

grammar 与 tree-sitter 运行时一律以 **N-API prebuilds 随 VSIX 附带**：发布流程用 `prebuildify --napi --strip` 产出 `grammar/prebuilds/<platform>-<arch>/shaderlab_binding.node`（与上游同构），随单一 vsix 分发；不在安装期编译、不走 WASM、不做首次运行下载。打包面随之确定：client 继续 esbuild bundle，**server 保持 `tsc` 不 bundle**（bundle 会破坏 `node-gyp-build` 基于 `__dirname` 的 prebuild 查找），用 `@vscode/vsce` + `.vscodeignore` 打包。

## 后果

- 正面：用户机零工具链、零网络、零首次运行等待；一份 N-API 二进制同时服务 Node（vitest / bench）与 Electron-as-node（生产宿主），bench 数字即生产数字；与上游 `tree-sitter`/`tree-sitter-hlsl` 分发方式同构，`node-gyp-build` 的查找顺序让「开发期本机编译」与「发布期 prebuild」天然共存，本地开发流程不变。
- 负面（接受）：发布必须有**多平台编译矩阵**（CI 或交叉编译），grammar 一改就要重编 6 份产物；vsix 体积上升（grammar + tree-sitter 运行时 + hlsl grammar ×6 平台，估 MB 量级）——ADR 0002 曾记「我们是纯 TS，无 78MB 问题」，本 ADR 之后确实带原生产物，但量级差两个数量级且仍走单一 vsix，`targetPlatform` 分包留作体积失控后的手段。
- 未覆盖平台（musl/Alpine、linux-arm 等）会**加载失败**而非降级 → 客户端必须给出明确错误提示（不是静默无智能），需要时补产物或按 `targetPlatform` 分包。
- 发布流程要锁版本：生成器 `tree-sitter-cli ^0.25` 与运行时 `tree-sitter ^0.22.4` 的 **parser ABI 必须匹配**，prebuild 必须由 CI 从 `grammar.js` 重新生成（`grammar/src/parser.c` 是 gitignore 的生成物，不能依赖本机残留）。
- 验收口径：prebuild 版产物上复跑 `npm run bench` 与 `npm run test:vscode`，性能与 M1 基线（1402ms / 192MB）不劣化。
- 若将来要支持 vscode.dev / Web，需要 WASM **且**非 stdio 宿主，届时另立 ADR（可能同时取代本 ADR 与 ADR 0002 的一部分）。
- 落地动作不在本 ADR：prebuildify 脚本 + CI 矩阵 + `.vscodeignore` + vsce 属工程任务，交 /project-plan（依据可写 `ADR:0005`）。
