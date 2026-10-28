/** T-003 / T-004：ShaderLab 外壳解析 + 程序块区间 + 虚拟 HLSL 文档的坐标一致性 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  parseShaderLab,
  parseHlslFile,
  extractProgramBodies,
  buildVirtualHlsl,
  countErrorNodes,
  walk,
} from '../../server/src/parser';

const FIXTURES = path.join(__dirname, '..', '..', 'grammar', 'examples');

describe('ShaderLab 外壳解析', () => {
  it('两个最小 fixture 无 ERROR 节点', () => {
    for (const f of ['cg.shader', 'hlsl.shader']) {
      const text = fs.readFileSync(path.join(FIXTURES, f), 'utf8');
      const tree = parseShaderLab(text);
      expect(countErrorNodes(tree.rootNode), f).toBe(0);
    }
  });

  it('识别 Shader/SubShader/Pass/Properties/Tags 结构', () => {
    const text = [
      'Shader "A"',
      '{',
      '  Properties { _T("T", 2D) = "white" {} }',
      '  SubShader',
      '  {',
      '    Tags { "RenderType" = "Opaque" }',
      '    Pass { }',
      '  }',
      '}',
    ].join('\n');
    const tree = parseShaderLab(text);
    expect(countErrorNodes(tree.rootNode)).toBe(0);
    const types = new Set<string>();
    walk(tree.rootNode, (n) => types.add(n.type));
    for (const t of ['shader_block', 'properties_block', 'subshader_block', 'pass_block', 'tags_block']) {
      expect(types.has(t), t).toBe(true);
    }
  });

  it('程序块内容是一个整体叶子：块内 HLSL 语法错误不产生 ShaderLab ERROR', () => {
    const text = `Shader "X"\n{\n  SubShader\n  {\n    Pass\n    {\n      CGPROGRAM\n      this is ((( not valid hlsl @@@\n      ENDCG\n    }\n  }\n}\n`;
    const tree = parseShaderLab(text);
    expect(countErrorNodes(tree.rootNode)).toBe(0);
  });

  it('HLSLPROGRAM / CGPROGRAM / CGINCLUDE / HLSLINCLUDE 边界都能识别', () => {
    const text = `Shader "X"\n{\n  SubShader\n  {\n    CGINCLUDE\n    float a;\n    ENDCG\n    HLSLINCLUDE\n    float b;\n    ENDHLSL\n    Pass { CGPROGRAM\nfloat c;\nENDCG }\n  }\n}\n`;
    const tree = parseShaderLab(text);
    const bodies = extractProgramBodies(tree, text);
    expect(bodies.length).toBe(3);
    expect(bodies.map((b) => b.kind).sort()).toEqual(['cg', 'cg', 'hlsl']);
    expect(countErrorNodes(tree.rootNode)).toBe(0);
  });

  it('虚拟 HLSL 文档与原文等长，程序块内坐标一一对应', () => {
    const text = fs.readFileSync(path.join(FIXTURES, 'cg.shader'), 'utf8');
    const tree = parseShaderLab(text);
    const bodies = extractProgramBodies(tree, text);
    const virtualText = buildVirtualHlsl(text, bodies);
    expect(virtualText.length).toBe(text.length);

    const body = bodies.find((b) => b.kind === 'cg')!;
    // 块外内容被替换为空白，块内内容保持原样
    expect(virtualText.slice(body.startByte, body.endByte)).toBe(
      text.slice(body.startByte, body.endByte)
    );
    const before = virtualText.slice(0, body.startByte - 1);
    expect(/[^\s]/.test(before)).toBe(false);
  });
});

describe('T-034：错误节点判定与 Unity 宏语句补丁', () => {
  it('MISSING 节点的 type 是缺失 token 名；countErrorNodes 必须计入', () => {
    const tree = parseHlslFile('float4 f(){\n  float a = 1\n  return a;\n}\n');
    const missing: string[] = [];
    walk(tree.rootNode, (n) => {
      if (n.isMissing) missing.push(n.type);
    });
    expect(missing).toContain(';');
    // 旧写法 `node.type === 'MISSING'` 恒为 false，MISSING 从未被计入（语料里 219 处因此隐形）
    expect(countErrorNodes(tree.rootNode)).toBeGreaterThan(0);
  });

  it('不带分号的 Unity 宏语句不再产 ERROR/MISSING（语料第一名模式）', () => {
    const src = [
      'UNITY_INSTANCING_BUFFER_START(Props)',
      'UNITY_INSTANCING_BUFFER_END(Props)',
      'void v(Data d) {',
      '    TRANSFER_SHADOW(d)',
      '    UNITY_BRANCH',
      '    if (d.f > 0.0) { g(); }',
      '}',
    ].join('\n');
    expect(countErrorNodes(parseHlslFile(src).rootNode)).toBe(0);
  });

  it('带分号的宏调用仍走原解释：symbolIndex 依赖的 call_expression 形态不被 macro_statement 抢走', () => {
    const tree = parseHlslFile('TEXTURE2D(_MainTex);\n');
    expect(countErrorNodes(tree.rootNode)).toBe(0);
    const types = new Set<string>();
    walk(tree.rootNode, (n) => types.add(n.type));
    expect(types.has('call_expression'), 'call_expression').toBe(true);
    expect(types.has('macro_statement'), 'macro_statement').toBe(false);
  });
});
