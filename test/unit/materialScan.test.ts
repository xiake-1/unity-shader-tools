/**
 * T-071 材质证据扫描（规格 feature-shader-name-index-and-variant-report 范围 7/8 的验收）。
 *
 * 夹具形态取自本机实测（log 2026-10-29 09:10）：`.mat` 里
 * `m_Shader: {fileID: 4800000, guid: ed945eecd1c2d494da666dde472e017d, fileID: 0}`
 * 与同名 `.shader.meta` 的 `guid:` 完全匹配；43 个 `.mat` 里带非空 `m_ShaderKeywords` 的有 0 个。
 */
import { describe, it, expect } from 'vitest';
import {
  materialScanLine,
  parseMaterial,
  parseMetaGuid,
  scanMaterials,
  suggestStripping,
} from '../../server/src/materialScan';
import type { ShaderVariantEntry } from '../../server/src/variantReport';

const GUID = 'ed945eecd1c2d494da666dde472e017d';
const OTHER_GUID = '11111111111111111111111111111111';

const mat = (guid: string, keywords = ''): string =>
  [
    '%YAML 1.1',
    '%TAG !u! tag:unity3d.com,2011:',
    '--- !u!21 &2100000',
    'Material:',
    '  serializedVersion: 6',
    '  m_Name: BumpedDiffuse',
    '  m_Shader: {fileID: 4800000, guid: ' + guid + ', fileID: 0}',
    '  m_ShaderKeywords: ' + keywords,
    '  m_CustomRenderQueue: -1',
    '',
  ].join('\n');

const meta = (guid: string): string => ['fileFormatVersion: 2', 'guid: ' + guid, 'ShaderImporter:'].join('\n') + '\n';

function entryOf(file: string, groups: Array<{ line: number; directive: string; keywords: string[] }>): ShaderVariantEntry {
  return {
    file,
    shaderName: 'Demo/X',
    start: { row: 0, column: 0 },
    passCount: 1,
    groups: groups.map((g) => ({
      directive: g.directive as ShaderVariantEntry['groups'][number]['directive'],
      keywords: g.keywords,
      offMarker: false,
      dedup: 0,
      size: g.keywords.length + 1,
      line: g.line,
    })),
    builtin: [{ name: 'fwdbase', count: 1, firstLine: 9 }],
    combinations: groups.reduce((n, g) => n * (g.keywords.length + 1), 1),
    dedupTotal: 0,
    pragmaSource: 'cst',
  };
}

describe('T-071 `.mat` 与 `.shader.meta` 解析', () => {
  it('`m_Shader` 的 guid 与 `m_ShaderKeywords` 都能取到', () => {
    const r = parseMaterial(mat(GUID, 'A B _EMISSION'), 'Assets/M/BumpedDiffuse.mat');
    expect(r.shaderGuid).toBe(GUID);
    expect(r.keywords).toEqual(['A', 'B', '_EMISSION']);
  });

  it('`m_ShaderKeywords` 缺失或空 → 空数组（默认变体在用）', () => {
    expect(parseMaterial(mat(GUID), 'a.mat').keywords).toEqual([]);
    expect(parseMaterial(mat(GUID, '   '), 'a.mat').keywords).toEqual([]);
    const noKeywords = mat(GUID).replace(/^  m_ShaderKeywords:.*$/m, '');
    expect(parseMaterial(noKeywords, 'a.mat').keywords).toEqual([]);
  });

  it('`.shader.meta` 的 guid 解析', () => {
    expect(parseMetaGuid(meta(GUID))).toBe(GUID);
    expect(parseMetaGuid('fileFormatVersion: 2\n')).toBeNull();
  });
});

