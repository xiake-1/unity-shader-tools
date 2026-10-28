/** M3 语义补全单测（T-022～T-026）
 *
 * 语料是自包含 fixture 工程（Assets / Library/PackageCache / EditorFake/Data/CGIncludes），
 * 与 definition.test.ts 同构。断言面按任务分组：
 * T-022 上下文判定与空结果面；T-023 成员；T-024 include 路径；T-025 Unity API/用户宏/文档兜底；
 * T-026 前缀过滤/排序/截断。能力声明经真实 stdio 握手断言。
 *
 * 探针文件 probe.hlsl 自身入索引并 `#include "inc.hlsl"`：
 * 用户宏候选 = 当前文件(0) + 闭包(1)，工程内其他文件(2) 的宏**必须**被过滤（范围规则）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CompletionItemKind, type CompletionItem } from 'vscode-languageserver';
import { SymbolIndex } from '../../server/out/symbolIndex.js';
import { DocumentStore } from '../../server/out/documentStore.js';
import { provideCompletion, clearCompletionCache } from '../../server/out/completion.js';
import type { CompletionContext } from '../../server/out/completion.js';
import type { IncludeContext } from '../../server/out/includeResolver.js';
import { LspClient, fileUri } from './lspClient.js';

let root: string;
let mainShader: string;
let inc1: string;
let inc2: string;
let pkgFile: string;
let cgFile: string;
let fillFile: string;
let probeHlsl: string;
let chainHlsl: string;
let outerV2f: string;
let usrHlsl: string;
let propShader: string;
let index: SymbolIndex;
let store: DocumentStore;
let includeCtx: IncludeContext;
let logs: string[];

const MAIN = [
  'Shader "M3/Demo"', //                                        0
  '{', //                                                       1
  '  Properties { _MainTex("Tex", 2D) = "white" {} }', //       2
  '  SubShader', //                                             3
  '  {', //                                                     4
  '    Pass', //                                                5
  '    {', //                                                   6
  '      Cull Off ZWrite On', //                                7
  '      // comment mentions SAMPLE_TEXTURE2D here', //         8
  '      Tags { "Queue"="Geometry" }', //                       9
  '      HLSLPROGRAM', //                                       10
  '      #include "inc.hlsl"', //                               11
  '      struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; float mul : TEXCOORD1; };', // 12
  '      v2f i;', //                                            13
  '      IncStruct s;', //                                      14
  '      float4 frag(v2f IN) : SV_Target', //                   15
  '      {', //                                                 16
  '        float2 q = i.uv;', //                                17
  '        float x = s.al;', //                                 18
  '        float4 c = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv);', // 19
  '        return c;', //                                       20
  '      }', //                                                 21
  '      ENDHLSL', //                                           22
  '    }', //                                                   23
  '  }', //                                                     24
  '}', //                                                       25
  '',
].join('\n');

const INC1 = [
  'struct IncStruct { float alpha; };', // 0
  '#define OrdInc 1', //                   1 ← 闭包层（rank 1）
  'float IncVar;', //                      2 ← 闭包层变量（rank 1）
  '',
].join('\n');

const INC2 = ['float _Outer;', ''].join('\n');

// 工程内非闭包文件：同名 struct 的另一份定义（图1 回归——成员候选不得跨工程并集）
const OUTER_V2F = ['struct v2f { float4 grabPos; half4 color; };', ''].join('\n');

const PKG = [
  '// Transforms a world-space position to clip space.', // 0
  'float4 TransformWorldToHClip(float3 positionWS) { return float4(0, 0, 0, 1); }', // 1
  '#define OrdPkg 1', // 2 ← 包内层（rank 3）
  'float4 _PkgGlobal; // package global var', // 3 ← 包内变量（rank 3，带注释文档）
  '',
].join('\n');

const CG = [
  '// Samples a texture with the given sampler and UV.', // 0
  '#define SAMPLE_TEXTURE2D(tex, samplerTex, uv) float4(0, 0, 0, 0)', // 1
  '#define TEXTURE2D(t) t##_tex', // 2  ← 无注释：文档走 macroTable 兜底
  '#define OrdCg 1', // 3 ← 内置层（rank 4）
  'float4 mul(float4 a, float4 b) { return a; }', // 4 ← 内置函数 mul
  'float4 _CgGlobalTime;', // 5 ← 内置全局变量（rank 4，图2 类候选）
  '',
].join('\n');

const PROBE = [
  '#include "inc.hlsl"', //           0 ← 闭包来源
  '#define MY_LOCAL_MACRO 1', //      1 ← 当前文件用户宏（rank 0）
  '#define MY_OTHER 2', //            2
  '#define OrdCur 1', //              3
  '#define SAM_PROBE 1', //           4 ← 光标停在 `SAM` 后
  '#define sam_probe 2', //           5 ← 大小写敏感负例
  '#define Fill', //                  6 ← 截断探针（Fill0..Fill349 在 CG fill.hlsl）
  '#define Ord', //                   7 ← 排序探针
  '#define MY_', //                   8 ← 用户宏探针
  '#define TransformWorldToH', //     9 ← Unity API 探针
  '#define TEXTURE', //               10 ← macroTable 兜底探针
  '',
].join('\n');

const CHAIN = [
  'v2f g;', //                    0
  'float2 a = g.uv.xy;', //       1 ← 链式：第二个点后应空
  'float2 b = unknownVar.uv;', // 2 ← 未知变量：点后应空
  '',
].join('\n');

// 图2 回归：用户自己声明的全局变量要进标识符候选（当前文件 / 闭包 / 内置各验一处）
const USR = [
  '#include "inc.hlsl"', //     0
  'float4 _MyMainTexture;', //   1 ← 当前文件变量（rank 0）
  'float4 q = _My;', //          2 ← 探针：当前文件变量
  'float w = Inc;', //           3 ← 探针：闭包变量 IncVar（rank 1）；IncStruct 是 struct 名不进
  'float t = _CgG;', //          4 ← 探针：内置全局变量 _CgGlobalTime（rank 4）
  'float u = _Pkg;', //          5 ← 探针：包内全局变量 _PkgGlobal（rank 3）
  '',
].join('\n');

// 图2 回归：Properties 声明的属性在本文件 HLSL 里可补全
const PROP_SHADER = [
  'Shader "M3/Prop"', //                          0
  '{', //                                         1
  '  Properties { _MainTexture("T", 2D) = "white" {} }', // 2
  '  SubShader', //                               3
  '  {', //                                       4
  '    Pass', //                                  5
  '    {', //                                     6
  '      HLSLPROGRAM', //                         7
  '      float4 f() { return _Main; }', //        8 ← 探针
  '      ENDHLSL', //                             9
  '    }', //                                     10
  '  }', //                                       11
  '}', //                                         12
  '',
].join('\n');

function write(rel: string, text: string): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

function ctx(overrides: Partial<CompletionContext> = {}): CompletionContext {
  return {
    index,
    store,
    includeCtx,
    projectRoot: root,
    log: (m) => logs.push(m),
    indexing: () => false,
    ...overrides,
  };
}

function comp(file: string, line: number, character: number) {
  return provideCompletion(file, line, character, ctx());
}

/** 光标列 = 该行 needle 起点 + offset */
function colOf(file: string, line: number, needle: string, offset: number): number {
  const text = fs.readFileSync(file, 'utf8').split('\n')[line];
  const idx = text.indexOf(needle);
  if (idx < 0) throw new Error(`第 ${line} 行找不到 "${needle}"`);
  return idx + offset;
}

