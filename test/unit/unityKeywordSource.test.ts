/** T-043：Unity `Editor.log` 关键字源（fixture 日志，不依赖本机 Unity） */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_KEYWORD_LOG_SCAN_BYTES,
  UnityKeywordSource,
  defaultKeywordLogPath,
  keywordHealthLine,
  parseDisabledKeywords,
} from '../../server/src/unityKeywordSource';

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kwlog-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function logFile(content: string, name = 'Editor.log'): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

describe('三平台默认路径', () => {
  it('win32 用 %LOCALAPPDATA%\\Unity\\Editor\\Editor.log', () => {
    const p = defaultKeywordLogPath('win32', { LOCALAPPDATA: 'C:/Users/u/AppData/Local' }, 'C:/Users/u');
    expect(p).toBe(path.join('C:/Users/u/AppData/Local', 'Unity', 'Editor', 'Editor.log'));
  });
  it('darwin 用 ~/Library/Logs/Unity/Editor.log', () => {
    expect(defaultKeywordLogPath('darwin', {}, '/Users/u')).toBe(path.join('/Users/u', 'Library', 'Logs', 'Unity', 'Editor.log'));
  });
  it('linux 用 ~/.config/unity3d/Editor.log', () => {
    expect(defaultKeywordLogPath('linux', {}, '/home/u')).toBe(path.join('/home/u', '.config', 'unity3d', 'Editor.log'));
  });
});

describe('Disabled keywords 行解析', () => {
  it('解析出集合 {A,B,C}', () => {
    expect(parseDisabledKeywords('blah\nDisabled keywords: A B C\ntrailer')).toEqual(['A', 'B', 'C']);
  });
  it('无该行 → 空集合', () => {
    expect(parseDisabledKeywords('Compiling shader\nNo keywords here\n')).toEqual([]);
  });
  it('大小写敏感：`disabled keywords:` 小写不算命中', () => {
    expect(parseDisabledKeywords('disabled keywords: A B\n')).toEqual([]);
  });
  it('取最后一条（最后一次会话为准）', () => {
    expect(parseDisabledKeywords('Disabled keywords: OLD1\n...\nDisabled keywords: NEW1 NEW2\n')).toEqual(['NEW1', 'NEW2']);
  });
});

describe('UnityKeywordSource 读取与降级', () => {
  it('fixture 日志 → 集合 {SHADER_API_GLES30, UNITY_NO_DXT5nm, X}', () => {
    const f = logFile(['Unity Editor 2022.3.62f3c1', 'Compiling shaders', 'Disabled keywords: SHADER_API_GLES30 UNITY_NO_DXT5nm X', ''].join('\n'));
    const s = new UnityKeywordSource({ logPath: f }).refresh(true);
    expect(s.source).toBe(f);
    expect([...s.set].sort()).toEqual(['SHADER_API_GLES30', 'UNITY_NO_DXT5nm', 'X']);
    expect(s.stale).toBe(false);
  });

  it('日志存在但无该行 → 空集合（全部未知）', () => {
    const s = new UnityKeywordSource({ logPath: logFile('Compiling\nDone.\n') }).refresh(true);
    expect(s.disabled).toEqual([]);
    expect(s.source).not.toBeNull();
  });

  it('文件不存在 → source=none，不抛错', () => {
    const s = new UnityKeywordSource({ logPath: path.join(dir, 'nope', 'Editor.log') }).refresh(true);
    expect(s.source).toBeNull();
    expect(s.disabled).toEqual([]);
    expect(keywordHealthLine(s, 0)).toContain('source=none');
  });

  it('尾部窗口：2 MB 日志，关键字行在窗口内 → 命中', () => {
    const filler = 'x'.repeat(2 * 1024 * 1024);
    const f = logFile(filler + '\nDisabled keywords: TAIL_KEY\n');
    const s = new UnityKeywordSource({ logPath: f, scanBytes: DEFAULT_KEYWORD_LOG_SCAN_BYTES }).refresh(true);
    expect(s.set.has('TAIL_KEY')).toBe(true);
    expect(s.scannedBytes).toBeLessThanOrEqual(DEFAULT_KEYWORD_LOG_SCAN_BYTES);
  });

  it('尾部窗口：关键字行在窗口外 → 不命中并记 scanned=', () => {
    const head = 'Disabled keywords: OUTSIDE_KEY\n';
    const filler = 'y'.repeat(2 * 1024 * 1024);
    const f = logFile(head + filler + '\n');
    const s = new UnityKeywordSource({ logPath: f, scanBytes: 64 * 1024 }).refresh(true);
    expect(s.set.has('OUTSIDE_KEY')).toBe(false);
    expect(s.foundInWindow).toBe(false);
    expect(s.scannedBytes).toBe(64 * 1024);
    expect(keywordHealthLine(s, 0)).toContain(`scanned=${s.scannedBytes}`);
  });

  it('mtime 未变 → 不重读不解析（readCount/parseCount 不增加）', () => {
    const f = logFile('Disabled keywords: A\n');
    const src = new UnityKeywordSource({ logPath: f });
    src.refresh();
    const first = src.current;
    src.refresh();
    src.refresh();
    expect(src.current.readCount).toBe(first.readCount);
    expect(src.current.parseCount).toBe(first.parseCount);
    expect(src.current.readCount).toBe(1);
  });

  it('mtime 变化 → 重读并给出新集合', () => {
    const f = logFile('Disabled keywords: A\n');
    const src = new UnityKeywordSource({ logPath: f });
    expect([...src.refresh().set]).toEqual(['A']);
    fs.writeFileSync(f, 'Disabled keywords: A B\n', 'utf8');
    fs.utimesSync(f, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const s = src.refresh();
    expect([...s.set].sort()).toEqual(['A', 'B']);
    expect(s.readCount).toBe(2);
  });

  it('stat 成功但读不出内容（目录冒充文件）→ 空集合、不抛错、不弹窗', () => {
    // Windows 上对目录 fd 的 readSync 不抛错，走的是「读到空内容」分支；
    // 真正的 read 抛错分支（stale=true）由 OS 拒绝读取触发，无法在 CI 里确定性地造。
    const bad = path.join(dir, 'bad.log');
    fs.mkdirSync(bad);
    const r = new UnityKeywordSource({ logPath: bad }).refresh();
    expect(r.disabled).toEqual([]);
    expect(r.source).toBe(bad);
    expect(keywordHealthLine(r, 0)).toMatch(/^\[keywords\] source=.+ disabled=0 /);
  });

  it('健康行格式：source/disabled/age/regions', () => {
    const f = logFile('Disabled keywords: A B\n');
    const s = new UnityKeywordSource({ logPath: f }).refresh(true);
    const line = keywordHealthLine(s, 7);
    expect(line).toMatch(/^\[keywords\] source=.+ disabled=2 age=\d{4}-\d{2}-\d{2}T.* regions=7$/);
  });
});
