/** T-030 / T-031 / T-032 rename 单测（规格 feature-rename）
 *
 * 覆盖：跨文件 WorkspaceEdit、struct 作用域（appdata.uv 零改动 + unresolved）、`#if` 分支全改、
 * 新名校验四例、内置/包内拒绝、存在性校验、空结果面、Properties/sampler_ 联动 + Info 资产提示、
 * 零误改回归语料（roadmap M3 核心：注释 / 字符串 / 死分支另一符号 / 不同 struct 同名字段，逐处 Range）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { WorkspaceEdit } from 'vscode-languageserver';
import { SymbolIndex } from '../../server/out/symbolIndex.js';
import { DocumentStore } from '../../server/out/documentStore.js';
import { prepareRename, rename } from '../../server/out/rename.js';
import type { RenameContext } from '../../server/out/rename.js';
import { LspClient, fileUri } from './lspClient.js';

let root: string;
let index: SymbolIndex;
let store: DocumentStore;
let logs: string[];
let infos: string[];
let ctx: RenameContext;

function write(rel: string, text: string): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
  index.indexFile(p, text);
  return p;
}

function colOf(file: string, line: number, needle: string, offset: number): number {
  const text = fs.readFileSync(file, 'utf8').split('\n')[line];
  const idx = text.indexOf(needle);
  if (idx < 0) throw new Error(`第 ${line} 行找不到 "${needle}"`);
  return idx + offset;
}

const isError = (r: unknown): boolean =>
  !!r && typeof r === 'object' && 'message' in (r as Record<string, unknown>) && !('changes' in (r as Record<string, unknown>));

/** WorkspaceEdit → Map<"basename:line:char", newText> */
function editMap(we: WorkspaceEdit): Map<string, string> {
  const m = new Map<string, string>();
  const changes = we.changes ?? {};
  for (const [uri, edits] of Object.entries(changes)) {
    const f = decodeURIComponent(uri.split('/').pop()!);
    for (const e of edits) m.set(`${f}:${e.range.start.line}:${e.range.start.character}`, e.newText);
  }
  return m;
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-rename-'));
  index = new SymbolIndex();
  store = new DocumentStore();
  logs = [];
  infos = [];
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
    notifyInfo: (m) => infos.push(m),
  };
});

afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('T-030 rename 核心', () => {
  it('跨文件：a.hlsl 声明、b.shader 与 c.hlsl 使用 → 三文件全部 occurrence', () => {
    const a = write('Assets/a.hlsl', 'float4 _SharedSym;\nfloat4 useA() { return _SharedSym; }\n');
    const b = write('Assets/b.shader', [
      'Shader "R/B"',
      '{',
      '  SubShader { Pass { CGPROGRAM',
      '  float4 useB() { return _SharedSym + _SharedSym; }',
      '  ENDCG } }',
      '}',
      '',
    ].join('\n'));
    const c = write('Assets/c.hlsl', 'float4 useC() { return _SharedSym; }\n');
    void b;
    void c;
    const r = rename(a, 0, colOf(a, 0, '_SharedSym', 2), '_Renamed', ctx);
    expect(isError(r)).toBe(false);
    const m = editMap(r as WorkspaceEdit);
    expect(m.get('a.hlsl:0:7')).toBe('_Renamed');
    expect(m.get('a.hlsl:1:23')).toBe('_Renamed');
    expect(m.get('b.shader:3:25')).toBe('_Renamed');
    expect(m.get('b.shader:3:38')).toBe('_Renamed');
    expect(m.get('c.hlsl:0:23')).toBe('_Renamed');
  });

  it('作用域：改 `i.uv`（v2f）→ appdata.uv 声明与 `a.uv` 零改动，日志 unresolved=', () => {
    const main = write('Assets/scope.shader', [
      'Shader "R/Scope"',
      '{',
      '  SubShader { Pass { HLSLPROGRAM',
      '  struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };',
      '  struct appdata { float2 uv : TEXCOORD0; };',
      '  v2f i;',
      '  appdata a;',
      '  float4 frag() : SV_Target',
      '  {',
      '    float2 q = i.uv;',
      '    float2 r = a.uv;',
      '    float2 s = unknownVar.uv;',
      '    return float4(q, 0, 1);',
      '  }',
      '  ENDHLSL } }',
      '}',
      '',
    ].join('\n'));
    logs.length = 0;
    const r = rename(main, 9, colOf(main, 9, 'i.uv', 3), 'tex', ctx);
    expect(isError(r)).toBe(false);
    const m = editMap(r as WorkspaceEdit);
    expect(m.get('scope.shader:3:48')).toBe('tex'); // v2f.uv 声明
    expect(m.get('scope.shader:9:17')).toBe('tex'); // i.uv
    expect(m.has('scope.shader:4:26')).toBe(false); // appdata.uv 声明
    expect(m.has('scope.shader:10:17')).toBe(false); // a.uv
    expect(m.has('scope.shader:11:28')).toBe(false); // unknownVar.uv（不可解析）
    expect(logs.some((l) => /unresolved=1/.test(l))).toBe(true);
  });

  it('#if 分支：同一逻辑符号两分支的声明与使用全部被改（不求值）', () => {
    const f = write('Assets/ifbranch.hlsl', [
      'float4 frag() : SV_Target',
      '{',
      '  #if defined(DEAD_BRANCH)',
      '  float2 uvv = 1;',
      '  return float4(uvv, 0, 0);',
      '  #else',
      '  float2 uvv = 2;',
      '  return float4(uvv, 0, 0);',
      '  #endif',
      '}',
      '',
    ].join('\n'));
    const r = rename(f, 6, colOf(f, 6, 'uvv', 2), 'wv', ctx);
    expect(isError(r)).toBe(false);
    const m = editMap(r as WorkspaceEdit);
    expect([m.get('ifbranch.hlsl:3:9'), m.get('ifbranch.hlsl:4:16'), m.get('ifbranch.hlsl:6:9'), m.get('ifbranch.hlsl:7:16')]).toEqual([
      'wv', 'wv', 'wv', 'wv',
    ]);
  });

  it('新名校验四例：`1abc` / `float` / 空串 / 同作用域已有名 → 错误且无 edit', () => {
    const a = write('Assets/validate.hlsl', 'float4 _Alpha;\nfloat4 _Beta;\n');
    for (const bad of ['1abc', 'float', '', '_Beta']) {
      const r = rename(a, 0, colOf(a, 0, '_Alpha', 2), bad, ctx);
      expect(isError(r), `新名 "${bad}" 应被拒绝`).toBe(true);
    }
  });

  it('内置/包内拒绝：pkg 声明 prepareRename → 错误含「不可改名」；references 仍可查', async () => {
    const pkg = write(
      'Library/PackageCache/com.unity.render-pipelines.core@14.0.12/ShaderLibrary/api.hlsl',
      '// Transforms position from world space to homogenous space\nfloat4 TransformWorldToHClip(float3 p) { return float4(p, 1); }\nfloat4 useIt() { return TransformWorldToHClip(float3(0,0,0)); }\n'
    );
    const r = prepareRename(pkg, 1, colOf(pkg, 1, 'TransformWorldToHClip', 2), ctx);
    expect(isError(r)).toBe(true);
    expect(String((r as { message: string }).message)).toContain('不可改名');
    const rr = rename(pkg, 1, colOf(pkg, 1, 'TransformWorldToHClip', 2), 'Whatever', ctx);
    expect(isError(rr)).toBe(true);
  });

  it('存在性校验：使用处文件被删 → 不报错、不在 edit、日志记跳过', () => {
    const a = write('Assets/exist_a.hlsl', 'float4 _Gone;\nfloat4 ua() { return _Gone; }\n');
    const b = write('Assets/exist_b.hlsl', 'float4 ub() { return _Gone; }\n');
    fs.unlinkSync(b);
    logs.length = 0;
    const r = rename(a, 0, colOf(a, 0, '_Gone', 2), '_Kept', ctx);
    expect(isError(r)).toBe(false);
    const m = editMap(r as WorkspaceEdit);
    expect(m.size).toBe(2); // 只有 a.hlsl 两处
    expect(logs.some((l) => /unresolved=1/.test(l))).toBe(true); // 缺失文件计入 unresolved
    index.removeFile(b);
  });

  it('空结果面：注释 / 状态命令 / 字符串上 prepareRename → null', () => {
    const f = write('Assets/empty.hlsl', [
      'Shader "R/Empty"',
      '{',
      '  // _Nothing 在注释',
      '  SubShader { Pass { Cull Off } }',
      '}',
      '',
    ].join('\n'));
    expect(prepareRename(f, 2, colOf(f, 2, '_Nothing', 2), ctx)).toBeNull();
    expect(prepareRename(f, 3, colOf(f, 3, 'Cull', 2), ctx)).toBeNull();
  });

  it('Temp/compiled-*：prepareRename 返回 null', () => {
    const t = path.join(root, 'Temp', 'compiled-r.shader');
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.writeFileSync(t, 'Shader "G" { SubShader { Pass { CGPROGRAM\nfloat4 _X;\nfloat4 u(){return _X;}\nENDCG } } }\n', 'utf8');
    expect(prepareRename(t, 1, 7, ctx)).toBeNull();
  });
});

