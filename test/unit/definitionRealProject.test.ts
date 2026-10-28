/** T-018 / T-020：真实 Unity 工程上的三段跳转 + F12 端到端时延（真实 stdio LSP 全链路）
 *
 * 语料是本机的真实工程与真实 Editor（与 `npm run bench` 同一对路径，可用 BENCH_PROJECT /
 * BENCH_EDITOR 覆盖）。三段跳转：
 *   ① 工程内：`_MainTex` 用法 → 同文件 Properties 声明；
 *   ② 内置：`UnityObjectToClipPos` → `<Editor>/Data/CGIncludes/`（2022.3 实际落在 UnityShaderUtilities.cginc）；
 *   ③ 包内：探针文档 include URP 包内头文件 → `TransformWorldToHClip` → Library/PackageCache。
 * ③ 用临时探针文档（didOpen）而不是往真实工程里写文件：include 的 `Packages/…` 解析按
 *   workspace 根解析，探针放哪都能验证包内跳转，且不会污染用户工程。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LspClient, fileUri } from './lspClient';

const SERVER = path.resolve(__dirname, '..', '..', 'server', 'out', 'server.js');
const PROJECT = (process.env.BENCH_PROJECT ?? 'D:/Work/Unity/ShaderStudy').replace(/\\/g, '/');
const EDITOR = (process.env.BENCH_EDITOR ?? 'D:/Soft/Work/Unity/UnityEditor/2022.3.62f3c1/Editor').replace(/\\/g, '/');
const CGINC = `${EDITOR}/Data/CGIncludes/UnityCG.cginc`;

const haveCorpus =
  fs.existsSync(path.join(PROJECT, 'Assets')) &&
  fs.existsSync(path.join(PROJECT, 'Library', 'PackageCache')) &&
  fs.existsSync(CGINC);

const suite = haveCorpus ? describe : describe.skip;

let proc: ChildProcessWithoutNullStreams;
let client: LspClient;
let probeDir: string;

function listShaderFiles(dir: string, out: string[] = [], limit = 4000): string[] {
  if (out.length >= limit) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listShaderFiles(p, out, limit);
    else if (/\.(shader|hlsl|cginc|compute)$/i.test(e.name)) out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

function posAt(text: string, offset: number): { line: number; character: number } {
  const before = text.slice(0, offset);
  const line = before.split('\n').length - 1;
  return { line, character: offset - before.lastIndexOf('\n') - 1 };
}

/** 第一个程序块之后、按整词匹配的用法位置（避开 Properties 里的声明）；
 *  无程序块的纯 HLSL 文件从文件头开始找。 */
function usageOffset(text: string, name: string): number {
  const programStart = text.search(/\b(CGPROGRAM|HLSLPROGRAM)\b/);
  const from = programStart < 0 ? 0 : programStart;
  const re = new RegExp(`\\b${name}\\b`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > from) return m.index;
  }
  return -1;
}

function programStartLine(text: string): number {
  return posAt(text, text.search(/\b(CGPROGRAM|HLSLPROGRAM)\b/)).line;
}

