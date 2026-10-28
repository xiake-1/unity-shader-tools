// T-048 集成用例：`#if` 死分支灰化（规格 feature-dead-branch-dimming）
// 覆盖：装饰落地、未知宏不灰、通知契约（uri/version/regions+condition）、
// Range 不含条件行、切换编辑器清空、命令与 Output 健康行、日志缺失降级 source=none。
//
// 观测口径：客户端测试钩子 `unityshader/__testInactiveDecorations`（活动编辑器上的
// 装饰计数与 Range），server 侧 `unityshader/__indexStats` 的 `inactiveRegions` 段。
// 关键字来自 runTest.js 造的 fixture 日志（`UNITYSHADER_KEYWORD_LOG`），不依赖本机 Unity。
// 注意：本模块排在 extension.test.js 之前——那边的崩溃用例会永久杀掉 server。
const vscode = require('vscode');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = process.env.UNITYSHADER_TEST_WORKSPACE;
const keywordLog = process.env.UNITYSHADER_KEYWORD_LOG;

async function stats() {
  try {
    return await vscode.commands.executeCommand('unityshader/__testIndexStats');
  } catch {
    return null;
  }
}

async function decorations() {
  return (await vscode.commands.executeCommand('unityshader/__testInactiveDecorations')) ?? {};
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

async function waitForDecorations(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last = {};
  while (Date.now() < deadline) {
    last = await decorations();
    if (predicate(last)) return last;
    await sleep(300);
  }
  return null;
}

const DEAD = 'UNITYSHADER_TEST_DEAD';

const tests = {
  '灰化协商：客户端声明 experimental 后 server 才发通知': async () => {
    const s = await waitReady();
    assert.strictEqual(s.inactiveRegions.clientWants, true, '客户端未声明 experimental 支持');
    assert.ok(
      s.inactiveRegions.source && s.inactiveRegions.source === keywordLog,
      `关键字源应为 fixture 日志，实际 ${s.inactiveRegions.source}`
    );
    assert.strictEqual(s.inactiveRegions.disabled, 2, `fixture 日志应有 2 个关闭关键字，实际 ${s.inactiveRegions.disabled}`);
  },

  '灰化：死分支装饰落到活动编辑器，Range 不含条件行': async () => {
    const file = write('Assets/dead.hlsl', [
      'float4 live(){ return 0; }',
      `#if ${DEAD}`,
      '  float4 deadA(){ return 1; }',
      '  float4 deadB(){ return 2; }',
      '#endif',
      'float4 live2(){ return 3; }',
    ]);
    const doc = await open(file);
    const got = await waitForDecorations((d) => d.applied >= 1);
    assert.ok(got, `未拿到灰化装饰；实际 ${JSON.stringify(await decorations())}`);
    assert.strictEqual(got.applied, 1, `应只 1 条装饰，实际 ${got.applied}`);
    assert.deepStrictEqual(got.conditions, [DEAD], `condition 文本不对：${JSON.stringify(got.conditions)}`);
    const [r] = got.ranges;
    // 条件行在 1（0-based），分支体是 2..3
    assert.strictEqual(r.start.line, 2, `起点应在条件行的下一行，实际 ${r.start.line}`);
    assert.strictEqual(r.start.character, 0, '起点应是行首');
    assert.strictEqual(r.end.line, 3, '终点应在 #endif 前一行，实际 ' + r.end.line);
    assert.ok(r.end.character >= '  float4 deadB(){ return 2; }'.length - 1, '终点应是该行行末');
    assert.ok(doc.getText().split('\n')[r.start.line].includes('deadA'), 'Range 起点行应是分支体');
  },

  '灰化：未知宏不灰（宁可不做不可做错）': async () => {
    const file = write('Assets/unknown.hlsl', [
      '#if TOTALLY_UNKNOWN_MACRO_XYZ',
      '  float4 maybe(){ return 0; }',
      '#endif',
    ]);
    await open(file);
    await sleep(2000);
    const d = await decorations();
    assert.strictEqual(d.applied, 0, `未知宏不应产生装饰，实际 ${JSON.stringify(d)}`);
  },

  '切换编辑器后装饰清空': async () => {
    const other = write('Assets/plain.hlsl', ['float4 plain(){ return 0; }']);
    await open(other);
    await sleep(1200);
    const d = await decorations();
    assert.strictEqual(d.applied, 0, `切到无死分支的编辑器后应清空，实际 ${JSON.stringify(d)}`);
  },

  '命令与 Output：refreshShaderKeywords 给出健康行': async () => {
    const r = await vscode.commands.executeCommand('unityshader/__testRefreshKeywords', {});
    assert.ok(r && typeof r.health === 'string', `命令未返回健康行：${JSON.stringify(r)}`);
    assert.match(r.health, /^\[keywords\] source=.+ disabled=2 age=\S+ regions=\d+$/);
    assert.ok(r.health.includes('fixture-Editor.log'), `source 应是 fixture 日志：${r.health}`);
    assert.deepStrictEqual(r.disabled, [DEAD, 'ANOTHER_DEAD']);
  },

  '日志缺失降级：source=none、装饰清空、不弹窗不报错': async () => {
    const missing = path.join(ws, 'no-such-dir', 'Editor.log');
    const deadFile = write('Assets/dead2.hlsl', [`#ifdef ${DEAD}`, '  float4 dead(){ return 1; }', '#endif']);
    await open(deadFile);
    const before = await waitForDecorations((d) => d.applied >= 1);
    assert.ok(before, '日志存在时应先有装饰');
    const r = await vscode.commands.executeCommand('unityshader/__testRefreshKeywords', { logPath: missing });
    assert.ok(r.health.includes('source=none'), `日志缺失应记 source=none：${r.health}`);
    assert.deepStrictEqual(r.disabled, []);
    await sleep(1200);
    const d = await decorations();
    assert.strictEqual(d.applied, 0, `日志缺失后应无装饰，实际 ${JSON.stringify(d)}`);
    // 复位到 fixture 日志，后续用例不受影响
    await vscode.commands.executeCommand('unityshader/__testRefreshKeywords', { logPath: keywordLog });
  },

  '灰化不影响 F12：死分支内的声明仍可跳转（回归口径见 test/unit/deadBranchRegression.test.ts）': async () => {
    const file = write('Assets/dead-f12.hlsl', [
      `#if ${DEAD}`,
      'float4 _DeadTex;',
      '#endif',
      'float4 use(){ return _DeadTex; }',
    ]);
    const doc = await open(file);
    const text = doc.getText();
    const at = doc.positionAt(text.indexOf('_DeadTex;') + 3);
    const r = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', doc.uri, at);
    assert.ok(Array.isArray(r) && r.length >= 1, `死分支内的声明应可跳转，实际 ${JSON.stringify(r)}`);
    assert.strictEqual(r[0].range.start.line, 1, '应跳到声明行');
  },
};

module.exports = { tests };
