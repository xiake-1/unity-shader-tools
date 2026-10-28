/**
 * T-055：DXC 类型诊断的豁免表（规格 feature-type-diagnostics 范围 10；ADR 0009 机制同构）。
 *
 * 与 `errorExemption.ts` 的**同构与不同构**之处：
 *  - 同构：数据表 + 命中计数 + 「每条必须在真实语料上有命中」的纪律（`npm run gate:type-diagnostics`
 *    断言命中 > 0，grammar/宏表修好后删行，防豁免变永久债）；命中即**不产诊断**（宁可漏报不可误报）。
 *  - 不同构：键不是 CST 特征，而是**归一化后的消息模式**（必填）+ 可选 `-W` flag + 可选文件特征。
 *    原因是实测（本机 DXC v1.9.2609）语义错误**不带错误码**，只有警告带 `[-Wflag]`
 *    —— 见 docs/progress/log.md 2026-10-28 16:45 与规格范围 7/10。
 *
 * 归一化口径（规格范围 10）：去掉数字、引号内标识符与类型参数后比较，
 * 使 `vector<float, 4>` 与 `vector<float, 3>` 落在**同一条**规则上（验收标准里点名的一条）。
 */
import type { DxcIssue } from './dxcRunner';

/** 归一化用占位符：`\u0001` 防止后续正则把插入的标记再替换一遍（与 errorExemption 同一手法）。 */
export function normalizeDxcMessage(message: string): string {
  let s = message
    // 1) 类型参数里的数字：`vector<float, 4>` → `vector<float, \u0001>`
    .replace(/\b\d+(\.\d+)?\b/g, '\u0001')
    // 2) 引号内标识符：`'foo'` / `'vector<float, 4>'` → `'S'`（规格：去掉引号内标识符与类型参数）
    .replace(/'[^']*'/g, "'\u0001'")
    // 3) 尖括号里的类型参数（无引号形态，如 `redefinition of <something>` 类）
    .replace(/<[^<>]*>/g, '<\u0001>')
    .replace(/\u0001/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > 160) s = s.slice(0, 160) + '…';
  return s;
}

/** 一条豁免规则（数据表条目；顺序即匹配顺序，先具体后宽泛）。 */
export interface DxcExemptionRule {
  id: string;
  /** 为什么这条 DXC 错误在 Unity 写法下不可信（「不豁免 + 理由」的反向记录） */
  reason: string;
  /** 归一化消息必须匹配（必填主键） */
  pattern: RegExp;
  /** 可选：仅当该条带这个 `-W` flag 时命中 */
  flag?: string;
  /** 可选：仅对路径匹配该模式的文件命中（内置/包内特征） */
  filePattern?: RegExp;
  /** 可选：只豁免某一侧；缺省两侧都豁免 */
  severity?: 'error' | 'warning';
}

/** 匹配上下文：DXC issue + 它报告的文件 + 本次编译的**文档**路径。
 *
 * 两个路径都要带，因为顶层文档是从 tmpdir 里的虚拟文件编译的：
 *  - 文档自身的错误 → `issue.file` = 虚拟文件（看不出原始路径）；
 *  - include 闭包内的错误 → `issue.file` = 真实头文件路径。
 * 所以「文件特征」必须同时看两边，否则独立打开一个包内头时规则不命中（实测踩过）。 */
export interface DxcMatchContext {
  issue: DxcIssue;
  /** 归一化后的消息（门槛脚本按它做逐签名聚合，与这里同一函数） */
  normalized: string;
  /** DXC 报告的文件路径；未知时为 '' */
  file: string;
  /** 本次编译的文档路径（`.shader` / `.hlsl` 的真实路径） */
  document: string;
}

export function dxcContextOf(issue: DxcIssue, document = ''): DxcMatchContext {
  return { issue, normalized: normalizeDxcMessage(issue.message), file: issue.file ?? '', document };
}

function ruleMatches(rule: DxcExemptionRule, ctx: DxcMatchContext): boolean {
  if (rule.severity && rule.severity !== ctx.issue.severity) return false;
  if (rule.flag && ctx.issue.code !== rule.flag) return false;
  if (rule.filePattern && !(rule.filePattern.test(ctx.file) || rule.filePattern.test(ctx.document))) {
    return false;
  }
  return rule.pattern.test(ctx.normalized);
}

/**
 * 引擎/包内头文件的特征。
 * **为什么每条规则都要带它**：把豁免收窄到「不是用户写的文件」，用户文件里的
 * `unknown type name` / `use of undeclared identifier` 仍然是最有价值的类型诊断。
 * 这也是 ADR 0009 否决「文件/路径级白名单」的边界所在 —— 文件特征只能**收窄**消息模式，
 * 不能单独成规则（否则门槛被掏空）。
 */
const ENGINE_HEADER = /[\\/](?:PackageCache|CGIncludes)[\\/]/i;

/**
 * 默认豁免表。
 * **纪律**：每条必须在真实语料上有命中（`npm run gate:type-diagnostics` 断言命中计数 > 0），
 * 否则删行。规则一律来自语料实测的逐签名聚合表（2026-10-28 本机 DXC v1.9.2609 +
 * URP `com.unity.render-pipelines.core@14.0.12`），不凭想象预写。
 *
 * 共同根因（除 R6/R7/R8 外）：**包内/内置头不是自足的编译单元**。门槛按规格范围 13 把
 * 62 个包内 `.hlsl` 各当一个编译单元喂给 DXC，但它们依赖「先 include `Common.hlsl`」这类
 * 前置条件（`real3`→`half3` 等类型别名就定义在那里），前置不在场时 DXC 报的是**依赖缺失**
 * 而不是代码错误。产品面这些错误本来也不推给用户（规格范围 11），但**用户直接打开这些头文件时
 * 会推** —— 所以必须在豁免表里结清，而不是靠推送过滤掩盖。
 */
