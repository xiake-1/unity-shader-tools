/** T-029 references 核心单测（规格 feature-rename）
 *
 * fixture：Properties/HLSL/宏参数合并逻辑符号、注释与字符串负例、跨文件与包内 rank、
 * 250→200 截断、Temp 过滤、成员引用（owner 过滤 + 浅推断 + unresolved）、stdio 能力声明。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SymbolIndex } from '../../server/out/symbolIndex.js';
import { DocumentStore } from '../../server/out/documentStore.js';
import { provideReferences } from '../../server/out/references.js';
import type { ReferenceContext } from '../../server/out/references.js';
import { LspClient, fileUri } from './lspClient.js';

let root: string;
let mainShader: string;
let bHlsl: string;
let pkgUses: string;
let index: SymbolIndex;
let store: DocumentStore;
let logs: string[];
let ctx: ReferenceContext;

const MAIN = [
  'Shader "Ref/Demo"', //                                              0
  '{', //                                                             1
  '  Properties { _MainTex("Tex", 2D) = "white" {} _Bump("B", 2D) = "white" {} }', // 2
  '  SubShader', //                                                   3
  '  {', //                                                           4
  '    Pass', //                                                      5
  '    {', //                                                         6
  '      Tags { "Queue"="Geometry" }', //                             7
  '      HLSLPROGRAM', //                                             8
  '      #include "b.hlsl"', //                                       9
  '      #include "uv"', //                                           10
  '      TEXTURE2D(_MainTex);', //                                    11
  '      SAMPLER(sampler_MainTex);', //                               12
  '      // _MainTex 在注释里', //                                    13
  '      struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };', // 14
  '      struct appdata { float2 uv : TEXCOORD0; };', //              15
  '      v2f i;', //                                                  16
  '      appdata a;', //                                              17
  '      float4 frag(v2f IN) : SV_Target', //                         18
  '      {', //                                                       19
  '        float2 q = i.uv;', //                                      20
  '        float2 r = a.uv;', //                                      21
  '        float2 s = unknownVar.uv;', //                             22
  '        return SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, IN.uv);', // 23
  '      }', //                                                       24
  '      ENDHLSL', //                                                 25
  '    }', //                                                         26
  '  }', //                                                           27
  '}', //                                                             28
  '',
].join('\n');

function write(rel: string, text: string): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

function colOf(file: string, line: number, needle: string, offset: number): number {
  const text = fs.readFileSync(file, 'utf8').split('\n')[line];
  const idx = text.indexOf(needle);
  if (idx < 0) throw new Error(`第 ${line} 行找不到 "${needle}"`);
  return idx + offset;
}

function refs(file: string, line: number, character: number, includeDeclaration = true) {
  return provideReferences(file, line, character, ctx, includeDeclaration);
}

/** Location[] → "basename:line" 集合 */
const keys = (locs: { uri: string; range: { start: { line: number } } }[]) =>
  locs.map((l) => {
    const f = decodeURIComponent(l.uri.split('/').pop()!);
    return `${f}:${l.range.start.line}`;
  });

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-refs-'));
  mainShader = write('Assets/main.shader', MAIN);
  bHlsl = write('Assets/b.hlsl', 'float4 sampleMain() { return _MainTex; }\n');
  pkgUses = write(
    'Library/PackageCache/com.unity.render-pipelines.core@14.0.12/ShaderLibrary/uses.hlsl',
    'float4 useIt() { return _MainTex; }\n'
  );
  write(
    'EditorFake/Data/CGIncludes/fill.cginc',
    Array.from({ length: 250 }, () => 'float FillSym;').join('\n') + '\n'
  );
  write('Assets/probe.hlsl', 'float useFill() { return FillSym; }\n');

  index = new SymbolIndex();
  store = new DocumentStore();
  logs = [];
  ctx = {
    index,
    store,
    includeCtx: {
      projectRoot: root,
      cgIncludesDir: path.join(root, 'EditorFake', 'Data', 'CGIncludes'),
      packageCacheDir: path.join(root, 'Library', 'PackageCache'),
    },
    projectRoot: root,
    log: (m) => logs.push(m),
    indexing: () => false,
  };
  for (const f of [mainShader, bHlsl, pkgUses, path.join(root, 'EditorFake/Data/CGIncludes/fill.cginc'), path.join(root, 'Assets/probe.hlsl')]) {
    index.indexFile(f, fs.readFileSync(f, 'utf8'));
  }
});

afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('T-029 references', () => {
  it('_MainTex：Properties 声明 + HLSL 声明 + 宏参数使用处 + 跨文件与包内', () => {
    const r = refs(mainShader, 23, colOf(mainShader, 23, '_MainTex', 2), true);
    const k = new Set(keys(r));
    expect(k.has('main.shader:2')).toBe(true); // Properties 声明
    expect(k.has('main.shader:11')).toBe(true); // TEXTURE2D 宏声明
    expect(k.has('main.shader:23')).toBe(true); // 宏参数使用处
    expect(k.has('b.hlsl:0')).toBe(true); // 跨文件
    expect(k.has('uses.hlsl:0')).toBe(true); // 包内引用可查
    expect(k.has('main.shader:13')).toBe(false); // 注释不计数
  });

  it('includeDeclaration=false：不含声明，只留使用处', () => {
    const r = refs(mainShader, 23, colOf(mainShader, 23, '_MainTex', 2), false);
    const k = new Set(keys(r));
    expect(k.has('main.shader:2')).toBe(false);
    expect(k.has('main.shader:11')).toBe(false);
    expect(k.has('main.shader:23')).toBe(true);
    expect(k.has('b.hlsl:0')).toBe(true);
  });

  it('优先级排序：当前文件 → 工程 → 包内', () => {
    const r = refs(mainShader, 23, colOf(mainShader, 23, '_MainTex', 2), true);
    const k = keys(r);
    expect(k.indexOf('main.shader:2')).toBeLessThan(k.indexOf('b.hlsl:0'));
    expect(k.indexOf('b.hlsl:0')).toBeLessThan(k.indexOf('uses.hlsl:0'));
  });

  it('截断：251 处（250 声明 + 1 使用）→ 200 条 + 日志 truncated=251', () => {
    logs.length = 0;
    const probe = path.join(root, 'Assets/probe.hlsl');
    const r = refs(probe, 0, colOf(probe, 0, 'FillSym', 2), true);
    expect(r).toHaveLength(200);
    expect(logs.some((l) => /truncated=251/.test(l))).toBe(true);
  });

  it('Temp/compiled-*：即使误入索引也不返回其 location', () => {
    const temp = write('Temp/compiled-x.hlsl', 'float4 t() { return _MainTex; }\n');
    index.indexFile(temp, fs.readFileSync(temp, 'utf8'));
    const r = refs(mainShader, 23, colOf(mainShader, 23, '_MainTex', 2), true);
    expect(keys(r).some((k) => k.startsWith('compiled-'))).toBe(false);
    index.removeFile(temp);
  });

  it('成员引用：`i.uv` → v2f.uv 声明 + 可解析使用处；appdata.uv 不混入；unresolved 记日志', () => {
    logs.length = 0;
    const r = refs(mainShader, 20, colOf(mainShader, 20, 'i.uv', 3), true);
    const k = new Set(keys(r));
    expect(k.has('main.shader:14')).toBe(true); // v2f 字段声明
    expect(k.has('main.shader:20')).toBe(true); // i.uv
    expect(k.has('main.shader:23')).toBe(true); // IN.uv（参数浅推断）
    expect(k.has('main.shader:15')).toBe(false); // appdata 字段声明
    expect(k.has('main.shader:21')).toBe(false); // a.uv
    expect(logs.some((l) => /unresolved=1/.test(l))).toBe(true); // unknownVar.uv
  });

  it('空结果面：注释 / 状态命令 / 字符串 → 空列表', () => {
    expect(refs(mainShader, 13, colOf(mainShader, 13, '_MainTex', 2))).toEqual([]);
    expect(refs(mainShader, 7, colOf(mainShader, 7, '"Queue"', 3))).toEqual([]);
  });

  it('能力声明：stdio 握手返回 referencesProvider 与 renameProvider(prepareProvider)', async () => {
    const proc = spawn(process.execPath, [path.resolve(__dirname, '../../server/out/server.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    const client = new LspClient(proc);
    try {
      const init = (await client.request('initialize', {
        processId: process.pid,
        rootUri: fileUri(root),
        workspaceFolders: [{ uri: fileUri(root), name: 'fixture' }],
        capabilities: {},
      })) as {
        capabilities: {
          referencesProvider?: boolean;
          renameProvider?: { prepareProvider?: boolean };
        };
      };
      expect(init.capabilities.referencesProvider).toBe(true);
      expect(init.capabilities.renameProvider?.prepareProvider).toBe(true);
    } finally {
      await client.shutdown();
    }
  });
});
