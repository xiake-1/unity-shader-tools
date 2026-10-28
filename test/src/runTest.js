// T-002 集成测试入口：下载独立的 VS Code 副本（不碰本机安装与配置），
// 加载 client 扩展并跑 suite。副本会缓存到 .vscode-test/，重复运行不再下载。
// 用法：npm run test:vscode
const path = require('path');
const os = require('os');
const fs = require('fs');
const { runTests } = require('@vscode/test-electron');

// 关键：宿主（DSH 自身是 Electron）会注入 ELECTRON_RUN_AS_NODE=1，
// 继承给 Code.exe 会让它退化成「纯 Node」并把第一个参数当模块加载
// （报 Cannot find module <工作目录>）。集成测试必须清掉它。
for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_EXEC_PATH']) {
  if (k in process.env) {
    console.log(`清除环境变量 ${k}（否则 Code.exe 不会以 VS Code 形态启动）`);
    delete process.env[k];
  }
}

async function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const extensionDevelopmentPath = path.join(repoRoot, 'client');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  // 独立副本：优先用 .vscode-test/standalone（curl 直接下载解压的那份，不碰本机安装）。
  // 不存在时 test-electron 回退为它自己的下载流程。
  const standalone = path.join(repoRoot, '.vscode-test', 'standalone', 'Code.exe');
  const vscodeExecutablePath = fs.existsSync(standalone) ? standalone : undefined;
  console.log(
    vscodeExecutablePath
      ? `使用独立副本: ${vscodeExecutablePath}`
      : '未找到 .vscode-test/standalone，回退为 test-electron 下载'
  );

  // 临时 Unity 工程 fixture：Assets + Library + ProjectSettings
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-ws-'));
  fs.mkdirSync(path.join(ws, 'Assets'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'Library'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'ProjectSettings'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, 'ProjectSettings', 'ProjectVersion.txt'),
    'm_EditorVersion: 2022.3.62f3c1\n',
    'utf8'
  );

  // T-027 补全需要包内与内置符号：合成 PackageCache（render-pipelines.core 的 ShaderLibrary），
  // 并用设置项把 Editor 路径指到本机安装（CGIncludes 兜底）。Editor 不存在时保持降级态，
  // 相关用例自行跳过。
  const editorPath =
    process.env.UNITYSHADER_TEST_EDITOR || 'D:/Soft/Work/Unity/UnityEditor/2022.3.62f3c1/Editor';
  const editorOk = fs.existsSync(path.join(editorPath, 'Data', 'CGIncludes'));
  if (editorOk) {
    fs.mkdirSync(path.join(ws, '.vscode'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, '.vscode', 'settings.json'),
      JSON.stringify({ 'unityShader.unityEditorPath': editorPath }, null, 2) + '\n',
      'utf8'
    );
  }
  const pkgLib = path.join(
    ws,
    'Library',
    'PackageCache',
    'com.unity.render-pipelines.core@14.0.12',
    'ShaderLibrary'
  );
  fs.mkdirSync(pkgLib, { recursive: true });
  fs.writeFileSync(
    path.join(pkgLib, 'SpaceTransforms.hlsl'),
    [
      '// Transforms position from world space to homogenous space',
      'float4 TransformWorldToHClip(float3 positionWS)',
      '{',
      '    return float4(positionWS, 1.0);',
      '}',
      '',
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(pkgLib, 'Macros.hlsl'),
    [
      '#define SAMPLE_TEXTURE2D(textureName, samplerName, coord2) TEXTURE2D_SAMPLE(textureName, samplerName, coord2)',
      '',
    ].join('\n'),
    'utf8'
  );
  const shaderPath = path.join(ws, 'Assets', 'bench.shader');
  fs.writeFileSync(
    shaderPath,
    [
      'Shader "Bench/Demo"',
      '{',
      '  Properties { _MainTex("Tex", 2D) = "white" {} }',
      '  SubShader',
      '  {',
      '    Pass',
      '    {',
      '      CGPROGRAM',
      '      float4 _MainTex_ST;',
      '      ENDCG',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n'),
    'utf8'
  );

  // T-048 灰化：自包含 fixture 日志（规格验收要求「Editor.log 用合成日志文件」，
  // 真实 Editor.log 只作补充样本）。server 侧用 UNITYSHADER_KEYWORD_LOG 注入路径。
  const keywordLog = path.join(ws, 'fixture-Editor.log');
  fs.writeFileSync(
    keywordLog,
    'Unity Editor 2022.3.62f3c1 (fixture)\nCompiling shader variants\nDisabled keywords: UNITYSHADER_TEST_DEAD ANOTHER_DEAD\nDone.\n',
    'utf8'
  );

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      vscodeExecutablePath,
      extensionTestsEnv: {
        UNITYSHADER_TEST_WORKSPACE: ws,
        UNITYSHADER_TEST_FILE: shaderPath,
        UNITYSHADER_KEYWORD_LOG: keywordLog,
        UNITYSHADER_SERVER_LOG: process.env.DSH_SERVER_LOG || path.join(ws, 'server-boot.log'),
        // 格式化「失败即不改」注入点：标志文件存在时打印器抛错（用例自己创建/删除）
        UNITYSHADER_FORMAT_FAIL_FILE: path.join(ws, 'format-fail.flag'),
        UNITYSHADER_CLIENT_LOG: path.join(ws, 'client-state.log'),
      },
      launchArgs: [ws, '--disable-workspace-trust'],
    });
  } catch (err) {
    console.error('集成测试失败：', err && err.message ? err.message : err);
    process.exitCode = 1;
  } finally {
    try {
      fs.rmSync(ws, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main();
