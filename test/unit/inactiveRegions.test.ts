/** T-045：死分支 Range 收集（Range 口径经用户确认：只灰分支体，不含条件行） */
import { describe, it, expect } from 'vitest';
import { parseHlslFile, type SyntaxNode } from '../../server/src/parser';
import { treesForFile } from '../../server/src/diagnostics';
import { collectInactiveRegions, type InactiveRegion } from '../../server/src/inactiveRegions';

function regions(src: string, disabled: string[]): InactiveRegion[] {
  const tree = parseHlslFile(src);
  return collectInactiveRegions(tree.rootNode, src, { disabled: new Set(disabled) });
}

/** 断言两组 Range 互不重叠 */
function assertNoOverlap(rs: InactiveRegion[]): void {
  const sorted = [...rs].sort((a, b) => a.start.line - b.start.line);
  for (let i = 1; i < sorted.length; i++) {
    expect(
      sorted[i].start.line > sorted[i - 1].end.line,
      `重叠：${JSON.stringify(sorted[i - 1])} vs ${JSON.stringify(sorted[i])}`
    ).toBe(true);
  }
}

describe('Range 口径（经用户确认）', () => {
  const src = [
    'float head;',
    '#if SHADER_API_GLES30',
    '  float a;',
    '  float b;',
    '#endif',
    'float tail;',
  ].join('\n');

  it('关键字在集合 → 分支体 1 条 Range', () => {
    const rs = regions(src, ['SHADER_API_GLES30']);
    expect(rs.length).toBe(1);
    expect(rs[0].condition).toBe('SHADER_API_GLES30');
  });

  it('不在集合 → 零 Range', () => {
    expect(regions(src, ['OTHER'])).toEqual([]);
  });

  it('起点 = 条件行下一行行首；终点 = `#endif` 前一行行末', () => {
    const [r] = regions(src, ['SHADER_API_GLES30']);
    expect(r.start).toEqual({ line: 2, character: 0 });
    expect(r.end).toEqual({ line: 3, character: '  float b;'.length });
  });

  it('条件行与 `#endif` 行都不落在任何 Range 内', () => {
    const rs = regions(src, ['SHADER_API_GLES30']);
    for (const line of [1, 4]) {
      expect(rs.some((r) => r.start.line <= line && line <= r.end.line), `第 ${line} 行被覆盖`).toBe(false);
    }
  });
});

describe('#ifdef / #ifndef 与 #else', () => {
  it('#ifdef X（X 在集合）→ 灰 `#ifdef` 分支体，`#else` 体不灰', () => {
    const src = ['#ifdef X', '  float dead;', '#else', '  float live;', '#endif'].join('\n');
    const rs = regions(src, ['X']);
    expect(rs.length).toBe(1);
    expect(rs[0].start.line).toBe(1);
    expect(rs[0].end.line).toBe(1);
    expect(rs[0].condition).toBe('defined(X)');
  });

  it('#ifndef X（X 在集合）→ 反之：`#else` 体灰', () => {
    const src = ['#ifndef X', '  float live;', '#else', '  float dead;', '#endif'].join('\n');
    const rs = regions(src, ['X']);
    expect(rs.length).toBe(1);
    expect(rs[0].start.line).toBe(3);
    expect(rs[0].condition).toBe('!defined(X)');
  });

  it('#ifdef X（X 不在集合）→ 零 Range', () => {
    const src = ['#ifdef X', '  float a;', '#else', '  float b;', '#endif'].join('\n');
    expect(regions(src, ['Y'])).toEqual([]);
  });
});