describe('T-071 guid → 文件映射与计数', () => {
  it('guid 命中 `.shader.meta` → `mat-mapped=1`，关键字按 shader 文件收窄', () => {
    const scan = scanMaterials(
      [{ file: 'Assets/M/BumpedDiffuse.mat', text: mat(GUID, 'A B') }],
      [{ file: 'Assets/Shaders/BumpedDiffuse.shader.meta', text: meta(GUID) }]
    );
    expect(scan.mapped).toBe(1);
    expect(scan.unmapped).toBe(0);
    expect(scan.materials[0].shaderFile).toBe('Assets/Shaders/BumpedDiffuse.shader');
    expect([...scan.keywordsByShader.get('Assets/Shaders/BumpedDiffuse.shader')!]).toEqual(['A', 'B']);
    expect(materialScanLine(scan)).toContain('mat-mapped=1');
    expect(materialScanLine(scan)).toContain('material-evidence=present');
  });

  it('guid 找不到 `.shader.meta` → 丢弃该材质证据并记 `mat-unmapped=1`', () => {
    const scan = scanMaterials(
      [{ file: 'Assets/M/Ghost.mat', text: mat(OTHER_GUID, 'A B') }],
      [{ file: 'Assets/Shaders/BumpedDiffuse.shader.meta', text: meta(GUID) }]
    );
    expect(scan.unmapped).toBe(1);
    expect(scan.mapped).toBe(0);
    expect(scan.materials[0].shaderFile).toBeNull();
    // 被丢弃的材质的关键字不算证据
    expect(scan.keywordsInUse.size).toBe(0);
    expect(materialScanLine(scan)).toContain('mat-unmapped=1');
  });

  it('本机基线形态：材质有但关键字全空 → `material-evidence=none` + 默认变体在用', () => {
    const scan = scanMaterials(
      [
        { file: 'Assets/M/a.mat', text: mat(GUID) },
        { file: 'Assets/M/b.mat', text: mat(GUID) },
      ],
      [{ file: 'Assets/Shaders/BumpedDiffuse.shader.meta', text: meta(GUID) }]
    );
    expect(scan.mapped).toBe(2);
    expect(scan.defaultVariantInUse).toBe(true);
    expect(scan.evidence).toBe('none');
    expect(materialScanLine(scan)).toContain('material-evidence=none');
  });
});

describe('T-071 可裁剪建议的门槛（范围 8）', () => {
  it('无材质证据 → `material-evidence=none` 且**不产出任何删除建议**', () => {
    const scan = scanMaterials([{ file: 'Assets/M/a.mat', text: mat(GUID) }], [
      { file: 'Assets/Shaders/a.shader.meta', text: meta(GUID) },
    ]);
    const entries = [entryOf('Assets/Shaders/a.shader', [{ line: 7, directive: 'multi_compile', keywords: ['A', 'B'] }])];
    const out = suggestStripping(entries, scan);
    expect(out.materialEvidence).toBe('none');
    expect(out.suggestions).toEqual([]);
  });

  it('有证据时：只列「没有任何材质用过」的关键字，内置组不参与', () => {
    const scan = scanMaterials([{ file: 'Assets/M/a.mat', text: mat(GUID, 'A') }], [
      { file: 'Assets/Shaders/a.shader.meta', text: meta(GUID) },
    ]);
    const entries = [entryOf('Assets/Shaders/a.shader', [{ line: 7, directive: 'multi_compile', keywords: ['A', 'B', 'C'] }])];
    const out = suggestStripping(entries, scan);
    expect(out.materialEvidence).toBe('present');
    expect(out.suggestions.length).toBe(1);
    expect(out.suggestions[0].unusedKeywords).toEqual(['B', 'C']);
    expect(out.suggestions[0].shader).toBe('Demo/X');
    expect(out.suggestions[0].line).toBe(7);
  });

  it('全部关键字都有材质在用 → 零建议', () => {
    const scan = scanMaterials([{ file: 'Assets/M/a.mat', text: mat(GUID, 'A B') }], [
      { file: 'Assets/Shaders/a.shader.meta', text: meta(GUID) },
    ]);
    const entries = [entryOf('Assets/Shaders/a.shader', [{ line: 7, directive: 'shader_feature', keywords: ['A', 'B'] }])];
    expect(suggestStripping(entries, scan).suggestions).toEqual([]);
  });
});
