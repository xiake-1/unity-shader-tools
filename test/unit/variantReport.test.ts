/**
 * T-070 变体分析纯函数（规格 feature-shader-name-index-and-variant-report 验收标准逐条对应）。
 *
 * 钉四件事：CST 口径（`preproc_call` → `preproc_directive` + `preproc_arg`，不得正则扫原文）、
 * 计数口径（+1 全 off / `_` 不重复计 / 去重记 dedup= / 内置组不参与相乘）、
 * shader_block 与 pass 收集、缺树时不静默出空表。
 */
import { describe, it, expect } from 'vitest';
import { parseShaderLab, parseHlslFile, extractProgramBodies, buildVirtualHlsl } from '../../server/src/parser';
import {
  analyzeVariants,
  buildKeywordGroup,
  collectPragmas,
  parsePragmaArg,
  variantDetailLines,
  variantSummaryLine,
} from '../../server/src/variantReport';

/** 与 `SymbolIndex.indexFile` 完全相同的取树方式：ShaderLab 树 + 虚拟 HLSL 文档的树。 */
function trees(shaderText: string) {
  const lab = parseShaderLab(shaderText);
  const virtual = buildVirtualHlsl(shaderText, extractProgramBodies(lab, shaderText));
  const hlsl = virtual.trim().length > 0 ? parseHlslFile(virtual) : null;
  return { lab, hlsl };
}

function pass(body: string[]): string {
  return ['    Pass', '    {', '      HLSLPROGRAM', ...body, '      ENDHLSL', '    }'].join('\n');
}

function shader(name: string, passes: string[]): string {
  return [`Shader "${name}"`, '{', '  SubShader', '  {', ...passes, '  }', '}', ''].join('\n');
}

describe('T-070 CST 口径', () => {
  it('pragma 取自 `preproc_call` 的 `preproc_directive` + `preproc_arg`（夹具断言 arg 原文）', () => {
    const text = shader('Fixtures/Cst', [pass(['      #pragma multi_compile _ A B'])]);
    const { hlsl } = trees(text);
    expect(hlsl).not.toBeNull();
    const sites = collectPragmas(hlsl!.rootNode);
    expect(sites.length).toBe(1);
    expect(sites[0].argText).toBe('multi_compile _ A B');
    expect(sites[0].parsed).toEqual({ kind: 'explicit', directive: 'multi_compile', rawKeywords: ['_', 'A', 'B'] });
    // 行号 = 原文行号（虚拟 HLSL 文档与原文行列一致，无需换算）
    expect(sites[0].line).toBe(text.split('\n').findIndex((l) => l.includes('#pragma')) + 1);
  });

  it('非 pragma 的预处理指令与无关 pragma 不进表', () => {
    const text = shader('Fixtures/Other', [
      pass(['      #include "Core.hlsl"', '      #define FOO 1', '      #pragma vertex vert', '      #pragma unknown_thing A B']),
    ]);
    const { hlsl } = trees(text);
    expect(collectPragmas(hlsl!.rootNode)).toEqual([]);
  });

  it('`parsePragmaArg` 三类判定：显式 / 显式 local / 内置组', () => {
    expect(parsePragmaArg('multi_compile A B')).toMatchObject({ kind: 'explicit', directive: 'multi_compile' });
    expect(parsePragmaArg('shader_feature_local _ D E')).toMatchObject({ kind: 'explicit', directive: 'shader_feature_local' });
    expect(parsePragmaArg('multi_compile_local A B')).toMatchObject({ kind: 'explicit', directive: 'multi_compile_local' });
    expect(parsePragmaArg('multi_compile_fwdbase')).toEqual({ kind: 'builtin', name: 'fwdbase' });
    expect(parsePragmaArg('multi_compile_fwdadd_fullshadows')).toEqual({ kind: 'builtin', name: 'fwdadd_fullshadows' });
    expect(parsePragmaArg('multi_compile_instancing _ A')).toEqual({ kind: 'builtin', name: 'instancing' });
    expect(parsePragmaArg('vertex vert')).toBeNull();
    expect(parsePragmaArg('')).toBeNull();
  });
});

