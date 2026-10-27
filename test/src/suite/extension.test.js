// T-002 集成用例：语言注册、server 启动、崩溃自动重启 ≤3 次后停止
const vscode = require('vscode');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const file = process.env.UNITYSHADER_TEST_FILE;

async function serverPid() {
  return vscode.commands.executeCommand('unityshader/__testServerPid');
}

async function clientState() {
  try {
    return await vscode.commands.executeCommand('unityshader/__testClientState');
  } catch {
    return 'err';
  }
}

async function waitForPid(prev, timeout = 40000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const pid = await serverPid();
    if (pid && pid !== prev) return pid;
    await sleep(500);
  }
  return null;
}

async function waitForNoPid(timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const pid = await serverPid();
    if (!pid) return true;
    await sleep(500);
  }
  return false;
}

async function crashServer() {
  // 外部 kill：与验收描述「kill server 后自动重启」一致
  const pid = await serverPid();
  assert.ok(pid, 'kill 前拿不到 server pid');
  const cp = require('child_process');
  if (typeof cp.kill === 'function') {
    cp.kill(pid);
    return pid;
  }
  if (typeof cp.spawn === 'function') {
    const p = cp.spawn('taskkill', ['/PID', String(pid), '/F']);
    await new Promise((r) => p.on('exit', r));
    return pid;
  }
  // 兜底：进程内崩溃钩子
  try {
    await vscode.commands.executeCommand('unityshader/__testCrash');
  } catch {
    /* 连接中断属预期 */
  }
  return pid;
}

exports.tests = {
  '打开 .shader 文件后语言为 unityshader': async () => {
    assert.ok(file, '缺少 UNITYSHADER_TEST_FILE');
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    assert.strictEqual(doc.languageId, 'unityshader');
  },

  'LSP server 启动并持有进程': async () => {
    const pid = await waitForPid(null);
    assert.ok(pid, '40s 内未拿到 server pid');
    assert.ok(typeof pid === 'number' && pid > 0);
  },

  'T-005：#region/#endregion 折叠可用': async () => {
    const fs = require('fs');
    const path = require('path');
    const ws = process.env.UNITYSHADER_TEST_WORKSPACE;
    const foldFile = path.join(ws, 'Assets', 'fold.shader');
    fs.writeFileSync(
      foldFile,
      ['Shader "Fold/Demo"', '{', '  //#region 公共属性', '  Properties { _A("A", Float) = 1 }', '  //#endregion', '}', ''].join('\n'),
      'utf8'
    );
    const doc = await vscode.workspace.openTextDocument(foldFile);
    await vscode.window.showTextDocument(doc);
    const ranges = await vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', doc.uri);
    assert.ok(Array.isArray(ranges) && ranges.length >= 1, `未拿到折叠区间：${JSON.stringify(ranges)}`);
  },

  'T-005：shader 片段可插入（补全里出现片段正文）': async () => {
    const doc = await vscode.workspace.openTextDocument({ language: 'unityshader', content: 'shader' });
    const editor = await vscode.window.showTextDocument(doc);
    await new Promise((r) => setTimeout(r, 1500));
    const list = await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider',
      doc.uri,
      new vscode.Position(0, 6)
    );
    const items = (list && list.items) || [];
    const hit = items.find((it) => {
      const insert = it.insertText;
      const text = insert && typeof insert.value === 'string' ? insert.value : String(insert ?? it.label ?? '');
      return /Shader\s*"/.test(text);
    });
    assert.ok(hit, `补全里没有 shader 片段（共 ${items.length} 项）`);
    void editor;
  },

  'server 崩溃后自动重启（前 3 次）': async () => {
    const before = await serverPid();
    console.log(`[crash-test] pid before=${before}`);
    await crashServer();
    const trace = [];
    for (let i = 0; i < 15; i++) {
      await sleep(2000);
      trace.push(`t+${(i + 1) * 2}s state=${await clientState()} pid=${await serverPid()}`);
    }
    console.log('[crash-test] ' + trace.join(' | '));
    const bootLog = process.env.UNITYSHADER_SERVER_LOG;
    if (bootLog) {
      try {
        console.log('[crash-test] boots: ' + fs.readFileSync(bootLog, 'utf8').trim().split('\n').join(' | '));
      } catch (e) {
        console.log('[crash-test] boot log 不可读: ' + e.message);
      }
    }
    const clog = process.env.UNITYSHADER_CLIENT_LOG;
    if (clog) {
      try {
        console.log('[crash-test] client: ' + fs.readFileSync(clog, 'utf8').trim().split('\n').join(' | '));
      } catch (e) {
        console.log('[crash-test] client log 不可读: ' + e.message);
      }
    }
    const after = await waitForPid(before, 10000);
    assert.ok(after, `第一次崩溃后未重启（before=${before}）`);
    assert.notStrictEqual(after, before);

    const b2 = after;
    await crashServer();
    const a2 = await waitForPid(b2);
    assert.ok(a2, '第二次崩溃后未重启');

    await crashServer();
    const a3 = await waitForPid(a2);
    assert.ok(a3, '第三次崩溃后未重启');
  },

  '第 4 次崩溃后不再重启': async () => {
    await crashServer();
    const gone = await waitForNoPid(25000);
    assert.ok(gone, '第 4 次崩溃后仍在重启，重启上限未生效');
    // 再观察 12s：确认没有新的 server 进程出现
    for (let i = 0; i < 6; i++) {
      await sleep(2000);
      const pid = await serverPid();
      assert.ok(!pid, `重启上限失效：观察期出现 pid=${pid}`);
    }
    const clog = process.env.UNITYSHADER_CLIENT_LOG;
    if (clog) {
      try {
        const lines = fs.readFileSync(clog, 'utf8').trim().split('\n');
        console.log('[final-crash] client tail: ' + lines.slice(-12).join(' | '));
      } catch (e) {
        console.log('[final-crash] client log 不可读: ' + e.message);
      }
    }
  },
};
