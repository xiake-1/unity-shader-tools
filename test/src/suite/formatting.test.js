// T-065 集成用例：真实 VS Code 里的格式化（规格 feature-formatting）
// 覆盖：provider 返回**单个覆盖全文的 TextEdit**、token 序列不变、
//       `[hlsl] editor.tabSize: 2` 经 LSP `FormattingOptions` 生效（不重复造配置）、
//       注入打印器抛错 → 文档零改动（失败即不改）、超 `maxFormatFileSize` → 零改动、
//       `__indexStats.formatting` 计数可观察。
//
// 三条硬断言（幂等 / token 不变 / 仅空白变化）在真实语料上的规模化验证由
// `npm run gate:format` 承担；这里验证的是**接线与边界**。
const vscode = require('vscode');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseShaderLab, parseHlslFile, walk } = require('../../../server/out/parser.js');

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

const tokensOf = (file, text) => {
  const tree = /\.(hlsl|hlslinc)$/i.test(file) ? parseHlslFile(text) : parseShaderLab(text);
  const out = [];
  walk(tree.rootNode, (n) => {
    if (n.children.length === 0) out.push(`${n.type}\u0000${n.text}`);
  });
  return out;
};

const MESSY_SHADER = [
  'Shader "Fmt/Messy"',
  '{',
  '\tProperties',
  '   {',
  '_A("A", 2D) = "white" {}',
  '   }',
  '     SubShader',
  ' {',
  'Pass',
  '{',
  'Blend   SrcAlpha    OneMinusSrcAlpha',
  '   HLSLPROGRAM',
  'float4 f(){ return 0; }',
  '   ENDHLSL',
  '}',
  '}',
  '}',
];

