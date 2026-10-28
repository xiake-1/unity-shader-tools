/**
 * T-053 / T-054 / T-055 单测（规格 feature-type-diagnostics 的验收标准逐条对应）。
 *
 * 与 `typeDiagnostics.test.ts` 的分工：那份钉「切分 + 坐标恒等 + 真实 dxc 一次编译」，
 * 这份钉「include 计划、诊断核心的互斥/缓存/取消/截断、豁免表」——全部用**注入的假 compile**，
 * 不依赖本机 dxc，断言的是调用计数与日志口径（规格验收要求 spy 断言「调用计数 = 0」）。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DiagnosticSeverity } from 'vscode-languageserver';
import {
  buildCompileUnits,
  computeTypeDiagnostics,
  planUnitIncludes,
  prepareTypeRun,
  typeDiagnosticLogLine,
  TypeDiagnosticsProvider,
} from '../../server/src/typeDiagnostics';
import type { CompileResult, DxcIssue } from '../../server/src/dxcRunner';
import type { IncludeContext } from '../../server/src/includeResolver';
import { DEFAULT_DXC_EXEMPTIONS, DxcExemptionTable, normalizeDxcMessage } from '../../server/src/dxcExemption';
import { NEVER_DEFINED_BY_DEFAULT } from '../../server/src/dxcMacroTable';
import { parseShaderLab } from '../../server/src/parser';

/* ---------------- 语料夹具：四类 include 各一例 ---------------- */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'unityshader-include-'));
const DOC_DIR = path.join(TMP, 'Assets', 'Shaders');
const PROJECT = TMP;
const CGINC = path.join(TMP, 'Editor', 'Data', 'CGIncludes');
const PKGCACHE = path.join(TMP, 'Library', 'PackageCache');

fs.mkdirSync(DOC_DIR, { recursive: true });
fs.mkdirSync(CGINC, { recursive: true });
fs.mkdirSync(path.join(PKGCACHE, 'com.unity.render-pipelines.core@14.0.12', 'ShaderLibrary'), { recursive: true });

fs.writeFileSync(path.join(DOC_DIR, 'Local.hlsl'), 'float4 local_fn(){return 0;}\n');
fs.writeFileSync(path.join(DOC_DIR, 'Bar.hlsl'), 'float4 bar_fn(){return 1;}\n');
fs.writeFileSync(path.join(CGINC, 'UnityCG.cginc'), 'float4 unitycg_fn(){return 2;}\n');
fs.writeFileSync(
  path.join(PKGCACHE, 'com.unity.render-pipelines.core@14.0.12', 'ShaderLibrary', 'Core.hlsl'),
  'float4 core_fn(){return 3;}\n'
);

const CTX: IncludeContext = {
  projectRoot: PROJECT,
  cgIncludesDir: CGINC,
  packageCacheDir: PKGCACHE,
};

const docFile = path.join(DOC_DIR, 'demo.shader');

