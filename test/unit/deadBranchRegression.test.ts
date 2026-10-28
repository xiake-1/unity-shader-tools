/** T-048 回归：灰化只加装饰，**不改** F12 / Rename 对死分支内符号的处理
 *
 * 规格 feature-dead-branch-dimming「不在范围」：M2/M3 已定「不求值、全分支都算」（feature-rename §8），
 * 本功能只加装饰。这条用例把「同一份死分支语料上灰化生效、而语义行为不变」钉在一起。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SymbolIndex } from '../../server/out/symbolIndex.js';
import { DocumentStore } from '../../server/out/documentStore.js';
import { rename } from '../../server/out/rename.js';
import { provideDefinition, clearDefinitionCache } from '../../server/out/definition.js';
import { collectOccurrences } from '../../server/out/occurrences.js';
import { collectInactiveRegions } from '../../server/out/inactiveRegions.js';
import { computeFileDiagnostics } from '../../server/out/diagnostics.js';
import { parseHlslFile } from '../../server/out/parser.js';

let root: string;
let index: SymbolIndex;
let store: DocumentStore;

function write(rel: string, text: string): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
  index.indexFile(p, text);
  store.open(p, text);
  return p;
}

const SRC = [
  '#if SHADER_API_GLES30',
  'float4 _DeadSide;',
  '#endif',
  'float4 use() { return _DeadSide; }',
  '',
].join('\n');

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-deadreg-'));
  index = new SymbolIndex();
  store = new DocumentStore();
});

afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('死分支灰化与语义功能互不影响', () => {
  it('同一语料：灰化产 Range，而 occurrence / F12 / Rename 行为不变', () => {
    const file = write('Assets/deadreg.hlsl', SRC);
    const ctx = {
      index,
      store,
      includeCtx: { projectRoot: root, cgIncludesDir: null, packageCacheDir: null },
      projectRoot: root,
      log: () => {},
      indexing: () => false,
    };

    // ① 灰化侧：关键字在 Disabled 集合 → 分支体（第 1 行）应被灰
    const regions = collectInactiveRegions(parseHlslFile(SRC).rootNode, SRC, {
      disabled: new Set(['SHADER_API_GLES30']),
    });
    expect(regions.length).toBe(1);
    expect(regions[0].start.line).toBe(1);

    // ② occurrence 仍覆盖死分支内的声明与使用（不求值、全分支都算）
    const occ = collectOccurrences('_DeadSide', { index, store, log: () => {} }).occurrences;
    const lines = occ.filter((o) => o.file === file).map((o) => o.range.start.line).sort((a, b) => a - b);
    expect(lines).toEqual([1, 3]);

    // ③ F12 从使用处仍能跳到死分支内的声明
    clearDefinitionCache();
    const def = provideDefinition(file, 3, SRC.split('\n')[3].indexOf('_DeadSide') + 3, ctx);
    expect(def.length).toBeGreaterThan(0);
    expect(def[0].range.start.line).toBe(1);

    // ④ Rename 仍改到死分支内的那一处
    const we = rename(file, 3, SRC.split('\n')[3].indexOf('_DeadSide') + 3, '_RenamedSide', ctx);
    const changes = (we as { changes?: Record<string, Array<{ range: { start: { line: number } } }>> } | null)?.changes;
    const edits = Object.values(changes ?? {})
      .flat()
      .map((e) => e.range.start.line)
      .sort((a, b) => a - b);
    expect(edits).toEqual([1, 3]);
  });

  it('灰化不影响语法诊断集合：死分支里的真实笔误仍报', () => {
    // 用 `MISSING )` 形态：它不在豁免表里（豁免表只覆盖预处理器拼接触发的 `MISSING ;`/`}` 等）
    const text = [
      '#if SHADER_API_GLES30',
      '  float4 a = mul((float4)1, (float4)2;',
      '#endif',
      'float4 ok(){ return 0; }',
      '',
    ].join('\n');
    const regions = collectInactiveRegions(parseHlslFile(text).rootNode, text, {
      disabled: new Set(['SHADER_API_GLES30']),
    });
    expect(regions.length).toBe(1); // 该分支确实被灰
    const r = computeFileDiagnostics([{ kind: 'hlsl', tree: parseHlslFile(text) }], { file: 'x.hlsl' });
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toMatch(/^MISSING /);
    expect(r.diagnostics[0].range.start.line).toBe(1);
  });
});
