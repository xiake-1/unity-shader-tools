/** T-037～T-039：语法诊断计算（规格 feature-syntax-diagnostics 的 vitest 侧验收） */
import { describe, it, expect } from 'vitest';
import { DiagnosticSeverity } from 'vscode-languageserver';
import {
  computeFileDiagnostics,
  treesForFile,
  diagnosticLogLine,
  DEFAULT_MAX_DIAGNOSTICS_PER_FILE,
} from '../../server/src/diagnostics';
import { ExemptionTable } from '../../server/src/errorExemption';
import { isGeneratedFile } from '../../server/src/tempFiles';

const HL = (text: string) => [{ kind: 'hlsl' as const, tree: treesForFile('t.hlsl', text)[0].tree }];

describe('T-037 三类语法错误各产 1 条 Error', () => {
  it('缺 `;` → MISSING ; 且 Range 是插入点零宽', () => {
    const r = computeFileDiagnostics(HL('float4 f(){\n  float a = 1\n  return a;\n}\n'));
    expect(r.diagnostics.length).toBe(1);
    const d = r.diagnostics[0];
    expect(d.severity).toBe(DiagnosticSeverity.Error);
    expect(d.message).toBe('MISSING ;');
    expect(d.range.start).toEqual({ line: 1, character: 13 });
    expect(d.range.end).toEqual({ line: 1, character: 13 });
  });

  it('括号不匹配 → 1 条 Error（缺 `)` 形态）', () => {
    const r = computeFileDiagnostics(HL('float4 f(){\n  float4 x = mul((float4)1, (float4)2;\n}\n'));
    expect(r.diagnostics.length).toBe(1);
    expect(r.diagnostics[0].message).toMatch(/^(syntax error - |MISSING )/);
    expect(r.diagnostics[0].range.start.line).toBe(1);
  });

  it('`HLSLPROGRAM` 缺 `ENDHLSL` → ShaderLab 外壳树产 Error，Range 落在程序块关键字上', () => {
    const text = 'Shader "X"\n{\n  SubShader\n  {\n    Pass\n    {\n      HLSLPROGRAM\n      float4 f(){ return 0; }\n    }\n  }\n}\n';
    const r = computeFileDiagnostics(treesForFile('X.shader', text));
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].range.start.line).toBe(6);
    expect(r.diagnostics[0].severity).toBe(DiagnosticSeverity.Error);
  });
});

describe('T-037 级联抑制与文案', () => {
  it('未闭合 `{` 吞掉 20 行 → 只产 1 条，日志含 nested=', () => {
    const body = Array.from({ length: 20 }, (_, i) => `      float v${i} = ${i};`).join('\n');
    const text = `void f(){\n{\n  if (a) {\n    for (int i = 0; i < 3; i++) {\n${body}\n      g(i;\n    }\n  }\n`;
    const r = computeFileDiagnostics(HL(text));
    expect(r.diagnostics.length).toBe(1);
    expect(r.counts.nested).toBeGreaterThan(0);
    expect(diagnosticLogLine('t.hlsl', r.counts)).toContain(`nested=${r.counts.nested}`);
  });

  it('文案形态：MISSING 前缀断言', () => {
    const r = computeFileDiagnostics(HL('float a\n'));
    expect(r.diagnostics.some((d) => d.message.startsWith('MISSING '))).toBe(true);
  });
});

