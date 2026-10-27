# 01 · 总体架构

## 1. 三层结构

```
┌──────────────────────────────────────────────────────────────────┐
│ ① VSCode 扩展  dist/extension.js  (55.8 KB, webpack 打包)         │
│    · 语言注册 / tmLanguage / snippets / language-configuration    │
│    · 8 个 LanguageFeature Provider（全部是"远程代理"）             │
│    · 进程与端口生命周期管理                                       │
│    · 文档变更 → 推送全文给服务端（/update）                        │
│    · 授权 UI、i18n、状态栏、消息推送                              │
└───────────────┬──────────────────────────────┬───────────────────┘
                │ spawn(detached)              │ fork(detached)
                ▼                              ▼
   sls / sls.exe  (原生语言服务器)      dist/watcher.js (25 KB, chokidar)
   win 31.8MB / mac 16.0MB / linux 19.1MB   监听整个工作区，
   Rocket(HTTP) + tree-sitter               把磁盘上的 shader 文件
   + 自研 shaderlab grammar                 内容 POST 到 /update
                ▲
                │ HTTP 127.0.0.1:<随机端口>
                │
┌───────────────┴──────────────────────────────────────────────────┐
│ ③ Unity 包 com.amlovey.omni-shader (Editor-only C#)               │
│    · [InitializeOnLoadMethod] 写 Library/omnishader.json          │
│      { workspace_path, unity_editor_path, all_shaders[] }         │
│    · 解包 Editor/Data/os.dat → %APPDATA%/OmniShaderTools/         │
│      .omnishader/{win|mac}/os(.exe)   ← 同一引擎的 CLI 形态        │
│    · 子进程调用：os analysis "<path>" / os strip "<path>" ...      │
│    · IPreprocessShaders / IPreprocessComputeShaders 做变体裁剪     │
└──────────────────────────────────────────────────────────────────┘
```

**关键点：VSCode 端几乎没有"语言智能"，它只是一个 UI 适配层 + 进程管家。** 所有解析、符号表、类型检查、格式化都在原生二进制里。

## 2. 交付物清单（安装后 78.6 MB）

```
amlovey.amlovey-omnishader-vsc-1.2.1/
├── package.json                     3.5 KB   扩展清单（见 02）
├── dist/
│   ├── extension.js                 55.8 KB  扩展主入口（webpack 生产包）
│   └── watcher.js                   25.0 KB  独立文件监听进程（chokidar 打包）
├── languages/
│   ├── UnityShader.tmLanguage.json  11.7 KB   391 行正则语法
│   ├── language-configuration.json  959 B     括号/注释/region 折叠
│   └── snippets.json                3.6 KB    35 个片段
├── sls/                             ← 语言服务器（三平台全量分发）
│   ├── win/sls.exe                  31.8 MB
│   ├── mac/sls                      16.0 MB
│   ├── linux/sls                    19.1 MB
│   └── {win,mac,linux}/
│       ├── Rocket.toml              workers=20, form/data-form/json=20MiB
│       └── inc/
│           ├── cg.std               172 KB  ← CG 内建函数（含文档注释）
│           ├── hlsl.std             15.9 KB ← HLSL 内建
│           ├── sm5.std              105 KB  ← Shader Model 5 资源类型
│           ├── sm6.std              3.7 KB  ← SM6（Wave/Quad intrinsics）
│           ├── glsl.std             3.1 KB  ← GLSL vec/mat 结构体定义
│           ├── unity.std            5.9 KB  ← Unity 内建函数
│           ├── values.std           4.8 KB  ← Unity 内建变量（UNITY_MATRIX_* 等）
│           ├── types.std            4.5 KB  ← Texture1D.. 等结构体方法
│           └── data/
│               ├── intellisense.json 40.8 KB
│               └── keywords.json     12.5 KB
└── unitypack/com.amlovey.omni-shader/  ← Unity 包（见 04）
    ├── package.json / .asmdef (Editor-only)
    ├── Editor/*.cs                  约 20 个文件
    ├── Editor/Data/os.dat           9.56 MB  ← XOR 混淆的 os(.exe) 打包体
    └── Editor/Styles/               MaterialIcons.ttf/.asset + app.uss
```

> 注意 `sls/` 三平台二进制都塞进 VSIX，这是 78 MB 体积的主因。VSCode Marketplace 支持 `targetPlatform`（如 `win32-x64`）做平台分包，他们没有用 —— 换来的是"一个 VSIX 通吃所有平台/远程开发"。

## 3. 启动时序（从 `dist/extension.js` 的 `activate` 还原）