describe('T-031 Properties / sampler_ 联动 + 资产提示', () => {
  it('改 Properties `_MainTex` → Properties/HLSL/宏参数/sampler_ 全联动，其他属性零改动', () => {
    const main = write('Assets/prop.shader', [
      'Shader "R/Prop"', //                                             0
      '{', //                                                          1
      '  Properties { _MainTex("Tex", 2D) = "white" {} _Bump("B", 2D) = "white" {} }', // 2
      '  SubShader { Pass { HLSLPROGRAM', //                           3
      '  TEXTURE2D(_MainTex);', //                                     4
      '  SAMPLER(sampler_MainTex);', //                                5
      '  float4 frag(float2 uv : TEXCOORD0) : SV_Target { return SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, uv); }', // 6
      '  ENDHLSL } }', //                                              7
      '}', //                                                          8
      '',
    ].join('\n'));
    infos.length = 0;
    const r = rename(main, 2, colOf(main, 2, '_MainTex', 2), '_BaseMap', ctx);
    expect(isError(r)).toBe(false);
    const m = editMap(r as WorkspaceEdit);
    expect(m.get('prop.shader:2:15')).toBe('_BaseMap'); // Properties 声明
    expect(m.get('prop.shader:4:12')).toBe('_BaseMap'); // TEXTURE2D 参数
    expect(m.get('prop.shader:6:75')).toBe('_BaseMap'); // SAMPLE_TEXTURE2D 第一参数
    expect(m.get('prop.shader:5:10')).toBe('sampler_BaseMap'); // SAMPLER 声明
    expect(m.get('prop.shader:6:85')).toBe('sampler_BaseMap'); // SAMPLE_TEXTURE2D 第二参数
    // 其他属性零改动
    expect([...m.values()].some((v) => v.includes('Bump'))).toBe(false);
    // Info 资产提示：含「材质」「场景」
    expect(infos.length).toBe(1);
    expect(infos[0]).toContain('材质');
    expect(infos[0]).toContain('场景');
  });
});

