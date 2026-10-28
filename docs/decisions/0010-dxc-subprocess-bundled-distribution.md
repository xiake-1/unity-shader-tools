---
adr: 0010
date: 2026-10-28
title: "DXC 类型诊断的执行形态与分发：短命子进程调用随扩展附带的官方预编译 dxc；宏注入用自写默认宏表"
---
# 0010 · DXC 怎么接、编译器从哪来、宏从哪来

## 背景

ADR 0004 结清了「类型诊断用不用 DXC」（用，且不自研类型系统），但它**只定了选型，没定执行形态**。它自己的后果段把胶水面全留成未决（[0004-dxc-type-diagnostics.md](0004-dxc-type-diagnostics.md) 后果段）：接口形态、编译器来源、进程模型、宏注入、分发物。roadmap M5 要在拆任务前给出可验证的验收口径（[../plan/roadmap.md](../plan/roadmap.md) M5 第二、三条），这五项不结清就写不出「误报低于阈值」的测法。本 ADR 结清其中四项跨模块项（行号映射算法属规格层，不在本 ADR）。

已核实与新增事实：

- Unity 侧只有 `Editor\Data\Tools\dxcompiler.dll`，**无独立 `dxc.exe`**（[../分析/09-implementation-options.md](../分析/09-implementation-options.md) §0）→ 「直接用用户 Unity 里的编译器」不是一条现成的路。
- DXC 官方 Releases 提供 Windows `dxc.exe` + `dxcompiler.dll`、Linux `dxc` + `libdxcompiler.so`，**没有 macOS 预编译产物**；发布包体积为 Windows zip 25.8 MB、Linux tar.gz 12.4 MB（压缩后）（[Releases · microsoft/DirectXShaderCompiler](https://github.com/microsoft/DirectXShaderCompiler/releases)）。→ ADR 0004 后果段写的「自带 `dxc.exe` 仅几 MB 量级、远小于对标产品的 31MB 引擎」**低估一个量级**，本 ADR 更正口径（按规范 §3 旧 ADR 不改写，以本条为准）。
- 命令行侧存在无需入口点的编译模式：`lib_6_x` 库目标（入口点靠 `[shader(...)]` 属性标注，不指定入口也能对全文件做语义检查），宏与 include 经 `-D`/`-I` 注入，错误输出形态为 `<file>(<line>,<col>): error <code>: <message>` → 文本可解析、位置可回映射。
- `IDxcIntelliSense` 是 COM 接口（0004 原文点名的正是它），Node 侧要用它必须 native addon + COM 绑定，且 COM 只在 Windows 存在。
- 宏注入的方向与 ADR 0008 相反：DXC 编译需要**确定开启**的宏集（`SHADER_API_*` 等），而 `Editor.log` 的 `Disabled keywords:` 只给**确定关闭**集合（[0008-dead-branch-dimming-editor-log.md](0008-dead-branch-dimming-editor-log.md) 决策段）→ 不能直接复用为 DXC 的输入。

备选：

- **X1 进程内 native addon 绑 `IDxcIntelliSense`**：语义能力最全（将来可给补全、成员访问、重载解析，即 [../分析/09-implementation-options.md](../分析/09-implementation-options.md) 的完整 B3）；但 Node↔COM 绑定工程量远超 0004 估的 3～5 周，ADR 0005 的 prebuild 矩阵要再翻一倍，Linux/macOS 无 COM，且编译崩溃落在 server 进程内 → 否。
- **X2 借用用户 Unity 的 `dxcompiler.dll`**：零分发体积、随 Unity 版本自动更新（与 ADR 0003 的哲学同构）；但版本随用户漂移 → 门槛测试不可复现（ADR 0009 要求门槛可重复），非 Unity 降级态根本没有编译器，且仍需自己加载 dll（回到 X1 的绑定问题）→ 否。
- **X3 首次运行下载 DXC**：与 ADR 0005 已否的 E3 同理（网络依赖 + 「下载产物版本 ≠ 扩展版本」漂移，离线工程直接不可用）→ 否。
- **X4 只支持用户自备（`unityShader.dxcPath`）**：vsix 零增长，但默认无类型诊断，与「类型错误由 DXC 给出编译器级诊断」的产品预期（[../project.md](../project.md) 成功标准）相悖 → 否，降级为覆盖项。
- **X5 短命子进程 + 随扩展附带官方预编译 `dxc`**（选定）。
- 进程复用子备选：**每次编译 spawn 一次**（选定）vs **常驻 dxc 服务进程**：DXC 无增量解析（0004 已记），常驻换不来增量收益，只带来状态泄漏与第二套生命周期 → 否。

## 决策

类型诊断的执行形态定为 **X5**：server 以**短命子进程**调用**随扩展附带的官方预编译 `dxc`**，用**库编译目标**（`-T lib_6_x`，无需入口点）做语义检查，宏与 include 经 `-D`/`-I` 注入，输出文本解析回 `.shader` 坐标；**不绑 `IDxcIntelliSense`、不使用 Unity 的 `dxcompiler.dll`、不做首次运行下载**，`unityShader.dxcPath` 可覆盖为自备编译器。DXC 编译所需的宏以**自写内置默认宏表 + 当前文件 `#define`** 为权威来源，ADR 0008 的 `Editor.log` Disabled 集合**只做减法**（关掉已知关闭的），不用于推断「什么开着」。DXC 只产类型/语义诊断，**不接管** M2/M3 已交付的 definition / completion / hover。

## 后果

- 正面：跨平台可用（win32-x64 / linux-x64 有官方产物）；编译崩溃隔离在子进程，不拖垮 server（与 ADR 0002「进程边界天然隔离解析崩溃」同向）；**不新增 native addon**，ADR 0005 的 prebuild 矩阵不翻倍；DXC 版本随扩展版本锁定 → 门槛测试可复现（ADR 0009 的可重复性要求）；spawn 边界天然就是缓存、超时与取消的落点。
- 负面（接受）：
  - **分发体积**：官方发布包 Windows zip 25.8 MB、Linux tar.gz 12.4 MB（压缩后），解压后编译器库本体是十 MB 量级 —— 这是对 ADR 0004「几 MB」的更正。单一 vsix 附带 win32-x64 + linux-x64 会把体积推到几十 MB 量级，ADR 0005 留作「体积失控后的手段」的 `targetPlatform` 分包在 DXC 这件上大概率要提前启用；具体口径由 ADR 0005 的发布流水线任务实测产物体积后定，不在本 ADR 预写。
  - **macOS 无官方预编译产物** → 类型诊断在 macOS 默认不可用，必须显式提示而非静默无智能（与 ADR 0005「未覆盖平台加载失败要给明确错误」同构），自备 `dxcPath` 是唯一路径。登记为未决项。
  - 命令行接口比 COM 粗：拿不到 IntelliSense 式的增量与补全能力。将来若要 DXC 反哺补全/成员访问，须另立 ADR（本 ADR 的「不接管」界定随之复议）。
  - 每次编译一次 spawn（几十 ms 量级）+ DXC 无增量 → 缓存键与触发时机（保存 vs 编辑）是规格必须结清的项，否则 M5 性能口径无从谈起。
  - **自写内置默认宏表是第二份知识**（与 ADR 0009 的豁免表同类风险）：与 Unity 版本 / 渲染管线版本漂移会造成误报或漏报 → 要求它是仓库内数据表、带来源与版本注记，且「宏不可判定」的方向按**宁可漏报不可误报**（编译整体失败即整块不产类型诊断并记日志，与 ADR 0009 同向）。
  - **子进程 ≠ 常驻进程**：core 规格的「不起额外进程」那条针对的是对标产品的常驻 watcher（[../specs/feature-language-server-core.md](../specs/feature-language-server-core.md) 不在范围节、ADR 0002 后果段）。本 ADR 把「短命工具子进程」界定在该禁令之外，**不取代 ADR 0002**；若将来引入常驻编译服务，须另立 ADR。
- 与既有 ADR 的关系（均不取代）：
  - **0004**：本 ADR 只结清它留下的执行面与分发面，关系同构于 0005 对 0001；并更正其「几 MB」体积估计。
  - **0005**：分发原则不变（随扩展附带、不在安装期编译、不走 WASM、不做首次运行下载），只是新增**第二个原生分发物**；`targetPlatform` 分包的启用条件由 0005 的落地任务按实测体积决定。
  - **0008**：不改其关键字源决策；只界定 Disabled 集合在 DXC 侧只做减法，宏的权威来源另有（见决策段）。
  - **0009**：门槛测试复用同一份语料与聚合口径（「不造两套」仍然有效），但类型诊断的误报豁免键是 **DXC 错误码**而非 tree-sitter ERROR 模式 → 豁免**机制**同构（按模式 + 命中计数 + 冗余可发现），豁免**表**另立一份。
- 未决项（登记，不预写取代关系）：① macOS 覆盖策略（自备 / 自行构建 / 明确声明不支持）；② `targetPlatform` 分包是否因 DXC 体积提前启用；③ M6 工程元数据桥是否取代「内置默认宏表 + Editor.log」成为宏的权威源 —— 与 ADR 0008 已登记的未决项同源，届时一并处理。
- 落地边界（不在本 ADR 内）：须先由 /project-spec 立 `feature-type-diagnostics`（覆盖的文件类别、已有语法 Error 时是否跳过 DXC、虚拟 `.hlsl` ↔ `.shader` 行号映射与多 `HLSLPROGRAM` 块、include 闭包与内置 CG include 编译失败的处理、缓存键与触发时机、severity 与默认开关、门槛命令与「误报阈值」的量化口径、编译器缺失/加载失败的降级与提示、配置项命名），再由 /project-plan 拆任务（依据可写 `spec:feature-type-diagnostics` + `ADR:0010`；按 M4 的 T-034 先例，语料门槛脚本与宏表基座应排在诊断接线之前）。