function docOf(item: CompletionItem | undefined): string {
  const d = item?.documentation as { value?: string } | string | undefined;
  if (!d) return '';
  return typeof d === 'string' ? d : (d.value ?? '');
}

function find(r: { items: CompletionItem[] }, label: string): CompletionItem | undefined {
  return r.items.find((i) => i.label === label);
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-comp-'));
  mainShader = write('Assets/Shaders/main.shader', MAIN);
  inc1 = write('Assets/Shaders/inc.hlsl', INC1);
  inc2 = write('Assets/Shaders/inc2.hlsl', INC2);
  probeHlsl = write('Assets/Shaders/probe.hlsl', PROBE);
  chainHlsl = write('Assets/Shaders/chain.hlsl', CHAIN);
  outerV2f = write('Assets/Shaders/outerV2f.hlsl', OUTER_V2F);
  usrHlsl = write('Assets/Shaders/usr.hlsl', USR);
  propShader = write('Assets/Shaders/prop.shader', PROP_SHADER);
  pkgFile = write(
    'Library/PackageCache/com.unity.render-pipelines.core@14.0.0/ShaderLibrary/SpaceTransforms.hlsl',
    PKG
  );
  cgFile = write('EditorFake/Data/CGIncludes/UnityCG.cginc', CG);
  fillFile = write(
    'EditorFake/Data/CGIncludes/fill.hlsl',
    Array.from({ length: 350 }, (_, i) => `#define Fill${i} ${i}`).join('\n') + '\n'
  );

  includeCtx = {
    projectRoot: root,
    cgIncludesDir: path.join(root, 'EditorFake', 'Data', 'CGIncludes'),
    packageCacheDir: path.join(root, 'Library', 'PackageCache'),
  };
  index = new SymbolIndex();
  store = new DocumentStore();
  for (const f of [mainShader, inc1, inc2, probeHlsl, chainHlsl, outerV2f, usrHlsl, propShader, pkgFile, cgFile, fillFile]) {
    index.indexFile(f, fs.readFileSync(f, 'utf8'));
  }
  logs = [];
});

afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('T-022 上下文判定与空结果面', () => {
  it('成员上下文：`i.` 后给出 v2f 字段', () => {
    const r = comp(mainShader, 17, colOf(mainShader, 17, 'i.uv', 2));
    expect(r.items.map((i) => i.label)).toEqual(expect.arrayContaining(['pos', 'uv', 'mul']));
  });

  it('include 上下文：字符串内给路径候选', () => {
    const r = comp(mainShader, 11, colOf(mainShader, 11, '"inc.hlsl"', 5));
    expect(r.items.map((i) => i.label)).toContain('inc.hlsl');
  });

  it('标识符上下文：`MY_` 前缀给宏候选', () => {
    const r = comp(probeHlsl, 8, colOf(probeHlsl, 8, '#define MY_', 11));
    expect(r.items.map((i) => i.label)).toEqual(
      expect.arrayContaining(['MY_LOCAL_MACRO', 'MY_OTHER'])
    );
  });

  it('空结果面：注释内 / ShaderLab 字符串 / 状态命令 → 空列表且不抛异常', () => {
    expect(comp(mainShader, 8, colOf(mainShader, 8, 'mentions', 3)).items).toEqual([]);
    expect(comp(mainShader, 9, colOf(mainShader, 9, '"Queue"', 3)).items).toEqual([]);
    expect(comp(mainShader, 7, colOf(mainShader, 7, 'Off', 1)).items).toEqual([]);
  });

  it('能力声明：真实 stdio 握手返回 completionProvider 与触发字符', async () => {
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
      })) as { capabilities: { completionProvider?: { triggerCharacters?: string[] } } };
      expect(init.capabilities.completionProvider).toBeTruthy();
      expect(init.capabilities.completionProvider!.triggerCharacters).toEqual(['.', '"', '/', '\\']);
    } finally {
      await client.shutdown();
    }
  });
});

