/** T-002 / T-010 / T-019：真实 stdio LSP 握手（不依赖 VS Code）
 *  断言：initialize 能力、增量同步、降级提示恰好一次、索引统计可查、
 *  降级态下 definition 的行为、进程可回收。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SERVER = path.resolve(__dirname, '..', '..', 'server', 'out', 'server.js');

interface RpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
}

class Client {
  private nextId = 1;
  private pending = new Map<number, (v: unknown) => void>();
  readonly notifications: RpcMessage[] = [];

  constructor(private proc: ChildProcessWithoutNullStreams) {
    let buf = Buffer.alloc(0);
    proc.stdout.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const sep = buf.indexOf('\r\n\r\n');
        if (sep < 0) return;
        const header = buf.subarray(0, sep).toString('ascii');
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        if (!m) return;
        const len = Number(m[1]);
        if (buf.length < sep + 4 + len) return;
        const body = buf.subarray(sep + 4, sep + 4 + len).toString('utf8');
        buf = buf.subarray(sep + 4 + len);
        this.dispatch(JSON.parse(body) as RpcMessage);
      }
    });
  }

  private dispatch(msg: RpcMessage): void {
    if (msg.id != null && msg.method == null && this.pending.has(msg.id)) {
      this.pending.get(msg.id)!(msg);
      this.pending.delete(msg.id);
      return;
    }
    if (msg.method) {
      this.notifications.push(msg);
      // server → client 的请求（如 showMessageRequest）回一个空答复，避免服务端挂起
      if (msg.id != null) {
        const reply = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null });
        this.proc.stdin.write(
          `Content-Length: ${Buffer.byteLength(reply, 'utf8')}\r\n\r\n${reply}`
        );
      }
    }
  }

  request(method: string, params: unknown, timeoutMs = 20000): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve((msg as { result?: unknown }).result);
      });
      this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`);
    });
  }

  notify(method: string, params: unknown): void {
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`);
  }

  async waitForNotification(method: string, timeoutMs = 15000): Promise<RpcMessage | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.notifications.find((n) => n.method === method);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }
}

let proc: ChildProcessWithoutNullStreams;
let client: Client;
let tmp: string;
let shaderFile: string;
let initResult: { capabilities: { textDocumentSync?: number } } | undefined;

beforeAll(async () => {
  expect(fs.existsSync(SERVER), `先构建 server：${SERVER}`).toBe(true);

  // 非 Unity 目录：用于降级断言
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unitylsp-'));
  shaderFile = path.join(tmp, 'plain.shader');
  fs.writeFileSync(
    shaderFile,
    'Shader "P"\n{\n  Properties { _A("A", Float) = 1 }\n  SubShader { Pass { CGPROGRAM\nfloat4 _V;\nfloat4 f() { return UnityObjectToClipPos(_V); }\nENDCG } }\n}\n',
    'utf8'
  );

  proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  client = new Client(proc);

  initResult = (await client.request('initialize', {
    processId: process.pid,
    rootUri: null,
    workspaceFolders: [],
    capabilities: {},
    initializationOptions: { activeFile: `file:///${shaderFile.replace(/\\/g, '/')}`, settings: { index: false } },
  })) as { capabilities: { textDocumentSync?: number } };
  client.notify('initialized', {});
});

afterAll(async () => {
  try {
    await client.request('shutdown', null, 5000);
    client.notify('exit', {});
  } catch {
    /* 已退出 */
  }
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      proc.kill();
      resolve();
    }, 3000);
    proc.on('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('LSP 生命周期（真实 stdio）', () => {
  it('initialize 返回增量同步能力', async () => {
    expect(initResult?.capabilities?.textDocumentSync).toBe(2); // Incremental
  });

  it('didOpen 后索引到符号，executeCommand 可查统计', async () => {
    client.notify('textDocument/didOpen', {
      textDocument: { uri: `file:///${shaderFile.replace(/\\/g, '/')}`, languageId: 'unityshader', version: 1, text: fs.readFileSync(shaderFile, 'utf8') },
    });
    const stats = (await client.request('workspace/executeCommand', {
      command: 'unityshader/__indexStats',
    })) as { files: number; symbols: number; degraded: string[] };
    expect(stats.files).toBeGreaterThanOrEqual(1);
    expect(stats.symbols).toBeGreaterThanOrEqual(2); // _A 与 _V
    expect(proc.exitCode).toBeNull(); // 仍在运行
  });

  it('非 Unity 目录：降级提示恰好一次，且不崩溃', async () => {
    const msgs = client.notifications.filter(
      (n) => n.method === 'window/showMessageRequest'
    );
    expect(msgs.length).toBe(1);
    const p = msgs[0].params as { type: number; message: string };
    expect(p.type).toBe(3); // Information
    expect(p.message).toContain('未识别到完整 Unity 工程');
    expect(proc.exitCode).toBeNull();
  });

  it('T-019 降级态：工程内符号可跳、内置符号返回空、弹窗仍只一次', async () => {
    const uri = `file:///${shaderFile.replace(/\\/g, '/')}`;
    const text = fs.readFileSync(shaderFile, 'utf8');
    const at = (needle: string, offset = 0) => {
      const i = text.indexOf(needle) + offset;
      const before = text.slice(0, i);
      return { line: before.split('\n').length - 1, character: i - before.lastIndexOf('\n') - 1 };
    };
    const local = (await client.request('textDocument/definition', {
      textDocument: { uri },
      position: at('UnityObjectToClipPos(_V', 21),
    })) as unknown[];
    expect(local.length, '同文件声明在降级态也应可跳').toBeGreaterThanOrEqual(1);
    expect(local[0]).toHaveProperty('uri', uri);

    const builtin = (await client.request('textDocument/definition', {
      textDocument: { uri },
      position: at('UnityObjectToClipPos'),
    })) as unknown[] | null;
    expect(builtin === null || builtin.length === 0, '内置符号在降级态应返回空而不是报错').toBe(true);

    // 降级提示仍然只有一条：definition 不产生新的弹窗
    expect(client.notifications.filter((n) => n.method === 'window/showMessageRequest')).toHaveLength(1);
    expect(proc.exitCode).toBeNull();
  });

  it('增量 didChange 后符号表更新', async () => {
    const uri = `file:///${shaderFile.replace(/\\/g, '/')}`;
    client.notify('textDocument/didChange', {
      textDocument: { uri, version: 2 },
      contentChanges: [
        { range: { start: { line: 4, character: 1 }, end: { line: 4, character: 1 } }, text: '  float _Renamed;\n' },
      ],
    });
    const stats = (await client.request('workspace/executeCommand', {
      command: 'unityshader/__indexStats',
    })) as { symbols: number };
    expect(stats.symbols).toBeGreaterThanOrEqual(3);
  });

  it('shutdown/exit 后进程退出，无残留', async () => {
    await client.request('shutdown', null, 5000);
    client.notify('exit', {});
    const exited = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 5000);
      proc.on('exit', () => {
        clearTimeout(t);
        resolve(true);
      });
    });
    expect(exited).toBe(true);
  });
});