function shaderWith(includes: string[]): string {
  return [
    'Shader "Demo/X"',
    '{',
    '  SubShader',
    '  {',
    '    Pass',
    '    {',
    '      HLSLPROGRAM',
    ...includes,
    '      float4 f(){ return 0; }',
    '      ENDHLSL',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
}

const nl = (s: string): number => (s.match(/\n/g) ?? []).length;

describe('T-053 include 闭包接入 DXC', () => {
  it('四类 include 各一例：相对 / Assets/… / Packages/… / 内置裸名，全部解析成功', () => {
    const text = shaderWith([
      '      #include "Local.hlsl"',
      '      #include "Assets/Shaders/Bar.hlsl"',
      '      #include "Packages/com.unity.render-pipelines.core/ShaderLibrary/Core.hlsl"',
      '      #include "UnityCG.cginc"',
    ]);
    const [unit] = buildCompileUnits(text, parseShaderLab(text));
    const plan = planUnitIncludes(unit, docFile, CTX);
    expect(plan.failures).toEqual([]);
    // `-I` 根集合：文档目录 + 工程根 + 内置 CGIncludes
    expect(plan.includeRoots.map((p) => path.basename(p))).toEqual(
      expect.arrayContaining(['Shaders', 'CGIncludes'])
    );
    expect(plan.includeRoots.some((p) => pathEq(p, DOC_DIR))).toBe(true);
    expect(plan.includeRoots.some((p) => pathEq(p, PROJECT))).toBe(true);
  });

  it('只有 `Packages/<pkg>/…` 需要改写（PackageCache 带 @version，`-I` 表达不了）', () => {
    const text = shaderWith([
      '      #include "Local.hlsl"',
      '      #include "Assets/Shaders/Bar.hlsl"',
      '      #include "Packages/com.unity.render-pipelines.core/ShaderLibrary/Core.hlsl"',
      '      #include "UnityCG.cginc"',
    ]);
    const [unit] = buildCompileUnits(text, parseShaderLab(text));
    const plan = planUnitIncludes(unit, docFile, CTX);
    expect(plan.rewritten).toBe(1);
    const rewritten = plan.virtualText.match(/#include "([^"]*PackageCache[^"]*)"/);
    expect(rewritten).toBeTruthy();
    expect(rewritten![1]).toContain(`com.unity.render-pipelines.core@14.0.12`);
    // 其余三类原样保留（坐标零漂移）
    expect(plan.virtualText).toContain('#include "Local.hlsl"');
    expect(plan.virtualText).toContain('#include "Assets/Shaders/Bar.hlsl"');
    expect(plan.virtualText).toContain('#include "UnityCG.cginc"');
  });

  it('改写不得增删行（坐标恒等的前提，规格范围 6）', () => {
    const text = shaderWith(['      #include "Packages/com.unity.render-pipelines.core/ShaderLibrary/Core.hlsl"']);
    const [unit] = buildCompileUnits(text, parseShaderLab(text));
    const plan = planUnitIncludes(unit, docFile, CTX);
    expect(plan.rewritten).toBe(1);
    expect(nl(plan.virtualText)).toBe(nl(text));
    // 改写行之后的行号不变
    const after = plan.virtualText.split('\n').findIndex((l) => l.includes('float4 f()'));
    expect(after).toBe(text.split('\n').findIndex((l) => l.includes('float4 f()')));
  });

  it('解析不到的 include → 记进 failures（调用方据此整块不产诊断）', () => {
    const text = shaderWith(['      #include "NoSuchFile.hlsl"']);
    const [unit] = buildCompileUnits(text, parseShaderLab(text));
    const plan = planUnitIncludes(unit, docFile, CTX);
    expect(plan.failures).toEqual(['NoSuchFile.hlsl']);
  });

  it('确定为假分支里的 include 不算失败（URP Common.hlsl 的 xboxone/ps4/ps5 分支）', () => {
    const text = shaderWith([
      '      #if defined(SHADER_API_XBOXONE)',
      '      #include "Packages/com.unity.render-pipelines.xboxone/ShaderLibrary/API/XBoxOne.hlsl"',
      '      #endif',
    ]);
    const [unit] = buildCompileUnits(text, parseShaderLab(text));
    const plan = planUnitIncludes(unit, docFile, CTX, {
      deadMacros: new Set<string>(NEVER_DEFINED_BY_DEFAULT),
    });
    expect(plan.deadSkipped).toBe(1);
    expect(plan.failures).toEqual([]);
    // 不传 deadMacros 时它会被算成失败 —— 这条差异就是那次实测回归的根因
    const naive = planUnitIncludes(unit, docFile, CTX);
    expect(naive.failures.length).toBe(1);
  });
});

/* ---------------- 假的 compile：断言调用计数与映射 ---------------- */

const VFILE = path.join(TMP, 'unityshader-unit-v.hlsl');

function issue(line: number, col: number, message: string, file = VFILE, code: string | null = null): DxcIssue {
  return { line, col, severity: 'error', code, message, file };
}

function fakeResult(issues: DxcIssue[], extra: Partial<CompileResult> = {}): CompileResult {
  return {
    status: issues.length ? 'errors' : 'ok',
    issues,
    errorCount: issues.length,
    warningCount: 0,
    exitCode: issues.length ? 1 : 0,
    virtualFile: VFILE,
    ...extra,
  };
}

const hlslFile = path.join(DOC_DIR, 'probe.hlsl');

describe('T-054 类型诊断核心', () => {
  it('语法 Error 互斥：syntaxErrorCount>0 → 一次都不调 compile + 日志 skipped=syntax-error', async () => {
    let calls = 0;
    const provider = new TypeDiagnosticsProvider(2);
    const res = await provider.run(hlslFile, 'float4 f(){ return 1; }\n', {
      version: 1,
      syntaxErrorCount: 1,
      dxc: { ok: true, path: 'dxc.exe', dir: TMP, source: 'bundled', platformDir: 'win32-x64' },
      includeCtx: CTX,
      compile: async () => {
        calls++;
        return fakeResult([]);
      },
    });
    expect(calls).toBe(0);
    expect(res.diagnostics).toEqual([]);
    expect(res.counts.skippedSyntaxError).toBe(true);
    expect(typeDiagnosticLogLine(hlslFile, res.counts)).toContain('skipped=syntax-error');
  });

  it('缓存：同版本重复保存 → 第二次不 spawn（调用计数不变）', async () => {
    let calls = 0;
    const provider = new TypeDiagnosticsProvider(2);
    const opts = {
      version: 7,
      syntaxErrorCount: 0,
      dxc: { ok: true, path: 'dxc.exe', dir: TMP, source: 'bundled', platformDir: 'win32-x64' },
      includeCtx: CTX,
      compile: async () => {
        calls++;
        return fakeResult([]);
      },
    } as const;
    const text = 'float4 f(){ return 1; }\n';
    const a = await provider.run(hlslFile, text, opts as never);
    const b = await provider.run(hlslFile, text, opts as never);
    expect(calls).toBe(1);
    expect(a.counts.cacheHit).toBe(false);
    expect(b.counts.cacheHit).toBe(true);
  });

  it('并发与取消：同一文档连续两次 → 第一次被 abort，只发布最新一次', async () => {
    const seen: AbortSignal[] = [];
    let releaseFirst: (() => void) | null = null;
    const provider = new TypeDiagnosticsProvider(2);
    const dxc = { ok: true, path: 'dxc.exe', dir: TMP, source: 'bundled', platformDir: 'win32-x64' } as const;
    const p1 = provider.run(hlslFile, 'float4 f(){ return 1; }\n', {
      version: 1,
      syntaxErrorCount: 0,
      dxc,
      includeCtx: CTX,
      compile: (o) =>
        new Promise<CompileResult>((resolve) => {
          seen.push(o.signal!);
          releaseFirst = () => resolve(fakeResult([issue(1, 7, 'first run')]));
          o.signal!.addEventListener('abort', () => resolve({ status: 'cancelled', issues: [], errorCount: 0, warningCount: 0, exitCode: null }));
        }),
    });
    await new Promise((r) => setImmediate(r));
    const p2 = provider.run(hlslFile, 'float4 f(){ return 2; }\n', {
      version: 2,
      syntaxErrorCount: 0,
      dxc,
      includeCtx: CTX,
      compile: async () => fakeResult([issue(1, 7, 'second run')]),
    });
    const r1 = await p1;
    releaseFirst?.();
    const r2 = await p2;
    expect(seen[0].aborted).toBe(true); // 第一次的子进程被 kill
    expect(r1.counts.cancelled).toBeGreaterThan(0);
    expect(r2.diagnostics[0]?.message).toBe('second run');
  });

  it('映射：Range = (line-1, col-1) 起、取该行首个非空白 token；source 固定', async () => {
    const prepared = prepareTypeRun(hlslFile, 'float4 f() { float4 c = float3(1,1,1); return c; }\n', {
      includeCtx: CTX,
    });
    const res = await computeTypeDiagnostics(prepared, {
      file: hlslFile,
      text: 'float4 f() { float4 c = float3(1,1,1); return c; }\n',
      dxc: { ok: true, path: 'dxc.exe', dir: TMP, source: 'bundled', platformDir: 'win32-x64' },
      compile: async () => fakeResult([issue(1, 21, "cannot initialize a variable of type 'vector<float, 4>' with an rvalue of type 'vector<float, 3>'")]),
    });
    expect(res.diagnostics.length).toBe(1);
    const d = res.diagnostics[0];
    expect(d.range.start).toEqual({ line: 0, character: 20 });
    expect(d.range.end.character).toBe(21); // `c`
    expect(d.severity).toBe(DiagnosticSeverity.Error);
    expect(d.source).toBe('Unity Shader (DXC)');
    expect(d.code).toBeUndefined(); // 语义错误无错误码 → 不设 code
  });

  it('警告首期不推；include 闭包内（非当前文档）的错误不推', async () => {
    const text = 'float4 f(){ return 1; }\n';
    const prepared = prepareTypeRun(hlslFile, text, { includeCtx: CTX });
    const res = await computeTypeDiagnostics(prepared, {
      file: hlslFile,
      text,
      dxc: { ok: true, path: 'dxc.exe', dir: TMP, source: 'bundled', platformDir: 'win32-x64' },
      compile: async () =>
        fakeResult([
          { ...issue(1, 1, 'implicit conversion', VFILE, '-Wliteral-conversion'), severity: 'warning' },
          issue(1, 1, 'nested header error', path.join(CGINC, 'UnityCG.cginc')),
        ]),
    });
    expect(res.diagnostics).toEqual([]);
  });

  it('截断：超过 maxTypeDiagnosticsPerFile → 按文档顺序截断 + 日志 truncated=', async () => {
    const text = 'float4 f(){ return 1; }\n';
    const prepared = prepareTypeRun(hlslFile, text, { includeCtx: CTX });
    const many = Array.from({ length: 150 }, (_, i) => issue(1, 1 + i, `err ${i}`));
    const res = await computeTypeDiagnostics(prepared, {
      file: hlslFile,
      text,
      dxc: { ok: true, path: 'dxc.exe', dir: TMP, source: 'bundled', platformDir: 'win32-x64' },
      maxPerFile: 100,
      compile: async () => fakeResult(many),
    });
    expect(res.diagnostics.length).toBe(100);
    expect(res.counts.truncated).toBe(150);
    expect(typeDiagnosticLogLine(hlslFile, res.counts)).toContain('truncated=150');
  });

  it('超时 / 编译失败 / 不可解析行：整块不产 + 日志 dxc=timeout / unparsed=', async () => {
    const text = 'float4 f(){ return 1; }\n';
    const prepared = prepareTypeRun(hlslFile, text, { includeCtx: CTX });
    const dxc = { ok: true, path: 'dxc.exe', dir: TMP, source: 'bundled', platformDir: 'win32-x64' } as const;
    const t = await computeTypeDiagnostics(prepared, {
      file: hlslFile,
      text,
      dxc,
      compile: async () => ({ status: 'timeout', issues: [], errorCount: 0, warningCount: 0, exitCode: null, unparsed: 3 }),
    });
    expect(t.diagnostics).toEqual([]);
    expect(t.counts.timeouts).toBe(1);
    const line = typeDiagnosticLogLine(hlslFile, t.counts);
    expect(line).toContain('dxc=timeout');
    expect(line).toContain('unparsed=3');
  });

  it('include 解析失败 → 该块不产诊断 + 日志 include-fail=', async () => {
    const text = shaderWith(['      #include "NoSuchFile.hlsl"']);
    const prepared = prepareTypeRun(docFile, text, { includeCtx: CTX, tree: parseShaderLab(text) });
    let calls = 0;
    const res = await computeTypeDiagnostics(prepared, {
      file: docFile,
      text,
      dxc: { ok: true, path: 'dxc.exe', dir: TMP, source: 'bundled', platformDir: 'win32-x64' },
      compile: async () => {
        calls++;
        return fakeResult([issue(9, 7, 'should not be reported')]);
      },
    });
    expect(calls).toBe(0);
    expect(res.diagnostics).toEqual([]);
    expect(typeDiagnosticLogLine(docFile, res.counts)).toContain('include-fail=NoSuchFile.hlsl');
  });

  it('降级态（无 include 根）→ 不产类型诊断 + 日志 degraded=skip-type-diag', async () => {
    const text = shaderWith(['      #include "Local.hlsl"']);
    const prepared = prepareTypeRun(docFile, text, { includeCtx: null, tree: parseShaderLab(text) });
    let calls = 0;
    const res = await computeTypeDiagnostics(prepared, {
      file: docFile,
      text,
      dxc: { ok: true, path: 'dxc.exe', dir: TMP, source: 'bundled', platformDir: 'win32-x64' },
      compile: async () => {
        calls++;
        return fakeResult([]);
      },
    });
    expect(calls).toBe(0);
    expect(typeDiagnosticLogLine(docFile, res.counts)).toContain('degraded=skip-type-diag');
  });

  it('`.cginc` 与 CGPROGRAM 块零编译单元（CG 语义不在范围）', () => {
    expect(prepareTypeRun(path.join(DOC_DIR, 'x.cginc'), 'float4 f(){return 0;}\n', { includeCtx: CTX }).units).toEqual([]);
    const cg = 'Shader "C"\n{ SubShader { Pass { CGPROGRAM\nfloat4 f(){return 0;}\nENDCG\n} } }\n';
    expect(prepareTypeRun(docFile, cg, { includeCtx: CTX, tree: parseShaderLab(cg) }).units).toEqual([]);
  });
});

describe('T-055 dxcExemption：按消息模式的豁免表', () => {
  it('归一化：`vector<float, 4>` 与 `vector<float, 3>` 命中同一条（验收点名）', () => {
    const a = normalizeDxcMessage("cannot initialize a variable of type 'vector<float, 4>' with an rvalue of type 'vector<float, 3>'");
    const b = normalizeDxcMessage("cannot initialize a variable of type 'vector<float, 3>' with an rvalue of type 'vector<float, 4>'");
    expect(a).toBe(b);
    expect(normalizeDxcMessage("unknown type name 'real3'")).toBe("unknown type name 'N'");
  });

  it('命中 → 零诊断 + 日志 exempted=<id>:<n>（文档是包内头文件时才命中）', async () => {
    const header = path.join(
      PKGCACHE,
      'com.unity.render-pipelines.core@14.0.12',
      'ShaderLibrary',
      'NormalSurfaceGradient.hlsl'
    );
    const text = 'real3 f(){ return 0; }\n';
    const prepared = prepareTypeRun(header, text, { includeCtx: CTX });
    const table = new DxcExemptionTable();
    const res = await computeTypeDiagnostics(prepared, {
      file: header,
      text,
      dxc: { ok: true, path: 'dxc.exe', dir: TMP, source: 'bundled', platformDir: 'win32-x64' },
      exemptions: table,
      compile: async () => fakeResult([issue(1, 1, "unknown type name 'real3'")]),
    });
    expect(res.diagnostics).toEqual([]);
    const line = typeDiagnosticLogLine(header, res.counts);
    expect(line).toContain('exempted=header-standalone-unknown-type:1');
  });

  it('文件特征只做收窄：用户文件里的 `unknown type name` 照常报', async () => {
    const text = 'float4 f(){ return notatype; }\n';
    const prepared = prepareTypeRun(hlslFile, text, { includeCtx: CTX });
    const res = await computeTypeDiagnostics(prepared, {
      file: hlslFile,
      text,
      dxc: { ok: true, path: 'dxc.exe', dir: TMP, source: 'bundled', platformDir: 'win32-x64' },
      compile: async () => fakeResult([issue(1, 19, "use of undeclared identifier 'notatype'")]),
    });
    expect(res.diagnostics.length).toBe(1);
  });

  it('默认表每条都带 reason，且消息模式必填（数据表纪律）', () => {
    for (const r of DEFAULT_DXC_EXEMPTIONS) {
      expect(r.id).toMatch(/^[a-z0-9-]+$/);
      expect(r.reason.length).toBeGreaterThan(20);
      expect(r.pattern).toBeInstanceOf(RegExp);
    }
  });
});

function pathEq(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}
