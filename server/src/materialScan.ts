/** 材质证据扫描（规格 feature-shader-name-index-and-variant-report 范围 7/8，T-071）
 *
 * 只读：解析 `.mat` 的 YAML 文本与 `.shader.meta` 的 guid，**不写任何 Unity 文件**。
 * 实测口径（log 2026-10-29 09:10）：
 * - `.mat` 里 `m_Shader: {fileID: 4800000, guid: <g>, fileID: 0}`；guid → 文件靠同名 `.shader.meta` 的 `guid:`
 *   （`BumpedDiffuse.mat` 的 `ed945eecd1c2d494da666dde472e017d` 与 `BumpedDiffuse.shader.meta` 完全匹配）。
 * - 本机 43 个 `.mat` 里带非空 `m_ShaderKeywords` 的有 **0 个** → 关键字证据为空，
 *   规格异常表据此要求 `material-evidence=none` 且**不出删除建议**。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ShaderVariantEntry } from './variantReport';

export interface MaterialRecord {
  file: string;
  /** `m_Shader` 引用的 guid；解析不到 → null */
  shaderGuid: string | null;
  /** guid 解析到的 `.shader` 文件；无匹配 → null（该材质证据被丢弃，记 `mat-unmapped=`） */
  shaderFile: string | null;
  /** `m_ShaderKeywords` 切分后的关键字（缺失/空 → 空数组 = 默认变体在用） */
  keywords: string[];
}

export interface MaterialScan {
  materials: MaterialRecord[];
  /** guid 命中 `.shader.meta` 的材质数（日志 `mat-mapped=`） */
  mapped: number;
  /** guid 找不到对应 `.shader.meta` 的材质数（日志 `mat-unmapped=`） */
  unmapped: number;
  /** 全部材质实际启用的关键字集合 */
  keywordsInUse: Set<string>;
  /** 按 shader 文件收窄的关键字集合（guid 映射成功时才有） */
  keywordsByShader: Map<string, Set<string>>;
  /** 至少一个材质没有关键字 → 默认（全 off）变体确实在用 */
  defaultVariantInUse: boolean;
  /** 关键字证据是否存在：为空 → `none`，此时**不得**产出删除建议（规格范围 8） */
  evidence: 'present' | 'none';
}

const GUID_IN_SHADER_REF = /m_Shader:\s*\{[^\r\n}]*guid:\s*([0-9a-f]{32})/i;
// 只吃水平空白：`\s*` 会跨过换行，把下一行的 `m_CustomRenderQueue: -1` 当成关键字（单测抓到）
const SHADER_KEYWORDS = /^[ \t]*m_ShaderKeywords:[ \t]*(.*)$/m;
const META_GUID = /^[ \t]*guid:[ \t]*([0-9a-f]{32})/im;

/** 解析一个 `.mat` 的文本（不读盘）。 */
export function parseMaterial(text: string, file: string): MaterialRecord {
  const guid = GUID_IN_SHADER_REF.exec(text)?.[1] ?? null;
  const raw = SHADER_KEYWORDS.exec(text)?.[1] ?? '';
  const keywords = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '[]');
  return { file, shaderGuid: guid, shaderFile: null, keywords };
}

/** 解析 `.shader.meta`（或任何 Unity meta）里的 guid。 */
export function parseMetaGuid(text: string): string | null {
  return META_GUID.exec(text)?.[1] ?? null;
}

/**
 * 扫描材质证据。
 *
 * @param materials  `.mat` 文件（`{file, text}`，读盘由调用方负责）
 * @param metas      `.shader.meta` 文件，用于建 guid → shader 路径映射
 */