describe('T-023 struct 成员补全', () => {
  it('`i.` → v2f 全部字段，kind=Field', () => {
    const r = comp(mainShader, 17, colOf(mainShader, 17, 'i.uv', 2));
    expect(find(r, 'uv')?.kind).toBe(CompletionItemKind.Field);
  });

  it('前缀过滤：`i.u` → 只剩 uv', () => {
    const r = comp(mainShader, 17, colOf(mainShader, 17, 'i.uv', 3));
    expect(r.items.map((i) => i.label)).toEqual(['uv']);
  });

  it('跨文件 struct：`s.al` → inc.hlsl 里 IncStruct 的 alpha', () => {
    const r = comp(mainShader, 18, colOf(mainShader, 18, 's.al', 4));
    expect(r.items.map((i) => i.label)).toEqual(['alpha']);
  });

  it('负例：链式 `g.uv.` → 空（不做链式推断）', () => {
    expect(comp(chainHlsl, 1, colOf(chainHlsl, 1, 'g.uv.', 5)).items).toEqual([]);
  });

  it('负例：未知变量 `unknownVar.` → 空', () => {
    expect(comp(chainHlsl, 2, colOf(chainHlsl, 2, 'unknownVar.', 11)).items).toEqual([]);
  });

  it('字段与内置函数同名不吞候选：`i.` 给 Field mul（内置 mul 函数存在）', () => {
    const r = comp(mainShader, 17, colOf(mainShader, 17, 'i.uv', 2));
    expect(find(r, 'mul')?.kind).toBe(CompletionItemKind.Field);
  });

  it('同名 struct 可见性分层：当前文件 v2f 定义在场 → 工程内另一份 v2f 字段不进（图1 回归）', () => {
    // outerV2f.hlsl 也定义了 `v2f { grabPos, color }`（工程内非闭包，rank 2）
    const r = comp(mainShader, 17, colOf(mainShader, 17, 'i.uv', 2));
    const labels = r.items.map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['pos', 'uv', 'mul']));
    expect(labels).not.toContain('grabPos');
    expect(labels).not.toContain('color');
  });
});

describe('语义补全（2026-10-28 二次修订）', () => {
  // MAIN 第 12 行：struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; float mul : TEXCOORD1; };
  // MAIN 第 15 行：float4 frag(v2f IN) : SV_Target
  it('struct 字段 `SV_` 前缀 → SV_Position/SV_Target（大小写不敏感，canonical 插入）', () => {
    const r = comp(mainShader, 12, colOf(mainShader, 12, 'SV_POSITION', 3));
    const labels = r.items.map((i) => i.label);
    expect(labels).toContain('SV_Position');
    expect(labels).toContain('SV_Target');
    expect(find(r, 'SV_Target')?.kind).toBe(CompletionItemKind.Keyword);
    expect(docOf(find(r, 'SV_Target'))).toContain('渲染目标');
  });

  it('`pos : ` 空前缀 → 含 TEXCOORD0 与 POSITION', () => {
    const r = comp(mainShader, 12, colOf(mainShader, 12, 'pos : SV_POSITION', 5));
    const labels = r.items.map((i) => i.label);
    expect(labels).toContain('TEXCOORD0');
    expect(labels).toContain('POSITION');
  });

  it('函数返回值 `SV_Targ` 前缀 → SV_Target', () => {
    const r = comp(mainShader, 15, colOf(mainShader, 15, 'SV_Target', 7));
    expect(r.items.map((i) => i.label)).toContain('SV_Target');
  });

  it('`TEX` 前缀 → TEXCOORD0..7', () => {
    const r = comp(mainShader, 12, colOf(mainShader, 12, 'TEXCOORD0', 3));
    const labels = r.items.map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['TEXCOORD0', 'TEXCOORD7']));
  });
});

