/** 语法诊断计算（T-037 / T-038 / T-039，规格 feature-syntax-diagnostics）
 *
 * 输入是**已有的解析树**（ADR 0001 唯一 CST：不新增解析路径），输出 LSP Diagnostic 与计数。
 * 三层误报控制里的第二层在这里生效：`ExemptionTable` 命中即不产（宁可漏报不可误报，ADR 0009）。
 * 发布与防抖属 server.ts（T-040），本模块纯计算、可单测。
 */
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';
import {
  collectErrorNodes,
  parseShaderLab,
  parseHlslFile,
  extractProgramBodies,
  buildVirtualHlsl,
  type Tree,
  type SyntaxNode,
} from './parser';
import { ExemptionTable, contextOf } from './errorExemption';
import { resolveInclude, type IncludeContext } from './includeResolver';

export const DEFAULT_MAX_DIAGNOSTICS_PER_FILE = 200;

export interface DiagnosticOptions {
  /** 文件路径（豁免表可按文件特征收窄；也用于日志） */
  file?: string;
  /** 单文件上限（`unityShader.maxDiagnosticsPerFile`，默认 200） */
  maxPerFile?: number;
  /** 豁免表；缺省用默认表（测试可注入空表以观察原始 ERROR） */
  exemptions?: ExemptionTable;
  /** include 解析上下文；null/缺省 = 降级态 → 不产 include 未找到诊断（规格约束） */
  includeCtx?: IncludeContext | null;
  /** 语法诊断开关（`unityShader.syntaxDiagnostics`） */
  syntaxDiagnostics?: boolean;
  /** include 未找到开关（`unityShader.includeDiagnostics`） */
  includeDiagnostics?: boolean;
}

export interface DiagnosticCounts {
  /** 产出的语法诊断条数 */
  syntax: number;
  /** 产出的 include 未找到 Warning 条数 */
  include: number;
  /** 被「只报最外层」抑制的级联错误节点数（日志 `nested=`） */
  nested: number;
  /** 豁免命中计数（日志 `exempted=<id>:<n>`） */
  exempted: Record<string, number>;
  /** 截断前的诊断总数；仅在发生截断时 > 0（日志 `truncated=<总数>`） */
  truncated: number;
  /** 降级态跳过 include 诊断的标记（日志 `degraded=skip-include-diag`） */
  degradedSkipInclude: boolean;
}

export interface FileDiagnostics {
  diagnostics: Diagnostic[];
  counts: DiagnosticCounts;
}

/** 一个文件参与诊断的树：`.shader` 有 ShaderLab 外壳树 + 虚拟 HLSL 树；`.hlsl` 只有后者。
 *  虚拟 HLSL 文档与原文等长，因此两棵树的行列都与文件坐标一致（parser.ts 的关键手法）。 */
export interface DiagnosticTree {
  kind: 'shaderlab' | 'hlsl';
  tree: Tree;
}

const HLSL_EXT = /\.(hlsl|hlslinc|cginc|compute|raytrace)$/i;

/** 按文件类型构造参与诊断的树（**唯一实现**：server 发布管线、门槛脚本、语料审计共用，
 *  避免「两套语料口径」（规格约束））。`.shader` 取外壳树 + 虚拟 HLSL 树；其余按 HLSL。 */
export function treesForFile(file: string, text: string): DiagnosticTree[] {
  if (HLSL_EXT.test(file)) {
    return [{ kind: 'hlsl', tree: parseHlslFile(text) }];
  }
  const lab = parseShaderLab(text);
  const bodies = extractProgramBodies(lab, text);
  const out: DiagnosticTree[] = [{ kind: 'shaderlab', tree: lab }];
  const virtual = buildVirtualHlsl(text, bodies);
  if (virtual.trim().length > 0) out.push({ kind: 'hlsl', tree: parseHlslFile(virtual) });
  return out;
}

/** ERROR 节点的文案后缀：优先用第一个子节点的类型（`#endif`、`}`、`declaration`…），
 *  没有子节点时退回 `block`。形态对齐对标产品 `syntax error - <节点>`（规格范围 2）。 */
function describeError(node: SyntaxNode): string {
  const first = node.children[0];
  if (!first) return 'block';
  return first.type;
}

function rangeOf(node: SyntaxNode): Diagnostic['range'] {
  if (node.isMissing) {
    // MISSING 的插入点：tree-sitter 已把它摆在正确坐标上，取零宽 Range（规格范围 2）
    const p = { line: node.startPosition.row, character: node.startPosition.column };
    return { start: p, end: p };
  }
  return {
    start: { line: node.startPosition.row, character: node.startPosition.column },
    end: { line: node.endPosition.row, character: node.endPosition.column },
  };
}

function messageOf(node: SyntaxNode): string {
  return node.isMissing ? `MISSING ${node.type}` : `syntax error - ${describeError(node)}`;
}