export const DEFAULT_DXC_EXEMPTIONS: DxcExemptionRule[] = [
  {
    id: 'header-standalone-unknown-type',
    reason:
      '包内/内置头独立编译时，`real`/`real2`/`real3`/`real4` 一类类型别名（定义在 `Common.hlsl`）不在场 → ' +
      '系统性误报（实测 148 条 / 5 文件：NormalSurfaceGradient、PerPixelDisplacement、Tessellation 等）。' +
      '不豁免用户文件：用户写错类型名正是要报的错。',
    pattern: /^unknown type name 'N'$/,
    filePattern: ENGINE_HEADER,
  },
  {
    id: 'header-standalone-undeclared-identifier',
    reason:
      '同上根因：符号由前置 include 提供（实测 109 条 / 4 文件，如 BC6H.hlsl 的 `Swap`）。' +
      '不豁免用户文件：`use of undeclared identifier` 是类型诊断里价值最高的一条。',
    pattern: /^use of undeclared identifier 'N'$/,
    filePattern: ENGINE_HEADER,
  },
  {
    id: 'header-cascade-missing-type-specifier',
    reason:
      '`header-standalone-unknown-type` 的级联：未知类型名被 clang 解析成「隐式 int + 函数声明」形态，' +
      '于是报「需要类型说明符」（实测 14 条 / 2 文件：SampleUVMapping*Internal.hlsl）。',
    pattern: /^HLSL requires a type specifier for all declarations$/,
    filePattern: ENGINE_HEADER,
  },
  {
    id: 'header-cascade-function-in-parameters',
    reason:
      '同一级联的第二层：`real3 f(real2 a, real3 b)` 里参数被当成函数声明（实测 7 条 / 2 文件，' +
      '与 `header-cascade-missing-type-specifier` 同两处文件）。',
    pattern: /^function declaration is not allowed in function parameters$/,
    filePattern: ENGINE_HEADER,
  },
  {
    id: 'header-cascade-return-function-type',
    reason:
      '同一级联的第三层：返回类型被解析成函数类型（实测 5 条 / 2 文件，消息里的函数类型全是级联产物）。',
    pattern: /^function cannot return function type 'N'$/,
    filePattern: ENGINE_HEADER,
  },
  {
    id: 'header-macro-hash-parameter',
    reason:
      '内置 API 头（GLCore/GLES2/GLES3.hlsl）里的 `#` 用法 hlscc 接受、DXC 前端拒绝' +
      '（实测 3 条 / 3 文件）。不修：那是 Unity 自己的头，改不了；用户文件出现同样写法属真错误，照常报。',
    pattern: /^'N' is not followed by a macro parameter$/,
    filePattern: ENGINE_HEADER,
  },
  {
    id: 'header-shader-architecture-error',
    reason:
      'Unity 头里的 `#error unknown shader architecture` 守卫在独立编译时命中' +
      '（实测 4 条 / 2 文件：GraniteShaderLibBase.hlsl、VirtualTexturing.hlsl）。' +
      '一条规则覆盖两种拼写：Unity 源码里本身就有一处拼错的 `unknow shader archtecture`。',
    pattern: /^(unknow|unknown) shader arch(tecture|itecture)$/,
    filePattern: ENGINE_HEADER,
  },
  {
    id: 'header-api-guard-error-directive',
    reason:
      'API 头的 `#error` 守卫（`GLES.hlsl should not be included if SHADER_API_* is not defined`）：' +
      '独立编译该 API 头时，我们注入的是 D3D11 宏集，守卫必然命中（实测 3 条 / 3 文件）。' +
      '一条正则覆盖 GLCORE/GLES/GLES3 三种变体。',
    pattern: /^GLES\.hlsl should not be included if SHADER_API_[A-Z0-9_]+ is not defined$/,
    filePattern: ENGINE_HEADER,
  },
  {
    id: 'header-preproc-split-expression',
    reason:
      'ADR 0007 同源：`#if` 拆断表达式后独立编译报 `expected )`（实测 1 条 / 1 文件：PerPixelDisplacement.hlsl）。' +
      '收窄到引擎头：用户文件里的括号不匹配是最典型的真语法错，绝不能被这条吞掉。',
    pattern: /^expected 'N'$/,
    filePattern: ENGINE_HEADER,
  },
];

export class DxcExemptionTable {
  private hits = new Map<string, number>();

  constructor(private readonly rules: DxcExemptionRule[] = DEFAULT_DXC_EXEMPTIONS) {}

  get ruleCount(): number {
    return this.rules.length;
  }

  /** 命中即返回规则并计数；未命中返回 null */
  match(ctx: DxcMatchContext): DxcExemptionRule | null {
    for (const r of this.rules) {
      if (ruleMatches(r, ctx)) {
        this.hits.set(r.id, (this.hits.get(r.id) ?? 0) + 1);
        return r;
      }
    }
    return null;
  }

  /** 只判定不计数（门槛脚本逐签名统计时用，避免重复计数污染命中表） */
  matches(ctx: DxcMatchContext): boolean {
    return this.rules.some((r) => ruleMatches(r, ctx));
  }

  get hitsById(): ReadonlyMap<string, number> {
    return this.hits;
  }

  resetHits(): void {
    this.hits.clear();
  }

  /** 日志片段：`exempted=id:3,id2:1`（无命中返回空串，与 errorExemption 同口径） */
  hitSummary(): string {
    const parts: string[] = [];
    for (const [id, n] of this.hits) parts.push(`${id}:${n}`);
    return parts.length ? `exempted=${parts.join(',')}` : '';
  }
}
