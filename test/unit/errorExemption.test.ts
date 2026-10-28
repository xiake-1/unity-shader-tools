/** T-038：ERROR 模式豁免表（数据纪律 + 每条豁免有 fixture 钉住）
 *
 * fixture 全部取自真实语料里出现过的形态（`npm run audit:errors` 的逐模式表），
 * 上下文由**真实解析结果**构造，不手搓假对象。
 * 唯一例外：`recovery-artifact-brace` 是错误恢复的产物，最小片段难以复现，
 * 它的真实命中由 `npm run gate:diagnostics` 钉住（语料 hits=1）。
 */
import { describe, it, expect } from 'vitest';
import { parseHlslFile, collectErrorNodes } from '../../server/src/parser';
import {
  DEFAULT_EXEMPTIONS,
  ExemptionTable,
  contextOf,
  normalizeShape,
  type ExemptionRule,
} from '../../server/src/errorExemption';

function contextsFor(text: string): ReturnType<typeof contextOf>[] {
  const tree = parseHlslFile(text);
  return collectErrorNodes(tree.rootNode, false).map((e) => contextOf(e.node));
}

function matchedIds(text: string): string[] {
  const table = new ExemptionTable();
  const ids: string[] = [];
  for (const ctx of contextsFor(text)) {
    const rule = table.match(ctx);
    if (rule) ids.push(rule.id);
  }
  return ids;
}

function byId(id: string): ExemptionRule {
  const r = DEFAULT_EXEMPTIONS.find((x) => x.id === id);
  if (!r) throw new Error(`豁免表缺少 id: ${id}`);
  return r;
}

describe('T-038 豁免表数据纪律', () => {
  it('每条豁免有唯一 id 与非空 reason（含「不修」理由）', () => {
    const ids = new Set<string>();
    for (const r of DEFAULT_EXEMPTIONS) {
      expect(ids.has(r.id), `重复 id: ${r.id}`).toBe(false);
      ids.add(r.id);
      expect(r.reason.length, r.id).toBeGreaterThan(10);
      expect(r.reason, r.id).toContain('不修');
    }
  });

  it('命中计数与 hitSummary 口径（exempted=<id>:<n>）', () => {
    const table = new ExemptionTable();
    for (const ctx of contextsFor('#if 1\nUNITY_DEFINE_INSTANCED_PROP(float, a)\n#endif\n')) table.match(ctx);
    const n = table.hitsById.get('bare-macro-with-primitive-args');
    expect(n, `实际命中: ${JSON.stringify([...table.hitsById])}`).toBeGreaterThan(0);
    expect(table.hitSummary()).toContain('exempted=bare-macro-with-primitive-args:');
    table.resetHits();
    expect(table.hitSummary()).toBe('');
  });

  it('空表不豁免任何东西', () => {
    const table = new ExemptionTable([]);
    expect(table.ruleCount).toBe(0);
    const ctx = contextsFor('#if 1\nUNITY_DEFINE_INSTANCED_PROP(float, a)\n#endif\n')[0];
    expect(table.match(ctx)).toBeNull();
  });

  it('matches() 只判定不计数（门槛脚本逐模式签名用它，避免污染命中表）', () => {
    const table = new ExemptionTable();
    const ctx = contextsFor('#if 1\nUNITY_DEFINE_INSTANCED_PROP(float, a)\n#endif\n')[0];
    expect(table.matches(ctx)).toBe(true);
    expect(table.hitsById.size).toBe(0);
  });
});

describe('T-038 每条豁免都有真实语料形态的 fixture', () => {
  const fixtures: Array<[ExemptionRule, string]> = [
    [byId('bare-macro-with-primitive-args'), '#if 1\nUNITY_DEFINE_INSTANCED_PROP(float, unity_LightData)\n#endif\n'],
    [byId('preproc-split-parameter'), 'void f(float a,\n#ifdef X\nout float4 b,\n#endif\nc) { }\n'],
    [byId('preproc-directive-in-expression'), '#if 1\nMERGE_NAME(Foo, Bar)\n#else\nFooBar\n#endif\n(real a) { }\n'],
    [byId('stray-closer-after-preproc'), '#if 1\nfloat4 a;\n#endif\n}\n'],
    [byId('missing-endif-after-preproc'), '#ifdef X\nfloat4 a;\n'],
    [byId('resource-type-modifier-in-template'), 'void f(RWTexture2D<SNORM float4> t) { }\n'],
    [byId('macro-as-function-body'), 'void g(uint tag, bool value) PRINT1(ValueTypeBool, uint(value));\n'],
    [byId('macro-spliced-declarator'), '#if A\nfloat4 unity_StereoScaleOffset[2]\n#endif\n'],
  ];

  for (const [rule, text] of fixtures) {
    it(`${rule.id} 命中该模式`, () => {
      const ids = matchedIds(text);
      expect(
        ids,
        `实际命中: ${ids.join(',')}；上下文: ${JSON.stringify(
          contextsFor(text).map((c) => ({ t: c.nodeType, parent: c.parentType, shape: c.shape }))
        )}`
      ).toContain(rule.id);
    });
  }

  it('recovery-artifact-brace 在表内（其真实命中由 `npm run gate:diagnostics` 钉住）', () => {
    // 该 MISSING `}` 只出现在错误恢复造出的假 `semantics`/`compound_literal_expression` 里，
    // 最小片段复现不了；门槛测试对「每条豁免命中 > 0」的断言覆盖它（语料 hits=1）。
    const rule = byId('recovery-artifact-brace');
    expect(rule.reason).toContain('恢复');
    expect(DEFAULT_EXEMPTIONS.map((r) => r.id)).toContain('recovery-artifact-brace');
  });
});

describe('豁免判据不误伤真实笔误', () => {
  it('参数列表里的真实笔误（`float a b`）不被豁免', () => {
    const ids = matchedIds('void f(float a b) { }\n');
    expect(ids).not.toContain('preproc-split-parameter');
    expect(ids).not.toContain('preproc-directive-in-expression');
  });

  it('`#ifdef` 块里的真实笔误（`float a b;`）不被豁免', () => {
    const ids = matchedIds('#ifdef X\nfloat a b;\n#endif\n');
    expect(ids).not.toContain('preproc-directive-in-expression');
    expect(ids).not.toContain('macro-spliced-declarator');
  });

  it('真实的未闭合 `{` 不被 stray-closer 豁免（它报的是缺 `{` 侧）', () => {
    const ids = matchedIds('void f(){\n  g();\n\n');
    expect(ids).not.toContain('stray-closer-after-preproc');
  });
});

describe('normalizeShape 与语料审计脚本共用同一函数', () => {
  it('标识符/数字/字符串归一化（占位符不被二次替换）', () => {
    expect(normalizeShape('float4 _MainTex_ST = mul(m4, 3.5);')).toBe('ID ID = ID(ID, N);');
    expect(normalizeShape('#include "UnityCG.cginc"')).toBe('#ID S');
  });
});
