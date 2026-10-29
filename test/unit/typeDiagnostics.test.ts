/**
 * T-050：编译单元切分与分块虚拟文档（规格 feature-type-diagnostics 范围 1/2、验收「坐标恒等」）。
 * T-051：一次编译与输出解析（真实附带 dxc，缺失时跳过）。
 * T-068：swizzle 的正例（越界分量报错）与负例（合法重排不报）—— 规格
 *   feature-type-diagnostics 验收「非法 swizzle」子项，走真机 dxc + 真实 include 根。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseShaderLab, parseHlslFile } from '../../server/src/parser';
import { isCgSource } from '../../server/src/tempFiles';
import {
  assertCoordinateIdentity,
  buildCompileUnits,
  typeDiagnosticLogLine,
  TypeDiagnosticsProvider,
  wholeFileUnit,
} from '../../server/src/typeDiagnostics';
import { compileUnit, dxcArgList, dxcBaseArgs, parseDxcOutput, resolveDxc } from '../../server/src/dxcRunner';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const TWO_PASS = `Shader "A/B"
{
  SubShader
  {
    Pass
    {
      HLSLPROGRAM
      float4 vert(float4 p : POSITION) : SV_POSITION { return p; }
      ENDHLSL
    }
    Pass
    {
      HLSLPROGRAM
      float4 vert(float4 p : POSITION) : SV_POSITION { return p * 2; }
      ENDHLSL
    }
  }
}
`;

describe('T-050 编译单元切分', () => {
  it('两个 Pass → 两个单元（分块编译，消除跨 Pass 重复定义误报）', () => {
    const tree = parseShaderLab(TWO_PASS);
    const units = buildCompileUnits(TWO_PASS, tree);
    expect(units.length).toBe(2);
    expect(units[0].startLine).toBeLessThan(units[1].startLine);
  });

  it('坐标恒等：每个虚拟文档与原文等长、换行数相同', () => {
    const tree = parseShaderLab(TWO_PASS);
    for (const u of buildCompileUnits(TWO_PASS, tree)) {
      assertCoordinateIdentity(TWO_PASS, u.virtualText);
    }
  });

  it('单元 A 的虚拟文档只含 A 块内容（B 块被空白化）', () => {
    const tree = parseShaderLab(TWO_PASS);
    const [a, b] = buildCompileUnits(TWO_PASS, tree);
    expect(a.virtualText).toContain('return p;');
    expect(a.virtualText).not.toContain('return p * 2;');
    expect(b.virtualText).toContain('return p * 2;');
    expect(b.virtualText).not.toContain('HLSLPROGRAM');
    expect(b.virtualText).not.toContain('Shader "A/B"');
  });

  it('块内字符在虚拟文档里位置不变（行列 = 原文件行列）', () => {
    const tree = parseShaderLab(TWO_PASS);
    const units = buildCompileUnits(TWO_PASS, tree);
    for (const u of units) {
      const original = TWO_PASS.slice(u.startChar, u.endChar);
      expect(u.virtualText.slice(u.startChar, u.endChar)).toBe(original);
    }
  });

  it('CGPROGRAM / GLSLPROGRAM 块不产单元（CG 语义不在范围）', () => {
    const src = `Shader "C"\n{ SubShader { Pass { CGPROGRAM\nfloat4 f(){return 0;}\nENDCG\n} } }\n`;
    expect(buildCompileUnits(src, parseShaderLab(src))).toEqual([]);
  });

  it('独立 .hlsl → 整文件一个单元，虚拟文档 = 原文', () => {
    const u = wholeFileUnit('float4 f(){return 1;}\n');
    expect(u.wholeFile).toBe(true);
    expect(u.virtualText).toBe('float4 f(){return 1;}\n');
    const tree = parseHlslFile(u.virtualText);
    expect(tree.rootNode.childCount).toBeGreaterThan(0);
  });

  it('`.cginc` 判定为 CG 源（与 .hlsl 同语言 id，只能按扩展名区分）', () => {
    expect(isCgSource('D:/x/UnityCG.cginc')).toBe(true);
    expect(isCgSource('D:/x/Core.hlsl')).toBe(false);
    expect(isCgSource('D:/x/a.hlslinc')).toBe(false);
  });

  it('assertCoordinateIdentity 对长度漂移抛错（防未来改写破坏坐标恒等）', () => {
    expect(() => assertCoordinateIdentity('ab\nc', 'ab\nc ')).toThrow(/长度漂移/);
    expect(() => assertCoordinateIdentity('a\nb', 'a b')).toThrow(/换行数漂移/);
  });
});

describe('T-051 参数与输出解析（纯逻辑）', () => {
  it('库目标 + 不落盘 + 宏/include 注入', () => {
    expect(dxcBaseArgs('win32')).toEqual(['-T', 'lib_6_3', '-Fo', 'NUL']);
    expect(dxcBaseArgs('linux')).toEqual(['-T', 'lib_6_3', '-Fo', '/dev/null']);
    const args = dxcArgList('v.hlsl', ['SHADER_API_D3D11=1', 'A'], ['/inc']);
    expect(args).toEqual(['-T', 'lib_6_3', '-Fo', process.platform === 'win32' ? 'NUL' : '/dev/null', '-DSHADER_API_D3D11=1', '-DA', '-I/inc', 'v.hlsl']);
  });

  const sample = [
    "C:/tmp/v.hlsl:1:21: error: cannot initialize a variable of type 'vector<float, 4>' with an rvalue of type 'vector<float, 3>'",
    'float4 f() { float4 c = float3(1,1,1); }',
    '                    ^   ~~~~~~~~~~~~~',
    "C:/tmp/v.hlsl:2:8: error: redefinition of 'f'",
    'float4 f() { return 0; }',
    '       ^',
    'C:/tmp/v.hlsl:1:8: note: previous definition is here',
    "C:/tmp/v.hlsl:1:22: warning: implicit conversion from 'literal float' to 'int' changes value from 1.5 to 1 [-Wliteral-conversion]",
  ].join('\n');

  it('只取 error 行：2 条，note 与 caret 上下文行忽略', () => {
    const issues = parseDxcOutput(sample);
    const errors = issues.filter((i) => i.severity === 'error');
    expect(errors.length).toBe(2);
    expect(errors[0]).toMatchObject({ line: 1, col: 21, code: null });
    expect(errors[0].message).toContain('vector<float, 3>');
    expect(errors[1]).toMatchObject({ line: 2, col: 8 });
    expect(errors[1].message).toContain("redefinition of 'f'");
  });

  it('前端语义错误无错误码 → code=null（豁免表键以消息模式为主）', () => {
    const issues = parseDxcOutput(sample);
    expect(issues.every((i) => (i.severity === 'error' ? i.code === null : true))).toBe(true);
  });

  it('警告带 `[-Wflag]` → 拆成 code，消息里去掉 flag（实测 clang 风格）', () => {
    const w = parseDxcOutput(sample).find((i) => i.severity === 'warning');
    expect(w).toBeTruthy();
    expect(w?.code).toBe('-Wliteral-conversion');
    expect(w?.message).toBe("implicit conversion from 'literal float' to 'int' changes value from 1.5 to 1");
    expect(w?.line).toBe(1);
    expect(w?.col).toBe(22);
  });

  it('空输出 / 无关文本 → 零 issue', () => {
    expect(parseDxcOutput('')).toEqual([]);
    expect(parseDxcOutput('dxc failed : Required input file argument is missing.')).toEqual([]);
  });
});

describe('T-051 真实编译（附带 dxc，缺失则跳过）', () => {
  // 按**当前平台**定位：CI package 档 fetch --all 后 win32 产物也在 Linux 机器上，
  // 硬编码 win32 会让 Linux 去 exec PE → crash（2026-10-29 CI 实测）
  const res = resolveDxc({ env: {}, moduleDir: path.join(REPO_ROOT, 'server', 'src'), platform: process.platform, arch: process.arch });
  const skip = !res.ok;

  it('合法 HLSL 库编译 → status=ok、零 issue', async () => {
    if (skip) return;
    const r = await compileUnit({
      exePath: (res as { path: string }).path,
      virtualText: '#pragma vertex vert\nfloat4 vert(float4 p : POSITION) : SV_POSITION { return p; }\n',
      label: 'ok',
    });
    expect(r.status).toBe('ok');
    expect(r.errorCount).toBe(0);
  });

  it('float4 = float3 → 1 条 error，行列就是原文行列', async () => {
    if (skip) return;
    const text = '\nfloat4 f() { float4 c = float3(1,1,1); return c; }\n';
    const r = await compileUnit({ exePath: (res as { path: string }).path, virtualText: text, label: 'bad' });
    expect(r.status).toBe('errors');
    expect(r.errorCount).toBe(1);
    expect(r.issues[0].line).toBe(2);
    expect(r.issues[0].col).toBe(21);
  });

  it('超时 → status=timeout、零 issue（规格：整块不产诊断）', async () => {
    if (skip) return;
    const big = 'float4 f(){return float4(1,1,1,1);}\n'.repeat(400);
    const r = await compileUnit({ exePath: (res as { path: string }).path, virtualText: big, timeoutMs: 1, label: 'slow' });
    expect(r.status).toBe('timeout');
    expect(r.issues).toEqual([]);
  });

  it('可执行文件不存在 → spawn-failed，不抛错', async () => {
    const r = await compileUnit({ exePath: path.join(REPO_ROOT, 'nope.exe'), virtualText: 'float4 f(){return 0;}' });
    expect(r.status).toBe('spawn-failed');
    expect(r.issues).toEqual([]);
  });
});

/* ---------------- T-068：swizzle 的正例与负例（规格验收「非法 swizzle」） ---------------- */