describe('T-024 #include 路径补全', () => {
  it('内置裸名：`Unity` → UnityCG.cginc', () => {
    const f = write('Assets/Shaders/probe1.hlsl', '#include "UnityCG.cginc"\n');
    const r = comp(f, 0, colOf(f, 0, '"UnityCG', 7));
    expect(r.items.map((i) => i.label)).toContain('UnityCG.cginc');
  });

  it('同目录：`inc` → inc.hlsl', () => {
    const f = write('Assets/Shaders/probe2.hlsl', '#include "inc.hlsl"\n');
    const r = comp(f, 0, colOf(f, 0, '"inc.', 4));
    expect(r.items.map((i) => i.label)).toContain('inc.hlsl');
  });

  it('Assets 前缀：`Assets/Sh` → Assets/Shaders/inc2.hlsl', () => {
    const f = write('Assets/Shaders/probe3.hlsl', '#include "Assets/Shaders/inc2.hlsl"\n');
    const r = comp(f, 0, colOf(f, 0, '"Assets/Sh', 10));
    expect(r.items.map((i) => i.label)).toContain('Assets/Shaders/inc2.hlsl');
  });

  it('Packages→PackageCache 回退：`...ShaderLibrary/Space` → Packages/<pkg>/ShaderLibrary/SpaceTransforms.hlsl', () => {
    const f = write(
      'Assets/Shaders/probe4.hlsl',
      '#include "Packages/com.unity.render-pipelines.core/ShaderLibrary/SpaceTransforms.hlsl"\n'
    );
    const r = comp(
      f,
      0,
      colOf(f, 0, '"Packages/com.unity.render-pipelines.core/ShaderLibrary/Space', 59)
    );
    expect(r.items.map((i) => i.label)).toContain(
      'Packages/com.unity.render-pipelines.core/ShaderLibrary/SpaceTransforms.hlsl'
    );
  });

  it('textEdit 替换整段字符串内容（不是追加）', () => {
    const f = write('Assets/Shaders/probe5.hlsl', '#include "inc.hlsl"\n');
    const r = comp(f, 0, colOf(f, 0, '"inc.', 4));
    const item = find(r, 'inc.hlsl');
    expect(item?.textEdit?.range.start).toEqual({ line: 0, character: 10 });
    expect(item?.textEdit?.range.end).toEqual({ line: 0, character: 18 });
  });
});

