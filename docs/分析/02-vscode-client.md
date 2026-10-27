# 02 · VSCode 端实现（`dist/extension.js`）

打包方式：webpack 生产模式 + `hidden-source-map`，模块 ID 为数字。运行时只 `require` 了 5 个 Node 内置模块：`vscode`、`child_process`、`fs`、`path`、`crypto`（`randomUUID`）。**没有任何第三方运行时依赖进入 extension.js**（`chokidar` 只进了 `watcher.js`）。

模块划分（从 bundle 里的模块号还原）：

| 模块号 | 职责 |
|---|---|
| 265 | `activate` / `deactivate`、Provider 注册、诊断与死分支装饰、注释续行 |
| 309 | HTTP API 客户端（所有 `fetch*`）、类型映射（服务端 DTO → VSCode 对象）、`AppGlobal` |
| 141 | 路径/平台工具、日志、`PathManager`、`shouldLanguageFeatureDisabled` |
| 732 | 常量（语言 ID、API host、版本号、扩展名白名单、授权错误码） |
| 351 | 授权（激活、检查、通知、机器指纹） |
| 690 | i18n 字典（8 种语言硬编码） |
| 440 / 792 / 864 / 780 / 563 / 592 / 931 / 772 | 8 个 Provider 实现 |

---

## 1. 静态贡献点（`package.json`）

```jsonc
"languages": [{ "id": "UnityShader",
  "extensions": [".shader",".cginc",".compute",".hlsl",".raytrace",".std",".glsl",".glslinc"],
  "configuration": "./languages/language-configuration.json" }],
"grammars":  [{ "language": "UnityShader", "scopeName": "source.shader.unity",
  "path": "./languages/UnityShader.tmLanguage.json" }],
"snippets":  [{ "language": "UnityShader", "path": "./languages/snippets.json" }],
"configuration": {
  "omnishader.enableDiagnostics":        false,   // 改后需重启
  "omnishader.formatting.braceOnNewLine": true,
  "omnishader.formatting.macroMatchIndent": true,
  "omnishader.disableCompiledShader":     true,
  "omnishader.incrementalParsing":        true    // 改后需重启
}
```

- `activationEvents: []` + `engines.vscode ^1.95.0` → 空数组意味着**任何窗口都会激活**（VSCode 对无 activationEvents 的扩展默认在启动时激活）。这是"服务端常驻"策略的必要条件。
- 语法高亮是**纯 tmLanguage 正则**（391 行），没有用服务端 token。仓库里 `source.shader.unity` 的 scope 命名很讲究：`uff_*`（固定管线）、`unity_*`（ShaderLab 块）、`keyword.other.bettershader.omnishader`（`BEGIN_*/END_*`）等，说明他们把 tmLanguage 与 tree-sitter 语法术语保持同构，便于测试与主题适配。
- `language-configuration.json` 里配了 `//region / #region` 折叠标记。
- snippets 35 条：`Shader`、`SubShader`、`Fallback`、`Property *`（7 种类型）、`Tags`、`Blend *`（5 种常用混合）、`CGPROGRAM...ENDCG`、`HLSLPROGRAM...ENDHLSL`、`#include "UnityCG.cginc"` / `"Packages"` / `"Lighting.cginc"` / `"AutoLight.cginc"`、`region`、`for`、`if`、`struct`。

---

## 2. Provider 注册（全部是服务端代理）

```js
// 触发字符很关键：补全在 . : " \ / # 空格 都触发
registerCompletionItemProvider("UnityShader", new OSCompletionProvider(), ".", ":", '"', "\\", "/", "#", " ")
registerSignatureHelpProvider("UnityShader", new OSSignatureHelpProvider(), ",", "(", " ")
registerDocumentSymbolProvider / registerDefinitionProvider / registerHoverProvider
registerReferenceProvider / registerRenameProvider / registerDocumentFormattingEditProvider
```

Provider 实现薄到只有一两行，例如补全：

