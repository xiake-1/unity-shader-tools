/** ERROR 模式豁免表（T-038，ADR 0009 第二层）
 *
 * 数据表 + 匹配器 + 命中计数。命中即**不产诊断**（宁可漏报不可误报）。
 * 每条必须带 `reason`（「不修 + 理由」）；门槛测试（`npm run gate:diagnostics`）断言
 * 每条豁免在真实语料上命中计数 > 0 —— grammar 修好后该行不再命中，测试失败提示删行。
 *
 * 模式来源：`npm run audit:errors`（test/corpus/errorAudit.mjs）对真实语料的逐模式聚合，
 * 以及 ADR 0007 登记的三类不可修模式。签名口径与审计脚本一致：
 * 父节点类型 + 子节点 token 序列 + 归一化形状 + MISSING 的 token 名。
 */
import type { SyntaxNode } from './parser';

/** 一个错误节点的匹配上下文（不依赖 vscode 类型，纯 CST 特征） */
export interface ExemptionContext {
  /** 节点本身（祖先链分类要用；不参与序列化） */
  node: SyntaxNode;
  /** 'ERROR' 或 MISSING 节点的 token 名（`;`、`}`、`::`…） */
  nodeType: string;
  isMissing: boolean;
  /** MISSING 的 token 名；ERROR 为 null */
  missingToken: string | null;
  parentType: string;
  grandparentType: string;
  /** 前 6 个子节点类型（ERROR 的 token 序列） */
  childTypes: string[];
  /** 父节点下所有兄弟（含自身）的类型：判「ERROR 夹在 `#ifdef`/`#endif` 之间」这类形态 */
  siblingTypes: string[];
  /** 兄弟里是否有以 `#` 开头的文本（被预处理器指令拆断的声明碎片） */
  siblingHasPreprocText: boolean;
  /** 节点原文（未归一化） */
  text: string;
  /** 归一化形状：标识符→ID、数字→N、字符串→S，空白折叠（与审计脚本同一函数） */
  shape: string;
  /** 文件路径（可选，用于文件特征；默认规则不用它） */
  file?: string;
}

export interface ExemptionRule {
  id: string;
  reason: string;
  match: (ctx: ExemptionContext) => boolean;
}

/** 与 test/corpus/errorAudit.mjs 共用（审计脚本直接 import 本函数，不造两套口径）。
 *  占位符用 `\u0001` 而不是裸 `S`：否则标识符正则会把插入的标记再替换一遍（`3.5`→`N`→`ID`）。 */
export function normalizeShape(text: string, limit = 90): string {
  let s = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/"[^"\n]*"|<[^\s<>\n]*>/g, '\u0001')
    .replace(/\b[A-Za-z_]\w*\b/g, 'ID')
    .replace(/\b0[xX][0-9a-fA-F]+\b|\b\d+(\.\d+)?\b/g, 'N')
    .replace(/\u0001/g, 'S')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > limit) s = s.slice(0, limit) + '…';
  return s;
}

export function contextOf(node: SyntaxNode, file?: string): ExemptionContext {
  const text = node.text;
  return {
    node,
    nodeType: node.type,
    isMissing: node.isMissing,
    missingToken: node.isMissing ? node.type : null,
    parentType: node.parent?.type ?? 'root',
    grandparentType: node.parent?.parent?.type ?? 'root',
    childTypes: node.children.slice(0, 6).map((c) => c.type),
    siblingTypes: node.parent ? node.parent.children.map((c) => c.type) : [node.type],
    siblingHasPreprocText: node.parent
      ? node.parent.children.some((c) => c.text.trimStart().startsWith('#'))
      : false,
    text,
    shape: normalizeShape(text),
    ...(file ? { file } : {}),
  };
}

const hasToken = (ctx: ExemptionContext, ...types: string[]): boolean =>
  ctx.childTypes.some((t) => types.includes(t));

const PREPROC_CONTAINERS = ['preproc_if', 'preproc_ifdef', 'preproc_ifndef', 'preproc_else', 'preproc_elif'];
const PREPROC_TOKENS = ['#if', '#ifdef', '#ifndef', '#endif', '#else', '#elif'];

