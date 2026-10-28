/**
 * T-052：DXC 的宏来源（规格 feature-type-diagnostics 范围 3；ADR 0010）。
 *
 * 权威顺序（ADR 0010 结清的口径）：
 *  1. **自写的内置默认宏表**（本文件，每条带来源与 Unity 版本注记）；
 *  2. **当前文件里的 `#define`**（块内的由 DXC 直接看到；块外的经 `-D` 注入，保证跨块可见）；
 *  3. Unity `Editor.log` 的 `Disabled keywords:` 集合 —— **只做减法**（关掉默认表里被禁的项），
 *     不作为宏的权威来源（ADR 0008 的降级口径：日志缺失 = 不减，不报错）。
 *
 * 保守原则：**宁可漏定义**（漏定义 → 走 `#if !defined(X)` 分支，通常少编译代码、少误报），
 * 不猜平台相关取值。缺什么由 T-057 门槛的逐错误码聚合表暴露，再往表里加（每条都要有来源）。
 *
 * 证据来源（本机 Unity 2022.3.62f3c1，2026-10-28 实测）：
 *  - `Editor/Data/CGIncludes/HLSLSupport.cginc` 里的 `SHADER_API_*` 名字集合；
 *  - `Editor/Data/CGIncludes/AutoLight.cginc:111` 用 `defined(UNITY_COMPILER_HLSLCC)` 选路径
 *    —— 我们喂给 DXC 的正是 hlscc 家族，所以定义它符合事实；
 *  - `Editor/Data/CGIncludes/UnityBuiltin3xTreeLibrary.cginc:139` 用 `(SHADER_TARGET > 30)`。
 */

export interface MacroEntry {
  name: string;
  /** 有值时按 `NAME=value` 传 `-D`；无值时只传 `NAME` */
  value?: string;
  /** 为什么定义它（可追溯；门槛失败时按这条决定加还是删） */
  source: string;
}

/** 内置默认宏表。刻意保持小：只放**有证据**且**平台无关或已声明平台**的项。 */
export const DEFAULT_MACROS: readonly MacroEntry[] = [
  {
    name: 'UNITY_COMPILER_HLSLCC',
    value: '1',
    source: 'Unity 内置头按它选 hlscc 路径（AutoLight.cginc:111）；DXC 属同一编译器家族（Unity 2019+ 的 hlscc 即 DXC）',
  },
  {
    name: 'SHADER_API_D3D11',
    value: '1',
    source: '编辑器 Windows 桌面的默认图形 API；名字取自 HLSLSupport.cginc（2022.3.62f3c1）。带值 1：内置头里有 `#if SHADER_API_D3D11` 这种**不带 defined()** 的写法，空值宏会让表达式为空',
  },
  {
    name: 'SHADER_API_DESKTOP',
    value: '1',
    source: '同上：桌面平台族标记（HLSLSupport.cginc）',
  },
  {
    name: 'SHADER_TARGET',
    value: '50',
    source: '桌面 D3D11 对应的 shader target 等级；内置头用它做 `> 30` 判断（UnityBuiltin3xTreeLibrary.cginc:139）',
  },
];

/** 明确**不**定义的平台族（定义它们会与 D3D11 冲突，制造误报）。写下来防误加。
 *  第二个用途（T-053）：这份名单同时是「**确定为假**」的宏名集合，喂给 M4 的三态求值，
 *  使 `#if defined(SHADER_API_XBOXONE)` 一类分支判定为假 —— 否则分支里的 `#include`
 *  （未安装的 `com.unity.render-pipelines.xboxone` 等包）会被算成 `include-fail` 而整块丢诊断。
 *  名单来源：本机 URP 14 `Common.hlsl` 与 2022.3 `HLSLSupport.cginc` 里出现过的 `SHADER_API_*` 全集。 */
export const NEVER_DEFINED_BY_DEFAULT: readonly string[] = [
  'SHADER_API_GLES',
  'SHADER_API_GLES3',
  'SHADER_API_GLCORE',
  'SHADER_API_METAL',
  'SHADER_API_VULKAN',
  'SHADER_API_MOBILE',
  'SHADER_API_PSSL',
  'SHADER_API_SWITCH',
  'SHADER_API_XBOXONE',
  'SHADER_API_N3DS',
  'SHADER_API_D3D11_9X',
  // 与 D3D11 互斥的桌面/主机族（URP 14 Common.hlsl 的 include 守卫用到；2026-10-28 实测补）
  'SHADER_API_D3D12',
  'SHADER_API_GAMECORE',
  'SHADER_API_PS4',
  'SHADER_API_PS5',
];

const DEFINE_RE = /^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)(\(([^)]*)\))?\s*(.*)$/;

/** 从文档文本里取**对象式** `#define`（函数式 `#define F(x)` 跳过：`-D` 传不了）。
 *  只做行级文本提取，不依赖 grammar —— 块外的 `#define` 也要能拿到。 */
export function extractFileDefines(text: string): MacroEntry[] {
  const out: MacroEntry[] = [];
  const seen = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^\s*\/\//.test(line)) continue; // 行注释
    const m = DEFINE_RE.exec(line);
    if (!m) continue;
    const [, name, fn, , rest] = m;
    if (fn) continue; // 函数式宏
    const value = (rest ?? '').replace(/\/\/.*$/, '').trim();
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, ...(value ? { value } : {}), source: 'file-define' });
  }
  return out;
}

export interface MacroTableOptions {
  /** `Editor.log` 的 Disabled keywords（只做减法） */
  disabled?: ReadonlySet<string>;
  /** 当前文档的 `#define`（`extractFileDefines` 的产物） */
  fileDefines?: readonly MacroEntry[];
  /** 额外注入（测试/用户配置） */
  extra?: readonly MacroEntry[];
}

/** 生成 `-D` 参数列表（`NAME` 或 `NAME=value`）。 */
export function buildMacroArgs(opts: MacroTableOptions = {}): string[] {
  const disabled = opts.disabled ?? new Set<string>();
  const fileDefines = opts.fileDefines ?? [];
  const extra = opts.extra ?? [];

  const fileNames = new Set(fileDefines.map((d) => d.name));
  const chosen: MacroEntry[] = [];

  // 1. 默认表：被 Disabled 减掉的跳过；与文件 #define 同名的跳过（文件优先）
  for (const m of DEFAULT_MACROS) {
    if (disabled.has(m.name)) continue;
    if (fileNames.has(m.name)) continue;
    chosen.push(m);
  }
  // 2. 文件 #define（不减：用户显式写的）
  chosen.push(...fileDefines);
  // 3. 额外注入（同样受 Disabled 约束）
  for (const m of extra) {
    if (disabled.has(m.name)) continue;
    chosen.push(m);
  }

  const seen = new Set<string>();
  return chosen
    .filter((m) => (seen.has(m.name) ? false : (seen.add(m.name), true)))
    .map((m) => (m.value === undefined || m.value === '' ? m.name : `${m.name}=${m.value}`));
}

/** 减法后的默认宏（诊断/日志用：`macros=default:4-disabled:1`）。 */
export function defaultMacroNamesMinus(disabled: ReadonlySet<string>): string[] {
  return DEFAULT_MACROS.map((m) => m.name).filter((n) => !disabled.has(n));
}
