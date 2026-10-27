# 04 · Unity 编辑器包 `com.amlovey.omni-shader`

包位置（VSIX 内）：`unitypack/com.amlovey.omni-shader/`，版本 `1.0.2`，`"unity": "2021.3"`，asmdef `includePlatforms: ["Editor"]`、`autoReferenced: true`。

安装方式：VSCode 命令 `Omni Shader: Install Omni Shader Tools for Unity Editor` → 把该目录**整份复制**到 `<Unity工程>/Packages/`（客户端代码：`copyIntoDir(join(extPath,"unitypack","com.amlovey.omni-shader"), join(projectRoot,"Packages"))`）。工程根由 `PathManager` 推断，失败就提示"似乎当前不在 Unity 项目中"。

> 这是"包分发"的最省事做法：不走 UPM 私有源、不走 OpenUPM、不要求用户改 `manifest.json`。代价是包进了版本库、升级要手动重跑命令。

## 1. 入口与生命周期

```csharp
// Features/OnLoad.cs
[InitializeOnLoadMethod]
static void Init() {
    OmniShaderMetaDataGenerator.Generate();          // 写 Library/omnishader.json
    if (Unpacker.UnpackInNeeds(Constants.OS_VERSION)) // 解包 os.dat
        Communicator.TryEnsureExecuableIfNeeds();     // 非 Windows 下 chmod +x
}
```

窗口入口：`[MenuItem("Tools/Omni Shader")]` → `OmniShaderEditorWindow : EditorWindow`，加载 USS 样式、`Theme.DetectTheme()` 适配 Pro/Light skin，状态存在一个 `ScriptableObject`（`hideFlags = HideAndDontSave`）里以扛住域重载。

五个页签：`Home / Explorer / Build / Stripper / Programming`（左侧导航 + 状态栏，全部 UIElements 手写）。

## 2. 与 IDE 的桥：`Library/omnishader.json`

```csharp
// Features/OmniShaderMetaData.cs
public class OmniShaderMetaData {
    public string workspace_path;      // Path.GetDirectoryName(Application.dataPath)
    public string unity_editor_path;   // EditorApplication.applicationPath
    public List<string> all_shaders;   // AssetDatabase t:Shader ∪ ShaderUtil.GetAllShaderInfo()
}
// 写到 <工程>/Library/omnishader.json
```

这是整个 IDE↔Unity 联动的**唯一上行通道**，成本极低（一个 JSON 文件），但收益明确：
- `all_shaders` → VSCode 里 `Fallback "..."` 的补全（CHANGELOG 1.2.1 明确"需要安装 Unity 包"）；
- `unity_editor_path` → 推断 Unity 版本，决定内置 `UnityCG.cginc` 等路径与关键字集合。

**这是本报告里最值得直接借鉴的一条设计。**

## 3. 引擎分发：`Editor/Data/os.dat`（9.56 MB）

Unity 包不依赖 VSCode 是否安装，自带一份同引擎的 **CLI 形态** `os(.exe)`，但打包成一个混淆 blob：

```csharp
// Common/Unpacker.cs
public const byte SEED = 131;                       // 0x83
var bytes = File.ReadAllBytes("Editor/Data/os.dat");
bytes = UnPackBytes(bytes, SEED);                   // 全文件逐字节 XOR 0x83
// 之后是 TLV 流：
//   int32 relPathLen | relPath(utf8) | int32 contentLen | content
// 逐个写盘到 %APPDATA%/OmniShaderTools/.omnishader/<relPath>
```

- 版本控制：`.omnishader/VERSION` 存 `Constants.OS_VERSION`（当前 1），本地版本 ≥ 目标版本就跳过解包；否则**整目录删除重建**。
- 解包后目录结构含 `win/os.exe`、`mac/os`（`GetOSExePath()` 按 `#if UNITY_STANDALONE_WIN` 选择）。
- 非 Windows 首次解包后跑一次 `chmod +x`。
- XOR 只是**防顺手翻包**，不是加密。目的：不把可执行文件直接放进 Unity 包（Unity AssetDatabase 会导入 .exe、市场扫描会告警、包体也会膨胀）。

