// T-027 集成用例：真实 VS Code 里触发补全（vscode.executeCompletionItemProvider）
// 覆盖：成员补全、Unity 宏带文档（真实 PackageCache 源码/兜底表）、include 路径（真实工程）、
// 编辑后新宏立即可补全、第二个语言 id（.hlsl）、生成文件不响应、空结果面。
//
// 关键卫生点：VS Code 会把内置 word-based 补全混进同一结果列表。
// 我们的 LSP 候选一律带 sortText（"rank|label"），断言只看带 sortText 的候选；
// 「应为空」的用例断言的是**带 sortText 的候选为空**，而不是整个列表为空。
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

/** 等 server 起来且首轮索引扫描完成（Unity API 候选依赖包内符号入索引） */
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

async function compAt(doc, needle, offset = 0, trigger) {
  const pos = positionOf(doc, needle, offset);
  const r = await vscode.commands.executeCommand(
    'vscode.executeCompletionItemProvider',
    doc.uri,
    pos,
    trigger
  );
  return r ?? { items: [], isIncomplete: false };
}

/** 只保留我们 LSP provider 的候选：sortText 形如 "rank|label"（word-based 噪声不是这个形态） */
function ours(r) {
  return r.items.filter((i) => typeof i !== 'string' && typeof i.sortText === 'string' && /^\d\|/.test(i.sortText));
}
const ourLabels = (r) => ours(r).map((i) => i.label);

function docText(item) {
  const d = item && item.documentation;
  if (!d) return '';
  return typeof d === 'string' ? d : (d.value ?? '');
}

/** 编辑后 didChange 是异步的：轮询到候选出现为止 */
async function compAtRetry(doc, needle, offset, want, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last = { items: [] };
  while (Date.now() < deadline) {
    last = await compAt(doc, needle, offset);
    if (ourLabels(last).includes(want)) return last;
    await sleep(500);
  }
  return last;
}

