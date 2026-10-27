/** T-012：符号索引与查询 API */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SymbolIndex } from '../../server/src/symbolIndex';
import { resolveInclude } from '../../server/src/includeResolver';

const SHADER = [
  'Shader "Demo"',
  '{',
  '  Properties',
  '  {',
  '    _MainTex("Main Tex", 2D) = "white" {}',
  '    _Power("Power", Range(0, 4)) = 1',
  '  }',
  '  SubShader',
  '  {',
  '    Pass',
  '    {',
  '      CGPROGRAM',
  '      #include "UnityCG.cginc"',
  '      float4 _MainTex_ST;',
  '      #ifdef _A',
  '      float _Dup;',
  '      #else',
  '      float _Dup;',
  '      #endif',
  '      struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };',
  '      float4 frag(v2f i) : SV_Target { return 0; }',
  '      ENDCG',
  '    }',
  '  }',
  '}',
].join('\n');

describe('符号索引（T-012）', () => {
  it('Properties 属性进入索引且 kind=property', () => {
    const idx = new SymbolIndex();
    idx.indexFile('mem://demo.shader', SHADER);
    expect(idx.getByName('_Power')?.kind).toBe('property');
    expect(idx.getByName('_Power')?.locations[0].start.row).toBe(5);
  });

  it('HLSL 全局变量 / 函数 / struct / 字段 / 宏都进入索引', () => {
    const idx = new SymbolIndex();
    idx.indexFile('mem://demo.shader', SHADER);
    expect(idx.getByName('_MainTex_ST')?.kind).toBe('variable');
    expect(idx.getByName('frag')?.kind).toBe('function');
    expect(idx.getByName('v2f')?.kind).toBe('struct');
    expect(idx.getByName('uv')?.kind).toBe('field');
  });

  it('同名符号（Properties 与 HLSL）合并为一条逻辑符号，保留全部 location', () => {
    const idx = new SymbolIndex();
    idx.indexFile('mem://demo.shader', SHADER.replace('float4 _MainTex_ST;', 'float4 _MainTex;'));
    const info = idx.getByName('_MainTex');
    expect(info).toBeDefined();
    expect(info!.locations.length).toBe(2);
    expect(info!.kind).toBe('property');
  });

  it('#if 分支里的重复声明：保留两处，不做求值猜测', () => {
    const idx = new SymbolIndex();
    idx.indexFile('mem://demo.shader', SHADER);
    const info = idx.getByName('_Dup');
    expect(info?.locations.length).toBe(2);
  });

  it('宏声明表命中：TEXTURE2D/SAMPLER 的参数成为符号并标注来源宏', () => {
    const idx = new SymbolIndex();
    idx.indexFile(
      'mem://m.hlsl',
      'TEXTURE2D(_BaseMap);\nSAMPLER(sampler_BaseMap);\nTEXTURE2D_ARGS(_Emission, sampler_Emission);'
    );
    expect(idx.getByName('_BaseMap')?.locations[0].viaMacro).toBe('TEXTURE2D');
    expect(idx.getByName('sampler_BaseMap')?.locations[0].viaMacro).toBe('SAMPLER');
    expect(idx.getByName('_Emission')).toBeDefined();
    expect(idx.getByName('sampler_Emission')).toBeDefined();
  });

  it('重新索引同一文件不会残留旧符号', () => {
    const idx = new SymbolIndex();
    idx.indexFile('mem://r.shader', 'Shader "R" { Properties { _Gone("x", Float) = 1 } }');
    expect(idx.getByName('_Gone')).toBeDefined();
    idx.indexFile('mem://r.shader', 'Shader "R" { Properties { _New("x", Float) = 1 } }');
    expect(idx.getByName('_Gone')).toBeUndefined();
    expect(idx.getByName('_New')).toBeDefined();
  });

  it('removeFile 清除该文件的全部符号位置', () => {
    const idx = new SymbolIndex();
    idx.indexFile('mem://r2.shader', SHADER);
    idx.removeFile('mem://r2.shader');
    expect(idx.getByName('_Power')).toBeUndefined();
    expect(idx.fileCount).toBe(0);
  });

  it('include 闭包沿解析结果递归展开', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unityclosure-'));
    const write = (p: string, c: string) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, c, 'utf8');
    };
    write(
      path.join(tmp, 'a.shader'),
      'Shader "A" { SubShader { Pass { CGPROGRAM\n#include "b.hlsl"\nENDCG } } }'
    );
    write(path.join(tmp, 'b.hlsl'), '#include "c.hlsl"\nfloat _B;');
    write(path.join(tmp, 'c.hlsl'), 'float _C;');

    const idx = new SymbolIndex();
    for (const f of ['a.shader', 'b.hlsl', 'c.hlsl']) {
      const full = path.join(tmp, f);
      idx.indexFile(full, fs.readFileSync(full, 'utf8'));
    }
    const closure = idx.includeClosure(path.join(tmp, 'a.shader'), (spec, from) =>
      resolveInclude(spec, from, {
        projectRoot: tmp,
        cgIncludesDir: null,
        packageCacheDir: null,
      }).resolved
    );
    expect(closure.map((p) => path.basename(p)).sort()).toEqual(['b.hlsl', 'c.hlsl']);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('查询 API：names / getFileSymbols / symbolCount', () => {
    const idx = new SymbolIndex();
    idx.indexFile('mem://q.shader', SHADER);
    const names = [...idx.names()];
    expect(names).toContain('_MainTex');
    expect(idx.getFileSymbols('mem://q.shader').length).toBeGreaterThan(5);
    expect(idx.symbolCount).toBeGreaterThanOrEqual(6);
  });
});
