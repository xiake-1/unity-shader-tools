/** VSCode 客户端（ADR 0002：标准 LSP，客户端只做进程管家 + UI 适配） */
import * as vscode from 'vscode';
import * as path from 'path';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
  CloseAction,
  ErrorAction,
  ErrorHandler,
  CloseHandlerResult,
  ErrorHandlerResult,
} from 'vscode-languageclient/node';
import { RestartGuard } from './restartGuard';

let client: LanguageClient | undefined;
let guard: RestartGuard | undefined;

function serverEntry(context: vscode.ExtensionContext): string {
  // 开发布局：client/ 与 server/ 同级；打包后由打包脚本调整
  return context.asAbsolutePath(path.join('..', 'server', 'out', 'server.js'));
}

function activeFileUri(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file') return editor.document.uri.toString();
  const first = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file');
  return first?.uri.toString();
}

class UnityShaderErrorHandler implements ErrorHandler {
  constructor(private readonly guard: RestartGuard) {}

  // 注意：client 读的是 handlerResult.action，返回裸枚举会被当成 undefined，
  // 两个分支都不匹配 → 既不重启也不提示（静默失效）。必须返回 { action } 对象。
  error(): ErrorHandlerResult {
    return { action: ErrorAction.Continue };
  }

  closed(): CloseHandlerResult {
    if (this.guard.noteCrash()) {
      return { action: CloseAction.Restart };
    }
    void vscode.window.showErrorMessage(
      `Unity Shader 语言服务器连续崩溃 ${this.guard.crashCount} 次，已停止自动重启。重载窗口可恢复。`
    );
    return { action: CloseAction.DoNotRestart, handled: true };
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const settings = vscode.workspace.getConfiguration('unityShader');
  guard = new RestartGuard(3);

  const serverModule = serverEntry(context);

  // 诊断落盘：状态迁移、spawn 与启动错误（集成测试据此判断重启卡在哪一步）
  const clientLog = process.env.UNITYSHADER_CLIENT_LOG;
  const trace = (msg: string): void => {
    if (!clientLog) return;
    try {
      require('fs').appendFileSync(clientLog, `${Date.now()} ${msg}\n`, 'utf8');
    } catch {
      /* 忽略 */
    }
  };

  // server 用宿主 Node/Electron 起：必须显式带 ELECTRON_RUN_AS_NODE，
  // 否则 Code.exe 会把 server.js 当 app 参数而不是以 Node 模式执行。
  // （函数式 ServerOptions 只接受 transports / 已 spawn 的进程，不接受命令描述，
  //   所以这里用对象式 + options.env。）
  const execDef = {
    command: process.execPath,
    args: [serverModule],
    transport: TransportKind.stdio,
    options: { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
  };
  trace(`server 定义: ${process.execPath} ${serverModule}`);
  const serverOptions: ServerOptions = { run: execDef, debug: execDef };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'unityshader' },
      { scheme: 'file', language: 'hlsl' },
      // ADR 0006 第 1 层：VSTU / Unity 扩展在装时文档语言是它的 `UnityShader`，
      // 我们不改用户任何设置也能接管语义功能（大小写敏感，必须原样写）。
      { scheme: 'file', language: 'UnityShader' },
    ],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher(
        '**/*.{shader,hlsl,hlslinc,cginc}'
      ),
    },
    initializationOptions: {
      activeFile: activeFileUri(),
      settings: {
        trace: settings.get<string>('trace', 'off'),
        index: settings.get<boolean>('index', true),
        maxIndexFileSize: settings.get<number>('maxIndexFileSize', 2 * 1024 * 1024),
        unityEditorPath: settings.get<string>('unityEditorPath', ''),
      },
    },
    // v9 要的是 ErrorHandler 实例（不是工厂）：传函数会让 closed() 变成 undefined，
    // 异常被 client 吞掉后回落到 DoNotRestart，重启策略形同虚设。
    errorHandler: new UnityShaderErrorHandler(guard),
    outputChannelName: 'Unity Shader Tools',
  };

  client = new LanguageClient(
    'unityShader',
    'Unity Shader Tools',
    serverOptions,
    clientOptions
  );

  // 把 client 的输出通道镜像到 trace 文件：内部重启失败只写通道，不镜像就看不到原因
  const channel = (client as unknown as {
    outputChannel?: { append: (s: string) => unknown; appendLine: (s: string) => unknown };
  }).outputChannel;
  if (channel && clientLog) {
    const origAppend = channel.append.bind(channel);
    const origLine = channel.appendLine.bind(channel);
    channel.append = (s: string) => {
      trace(`out: ${s}`);
      return origAppend(s);
    };
    channel.appendLine = (s: string) => {
      trace(`out: ${s}`);
      return origLine(s);
    };
  }

  let lastState = 'n/a';
  client.onDidChangeState((e) => {
    lastState = String(e.newState);
    trace(`state ${String(e.oldState)} -> ${String(e.newState)}`);
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('unityshader.showIndexStats', async () => {
      if (!client) return;
      const stats = await client.sendRequest('workspace/executeCommand', {
        command: 'unityshader/__indexStats',
      });
      void vscode.window.showInformationMessage(`Unity Shader index: ${JSON.stringify(stats)}`);
    }),
    // 测试钩子：客户端连接状态（initial/starting/running/stopping/stopped/startFailed）
    vscode.commands.registerCommand('unityshader/__testClientState', () => lastState),
    // 测试钩子：把 server 的索引统计原样返回（集成测试断言降级状态）
    vscode.commands.registerCommand('unityshader/__testIndexStats', async () => {
      if (!client) return null;
      return client.sendRequest('workspace/executeCommand', {
        command: 'unityshader/__indexStats',
      });
    }),
    // 测试钩子：返回 server 自报的 pid（v9 的 LanguageClient 不公开 serverProcess，
    // 让 server 自己在 __indexStats 里报告，才能真实断言重启身份）
    vscode.commands.registerCommand('unityshader/__testServerPid', async () => {
      if (!client) return null;
      try {
        const stats = (await client.sendRequest('workspace/executeCommand', {
          command: 'unityshader/__indexStats',
        })) as { pid?: number } | null;
        return stats?.pid ?? null;
      } catch {
        return null; // 连接中断（崩溃/重启中）
      }
    }),
    vscode.commands.registerCommand('unityshader/__testCrash', async () => {
      if (!client) return null;
      return client.sendRequest('workspace/executeCommand', {
        command: 'unityshader/__testCrash',
      });
    })
  );

  client.start().then(undefined, (err) => {
    trace(`start() rejected: ${err && err.message ? err.message : String(err)}`);
  });
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) return undefined;
  return client.stop();
}
