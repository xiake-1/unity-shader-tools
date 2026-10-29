/** M2 转到定义单测（T-014～T-017）
 *
 * 语料是自包含 fixture 工程（Assets / Library/PackageCache / EditorFake/Data/CGIncludes）。
 * 断言面：多义优先级与截断、存在性校验、局部作用域与遮蔽、成员访问、`#pragma` 与 include 跳转、
 * 以及「无定义面」（注释 / 状态命令 / 字面量 / 语义名）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import type { Location } from 'vscode-languageserver';

import { SymbolIndex } from '../../server/out/symbolIndex.js';
import { DocumentStore } from '../../server/out/documentStore.js';
import { provideDefinition, clearDefinitionCache } from '../../server/out/definition.js';
import type { IncludeContext } from '../../server/out/includeResolver.js';

let root: string; // fixture 工程根
let editorRoot: string; // 假 Unity Editor
let mainShader: string;
let inc1: string;
let inc2: string;
let pkgFile: string;
let cgFile: string;
let goneFile: string;
let index: SymbolIndex;
let store: DocumentStore;
import type { DefinitionContext } from '../../server/out/definition.js';
let includeCtx: IncludeContext;
let logs: string[];

const MAIN = [
  'Shader "M2/Demo"', //                          0
  '{', //                                         1
  '  Properties { _MainTex("Tex", 2D) = "white" {} }', // 2
  '  SubShader', //                               3
  '  {', //                                       4
  '    Pass', //                                  5
  '    {', //                                     6
  '      Cull Off ZWrite On', //                  7
  '      // comment mentions _MainTex and Helper here', // 8
  '      HLSLPROGRAM', //                         9
  '      #include "inc.hlsl"', //                 10
  '      #include "Assets/Shaders/inc2.hlsl"', // 11
  '      #include "Packages/com.unity.render-pipelines.core/ShaderLibrary/SpaceTransforms.hlsl"', // 12
  '      #include "UnityCG.cginc"', //            13
  '      #pragma vertex vert', //                 14
  '      #pragma fragment frag', //               15
  '      TEXTURE2D(_MainTex);', //                16
  '      SAMPLER(sampler_MainTex);', //           17
  '      struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };', // 18
  '      v2f i;', //                              19
  '      float4 frag(v2f IN) : SV_Target', //     20
  '      {', //                                   21
  '        float d = _Outer;', //                 22
  '        float e = d;', //                      23
  '        {', //                                 24
  '          float d = 2.0;', //                  25
  '          float f = d;', //                    26
  '        }', //                                 27
  '        float4 c = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, IN.uv);', // 28
  '        float2 q = i.uv;', //                  29
  '        float2 r = i.uv.x;', //                30
  '        float2 s = SharedFn();', //            31
  '        float2 t = Dup2();', //                32
  '        float2 u = NoSuchSym();', //           33
  '        float2 w = UnknownVar.uv;', //         34
  '        float z = DupTwelve();', //            35
  '        float2 g = GoneAway();', //            36
  '        return c + q.x + r + s + t;', //       37
  '      }', //                                   38
  '      ENDHLSL', //                             39
  '    }', //                                     40
  '  }', //                                       41
  '}', //                                         42
  '',
].join('\n');

const INC1 = [
  'float2 Helper() { return float2(0, 0); }', // 0
  'float2 Dup2() { return float2(1, 1); }', //   1
  'float2 SharedFn() { return float2(2, 2); }', // 2 ← 工程内
  'float4 vert(float4 pos : SV_POSITION) : SV_POSITION { return pos; }', // 3
  '',
].join('\n');

const INC2 = [
  'float2 Dup2() { return float2(3, 3); }', // 0 ← 第二个 include
  'float _Outer;', // 1
  '',
].join('\n');

const PKG = [
  'float2 SharedFn() { return float2(4, 4); }', // 0 ← 包内
  'float4 TransformWorldToHClip(float3 w) { return float4(w, 1); }', // 1
  '',
].join('\n');

const CG = [
  'float2 SharedFn() { return float2(5, 5); }', // 0 ← 内置
  'float4 UnityObjectToClipPos(float3 p) { return float4(p, 1); }', // 1
  '',
].join('\n');

function write(rel: string, text: string): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

/** 文本里第 n 次出现 needle 的位置（0 基行列），offset 用于把光标推到 needle 内部的某个 token */
function posOf(text: string, needle: string, occurrence = 1, offset = 0): { line: number; character: number } {
  let idx = -1;
  for (let i = 0; i < occurrence; i++) {
    idx = text.indexOf(needle, idx + 1);
    if (idx < 0) throw new Error(`fixture 里找不到 "${needle}" 第 ${occurrence} 次出现`);
  }
  const before = text.slice(0, idx + offset);
  const line = before.split('\n').length - 1;
  const lastNl = before.lastIndexOf('\n');
  return { line, character: idx + offset - lastNl - 1 };
}

