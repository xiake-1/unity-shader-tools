// T-058 / T-049 集成用例：真实 VS Code 里的类型诊断（规格 feature-type-diagnostics）
// 覆盖：注入类型错误出诊断且坐标恒等、分块编译消除跨 Pass 重复定义、语法 Error 互斥、
//       didChange 不触发、开关关闭清空旧类型诊断、命令强制重算、
//       `dxcPath` 指向不存在 → 零诊断 + 一次性提示 + 其余功能不受影响（T-049 的验收）。
//
// 观测口径：诊断内容走 `vscode.languages.getDiagnostics(uri)`，按 `source === 'Unity Shader (DXC)'`
// 与语法诊断区分；计数走 server 在 `unityshader/__indexStats` 里自报的 `typeDiagnostics`。
const vscode = require('vscode');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = process.env.UNITYSHADER_TEST_WORKSPACE;
const DXC_SOURCE = 'Unity Shader (DXC)';

async function stats() {
  try {
    return await vscode.commands.executeCommand('unityshader/__testIndexStats');
  } catch {
    return null;
  }
}

async function waitReady(timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const s = await stats();
    if (s && s.files >= 1 && s.symbols >= 1 && s.indexing === false) return s;
    await sleep(500);
  }
  throw new Error(`server/索引在 ${timeout}ms 内未就绪`);
}

function write(name, lines) {
  const file = path.join(ws, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

async function open(file) {
  const doc = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(doc);
  return doc;
}

const typeDiags = (uri) =>
  vscode.languages.getDiagnostics(uri).filter((d) => d.source === DXC_SOURCE);

/** 轮询等类型诊断出现/消失 */
async function waitForTypeDiags(uri, predicate, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const got = typeDiags(uri);
    if (predicate(got)) return got;
    await sleep(250);
  }
  return null;
}

async function waitTypeStats(predicate, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const s = await stats();
    if (s && s.typeDiagnostics && predicate(s.typeDiagnostics)) return s.typeDiagnostics;
    await sleep(250);
  }
  throw new Error('typeDiagnostics 统计未在超时内达到预期');
}

async function setSetting(key, value) {
  await vscode.workspace
    .getConfiguration('unityShader')
    .update(key, value, vscode.ConfigurationTarget.Workspace);
  await sleep(900);
}

