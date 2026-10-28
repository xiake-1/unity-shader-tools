// T-042 集成用例：真实 VS Code 里的语法诊断（规格 feature-syntax-diagnostics）
// 覆盖：四类文件覆盖（.shader/.hlsl）、include 未找到 Warning、防抖只发一次、
// debounceMs=0 即时发布、生成文件零诊断、开关关闭后旧诊断清空。
//
// 观测口径：
//  - 诊断内容走 `vscode.languages.getDiagnostics(uri)`（LSP push → VS Code 诊断集合）；
//  - 发布次数走 server 在 `unityshader/__indexStats` 里自报的 `diagnosticsPublished`
//    （LanguageClient 不公开诊断事件，自报计数器是唯一可断言的口径）。
// 注意：本模块排在 extension.test.js 之前——那边的崩溃用例会永久杀掉 server。
const vscode = require('vscode');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = process.env.UNITYSHADER_TEST_WORKSPACE;

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

/** 轮询等诊断出现（push 模型有延迟；timeout 内不出现即失败） */
async function waitForDiagnostics(uri, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last = [];
  while (Date.now() < deadline) {
    last = vscode.languages.getDiagnostics(uri);
    if (predicate(last)) return last;
    await sleep(250);
  }
  return null;
}

async function setSetting(key, value) {
  await vscode.workspace
    .getConfiguration('unityShader')
    .update(key, value, vscode.ConfigurationTarget.Workspace);
  // 等 server 收到 didChangeConfiguration（下一轮再断言，避免竞态）
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const s = await stats();
    if (s && s.diagnosticsSettings) {
      const cur = s.diagnosticsSettings;
      if (key === 'diagnosticsDebounceMs' && cur.debounceMs === value) return s;
      if (key === 'syntaxDiagnostics' && cur.syntax === value) return s;
      if (key === 'includeDiagnostics' && cur.include === value) return s;
    }
    await sleep(200);
  }
  throw new Error(`设置 unityShader.${key}=${value} 未在 8s 内送达 server`);
}

async function editOnce(doc, needle, replacement) {
  const editor = vscode.window.activeTextEditor;
  const text = doc.getText();
  const i = text.indexOf(needle);
  assert.ok(i >= 0, `文档里找不到 "${needle}"`);
  const ok = await editor.edit((b) => b.replace(new vscode.Range(doc.positionAt(i), doc.positionAt(i + needle.length)), replacement));
  assert.ok(ok, '编辑未生效');
}