```js
class OSCompletionProvider {
  provideCompletionItems(doc, pos, ctx, token) {
    const trigger = doc.getText(new Range(pos.translate(0,-1), pos));   // 上一个字符
    return updateProgramToServer(doc)                                     // 先推全文
      .then(() => fetchCompletion(doc, pos, trigger))
      .then(items => items.map(i => new CompletionItem(i.label, osKindToCompletionKind(i.kind))));
  }
}
```

跳转的健壮性处理（服务端可能返回 `.std` 里的内建符号，那些文件不存在于磁盘）：

```js
class OSGoToDefinitionProvider {
  provideDefinition(doc, pos) {
    return fetchDefition(doc, pos).then(r =>
      r.path === NEED_LICENSE_ERROR ? (showRequiredProNofication("Go to Definition"), null)
      : r.path.endsWith(".std") ? null
      : existsSync(r.path) ? osLocationToLocation(r) : null);   // CHANGELOG 1.0.0 修过"打开不存在的文件"
  }
}
```

悬停返回**两段**：一段代码块（用 `UnityShader` 语言做语法着色）+ 一段 Markdown 文档：

```js
new Hover([{ language: "UnityShader", value: r.value }, new MarkdownString(r.doc)])
```

重命名分两步：`prepareRename` 调 `/rename` 拿位置列表缓存到实例字段，`provideRenameEdits` 再按新名字生成 `WorkspaceEdit`（并在每个文件上补一次 `/update`）。

---

## 3. 服务端进程与端口管理

```js
// 端口：扫 %LOCALAPPDATA%/OmniShaderTools 下已存在的 <port>.PORT，避开它们
let t = (() => {
  let e = getAppLocalDataFolder();
  let t = readdirSync(e).map(f => parse(f).name);
  let n = 17892 + Math.floor(3e4 * Math.random());
  while (t.length > 1 && t.indexOf(n.toString()) !== -1) n = 17892 + Math.floor(3e4*Math.random());
  return { port: n.toString(), otherPorts: t.filter(x => x !== n.toString()) };
})();
AppGlobal.value = t.port;

const dir = join(extPath, "sls", platform);            // win | mac | linux
const bin = join(dir, "sls");                          // Windows 下 spawn 会自动解析 .exe
const incremental = !!workspace.getConfiguration().get("omnishader.incrementalParsing");
const child = spawn(bin, [AppGlobal.value, workspaceRoot, `${incremental}`], { cwd: dir, detached: true });

child.stdout.on("data", chunk => {
  log(`SLS: ${chunk}`);
  if (chunk.indexOf("launched from http://127.0.0.1") !== -1) { launchWatcher(workspaceRoot); ... }
});
```

- 端口文件内容就是端口号本身（实测 `%LOCALAPPDATA%\OmniShaderTools\34289.PORT` 内容为 `34289`），作用是**多窗口/多实例互不抢端口**并留下可清理的痕迹。
- 清理陈旧端口：对每个 `otherPort` 发一次 `fetch(http://127.0.0.1:<port>/..., {signal: AbortSignal.timeout(100)})`，失败即 `rmSync(<port>.PORT)`。
- `cwd` 设为 `sls/<platform>` 目录，因为服务端用**相对路径**加载 `inc/*.std`、`inc/data/*.json`、`Rocket.toml`（见 03）。

`watcher.js` 的全部自有逻辑只有 ~30 行（其余是 chokidar）：

```js
chokidar.watch(workspaceRoot, { persistent: true })
  .on("add",   p => { if (!skip(p)) post(p, readFileSync(p,"utf8")); })
  .on("unlink", p => { if (!skip(p)) post(p, "", true); });
// post → POST http://127.0.0.1:<port>/update  FormData{path, code, remove}
// skip → 只处理 8 种 shader 扩展名；跳过 .std；按 disableCompiledShader 跳过 Temp/compiled-* /generatedFrom*
```

> 注意它监听的是**整个工作区根**（Unity 工程下含 `Library/`），靠扩展名过滤。CHANGELOG 1.1.5 修过 "backend file watcher are broken by moudle not found error"，1.1.6 "通过启动时不扫描全部 shader 来改善启动时间" —— 这条路径历史上反复出问题。
>
> **【实测】** 本次会话该子进程并未运行（只有 `sls.exe`），但跨文件解析仍正常（服务端按需读盘），且失效时无任何提示。自研时不要引入这个失败面：用 LSP 的 `workspace/didChangeWatchedFiles`，让 VSCode 自己管文件监听。

