// T-031 / T-033 集成用例：真实 VS Code 里的 references / rename
// 覆盖：Properties 联动改名 + 资产失效 Info（含「材质」「场景」）、编辑后 rename 立即覆盖新使用处、
// 第二个语言 id（.hlsl）、Temp/compiled-* 不响应。
// 注意：本模块排在 extension.test.js 之前——那边的崩溃用例会永久杀掉 server。
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

async function waitReady(timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const pid = await serverPid();
    const stats = await indexStats();
    if (pid && stats && stats.files >= 1 && stats.symbols >= 1 && stats.indexing === false) return stats;
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

/** WorkspaceEdit（ext-host 返回的是 vscode.WorkspaceEdit 实例或 DTO）→ "basename:line:char → newText" 列表 */
function editEntries(we) {
  const out = [];
  if (!we) return out;
  const push = (uri, edits) => {
    const f = decodeURIComponent(String(uri).split('/').pop());
    for (const e of edits || []) {
      out.push(`${f}:${e.range.start.line}:${e.range.start.character}→${e.newText}`);
    }
  };
  if (we.changes) for (const [uri, edits] of Object.entries(we.changes)) push(uri, edits);
  if (Array.isArray(we.edits)) for (const e of we.edits) push(e.uri ?? e.uriString ?? e.resource, e.edits ?? e.textEdits);
  const ent = typeof we.entries === 'function' ? we.entries() : we.entries;
  if (Array.isArray(ent)) for (const [uri, edits] of ent) push(uri, edits);
  if (Array.isArray(we.all)) for (const item of we.all) push(item[0], item[2] ?? item[1]);
  return out;
}

exports.tests = {
  'T-031：Properties 联动改名（vscode-test 一例）': async () => {
    const file = write(
      path.join('Assets', 'rn1.shader'),
      [
        'Shader "Rn/Prop"', //                                      0
        '{', //                                                    1
        '  Properties { _MainTex("Tex", 2D) = "white" {} }', //    2
        '  SubShader { Pass { HLSLPROGRAM', //                     3
        '  TEXTURE2D(_MainTex);', //                               4
        '  SAMPLER(sampler_MainTex);', //                          5
        '  float4 frag(float2 uv : TEXCOORD0) : SV_Target { return SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, uv); }', // 6
        '  ENDHLSL } }', //                                        7
        '}', //                                                    8
      ]
    );
    const doc = await open(file);
    await waitReady();
    const pos = positionOf(doc, '_MainTex', 2);

    // 该 VS Code 构建没有 executePrepareRenameProvider 命令；
    // executeDocumentRenameProvider 内部会先走 prepareRename（拒绝时抛错/空 edits）。
    // 资产失效 Info（window/showMessage）的断言在 vitest 协议级拦截做
    // （vscode API 的 window.showInformationMessage 是只读 getter，测试侧无法替换）。
    const we = await vscode.commands.executeCommand(
      'vscode.executeDocumentRenameProvider',
      doc.uri,
      pos,
      '_BaseMap'
    );
    const entries = new Set(editEntries(we));
    console.log('[rename-integration] edits: ' + [...entries].join(' | '));
    assert.ok(entries.has('rn1.shader:2:15→_BaseMap'), 'Properties 声明应改');
    assert.ok(entries.has('rn1.shader:4:12→_BaseMap'), 'TEXTURE2D 参数应改');
    assert.ok(entries.has('rn1.shader:5:10→sampler_BaseMap'), 'SAMPLER 声明应联动');
    assert.ok([...entries].some((e) => e.includes('→sampler_BaseMap') && e.includes(':6:')), 'SAMPLE_TEXTURE2D 采样器参数应联动');
  },

  'T-033：编辑后新使用处 rename 立即覆盖': async () => {
    const file = write(
      path.join('Assets', 'rn2.hlsl'),
      ['float4 _Sym;', 'float4 use1() { return _Sym; }']
    );
    const doc = await open(file);
    await waitReady();

    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(2, 0), 'float4 use2() { return _Sym; }\n');
    assert.ok(await vscode.workspace.applyEdit(edit), 'applyEdit 失败');

    const pos = positionOf(doc, '_Sym', 2);
    const deadline = Date.now() + 15000;
    let entries = [];
    while (Date.now() < deadline) {
      const we = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', doc.uri, pos, '_Sym2');
      entries = editEntries(we);
      if (entries.length >= 3) break;
      await sleep(500);
    }
    console.log('[rename-integration] 编辑后 edits: ' + entries.join(' | '));
    assert.strictEqual(entries.length, 3, `应覆盖声明 + 两个使用处：${entries.join(' | ')}`);
    assert.ok(entries.some((e) => e.startsWith('rn2.hlsl:2:')), '编辑新增的第 2 行应在 edit 中');
  },

  'T-033：.hlsl（第二个语言 id）references/rename 可用': async () => {
    const file = write(
      path.join('Assets', 'rn3.hlsl'),
      ['float4 _HlslSym;', 'float4 use() { return _HlslSym; }']
    );
    const doc = await open(file);
    await waitReady();
    assert.strictEqual(doc.languageId, 'hlsl', `期望 hlsl，实际 ${doc.languageId}`);
    const pos = positionOf(doc, '_HlslSym', 2);

    const refs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', doc.uri, pos, {
      includeDeclaration: true,
    });
    assert.strictEqual((refs || []).length, 2, `references 应 2 处：${JSON.stringify(refs)}`);

    const we = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', doc.uri, pos, '_HlslSym2');
    assert.strictEqual(editEntries(we).length, 2, 'rename 应 2 处 edit');
  },

  'T-033：Temp/compiled-* references 为空、prepareRename 拒绝': async () => {
    const file = write(
      path.join('Temp', 'compiled-rn.shader'),
      ['Shader "G/Rn"', '{', '  SubShader { Pass { CGPROGRAM', '  float4 _TempSym;', '  float4 u() { return _TempSym; }', '  ENDCG } }', '}']
    );
    const doc = await open(file);
    await waitReady();
    const pos = positionOf(doc, '_TempSym', 2);

    const refs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', doc.uri, pos, {
      includeDeclaration: true,
    });
    assert.strictEqual((refs || []).length, 0, `生成文件 references 应为空：${JSON.stringify(refs)}`);
    let rejected = false;
    try {
      const we = await vscode.commands.executeCommand(
        'vscode.executeDocumentRenameProvider',
        doc.uri,
        pos,
        '_TempRenamed'
      );
      rejected = editEntries(we).length === 0;
    } catch {
      rejected = true; // 命令对拒绝直接抛错（"The element can't be renamed."）
    }
    assert.ok(rejected, '生成文件 rename 应被拒绝（空 edits 或抛错）');
  },
};
