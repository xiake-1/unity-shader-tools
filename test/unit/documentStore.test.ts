/** T-009：文档同步与增量解析 —— 增量结果与全量解析一致；生成文件关闭智能 */
import { describe, it, expect } from 'vitest';
import { DocumentStore } from '../../server/src/documentStore';
import { isGeneratedFile } from '../../server/src/tempFiles';
import { parseShaderLab, countErrorNodes } from '../../server/src/parser';

const BASE = [
  'Shader "S"',
  '{',
  '  Properties { _A("A", Float) = 1 }',
  '  SubShader',
  '  {',
  '    Pass',
  '    {',
  '      HLSLPROGRAM',
  '      float4 _A;',
  '      ENDHLSL',
  '    }',
  '  }',
  '}',
].join('\n');

describe('增量解析（T-009）', () => {
  it('增量编辑后的树与全量解析的树一致', () => {
    const store = new DocumentStore();
    const file = 'mem://a.shader';
    store.open(file, BASE);

    // 在 Properties 行插入一个属性（增量 range 编辑）
    store.change(file, [
      {
        range: { start: { line: 2, character: 29 }, end: { line: 2, character: 29 } },
        text: ' _B("B", Range(0,1)) = 0.5',
      },
    ]);
    // 再改 HLSL 块里的变量名：`float4 _A;` 的 `A`（第 8 行第 14 列）
    store.change(file, [
      {
        range: { start: { line: 8, character: 14 }, end: { line: 8, character: 15 } },
        text: 'BB',
      },
    ]);

    const state = store.get(file)!;
    const incremental = state.tree!.rootNode.toString();
    const full = parseShaderLab(state.text).rootNode.toString();
    expect(incremental).toBe(full);
    expect(state.text).toContain('_BB');
  });

  it('全量替换（无 range）同样保持树一致', () => {
    const store = new DocumentStore();
    const file = 'mem://b.shader';
    store.open(file, BASE);
    const next = BASE.replace('float4 _A;', 'float4 _A;\n      float _C;');
    store.change(file, [{ text: next }]);
    const state = store.get(file)!;
    expect(state.tree!.rootNode.toString()).toBe(parseShaderLab(next).rootNode.toString());
  });

  it('语法错误不中断：出错文件仍有树，且错误节点可数', () => {
    const store = new DocumentStore();
    store.open('mem://c.shader', 'Shader "S"\n{\n  SubShader\n  {\n    Pass\n    {\n      HLSLPROGRAM\n');
    const state = store.get('mem://c.shader')!;
    expect(state.tree).not.toBeNull();
    expect(countErrorNodes(state.tree!.rootNode)).toBeGreaterThan(0);
  });
});

describe('生成文件关闭智能（T-009）', () => {
  it.each([
    ['C:/P/Library/ShaderCache/Temp/compiled-abc123.shader', true],
    ['C:/P/Temp/generatedFromFile.shader', true],
    ['C:/P/Temp/__Generated/unlit.shader', true],
    ['C:/P/Assets/Shaders/unlit.shader', false],
    ['C:/P/Assets/Temp/keep.shader', false],
  ])('%s → %s', (p, expected) => {
    expect(isGeneratedFile(p)).toBe(expected);
  });

  it('生成文件不解析、不索引', () => {
    const store = new DocumentStore();
    const file = 'C:/P/Temp/compiled-x.shader';
    const state = store.open(file, 'Shader "G" { }');
    expect(state.generated).toBe(true);
    expect(state.tree).toBeNull();
    expect(store.change(file, [{ text: 'Shader "G" { SubShader { } }' }])?.tree).toBeNull();
  });
});