---

## 4. 编辑器侧增强（不依赖服务端的部分）

### 4.1 文档注释自动生成

监听 `onDidChangeTextDocument`，识别三种情形：

- 在 `///` 行尾回车 → 自动插入 `/// `；
- 在 `/*` 块内回车 → 自动插入 `* `；
- 在已有 `///` 上再输入 `/`（变成 `////`）、或在 `//*` 上输入 `*` → 调服务端 `/doc` 生成完整文档骨架，替换整行。

服务端返回的骨架（从二进制字符串还原）：

```
/// <summary>
/// 
/// </summary>
/// <returns></returns>
/// <param name=""></param>
```
以及 javadoc/doxygen 风格：`@param `、`@return `、`@brief`、`@details`。

### 4.2 死代码分支灰化（"Live Testing"，Pro）

```js
const r = await fetchBranches(doc, keywords);   // POST /branch {path, keywords}
// 返回 [{ if_branch:{condition_value,start,end}, elseif_branches:[...], else_branch:{...} }]
// 客户端按 C 语义挑出"求值为假"的分支，生成 DecorationOptions
activeEditor.setDecorations(UNUSED_CODE_STYLE /* color: grey */, ranges);
```

关键字来自文件里的 `//! DEBUG;STEP:1` 注释（CHANGELOG 1.1.2），debounce 700ms。这是**用编辑器装饰 + 服务端预处理器求值**组合出来的功能，不需要改语法、不需要 LSP 的 semantic tokens。

### 4.3 对"编译产物"关闭智能

```js
function shouldLanguageFeatureDisabled(p) {
  const name = basename(p).toLowerCase();
  if (name.endsWith(".std")) return true;
  const inTemp = p.toLowerCase().includes(sep + "temp" + sep);
  return (name.startsWith("compiled-") || name.startsWith("generatedfrom")) && inTemp
         && getConfiguration().get("omnishader.disableCompiledShader");
}
```

即 Unity Inspector 里 "Show generated code / Compiled code" 导出的 `Temp/compiled-*.shader`、`Temp/generatedFrom*.shader` 默认不享受语言服务（这类文件巨大且无意义）。**这是很实用的一行代码级功能，值得直接抄。**

---

## 5. 授权与商业分层

| 机制 | 实现 |
|---|---|
| 激活 | 命令 `Omni Shader: Active License` → 输入框校验长度必须 36 → `POST https://api.amlovey.com/os/code` `{machine, key, action:"reg", src:"unityVSCwin121"}` → 成功写 `.lic.os` + `.lic.state`，要求重启窗口 |
| 机器指纹 | `%APPDATA%/OmniShaderTools/.mac` 存一个自生成的 `randomUUID()` |
| 失败态 | `.lic.error` 内容 `machine_mismatch` / `expired` → 启动时弹"被其它机器使用/已过期" |
| 运行期判定 | 服务端在受限功能的响应里返回哨兵值 `path === "-1000001"`（`NEED_LICENSE_ERROR`），客户端据此弹"Basic 模式不支持，是否试用？" |
| 状态查询 | `GET /basic` → `"true"/"false"`（点状态栏触发 `checkLicense`） |
| 快捷试用 | `POST /quicktrial`（服务端签发 1 天，无需账号，一机一次） |
| 营销通知 | `POST https://api.amlovey.com/os/notify`，12 小时节流（`.notify` 存时间戳），消息落 `.news` 显示在状态栏 |

**分层实现方式值得注意**：功能开关**不在客户端**，而在服务端响应里。客户端只是"收到 -1000001 就弹付费引导"。这样客户端无法被本地改配置绕过（对自研产品是重要设计点）。

---

## 6. i18n

`690` 模块内硬编码 8 种语言的字典（en / zh-cn / ja / ko / de / fr / pt-br / es），按 `vscode.env.language` 取。没有用 `package.nls.json`（即扩展清单里的命令标题不翻译，只有运行时消息翻译）。