function ctx(overrides: Partial<DefinitionContext> = {}): DefinitionContext {
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

function def(file: string, needle: string, occurrence = 1, offset = 0): Location[] {
  const text = store.get(file)?.text ?? fs.readFileSync(file, 'utf8');
  const { line, character } = posOf(text, needle, occurrence, offset);
  return provideDefinition(file, line, character, ctx());
}

const uri = (p: string): string => pathToFileURL(p).toString();

/** 取 Location 指向的原文片段，用来断言「落在名字本身而不是整条声明」 */
function textAt(loc: Location): string {
  const file = fileURLToPath(loc.uri); // 跨平台：Windows 盘符与 POSIX 路径都走标准解码
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const l = lines[loc.range.start.line] ?? '';
  return l.slice(loc.range.start.character, loc.range.end.character);
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-def-'));
  editorRoot = path.join(root, 'EditorFake');

  mainShader = write('Assets/Shaders/main.shader', MAIN);
  inc1 = write('Assets/Shaders/inc.hlsl', INC1);
  inc2 = write('Assets/Shaders/inc2.hlsl', INC2);
  pkgFile = write(
    'Library/PackageCache/com.unity.render-pipelines.core@14.0.0/ShaderLibrary/SpaceTransforms.hlsl',
    PKG
  );
  cgFile = write('EditorFake/Data/CGIncludes/UnityCG.cginc', CG);
  goneFile = write('Assets/Shaders/gone.hlsl', 'float2 GoneAway() { return float2(0,0); }\n');

  for (let i = 0; i < 12; i++) {
    write(`Assets/Shaders/dup${i}.hlsl`, `float DupTwelve() { return ${i}; }\n`);
  }

  includeCtx = {
    projectRoot: root,
    cgIncludesDir: path.join(editorRoot, 'Data', 'CGIncludes'),
    packageCacheDir: path.join(root, 'Library', 'PackageCache'),
  };

  index = new SymbolIndex();
  store = new DocumentStore();
  const files = [mainShader, inc1, inc2, pkgFile, cgFile, goneFile];
  for (let i = 0; i < 12; i++) files.push(path.join(root, 'Assets', 'Shaders', `dup${i}.hlsl`));
  for (const f of files) index.indexFile(f, fs.readFileSync(f, 'utf8'));
  logs = [];
});

afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('T-014 核心：符号定位、优先级、截断、存在性校验', () => {
  it('`_MainTex` 用法跳回声明：Properties 行在前，宏声明行也在结果里', () => {
    const r = def(mainShader, 'SAMPLE_TEXTURE2D(_MainTex', 1, 18);
    expect(r.length).toBeGreaterThanOrEqual(2);
    expect(r[0].range.start.line).toBe(2); // Properties 声明行
    expect(r.map((l) => l.range.start.line)).toContain(16); // TEXTURE2D(_MainTex);
    expect(textAt(r[0])).toBe('_MainTex');
  });

  it('同名跨层：工程内 → 包内 → 内置', () => {
    const r = def(mainShader, 'SharedFn()', 1, 3);
    expect(r.map((l) => l.uri)).toEqual([uri(inc1), uri(pkgFile), uri(cgFile)]);
  });

  it('include 闭包内部按 include 出现顺序：inc.hlsl 先于 inc2.hlsl', () => {
    const r = def(mainShader, 'Dup2()', 1, 3);
    expect(r.map((l) => l.uri)).toEqual([uri(inc1), uri(inc2)]);
  });

  it('同名 >10 截断到 10 并记 truncated', () => {
    logs.length = 0;
    const r = def(mainShader, 'DupTwelve()', 1, 5);
    expect(r).toHaveLength(10);
    expect(logs.some((l) => /truncated=12/.test(l))).toBe(true);
  });

  it('返回前存在性校验：目标文件被删则不出现', () => {
    expect(def(mainShader, 'GoneAway()', 1, 4)[0].uri).toBe(uri(goneFile));
    fs.rmSync(goneFile, { force: true });
    index.removeFile(goneFile);
    expect(def(mainShader, 'GoneAway', 1)).toHaveLength(0);
  });

  it('未命中且索引进行中：返回空并记「索引进行中」', () => {
    logs.length = 0;
    const text = MAIN;
    const { line, character } = posOf(text, 'NoSuchSym()', 1, 3);
    const r = provideDefinition(mainShader, line, character, ctx({ indexing: () => true }));
    expect(r).toHaveLength(0);
    expect(logs.some((l) => /索引进行中/.test(l))).toBe(true);
  });
});

