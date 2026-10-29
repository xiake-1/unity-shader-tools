/**
 * T-069 shader 名索引 + `Fallback`/`UsePass` 补全与跳转（规格 feature-shader-name-index-and-variant-report）。
 *
 * vitest 侧钉三件事：索引出 `kind='shader'` 且名字保留原文；补全只在开引号处给候选
 * （`Fallback Off` 零候选）；跳转落到 `shader_block` 起始且内置名走 `shader-def=unavailable`。
 * 真机集成（`Fallback "` 弹候选、F12 落地）在 `test/src/suite/shaderNames.test.js`。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SymbolIndex } from '../../server/out/symbolIndex.js';
import { DocumentStore } from '../../server/out/documentStore.js';
import { detectCompletionSite, provideCompletion, clearCompletionCache } from '../../server/out/completion.js';
import { provideDefinition } from '../../server/out/definition.js';
import type { CompletionContext } from '../../server/out/completion.js';
import type { DefinitionContext } from '../../server/out/definition.js';
import type { IncludeContext } from '../../server/out/includeResolver.js';

const TARGET = [
  'Shader "Legacy Shaders/Diffuse Two Words"', // 0 ← 名字含空格与 `/`
  '{',
  '  SubShader',
  '  {',
  '    Pass { Name "BASE" }',
  '  }',
  '}',
  '',
].join('\n');

const TARGET2 = [
  'Shader "Fixtures/Target"', //                   0
  '{',
  '  SubShader { Pass { Name "FORWARD" } }',
  '}',
  '',
].join('\n');

const CONSUMER = [
  'Shader "Fixtures/Consumer"', //                 0
  '{',
  '  SubShader',
  '  {',
  '    UsePass "Legacy Shaders/Diffuse Two Words"', // 4
  '    Pass { }',
  '  }',
  '  Fallback "Fixtures/Target"', //               8
  '}',
  '',
].join('\n');

const OFF_CASE = [
  'Shader "Fixtures/OffCase"', //                  0
  '{',
  '  SubShader { Pass { } }',
  '  Fallback Off', //                             3
  '}',
  '',
].join('\n');

const BUILTIN_REF = [
  'Shader "Fixtures/BuiltinRef"', //               0
  '{',
  '  SubShader',
  '  {',
  '    Pass { }',
  '    UsePass "Legacy Shaders/Diffuse"', //  5 ← 内置名，无源（`UsePass` 只在 SubShader 内合法）
  '  }',
  '}',
  '',
].join('\n');

let root: string;
let index: SymbolIndex;
let store: DocumentStore;
let includeCtx: IncludeContext;
let logs: string[];
let targetFile: string;
let target2File: string;
let consumerFile: string;
let offFile: string;
let builtinFile: string;

function write(rel: string, text: string): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

function baseCtx() {
  return {
    index,
    store,
    includeCtx,
    projectRoot: root,
    log: (m: string) => logs.push(m),
    indexing: () => false,
  };
}

function compCtx(): CompletionContext {
  return baseCtx();
}

function defCtx(): DefinitionContext {
  return baseCtx();
}

/** 光标列 = 该行 needle 起点 + offset */
function colOf(file: string, line: number, needle: string, offset: number): number {
  const text = fs.readFileSync(file, 'utf8').split('\n')[line];
  const idx = text.indexOf(needle);
  if (idx < 0) throw new Error(`第 ${line} 行找不到 "${needle}"`);
  return idx + offset;
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'm6a-shadernames-'));
  targetFile = write('Assets/Shaders/target.shader', TARGET);
  target2File = write('Assets/Shaders/target2.shader', TARGET2);
  consumerFile = write('Assets/Shaders/consumer.shader', CONSUMER);
  offFile = write('Assets/Shaders/off.shader', OFF_CASE);
  builtinFile = write('Assets/Shaders/builtin.shader', BUILTIN_REF);
  includeCtx = {
    projectRoot: root,
    cgIncludesDir: path.join(root, 'EditorFake', 'Data', 'CGIncludes'),
    packageCacheDir: path.join(root, 'Library', 'PackageCache'),
  };
  index = new SymbolIndex();
  store = new DocumentStore();
  for (const f of [targetFile, target2File, consumerFile, offFile, builtinFile]) {
    index.indexFile(f, fs.readFileSync(f, 'utf8'));
  }
  logs = [];
  clearCompletionCache();
});

afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('T-069 shader 名入索引', () => {
  it('两个 `shader_block` 分布在不同文件 → 各 1 条 `kind=shader`，名字保留原文（含空格与 `/`）', () => {
    const info = index.getByName('Legacy Shaders/Diffuse Two Words');
    expect(info?.kind).toBe('shader');
    expect(info?.locations.length).toBe(1);
    expect(index.getByName('Fixtures/Target')?.kind).toBe('shader');
    expect(index.getByName('Fixtures/Consumer')?.kind).toBe('shader');
  });

  it('索引统计带 shader 名计数（`showIndexStats` 的 `shaderNames=` 口径）', () => {
    expect(index.shaderNameCount).toBeGreaterThanOrEqual(5);
  });

  it('位置 = `shader_block` 的起始（不是引号里）', () => {
    const l = index.getByName('Legacy Shaders/Diffuse Two Words')!.locations[0];
    expect(l.start).toEqual({ row: 0, column: 0 });
    expect(path.resolve(l.file)).toBe(path.resolve(targetFile));
  });

  it('一个文件里多个 `shader_block` 全部入', () => {
    const multi = write('Assets/Shaders/multi.shader', TARGET + TARGET2);
    index.indexFile(multi, fs.readFileSync(multi, 'utf8'));
    expect(index.getByName('Legacy Shaders/Diffuse Two Words')!.locations.length).toBe(2);
    expect(index.getByName('Fixtures/Target')!.locations.length).toBe(2);
  });

  it('shader 名不进标识符候选（不污染 HLSL 补全）', () => {
    const list = provideCompletion(targetFile, 0, 0, compCtx());
    expect(list.items.some((i) => i.label === 'Fixtures/Target')).toBe(false);
  });
});

describe('T-069 `Fallback` / `UsePass` 补全', () => {
  it('`Fallback "` 处 → 上下文是 shaderName，候选含夹具 shader 名', () => {
    const line = 7;
    const col = colOf(consumerFile, line, 'Fallback "', 'Fallback "'.length);
    const site = detectCompletionSite(consumerFile, line, col, compCtx());
    expect(site.kind).toBe('shaderName');
    const list = provideCompletion(consumerFile, line, col, compCtx());
    const labels = list.items.map((i) => i.label);
    expect(labels).toContain('Fixtures/Target');
    expect(labels).toContain('Fixtures/Consumer');
  });

  it('前缀过滤：`Fallback "Fixtures/Targ` 只命中前缀匹配的名', () => {
    const line = 7;
    const col = colOf(consumerFile, line, 'Fallback "Fixtures/Targ', 'Fallback "Fixtures/Targ'.length);
    const list = provideCompletion(consumerFile, line, col, compCtx());
    const labels = list.items.map((i) => i.label);
    expect(labels).toContain('Fixtures/Target');
    expect(labels.some((l) => l.startsWith('Legacy'))).toBe(false);
  });

  it('`UsePass "` 处 → 候选含带空格与 `/` 的名', () => {
    const line = 4;
    const col = colOf(consumerFile, line, 'UsePass "', 'UsePass "'.length);
    const list = provideCompletion(consumerFile, line, col, compCtx());
    expect(list.items.map((i) => i.label)).toContain('Legacy Shaders/Diffuse Two Words');
  });

  it('`Fallback Off` → 零候选（未开引号不产候选）', () => {
    const line = 3;
    const col = colOf(offFile, line, 'Fallback Off', 'Fallback '.length);
    const site = detectCompletionSite(offFile, line, col, compCtx());
    expect(site.kind).toBe('none');
    expect(provideCompletion(offFile, line, col, compCtx()).items).toEqual([]);
  });
});

describe('T-069 跳转', () => {
  it('`UsePass "…"` 上 F12 → 落到该名的 `shader_block` 起始', () => {
    const line = 4;
    const col = colOf(consumerFile, line, 'Legacy Shaders/Diffuse Two Words', 12);
    const locs = provideDefinition(consumerFile, line, col, defCtx());
    expect(locs.length).toBeGreaterThanOrEqual(1);
    expect(locs.every((l) => l.range.start.line === 0 && l.range.start.character === 0)).toBe(true);
    expect(locs.some((l) => l.uri.replace(/\\/g, '/').endsWith('/target.shader'))).toBe(true);
  });

  it('`Fallback "…"` 上 F12 → 同样落到 `shader_block`', () => {
    const line = 7;
    const col = colOf(consumerFile, line, 'Fixtures/Target', 5);
    const locs = provideDefinition(consumerFile, line, col, defCtx());
    expect(locs.length).toBeGreaterThanOrEqual(1);
    // target2.shader 里的 `shader_block` 在第 0 行（multi.shader 里那份在文件中部，行号不同）
    expect(locs.some((l) => l.uri.replace(/\\/g, '/').endsWith('/target2.shader') && l.range.start.line === 0)).toBe(true);
  });

  it('内置名（无源）→ 零结果 + 日志 `shader-def=unavailable`', () => {
    logs = [];
    const line = 5;
    const col = colOf(builtinFile, line, 'Legacy Shaders/Diffuse', 12);
    const locs = provideDefinition(builtinFile, line, col, defCtx());
    expect(locs).toEqual([]);
    expect(logs.join('\n')).toContain('shader-def=unavailable');
  });

  it('同名多处（工程内多个文件）→ 全部返回', () => {
    const multi = write('Assets/Shaders/multi2.shader', TARGET);
    index.indexFile(multi, fs.readFileSync(multi, 'utf8'));
    const line = 4;
    const col = colOf(consumerFile, line, 'Legacy Shaders/Diffuse Two Words', 12);
    const locs = provideDefinition(consumerFile, line, col, defCtx());
    const uris = new Set(locs.map((l) => l.uri));
    expect(uris.size).toBeGreaterThanOrEqual(2);
    expect([...uris].some((u) => u.endsWith('/target.shader'))).toBe(true);
  });
});
