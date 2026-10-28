/**
 * T-049 / T-067：取官方 DXC 预编译产物到 `third_party/dxc/<platform>-<arch>/`。
 *
 * ADR 0010：DXC 随扩展附带、不在安装期编译、不做首次运行下载 —— 所以产物在**发布流水线里**
 * 由本脚本取（CI 或本机开发），产物本身不入库（见 .gitignore），与 grammar 的 `parser.c`
 * 同构（生成物/下载物不入库，由脚本重建）。
 *
 * 用法：
 *   npm run dxc:fetch                      # 当前平台
 *   node scripts/fetch-dxc.mjs --all       # 官方有产物的全部平台（发布用）
 *   node scripts/fetch-dxc.mjs --platform linux-x64
 *
 * 依赖：系统 `tar`（Windows 10+ 自带 bsdtar，能解 zip；Linux/macOS 自带 GNU tar）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 锁版本：门槛测试的可复现性依赖它（ADR 0009/0010）。升级 = 改动本常量并复跑门槛。 */
const DXC_VERSION = 'v1.9.2609';
const BASE = `https://github.com/microsoft/DirectXShaderCompiler/releases/download/${DXC_VERSION}`;

const ASSETS = {
  'win32-x64': { file: 'dxc_2026_09_29.zip', kind: 'zip', pick: (rel) => /^bin\/x64\/(dxc\.exe|dxcompiler\.dll|dxil\.dll)$/.test(rel) },
  'win32-arm64': { file: 'dxc_2026_09_29.zip', kind: 'zip', pick: (rel) => /^bin\/arm64\/(dxc\.exe|dxcompiler\.dll|dxil\.dll)$/.test(rel) },
  'linux-x64': {
    file: 'linux_dxc_2026_09_28.x86_x64.tar.gz',
    kind: 'targz',
    pick: (rel) => /(^|\/)(dxc|libdxcompiler\.so|libdxil\.so)$/.test(rel) && !rel.includes('debug'),
  },
};

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dest = path.join(root, 'third_party', 'dxc');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

function currentPlatformDir() {
  if (process.platform === 'win32' && (process.arch === 'x64' || process.arch === 'arm64')) return `win32-${process.arch}`;
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64';
  return null;
}

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

async function download(url, to) {
  process.stdout.write(`  GET ${url}\n`);
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'unity-shader-tools-dxc-fetch' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(to, buf);
  process.stdout.write(`  ${(buf.length / 1048576).toFixed(1)} MB\n`);
  return buf.length;
}

async function fetchOne(platform) {
  const spec = ASSETS[platform];
  if (!spec) {
    throw new Error(`无官方 DXC 预编译产物：${platform}（ADR 0010 的未决项；自备 unityShader.dxcPath）`);
  }
  const outDir = path.join(dest, platform);
  const marker = path.join(outDir, 'VERSION');
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === DXC_VERSION) {
    process.stdout.write(`${platform}: 已是 ${DXC_VERSION}，跳过\n`);
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxc-fetch-'));
  try {
    const archive = path.join(tmp, spec.file);
    await download(`${BASE}/${spec.file}`, archive);
    const ex = path.join(tmp, 'ex');
    fs.mkdirSync(ex);
    execFileSync('tar', spec.kind === 'zip' ? ['-xf', archive, '-C', ex] : ['-xzf', archive, '-C', ex], { stdio: 'inherit' });

    const picked = walk(ex).filter(spec.pick);
    if (picked.length === 0) throw new Error(`产物里没匹配到任何文件（${spec.file}），上游布局可能变了`);
    fs.mkdirSync(outDir, { recursive: true });
    let total = 0;
    for (const rel of picked) {
      const src = path.join(ex, rel);
      const dst = path.join(outDir, path.basename(rel));
      fs.copyFileSync(src, dst);
      if (process.platform !== 'win32' && path.basename(rel) !== 'VERSION') {
        fs.chmodSync(dst, 0o755);
      }
      total += fs.statSync(dst).size;
      process.stdout.write(`  + ${path.basename(rel)}  ${(fs.statSync(dst).size / 1048576).toFixed(2)} MB\n`);
    }
    // 许可证随产物附带（再分发要求）
    for (const rel of walk(ex)) {
      if (/^(LICENCE-MIT\.txt|LICENSE-LLVM\.txt|LICENSE-MS\.txt)$/i.test(rel)) {
        fs.copyFileSync(path.join(ex, rel), path.join(dest, path.basename(rel)));
      }
    }
    fs.writeFileSync(marker, `${DXC_VERSION}\n`);
    process.stdout.write(`${platform}: OK（共 ${(total / 1048576).toFixed(1)} MB，${DXC_VERSION}）\n`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const requested = arg('platform');
const targets = process.argv.includes('--all')
  ? Object.keys(ASSETS)
  : requested
    ? [requested]
    : [currentPlatformDir() ?? 'win32-x64'];

try {
  for (const t of targets) await fetchOne(t);
} catch (e) {
  process.stderr.write(`dxc:fetch 失败：${e.message}\n`);
  process.exit(1);
}