/** 祖先链（不含自身）上的类型集合，深度默认 4 —— MISSING 节点的分类靠它 */
function ancestors(ctx: ExemptionContext, depth = 4): string[] {
  const out: string[] = [];
  let n: SyntaxNode | null = ctx.node;
  for (let i = 0; i < depth && n?.parent; i++) {
    n = n.parent;
    out.push(n.type);
  }
  return out;
}

const PREPROC_NODE_TYPES = ['preproc_if', 'preproc_ifdef', 'preproc_ifndef', 'preproc_else', 'preproc_elif', 'preproc_include', 'preproc_def', 'preproc_undef'];

/** 预处理器指令嵌在表达式/参数/实参里（SpeedTreeWind.cginc、AreaLighting.hlsl、
 *  UnityStandardShadow.cginc 等）：`float f, #ifdef X , float3 v #endif )`。
 *  C 预处理器先裁剪再解析，tree-sitter 不裁剪 → 必然 ERROR。
 *  两种形态都算：① ERROR 节点内部含指令 token；② ERROR 夹在同级的 `#ifdef`/`#endif` 之间
 *  （`out VertexOutputShadowCaster o,` 被 `#ifdef` 包着，指令不是它的子节点）。 */
const preprocDirectiveInExpression: ExemptionRule = {
  id: 'preproc-directive-in-expression',
  reason:
    '参数列表/实参列表/初始化列表/语句块里出现 `#ifdef`/`#endif`（SpeedTreeWind.cginc、AreaLighting.hlsl、' +
    'UnityStandardParticleShadow.cginc）。不修：需要先做预处理裁剪，属求值范畴（ADR 0008 明确不求值）。',
  match: (ctx) => {
    if (ctx.isMissing) return false;
    if (hasToken(ctx, ...PREPROC_TOKENS)) return true;
    return (
      ctx.siblingTypes.some((t) => PREPROC_TOKENS.includes(t) || PREPROC_NODE_TYPES.includes(t)) &&
      (ctx.parentType === 'parameter_list' ||
        ctx.parentType === 'parameter_declaration' ||
        ctx.parentType === 'argument_list' ||
        ctx.parentType === 'initializer_list' ||
        ctx.parentType === 'compound_statement' ||
        PREPROC_CONTAINERS.includes(ctx.parentType))
    );
  },
};

/** ADR 0007 ②：`#if`/`#ifdef` 块内带 primitive 参数的裸宏调用
 *  （`UNITY_DEFINE_INSTANCED_PROP(float, x)`）。不带参数的形态已由 grammar 补丁解决
 *  （macro_statement），带 primitive 参数的与 cpp 声明形态冲突面过大。 */
const bareMacroWithPrimitiveArgs: ExemptionRule = {
  id: 'bare-macro-with-primitive-args',
  reason:
    'ADR 0007 ②：带 primitive 参数的块作用域裸宏调用（UNITY_DEFINE_INSTANCED_PROP(float, x)）。' +
    '不修：与 cpp 顶层 declaration/function_declarator 冲突面过大（generate 直接失败）。',
  match: (ctx) =>
    !ctx.isMissing &&
    ctx.childTypes[0] === 'function_declarator' &&
    (PREPROC_CONTAINERS.includes(ctx.parentType) || ctx.parentType === 'translation_unit'),
};

/** ADR 0007 ①：花括号/圆括号在裁剪后才配对 → 出现「无主的收尾符」。 */
const strayCloser: ExemptionRule = {
  id: 'stray-closer-after-preproc',
  reason:
    'ADR 0007 ①：`#if` 块内外括号不平衡导致孤立 `}`/`)`（AutoLight.cginc、UnityStandardCore.cginc、AreaLighting.hlsl）。' +
    '不修：配对只在预处理裁剪后成立，文法侧要引入求值。',
  match: (ctx) => !ctx.isMissing && (ctx.childTypes[0] === '}' || ctx.childTypes[0] === ')'),
};