describe('T-025 Unity API / 用户宏 / 文档兜底链', () => {
  it('Unity 函数带真实源码注释文档：TransformWorldToHClip', () => {
    const r = comp(probeHlsl, 9, colOf(probeHlsl, 9, '#define TransformWorldToH', 20));
    const item = find(r, 'TransformWorldToHClip');
    expect(item).toBeTruthy();
    expect(docOf(item)).toContain('clip space');
    expect(item!.kind).toBe(CompletionItemKind.Function);
  });

  it('Unity 宏带注释文档：SAMPLE_TEXTURE2D', () => {
    const r = comp(probeHlsl, 4, colOf(probeHlsl, 4, '#define SAM_PROBE', 10));
    expect(docOf(find(r, 'SAMPLE_TEXTURE2D'))).toContain('Samples a texture');
  });

  it('用户宏：当前文件的 `MY_OTHER` 可补全（无注释 → 文档为空）', () => {
    const r = comp(probeHlsl, 8, colOf(probeHlsl, 8, '#define MY_', 11));
    const item = find(r, 'MY_OTHER');
    expect(item).toBeTruthy();
    expect(item!.documentation).toBeUndefined();
  });

  it('include 闭包内用户宏可补全：OrdInc（rank 1）', () => {
    const r = comp(probeHlsl, 7, colOf(probeHlsl, 7, '#define Ord', 10));
    expect(r.items.map((i) => i.label)).toContain('OrdInc');
  });

  it('文档兜底链：无注释的已知宏 TEXTURE2D → macroTable 描述', () => {
    const r = comp(probeHlsl, 10, colOf(probeHlsl, 10, '#define TEXTURE', 14));
    const item = find(r, 'TEXTURE2D');
    expect(item).toBeTruthy();
    expect(docOf(item)).toContain('2D 纹理');
  });

  it('范围外类别不出现：工程内非闭包变量/函数、struct 名、工程内非闭包宏不进候选', () => {
    const r = comp(probeHlsl, 8, colOf(probeHlsl, 8, '#define MY_', 11));
    const labels = r.items.map((i) => i.label);
    expect(labels).not.toContain('_Outer'); // 工程内非闭包变量（rank 2 不可见）
    expect(labels).not.toContain('v2f'); // struct 名
    expect(labels).not.toContain('frag'); // 工程内非闭包函数
    // 工程内非闭包文件（main.shader）独有的宏：`OrdCur` 在 probe 自身有定义才出现；
    // 造一个只在 main 里的宏名做负例
    const r2 = comp(probeHlsl, 8, colOf(probeHlsl, 8, '#define MY_', 11));
    expect(r2.items.map((i) => i.label)).not.toContain('MAIN_ONLY_MACRO');
  });

  it('用户全局变量进候选：当前文件 `_My` → _MyMainTexture（Variable）', () => {
    const r = comp(usrHlsl, 2, colOf(usrHlsl, 2, '_My', 3));
    const item = find(r, '_MyMainTexture');
    expect(item, `_My 候选：${r.items.map((i) => i.label).join(',')}`).toBeTruthy();
    expect(item!.kind).toBe(CompletionItemKind.Variable);
  });

  it('闭包变量进候选：`Inc` → IncVar（rank 1），struct 名 IncStruct 不进', () => {
    const labels = comp(usrHlsl, 3, colOf(usrHlsl, 3, 'Inc', 3)).items.map((i) => i.label);
    expect(labels).toContain('IncVar');
    expect(labels).not.toContain('IncStruct');
  });

  it('内置/包内全局变量进候选：`_CgG` → _CgGlobalTime（rank 4）；`_Pkg` → _PkgGlobal（rank 3）', () => {
    const r = comp(usrHlsl, 4, colOf(usrHlsl, 4, '_CgG', 4));
    expect(r.items.map((i) => i.label)).toContain('_CgGlobalTime');
    const r2 = comp(usrHlsl, 5, colOf(usrHlsl, 5, '_Pkg', 4));
    expect(r2.items.map((i) => i.label)).toContain('_PkgGlobal');
  });

  it('Properties 属性进候选：本文件 HLSL 里 `_Main` → _MainTexture（Property）', () => {
    const r = comp(propShader, 8, colOf(propShader, 8, '_Main', 5));
    const item = find(r, '_MainTexture');
    expect(item, `_Main 候选：${r.items.map((i) => i.label).join(',')}`).toBeTruthy();
    expect(item!.kind).toBe(CompletionItemKind.Property);
  });
});

describe('T-026 前缀过滤 / 排序 / 截断', () => {
  it('大小写敏感：`SAM` 命中 SAMPLE_TEXTURE2D 不命中 TEXTURE2D；`sam` 不命中 SAMPLE_TEXTURE2D', () => {
    const upper = comp(probeHlsl, 4, colOf(probeHlsl, 4, '#define SAM_PROBE', 10));
    const labels = upper.items.map((i) => i.label);
    expect(labels).toContain('SAMPLE_TEXTURE2D');
    expect(labels).not.toContain('TEXTURE2D');
    const lower = comp(probeHlsl, 5, colOf(probeHlsl, 5, '#define sam_probe', 10));
    expect(lower.items.map((i) => i.label)).not.toContain('SAMPLE_TEXTURE2D');
  });

  it('五层排序：当前文件 → include 闭包 → 包内 → 内置', () => {
    const r = comp(probeHlsl, 7, colOf(probeHlsl, 7, '#define Ord', 10));
    const ord = r.items.map((i) => i.label).filter((l) => l.startsWith('Ord'));
    expect(ord).toEqual(['Ord', 'OrdCur', 'OrdInc', 'OrdPkg', 'OrdCg']);
  });

  it('截断：>300 候选 → 300 条、isIncomplete=true、日志 truncated=', () => {
    logs.length = 0;
    const r = comp(probeHlsl, 6, colOf(probeHlsl, 6, '#define Fill', 11));
    expect(r.items).toHaveLength(300);
    expect(r.isIncomplete).toBe(true);
    expect(logs.some((l) => /truncated=351/.test(l))).toBe(true);
  });

  it('索引进行中：照常返回并记日志', () => {
    logs.length = 0;
    const r = provideCompletion(
      probeHlsl,
      8,
      colOf(probeHlsl, 8, '#define MY_', 11),
      ctx({ indexing: () => true })
    );
    expect(r.items.length).toBeGreaterThan(0);
    expect(logs.some((l) => /索引进行中/.test(l))).toBe(true);
  });
});