describe('T-070 计数口径（四条都要钉住）', () => {
  it('`multi_compile A B C` → 组大小 4（含全 off）', () => {
    expect(buildKeywordGroup('multi_compile', ['A', 'B', 'C'], 1).size).toBe(4);
  });

  it('`shader_feature_local D E` → 3；两组相乘 → 12', () => {
    const text = shader('Fixtures/Count', [
      pass(['      #pragma multi_compile A B C', '      #pragma shader_feature_local D E']),
    ]);
    const [entry] = analyzeVariants(trees(text).lab.rootNode, 'x.shader', trees(text).hlsl?.rootNode);
    expect(entry.groups.map((g) => g.size)).toEqual([4, 3]);
    expect(entry.combinations).toBe(12);
    expect(entry.groups.map((g) => g.directive)).toEqual(['multi_compile', 'shader_feature_local']);
  });

  it('`multi_compile _ A B` → 3（`_` 不重复 +1）', () => {
    const text = shader('Fixtures/Off', [pass(['      #pragma multi_compile _ A B'])]);
    const [entry] = analyzeVariants(trees(text).lab.rootNode, 'x.shader', trees(text).hlsl?.rootNode);
    expect(entry.groups[0].size).toBe(3);
    expect(entry.groups[0].offMarker).toBe(true);
    expect(entry.groups[0].keywords).toEqual(['A', 'B']);
    expect(entry.combinations).toBe(3);
  });

  it('`multi_compile _ A A` → 2 且输出含 `dedup=1`', () => {
    const text = shader('Fixtures/Dedup', [pass(['      #pragma multi_compile _ A A'])]);
    const [entry] = analyzeVariants(trees(text).lab.rootNode, 'x.shader', trees(text).hlsl?.rootNode);
    expect(entry.groups[0].size).toBe(2);
    expect(entry.groups[0].dedup).toBe(1);
    expect(entry.dedupTotal).toBe(1);
    expect(variantSummaryLine(entry)).toContain('dedup=1');
  });

  it('内置组不参与相乘：显式 4 × 内置组 → 仍 4，输出含 `builtin-groups=1` 与 `unavailable`', () => {
    const text = shader('Fixtures/Builtin', [
      pass(['      #pragma multi_compile A B C', '      #pragma multi_compile_fwdbase', '      #pragma multi_compile_fog']),
    ]);
    const [entry] = analyzeVariants(trees(text).lab.rootNode, 'x.shader', trees(text).hlsl?.rootNode);
    expect(entry.combinations).toBe(4);
    expect(entry.groups.length).toBe(1);
    expect(entry.builtin.map((b) => [b.name, b.count])).toEqual([
      ['fwdbase', 1],
      ['fog', 1],
    ]);
    const line = variantSummaryLine(entry);
    expect(line).toContain('builtin-groups=2');
    expect(line).toContain('builtin-occurrences=2');
    expect(line).toContain('unavailable');
    expect(variantDetailLines(entry).join('\n')).toContain('不参与计数（关键字空间 unavailable）');
  });

  it('显式组为 0 时仍出 pass 数与内置组清单，不报错、不空手退出（本机 52 文件即如此）', () => {
    const text = shader('Fixtures/NoExplicit', [pass(['      #pragma multi_compile_fwdbase'])]);
    const [entry] = analyzeVariants(trees(text).lab.rootNode, 'x.shader', trees(text).hlsl?.rootNode);
    expect(entry.groups).toEqual([]);
    expect(entry.combinations).toBe(0);
    expect(entry.passCount).toBe(1);
    expect(entry.builtin.length).toBe(1);
  });
});

describe('T-070 shader_block 与 pass 收集', () => {
  it('两个 `shader_block` → 两条，名字保留原文（含空格与 `/`）', () => {
    const text = shader('Legacy Shaders/Diffuse Two Words', [
      pass(['      #pragma multi_compile A B']),
      pass(['      float4 g(){return 0;}']),
    ]) + shader('Second/One', [pass(['      #pragma multi_compile C D'])]);
    const entries = analyzeVariants(trees(text).lab.rootNode, 'two.shader', trees(text).hlsl?.rootNode);
    expect(entries.length).toBe(2);
    expect(entries[0].shaderName).toBe('Legacy Shaders/Diffuse Two Words');
    expect(entries[0].passCount).toBe(2);
    expect(entries[1].shaderName).toBe('Second/One');
    expect(entries[1].passCount).toBe(1);
    // pragma 按 shader_block 的字节区间归属，不串味
    expect(entries[0].groups[0].keywords).toEqual(['A', 'B']);
    expect(entries[1].groups[0].keywords).toEqual(['C', 'D']);
  });

  it('独立 `.hlsl`（无 shader_block）→ 整文件一条，pragma 仍收', () => {
    const text = '#pragma multi_compile _ A B\nfloat4 f(){return 0;}\n';
    const hlsl = parseHlslFile(text);
    const [entry] = analyzeVariants(hlsl.rootNode, 'lib.hlsl', hlsl.rootNode);
    expect(entry.shaderName).toBeNull();
    expect(entry.groups.length).toBe(1);
    expect(entry.combinations).toBe(3);
  });

  it('缺 HLSL 树时不静默出空表：`pragmaSource=no-tree` + 输出 `pragma=unavailable`', () => {
    const text = shader('Fixtures/NoTree', [pass(['      #pragma multi_compile A B'])]);
    const [entry] = analyzeVariants(trees(text).lab.rootNode, 'x.shader', null);
    expect(entry.pragmaSource).toBe('no-tree');
    expect(entry.groups).toEqual([]);
    expect(variantSummaryLine(entry)).toContain('pragma=unavailable');
  });
});
