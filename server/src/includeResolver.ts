/** include 解析四类（规格范围 5、T-011）
 *  1) 相对当前文件；2) `Assets/…` → 工程根；3) `Packages/<pkg>/…` → Packages/ 或
 *  Library/PackageCache 下带版本后缀的包目录；4) 裸名（`UnityCG.cginc`）→ Editor/Data/CGIncludes。
 *  失败以结构化记录返回，供 M4「include 未找到」诊断消费；本模块不发诊断。
 */
import * as fs from 'fs';
import * as path from 'path';

export interface IncludeContext {
  projectRoot: string | null;
  cgIncludesDir: string | null;
  packageCacheDir: string | null;
}

export type IncludeFailureReason =
  | 'empty-spec'
  | 'no-search-root'
  | 'not-found';

export interface IncludeResult {
  spec: string;
  fromFile: string;
  resolved: string | null;
  /** 依次尝试过的候选路径（诊断与测试都要用） */
  tried: string[];
  failure?: { reason: IncludeFailureReason; spec: string; tried: string[] };
}

const exists = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

function packageCacheCandidates(packageCacheDir: string, pkg: string): string[] {
  try {
    return fs
      .readdirSync(packageCacheDir)
      .filter((e) => e === pkg || e.startsWith(`${pkg}@`))
      .map((e) => path.join(packageCacheDir, e));
  } catch {
    return [];
  }
}

/** 生成候选路径（按优先级），不触碰文件系统之外的状态 */
export function includeCandidates(
  spec: string,
  fromFile: string,
  ctx: IncludeContext
): string[] {
  const clean = spec.replace(/\\/g, '/').trim();
  if (!clean) return [];
  const out: string[] = [];

  // 1) 相对当前文件
  out.push(path.resolve(path.dirname(fromFile), clean));

  const root = ctx.projectRoot;
  const norm = clean.replace(/^\.?\//, '');

  // 2) Assets/… 前缀 → 工程根
  if (root && /^(Assets|Packages)\//i.test(norm)) {
    out.push(path.join(root, norm));
  }

  // 3) Packages/<pkg>/… → Packages/ 或 PackageCache/<pkg>@*/
  const pkgMatch = /^Packages\/([^/]+)\/(.*)$/i.exec(norm);
  if (pkgMatch && root) {
    const [, pkg, rest] = pkgMatch;
    out.push(path.join(root, 'Packages', pkg, rest));
    if (ctx.packageCacheDir) {
      for (const dir of packageCacheCandidates(ctx.packageCacheDir, pkg)) {
        out.push(path.join(dir, rest));
      }
    }
  }

  // 4) 裸名 → 内置 CGIncludes
  if (!clean.includes('/')) {
    if (ctx.cgIncludesDir) out.push(path.join(ctx.cgIncludesDir, clean));
  }

  // 常见写法：`#include "Assets/..."` 之外的工程内绝对前缀也试一次工程根
  if (root && norm.includes('/')) out.push(path.join(root, norm));

  return out;
}

export function resolveInclude(
  spec: string,
  fromFile: string,
  ctx: IncludeContext
): IncludeResult {
  const tried = includeCandidates(spec, fromFile, ctx);
  if (!spec.trim()) {
    return {
      spec,
      fromFile,
      resolved: null,
      tried,
      failure: { reason: 'empty-spec', spec, tried },
    };
  }
  for (const cand of tried) {
    if (exists(cand)) return { spec, fromFile, resolved: cand, tried };
  }
  const hasAnyRoot =
    !!ctx.projectRoot || !!ctx.cgIncludesDir || !!ctx.packageCacheDir;
  return {
    spec,
    fromFile,
    resolved: null,
    tried,
    failure: {
      reason: tried.length === 0 ? 'no-search-root' : hasAnyRoot ? 'not-found' : 'no-search-root',
      spec,
      tried,
    },
  };
}