describe('T-015 局部变量与参数（就近优先）', () => {
  it('内层同名遮蔽：块内引用命中内层声明', () => {
    const r = def(mainShader, 'float f = d;', 1, 10);
    expect(r[0].range.start.line).toBe(25);
    expect(textAt(r[0])).toBe('d');
  });

  it('外层引用命中外层声明', () => {
    const r = def(mainShader, 'float e = d;', 1, 10);
    expect(r[0].range.start.line).toBe(22);
  });

  it('函数参数：`IN.uv` 的 IN 跳到参数声明', () => {
    const r = def(mainShader, 'IN.uv', 1, 1);
    expect(r[0].range.start.line).toBe(20);
    expect(r[0].uri).toBe(uri(mainShader));
    expect(textAt(r[0])).toBe('IN');
  });
});

describe('T-016 成员访问（单层浅推断）', () => {
  it('`i.uv` 的 uv → struct v2f 的字段 uv', () => {
    const r = def(mainShader, 'i.uv;', 1, 2);
    expect(r).toHaveLength(1);
    expect(r[0].range.start.line).toBe(18);
    expect(textAt(r[0])).toBe('uv');
  });

  it('链式 `i.uv.x` 的 x 返回空（类型驱动属 M5）', () => {
    expect(def(mainShader, 'i.uv.x', 1, 5)).toHaveLength(0);
  });

  it('未知变量的成员访问返回空', () => {
    expect(def(mainShader, 'UnknownVar.uv', 1, 11)).toHaveLength(0);
  });

  it('字段名在别的 struct 里不会串味（owner 过滤）', () => {
    const other = write('Assets/Shaders/other.hlsl', 'struct Other { float2 uv; };\nOther o;\nfloat2 use() { return o.uv; }\n');
    index.indexFile(other, fs.readFileSync(other, 'utf8'));
    const r = provideDefinition(other, 2, 24, ctx());
    expect(r).toHaveLength(1);
    expect(r[0].range.start.line).toBe(0);
  });
});

describe('T-017 ShaderLab 侧：#pragma 与 include 跳转', () => {
  it('#pragma vertex vert → inc.hlsl 里的 vert 定义', () => {
    const r = def(mainShader, '#pragma vertex vert', 1, 16);
    expect(r).toHaveLength(1);
    expect(r[0].uri).toBe(uri(inc1));
    expect(r[0].range.start.line).toBe(3);
    expect(textAt(r[0])).toBe('vert');
  });

  it('#pragma 的非函数关键字（only_renderers）不跳', () => {
    const f = write('Assets/Shaders/pragma.hlsl', '#pragma only_renderers d3d11\nfloat onlyfn() { return 1; }\n');
    expect(provideDefinition(f, 0, 24, ctx())).toHaveLength(0);
  });

  it('include 四类各得目标文件', () => {
    expect(def(mainShader, '#include "inc.hlsl"', 1, 12)[0].uri).toBe(uri(inc1));
    expect(def(mainShader, '#include "Assets/Shaders/inc2.hlsl"', 1, 22)[0].uri).toBe(uri(inc2));
    expect(def(mainShader, '#include "Packages/com.unity.render-pipelines.core', 1, 40)[0].uri).toBe(uri(pkgFile));
    expect(def(mainShader, '#include "UnityCG.cginc"', 1, 12)[0].uri).toBe(uri(cgFile));
  });

  it('include 未命中返回空（不发诊断，M4 消费）', () => {
    const f = write('Assets/Shaders/missing.hlsl', '#include "Nope.hlsl"\n');
    expect(provideDefinition(f, 0, 12, ctx())).toHaveLength(0);
  });
});

describe('无定义面与 .hlsl 文档', () => {
  it('注释 / 状态命令 / 内置类型 / 语义名 → 空', () => {
    expect(def(mainShader, 'comment mentions _MainTex', 1, 20)).toHaveLength(0);
    expect(def(mainShader, 'Cull Off', 1, 2)).toHaveLength(0);
    expect(def(mainShader, 'float d = _Outer;', 1, 2)).toHaveLength(0);
    expect(def(mainShader, 'SV_POSITION;', 1, 2)).toHaveLength(0);
  });

  it('Properties 块里的属性名本身可跳（落在自身声明的名字上）', () => {
    const r = def(mainShader, '_MainTex("Tex"', 1, 1);
    expect(r[0].uri).toBe(uri(mainShader));
    expect(r[0].range.start.line).toBe(2);
    expect(textAt(r[0])).toBe('_MainTex');
  });

  it('.hlsl 文档内的跳转（打开态走 store 的树）', () => {
    store.open(inc1, INC1);
    const r = def(inc1, 'Helper()', 1, 3);
    expect(r[0].uri).toBe(uri(inc1));
    expect(r[0].range.start.line).toBe(0);
    store.close(inc1);
  });

  it('不存在的文件与生成文件不响应', () => {
    clearDefinitionCache();
    expect(provideDefinition(path.join(root, 'Assets', 'nope.shader'), 0, 0, ctx())).toHaveLength(0);
    expect(
      provideDefinition(path.join(root, 'Temp', 'compiled-x.shader'), 0, 0, ctx())
    ).toHaveLength(0);
  });
});
