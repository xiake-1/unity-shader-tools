/** T-028 occurrence 收集单测（规格 feature-rename）
 *
 * fixture 工程覆盖：Properties 与 HLSL 同名归并、宏参数位（TEXTURE2D(_MainTex)）、
 * 注释/字符串/语义不计数、`sampler_<名>` 关联、跨文件、大小写敏感、unresolved 日志。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SymbolIndex } from '../../server/out/symbolIndex.js';
import { DocumentStore } from '../../server/out/documentStore.js';
import { collectOccurrences, samplerOccurrences } from '../../server/out/occurrences.js';
import type { OccurrenceContext } from '../../server/out/occurrences.js';

let root: string;
let mainShader: string;
let otherHlsl: string;
let index: SymbolIndex;
let store: DocumentStore;
let logs: string[];
let ctx: OccurrenceContext;

const MAIN = [
  'Shader "Occ/Demo"', //                                             0
  '{', //                                                            1
  '  Properties { _MainTex("Tex", 2D) = "white" {} }', //            2  ← word 声明
  '  SubShader', //                                                  3
  '  {', //                                                          4
  '    Pass', //                                                     5
  '    {', //                                                        6
  '      CGPROGRAM', //                                              7
  '      TEXTURE2D(_MainTex);', //                                   8  ← 宏参数位 identifier
  '      SAMPLER(sampler_MainTex);', //                              9
  '      // _MainTex 出现在注释里：不计数', //                        10
  '      float4 frag(float2 uv : TEXCOORD0) : SV_Target', //         11
  '      {', //                                                      12
  '        return SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, uv);', // 13
  '      }', //                                                      14
  '      ENDCG', //                                                  15
  '    }', //                                                        16
  '  }', //                                                          17
  '}', //                                                            18
  '',
].join('\n');

const OTHER = [
  'float4 _MainTex;', //                          0  ← 声明（另一文件）
  'float2 scaleUV(float2 uv) { return uv * _MainTex.xy; }', // 1 ← 用法
  'float2 nope() { return float2(0,0); } // _MainTex 在注释', //  2 ← 注释不计数
  '#define _MAINTEX_UPPER 1', //                  3 ← 大小写不同：不计数
  'float4 sampleIt() { return _maintex_lower; }', // 4 ← 大小写不同：不计数
  '',
].join('\n');

function write(rel: string, text: string): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-occ-'));
  mainShader = write('Assets/main.shader', MAIN);
  otherHlsl = write('Assets/other.hlsl', OTHER);
  index = new SymbolIndex();
  store = new DocumentStore();
  logs = [];
  ctx = { index, store, log: (m) => logs.push(m) };
  for (const f of [mainShader, otherHlsl]) {
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

describe('T-028 occurrence 收集', () => {
  it('逻辑符号合并视图：Properties word + HLSL token 一次收齐', () => {
    const r = collectOccurrences('_MainTex', ctx);
    const inMain = r.occurrences.filter((o) => o.file === mainShader);
    // 期望 main：L2 Properties、L8 宏参数位、L13 用法 = 3 处；注释 L10 不算
    expect(inMain.map((o) => o.range.start.line)).toEqual([2, 8, 13]);
    const inOther = r.occurrences.filter((o) => o.file === otherHlsl);
    expect(inOther.map((o) => o.range.start.line)).toEqual([0, 1]);
  });

  it('宏参数位计入：TEXTURE2D(_MainTex) 里的 _MainTex', () => {
    const r = collectOccurrences('_MainTex', ctx);
    const at8 = r.occurrences.find((o) => o.file === mainShader && o.range.start.line === 8);
    expect(at8).toBeTruthy();
    expect(at8!.range.start.character).toBe(16); // `      TEXTURE2D(` 之后
  });

  it('声明位标记 decl：与索引 location 对齐', () => {
    const r = collectOccurrences('_MainTex', ctx);
    const decls = r.occurrences.filter((o) => o.decl);
    // 索引声明：main L2（property word）、main L8（宏声明）、other L0（变量声明）
    expect(decls.map((o) => `${path.basename(o.file)}:${o.range.start.line}`).sort()).toEqual([
      'main.shader:2',
      'main.shader:8',
      'other.hlsl:0',
    ]);
  });

  it('注释与字符串不计数（`_MainTex` 注释两处、字符串无）', () => {
    const r = collectOccurrences('_MainTex', ctx);
    expect(r.occurrences.some((o) => o.range.start.line === 10 && o.file === mainShader)).toBe(false);
    expect(r.occurrences.some((o) => o.range.start.line === 2 && o.file === otherHlsl)).toBe(false);
  });

  it('大小写敏感：`_maintex_lower` / `_MAINTEX_UPPER` 不混入', () => {
    const r = collectOccurrences('_MainTex', ctx);
    expect(r.occurrences.every((o) => o.range.start.line !== 3)).toBe(true);
    expect(r.occurrences.every((o) => o.range.start.line !== 4 || o.file !== otherHlsl)).toBe(true);
  });

  it('sampler_<名> 关联可查：sampler_MainTex 两处（声明 + 用法）', () => {
    const r = samplerOccurrences('_MainTex', ctx);
    expect(r.occurrences.map((o) => `${path.basename(o.file)}:${o.range.start.line}`)).toEqual([
      'main.shader:9',
      'main.shader:13',
    ]);
  });

  it('未索引到但同名出现的文件也覆盖（文本预筛 + 重解析）：新文件入索引后可见', () => {
    const late = write('Assets/late.hlsl', 'float v = _MainTex.x;\n');
    index.indexFile(late, fs.readFileSync(late, 'utf8'));
    const r = collectOccurrences('_MainTex', ctx);
    expect(r.occurrences.some((o) => o.file === late)).toBe(true);
  });

  it('打开文档编辑后即时反映（store 文本优先）', () => {
    store.open(otherHlsl, OTHER.replace('_MainTex_ST.xy', '_MainTex_ST.zz'));
    const r = collectOccurrences('_MainTex', ctx);
    const o1 = r.occurrences.find((o) => o.file === otherHlsl && o.range.start.line === 1);
    expect(o1).toBeTruthy();
    store.close(otherHlsl);
  });

  it('读不到的文件计入 unresolved 并记日志', () => {
    const ghost = path.join(root, 'Assets', 'gone.hlsl');
    index.indexFile(ghost, 'float _Ghost;\n');
    logs.length = 0;
    const r = collectOccurrences('_Ghost', ctx);
    expect(r.unresolved).toBe(1);
    expect(logs.some((l) => /unresolved=1/.test(l))).toBe(true);
    index.removeFile(ghost);
  });

  it('无命中：occurrences 为空且不解析（scanned=0）', () => {
    const r = collectOccurrences('NoSuchNameAnywhere', ctx);
    expect(r.occurrences).toEqual([]);
    expect(r.scanned).toBe(0);
  });
});