## 4. 调用方式：一次性 CLI，不是常驻服务

```csharp
// Features/Communicator.cs
var psi = new ProcessStartInfo {
    FileName = osExe,
    Arguments = $"{command} {string.Join(" ", arguments)}",
    UseShellExecute = false, RedirectStandardOutput = true,
    RedirectStandardError = true, CreateNoWindow = true,
    WorkingDirectory = Path.GetDirectoryName(osExe)
};
var p = Process.Start(psi);
var output = p.StandardOutput.ReadToEnd();   // 约定：stdout 是 JSON
p.WaitForExit();
```

用到的子命令：

| 命令 | 参数 | 返回 |
|---|---|---|
| `analysis` | `"<shader 绝对路径>"` | `{"keywords":[…],"passes":[…],"shader_path":"…"}` → `JsonUtility.FromJson<AnalysisResult>` |
| `strip` | `"<src>" "<shader_name>" "<includePasses,逗号>" "<excludeKeywords,逗号>"` | stdout 直接是**生成后的 .shader 文本**，写盘 |

> 注意与 VSCode 侧的差别：IDE 侧是**常驻 HTTP 服务**（要低延迟），Unity 侧是**一次性进程**（要简单、无端口冲突）。同一引擎两种宿主形态 —— 这是"原生二进制 + 无状态核心"架构的红利。

## 5. Shader Stripper（代码级变体裁剪）

流程（`OmniShaderEditor.CreateStripperContent` + `Features/OSStripper.cs`）：

1. 选目标 Shader（`ObjectField`）；
2. `analysis` 拿到该 shader 的 `multi_compile/shader_feature` 关键字列表与 pass 列表；
3. UI 上是两组**左右穿梭框**（`ListBoxGroup`：included/excluded keywords、included/excluded passes）；
4. `Generate` → `strip` → 写出新 `.shader`，文件名模板 `OmniShader_[FileName].shader`，`[%d]` 替换为 `yyyyMMddHHmmss`，输出到原文件同目录，然后 `AssetDatabase.Refresh()`。

### ShaderGraph 支持（反射黑魔法）

`.shadergraph` 没有源码，他们靠反射 ShaderGraph 编辑器程序集**离线生成** ShaderLab 代码，再走同一条 strip 流程：

```csharp
var asm = AppDomain.CurrentDomain.GetAssemblies()
    .First(a => a.GetName().Name == "Unity.ShaderGraph.Editor");
Type importerEditor = 找 "ShaderGraphImporterEditor";
Type generator      = 找 "Generator";
var data = importerEditor 的 "GetGraphData" 方法.Invoke(null, [AssetImporter.GetAtPath(graphPath)]);
var gen  = generator.GetConstructors()[0].Invoke(new object[]{ data, null, 1, assetName, null, null, true });
return generator 的 "generatedShader" 属性值;   // → 写到 Temp/<name>_os_gen.shader
```

【评价】这段非常脆弱（构造参数个数/顺序随 Unity 版本变），但思路正确：**要处理 ShaderGraph，就必须拿到它生成的 ShaderLab 文本**。更稳的做法是走 `ShaderGraphImporter` 的公开 API 或 `GraphicsSettings`/`ShaderUtil` 的生成代码接口，或要求用户先 "Use Graph Material" 导出。

## 6. Build：构建期变体裁剪（真正的产品价值点）

```csharp
// Features/BuildSettings.cs
public class OmniShaderPreprocesser : IPreprocessShaders, IPreprocessComputeShaders {
    public int callbackOrder => 0;                       // 抢在其它裁剪器之前
    public void OnProcessShader(Shader s, ShaderSnippetData snippet, IList<ShaderCompilerData> data) {
        var config = OSBuildSetting.Load();              // ProjectSettings/OmniShaderBuildSetting.json
        if (!config.Enabled || config.Rules.Count == 0) return;
        for (int i = data.Count - 1; i >= 0; i--)
            if (config.Rules.Any(r => IsMatchRule(r, "", s.name, assetPath, data[i])))
                data.RemoveAt(i);                        // 直接删变体
    }
    public void OnProcessComputeShader(ComputeShader cs, string kernelName, IList<ShaderCompilerData> data) { … 同上，按 kernelName 匹配 }
}
```

