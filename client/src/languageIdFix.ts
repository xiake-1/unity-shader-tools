/**
 * T-074：语言 id 共存的判定纯函数（规格 feature-language-id-coexistence 范围 5/6/8；ADR 0006 第 2/3 层）。
 *
 * 刻意**不 import vscode**：输入是普通对象（关联表、已注册 id 集合、文档描述），
 * 输出是判定与改写计划 —— vitest 直接喂假数据钉语义，接线层（extension.ts）只做搬运。
 *
 * 背景：用户/其它扩展（VSTU）在 `files.associations` 里把我们的扩展名指向**未注册**的
 * 语言 id（如 `UnityShader`）时，VS Code 回落 plaintext，我们的语义功能全灭。
 * 第 2 层＝运行时 `setTextDocumentLanguage` 自愈（不改用户设置）；
 * 第 3 层＝`unityshader.fixFileAssociations` 命令把关联条目改写到我们的 id（用户确认）。
 */

/** 我们的扩展名 → 目标语言 id（与 `client/package.json` 的 `contributes.languages` 一致） */
export const OUR_TARGETS: ReadonlyMap<string, string> = new Map([
  ['.shader', 'unityshader'],
  ['.hlsl', 'hlsl'],
  ['.hlslinc', 'hlsl'],
  ['.cginc', 'hlsl'],
]);

export type AssocScope = 'workspace' | 'user';

/** 一条 `files.associations` 条目 + 它来自哪一级（同名 glob：工作区压用户，VS Code 生效口径） */
export interface AssocEntry {
  glob: string;
  id: string;
  scope: AssocScope;
}

/** 文件名（或路径）→ 我们的目标语言 id；不是我们的扩展名 → undefined */
export function targetIdFor(fileName: string): string | undefined {
  const lower = fileName.toLowerCase();
  for (const [ext, id] of OUR_TARGETS) {
    if (lower.endsWith(ext)) return id;
  }
  return undefined;
}

/** `{a,b}` 展开成多个 glob（一层，够用；`*.{shader,cg}` → `*.shader` + `*.cg`） */
function globAlternatives(glob: string): string[] {
  const m = /^([^{}]*)\{([^{}]*)\}([^{}]*)$/.exec(glob);
  if (!m) return [glob];
  const [, pre, alts, post] = m;
  return alts.split(',').map((a) => pre + a + post);
}

/** 混合 glob（含 `{}`）：自愈可以据它切文档，但命令**不改写**（拆 glob 会牵连别的扩展名） */
export function isMixedGlob(glob: string): boolean {
  return glob.includes('{');
}

function globToRe(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '(?:.*/)?';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

/** glob 是否命中该文件（basename 与全路径都试：`*.shader` 与双星前缀写法都能命中） */
export function globMatchesFile(glob: string, fileName: string): boolean {
  const full = fileName.replace(/\\/g, '/');
  const base = full.split('/').pop() ?? full;
  return globAlternatives(glob).some((g) => {
    const re = globToRe(g);
    return re.test(base) || re.test(full);
  });
}

/** glob（任一展开分支）是否指向我们的扩展名 */
export function globTouchesOurs(glob: string): boolean {
  for (const ext of OUR_TARGETS.keys()) {
    if (globMatchesFile(glob, `probe${ext}`)) return true;
  }
  return false;
}

/** 两级关联合并成条目表：同名 glob 只留工作区那条（生效值口径，规格范围 8） */
export function mergeAssociationEntries(
  workspaceValue: Record<string, string> | undefined,
  globalValue: Record<string, string> | undefined
): AssocEntry[] {
  const out: AssocEntry[] = [];
  const seen = new Set<string>();
  for (const [glob, id] of Object.entries(workspaceValue ?? {})) {
    if (typeof id !== 'string') continue;
    out.push({ glob, id, scope: 'workspace' });
    seen.add(glob);
  }
  for (const [glob, id] of Object.entries(globalValue ?? {})) {
    if (typeof id !== 'string' || seen.has(glob)) continue;
    out.push({ glob, id, scope: 'user' });
  }
  return out;
}

/** 「无效」关联：glob 指向我们的扩展名 && 目标 id 未注册（大小写敏感：`unityshader` ≠ `UnityShader`） */
export function invalidAssociationEntries(
  entries: readonly AssocEntry[],
  registered: ReadonlySet<string>
): AssocEntry[] {
  return entries.filter((e) => globTouchesOurs(e.glob) && !registered.has(e.id));
}

/**
 * 自愈三条件（规格范围 5，缺一不自愈）：
 * ① 文件扩展名是我们的；② 文档当前是 plaintext；③ 存在命中该文件名的无效关联。
 * 已是 `UnityShader`（VSTU 正常提供）或用户手动选的 plaintext（无无效关联）都不动。
 */
export function shouldSelfHeal(
  doc: { fileName: string; languageId: string },
  invalid: readonly AssocEntry[]
): boolean {
  if (!targetIdFor(doc.fileName)) return false;
  if (doc.languageId !== 'plaintext') return false;
  return invalid.some((e) => globMatchesFile(e.glob, doc.fileName));
}

export interface RewritePlan {
  rewrite: { glob: string; scope: AssocScope; fromId: string; toId: string }[];
  /** 混合 glob（只报告不改写）；接线层记 `skipped=mixed-glob` */
  skippedMixed: string[];
}

/** 命令的改写计划：无效条目里，混合 glob 跳过；其余按 glob 的扩展名映射到我们的 id */
export function planAssociationRewrite(
  entries: readonly AssocEntry[],
  registered: ReadonlySet<string>
): RewritePlan {
  const rewrite: RewritePlan['rewrite'] = [];
  const skippedMixed: string[] = [];
  for (const e of invalidAssociationEntries(entries, registered)) {
    if (isMixedGlob(e.glob)) {
      skippedMixed.push(e.glob);
      continue;
    }
    const ext = [...OUR_TARGETS.keys()].find((x) => e.glob.toLowerCase().endsWith(x));
    if (!ext) continue;
    const toId = OUR_TARGETS.get(ext)!;
    if (e.id === toId) continue; // 已经是目标 id（不该进无效集，防御一下）
    rewrite.push({ glob: e.glob, scope: e.scope, fromId: e.id, toId });
  }
  return { rewrite, skippedMixed };
}

/** 条目级写回：只改命中条目，其余键原样保留（规格约束「不整对象覆盖」） */
export function mergeAssociations(
  current: Record<string, string> | undefined,
  plan: Pick<RewritePlan, 'rewrite'>
): Record<string, string> {
  const out: Record<string, string> = { ...(current ?? {}) };
  for (const r of plan.rewrite) out[r.glob] = r.toId;
  return out;
}

/** 确认对话框的选项：无工作区文件夹时只给 User（规格异常表） */
export function commandTargets(hasWorkspaceFolder: boolean): AssocScope[] {
  return hasWorkspaceFolder ? ['workspace', 'user'] : ['user'];
}
