/** T-005：用真实 TextMate 引擎分词，断言 grammar 的 scope 落地
 *  （截图肉眼检查不可靠：VS Code 对解析不到的 include 会静默丢弃整条规则）
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Registry, parseRawGrammar, INITIAL } from 'vscode-textmate';
import * as oniguruma from 'vscode-oniguruma';

const root = path.resolve(__dirname, '..', '..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8');

const SAMPLE = [
  'Shader "Unlit/Demo"',
  '{',
  '    Properties',
  '    {',
  '        _MainColor("MainColor",Color) = (1,1,1,1)',
  '    }',
  '    SubShader',
  '    {',
  '        #region Test',
  '        Tags { "LightMode"="ForwardBase" }',
  '        #endregion',
  '        Pass',
  '        {',
  '            CGPROGRAM',
  '            #pragma vertex vert',
  '            #include "UnityCG.cginc"',
  '            fixed4 _MainColor;',
  '            struct v2f { fixed4 pos : SV_POSITION; };',
  '            v2f vert (appdata_base v) { o.pos = UnityObjectToClipPos(v.vertex); }',
  '            fixed4 frag (v2f i) : SV_Target { return fixed4(UNITY_LIGHTMODEL_AMBIENT + _WorldSpaceLightPos0.xyz, 1); }',
  '            ENDCG',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

interface Tok {
  text: string;
  scopes: string[];
}

let tokens: Tok[] = [];

beforeAll(async () => {
  const wasm = fs.readFileSync(path.join(root, 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer ?? (wasm as unknown as ArrayBuffer));
  const onigLib = Promise.resolve({
    createOnigScanner: (s: string[]) => new oniguruma.OnigScanner(s),
    createOnigString: (s: string) => new oniguruma.OnigString(s),
  });

  const registry = new Registry({
    onigLib,
    loadGrammar: async (scope: string) => {
      if (scope === 'source.shaderlab') {
        return parseRawGrammar(read('client/syntaxes/shaderlab.tmLanguage.json'), 'shaderlab.tmLanguage.json');
      }
      if (scope === 'source.hlsl') {
        return parseRawGrammar(read('client/syntaxes/hlsl.tmLanguage.json'), 'hlsl.tmLanguage.json');
      }
      return null;
    },
  });

  const grammar = await registry.loadGrammar('source.shaderlab');
  expect(grammar, 'grammar 未能编译').toBeTruthy();

  let ruleStack = INITIAL;
  for (const line of SAMPLE.split('\n')) {
    const r = grammar.tokenizeLine(line, ruleStack);
    for (const t of r.tokens) {
      const text = line.substring(t.startIndex, t.endIndex);
      if (text.trim()) tokens.push({ text, scopes: t.scopes });
    }
    ruleStack = r.ruleStack;
  }
});

function scopesOf(word: string): string[] {
  const hit = tokens.find((t) => t.text.trim() === word);
  return hit ? hit.scopes : [];
}

describe('ShaderLab / HLSL grammar 分词', () => {
  it('ShaderLab 块关键字有 keyword scope', () => {
    for (const w of ['Shader', 'SubShader', 'Pass', 'CGPROGRAM', 'ENDCG']) {
      expect(scopesOf(w), `${w} 应有 keyword.other.shaderlab`).toContain('keyword.other.shaderlab');
    }
  });

  it('Properties / Tags 有 storage scope', () => {
    expect(scopesOf('Properties')).toContain('storage.type.shaderlab');
    expect(scopesOf('Tags')).toContain('storage.type.shaderlab');
  });

  it('字符串与数字有 scope', () => {
    const str = tokens.find((t) => t.text.includes('Unlit/Demo'));
    expect(str?.scopes).toContain('string.quoted.double.shaderlab');
    const num = tokens.find((t) => t.text.trim() === '1');
    expect(num?.scopes).toContain('constant.numeric.shaderlab');
  });

  it('程序块内嵌 HLSL 被解析（不是整段丢弃）', () => {
    expect(scopesOf('fixed4')).toContain('storage.type.hlsl');
    expect(scopesOf('struct')).toContain('keyword.other.hlsl');
    expect(scopesOf('SV_POSITION')).toContain('support.type.semantic.hlsl');
    expect(scopesOf('UnityObjectToClipPos')).toContain('support.function.unity.hlsl');
    const pragma = tokens.find((t) => t.text.includes('pragma'));
    expect(pragma?.scopes).toContain('keyword.control.directive.include.hlsl');
  });

  it('Unity 内置常量 / 全局 uniform / appdata 结构 / SV_Target 有 scope', () => {
    expect(scopesOf('UNITY_LIGHTMODEL_AMBIENT')).toContain('support.constant.unity.hlsl');
    expect(scopesOf('_WorldSpaceLightPos0')).toContain('support.variable.unity.hlsl');
    expect(scopesOf('appdata_base')).toContain('support.type.unity.hlsl');
    expect(scopesOf('SV_Target')).toContain('support.type.semantic.hlsl');
  });

  it('#region/#endregion 有可见 scope（不只是能折叠）', () => {
    const marker = tokens.find((t) => t.text.includes('#region'));
    expect(marker?.scopes, `实际: ${marker?.scopes.join(',')}`).toContain('keyword.other.region.shaderlab');
    const end = tokens.find((t) => t.text.includes('#endregion'));
    expect(end?.scopes).toContain('keyword.other.region.shaderlab');
    const title = tokens.find((t) => t.text.trim() === 'Test');
    expect(title?.scopes).toContain('entity.name.section.region.shaderlab');
  });

  it('程序块内每一行非空白 token 至少带一个 hlsl/embedded scope', () => {
    const inBlock = tokens.filter((t) => t.scopes.includes('meta.program.cg.shaderlab'));
    expect(inBlock.length).toBeGreaterThan(10);
    const bare = inBlock.filter(
      (t) => !t.scopes.some((s) => s !== 'meta.program.cg.shaderlab' && !s.startsWith('meta.embedded'))
    );
    expect(bare.length, `无 scope 的裸 token: ${bare.map((b) => b.text).join(',')}`).toBe(0);
  });
});
