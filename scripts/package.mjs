#!/usr/bin/env node
/**
 * T-067 打包流水线：暂存 → `@vscode/vsce package` → 体积口径。
 *
 * 为什么要暂存而不是直接在 `client/` 里打包：
 * ADR 0005 定「server 保持 `tsc` 不 bundle」，因为 `node-gyp-build` 按 `__dirname` 找
 * `prebuilds/<platform>-<arch>/`。于是 vsix 里必须真的带着 server 的运行时依赖闭包
 * （`tree-sitter` + 我们自己的两个 grammar 包 + LSP 运行时），而不是靠 npm 安装。
 *
 * grammar/hlsl 只带 `bindings/` + `prebuilds/`（不带 `src/*.c`、不带 `build/`）：
 * 未覆盖平台应当**加载失败并给出明确提示**（ADR 0005 负面段），而不是在用户机上编译。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stage = path.join(root, '.package');
const vsixDir = path.join(root, 'dist-vsix');

const copyRel = (srcDir, dstDir, relList) => {
  for (const rel of relList) {
    const from = path.join(srcDir, rel);
    if (!fs.existsSync(from)) throw new Error(`打包缺件：${from}`);
    fs.cpSync(from, path.join(dstDir, rel), { recursive: true, dereference: true });
  }
};

const dirBytes = (p) => {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    total += e.isDirectory() ? dirBytes(f) : fs.statSync(f).size;
  }
  return total;
};

/** 运行时依赖闭包：只跟 `dependencies`，不跟 `devDependencies` */
function closure(names, seen = new Set()) {
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    const pkgPath = path.join(root, 'node_modules', n, 'package.json');
    if (!fs.existsSync(pkgPath)) throw new Error(`依赖闭包缺件：${n}（先跑 npm install）`);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    closure(Object.keys(pkg.dependencies ?? {}), seen);
  }
  return [...seen];
}

const serverPkg = JSON.parse(fs.readFileSync(path.join(root, 'server', 'package.json'), 'utf8'));
// 我们自己的两个 grammar 包在 workspace 里是指向 grammar/ 与 hlsl/ 的符号链接，
// 打包必须取**本地 fork**（ADR 0007：prebuild 从 fork 出产物），不能退回 npm 上的上游
const LOCAL_GRAMMARS = { 'shaderlab-grammar': 'grammar', 'tree-sitter-hlsl': 'hlsl' };

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'node_modules'), { recursive: true });

// 1) 扩展本体（client 是 vsix 的清单所在）
copyRel(path.join(root, 'client'), stage, ['package.json', 'dist', 'syntaxes', 'snippets', 'language-configuration.json', '.vscodeignore']);
// vsix 的 README 不是仓库根 README：根 README 带 `docs/…` 相对链接，vsce 在没有
// repository URL 时会因「链接会断」直接报错。这里生成一份只含自身说明的短 README。
fs.writeFileSync(
  path.join(stage, 'README.md'),
  '# Unity Shader Tools（自建）\n\n' +
    'Unity ShaderLab（`.shader`）与 HLSL（`.hlsl`/`.hlslinc`）的语言支持：转到定义、补全、改名、悬停、' +
    '语法诊断、死分支灰化、DXC 类型诊断、格式化。解析走 tree-sitter（自写 ShaderLab grammar + HLSL fork），' +
    '语言服务是标准 LSP（stdio 子进程），类型诊断调用随扩展附带的官方 `dxc` 预编译产物。\n\n' +
    '原生件按 ADR 0005 以 N-API prebuilds 随 vsix 附带；未覆盖的平台会明确报加载失败，而不是静默失去智能。\n',
  'utf8'
);

// 2) server：`tsc` 产物，不 bundle（ADR 0005）
fs.mkdirSync(path.join(stage, 'server'), { recursive: true });
copyRel(path.join(root, 'server'), path.join(stage, 'server'), ['package.json', 'out']);