exports.tests = {
  'T-027：`i.` 成员补全（struct 字段候选）': async () => {
    const file = write(
      path.join('Assets', 'comp.shader'),
      [
        'Shader "Comp/Members"',
        '{',
        '  SubShader',
        '  {',
        '    Pass',
        '    {',
        '      HLSLPROGRAM',
        '      struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };',
        '      v2f i;',
        '      float4 frag() : SV_Target { float2 q = i.uv; return float4(q, 0, 1); }',
        '      ENDHLSL',
        '    }',
        '  }',
        '}',
      ]
    );
    const doc = await open(file);
    await waitReady();

    const r = await compAt(doc, 'i.uv', 2, '.');
    console.log('[completion-integration] `i.` 我们的候选: ' + ourLabels(r).slice(0, 8).join(','));
    assert.ok(ourLabels(r).includes('uv'), `候选应含 uv：${ourLabels(r).join(',')}`);
    assert.ok(ourLabels(r).includes('pos'), `候选应含 pos：${ourLabels(r).join(',')}`);
  },

  'T-027：Unity 宏补全带文档（真实 PackageCache 源码/兜底表）': async () => {
    const stats0 = await indexStats();
    if (!stats0 || !stats0.includeRoots || !stats0.includeRoots.packageCacheDir) {
      console.log('  – 跳过：fixture 无 PackageCache');
      return;
    }
    const file = write(
      path.join('Assets', 'comp2.shader'),
      [
        'Shader "Comp/Macro"',
        '{',
        '  SubShader',
        '  {',
        '    Pass',
        '    {',
        '      HLSLPROGRAM',
        '      float4 frag() : SV_Target { return SAMPLE_TEXTURE2; }',
        '      ENDHLSL',
        '    }',
        '  }',
        '}',
      ]
    );
    const doc = await open(file);
    const stats = await waitReady();
    console.log(
      `[completion-integration] 索引状态: files=${stats.files} symbols=${stats.symbols} ` +
        `degraded=${(stats.degraded || []).join('|') || 'no'} ` +
        `pc=${stats.includeRoots && stats.includeRoots.packageCacheDir ? 'yes' : 'no'} ` +
        `cg=${stats.includeRoots && stats.includeRoots.cgIncludesDir ? 'yes' : 'no'}`
    );

    const r = await compAt(doc, 'return SAMPLE_TEXTURE2', 14);
    const item = ours(r).find((i) => i.label === 'SAMPLE_TEXTURE2D');
    console.log(
      '[completion-integration] SAMPLE_TEXTURE2D 文档: ' + JSON.stringify(docText(item).slice(0, 60))
    );
    assert.ok(item, `候选应含 SAMPLE_TEXTURE2D：${ourLabels(r).slice(0, 12).join(',')}`);
    assert.ok(docText(item).length > 0, 'SAMPLE_TEXTURE2D 应带非空文档（源码注释或兜底表）');
  },

  'T-027：include 路径补全（真实工程 PackageCache 枚举）': async () => {
    const file = write(
      path.join('Assets', 'comp3.shader'),
      [
        'Shader "Comp/Include"',
        '{',
        '  SubShader',
        '  {',
        '    Pass',
        '    {',
        '      HLSLPROGRAM',
        '      #include "Packages/com.unity.render-pipelines.core/ShaderLibrary/Space"',
        '      float4 frag() : SV_Target { return 0; }',
        '      ENDHLSL',
        '    }',
        '  }',
        '}',
      ]
    );
    const doc = await open(file);
    await waitReady();

    // 光标停在 `Space` 之后（字符串内容内，闭合引号前）
    const r = await compAt(doc, 'ShaderLibrary/Space"', 19, '/');
    const hit = ourLabels(r).some((l) => l.endsWith('SpaceTransforms.hlsl'));
    console.log('[completion-integration] include 我们的候选数: ' + ours(r).length);
    assert.ok(hit, `候选应含 *SpaceTransforms.hlsl：${ourLabels(r).slice(0, 12).join(',')}`);
  },

  'T-027：编辑后新 `#define` 立即可补全': async () => {
    const file = write(
      path.join('Assets', 'comp4.shader'),
      [
        'Shader "Comp/Edit"',
        '{',
        '  SubShader',
        '  {',
        '    Pass',
        '    {',
        '      HLSLPROGRAM',
        '      float4 frag() : SV_Target { return M3_ED; }',
        '      ENDHLSL',
        '    }',
        '  }',
        '}',
      ]
    );
    const doc = await open(file);
    await waitReady();

    const before = await compAt(doc, 'return M3_ED', 8);
    assert.ok(!ourLabels(before).includes('M3_EDIT_MACRO'), '编辑前不该有该宏候选');

    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(7, 6), '#define M3_EDIT_MACRO 1\n');
    assert.ok(await vscode.workspace.applyEdit(edit), 'applyEdit 失败');

    const after = await compAtRetry(doc, 'return M3_ED', 8, 'M3_EDIT_MACRO');
    assert.ok(ourLabels(after).includes('M3_EDIT_MACRO'), `编辑后应命中：${ourLabels(after).slice(0, 12).join(',')}`);
  },

  'T-027：.hlsl 文档（第二个语言 id）补全可用': async () => {
    const file = write(
      path.join('Assets', 'comp.hlsl'),
      ['#define HL_MACRO 1', 'float use() { return HL_; }']
    );
    const doc = await open(file);
    await waitReady();
    assert.strictEqual(doc.languageId, 'hlsl', `期望 hlsl，实际 ${doc.languageId}`);

    const r = await compAt(doc, 'return HL_', 9);
    assert.ok(ourLabels(r).includes('HL_MACRO'), `hlsl 文档补全失败：${ourLabels(r).slice(0, 12).join(',')}`);
  },

  'T-027：生成文件（Temp/compiled-*）我们的补全为空': async () => {
    const file = write(
      path.join('Temp', 'compiled-comp.shader'),
      ['Shader "Gen/Comp"', '{', '  SubShader { Pass { HLSLPROGRAM', '  #define TEMP_MACRO 1', '  float4 f() { return TEMP_; }', '  ENDHLSL } }', '}']
    );
    const doc = await open(file);
    await waitReady();
    const r = await compAt(doc, 'return TEMP_', 8);
    assert.strictEqual(ours(r).length, 0, `生成文件不该有我们的候选：${ourLabels(r).join(',')}`);
  },

  'T-027：空结果面（注释内 / 状态命令）我们的候选为空': async () => {
    const file = write(
      path.join('Assets', 'comp5.shader'),
      [
        'Shader "Comp/Empty"',
        '{',
        '  // SAMPLE_TEXTURE2 出现在注释里',
        '  SubShader',
        '  {',
        '    Pass { Cull Off }',
        '  }',
        '}',
      ]
    );
    const doc = await open(file);
    await waitReady();

    const inComment = await compAt(doc, 'SAMPLE_TEXTURE2 出现在注释里', 5);
    assert.strictEqual(ours(inComment).length, 0, `注释内不该有我们的候选：${ourLabels(inComment).join(',')}`);
    const onCmd = await compAt(doc, 'Cull Off', 2);
    assert.strictEqual(ours(onCmd).length, 0, `状态命令处不该有我们的候选：${ourLabels(onCmd).join(',')}`);
  },

  '2026-10-28 手动测试修复：内置 word-based 补全在两个语言 id 下默认关闭': async () => {
    // 图1 缺陷：`i.` 成员补全混入文档单词（float4/grabPos/SV_POSITION…）。
    // 修复：contributes.configurationDefaults 对 unityshader/hlsl 关闭 editor.wordBasedSuggestions。
    for (const langId of ['unityshader', 'hlsl']) {
      const v = vscode.workspace.getConfiguration('editor', { languageId: langId }).get('wordBasedSuggestions');
      assert.strictEqual(v, 'off', `[${langId}] wordBasedSuggestions 应为 off，实际：${v}`);
    }
  },

  '2026-10-28 手动测试修复：用户变量/Properties 进候选；同名 struct 字段按可见性分层': async () => {
    // 图1：工程内另一编译单元定义不同的 v2f → 不得混进当前文件 `i.`；
    // 图2：当前文件声明的 `_MainTexture`（Properties + HLSL）要出现在标识符候选里。
    write(path.join('Assets', 'comp6_other.hlsl'), ['struct v2f { float4 grabPos; half4 color; };']);
    const file = write(
      path.join('Assets', 'comp6.shader'),
      [
        'Shader "Comp/Usr"',
        '{',
        '  Properties { _MainTexture("T", 2D) = "white" {} }',
        '  SubShader',
        '  {',
        '    Pass',
        '    {',
        '      HLSLPROGRAM',
        '      struct v2f { fixed4 pos : SV_POSITION; fixed3 normal : NORMAL; };',
        '      sampler2D _MainTexture;',
        '      fixed4 frag(v2f i) : SV_Target',
        '      {',
        '        fixed4 c = _Main;',
        '        float2 t = i.uv;',
        '        return c;',
        '      }',
        '      ENDHLSL',
        '    }',
        '  }',
        '}',
      ]
    );
    const doc = await open(file);
    await waitReady();

    const r1 = await compAtRetry(doc, 'fixed4 c = _Main;', 14, '_MainTexture');
    assert.ok(ourLabels(r1).includes('_MainTexture'), `_Main 候选应含 _MainTexture：${ourLabels(r1).slice(0, 15).join(',')}`);

    const r2 = await compAt(doc, 'i.uv', 2);
    const l2 = ourLabels(r2);
    assert.ok(l2.includes('pos') && l2.includes('normal'), `i. 应含当前文件字段：${l2.join(',')}`);
    // comp.shader（早前用例已索引）的 v2f 有 uv；comp6_other 的有 grabPos/color——都不该混进来
    assert.ok(!l2.includes('uv'), `i. 不该混入工程内其他 v2f 字段（uv）：${l2.join(',')}`);
    assert.ok(!l2.includes('grabPos') && !l2.includes('color'), `i. 不该混入 comp6_other 的 v2f 字段：${l2.join(',')}`);
  },

  '2026-10-28 悬停与语义补全（SV_Target 等语义，T-035/T-036）': async () => {
    const file = write(
      path.join('Assets', 'hover1.shader'),
      [
        'Shader "Hover/Demo"',
        '{',
        '  Properties { _HoverTex("T", 2D) = "white" {} }',
        '  SubShader',
        '  {',
        '    Pass',
        '    {',
        '      HLSLPROGRAM',
        '      struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };',
        '      v2f i;',
        '      sampler2D _HoverTex;',
        '      float4 frag(v2f IN) : SV_Target { float4 n = nosuchname; return float4(IN.uv, 0, 1); }',
        '      ENDHLSL',
        '    }',
        '  }',
        '}',
      ]
    );
    const doc = await open(file);
    await waitReady();

    const hoverOnce = async (needle, offset) => {
      let h = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, positionOf(doc, needle, offset));
      if (Array.isArray(h)) h = h[0]; // 本 harness 版本返回 [Hover]
      if (!h) return '';
      const contents = Array.isArray(h.contents) ? h.contents : [h.contents];
      return contents
        .map((c) => {
          if (typeof c === 'string') return c;
          if (c && typeof c === 'object' && typeof c.value === 'string') return c.value;
          return `[shape proto=${Object.getPrototypeOf(c)?.constructor?.name ?? '?'} keys=${JSON.stringify(Object.getOwnPropertyNames(c ?? {}))}]`;
        })
        .join('\n');
    };
    /** 文档同步是异步的：轮询到 hover 非空为止（负例除外） */
    const hoverText = async (needle, offset, timeout = 10000) => {
      const deadline = Date.now() + timeout;
      let last = '';
      while (Date.now() < deadline) {
        last = await hoverOnce(needle, offset);
        if (last) return last;
        await sleep(500);
      }
      return last;
    };
    // 语义悬停：函数返回值与 struct 字段两处
    const hT = await hoverText('SV_Target', 3);
    assert.ok(hT.includes('渲染目标'), `hover(SV_Target) 应含「渲染目标」，实际：${hT.slice(0, 300)}`);
    assert.ok((await hoverText('SV_POSITION', 3)).includes('裁剪空间'), 'hover(SV_POSITION) 应含「裁剪空间」');
    // 符号悬停：HLSL 声明的变量 → 声明行代码块（Properties 块属 ShaderLab 外壳，规格不在范围）
    assert.ok((await hoverText('sampler2D _HoverTex', 14)).includes('_HoverTex'), 'hover(_HoverTex) 应含声明行');
    // 未声明标识符 → 空（负例不轮询）
    const hn = await hoverOnce('nosuchname', 4);
    assert.ok(!hn.includes('```'), `hover(未声明) 应为空：${hn.slice(0, 120)}`);

    // 语义补全：`uv : ` 空前缀 → TEXCOORD0；`pos : SV_` → SV_Position（带文档）
    const r1 = await compAt(doc, 'TEXCOORD0', 0);
    assert.ok(ourLabels(r1).includes('TEXCOORD0'), `uv : 后应给语义候选：${ourLabels(r1).slice(0, 10).join(',')}`);
    const r2 = await compAt(doc, 'SV_POSITION', 3);
    const item = ours(r2).find((i) => i.label === 'SV_Position');
    assert.ok(item, `pos : SV_ 应含 SV_Position：${ourLabels(r2).join(',')}`);
    assert.ok(docText(item).includes('裁剪空间'), '语义候选应带文档');
  },
};