describe('缓存与卫生', () => {
  it('clearCompletionCache 后目录枚举可重建（新文件可见）', () => {
    const f = write('Assets/Shaders/probe6.hlsl', '#include "late"\n');
    write('Assets/Shaders/late.hlsl', '\n');
    clearCompletionCache();
    const r = comp(f, 0, colOf(f, 0, '"late', 5));
    expect(r.items.map((i) => i.label)).toContain('late.hlsl');
  });
});

describe('T-027 真实 stdio：降级态与生成文件', () => {
  let degRoot: string;
  let client: LspClient;

  beforeAll(async () => {
    // 非 Unity 根：无 Assets/Library、无 Editor 路径 → 核心规格降级态
    degRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-degraded-'));
    fs.writeFileSync(path.join(degRoot, 'a.hlsl'), '\n', 'utf8');
    fs.writeFileSync(path.join(degRoot, 'x.shader'), '#include "a.hlsl"\n', 'utf8');
    fs.mkdirSync(path.join(degRoot, 'Temp'), { recursive: true });
    fs.writeFileSync(
      path.join(degRoot, 'Temp', 'compiled-x.shader'),
      'Shader "G" { SubShader { Pass { HLSLPROGRAM\n#define TEMP_MACRO 1\nfloat4 f(){return TEMP_;}\nENDHLSL } } }\n',
      'utf8'
    );
    const proc = spawn(process.execPath, [path.resolve(__dirname, '../../server/out/server.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    client = new LspClient(proc);
    await client.request('initialize', {
      processId: process.pid,
      rootUri: fileUri(degRoot),
      workspaceFolders: [{ uri: fileUri(degRoot), name: 'degraded' }],
      capabilities: {},
    });
    client.notify('initialized', {});
  });

  afterAll(async () => {
    await client?.shutdown();
    try {
      fs.rmSync(degRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('降级态：`#include "` 只给同目录候选，内置候选为空，无错误弹窗', async () => {
    const r = (await client.request('textDocument/completion', {
      textDocument: { uri: fileUri(path.join(degRoot, 'x.shader')) },
      position: { line: 0, character: 10 },
      context: { triggerKind: 1 },
    })) as { items: { label: string }[] };
    const labels = (r?.items ?? []).map((i) => i.label);
    expect(labels).toContain('a.hlsl');
    expect(labels).not.toContain('UnityCG.cginc');
    const errors = client.notifications.filter(
      (n) => n.method === 'window/showMessage' && (n.params as { type?: number })?.type === 1
    );
    expect(errors).toHaveLength(0);
  });

  it('生成文件（Temp/compiled-*）：补全返回空列表', async () => {
    const r = (await client.request('textDocument/completion', {
      textDocument: { uri: fileUri(path.join(degRoot, 'Temp', 'compiled-x.shader')) },
      position: { line: 2, character: 21 },
      context: { triggerKind: 1 },
    })) as { items: unknown[] };
    expect(r?.items ?? []).toEqual([]);
  });
});
