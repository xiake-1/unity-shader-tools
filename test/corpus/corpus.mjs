/** 语料收集的唯一实现（T-057 起被三处共用：`gate:diagnostics`、`audit:errors`、`gate:type-diagnostics`）。
 *
 * 规格 feature-type-diagnostics 范围 13 明确要求门槛脚本**复用同一 `collectCorpus`**
 * （「不造第三套」），所以这里把它从 `diagnosticsGate.mjs` / `errorAudit.mjs` 里抽出来。
 * 三源语料 = 工程 `Assets` + `Library/PackageCache/com.unity.render-pipelines.<pkg>/ShaderLibrary`
 * + 内置 `Data/CGIncludes`（roadmap M4/M5 的「50 工程 / 80+ 包内 / 56 内置」口径）。
 * 定位方式沿用 bench 的环境变量约定：`BENCH_PROJECT` / `BENCH_EDITOR`。
 */
import fs from 'node:fs';
import path from 'node:path';

export const PROJECT = process.env.BENCH_PROJECT ?? 'D:/Work/Unity/ShaderStudy';
export const EDITOR = process.env.BENCH_EDITOR ?? 'D:/Soft/Work/Unity/UnityEditor/2022.3.62f3c1/Editor';

export const SHADER_EXT = /\.(shader|hlsl|hlslinc|cginc)$/i;

export function listFiles(dir, limit = 5000) {
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < limit) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'Temp' || e.name === 'obj' || e.name === '.git') continue;
        stack.push(full);
      } else if (SHADER_EXT.test(e.name)) out.push(full);
    }
  }
  return out;
}

/** 三源语料，按源分组（逐源统计用）。 */
export function collectCorpus() {
  const groups = { project: [], packageCache: [], cgIncludes: [] };
  if (fs.existsSync(PROJECT)) {
    groups.project.push(...listFiles(path.join(PROJECT, 'Assets')));
    const pc = path.join(PROJECT, 'Library', 'PackageCache');
    if (fs.existsSync(pc)) {
      for (const e of fs.readdirSync(pc)) {
        if (!/^com\.unity\.render-pipelines\./i.test(e)) continue;
        const lib = path.join(pc, e, 'ShaderLibrary');
        if (fs.existsSync(lib)) groups.packageCache.push(...listFiles(lib));
      }
    }
  }
  const cginc = path.join(EDITOR, 'Data', 'CGIncludes');
  if (fs.existsSync(cginc)) {
    for (const e of fs.readdirSync(cginc)) if (SHADER_EXT.test(e)) groups.cgIncludes.push(path.join(cginc, e));
  }
  return groups;
}

/** 内置 CGIncludes 目录（include 根用；不存在返回 null）。 */
export function cgIncludesDir() {
  const d = path.join(EDITOR, 'Data', 'CGIncludes');
  return fs.existsSync(d) ? d : null;
}
