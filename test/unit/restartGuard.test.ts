/** T-002：崩溃重启策略（客户端逻辑，无需真实进程） */
import { describe, it, expect } from 'vitest';
import { RestartGuard } from '../../client/src/restartGuard';

describe('RestartGuard', () => {
  it('前 3 次崩溃允许重启', () => {
    const g = new RestartGuard(3);
    expect(g.noteCrash()).toBe(true);
    expect(g.noteCrash()).toBe(true);
    expect(g.noteCrash()).toBe(true);
    expect(g.exhausted).toBe(false);
  });

  it('第 4 次崩溃不再重启', () => {
    const g = new RestartGuard(3);
    for (let i = 0; i < 3; i++) expect(g.noteCrash()).toBe(true);
    expect(g.noteCrash()).toBe(false);
    expect(g.exhausted).toBe(true);
    expect(g.crashCount).toBe(4);
  });

  it('reset 后重新计数', () => {
    const g = new RestartGuard(3);
    g.noteCrash();
    g.noteCrash();
    g.reset();
    expect(g.crashCount).toBe(0);
    expect(g.noteCrash()).toBe(true);
  });
});
