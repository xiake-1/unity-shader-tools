#!/usr/bin/env node
/**
 * T-067：把 CI 各 runner 上传的 prebuild 产物合并回 `grammar/prebuilds/` 与 `hlsl/prebuilds/`。
 *
 * 每台 runner 的 `prebuildify` 只把产物写进 `prebuilds/<platform>-<arch>/`，artifact 按平台分别上传
 * （workflow 里先改名成 `prebuilds-out` 避免同名冲突）。这里按「哪个包 + 哪个平台目录」原样搬回去，
 * 并断言 6 档齐全 —— 少一档就退出非 0，不能悄悄发一个缺平台的 vsix
 * （ADR 0005：未覆盖平台是**加载失败**而不是降级，缺档必须在发布前炸出来）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const src = process.argv[2] ?? '.ci-prebuilds';
const PACKAGES = ['grammar', 'hlsl'];
// ADR 0005 的 6 档平台面（与上游 tree-sitter / tree-sitter-hlsl 的 prebuilds 同构）
const REQUIRED = ['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];

const abs = path.isAbsolute(src) ? src : path.join(root, src);
if (!fs.existsSync(abs)) {
  console.error(`merge-prebuilds: 找不到产物目录 ${abs}`);
  process.exit(1);
}

const found = {};
for (const pkg of PACKAGES) found[pkg] = new Set();

// 产物目录形如 <artifact>/grammar/prebuilds-out/<platform>-<arch>/*.node
for (const artifact of fs.readdirSync(abs)) {
  for (const pkg of PACKAGES) {
    const outDir = path.join(abs, artifact, pkg, 'prebuilds-out');
    const dir = fs.existsSync(outDir) ? outDir : path.join(abs, artifact, pkg, 'prebuilds');
    if (!fs.existsSync(dir)) continue;
    for (const plat of fs.readdirSync(dir)) {
      const from = path.join(dir, plat);
      if (!fs.statSync(from).isDirectory()) continue;
      const to = path.join(root, pkg, 'prebuilds', plat);
      fs.mkdirSync(to, { recursive: true });
      fs.cpSync(from, to, { recursive: true });
      found[pkg].add(plat);
    }
  }
}

const missing = [];
for (const pkg of PACKAGES) {
  for (const plat of REQUIRED) if (!found[pkg].has(plat)) missing.push(`${pkg}/${plat}`);
}
console.log(
  JSON.stringify(
    { merged: Object.fromEntries(PACKAGES.map((p) => [p, [...found[p]].sort()])), required: REQUIRED, missing },
    null,
    2
  )
);
if (missing.length) {
  console.error(`merge-prebuilds: 缺平台产物 ${missing.join(', ')}（矩阵没跑全就发布 = 发一个会加载失败的 vsix）`);
  process.exit(1);
}
