// vsix 冒烟（QA）：解包后的依赖闭包必须能加载并解析——vsce --no-dependencies 曾把
// 暂存的 node_modules 整个排除在包外（2026-10-29 上架前实测），装上必 Cannot find module。
// 用法：node scripts/vsix-smoke.cjs <解包出的 extension 目录>
// CI package 档在打包后解包实跑（Linux 上顺带验证 linux-x64 prebuilds 真能加载）。
const fs = require('node:fs');
const path = require('node:path');

const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', '.vsix-smoke', 'extension'));
const nm = (n) => path.join(ext, 'node_modules', n);

const P = require(nm('tree-sitter'));
const Parser = P.default || P;
const shaderlab = require(nm('shaderlab-grammar'));
const hlsl = require(nm('tree-sitter-hlsl'));
const parser = new Parser();
parser.setLanguage(shaderlab);
let t = parser.parse('Shader "X" { SubShader { Pass { CGPROGRAM\nENDHLSL } } }');
console.log('shaderlab ok: ' + t.rootNode.type + ' children=' + t.rootNode.childCount);
parser.setLanguage(hlsl);
t = parser.parse('float4 f(){return 0;}');
console.log('hlsl ok: ' + t.rootNode.type);
console.log('lsp deps ok: ' + !!require(nm('vscode-languageserver')));

// server 入口必须能在扩展根下解析，且 bundle 的 serverEntry 优先走该布局
// （2026-10-29 上架首测：serverEntry 只写 '..' → 已安装时指向扩展目录外 → server 秒死 EPIPE）
const serverJs = path.join(ext, 'server', 'out', 'server.js');
if (!fs.existsSync(serverJs)) {
  console.error('MISSING server entry: ' + serverJs);
  process.exit(1);
}
const bundle = fs.readFileSync(path.join(ext, 'dist', 'extension.js'), 'utf8');
if (!/join\("server",\s*"out",\s*"server\.js"\)/.test(bundle)) {
  console.error('bundle serverEntry 缺已安装布局解析（join("server","out","server.js")）');
  process.exit(1);
}
console.log('server entry ok: server/out/server.js + bundle resolution');

// 当前平台的附带 dxc 必须在包里（ADR 0010；mac 等无官方产物的平台跳过该断言）
const platDir =
  process.platform === 'win32' && (process.arch === 'x64' || process.arch === 'arm64')
    ? `win32-${process.arch}`
    : process.platform === 'linux' && process.arch === 'x64'
      ? 'linux-x64'
      : null;
if (platDir) {
  const exe = path.join(ext, 'third_party', 'dxc', platDir, process.platform === 'win32' ? 'dxc.exe' : 'dxc');
  if (!fs.existsSync(exe)) {
    console.error('MISSING bundled dxc: ' + exe);
    process.exit(1);
  }
  console.log('bundled dxc ok: ' + platDir);
} else {
  console.log('bundled dxc: 当前平台无官方产物，跳过');
}