const tests = {
  '语法诊断：.shader 缺 ENDHLSL 产 Error': async () => {
    await waitReady();
    const file = write('Assets/diag-endhlsl.shader', [
      'Shader "Diag/NoEnd"',
      '{',
      '  SubShader',
      '  {',
      '    Pass',
      '    {',
      '      HLSLPROGRAM',
      '      float4 f(){ return 0; }',
      '    }',
      '  }',
      '}',
    ]);
    const doc = await open(file);
    const diags = await waitForDiagnostics(doc.uri, (d) => d.some((x) => x.severity === vscode.DiagnosticSeverity.Error));
    assert.ok(diags, `未拿到 Error 诊断；实际 ${JSON.stringify(vscode.languages.getDiagnostics(doc.uri).map((d) => d.message))}`);
  },

  '语法诊断：.hlsl 缺分号产 MISSING ;': async () => {
    const file = write('Assets/diag-missing.hlsl', ['float4 f(){', '  float a = 1', '  return a;', '}', '']);
    const doc = await open(file);
    const diags = await waitForDiagnostics(doc.uri, (d) => d.some((x) => x.message.startsWith('MISSING ')));
    assert.ok(diags, `未拿到 MISSING 诊断；实际 ${JSON.stringify(vscode.languages.getDiagnostics(doc.uri).map((d) => d.message))}`);
    const d = diags.find((x) => x.message.startsWith('MISSING '));
    assert.strictEqual(d.range.start.line, 1);
  },

  'include 未找到产 Warning': async () => {
    const file = write('Assets/diag-include.hlsl', ['#include "definitely-not-here.hlsl"', 'float4 f(){ return 0; }', '']);
    const doc = await open(file);
    const diags = await waitForDiagnostics(doc.uri, (d) =>
      d.some((x) => x.severity === vscode.DiagnosticSeverity.Warning && x.message.includes("definitely-not-here.hlsl"))
    );
    assert.ok(diags, `未拿到 include Warning；实际 ${JSON.stringify(vscode.languages.getDiagnostics(doc.uri).map((d) => d.message))}`);
    const d = diags.find((x) => x.severity === vscode.DiagnosticSeverity.Warning);
    // Range 覆盖路径字符串（含引号）
    assert.ok(d.range.start.character <= 10 && d.range.end.character >= 20, `Range 未覆盖路径字符串: ${JSON.stringify(d.range)}`);
  },

  '生成文件 Temp/compiled-* 零诊断': async () => {
    const file = write('Temp/compiled-diag.shader', ['Shader "X"', '{', '  SubShader', '  {', '    Pass', '    {', '      HLSLPROGRAM', '      float4 f(){ return 0;', '    }', '  }', '}']);
    const doc = await open(file);
    await sleep(1500);
    const diags = vscode.languages.getDiagnostics(doc.uri);
    assert.strictEqual(diags.length, 0, `生成文件不应有诊断，实际 ${JSON.stringify(diags.map((d) => d.message))}`);
  },

  '防抖：连续 5 次编辑只发布 1 次': async () => {
    await setSetting('diagnosticsDebounceMs', 1200);
    const file = write('Assets/diag-debounce.hlsl', ['float4 f(){', '  float a = 0;', '  return a;', '}', '']);
    const doc = await open(file);
    // 基线取在「落盘 + didOpen 的即时发布」都落地之后：否则计数里混入这两次
    await sleep(1600);
    const base = (await stats()).diagnosticsPublished;
    for (let i = 0; i < 5; i++) {
      await editOnce(doc, `float a = ${i};`, `float a = ${i + 1};`);
      await sleep(120);
    }
    await sleep(2200); // 防抖窗口 1200ms + 余量
    const after = await stats();
    const delta = after.diagnosticsPublished - base;
    assert.strictEqual(delta, 1, `防抖窗口内应只发布 1 次，实际 ${delta} 次`);
  },

  'debounceMs=0：每次编辑即时发布': async () => {
    const before = await setSetting('diagnosticsDebounceMs', 0);
    const base = before.diagnosticsPublished;
    const file = write('Assets/diag-now.hlsl', ['float4 f(){', '  float a = 0;', '  return a;', '}', '']);
    const doc = await open(file);
    for (let i = 0; i < 3; i++) {
      await editOnce(doc, `float a = ${i};`, `float a = ${i + 1};`);
      await sleep(400);
    }
    await sleep(800);
    const after = await stats();
    const delta = after.diagnosticsPublished - base;
    assert.ok(delta >= 3, `debounce=0 时每次编辑都应发布，实际 ${delta} 次（≥3）`);
    await setSetting('diagnosticsDebounceMs', 800);
  },

  '关闭 syntaxDiagnostics：旧诊断清空且无新诊断': async () => {
    const file = write('Assets/diag-off.hlsl', ['float4 f(){', '  float a = 1', '  return a;', '}', '']);
    const doc = await open(file);
    const had = await waitForDiagnostics(doc.uri, (d) => d.length > 0);
    assert.ok(had, '关闭前应先有诊断');
    await setSetting('syntaxDiagnostics', false);
    await sleep(1500);
    const after = vscode.languages.getDiagnostics(doc.uri);
    assert.strictEqual(after.length, 0, `关闭后应清空诊断，实际 ${JSON.stringify(after.map((d) => d.message))}`);
    await setSetting('syntaxDiagnostics', true);
  },
};

module.exports = { tests };