/** `#include` 的路径节点（Range 要落在路径字符串上，规格范围 3） */
function includePathNode(node: SyntaxNode): SyntaxNode | null {
  for (const c of node.children) {
    if (c.type === 'system_lib_string' || c.type === 'string_literal' || c.type === 'string') return c;
  }
  return null;
}

function collectIncludeNodes(root: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const visit = (n: SyntaxNode): void => {
    if (n.type === 'preproc_include') out.push(n);
    for (const c of n.children) visit(c);
  };
  visit(root);
  return out;
}

/** 从 `#include` 节点取原始 spec 文本（去掉引号/尖括号） */
function includeSpecOf(includeNode: SyntaxNode): string {
  const pathNode = includePathNode(includeNode);
  const raw = pathNode ? pathNode.text : '';
  return raw.replace(/^["<]|[">]$/g, '').trim();
}

/** 计算一个文件的语法诊断 + include 未找到 Warning（纯函数，除豁免表计数外无状态） */
export function computeFileDiagnostics(
  trees: DiagnosticTree[],
  opts: DiagnosticOptions = {}
): FileDiagnostics {
  const maxPerFile = opts.maxPerFile ?? DEFAULT_MAX_DIAGNOSTICS_PER_FILE;
  const exemptions = opts.exemptions ?? new ExemptionTable();
  const wantSyntax = opts.syntaxDiagnostics ?? true;
  const wantInclude = opts.includeDiagnostics ?? true;
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  let nested = 0;

  for (const { tree } of wantSyntax ? trees : []) {
    for (const { node, nested: inner } of collectErrorNodes(tree.rootNode, true)) {
      nested += inner;
      const rule = exemptions.match(contextOf(node, opts.file));
      if (rule) continue; // 豁免命中 → 不产诊断（ADR 0009）
      const range = rangeOf(node);
      const key = `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}-${node.type}-${messageOf(node)}`;
      if (seen.has(key)) continue; // 去重：同一节点重复发布不重复计入
      seen.add(key);
      diagnostics.push({ range, severity: DiagnosticSeverity.Error, message: messageOf(node), source: 'unity-shader' });
    }
  }

  // include 未找到（Warning）：只在有 include 上下文时产；降级态跳过（规格约束）
  let degradedSkipInclude = false;
  if (
    wantInclude &&
    opts.includeCtx &&
    (opts.includeCtx.projectRoot || opts.includeCtx.cgIncludesDir || opts.includeCtx.packageCacheDir)
  ) {
    for (const { kind, tree } of trees) {
      if (kind !== 'hlsl') continue; // #include 属 HLSL 侧；ShaderLab 外壳不产
      for (const node of collectIncludeNodes(tree.rootNode)) {
        const spec = includeSpecOf(node);
        const pathNode = includePathNode(node)!;
        const result = resolveInclude(spec, opts.file ?? '', opts.includeCtx);
        if (result.resolved) continue;
        const range = {
          start: { line: pathNode.startPosition.row, character: pathNode.startPosition.column },
          end: { line: pathNode.endPosition.row, character: pathNode.endPosition.column },
        };
        const key = `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}-include-${spec}`;
        if (seen.has(key)) continue;
        seen.add(key);
        diagnostics.push({
          range,
          severity: DiagnosticSeverity.Warning,
          message: `Include file '${spec}' not found`,
          source: 'unity-shader',
        });
      }
    }
  } else {
    // 只有「本该产 include 诊断但环境降级」才记 degraded 标记；用户关开关不算降级
    degradedSkipInclude = wantInclude && trees.some((t) => t.kind === 'hlsl');
  }

  // 文档顺序 + 截断（规格范围 2）
  diagnostics.sort((a, b) =>
    a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character
  );
  let truncated = 0;
  let out = diagnostics;
  if (diagnostics.length > maxPerFile) {
    truncated = diagnostics.length;
    out = diagnostics.slice(0, maxPerFile);
  }

  const exempted: Record<string, number> = {};
  for (const [id, n] of exemptions.hitsById) exempted[id] = n;

  const counts: DiagnosticCounts = {
    syntax: out.filter((d) => d.severity === DiagnosticSeverity.Error).length,
    include: out.filter((d) => d.severity === DiagnosticSeverity.Warning).length,
    nested,
    exempted,
    truncated,
    degradedSkipInclude,
  };
  return { diagnostics: out, counts };
}

/** 日志行（server.ts 的 `log()` 用；口径与规格一致：`nested=` / `exempted=` / `truncated=`） */
export function diagnosticLogLine(file: string, c: DiagnosticCounts): string {
  const parts = [`[diagnostics] ${file} errors=${c.syntax} include=${c.include}`];
  if (c.nested > 0) parts.push(`nested=${c.nested}`);
  const ex = Object.entries(c.exempted)
    .map(([id, n]) => `${id}:${n}`)
    .join(',');
  if (ex) parts.push(`exempted=${ex}`);
  if (c.truncated > 0) parts.push(`truncated=${c.truncated}`);
  if (c.degradedSkipInclude) parts.push('degraded=skip-include-diag');
  return parts.join(' ');
}