```
activate(context)
 ├─ createOutputChannel("OmniShader Unity")
 ├─ registerCommand × 4   (active / openSite / checkLicense / installUnityPack)
 ├─ register*Provider × 8  ← 立即注册，不等服务端就绪
 ├─ if (omnishader.enableDiagnostics) 挂 4 个文档事件（debounce 900ms）
 └─ setTimeout(300ms)
     ├─ 状态栏 "Omni Shader: Launching..."
     ├─ 选端口：扫 %LOCALAPPDATA%/OmniShaderTools 下已有 <port>.PORT，
     │          在 [17892, 47892) 随机取一个不冲突的
     ├─ 选平台目录：process.platform → sls/{win|mac|linux}
     ├─ spawn(sls, [port, workspaceRoot, incrementalParsing], {cwd: sls目录, detached: true})
     ├─ stdout 监听：
     │    出现 "launched from http://127.0.0.1" 时
     │      → fork(watcher.js, [port, workspaceRoot, disableCompiledShader], {detached:true})
     │      → 状态栏改为 "Omni Shader: On"
     │      → getNofityIfNeeds()（拉营销/更新通知，12h 节流）
     ├─ 清理其它实例留下的失效 .PORT 文件（fetch 超时 100ms 即删除）
     └─ 读取本地 .lic.error 弹"授权被其它机器使用/已过期"

deactivate()
 └─ process.kill(slsPid, SIGTERM); process.kill(watcherPid, SIGTERM)
```

**`detached: true` 的含义**：sls 与 watcher 都不随扩展宿主退出而死；扩展卸载/窗口关闭靠 `deactivate` 显式 kill。若 VSCode 崩溃，会残留孤儿进程 —— 这正是它需要"清理失效端口"机制的原因。

## 4. 工作区根目录的推断（`PathManager`）

服务端需要知道 Unity 工程根，才能解析 `#include`、找到 `Library/PackageCache`、读 `Library/omnishader.json`。客户端的判定顺序：

1. 已打开的 shader 文档路径里找 `\assets\`、`\packages\`、`\library\packagecache\` 分段；
2. 否则从文件所在目录向上找同时含 `assets/` 与 `library/` 的目录；
3. 否则取第一个 workspace folder；
4. 否则退化为扩展自身目录（此时智能受限，CHANGELOG 0.0.7b/0.0.10b 明确提到"脱离工程打开 shader 时智能不完整"）。

## 5. 两条"文档进入服务端"的路径

| 路径 | 触发 | 用途 |
|---|---|---|
| 客户端 `/update` | `onDidChangeTextDocument`（debounce 700ms）、每次 completion/signature 之前、格式化之后 | 未保存的编辑器缓冲区状态 |
| watcher 进程 `/update` | chokidar 监听工作区 add/unlink | 预热服务端缓存（新增/删除文件时通知） |

两者都传**全文**（`code` 字段），删除时传 `remove=true` + 空内容。服务端自己维护 AST 与增量解析（`omnishader.incrementalParsing` 传给 sls 作为第 3 个命令行参数）。

> **【2026-10-27 实测修正】** 对从未在编辑器打开过的文件直接查 `/symbol` 能拿到符号 → **服务端自己按需读盘**，watcher 只是预热，不是跨文件能力的必要条件。实测本次会话 `watcher.js` 子进程**根本没有运行**（进程列表里只有 `sls.exe`），跨文件解析依然正常，且没有任何用户可见的错误提示（状态栏仍显示 "Omni Shader: On"）。详见 [07-live-probe-results.md](07-live-probe-results.md)。

## 6. 与常见做法的差异（值得注意的取舍）

| 常规做法 | Omni Shader 的做法 | 代价 / 收益 |
|---|---|---|
| LSP（stdio + `vscode-languageclient`） | 自定义 HTTP + FormData，自己写 8 个 Provider 代理 | 失去 LSP 生态（其它编辑器免费接入、进度/取消/半开事务），换来：服务端可被 Unity 以 CLI 复用、可被 VS 扩展复用、调试直观（curl 即可） |
| Node 写 server（`vscode-languageclient/server`） | Rust 原生二进制 | 体积 +78MB、跨平台交叉编译成本，换来：解析性能、内存可控、同一份引擎服务 IDE 与 Unity |
| 只解析当前文件 | 服务端持有全工程符号表 + 文件监听 | 启动慢（CHANGELOG 多次"优化启动时间"），换来：真跳转/引用/重命名/include 诊断 |
| 用 `targetPlatform` 分包 | 三平台二进制全塞 | 下载体积大 |