// 3) 运行时依赖闭包
for (const [name, dir] of Object.entries(LOCAL_GRAMMARS)) {
  const dst = path.join(stage, 'node_modules', name);
  fs.mkdirSync(dst, { recursive: true });
  copyRel(path.join(root, dir), dst, ['package.json', 'bindings', 'prebuilds']);
}
const npmDeps = closure(Object.keys(serverPkg.dependencies ?? {}).filter((n) => !LOCAL_GRAMMARS[n]));
for (const n of npmDeps) {
  fs.cpSync(path.join(root, 'node_modules', n), path.join(stage, 'node_modules', n), { recursive: true, dereference: true });
}

// 4) dxc 产物（ADR 0010：随扩展附带官方预编译）
const dxcSrc = path.join(root, 'third_party', 'dxc');
if (fs.existsSync(dxcSrc) && !process.env.PACKAGE_SKIP_DXC) {
  fs.mkdirSync(path.join(stage, 'third_party', 'dxc'), { recursive: true });
  for (const p of fs.readdirSync(dxcSrc, { withFileTypes: true })) {
    if (p.isDirectory()) fs.cpSync(path.join(dxcSrc, p.name), path.join(stage, 'third_party', 'dxc', p.name), { recursive: true });
    else fs.copyFileSync(path.join(dxcSrc, p.name), path.join(stage, 'third_party', 'dxc', p.name));
  }
}

// 5) 打包
fs.mkdirSync(vsixDir, { recursive: true });
const vsixName = 'unity-shader-tools.vsix';
// vsce 的 bin 是带 shebang 的 JS；Node 24 在 Windows 上不允许 `spawnSync('npx.cmd')`
// （EINVAL，需要 shell），所以直接用自己的 Node 跑它的入口文件，不经过 shell
const vsceBin = ['node_modules/@vscode/vsce/vsce', 'client/node_modules/@vscode/vsce/vsce']
  .map((p) => path.join(root, p))
  .find((p) => fs.existsSync(p));
if (!vsceBin) throw new Error('找不到 @vscode/vsce，先 npm i -D @vscode/vsce');
execFileSync(process.execPath, [vsceBin, 'package', '--no-dependencies', '--allow-missing-repository', '--out', vsixName], {
  cwd: stage,
  stdio: 'inherit',
});

const vsix = path.join(vsixDir, vsixName);
if (!fs.existsSync(vsix)) {
  // vsce 把产物写在 cwd；搬过来统一路径
  const produced = path.join(stage, vsixName);
  if (fs.existsSync(produced)) fs.renameSync(produced, vsix);
}
const size = fs.statSync(vsix).size;
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';

const breakdown = {};
for (const key of ['dist', 'server', 'node_modules', path.join('third_party', 'dxc')]) {
  const p = path.join(stage, key);
  if (fs.existsSync(p)) breakdown[key.replace(/\\/g, '/')] = +dirBytes(p).toFixed(0);
}
const prebuilds = {};
for (const g of ['grammar', 'hlsl']) {
  const p = path.join(root, g, 'prebuilds');
  if (fs.existsSync(p)) {
    for (const plat of fs.readdirSync(p)) prebuilds[`${g}/${plat}`] = dirBytes(path.join(p, plat));
  }
}

console.log(
  JSON.stringify(
    {
      vsix: path.relative(root, vsix).replace(/\\/g, '/'),
      vsixBytes: size,
      vsixMB: +(size / 1024 / 1024).toFixed(2),
      stagedMB: Object.fromEntries(Object.entries(breakdown).map(([k, v]) => [k, +(v / 1024 / 1024).toFixed(2)])),
      prebuildMB: Object.fromEntries(Object.entries(prebuilds).map(([k, v]) => [k, +(v / 1024 / 1024).toFixed(2)])),
      npmClosure: npmDeps.length,
      platformsShipped: fs.existsSync(path.join(stage, 'node_modules', 'shaderlab-grammar', 'prebuilds'))
        ? fs.readdirSync(path.join(stage, 'node_modules', 'shaderlab-grammar', 'prebuilds'))
        : [],
    },
    null,
    2
  )
);
console.log(`vsix 体积：${mb(size)}`);