describe('#elif 链口径（规格范围 4）', () => {
  const chain = (a: string, b: string) =>
    ['#if ' + a, '  float one;', '#elif ' + b, '  float two;', '#else', '  float three;', '#endif'].join('\n');

  it('前支假、当前支也假 → 两支都灰；`#else` 是激活分支不灰', () => {
    const rs = regions(chain('AAA', 'BBB'), ['AAA', 'BBB']);
    expect(rs.map((r) => r.start.line)).toEqual([1, 3]);
    assertNoOverlap(rs);
  });

  it('前支假、当前支未知 → 只灰前支，其后不灰', () => {
    const rs = regions(chain('AAA', 'UNKNOWN_X'), ['AAA']);
    expect(rs.map((r) => r.start.line)).toEqual([1]);
  });

  it('前支未知 → 当前及其后全部不灰（不猜激活分支）', () => {
    const rs = regions(chain('UNKNOWN_X', 'BBB'), ['BBB']);
    expect(rs).toEqual([]);
  });

  it('前支真（文件内 `#define`）→ 其后一律不灰', () => {
    const src = ['#define ON 1', '#if ON', '  float live;', '#elif CCC', '  float dead;', '#endif'].join('\n');
    expect(regions(src, ['CCC'])).toEqual([]);
  });
});

describe('嵌套口径：外层假 → 只产外层 Range', () => {
  const src = [
    '#if DEAD_OUT',
    '  float a;',
    '  #if DEAD_IN',
    '    float b;',
    '  #endif',
    '  float c;',
    '#endif',
  ].join('\n');

  it('只产 1 条外层 Range，无重叠', () => {
    const rs = regions(src, ['DEAD_OUT', 'DEAD_IN']);
    expect(rs.length).toBe(1);
    expect(rs[0].start.line).toBe(1);
    expect(rs[0].end.line).toBe(5);
    assertNoOverlap(rs);
  });

  it('外层未知、内层假 → 只灰内层', () => {
    const rs = regions(src, ['DEAD_IN']);
    expect(rs.length).toBe(1);
    expect(rs[0].start.line).toBe(3);
    expect(rs[0].end.line).toBe(3);
  });
});

describe('边界与真实形态', () => {
  it('空分支体不产 Range', () => {
    expect(regions(['#if DEAD', '#endif'].join('\n'), ['DEAD'])).toEqual([]);
  });

  it('同一文件多处死分支各自产 Range 并按文档顺序', () => {
    const src = ['#if A', 'float x;', '#endif', 'float mid;', '#if B', 'float y;', '#endif'].join('\n');
    const rs = regions(src, ['A', 'B']);
    expect(rs.map((r) => r.start.line)).toEqual([1, 5]);
  });

  it('真实语料形态：`#if defined(SHADOWS_SHADOWMASK) && (UNITY_ALLOWED_MRT_COUNT > 4)` 不可判定 → 不灰', () => {
    const src = [
      '#if defined(SHADOWS_SHADOWMASK) && (UNITY_ALLOWED_MRT_COUNT > 4)',
      '    outShadowMask = 1;',
      '#endif',
    ].join('\n');
    expect(regions(src, ['SHADOWS_SHADOWMASK'])).toEqual([]);
  });

  it('ShaderLab 外壳里的 `#if` 不处理；`.shader` 走虚拟 HLSL 树（与诊断同一口径）', () => {
    const src = ['Shader "T"', '{', '  SubShader', '  {', '    Pass', '    {', '      HLSLPROGRAM', '      #if DEAD', '      float a;', '      #endif', '      ENDHLSL', '    }', '  }', '}'].join('\n');
    const trees = treesForFile('t.shader', src);
    const hlsl = trees.filter((t) => t.kind === 'hlsl');
    expect(hlsl.length).toBe(1);
    const rs = collectInactiveRegions(hlsl[0].tree.rootNode, src, { disabled: new Set(['DEAD']) });
    expect(rs.length).toBe(1);
    expect(rs[0].start.line).toBe(8);
    // ShaderLab 树本身不产 preproc 节点
    const labTree = trees.find((t) => t.kind === 'shaderlab') as { tree: { rootNode: SyntaxNode } };
    expect(collectInactiveRegions(labTree.tree.rootNode, src, { disabled: new Set(['DEAD']) })).toEqual([]);
  });
});