/** `#endif` 被文法判为缺失：同样是裁剪前才成立的配对。 */
const missingEndif: ExemptionRule = {
  id: 'missing-endif-after-preproc',
  reason:
    '文法在 `#ifdef`/函数体里插 `MISSING #endif`（SpeedTree8Common.cginc、UnityStandardParticleShadow.cginc）。' +
    '不修：与 ADR 0007 ① 同源，配对要预处理裁剪。',
  match: (ctx) => ctx.isMissing && ctx.missingToken === '#endif',
};

/** 资源类型尖括号里带修饰符：`RWTexture2D<GRA_UNORM gra_Float4>`、`DOTS_INSTANCING_START` 里的
 *  `::` 形态（GraniteShaderLibBase.hlsl、UnityDOTSInstancing.hlsl、PerPixelDisplacement.hlsl）。 */
const resourceTypeModifierInTemplate: ExemptionRule = {
  id: 'resource-type-modifier-in-template',
  reason:
    '资源类型/模板尖括号里带 snorm/unorm 之类修饰符（`RWTexture2D<GRA_UNORM gra_Float4>`），' +
    'cpp 模板文法在此插 `::` 类 MISSING。不修：HLSL 资源类型语法与 C++ 模板不同构。',
  match: (ctx) => {
    if (ctx.isMissing) {
      return ctx.missingToken === '::' || ctx.missingToken === ':' || ctx.parentType === 'qualified_identifier';
    }
    // 非 MISSING 形态：ERROR 落在模板实参上下文里（同一根因的另一面）
    return ancestors(ctx).some((t) => t === 'template_argument_list' || t === 'template_type' || t === 'qualified_identifier');
  },
};

/** 宏当函数体：`void ShaderDebugPrint(uint tag, bool value) PRINT1(...);`
 *  （ShaderDebugPrint.hlsl 79 处、TerrainSplatmapCommon.cginc）—— 声明后直接跟宏。 */
const macroAsFunctionBody: ExemptionRule = {
  id: 'macro-as-function-body',
  reason:
    '函数声明后直接跟宏调用当函数体（`void f(args) PRINT1(...)`，ShaderDebugPrint.hlsl）。' +
    '不修：合法但极罕见，为它放宽 function_definition 会吞掉真正的语法错误。',
  match: (ctx) => {
    if (!ctx.isMissing || ctx.missingToken !== ';') return false;
    const chain = ancestors(ctx);
    return chain.includes('function_declarator') || chain.includes('parameter_list');
  },
};

/** 声明头由 `#if`/`#define` 拼出（PerPixelDisplacement.hlsl 的 MERGE_NAME 形态），
 *  或声明落在嵌套 `#if` 里被上游级联打断（UnityShaderVariables.cginc、UnityInstancing.hlsl）。 */
const macroSplicedDeclarator: ExemptionRule = {
  id: 'macro-spliced-declarator',
  reason:
    '声明头由 `#if`/`#define` 拼出或被上游级联打断（PerPixelDisplacement.hlsl 的 MERGE_NAME、' +
    'UnityShaderVariables.cginc 的嵌套 `#if`）。不修：需要宏展开，属求值范畴。',
  match: (ctx) => {
    if (!ctx.isMissing || ctx.missingToken !== ';') return false;
    const chain = ancestors(ctx);
    return (
      PREPROC_CONTAINERS.some((t) => chain.includes(t)) ||
      (ctx.parentType === 'expression_statement' && ctx.grandparentType === 'translation_unit')
    );
  },
};

/** 上游参数列表被 `#if` 拆断后，**错误恢复**造出 `semantics`/`compound_literal_expression`
 *  假节点，其中插 `MISSING }`（UnityStandardCore.cginc 第 635 行那一处）。 */