interface Loc {
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

function textAt(loc: Loc): string {
  const file = loc.uri.replace(/^file:\/\/\/?/, '').replace(/\//g, path.sep);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const l = lines[loc.range.start.line] ?? '';
  return l.slice(loc.range.start.character, loc.range.end.character);
}

async function definition(uri: string, line: number, character: number): Promise<Loc[]> {
  return (await client.request('textDocument/definition', {
    textDocument: { uri },
    position: { line, character },
  })) as Loc[];
}

/** 后台索引是分片让出的、按 Assets → PackageCache → CGIncludes 的顺序推进：
 *  跨层跳转要轮询到目标出现为止（否则会把「还没索引到」误判成「跳不到」）。 */
async function definitionUntil(
  uri: string,
  line: number,
  character: number,
  predicate: (locs: Loc[]) => boolean,
  timeoutMs = 30_000
): Promise<Loc[]> {
  const deadline = Date.now() + timeoutMs;
  let last: Loc[] = [];
  for (;;) {
    last = (await definition(uri, line, character)) ?? [];
    if (predicate(last)) return last;
    if (Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
}

beforeAll(async () => {
  if (!haveCorpus) return;
  expect(fs.existsSync(SERVER), `先构建 server：${SERVER}`).toBe(true);

  const files = listShaderFiles(path.join(PROJECT, 'Assets'));
  expect(files.length).toBeGreaterThan(10);

  probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-real-'));
  proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  client = new LspClient(proc);

  await client.request('initialize', {
    processId: process.pid,
    rootUri: fileUri(PROJECT),
    workspaceFolders: [{ uri: fileUri(PROJECT), name: path.basename(PROJECT) }],
    capabilities: {},
    initializationOptions: {
      activeFile: fileUri(files[0]),
      settings: { index: true, unityEditorPath: EDITOR.replace(/\//g, path.sep) },
    },
  });
  client.notify('initialized', {});

  const stats = await client.waitForIndex(100);
  expect(stats.files, '真实工程冷索引应覆盖 Assets + PackageCache + CGIncludes').toBeGreaterThanOrEqual(100);
  await waitIndexSettled();
});

/** 索引是分片让出的：等到两次统计一致才算完成，否则跨层跳转会误判 */
async function waitIndexSettled(timeoutMs = 90_000): Promise<void> {
  let prev = await client.indexStats();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const now = await client.indexStats();
    if (now.files === prev.files && now.symbols === prev.symbols) return;
    prev = now;
  }
}

afterAll(async () => {
  if (!haveCorpus) return;
  await client?.shutdown();
  try {
    fs.rmSync(probeDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

suite('T-018 真实工程三段跳转（真实 stdio LSP）', () => {
  it('① 工程内：`_MainTex` 用法 → 同文件 Properties 声明', async () => {
    const files = listShaderFiles(path.join(PROJECT, 'Assets'));
    let hit: { file: string; text: string; off: number } | null = null;
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      if (!/Properties\s*\{[^}]*\b_MainTex\b/s.test(text)) continue;
      const off = usageOffset(text, '_MainTex');
      if (off >= 0) {
        hit = { file: f, text, off };
        break;
      }
    }
    expect(hit, '真实工程里应有 Properties 声明并在程序块里使用 _MainTex 的 shader').not.toBeNull();
    const { file, text, off } = hit!;
    const uri = fileUri(file);
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'unityshader', version: 1, text },
    });
    const p = posAt(text, off);
    const r = await definition(uri, p.line, p.character);
    expect(r && r.length).toBeGreaterThan(0);
    expect(r[0].uri).toBe(uri); // 当前文件优先
    expect(textAt(r[0])).toBe('_MainTex'); // 落在声明名字本身
    expect(r[0].range.start.line).toBeLessThan(programStartLine(text)); // 落在 Properties 区
    client.notify('textDocument/didClose', { textDocument: { uri } });
  });

  it('② 内置：`UnityObjectToClipPos` → Editor/Data/CGIncludes 内的声明', async () => {
    const files = listShaderFiles(path.join(PROJECT, 'Assets'));
    let hit: { file: string; text: string; off: number } | null = null;
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      const off = usageOffset(text, 'UnityObjectToClipPos');
      if (off >= 0) {
        hit = { file: f, text, off };
        break;
      }
    }
    expect(hit, '真实工程里应有 UnityObjectToClipPos 的用法').not.toBeNull();
    const { file, text, off } = hit!;
    const uri = fileUri(file);
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'unityshader', version: 1, text },
    });
    const p = posAt(text, off);
    // 2022.3 里这个函数声明在 UnityShaderUtilities.cginc（不是 UnityCG.cginc），
    // 断言只钉「落在 CGIncludes 目录内 + 落在声明名字上」，不钉具体文件名。
    const cgRoot = (fileUri(CGINC.replace(/\/[^/]+$/, '')) + '/').toLowerCase();
    const r = await definitionUntil(uri, p.line, p.character, (locs) =>
      locs.some((l) => l.uri.toLowerCase().startsWith(cgRoot))
    );
    const target = r.find((l) => l.uri.toLowerCase().startsWith(cgRoot));
    expect(target, `应命中 CGIncludes 里的声明，实际：${JSON.stringify(r)}`).toBeTruthy();
    expect(textAt(target!)).toBe('UnityObjectToClipPos');
    client.notify('textDocument/didClose', { textDocument: { uri } });
  });

  it('②b 内置：工程里 `appdata_base` 用法 → UnityCG.cginc 声明（grammar fork 补丁回归）', async () => {
    // 2026-10-28 手动测试缺陷：struct 体内裸宏成员（UNITY_VERTEX_INPUT_INSTANCE_ID）让
    // UnityCG.cginc 整文件级联 ERROR，appdata_base / UnityObjectToWorldNormal 从索引消失。
    const files = listShaderFiles(path.join(PROJECT, 'Assets'));
    let hit: { file: string; text: string; off: number } | null = null;
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      const off = usageOffset(text, 'appdata_base');
      if (off >= 0) {
        hit = { file: f, text, off };
        break;
      }
    }
    expect(hit, '真实工程里应有 appdata_base 的用法').not.toBeNull();
    const { file, text, off } = hit!;
    const uri = fileUri(file);
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'unityshader', version: 1, text },
    });
    const p = posAt(text, off);
    const cgincUri = fileUri(CGINC).toLowerCase();
    const r = await definitionUntil(uri, p.line, p.character, (locs) =>
      locs.some((l) => l.uri.toLowerCase() === cgincUri)
    );
    const target = r.find((l) => l.uri.toLowerCase() === cgincUri);
    expect(target, `appdata_base 应跳到 UnityCG.cginc，实际：${JSON.stringify(r)}`).toBeTruthy();
    expect(textAt(target!)).toBe('appdata_base');
    client.notify('textDocument/didClose', { textDocument: { uri } });
  });

  it('②c 内置：UnityCG.cginc 内 `UnityObjectToWorldNormal` 用法 → 同文件声明（fork 补丁回归）', async () => {
    const text = fs.readFileSync(CGINC, 'utf8');
    const uri = fileUri(CGINC);
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'hlsl', version: 1, text },
    });
    const re = /\bUnityObjectToWorldNormal\b/g;
    const hits: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) hits.push(m.index);
    expect(hits.length, 'UnityObjectToWorldNormal 在 UnityCG.cginc 内应有声明+用法').toBeGreaterThanOrEqual(2);
    const p = posAt(text, hits[1]);
    const r = await definitionUntil(uri, p.line, p.character, (locs) =>
      locs.some((l) => l.uri.toLowerCase() === uri.toLowerCase() && textAt(l) === 'UnityObjectToWorldNormal')
    );
    const target = r.find((l) => l.uri.toLowerCase() === uri.toLowerCase() && textAt(l) === 'UnityObjectToWorldNormal');
    expect(target, `应跳回 UnityCG.cginc 内声明（L177），实际：${JSON.stringify(r)}`).toBeTruthy();
    client.notify('textDocument/didClose', { textDocument: { uri } });
  });

  it('③ 包内：include URP 头文件 → `TransformWorldToHClip` → Library/PackageCache', async () => {
    const probeText = [
      '#include "Packages/com.unity.render-pipelines.core/ShaderLibrary/SpaceTransforms.hlsl"',
      'float4 vert(float3 positionWS) { return TransformWorldToHClip(positionWS); }',
      '',
    ].join('\n');
    const probe = path.join(probeDir, 'probeIncludePkg.hlsl');
    fs.writeFileSync(probe, probeText, 'utf8');
    const uri = fileUri(probe);
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'hlsl', version: 1, text: probeText },
    });

    // include 字符串本身可跳
    const inc = await definition(uri, 0, 30);
    expect(inc && inc.length, 'include 字符串应解析到包内文件').toBeGreaterThan(0);
    expect(inc[0].uri).toContain('PackageCache');
    expect(inc[0].uri.toLowerCase()).toContain('spacetransforms.hlsl');

    // 符号跳到包内
    const off = usageOffset(probeText, 'TransformWorldToHClip');
    expect(off).toBeGreaterThan(0);
    const p = posAt(probeText, off);
    const r = await definitionUntil(uri, p.line, p.character, (locs) =>
      locs.some((l) => l.uri.toLowerCase().includes('spacetransforms.hlsl'))
    );
    const target = r.find((l) => l.uri.toLowerCase().includes('spacetransforms.hlsl'));
    expect(target, `应命中 PackageCache 里的 SpaceTransforms.hlsl，实际：${JSON.stringify(r)}`).toBeTruthy();
    expect(target!.uri).toContain('PackageCache');
    expect(textAt(target!)).toBe('TransformWorldToHClip');
    client.notify('textDocument/didClose', { textDocument: { uri } });
  });

  it('F12 不触发重建索引（查询只读）', async () => {
    const before = await client.indexStats();
    const files = listShaderFiles(path.join(PROJECT, 'Assets')).slice(0, 5);
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      const uri = fileUri(f);
      client.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: 'unityshader', version: 1, text },
      });
      const off = usageOffset(text, 'UnityObjectToClipPos');
      if (off >= 0) {
        const p = posAt(text, off);
        await definition(uri, p.line, p.character);
      }
      client.notify('textDocument/didClose', { textDocument: { uri } });
    }
    const after = await client.indexStats();
    expect(after.files).toBe(before.files);
    expect(after.symbols).toBe(before.symbols);
  });

  it('T-020：真实工程 F12 端到端 P95 < 200ms（20 次采样）', async () => {
    const files = listShaderFiles(path.join(PROJECT, 'Assets'));
    const samples: { uri: string; line: number; character: number }[] = [];
    const opened = new Map<string, string>();
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      for (const name of ['UnityObjectToClipPos', '_MainTex', 'mul', 'normalize']) {
        const off = usageOffset(text, name);
        if (off >= 0) {
          const p = posAt(text, off);
          samples.push({ uri: fileUri(f), line: p.line, character: p.character });
          opened.set(fileUri(f), text);
        }
      }
      if (samples.length >= 40) break;
    }
    expect(samples.length).toBeGreaterThanOrEqual(20);

    for (const [uri, text] of opened) {
      client.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: 'unityshader', version: 1, text },
      });
    }
    // 预热：首查要建 ShaderLab + 虚拟 HLSL 两棵树，不计入采样
    for (const s of samples.slice(0, 3)) await definition(s.uri, s.line, s.character);

    const timings: number[] = [];
    for (const s of samples.slice(0, 20)) {
      const t0 = process.hrtime.bigint();
      await definition(s.uri, s.line, s.character);
      timings.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    for (const uri of opened.keys()) client.notify('textDocument/didClose', { textDocument: { uri } });
    const sorted = [...timings].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
    const median = sorted[Math.floor(sorted.length / 2)];
    console.log(`[bench] F12 端到端 median=${median.toFixed(1)}ms p95=${p95.toFixed(1)}ms n=${sorted.length}`);
    expect(p95).toBeLessThan(200);
  });
});