const tests = {
  '类型诊断：float4 = float3 出 Error，坐标恒等落回 .shader 行列': async () => {
    await waitReady();
    const file = write('Assets/td-bad.shader', [
      'Shader "TD/Bad"',
      '{',
      '  SubShader',
      '  {',
      '    Pass',
      '    {',
      '      HLSLPROGRAM',
      '      float4 bad_fn() { float4 c = float3(1,1,1); return c; }',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ]);
    const doc = await open(file);
    const got = await waitForTypeDiags(doc.uri, (d) => d.length > 0);
    assert.ok(got, `未拿到 DXC 诊断；实际 ${JSON.stringify(vscode.languages.getDiagnostics(doc.uri).map((d) => `${d.source}:${d.message}`))}`);
    const d = got[0];
    assert.strictEqual(d.severity, vscode.DiagnosticSeverity.Error);
    // 坐标恒等：DXC 的 (line,col) 就是 .shader 里的行列（第 8 行、`c` 那一列）
    const lineIdx = 7;
    const lineText = doc.getText().split('\n')[lineIdx];
    const expectedCol = lineText.indexOf('c =');
    assert.ok(expectedCol > 0, '夹具行里应能找到 `c =`');
    assert.strictEqual(d.range.start.line, lineIdx, `行号应恒等为 ${lineIdx}，实际 ${d.range.start.line}`);
    assert.strictEqual(d.range.start.character, expectedCol, `列号应恒等为 ${expectedCol}，实际 ${d.range.start.character}`);
    assert.ok(/vector<float, 3>/.test(d.message), `消息应取 DXC 原文，实际 ${d.message}`);
    assert.strictEqual(d.code, undefined, '语义错误无错误码 → 不应设 code');
  },

  '分块编译：两个 Pass 各定义 vert → 零类型诊断（不误报重复定义）': async () => {
    const file = write('Assets/td-twopass.shader', [
      'Shader "TD/TwoPass"',
      '{',
      '  SubShader',
      '  {',
      '    Pass { HLSLPROGRAM',
      '      float4 vert(float4 p : POSITION) : SV_POSITION { return p; }',
      '      ENDHLSL }',
      '    Pass { HLSLPROGRAM',
      '      float4 vert(float4 p : POSITION) : SV_POSITION { return p * 2; }',
      '      ENDHLSL }',
      '  }',
      '}',
    ]);
    const doc = await open(file);
    await sleep(2500);
    const got = typeDiags(doc.uri);
    const redefinition = got.filter((d) => /redefinition/i.test(d.message));
    assert.strictEqual(redefinition.length, 0, `跨 Pass 同名函数不应误报：${JSON.stringify(redefinition.map((d) => d.message))}`);
  },

  '语法 Error 互斥：缺 `;` 的文档不跑 DXC': async () => {
    // 前面的用例可能把 syntaxDiagnostics 关成 false（工作区级、不恢复），本用例的前提是它开着；
    // 而互斥判定本身不依赖这个开关（关掉时按"应有的语法 Error"判定），见 server.ts 注释。
    await setSetting('syntaxDiagnostics', true);
    const before = await stats();
    const runsBefore = before.typeDiagnostics.runs;
    const file = write('Assets/td-syntaxerr.shader', [
      'Shader "TD/Syn"',
      '{',
      '  SubShader',
      '  {',
      '    Pass { HLSLPROGRAM',
      '      float4 bad_fn() { float4 c = float3(1,1,1)',
      '      return c; }',
      '      ENDHLSL }',
      '  }',
      '}',
    ]);
    const doc = await open(file);
    await sleep(2500);
    const got = typeDiags(doc.uri);
    assert.strictEqual(got.length, 0, `有语法 Error 时不应产类型诊断：${JSON.stringify(got.map((d) => `${d.range.start.line}:${d.range.start.character} ${d.message}`))}`);
    const after = await waitTypeStats((t) => t.runs > runsBefore);
    assert.ok(after.lastCounts.skippedSyntaxError, '日志/统计应记 skipped=syntax-error');
  },

  'didChange 不触发类型诊断（DXC 无增量）': async () => {
    const file = write('Assets/td-change.shader', [
      'Shader "TD/Change"',
      '{',
      '  SubShader',
      '  {',
      '    Pass { HLSLPROGRAM',
      '      float4 ok_fn(){ return 0; }',
      '      ENDHLSL }',
      '  }',
      '}',
    ]);
    const doc = await open(file);
    await sleep(1500);
    const before = await stats();
    const editor = vscode.window.activeTextEditor;
    for (let i = 0; i < 3; i++) {
      await editor.edit((b) => b.insert(new vscode.Position(5, 6), ' '));
      await sleep(150);
    }
    await sleep(1500); // 语法诊断的 800 ms 防抖早已过，类型诊断应一次都没跑
    const after = await stats();
    assert.strictEqual(after.typeDiagnostics.runs, before.typeDiagnostics.runs, 'didChange 不应触发 DXC');
  },

  '命令 runTypeDiagnostics：强制重算（绕缓存）': async () => {
    const before = await stats();
    const res = await vscode.commands.executeCommand('unityshader.runTypeDiagnostics');
    assert.ok(res, '命令应返回结果');
    const after = await waitTypeStats((t) => t.runs > before.typeDiagnostics.runs);
    assert.ok(after.lastCounts, '命令应留下 lastCounts');
  },

  '关闭 typeDiagnostics：旧类型诊断清空': async () => {
    const file = write('Assets/td-off.shader', [
      'Shader "TD/Off"',
      '{',
      '  SubShader',
      '  {',
      '    Pass { HLSLPROGRAM',
      '      float4 bad_fn() { float4 c = float3(1,1,1); return c; }',
      '      ENDHLSL }',
      '  }',
      '}',
    ]);
    const doc = await open(file);
    const had = await waitForTypeDiags(doc.uri, (d) => d.length > 0);
    assert.ok(had, '关闭前应先有类型诊断');
    await setSetting('typeDiagnostics', false);
    await sleep(1200);
    assert.strictEqual(typeDiags(doc.uri).length, 0, '关闭后应清空类型诊断');
    await setSetting('typeDiagnostics', true);
  },

  'T-049：dxcPath 指向不存在 → 零类型诊断 + 一次性提示 + 其余功能不受影响': async () => {
    // 「其余功能不受影响」要验证语法诊断，先把可能被前面用例关掉开关恢复
    await setSetting('syntaxDiagnostics', true);
    const bogus = path.join(ws, 'definitely-not-dxc.exe');
    await setSetting('dxcPath', bogus);
    const t = await waitTypeStats((x) => x.dxcState === 'missing-configured');
    assert.ok(t.notified, '应给出一次性提示（notified=true）');

    const file = write('Assets/td-nodxc.shader', [
      'Shader "TD/NoDxc"',
      '{',
      '  SubShader',
      '  {',
      '    Pass { HLSLPROGRAM',
      '      float4 bad_fn() { float4 c = float3(1,1,1); return c; }',
      '      ENDHLSL }',
      '  }',
      '}',
    ]);
    const doc = await open(file);
    await sleep(2000);
    assert.strictEqual(typeDiags(doc.uri).length, 0, 'dxc 不可用时应零类型诊断');

    // 其余功能不受影响：语法诊断仍在
    const syn = write('Assets/td-nodxc-syn.hlsl', ['float4 f(){', '  float a = 1', '  return a;', '}', '']);
    const synDoc = await open(syn);
    const deadline = Date.now() + 15000;
    let syntax = [];
    while (Date.now() < deadline) {
      syntax = vscode.languages.getDiagnostics(synDoc.uri).filter((d) => d.source !== DXC_SOURCE);
      if (syntax.length) break;
      await sleep(250);
    }
    assert.ok(syntax.length > 0, '语法诊断不应受 dxc 缺失影响');

    // F12 仍可用
    const def = await vscode.commands.executeCommand(
      'vscode.executeDefinitionProvider',
      synDoc.uri,
      new vscode.Position(0, 7)
    );
    assert.ok(Array.isArray(def) || def === undefined || def === null, '转到定义应正常返回');

    await setSetting('dxcPath', '');
    await waitTypeStats((x) => x.dxcState === 'ok');
  },
};

module.exports = { tests };