describe('T-068 swizzle 诊断（真机 dxc + 真实 include 根）', () => {
  const res = resolveDxc({ env: {}, moduleDir: path.join(REPO_ROOT, 'server', 'src'), platform: process.platform, arch: process.arch });
  const skip = !res.ok;

  // includeCtx 必须是**真实存在的目录**：传 null 会走 `degraded=skip-type-diag`，整块不产诊断
  // （规格异常表；实测见 log 2026-10-29 08:20 —— 那次探针 degraded=true / compiled=0 就是这个原因）。
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'unityshader-swizzle-'));
  const DOC = path.join(TMP, 'Assets', 'Shaders');
  const CGINC = path.join(TMP, 'Editor', 'Data', 'CGIncludes');
  fs.mkdirSync(DOC, { recursive: true });
  fs.mkdirSync(CGINC, { recursive: true });
  const CTX = {
    projectRoot: TMP,
    cgIncludesDir: CGINC,
    packageCacheDir: path.join(TMP, 'Library', 'PackageCache'),
  };
  const docFile = path.join(DOC, 'swizzle.shader');

  /** 夹具：swizzle 落在**第 7 行**，`c` 的 0 基列 = 48（6 空格缩进 + 42 字符前缀）。 */
  function shaderWith(expr: string): string {
    return [
      'Shader "T068/Swizzle"',
      '{',
      '  SubShader',
      '  {',
      '    Pass {',
      '      HLSLPROGRAM',
      `      float4 probe(float4 c, float4 d) { return ${expr}; }`,
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
  }

  async function run(expr: string) {
    const text = shaderWith(expr);
    const provider = new TypeDiagnosticsProvider(2);
    return provider.run(docFile, text, {
      version: 1,
      syntaxErrorCount: 0,
      dxc: { ok: true, path: (res as { path: string }).path, dir: path.dirname((res as { path: string }).path), source: 'bundled', platformDir: (res as { platformDir: string }).platformDir },
      includeCtx: CTX,
      tree: parseShaderLab(text),
    });
  }

  it('夹具本身成立：一个编译单元、非降级态', async () => {
    if (skip) return;
    const r = await run('c.xyzw');
    expect(r.counts.units).toBe(1);
    expect(r.counts.degraded).toBe(false);
    expect(r.counts.compiled).toBe(1);
    expect(r.diagnostics).toEqual([]);
  });

  it('正例：越界分量 `c.xyzwq` → 恰好 1 条 Error，坐标恒等落在第 7 行', async () => {
    if (skip) return;
    const r = await run('c.xyzwq');
    expect(r.counts.compiled).toBe(1);
    expect(r.diagnostics.length).toBe(1);
    const d = r.diagnostics[0];
    expect(d.severity).toBe(1); // DiagnosticSeverity.Error
    expect(d.source).toBe('Unity Shader (DXC)');
    expect(d.code).toBeUndefined(); // 前端语义错误无错误码
    expect(d.message).toContain('invalid format for vector swizzle');
    // 坐标恒等：原文第 7 行 → LSP line 6；DXC 指向 swizzle 成员首字符（1 基列 51 → 0 基 50）。
    // 终点按规格范围 7 的口径 = 该行起点起的第一个非空白 run，故含尾随 `;`（到 56）。
    expect(d.range.start).toEqual({ line: 6, character: 50 });
    expect(d.range.end).toEqual({ line: 6, character: 56 });
    expect(shaderWith('c.xyzwq').split('\n')[6].slice(d.range.start.character, d.range.end.character)).toBe('xyzwq;');
    expect(typeDiagnosticLogLine(docFile, r.counts)).toContain('compiled=1 errors=1');
  });

  it('负例：合法重排 `c.wwwz` → 零诊断，且确实编译过（compiled=1）', async () => {
    if (skip) return;
    const r = await run('c.wwwz');
    expect(r.counts.compiled).toBe(1);
    expect(r.counts.produced).toBe(0);
    expect(r.diagnostics).toEqual([]);
    expect(typeDiagnosticLogLine(docFile, r.counts)).toContain('compiled=1 errors=0');
  });
});
