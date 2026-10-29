/** T-074：语言 id 共存判定纯函数（规格 feature-language-id-coexistence 验收 1/5/13） */
import { describe, it, expect } from 'vitest';
import {
  commandTargets,
  globMatchesFile,
  invalidAssociationEntries,
  isMixedGlob,
  mergeAssociationEntries,
  mergeAssociations,
  planAssociationRewrite,
  shouldSelfHeal,
  targetIdFor,
} from '../../client/src/languageIdFix';

const REGISTERED = new Set(['plaintext', 'hlsl', 'unityshader', 'c', 'cpp']);

describe('判定：哪些关联是「无效」（验收 1）', () => {
  it('`*.shader` → `UnityShader`（id 未注册）判「无人提供」', () => {
    const got = invalidAssociationEntries([{ glob: '*.shader', id: 'UnityShader', scope: 'workspace' }], REGISTERED);
    expect(got.length).toBe(1);
  });
  it('大小写敏感：`unityshader`（已注册）不判无效——只有 `UnityShader` 这种才无效', () => {
    const got = invalidAssociationEntries([{ glob: '*.shader', id: 'unityshader', scope: 'user' }], REGISTERED);
    expect(got).toEqual([]);
  });
  it('`hlsl`/`plaintext`（已注册）判「不动」；非我们扩展名的关联不参与', () => {
    const entries = [
      { glob: '*.hlsl', id: 'hlsl', scope: 'user' as const },
      { glob: '*.shader', id: 'plaintext', scope: 'user' as const },
      { glob: '*.txt', id: 'Whatever', scope: 'user' as const },
    ];
    expect(invalidAssociationEntries(entries, REGISTERED)).toEqual([]);
  });
  it('`**/*.shader` 与混合 glob `*.{shader,cg}` 都算指向我们', () => {
    const entries = [
      { glob: '**/*.shader', id: 'UnityShader', scope: 'user' as const },
      { glob: '*.{shader,cg}', id: 'UnityShader', scope: 'user' as const },
    ];
    expect(invalidAssociationEntries(entries, REGISTERED).length).toBe(2);
  });
});

describe('自愈三条件（验收 5 的判定面）', () => {
  const invalid = [{ glob: '*.shader', id: 'UnityShader', scope: 'workspace' as const }];
  it('三条件齐 → 自愈', () => {
    expect(shouldSelfHeal({ fileName: 'a.shader', languageId: 'plaintext' }, invalid)).toBe(true);
  });
  it('已是 `UnityShader`（VSTU 正常提供）→ 不自愈', () => {
    expect(shouldSelfHeal({ fileName: 'a.shader', languageId: 'UnityShader' }, invalid)).toBe(false);
  });
  it('不是我们的扩展名 → 不自愈', () => {
    expect(shouldSelfHeal({ fileName: 'a.txt', languageId: 'plaintext' }, invalid)).toBe(false);
  });
  it('无无效关联时手动 plaintext → 不自愈（用户意图优先）', () => {
    expect(shouldSelfHeal({ fileName: 'a.shader', languageId: 'plaintext' }, [])).toBe(false);
  });
  it('混合 glob 也满足条件③（运行时切文档，不改设置）', () => {
    const mixed = [{ glob: '*.{shader,cg}', id: 'UnityShader', scope: 'user' as const }];
    expect(shouldSelfHeal({ fileName: 'Assets/a.shader', languageId: 'plaintext' }, mixed)).toBe(true);
  });
});

describe('改写计划（验收 13 的判定面）', () => {
  it('混合 glob `*.{shader,cg}` 不改写，进 skippedMixed', () => {
    const plan = planAssociationRewrite([{ glob: '*.{shader,cg}', id: 'UnityShader', scope: 'user' }], REGISTERED);
    expect(plan.rewrite).toEqual([]);
    expect(plan.skippedMixed).toEqual(['*.{shader,cg}']);
    expect(isMixedGlob('*.{shader,cg}')).toBe(true);
  });
  it('toId 按扩展名映射：`.shader`→unityshader、`.hlslinc`→hlsl', () => {
    const plan = planAssociationRewrite(
      [
        { glob: '*.shader', id: 'UnityShader', scope: 'workspace' },
        { glob: '*.hlslinc', id: 'UnityShader', scope: 'user' },
      ],
      REGISTERED
    );
    expect(plan.rewrite.map((r) => `${r.glob}->${r.toId}@${r.scope}`)).toEqual([
      '*.shader->unityshader@workspace',
      '*.hlslinc->hlsl@user',
    ]);
  });
  it('两级同 glob：工作区优先取生效值，只改生效那条（验收 13）', () => {
    const entries = mergeAssociationEntries(
      { '*.shader': 'UnityShader' },
      { '*.shader': 'Whatever', '*.hlsl': 'UnityShader' }
    );
    expect(entries.map((e) => `${e.glob}@${e.scope}`)).toEqual(['*.shader@workspace', '*.hlsl@user']);
    const plan = planAssociationRewrite(entries, REGISTERED);
    expect(plan.rewrite.map((r) => `${r.glob}@${r.scope}`)).toEqual(['*.shader@workspace', '*.hlsl@user']);
  });
  it('工作区已修好（指向已注册 id）→ 用户级坏条目仍会被判无效（生效值就是工作区的，不改用户级）', () => {
    const entries = mergeAssociationEntries({ '*.shader': 'hlsl' }, { '*.shader': 'UnityShader' });
    expect(planAssociationRewrite(entries, REGISTERED).rewrite).toEqual([]);
  });
});

describe('写回与对话框（条目级、不整对象覆盖）', () => {
  it('mergeAssociations 只改命中键，其余键原样保留', () => {
    const merged = mergeAssociations(
      { '*.shader': 'UnityShader', '*.txt': 'plaintext', 'LICENSE': 'yaml' },
      { rewrite: [{ glob: '*.shader', scope: 'workspace', fromId: 'UnityShader', toId: 'unityshader' }] }
    );
    expect(merged).toEqual({ '*.shader': 'unityshader', '*.txt': 'plaintext', 'LICENSE': 'yaml' });
  });
  it('无工作区文件夹时只给 User 选项', () => {
    expect(commandTargets(true)).toEqual(['workspace', 'user']);
    expect(commandTargets(false)).toEqual(['user']);
  });
});

describe('glob 匹配', () => {
  it('`*.shader` 命中 basename；`**/*.shader` 命中全路径；大小写不敏感', () => {
    expect(globMatchesFile('*.shader', 'Assets/a.shader')).toBe(true);
    expect(globMatchesFile('*.shader', 'C:/p/a.SHADER')).toBe(true);
    expect(globMatchesFile('**/*.shader', 'C:/p/a.shader')).toBe(true);
    expect(globMatchesFile('*.shader', 'a.hlsl')).toBe(false);
    expect(globMatchesFile('*.cg', 'a.shader')).toBe(false);
  });
  it('targetIdFor 只认我们的四个扩展名', () => {
    expect(targetIdFor('a.shader')).toBe('unityshader');
    expect(targetIdFor('a.HLSL')).toBe('hlsl');
    expect(targetIdFor('a.hlslinc')).toBe('hlsl');
    expect(targetIdFor('a.cginc')).toBe('hlsl');
    expect(targetIdFor('a.cg')).toBeUndefined();
    expect(targetIdFor('a.txt')).toBeUndefined();
  });
});
