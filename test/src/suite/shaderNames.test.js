// T-069 / T-072 集成用例：shader 名索引的补全与跳转 + 变体报告命令的只读性
// （规格 feature-shader-name-index-and-variant-report 范围 2/3/4/10 的验收）。
//
// 观测口径：VS Code 内置的补全/跳转 provider（真实编辑器路径），
// 以及两个报告命令 `unityshader.reportVariants` / `unityshader.reportVariantsProject` 的返回值。
// 只读断言用「跑命令前后全工作区 mtime+size 快照比对」——server 是独立进程，客户端拦不住它的 fs 调用，
// 但写没写文件是**可观察**的：任何新建/改写都会改变快照。
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

function colOf(file, line, needle, offset) {
  const text = fs.readFileSync(file, 'utf8').split('\n')[line];
  const i = text.indexOf(needle);
  assert.ok(i >= 0, `第 ${line} 行找不到 "${needle}"`);
  return i + offset;
}

/** 只快照 Unity 工程的四类目录（规格范围 10 点名的写入面），跳过测试夹具自己的 `*.log`
 *  （`client-state.log` 由测试夹具写，与报告命令无关）。 */
function snapshot(root) {
  const out = new Map();
  const stack = ['Assets', 'Packages', 'Library', 'ProjectSettings'].map((d) => path.join(root, d));
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'Temp' || e.name === '.git') continue;
        stack.push(full);
      } else if (/\.log$/i.test(e.name)) {
        continue; // 夹具自己的日志
      } else {
        try {
          const st = fs.statSync(full);
          out.set(full, `${st.mtimeMs}|${st.size}`);
        } catch {
          /* 竞态删除：忽略 */
        }
      }
    }
  }
  return out;
}

const TARGET = [
  'Shader "M6a/Target Shader With Space"',
  '{',
  '  SubShader',
  '  {',
  '    Pass { Name "BASE" }',
  '  }',
  '}',
];

const CONSUMER = [
  'Shader "M6a/Consumer"',
  '{',
  '  SubShader',
  '  {',
  '    UsePass "M6a/Target Shader With Space"',
  '    Pass',
  '    {',
  '      HLSLPROGRAM',
  '      #pragma multi_compile A B C',
  '      #pragma multi_compile_fwdbase',
  '      float4 f(){return 0;}',
  '      ENDHLSL',
  '    }',
  '  }',
  '  Fallback "M6a/Target Shader With Space"',
  '}',
];

const tests = {
  'shaderNames: 索引 + 补全 + 跳转 + 报告命令只读': async () => {
    const target = write('Assets/m6a-target.shader', TARGET);
    const consumer = write('Assets/m6a-consumer.shader', CONSUMER);
    await waitReady();

    const consumerUri = vscode.Uri.file(consumer);
    const doc = await vscode.workspace.openTextDocument(consumerUri);
    await vscode.window.showTextDocument(doc);

    // 等索引真的扫到 `m6a-target.shader`（跑全套时工作区里已有几十个文件，
    // 只按 `files >= 2` 等待会提前放行）：用跳转本身当探针，命中即索引就绪。
    const upLine = 4;
    const upCol = colOf(consumer, upLine, 'M6a/Target Shader With Space', 8);
    let locs = [];
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      locs = (await vscode.commands.executeCommand('vscode.executeDefinitionProvider', consumerUri, new vscode.Position(upLine, upCol))) ?? [];
      if (locs.length >= 1) break;
      await sleep(1000);
    }
    assert.ok(locs.length >= 1, 'UsePass 跳转无结果（索引未扫到 target shader）');
    const s = await stats();
    assert.ok(s && s.shaderNames >= 2, `索引统计缺 shader 名计数：${JSON.stringify(s && s.shaderNames)}`);
    assert.ok(locs[0].uri.fsPath.replace(/\\/g, '/').endsWith('m6a-target.shader'), `跳转目标不对：${locs[0].uri.fsPath}`);
    assert.strictEqual(locs[0].range.start.line, 0, '跳转应落在 `Shader "…"` 那一行');

    // 1) `Fallback "` 处补全 → 候选含带空格的名字
    const fbLine = 14;
    const fbCol = colOf(consumer, fbLine, 'Fallback "', 'Fallback "'.length);
    const list = await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider',
      consumerUri,
      new vscode.Position(fbLine, fbCol)
    );
    const labels = (list?.items ?? []).map((i) => i.label);
    assert.ok(labels.includes('M6a/Target Shader With Space'), `Fallback 补全缺目标名：${labels.slice(0, 12).join(', ')}`);

    // 2) `Fallback Off` 位置（未开引号）→ 不给 shader 名候选
    const offFile = write('Assets/m6a-off.shader', ['Shader "M6a/OffCase"', '{', '  SubShader { Pass { } }', '  Fallback Off', '}']);
    const offUri = vscode.Uri.file(offFile);
    const offList = await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider',
      offUri,
      new vscode.Position(3, colOf(offFile, 3, 'Fallback Off', 'Fallback '.length))
    );
    const offLabels = (offList?.items ?? []).map((i) => i.label);
    assert.ok(!offLabels.includes('M6a/Target Shader With Space'), 'Fallback Off 处不应给 shader 名候选');

    // 3) `UsePass "…"` 上 F12 的落点已在上面的「索引就绪」轮询里断言（同一请求，不重复发）

    // 4) 两个报告命令 + **只读断言**：跑命令前后全工作区 mtime+size 不变、无新文件
    const before = snapshot(ws);
    const fileRes = await vscode.commands.executeCommand('unityshader.reportVariants');
    const projRes = await vscode.commands.executeCommand('unityshader.reportVariantsProject');
    const after = snapshot(ws);

    assert.ok(fileRes && !fileRes.error, `当前文件报告失败：${JSON.stringify(fileRes)}`);
    assert.ok(projRes && !projRes.error, `工程报告失败：${JSON.stringify(projRes)}`);
    const text = (fileRes.lines ?? []).join('\n');
    assert.ok(/combinations=4\b/.test(text), `报告缺 combinations=4：${text}`);
    assert.ok(/builtin-groups=1/.test(text) && /unavailable/.test(text), '报告缺内置组与 unavailable 口径');
    assert.ok(/material-evidence=(none|present)/.test(text), '报告缺 material-evidence 口径');
    assert.ok(/builtin-shader-names=unavailable/.test(text), '报告缺 `builtin-shader-names=unavailable`（roadmap M6 验收 1 的显式口径）');

    const changed = [];
    for (const [f, sig] of after) if (before.get(f) !== sig) changed.push(f);
    const added = [...after.keys()].filter((f) => !before.has(f));
    assert.deepStrictEqual(added, [], `报告命令新建了文件：${added.join(', ')}`);
    assert.deepStrictEqual(changed, [], `报告命令改写了文件：${changed.join(', ')}`);
    assert.ok(before.size >= 3, `快照文件数异常：${before.size}`);
    assert.ok(target && consumer);
  },
};

module.exports = { tests };
