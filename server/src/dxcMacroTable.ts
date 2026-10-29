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

/* ---------------------------------------------------------------------------
 * T-078：用户级宏覆盖（规格 feature-dxc-macro-overrides 范围 2/3；ADR 0014 缺口）
 * 条目语法：`NAME`（定义成 1）/ `NAME=VALUE`（首个 `=` 拆分）/ `-NAME`（强制不定义）。
 * 处置顺序＝默认表 → Disabled 减法（**显式覆盖条目豁免**，用户确认的优先级）→ 覆盖增删改。
 * ------------------------------------------------------------------------- */

export interface MacroOverrides {
  /** 最终生效的增/改值条目（重复条目＝最后一条生效，已在解析里结清） */
  defines: MacroEntry[];
  /** 强制不定义的名字（作用于默认表与块外文件 `#define` 的注入，不动块内文本） */
  removes: ReadonlySet<string>;
  /** 被逐条拒绝的非法条目原文（日志 `macro-invalid=<n>`；不整表作废） */
  invalid: string[];
}

export const EMPTY_OVERRIDES: MacroOverrides = { defines: [], removes: new Set<string>(), invalid: [] };

const OVERRIDE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 解析覆盖列表为增删集合（纯函数，vitest 直接喂假列表）。非法判据见规格约束段。 */
export function parseMacroOverrides(list: readonly string[]): MacroOverrides {
  const invalid: string[] = [];
  // 有序 map：后写条目覆盖先写（规格范围 3「重复条目 → 最后一条生效」）
  const plan = new Map<string, { kind: 'define'; value?: string } | { kind: 'remove' }>();
  for (const raw of list) {
    const entry = (raw ?? '').trim();
    if (!entry) {
      invalid.push(String(raw));
      continue;
    }
    if (entry.startsWith('-')) {
      const name = entry.slice(1);
      if (!OVERRIDE_NAME_RE.test(name)) {
        invalid.push(entry); // 孤立的 `-`、`--x` 等
        continue;
      }
      plan.set(name, { kind: 'remove' });
      continue;
    }
    const eq = entry.indexOf('='); // 首个 `=` 拆分；值可含 `=` `:` `/`
    const name = eq < 0 ? entry : entry.slice(0, eq);
    const value = eq < 0 ? undefined : entry.slice(eq + 1);
    // 名字非法、空值（`NAME=`）、值含空白（`A=a b`）→ 逐条拒绝
    if (!OVERRIDE_NAME_RE.test(name) || value === '' || (value !== undefined && /\s/.test(value))) {
      invalid.push(entry);
      continue;
    }
    plan.set(name, { kind: 'define', ...(value !== undefined ? { value } : {}) });
  }
  const defines: MacroEntry[] = [];
  const removes = new Set<string>();
  for (const [name, op] of plan) {
    if (op.kind === 'remove') {
      removes.add(name);
    } else {
      // 裸 `NAME` → 值 1：内置头有裸 `#if X` 写法，空值宏会让表达式为空（同默认表理由）
      defines.push({ name, value: op.value ?? '1', source: 'override' });
    }
  }
  return { defines, removes, invalid };
}

export interface MacroTableOptions {
  /** `Editor.log` 的 Disabled keywords（只做减法） */
  disabled?: ReadonlySet<string>;
  /** 当前文档的 `#define`（`extractFileDefines` 的产物） */
  fileDefines?: readonly MacroEntry[];
  /** 额外注入（测试/用户配置） */
  extra?: readonly MacroEntry[];
  /** T-078：用户显式覆盖（`parseMacroOverrides` 的产物）；在 Disabled 减法**之后**应用 */
  overrides?: MacroOverrides;
}

/** 生成 `-D` 参数列表（`NAME` 或 `NAME=value`）。 */
export function buildMacroArgs(opts: MacroTableOptions = {}): string[] {
  const disabled = opts.disabled ?? new Set<string>();
  const fileDefines = opts.fileDefines ?? [];
  const extra = opts.extra ?? [];

  const fileNames = new Set(fileDefines.map((d) => d.name));
  let chosen: MacroEntry[] = [];

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

  // 4. 覆盖（T-078）：`-NAME` 从宏表剔除（含块外文件 `#define` 的注入；块内文本不动）；
  //    显式 define 同名替换并**豁免 Disabled 减法**（减法已发生在上面，这里不再受它约束）。
  const ov = opts.overrides;
  if (ov) {
    if (ov.removes.size) chosen = chosen.filter((m) => !ov.removes.has(m.name));
    for (const d of ov.defines) {
      chosen = chosen.filter((m) => m.name !== d.name);
      chosen.push(d);
    }
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
