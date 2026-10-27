/** 崩溃重启策略（规格异常与边界：自动重启 ≤3 次，超限提示）
 *  纯逻辑，无 vscode 依赖 —— 可在 vitest 里直接断言（T-002 验收）。
 */
export class RestartGuard {
  private crashes = 0;

  constructor(private readonly maxRestarts = 3) {}

  /** 记录一次崩溃；返回是否允许重启 */
  noteCrash(): boolean {
    this.crashes += 1;
    return this.crashes <= this.maxRestarts;
  }

  get crashCount(): number {
    return this.crashes;
  }

  get exhausted(): boolean {
    return this.crashes > this.maxRestarts;
  }

  reset(): void {
    this.crashes = 0;
  }
}