describe('T-038 豁免表', () => {
  it('ADR 0007 模式①（`#if` 块内外括号不平衡）→ 零诊断 + exempted 计数', () => {
    const text = ['#if 1', '{', '#endif', 'float4 a;', '}'].join('\n');
    const r = computeFileDiagnostics(HL(text));
    expect(r.diagnostics.length).toBe(0);
    expect(Object.keys(r.counts.exempted).length).toBeGreaterThan(0);
    expect(diagnosticLogLine('t.hlsl', r.counts)).toContain('exempted=');
  });

  it('空豁免表时同一 fixture 会产诊断（证明豁免真的在起作用）', () => {
    const text = ['#if 1', '{', '#endif', 'float4 a;', '}'].join('\n');
    const r = computeFileDiagnostics(HL(text), { exemptions: new ExemptionTable([]) });
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  it('ADR 0007 模式②（带 primitive 参数的裸宏调用）被豁免', () => {
    const r = computeFileDiagnostics(HL('#if 1\nUNITY_DEFINE_INSTANCED_PROP(float, unity_LightData)\n#endif\n'));
    expect(r.diagnostics.length).toBe(0);
    expect(r.counts.exempted['bare-macro-with-primitive-args']).toBeGreaterThan(0);
  });
});

describe('T-039 include 未找到 Warning', () => {
  const CTX = {
    projectRoot: 'D:/Work/Unity/ShaderStudy',
    cgIncludesDir: null,
    packageCacheDir: null,
  };

  it('`#include "nope.hlsl"` → 1 条 Warning，Range 覆盖路径字符串', () => {
    const r = computeFileDiagnostics(HL('#include "nope.hlsl"\nfloat4 f(){ return 0; }\n'), {
      includeCtx: CTX,
      file: 'D:/Work/Unity/ShaderStudy/Assets/x.hlsl',
    });
    expect(r.counts.include).toBe(1);
    const d = r.diagnostics.find((x) => x.severity === DiagnosticSeverity.Warning)!;
    expect(d.message).toBe("Include file 'nope.hlsl' not found");
    expect(d.range.start).toEqual({ line: 0, character: 9 });
    expect(d.range.end).toEqual({ line: 0, character: 20 });
  });

  it('解析成功的 include 零诊断（内置 CGIncludes 命中）', () => {
    const ctx = {
      projectRoot: 'D:/Work/Unity/ShaderStudy',
      cgIncludesDir: 'D:/Soft/Work/Unity/UnityEditor/2022.3.62f3c1/Editor/Data/CGIncludes',
      packageCacheDir: 'D:/Work/Unity/ShaderStudy/Library/PackageCache',
    };
    const r = computeFileDiagnostics(HL('#include "UnityCG.cginc"\n#include "Lighting.cginc"\n'), {
      includeCtx: ctx,
      file: 'D:/Work/Unity/ShaderStudy/Assets/x.hlsl',
    });
    expect(r.diagnostics.length).toBe(0);
  });

  it('降级态：include 未找到不产、语法诊断照常产，日志记 degraded=skip-include-diag', () => {
    const r = computeFileDiagnostics(HL('#include "nope.hlsl"\nfloat a = 1\n'), { includeCtx: null });
    expect(r.counts.include).toBe(0);
    expect(r.counts.syntax).toBeGreaterThan(0);
    expect(r.counts.degradedSkipInclude).toBe(true);
    expect(diagnosticLogLine('t.hlsl', r.counts)).toContain('degraded=skip-include-diag');
  });
});

describe('T-037 文件覆盖 / 生成文件 / 截断', () => {
  const broken = 'float4 f(){\n  float a = 1\n  return a;\n}\n';

  it('四类文件都产语法诊断（.shader/.hlsl/.hlslinc/.cginc）', () => {
    for (const f of ['a.hlsl', 'a.hlslinc', 'a.cginc']) {
      const r = computeFileDiagnostics(treesForFile(f, broken));
      expect(r.counts.syntax, f).toBeGreaterThan(0);
    }
    const shaderText = `Shader "X"\n{\n  SubShader\n  {\n    Pass\n    {\n      HLSLPROGRAM\n${broken}\n      ENDHLSL\n    }\n  }\n}\n`;
    const r = computeFileDiagnostics(treesForFile('a.shader', shaderText));
    expect(r.counts.syntax).toBeGreaterThan(0);
  });

  it('`Temp/compiled-*` 与 `Temp/generatedFrom*` 判定为生成文件（不产诊断的路径口径）', () => {
    expect(isGeneratedFile('D:/p/Temp/compiled-abc.shader')).toBe(true);
    expect(isGeneratedFile('D:/p/Temp/generatedFromPass.shader')).toBe(true);
    expect(isGeneratedFile('D:/p/Assets/a.shader')).toBe(false);
  });

  it('造 250 个错误 → 返回 200 条 + 日志 truncated=250', () => {
    const text = Array.from({ length: 250 }, (_, i) => `float v${i} = ;`).join('\n');
    const r = computeFileDiagnostics(HL(text));
    expect(r.diagnostics.length).toBe(DEFAULT_MAX_DIAGNOSTICS_PER_FILE);
    expect(r.counts.truncated).toBeGreaterThanOrEqual(250);
    expect(diagnosticLogLine('t.hlsl', r.counts)).toContain(`truncated=${r.counts.truncated}`);
  });

  it('maxPerFile 可配（小上限立即截断）', () => {
    const text = Array.from({ length: 10 }, (_, i) => `float v${i} = ;`).join('\n');
    const r = computeFileDiagnostics(HL(text), { maxPerFile: 3 });
    expect(r.diagnostics.length).toBe(3);
    expect(r.counts.truncated).toBeGreaterThan(3);
  });
});