describe('T-031 真实 stdio：Properties rename + window/showMessage(Info) 协议级拦截', () => {
  it('rename 返回 WorkspaceEdit，server 发 window/showMessage(Info) 含「材质」「场景」', async () => {
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-rnstdio-'));
    const f = path.join(root2, 'Assets', 'propstdio.shader');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(
      f,
      [
        'Shader "Rn/Stdio"',
        '{',
        '  Properties { _MainTex("Tex", 2D) = "white" {} }',
        '  SubShader { Pass { HLSLPROGRAM',
        '  TEXTURE2D(_MainTex);',
        '  SAMPLER(sampler_MainTex);',
        '  float4 frag(float2 uv : TEXCOORD0) : SV_Target { return SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, uv); }',
        '  ENDHLSL } }',
        '}',
        '',
      ].join('\n'),
      'utf8'
    );
    const proc = spawn(process.execPath, [path.resolve(__dirname, '../../server/out/server.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    const client = new LspClient(proc);
    try {
      await client.request('initialize', {
        processId: process.pid,
        rootUri: fileUri(root2),
        workspaceFolders: [{ uri: fileUri(root2), name: 'fixture' }],
        // 必须声明 window.showMessage 能力，否则协议库会吞掉 showMessageRequest
        capabilities: { window: { showMessage: {} } },
      });
      client.notify('initialized', {});
      await client.waitForIndex(1);

      const we = (await client.request('textDocument/rename', {
        textDocument: { uri: fileUri(f) },
        position: { line: 2, character: 17 },
        newName: '_BaseMap',
      })) as { changes?: Record<string, unknown[]> } | null;
      expect(we).toBeTruthy();
      const edits = Object.values(we?.changes ?? {}).flat();
      expect(edits.length).toBe(5); // Properties + TEXTURE2D + SAMPLE 参数 + 两处 sampler_ 联动

      // 协议级拦截：server→client 的 window/showMessageRequest（LSP 里请求的方法名；
      // LspClient 记录并回 null）。降级告警可能先发，扫全部找 Info（MessageType: 1=Error 2=Warning 3=Info）。
      const deadline = Date.now() + 5000;
      let infoMsg: { type: number; message: string } | null = null;
      while (Date.now() < deadline && !infoMsg) {
        for (const n of client.notifications) {
          if (n.method !== 'window/showMessageRequest') continue;
          const p = n.params as { type: number; message: string };
          if (p && p.type === 3 && p.message.includes('材质')) {
            infoMsg = p;
            break;
          }
        }
        if (!infoMsg) await new Promise((r) => setTimeout(r, 100));
      }
      expect(infoMsg, 'server 应发 window/showMessageRequest(Info)').toBeTruthy();
      expect(infoMsg!.message).toContain('材质');
      expect(infoMsg!.message).toContain('场景');
    } finally {
      await client.shutdown();
      try {
        fs.rmSync(root2, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});

describe('T-032 零误改回归语料（roadmap M3 核心）', () => {
  it('对 v2f 的字段 uv 改名：注释 / 字符串 / 死分支另一符号 / 另一 struct 全部原样', () => {
    const f = write('Assets/corpus.shader', [
      'Shader "R/Corpus"', //                                            0
      '{', //                                                           1
      '  Properties { _T("t", 2D) = "white" {} }', //                   2
      '  SubShader { Pass { HLSLPROGRAM', //                            3
      '  #include "uv"', //                                             4 ← 字符串里的 uv
      '  struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };', // 5 ← 目标字段
      '  struct appdata { float2 uv : TEXCOORD0; };', //                6 ← 另一 struct 同名字段
      '  v2f i;', //                                                    7
      '  appdata a;', //                                                8
      '  float4 frag() : SV_Target', //                                 9
      '  {', //                                                         10
      '    // i.uv 在注释里', //                                        11 ← 注释
      '    #if defined(DEAD_BRANCH)', //                                12
      '    float uv = 1.0;', //                                         13 ← 死分支里另一符号（局部变量）
      '    return float4(uv, 0, 0, 1);', //                             14
      '    #else', //                                                   15
      '    float2 q = i.uv;', //                                        16 ← 可解析目标
      '    float2 r = a.uv;', //                                        17 ← 另一 struct 的使用
      '    return float4(q, r.x, 0);', //                               18
      '    #endif', //                                                  19
      '  }', //                                                         20
      '  ENDHLSL } }', //                                               21
      '}', //                                                           22
      '',
    ].join('\n'));
    const r = rename(f, 16, colOf(f, 16, 'i.uv', 3), 'texUV', ctx);
    expect(isError(r)).toBe(false);
    const m = editMap(r as WorkspaceEdit);
    // 只改：v2f 字段声明（L5）与可解析的 i.uv（L16）
    expect(m.get('corpus.shader:5:48')).toBe('texUV');
    expect(m.get('corpus.shader:16:17')).toBe('texUV');
    // 其余全部原样：逐处断言不在 edit 集
    for (const untouched of [
      'corpus.shader:4:12', // #include "uv"
      'corpus.shader:6:26', // appdata.uv 声明
      'corpus.shader:11:9', // 注释里的 i.uv
      'corpus.shader:13:10', // 死分支局部 uv
      'corpus.shader:14:18', // 死分支局部 uv 使用
      'corpus.shader:17:17', // a.uv
    ]) {
      expect(m.has(untouched), `不该被改：${untouched}`).toBe(false);
    }
  });
});