const recoveryArtifactBrace: ExemptionRule = {
  id: 'recovery-artifact-brace',
  reason:
    '参数列表被 `#if` 拆断后，恢复过程造出 `semantics`/`compound_literal_expression` 假节点，其中插 `MISSING }`' +
    '（UnityStandardCore.cginc）。不修：那是恢复产物不是真实结构，为它改文法会掩盖真的未闭合括号。',
  match: (ctx) => {
    if (!ctx.isMissing || ctx.missingToken !== '}') return false;
    return ancestors(ctx).some((t) => t === 'semantics' || t === 'compound_literal_expression');
  },
};

/** 参数列表被预处理器指令拆断后的**碎片**（UnityStandardParticleShadow.cginc 的
 *  `out VertexOutputShadowCaster o,` 夹在 `#ifdef`/`#endif` 之间；UnityStandardCore.cginc 的
 *  `,out half4 outShadowMask : SV_Target4`）。判据刻意收窄，避免吞掉真实笔误：
 *  ① 兄弟里有 `#` 开头的文本（说明这里被指令切断），或
 *  ② 碎片以 HLSL 方向修饰符 `in`/`out`/`inout` 开头且祖先里有预处理器块。
 *  对照：`void f(float a b)`（真实笔误）既无 `#` 兄弟、也不以方向修饰符开头 → 照常报。 */
const preprocSplitParameter: ExemptionRule = {
  id: 'preproc-split-parameter',
  reason:
    '参数列表/声明被 `#ifdef`/`#endif` 拆断后的碎片（UnityStandardParticleShadow.cginc、UnityStandardCore.cginc）。' +
    '不修：拆分发生在预处理裁剪阶段，文法看到的是残缺序列。',
  match: (ctx) => {
    if (ctx.isMissing) return false;
    if (
      (ctx.parentType === 'parameter_list' || ctx.parentType === 'parameter_declaration') &&
      ctx.siblingHasPreprocText
    ) {
      return true;
    }
    const firstWord = ctx.text.trim().split(/\s+/, 1)[0];
    return (
      ['in', 'out', 'inout'].includes(firstWord) &&
      ancestors(ctx).some((t) => PREPROC_CONTAINERS.includes(t))
    );
  },
};

/** 默认豁免表（顺序即匹配顺序，先具体后宽泛）。
 *  **纪律**：每条必须在真实语料上有命中（`npm run gate:diagnostics` 断言命中计数 > 0），
 *  否则删行。ADR 0007 ③ 的 ShaderGraph `$` 占位符在本机语料里没有样本文件，
 *  因此**不建豁免行**（空转规则会被门槛测试拒绝）。 */
export const DEFAULT_EXEMPTIONS: ExemptionRule[] = [
  bareMacroWithPrimitiveArgs,
  preprocSplitParameter,
  preprocDirectiveInExpression,
  strayCloser,
  missingEndif,
  resourceTypeModifierInTemplate,
  macroAsFunctionBody,
  macroSplicedDeclarator,
  recoveryArtifactBrace,
];

export class ExemptionTable {
  private hits = new Map<string, number>();

  constructor(private readonly rules: ExemptionRule[] = DEFAULT_EXEMPTIONS) {}

  get ruleCount(): number {
    return this.rules.length;
  }

  /** 命中即返回规则并计数；未命中返回 null */
  match(ctx: ExemptionContext): ExemptionRule | null {
    for (const r of this.rules) {
      if (r.match(ctx)) {
        this.hits.set(r.id, (this.hits.get(r.id) ?? 0) + 1);
        return r;
      }
    }
    return null;
  }

  /** 只判定不计数（门槛脚本做逐模式签名时用它，避免重复计数污染命中表） */
  matches(ctx: ExemptionContext): boolean {
    return this.rules.some((r) => r.match(ctx));
  }

  get hitsById(): ReadonlyMap<string, number> {
    return this.hits;
  }

  resetHits(): void {
    this.hits.clear();
  }

  /** 日志片段：`exempted=id:3,id2:1`（无命中返回空串） */
  hitSummary(): string {
    const parts: string[] = [];
    for (const [id, n] of this.hits) parts.push(`${id}:${n}`);
    return parts.length ? `exempted=${parts.join(',')}` : '';
  }
}
