/** 共享的真实 stdio LSP 客户端（供 lspServer / definitionRealProject 等 stdio 测试复用）
 *  与 test/unit/lspServer.test.ts 内联的那份同源；抽出来只为避免第三份拷贝。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

export interface RpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
}

export class LspClient {
  private nextId = 1;
  private pending = new Map<number, (v: unknown) => void>();
  readonly notifications: RpcMessage[] = [];

  constructor(readonly proc: ChildProcessWithoutNullStreams) {
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

  indexStats(): Promise<{ pid: number; files: number; symbols: number; degraded: string[] }> {
    return this.request('workspace/executeCommand', { command: 'unityshader/__indexStats' }, 10000) as Promise<{
      pid: number;
      files: number;
      symbols: number;
      degraded: string[];
    }>;
  }

  /** 轮询等到后台索引达到期望规模（索引是分片让出的，不能假设 initialized 后已完成） */
  async waitForIndex(minFiles: number, timeoutMs = 90_000): Promise<{ files: number; symbols: number }> {
    const deadline = Date.now() + timeoutMs;
    let last = { files: 0, symbols: 0 };
    while (Date.now() < deadline) {
      last = await this.indexStats();
      if (last.files >= minFiles) return last;
      await new Promise((r) => setTimeout(r, 250));
    }
    return last;
  }

  async shutdown(): Promise<void> {
    try {
      await this.request('shutdown', null, 5000);
      this.notify('exit', {});
    } catch {
      /* 已退出 */
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.proc.kill();
        resolve();
      }, 3000);
      this.proc.on('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

export const fileUri = (p: string): string => 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '');
