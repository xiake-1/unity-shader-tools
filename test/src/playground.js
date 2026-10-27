// 用独立副本起一个带本扩展的开发实例，供人工核对 T-005 的视觉项（高亮无错色、折叠、片段插入）。
// 用法：npm run vscode:playground [工程目录]
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const code = path.join(repoRoot, '.vscode-test', 'standalone', 'Code.exe');
if (!fs.existsSync(code)) {
  console.error(`未找到独立副本：${code}\n先跑一次 npm run test:vscode（它会准备 .vscode-test/standalone）。`);
  process.exit(1);
}

const target = process.argv[2] || 'D:\\Work\\Unity\\ShaderStudy';
if (!fs.existsSync(target)) {
  console.error(`目标目录不存在：${target}`);
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // 否则 Code.exe 会以纯 Node 模式启动

// 给这个独立 profile 写显眼窗口标题，并复用 server 那套发现逻辑预填 Unity 编辑器路径。
// 注意：只写 .vscode-test/playground-profile/User/settings.json（gitignore 内的开发用 profile），
// 不进扩展包、不碰你本机 VS Code 的 profile；别人装扩展时走的是 server 的自动发现，与此无关。
const profile = path.join(repoRoot, '.vscode-test', 'playground-profile');
const userDir = path.join(profile, 'User');
fs.mkdirSync(userDir, { recursive: true });
const settingsPath = path.join(userDir, 'settings.json');

let settings = {};
let parseOk = true;
if (fs.existsSync(settingsPath)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (err) {
    parseOk = false;
    console.warn(`profile settings.json 解析失败，本次不改写：${err.message}`);
  }
}
if (parseOk) {
  if (settings['window.title'] === undefined) {
    settings['window.title'] = '\u{1F9EA} Shader Playground | ${rootName}';
  }
  if (settings['window.restoreWindows'] === undefined) settings['window.restoreWindows'] = 'none';
  if (settings['update.mode'] === undefined) settings['update.mode'] = 'none';
  if (settings['telemetry.telemetryLevel'] === undefined) settings['telemetry.telemetryLevel'] = 'off';

  // 与运行时完全同一套发现：配置项 → Unity Hub 安装表 → 常见安装根扫描
  // 便携安装（Hub 未登记）时用 .vscode-test/dev.local.json 或环境变量 UNITYSHADER_EDITOR 指定
  let configured = process.env.UNITYSHADER_EDITOR;
  const devLocal = path.join(repoRoot, '.vscode-test', 'dev.local.json');
  if (!configured && fs.existsSync(devLocal)) {
    try {
      configured = JSON.parse(fs.readFileSync(devLocal, 'utf8')).unityEditorPath;
    } catch {
      /* 解析失败即忽略 */
    }
  }
  const { discoverUnityEnvironment } = require(path.join(repoRoot, 'server', 'out', 'unityProject.js'));
  const info = discoverUnityEnvironment(target, [target], { configuredEditorPath: configured });
  if (info.editorDir && settings['unityShader.unityEditorPath'] === undefined) {
    settings['unityShader.unityEditorPath'] = info.editorDir;
    console.log(`探测到 Unity Editor：${info.editorDir}（版本 ${info.editorVersion}）→ 预填进 profile`);
  } else if (info.editorDir) {
    console.log(`profile 已有 unityShader.unityEditorPath：${settings['unityShader.unityEditorPath']}`);
  } else {
    console.warn(
      `未探测到 Unity Editor（降级原因：${info.degradedReasons.join(', ') || '无'}）；` +
        '可在 playground 里手动设 unityShader.unityEditorPath。'
    );
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4), 'utf8');
}

console.log(`独立副本：${code}`);
console.log(`打开目录：${target}`);
console.log('要核对：ShaderLab 关键字着色无错色、//#region 折叠、输入 shader/blend 能插片段');

execFileSync(
  code,
  [
    target,
    `--extensionDevelopmentPath=${path.join(repoRoot, 'client')}`,
    `--user-data-dir=${profile}`,
    `--extensions-dir=${path.join(profile, 'extensions')}`,
    '--disable-workspace-trust',
  ],
  { stdio: 'inherit', env }
);
