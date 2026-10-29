// T-075/T-076/T-077 集成用例：语言 id 共存第 2/3 层（规格 feature-language-id-coexistence）
// 覆盖：无效关联下打开文档自愈到 unityshader、已注册 id 关联不动、手动 plaintext 不覆盖、
//       幂等（≤1 次/会话、切回不再切）、命令写工作区级/用户级、条目级不整对象覆盖、
//       连跑两次 fixed=0、混合 glob 只报告不改写（但自愈仍生效）、settings 只读 → write-failed。
//
// 观测口径：`doc.languageId` 直接断言（自愈走 languages.setTextDocumentLanguage，真实编辑器路径）；
// 命令返回值结构化（fixed/scanned/target/error/skippedMixed）；切换计数走测试钩子
// `unityshader/__testLanguageIdScan`（本会话累计切换次数 ≤1/文档）。
// 注意：本模块排在 extension.test.js 之前——那边的崩溃用例会永久杀掉 server。
const vscode = require('vscode');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = process.env.UNITYSHADER_TEST_WORKSPACE;
const SETTINGS_FILE = path.join(ws, '.vscode', 'settings.json');

function write(name, lines) {
  const file = path.join(ws, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

async function setWsAssoc(value) {
  await vscode.workspace.getConfiguration('files').update('associations', value, vscode.ConfigurationTarget.Workspace);
  await sleep(700);
}

async function setGlobalAssoc(value) {
  await vscode.workspace.getConfiguration('files').update('associations', value, vscode.ConfigurationTarget.Global);
  await sleep(700);
}

const wsAssocValue = () => vscode.workspace.getConfiguration('files').inspect('associations')?.workspaceValue ?? {};
const globalAssocValue = () => vscode.workspace.getConfiguration('files').inspect('associations')?.globalValue ?? {};

async function waitLangId(doc, expected, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (doc.languageId === expected) return true;
    await sleep(200);
  }
  return doc.languageId === expected;
}

const SHADER_LINES = ['Shader "LangId/Demo"', '{', '  SubShader { Pass { } }', '}'];

const tests = {
  'language-id：无效关联（*.shader→UnityShader 未注册）→ 打开即自愈到 unityshader': async () => {
    await setWsAssoc({ '*.shader': 'UnityShader', '*.hlsl': 'UnityShader' });
    const file = write('Assets/langid-a.shader', SHADER_LINES);
    const doc = await vscode.workspace.openTextDocument(file);
    // 前置事实：未注册 id 的关联让 VS Code 回落 plaintext（若不回落，本用例前提就不成立）
    assert.ok(['plaintext', 'unityshader'].includes(doc.languageId), `初始 languageId 异常：${doc.languageId}`);
    const ok = await waitLangId(doc, 'unityshader');
    assert.ok(ok, `自愈未切换：实际 ${doc.languageId}`);
    // `.hlsl` 关联同样自愈到 hlsl
    const hlslFile = write('Assets/langid-a.hlsl', ['float4 f(){ return 0; }', '']);
    const hlslDoc = await vscode.workspace.openTextDocument(hlslFile);
    const ok2 = await waitLangId(hlslDoc, 'hlsl');
    assert.ok(ok2, `.hlsl 自愈目标不对：${hlslDoc.languageId}`);
  },

  'language-id：关联指向已注册 id（hlsl）→ 不动（条件③不成立）': async () => {
    await setWsAssoc({ '*.shader': 'hlsl' });
    const file = write('Assets/langid-b.shader', SHADER_LINES);
    const doc = await vscode.workspace.openTextDocument(file);
    assert.strictEqual(doc.languageId, 'hlsl', '已注册关联应直接生效');
    await sleep(900);
    assert.strictEqual(doc.languageId, 'hlsl', '已注册关联不得被自愈改切');
  },

  'language-id：无无效关联时手动 plaintext → 扫描后仍 plaintext（用户意图优先）': async () => {
    await setWsAssoc({});
    const file = write('Assets/langid-c.shader', SHADER_LINES);
    const doc = await vscode.workspace.openTextDocument(file);
    assert.strictEqual(doc.languageId, 'unityshader');
    await vscode.languages.setTextDocumentLanguage(doc, 'plaintext');
    await vscode.commands.executeCommand('unityshader/__testLanguageIdScan');
    await sleep(400);
    assert.strictEqual(doc.languageId, 'plaintext', '手动 plaintext（无无效关联）不应被覆盖');
  },

  'language-id：幂等——一次会话 setTextDocumentLanguage ≤1；切回 plaintext 不再切': async () => {
    await setWsAssoc({ '*.shader': 'UnityShader' });
    const file = write('Assets/langid-d.shader', SHADER_LINES);
    const doc = await vscode.workspace.openTextDocument(file);
    const ok = await waitLangId(doc, 'unityshader');
    assert.ok(ok, '打开应自愈');
    const st1 = await vscode.commands.executeCommand('unityshader/__testLanguageIdScan');
    const uri = doc.uri.toString();
    assert.ok(st1.switched.includes(uri), '已切集合应含该文档');
    await vscode.languages.setTextDocumentLanguage(doc, 'plaintext');
    const st2 = await vscode.commands.executeCommand('unityshader/__testLanguageIdScan');
    await sleep(400);
    assert.strictEqual(doc.languageId, 'plaintext', '切回 plaintext 本会话不再切');
    assert.strictEqual(st2.switches, st1.switches, `切换计数不应增长：${st1.switches} -> ${st2.switches}`);
  },

  'language-id：autoFixLanguageId 关 → 不自愈（仍 plaintext）；已切的不回滚': async () => {
    // 自包含：先开关联把一个新文档切好（自愈路径），再关开关断言「不回滚 + 新文档不自愈」。
    // 不依赖其它用例留下的文档状态——关联一变，VS Code 会重分类已打开文档，跨用例状态不可靠。
    await setWsAssoc({ '*.shader': 'UnityShader' });
    const fileA = write('Assets/langid-g.shader', SHADER_LINES);
    const docA = await vscode.workspace.openTextDocument(fileA);
    const ok = await waitLangId(docA, 'unityshader');
    assert.ok(ok, `前置：开关开着时应先自愈：${docA.languageId}`);
    try {
      await vscode.workspace
        .getConfiguration('unityShader')
        .update('autoFixLanguageId', false, vscode.ConfigurationTarget.Workspace);
      await sleep(700);
      assert.strictEqual(docA.languageId, 'unityshader', '开关关不回滚已切文档（我们的自愈不主动回滚）');
      const file = write('Assets/langid-f.shader', SHADER_LINES);
      const doc = await vscode.workspace.openTextDocument(file);
      await sleep(1500);
      assert.strictEqual(doc.languageId, 'plaintext', '开关关 → 不自愈（规格验收 6）');
      await vscode.commands.executeCommand('unityshader/__testLanguageIdScan');
      await sleep(400);
      assert.strictEqual(doc.languageId, 'plaintext', '开关关时手动扫描也不自愈');
    } finally {
      await vscode.workspace
        .getConfiguration('unityShader')
        .update('autoFixLanguageId', true, vscode.ConfigurationTarget.Workspace);
      await setWsAssoc({});
    }
  },

  '命令：写工作区级——只有命中条目被改写，其余条目与其它设置键不动': async () => {
    await setWsAssoc({ '*.shader': 'UnityShader', '*.hlsl': 'UnityShader', '*.txt': 'plaintext' });
    const before = fs.existsSync(SETTINGS_FILE) ? fs.readFileSync(SETTINGS_FILE, 'utf8') : '';
    const res = await vscode.commands.executeCommand('unityshader.fixFileAssociations', 'workspace');
    assert.strictEqual(res.fixed, 2, `应修 2 条：${JSON.stringify(res)}`);
    assert.strictEqual(res.target, 'workspace');
    const v = wsAssocValue();
    assert.strictEqual(v['*.shader'], 'unityshader');
    assert.strictEqual(v['*.hlsl'], 'hlsl');
    assert.strictEqual(v['*.txt'], 'plaintext', '未命中条目必须原样保留');
    if (before.includes('unityEditorPath')) {
      const after = fs.existsSync(SETTINGS_FILE) ? fs.readFileSync(SETTINGS_FILE, 'utf8') : '';
      assert.ok(after.includes('unityEditorPath'), '写关联不得清掉 settings.json 里的其它键');
    }
  },

  '命令：User 级写入——工作区 settings 文件不动': async () => {
    const wsMtimeBefore = fs.existsSync(SETTINGS_FILE) ? fs.statSync(SETTINGS_FILE).mtimeMs : 0;
    await setGlobalAssoc({ '*.cginc': 'UnityShader' });
    const res = await vscode.commands.executeCommand('unityshader.fixFileAssociations', 'user');
    assert.strictEqual(res.fixed, 1, `应修 1 条：${JSON.stringify(res)}`);
    assert.strictEqual(res.target, 'user');
    assert.strictEqual(globalAssocValue()['*.cginc'], 'hlsl', '用户级条目应改写');
    if (fs.existsSync(SETTINGS_FILE)) {
      assert.strictEqual(fs.statSync(SETTINGS_FILE).mtimeMs, wsMtimeBefore, 'User 级写入不得碰工作区文件');
    }
    await setGlobalAssoc({});
  },

  '命令：无可修条目 → fixed=0 且 settings.json mtime 不变；连跑两次第二次仍 0': async () => {
    await setWsAssoc({});
    const mtimeBefore = fs.existsSync(SETTINGS_FILE) ? fs.statSync(SETTINGS_FILE).mtimeMs : 0;
    const r1 = await vscode.commands.executeCommand('unityshader.fixFileAssociations', 'workspace');
    assert.strictEqual(r1.fixed, 0);
    const r2 = await vscode.commands.executeCommand('unityshader.fixFileAssociations', 'workspace');
    assert.strictEqual(r2.fixed, 0, '连跑两次第二次应 fixed=0');
    if (fs.existsSync(SETTINGS_FILE)) {
      assert.strictEqual(fs.statSync(SETTINGS_FILE).mtimeMs, mtimeBefore, '无可修条目不应写 settings.json');
    }
  },

  '命令：混合 glob `*.{shader,cg}` 只报告不改写（skippedMixed），但运行时自愈仍生效': async () => {
    await setWsAssoc({ '*.{shader,cg}': 'UnityShader' });
    try {
      const file = write('Assets/langid-e.shader', SHADER_LINES);
      const doc = await vscode.workspace.openTextDocument(file);
      const ok = await waitLangId(doc, 'unityshader');
      assert.ok(ok, `混合 glob 下自愈应生效（条件③满足）：实际 ${doc.languageId}`);
      const res = await vscode.commands.executeCommand('unityshader.fixFileAssociations', 'workspace');
      assert.strictEqual(res.fixed, 0, `混合 glob 不应改写：${JSON.stringify(res)}`);
      assert.deepStrictEqual(res.skippedMixed, ['*.{shader,cg}']);
      assert.strictEqual(wsAssocValue()['*.{shader,cg}'], 'UnityShader', '混合 glob 条目应原样保留');
    } finally {
      await setWsAssoc({});
    }
  },

  '命令：settings 只读 → error=write-failed + 提示，扩展不崩': async () => {
    // 备份取在改关联**之前**：失败路径的恢复必须把文件带回「无无效关联」的状态，
    // 否则脏模型/残留关联会污染后续套件（上一轮跑就是这么翻车的）。
    const backup = fs.existsSync(SETTINGS_FILE) ? fs.readFileSync(SETTINGS_FILE, 'utf8') : null;
    await setWsAssoc({ '*.shader': 'UnityShader' });
    assert.ok(fs.existsSync(SETTINGS_FILE), '夹具应先有 .vscode/settings.json（上一步写入创建）');
    fs.chmodSync(SETTINGS_FILE, 0o444);
    let res = null;
    try {
      res = await vscode.commands.executeCommand('unityshader.fixFileAssociations', 'workspace');
    } catch (err) {
      // 不同 VS Code 版本可能把写错误直接抛给调用方：同样算「失败可观察」
      res = { error: /write|EPERM|EntryWriteLocked|unsaved/i.test(String(err)) ? 'write-failed' : `unexpected: ${err}` };
    } finally {
      fs.chmodSync(SETTINGS_FILE, 0o666);
      if (backup !== null) fs.writeFileSync(SETTINGS_FILE, backup, 'utf8');
      // 写失败后 VS Code 会把 settings 留成脏模型（config API 会拒绝后续写入）：开出来 revert 掉
      const sUri = vscode.Uri.file(SETTINGS_FILE);
      const sDoc = await vscode.workspace.openTextDocument(sUri);
      await vscode.window.showTextDocument(sDoc);
      await vscode.commands.executeCommand('workbench.action.files.revert');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await sleep(900);
    }
    assert.strictEqual(res.error, 'write-failed', JSON.stringify(res));
    assert.ok(!wsAssocValue()['*.shader'], '写失败后关联不应被改写');
    // 扩展不崩：客户端命令面仍在
    const st = await vscode.commands.executeCommand('unityshader/__testLanguageIdState');
    assert.ok(st && typeof st.switches === 'number');
  },
};

module.exports = { tests };