规则模型（`Components/BuildPanel.cs`）：

```csharp
Filters      = { KernalName, ShaderPath, FileName, Keywords }      // 原文拼写 Kernal
Comparisons  = { Contains, Equals }
Rule         = { Platform ("All" 或 BuildTarget 名), Filter, Comparison, Value }
```

`Keywords` 匹配读 `data.shaderKeywordSet.GetShaderKeywords()`，且要求 `IsEnabled(keyword)` 才算命中。

配置持久化到 **`ProjectSettings/OmniShaderBuildSetting.json`**（`JsonUtility`），因此可随工程提交、团队共享。

> 对比 Unity 官方 `ShaderProcesser`/`IPreprocessShaders` 手写代码：这个包的价值在于**把裁剪规则做成可视化 + 可版本化的配置文件**，而不是能力本身。技术上 200 行就能复刻。

## 7. Explorer（纯 C#，不走引擎）

`Components/ExploreContent.cs`（19 KB）+ `Features/AssetsExploerer.cs`：

- `AssetDatabase.FindAssets("t:Shader")` / `"t:Material"`，按 `All / InAssets / InPackages` 过滤 + 名称搜索；
- 材质行显示其引用的 `ShaderName`（`mat.shader.name`）；
- 内置 shader（GUID 以 `00000000` 开头）走 `Shader.Find(name)`；
- `GetAllShaderNames()` 取 `AssetDatabase` 与 `ShaderUtil.GetAllShaderInfo()` 的并集（后者含内置/包内 shader）。

没有做变体计数/内存占用统计（`ShaderUtil.GetShaderData` 的 `pass/variantCount` 未使用）—— 这是**可以做得比它更好**的地方。

## 8. 自研 UIElements 框架（成本被严重低估的部分）

```
Editor/Common/UI/Buttons.cs      62 KB   ← 手写控件库（按钮/表格/穿梭框/输入/图标按钮…）
Editor/Common/UI/Theme.cs         2 KB   明暗主题、状态栏色、ColorHelper.Parse
Editor/Common/UI/Container.cs     1 KB   布局容器基类
Editor/Common/UI/UIExtensions.cs  5 KB   样式路径解析、扩展方法
Editor/Styles/app.uss             244 B
Editor/Styles/MaterialIcons.ttf 128 KB + MaterialIcons.asset 380 KB（字体导入产物）
```

Unity 的 UIElements 没有官方控件库（没有 ListView 之外的成熟组件），要做"导航 + 表格 + 穿梭框"必须自己写。**这部分占了 Unity 包代码量的大头，也是复刻时最容易低估的工时。**

## 9. 复刻清单（Unity 侧）

| 能力 | 复刻难度 | 关键 API |
|---|---|---|
| 写 `Library/xxx.json` 元数据 | 极低 | `[InitializeOnLoadMethod]` + `JsonUtility` |
| 构建期变体裁剪 | 低 | `IPreprocessShaders` / `IPreprocessComputeShaders`，`callbackOrder` |
| 变体规则可视化 | 中（UI 工时） | UIElements + 自绘表格/穿梭框 |
| Shader 关键字/pass 分析 | **取决于是否有解析引擎** | 无引擎时可用 `ShaderUtil.GetShaderData`/`GetShaderPassData` + 正则扫 `multi_compile` |
| ShaderGraph 取源码 | 中-高（版本脆弱） | 反射 `ShaderGraphImporterEditor`/`Generator`，或公开导入器 API |
| 自带引擎二进制 | 低（但要处理 chmod、杀软、体积） | `Editor/Data/*.dat` 解包 |