export function scanMaterials(
  materials: Array<{ file: string; text: string }>,
  metas: Array<{ file: string; text: string }>
): MaterialScan {
  const guidToShader = new Map<string, string>();
  for (const m of metas) {
    const g = parseMetaGuid(m.text);
    if (!g) continue;
    // `.shader.meta` → 去掉尾部的 `.meta`
    const shaderFile = m.file.replace(/\.meta$/i, '');
    if (!guidToShader.has(g)) guidToShader.set(g, shaderFile);
  }

  const records: MaterialRecord[] = [];
  const keywordsInUse = new Set<string>();
  const keywordsByShader = new Map<string, Set<string>>();
  let mapped = 0;
  let unmapped = 0;
  let defaultVariantInUse = false;

  for (const m of materials) {
    const rec = parseMaterial(m.text, m.file);
    if (rec.keywords.length === 0) defaultVariantInUse = true;
    if (rec.shaderGuid) {
      const shaderFile = guidToShader.get(rec.shaderGuid);
      if (shaderFile) {
        rec.shaderFile = shaderFile;
        mapped++;
        let set = keywordsByShader.get(shaderFile);
        if (!set) {
          set = new Set<string>();
          keywordsByShader.set(shaderFile, set);
        }
        for (const k of rec.keywords) {
          keywordsInUse.add(k);
          set.add(k);
        }
      } else {
        unmapped++; // 丢弃该材质证据（规格异常表）
      }
    } else {
      unmapped++;
    }
    records.push(rec);
  }

  return {
    materials: records,
    mapped,
    unmapped,
    keywordsInUse,
    keywordsByShader,
    defaultVariantInUse,
    // 关键字证据为空 → 没有任何「材质实际用了哪些关键字」的依据，建议一律不出
    evidence: keywordsInUse.size > 0 ? 'present' : 'none',
  };
}

export interface StripSuggestion {
  /** 报告里的 shader 名（独立 HLSL 为 null） */
  shader: string | null;
  file: string;
  line: number;
  directive: string;
  /** 没有任何材质用到的关键字 */
  unusedKeywords: string[];
}

/** 可裁剪建议（规格范围 8 的门槛）：
 *  只有「显式组 × 无任何材质使用 × 非内置组」才进建议；
 *  无关键字证据（`evidence='none'`）时**只列组合、不出删除建议**。 */
export function suggestStripping(
  entries: ShaderVariantEntry[],
  scan: MaterialScan
): { suggestions: StripSuggestion[]; materialEvidence: 'present' | 'none' } {
  const suggestions: StripSuggestion[] = [];
  if (scan.evidence === 'none') return { suggestions, materialEvidence: 'none' };

  for (const e of entries) {
    // 内置组不参与（它们的关键字空间不可读，规格范围 6）
    for (const g of e.groups) {
      const inUse = scan.keywordsByShader.get(e.file);
      const unused = g.keywords.filter((k) => !(inUse?.has(k) ?? scan.keywordsInUse.has(k)));
      if (unused.length === 0) continue;
      suggestions.push({
        shader: e.shaderName,
        file: e.file,
        line: g.line,
        directive: g.directive,
        unusedKeywords: unused,
      });
    }
  }
  return { suggestions, materialEvidence: scan.evidence };
}

/** 只读遍历工程，取 `.mat` 与 `.shader.meta`（guid 映射的另一半）。
 *  不写任何文件；`limit` 与索引侧 `listFiles` 同口径，防止超大工程扫穿。 */
export function collectMaterialSources(
  projectRoot: string,
  limit = 4000
): { materials: Array<{ file: string; text: string }>; metas: Array<{ file: string; text: string }> } {
  const materials: Array<{ file: string; text: string }> = [];
  const metas: Array<{ file: string; text: string }> = [];
  const stack = [path.join(projectRoot, 'Assets')];
  let seen = 0;
  while (stack.length && seen < limit) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (seen >= limit) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'Temp' || e.name === 'obj' || e.name === '.git') continue;
        stack.push(full);
      } else if (/\.mat$/i.test(e.name)) {
        seen++;
        try {
          materials.push({ file: full, text: fs.readFileSync(full, 'utf8') });
        } catch {
          /* 读不到的材质直接跳过 */
        }
      } else if (/\.shader\.meta$/i.test(e.name)) {
        seen++;
        try {
          metas.push({ file: full, text: fs.readFileSync(full, 'utf8') });
        } catch {
          /* 同上 */
        }
      }
    }
  }
  return { materials, metas };
}

/** 材质证据摘要行（Output 通道口径）。 */
export function materialScanLine(scan: MaterialScan): string {
  const parts = [
    '[materials]',
    `mat-mapped=${scan.mapped}`,
    `mat-unmapped=${scan.unmapped}`,
    `keywords-in-use=${scan.keywordsInUse.size}`,
    `material-evidence=${scan.evidence}`,
  ];
  if (scan.defaultVariantInUse) parts.push('default-variant-in-use');
  return parts.join(' ');
}