const tests = {
  '格式化：`editor.action.formatDocument` 落地缩进，且 token 序列不变': async () => {
    await waitReady();
    // 固定 FormattingOptions：夹具混用 tab 与 3 空格，VS Code 的 detectIndentation 会推出
    // tabSize=3，断言就不稳定了（实测如此）。关掉探测 = 断言的是我们按选项输出的形状。
    await vscode.workspace
      .getConfiguration()
      .update('[unityshader]', { 'editor.tabSize': 4, 'editor.insertSpaces': true, 'editor.detectIndentation': false }, vscode.ConfigurationTarget.Workspace);
    const file = write('Assets/fmt-messy.shader', MESSY_SHADER);
    const doc = await open(file);
    const before = doc.getText();
    // 「返回单个覆盖全文的 TextEdit」在协议层断言（test/unit/lspServer.test.ts）：
    // 编辑器会把整篇编辑拆成逐行编辑，那是编辑器的归一化，不是我们的输出形状
    await vscode.commands.executeCommand('editor.action.formatDocument');
    await sleep(800);
    const lines = doc.getText().split('\n');
    assert.strictEqual(lines[2], '    Properties', `Properties 应缩进一级，实际 ${JSON.stringify(lines[2])}`);
    assert.strictEqual(lines[4], '        _A("A", 2D) = "white" {}');
    assert.strictEqual(lines[10], '            Blend SrcAlpha OneMinusSrcAlpha'); // 范围 7：token 之间空白归一，token 不动
    assert.strictEqual(lines[12], '                float4 f(){ return 0; }'); // HLSL 内部深一级
    // token 序列逐项相同（硬断言 ② 的集成侧口径）
    const a = tokensOf(file, before);
    const b = tokensOf(file, doc.getText());
    assert.strictEqual(a.length, b.length, 'token 数应相同');
    for (let i = 0; i < a.length; i++) assert.strictEqual(a[i], b[i], `第 ${i} 个 token 变了`);
    // 幂等：再排一次不再变化
    await vscode.commands.executeCommand('editor.action.formatDocument');
    await sleep(800);
    assert.strictEqual(doc.getText().split('\n')[2], '    Properties');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.workspace
      .getConfiguration()
      .update('[unityshader]', undefined, vscode.ConfigurationTarget.Workspace);
  },

  '格式化：`[hlsl] editor.tabSize: 2` → 输出缩进 2 空格（缩进取 FormattingOptions，不重复造配置）': async () => {
    await vscode.workspace
      .getConfiguration()
      .update('[hlsl]', { 'editor.tabSize': 2, 'editor.insertSpaces': true }, vscode.ConfigurationTarget.Workspace);
    const file = write('Assets/fmt-hlsl.hlsl', ['float4 g() {', 'float4 a = 0;', 'return a;', '}', '']);
    const doc = await open(file);
    await vscode.commands.executeCommand('editor.action.formatDocument');
    await sleep(600);
    const lines = doc.getText().split('\n');
    assert.strictEqual(lines[1], '  float4 a = 0;', `应缩进 2 空格，实际 ${JSON.stringify(lines[1])}`);
    // 幂等：再排一次不再变化
    await vscode.commands.executeCommand('editor.action.formatDocument');
    await sleep(600);
    assert.strictEqual(doc.getText().split('\n')[1], '  float4 a = 0;');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.workspace
      .getConfiguration()
      .update('[hlsl]', undefined, vscode.ConfigurationTarget.Workspace);
  },

  '格式化：`intraLineSpacing` / `braceSplitting` 改值即时生效（不重载窗口，范围 9）': async () => {
    await waitReady();
    await vscode.workspace
      .getConfiguration()
      .update('[unityshader]', { 'editor.tabSize': 4, 'editor.insertSpaces': true, 'editor.detectIndentation': false }, vscode.ConfigurationTarget.Workspace);
    const fixture = [
      'Shader "Sw"', '{', 'SubShader', '{', 'Pass', '{', 'CGPROGRAM',
      'float4 f()', '{', '    return   0;}', 'ENDCG', '}', '}', '}', '',
    ];
    const file = write('Assets/fmt-switches.shader', fixture);
    let doc = await open(file);
    // 默认（两个开关都开）：CG 内部归一空白 + 拆行尾 `}`
    await vscode.commands.executeCommand('editor.action.formatDocument');
    await sleep(800);
    let got = doc.getText().split('\n');
    assert.strictEqual(got[7], '                float4 f()', `CG 内部应缩进一级，实际 ${JSON.stringify(got[7])}`);
    assert.strictEqual(got[9], '                    return 0;', `默认应归一空白并拆行尾 }，实际 ${JSON.stringify(got[9])}`);
    assert.strictEqual(got[10], '                }');
    // 关掉两个开关 → 同一夹具：空白不动、`}` 不拆。改值走 didChangeConfiguration，不重载窗口。
    // 注意：嵌套键必须从根写全名（`getConfiguration('unityShader').update('intraLineSpacing')`
    // 会解析成 `unityShader.intraLineSpacing` → 「not a registered configuration」）
    await vscode.workspace.getConfiguration().update('unityShader.formatting.intraLineSpacing', false, vscode.ConfigurationTarget.Workspace);
    await vscode.workspace.getConfiguration().update('unityShader.formatting.braceSplitting', false, vscode.ConfigurationTarget.Workspace);
    await sleep(900);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await sleep(400);
    doc = await open(file);
    await vscode.commands.executeCommand('editor.action.formatDocument');
    await sleep(800);
    got = doc.getText().split('\n');
    assert.strictEqual(got[9], '                    return   0;}', `关掉后应保留原空白与粘连 }，实际 ${JSON.stringify(got[9])}`);
    await vscode.workspace.getConfiguration().update('unityShader.formatting.intraLineSpacing', undefined, vscode.ConfigurationTarget.Workspace);
    await vscode.workspace.getConfiguration().update('unityShader.formatting.braceSplitting', undefined, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await vscode.workspace.getConfiguration().update('[unityshader]', undefined, vscode.ConfigurationTarget.Workspace);
  },

  '格式化：注入打印器抛错 → 文档零改动（失败即不改）': async () => {
    const file = write('Assets/fmt-throw.shader', MESSY_SHADER);
    const doc = await open(file);
    const before = doc.getText();
    const flag = path.join(ws, 'format-fail.flag');
    fs.writeFileSync(flag, 'inject', 'utf8');
    try {
      const edits = await vscode.commands.executeCommand(
        'vscode.executeFormatDocumentProvider',
        doc.uri,
        { tabSize: 4, insertSpaces: true }
      );
      assert.ok(!edits || edits.length === 0, `抛错时不应返回编辑，实际 ${JSON.stringify(edits && edits.length)}`);
      await vscode.commands.executeCommand('editor.action.formatDocument');
      await sleep(800);
      assert.strictEqual(doc.getText(), before, '抛错后文档必须字节不变');
    } finally {
      fs.rmSync(flag, { force: true });
    }
    // 标志撤掉后恢复正常（编辑器会把整篇编辑拆成逐行编辑，这里只断言「有编辑」）
    const back = await vscode.commands.executeCommand(
      'vscode.executeFormatDocumentProvider',
      doc.uri,
      { tabSize: 4, insertSpaces: true }
    );
    assert.ok(Array.isArray(back) && back.length > 0, '撤掉注入后应恢复可格式化');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  },

  '格式化：超 `maxFormatFileSize` → 零改动': async () => {
    const file = write('Assets/fmt-big.shader', MESSY_SHADER);
    const doc = await open(file);
    await vscode.workspace
      .getConfiguration('unityShader')
      .update('maxFormatFileSize', 64, vscode.ConfigurationTarget.Workspace);
    await sleep(900);
    const edits = await vscode.commands.executeCommand(
      'vscode.executeFormatDocumentProvider',
      doc.uri,
      { tabSize: 4, insertSpaces: true }
    );
    assert.ok(!edits || edits.length === 0, '超限应返回空');
    await vscode.workspace
      .getConfiguration('unityShader')
      .update('maxFormatFileSize', undefined, vscode.ConfigurationTarget.Workspace);
    await sleep(900);
    const back = await vscode.commands.executeCommand(
      'vscode.executeFormatDocumentProvider',
      doc.uri,
      { tabSize: 4, insertSpaces: true }
    );
    assert.ok(Array.isArray(back) && back.length > 0, '恢复默认后应可格式化');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  },

  '格式化：`__indexStats.formatting` 计数与健康行可观察': async () => {
    const file = write('Assets/fmt-stats.shader', MESSY_SHADER);
    const doc = await open(file);
    const before = (await stats()).formatting;
    await vscode.commands.executeCommand('editor.action.formatDocument');
    await sleep(800);
    const after = (await stats()).formatting;
    assert.ok(after.requests > before.requests, '每次请求都应计数');
    assert.strictEqual(after.switches.enable, true);
    // 范围 9：6 开关都在配置面里可见；范围 14：健康字段 `cg=` 可观察
    assert.strictEqual(after.switches.intraLineSpacing, true);
    assert.strictEqual(after.switches.braceSplitting, true);
    assert.strictEqual(typeof after.cgBytes, 'number', 'stats.formatting.cgBytes 必须存在');
    // 范围 14：Output 侧健康行 `[format] … cg=` 的行格式。
    // server 的 `log()` 走 `connection.console.log`（→ Output 通道），落盘在**客户端**日志里，不在 server boot 日志
    const clientLog = process.env.UNITYSHADER_CLIENT_LOG;
    if (clientLog) {
      const health = fs
        .readFileSync(clientLog, 'utf8')
        .split('\n')
        .filter((l) => l.includes('[format] '));
      assert.ok(health.length > 0, '客户端日志里应出现 `[unityshader] [format]` 健康行');
      assert.match(
        health[health.length - 1],
        /\[unityshader\] \[format\] file=.* state=(ok|skip=[a-z0-9:-]+) verbatim=\d+ changed=\d+ cg=\d+/,
        `健康行格式不符：${health[health.length - 1]}`
      );
    }
    assert.ok(after.maxBytes >= 1024 * 1024, 'maxFormatFileSize 默认 1 MiB');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  },
};

module.exports = { tests };
