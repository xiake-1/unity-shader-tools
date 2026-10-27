// T-018 / T-019 集成用例：真实 VS Code 里按 F12（vscode.executeDefinitionProvider）
// 覆盖：跨文件与同文件跳转、编辑后即时可跳、无定义面、另一语言 id（.hlsl）、
// ADR 0006 第 1 层的 documentSelector 覆盖、生成文件不响应。
// 注意：本模块必须排在 extension.test.js 之前——那边的崩溃用例会永久杀掉 server。
const vscode = require('vscode');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = process.env.UNITYSHADER_TEST_WORKSPACE;

async function serverPid() {
  try {
    return await vscode.commands.executeCommand('unityshader/__testServerPid');
  } catch {
    return null;
  }
}

async function indexStats() {
  try {
    return await vscode.commands.executeCommand('unityshader/__testIndexStats');
  } catch {
    return null;
  }
}

/** 等 server 起来并完成首轮索引（跳转依赖符号索引） */
async function waitReady(timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const pid = await serverPid();
    const stats = await indexStats();
    if (pid && stats && stats.files >= 1 && stats.symbols >= 1) return stats;
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

function positionOf(doc, needle, offset = 0) {
  const i = doc.getText().indexOf(needle);
  assert.ok(i >= 0, `文档里找不到 "${needle}"`);
  return doc.positionAt(i + offset);
}

async function defAt(doc, needle, offset = 0) {
  const pos = positionOf(doc, needle, offset);
  const locs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', doc.uri, pos);
  return locs ?? [];
}

/** 编辑后 LSP 的 didChange 是异步的：轮询到结果稳定为止 */
async function defAtRetry(doc, needle, offset, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last = [];
  while (Date.now() < deadline) {
    last = await defAt(doc, needle, offset);
    if (last.length) return last;
    await sleep(500);
  }
  return last;
}

function textAt(doc, loc) {
  const range = loc.range || (loc.targetRange ?? loc);
  return doc.getText(range);
}

exports.tests = {
  'T-018：F12 从 _MainTex 用法跳回 Properties 声明（落在名字本身）': async () => {
    const file = write(
      path.join('Assets', 'def.shader'),
      [
        'Shader "Def/Demo"',
        '{',
        '  Properties { _MainTex("Tex", 2D) = "white" {} }',
        '  SubShader',
        '  {',
        '    Pass',
        '    {',
        '      CGPROGRAM',
        '      sampler2D _MainTex;',
        '      float4 _MainTex_ST;',
        '      float4 frag(float2 uv : TEXCOORD0) : SV_Target { return tex2D(_MainTex, uv); }',
        '      ENDCG',
        '    }',
        '  }',
        '}',
      ]
    );
    const doc = await open(file);
    await waitReady();

    const locs = await defAt(doc, 'tex2D(_MainTex', 7);
    console.log(
      '[def-integration] _MainTex 结果: ' +
        JSON.stringify(
          locs.map((l) => ({
            file: path.basename(l.uri.fsPath ?? l.uri.toString()),
            line: l.range.start.line,
            char: l.range.start.character,
          }))
        )
    );
    assert.ok(locs.length >= 2, `跳转结果太少：${JSON.stringify(locs)}`);
    // 注意：VS Code 会把多结果按 URI 重排（实测），「当前文件优先」的服务端顺序
    // 由 vitest（definition.test.ts 断言数组顺序）与真实 stdio 探针保证；
    // 这里只断言「本文件的声明都在，且落在名字 token 上」。
    const same = locs.filter((l) => l.uri.toString() === doc.uri.toString());
    assert.ok(same.length >= 2, `本文件应有 2 处声明：${JSON.stringify(locs)}`);
    assert.strictEqual(same[0].range.start.line, 2, `应落在 Properties 行，实际 ${same[0].range.start.line}`);
    assert.strictEqual(textAt(doc, same[0]), '_MainTex', '应落在声明的名字 token 上');
    assert.ok(
      same.some((l) => l.range.start.line === 8),
      `CGPROGRAM 里的声明行也应出现：${same.map((l) => l.range.start.line).join(',')}`
    );
  },

  'T-018：编辑后新声明立即可跳（增量重解析 + 索引更新）': async () => {
    const file = write(
      path.join('Assets', 'def2.shader'),
      [
        'Shader "Def/Edit"',
        '{',
        '  SubShader',
        '  {',
        '    Pass',
        '    {',
        '      CGPROGRAM',
        '      float4 frag() : SV_Target { return _Inserted; }',
        '      ENDCG',
        '    }',
        '  }',
        '}',
      ]
    );
    const doc = await open(file);
    await waitReady();

    const before = await defAt(doc, 'return _Inserted', 8);
    assert.strictEqual(before.length, 0, `编辑前不该有定义：${JSON.stringify(before)}`);

    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(7, 6), 'float _Inserted;\n');
    const ok = await vscode.workspace.applyEdit(edit);
    assert.ok(ok, 'applyEdit 失败');

    const after = await defAtRetry(doc, 'return _Inserted', 8);
    assert.strictEqual(after.length, 1, `编辑后应命中新声明：${JSON.stringify(after)}`);
    assert.strictEqual(after[0].range.start.line, 7, `新声明应在插入行，实际 ${after[0].range.start.line}`);
    assert.strictEqual(textAt(doc, after[0]), '_Inserted');
  },

  'T-019：无定义面（注释 / 状态命令 / 字面量）返回空': async () => {
    const file = write(
      path.join('Assets', 'def3.shader'),
      [
        'Shader "Def/None"',
        '{',
        '  // _MainTex 出现在注释里',
        '  Properties { _A("A", Float) = 1 }',
        '  SubShader',
        '  {',
        '    Pass { Cull Off }',
        '  }',
        '}',
      ]
    );
    const doc = await open(file);
    await waitReady();

    assert.strictEqual((await defAt(doc, '_MainTex 出现在注释里', 1)).length, 0, '注释里的名字不该有定义');
    assert.strictEqual((await defAt(doc, 'Cull Off', 2)).length, 0, '状态命令不该有定义');
    assert.strictEqual((await defAt(doc, '= 1 }', 2)).length, 0, '数字字面量不该有定义');
  },

  'T-019：.hlsl 文档（第二个语言 id）F12 可用': async () => {
    const file = write(
      path.join('Assets', 'def.hlsl'),
      ['float2 Helper() { return float2(0, 0); }', 'float2 Use() { return Helper(); }']
    );
    const doc = await open(file);
    await waitReady();
    assert.strictEqual(doc.languageId, 'hlsl', `期望 hlsl，实际 ${doc.languageId}`);

    const locs = await defAtRetry(doc, 'return Helper()', 8);
    assert.ok(locs.length >= 1, `hlsl 文档跳转失败：${JSON.stringify(locs)}`);
    assert.strictEqual(locs[0].range.start.line, 0);
  },

  'T-019：documentSelector 覆盖 UnityShader（ADR 0006 第 1 层）': async () => {
    const bundle = path.resolve(__dirname, '..', '..', '..', 'client', 'dist', 'extension.js');
    assert.ok(fs.existsSync(bundle), `先构建 client：${bundle}`);
    const src = fs.readFileSync(bundle, 'utf8');
    assert.match(src, /language:\s*"UnityShader"/, '打包产物里没有 UnityShader 的 documentSelector 条目');
    assert.match(src, /language:\s*"unityshader"/, '打包产物里没有 unityshader 的 documentSelector 条目');
  },

  'T-019：生成文件（Temp/compiled-*）不响应跳转': async () => {
    const file = write(
      path.join('Temp', 'compiled-generated.shader'),
      ['Shader "Gen/Demo"', '{', '  Properties { _G("G", Float) = 1 }', '  SubShader { Pass { CGPROGRAM', '  float4 f() { return _G; }', '  ENDCG } }', '}']
    );
    const doc = await open(file);
    await waitReady();
    const locs = await defAt(doc, 'return _G', 8);
    assert.strictEqual(locs.length, 0, `生成文件不应响应：${JSON.stringify(locs)}`);
  },
};
