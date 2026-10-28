/**
 * T-060 格式化配置面（规格 feature-formatting 范围 7）。
 *
 * 分工经用户确认：**专属 4 开关**在这里归一；**缩进宽度与空格来源不重复造轮子** ——
 * 直接取 LSP `FormattingOptions`（VSCode 按 `[unityshader]` / `[hlsl]` 作用域算好的
 * `editor.tabSize` / `editor.insertSpaces`）。
 */

export interface FormatSwitches {
  /** 关掉 → server 不宣告 `documentFormattingProvider`（范围 9；改值需重载窗口，约束） */
  enable: boolean;
  /** HLSL 函数/控制流左括号位置（范围 6）。默认同行 */
  braceOnNewLine: boolean;
  /** 多行调用的续行对齐到左括号（范围 6）。默认开 */
  macroMatchIndent: boolean;
  /** 连续空行折叠上限，0–2（范围 6 + 异常表） */
  keepBlankLines: number;
}

export const DEFAULT_FORMAT_SWITCHES: FormatSwitches = {
  // 默认值与 `npm run gate:format` 的门槛结果联动（范围 9）：PASS → true；FAIL → 必须改回 false
  enable: true,
  braceOnNewLine: false,
  macroMatchIndent: true,
  keepBlankLines: 1,
};

/** 归一 + 夹紧：配置面是用户输入，越界值夹紧而不是抛错（规格约束：格式化不产诊断） */
export function normalizeFormatSwitches(raw: unknown): FormatSwitches {
  const r = (raw ?? {}) as Record<string, unknown>;
  const keep = Number(r.keepBlankLines ?? DEFAULT_FORMAT_SWITCHES.keepBlankLines);
  return {
    enable: typeof r.enable === 'boolean' ? r.enable : DEFAULT_FORMAT_SWITCHES.enable,
    braceOnNewLine:
      typeof r.braceOnNewLine === 'boolean' ? r.braceOnNewLine : DEFAULT_FORMAT_SWITCHES.braceOnNewLine,
    macroMatchIndent:
      typeof r.macroMatchIndent === 'boolean'
        ? r.macroMatchIndent
        : DEFAULT_FORMAT_SWITCHES.macroMatchIndent,
    keepBlankLines: Number.isFinite(keep) ? Math.max(0, Math.min(2, Math.trunc(keep))) : DEFAULT_FORMAT_SWITCHES.keepBlankLines,
  };
}

/** 缩进来自 LSP `FormattingOptions`（范围 7）：`tabSize` / `insertSpaces` */
export interface IndentOptions {
  tabSize: number;
  insertSpaces: boolean;
}

export function resolveIndentOptions(o?: { tabSize?: number | null; insertSpaces?: boolean | null } | null): IndentOptions {
  const tabSize = Math.max(1, Math.min(8, Math.trunc(Number(o?.tabSize) || 4)));
  const insertSpaces = o?.insertSpaces === undefined ? true : Boolean(o.insertSpaces);
  return { tabSize, insertSpaces };
}

/** 一级缩进的字符串（`insertSpaces=false` 时用制表符） */
export function indentUnit(o: IndentOptions): string {
  return o.insertSpaces ? ' '.repeat(o.tabSize) : '\t';
}

export function indentPrefix(depth: number, o: IndentOptions): string {
  const d = Math.max(0, Math.trunc(depth));
  return o.insertSpaces ? ' '.repeat(d * o.tabSize) : '\t'.repeat(d);
}
