/** 悬停单测（T-035，规格 feature-hover）
 *
 * fixture 与 completion.test.ts 同构（更小）：Assets + PackageCache + CGIncludes。
 * 断言面：符号悬停（声明行代码块 + 邻近注释/macroTable 文档、多声明取优）、
 * 语义悬停（struct 字段与函数返回值两处、大小写不敏感、未知语义通用说明）、
 * 空结果面（关键字、未声明、ShaderLab 外壳）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Hover } from 'vscode-languageserver';
import { SymbolIndex } from '../../server/out/symbolIndex.js';
import { DocumentStore } from '../../server/out/documentStore.js';
import { provideHover } from '../../server/out/hover.js';
import { semanticDescription } from '../../server/out/semanticTable.js';
import type { HoverContext } from '../../server/out/hover.js';
import type { IncludeContext } from '../../server/out/includeResolver.js';

let root: string;
let mainShader: string;
let index: SymbolIndex;
let store: DocumentStore;
let includeCtx: IncludeContext;

const MAIN = [
  'Shader "H/Demo"', //                                        0
  '{', //                                                      1
  '  Properties { _HoverProp("P", 2D) = "white" {} }', //       2
  '  SubShader', //                                            3
  '  {', //                                                    4
  '    Pass', //                                               5
  '    {', //                                                  6
  '      HLSLPROGRAM', //                                      7
  '      #include "hinc.hlsl"', //                             8
  '      struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; float w : MY_CHANNEL0; };', // 9
  '      float4 frag(v2f IN) : SV_Target', //                  10
  '      {', //                                                11
  '        float4 c = TransformWorldToHClip(0);', //           12
  '        float4 t = TEXTURE2D(_HoverProp);', //              13
  '        float4 p = DupName();', //                          14
  '        float4 q = nosuchthing;', //                        15
  '        return c + t + p + q + IN.uv.x + IN.pos.w;', //     16
  '      }', //                                                17
  '      ENDHLSL', //                                          18
  '    }', //                                                  19
  '  }', //                                                    20
  '}', //                                                      21
  '',
].join('\n');

const INC = [
  'float4 DupName() { return 0; }', // 0 ← 与 pkg 同名：闭包(1) 优先于包(3)
  '#define TEXTURE2D(t) t##_tex', //  1 ← 无邻近注释：文档走 macroTable 兜底
  '',
].join('\n');

const PKG = [
  '// Transforms a world-space position to clip space.', // 0
  'float4 TransformWorldToHClip(float3 positionWS) { return float4(0, 0, 0, 1); }', // 1
  'float4 DupName() { return 1; }', // 2 ← 第二处同名声明（rank 3）
  '',
].join('\n');

function write(rel: string, text: string): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

function ctx(): HoverContext {
  return {
    index,
    store,
    includeCtx,
    projectRoot: root,
    log: () => undefined,
    indexing: () => false,
  };
}

function hov(file: string, line: number, character: number): Hover | null {
  return provideHover(file, line, character, ctx());
}

function colOf(file: string, line: number, needle: string, offset: number): number {
  const text = fs.readFileSync(file, 'utf8').split('\n')[line];
  const idx = text.indexOf(needle);
  if (idx < 0) throw new Error(`第 ${line} 行找不到 "${needle}"`);
  return idx + offset;
}

function mdOf(h: Hover | null): string {
  if (!h) return '';
  const c = h.contents as { value?: string } | string;
  return typeof c === 'string' ? c : (c.value ?? '');
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hover-'));
  mainShader = write('Assets/Shaders/main.shader', MAIN);
  write('Assets/Shaders/hinc.hlsl', INC);
  write(
    'Library/PackageCache/com.unity.render-pipelines.core@14.0.0/ShaderLibrary/SpaceTransforms.hlsl',
    PKG
  );
  includeCtx = {
    projectRoot: root,
    cgIncludesDir: path.join(root, 'EditorFake', 'Data', 'CGIncludes'),
    packageCacheDir: path.join(root, 'Library', 'PackageCache'),
  };
  index = new SymbolIndex();
  store = new DocumentStore();
  const pkgFile = path.join(
    root,
    'Library',
    'PackageCache',
    'com.unity.render-pipelines.core@14.0.0',
    'ShaderLibrary',
    'SpaceTransforms.hlsl'
  );
  for (const f of [mainShader, path.join(root, 'Assets', 'Shaders', 'hinc.hlsl'), pkgFile]) {
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

describe('符号悬停', () => {
  it('包内函数：代码块含声明行、文档来自邻近注释', () => {
    const h = hov(mainShader, 12, colOf(mainShader, 12, 'TransformWorldToHClip', 5));
    const md = mdOf(h);
    expect(md).toContain('```hlsl');
    expect(md).toContain('float4 TransformWorldToHClip(float3 positionWS)');
    expect(md).toContain('clip space');
  });

  it('宏（无邻近注释）：文档走 macroTable 兜底', () => {
    const h = hov(mainShader, 13, colOf(mainShader, 13, 'TEXTURE2D', 4));
    expect(mdOf(h)).toContain('2D 纹理');
  });

  it('Properties 属性：代码块含 Properties 声明行', () => {
    const h = hov(mainShader, 13, colOf(mainShader, 13, '_HoverProp', 4));
    expect(mdOf(h)).toContain('_HoverProp("P", 2D)');
  });

  it('多处声明：按优先级取闭包(1)一条并注明共 2 处', () => {
    const h = hov(mainShader, 14, colOf(mainShader, 14, 'DupName', 3));
    const md = mdOf(h);
    expect(md).toContain('return 0;'); // hinc.hlsl（闭包 rank 1）优先于 pkg（rank 3）
    expect(md).toContain('共 2 处声明');
  });

  it('hover range = 词范围', () => {
    const h = hov(mainShader, 12, colOf(mainShader, 12, 'TransformWorldToHClip', 5));
    expect(h?.range).toEqual({
      start: { line: 12, character: colOf(mainShader, 12, 'TransformWorldToHClip', 0) },
      end: { line: 12, character: colOf(mainShader, 12, 'TransformWorldToHClip', 21) },
    });
  });
});

describe('语义悬停', () => {
  it('struct 字段 `SV_POSITION`：系统值语义描述', () => {
    const md = mdOf(hov(mainShader, 9, colOf(mainShader, 9, 'SV_POSITION', 3)));
    expect(md).toContain('系统值语义');
    expect(md).toContain('裁剪空间');
  });

  it('函数返回值 `SV_Target`：渲染目标描述', () => {
    const md = mdOf(hov(mainShader, 10, colOf(mainShader, 10, 'SV_Target', 3)));
    expect(md).toContain('渲染目标');
  });

  it('大小写不敏感：`SV_Position` 与 `SV_POSITION` 同词条', () => {
    const d = semanticDescription('SV_Position');
    expect(d).toBe(semanticDescription('SV_POSITION'));
    expect(d).toContain('裁剪空间');
  });

  it('约定语义 `TEXCOORD0`：插值通道描述', () => {
    expect(mdOf(hov(mainShader, 9, colOf(mainShader, 9, 'TEXCOORD0', 4)))).toContain('插值');
  });

  it('未知语义 `MY_CHANNEL0`：通用说明（非 null）', () => {
    expect(mdOf(hov(mainShader, 9, colOf(mainShader, 9, 'MY_CHANNEL0', 4)))).toContain(
      '用户自定义数据流语义'
    );
  });
});

describe('空结果面', () => {
  it('内置类型名 `float4` → null', () => {
    expect(hov(mainShader, 12, colOf(mainShader, 12, 'float4 c', 3))).toBeNull();
  });

  it('未声明标识符 → null', () => {
    expect(hov(mainShader, 15, colOf(mainShader, 15, 'nosuchthing', 4))).toBeNull();
  });

  it('ShaderLab 外壳标识符 → null', () => {
    expect(hov(mainShader, 3, colOf(mainShader, 3, 'SubShader', 3))).toBeNull();
  });

  it('注释/字符串内 → null', () => {
    expect(hov(mainShader, 0, colOf(mainShader, 0, '"H/Demo"', 3))).toBeNull();
  });
});
