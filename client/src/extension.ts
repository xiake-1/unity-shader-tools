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
import {
  type AssocEntry,
  type AssocScope,
  commandTargets,
  invalidAssociationEntries,
  mergeAssociationEntries,
  mergeAssociations,
  planAssociationRewrite,
  shouldSelfHeal,
  targetIdFor,
} from './languageIdFix';

let client: LanguageClient | undefined;
let guard: RestartGuard | undefined;

function serverEntry(context: vscode.ExtensionContext): string {
  // 已安装布局：server/ 在扩展根下（vsix 解包即如此）；
  // 开发布局：extensionPath=client/，server/ 与其同级 → 回退 '..'。
  // （曾只写 '..'：已安装时指向扩展目录外 → server 秒死 EPIPE，2026-10-29 上架首测暴露。）
  const installed = context.asAbsolutePath(path.join('server', 'out', 'server.js'));
  if (require('fs').existsSync(installed)) return installed;
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
      // 让 VS Code 把 unityShader 这一节的当前值推给 server（workspace/didChangeConfiguration），
      // 否则 server 收到的 change.settings 是空对象，开关一改不生效。
      configurationSection: 'unityShader',
    },
    initializationOptions: {
      activeFile: activeFileUri(),
      settings: {
        trace: settings.get<string>('trace', 'off'),
        index: settings.get<boolean>('index', true),
        maxIndexFileSize: settings.get<number>('maxIndexFileSize', 2 * 1024 * 1024),
        unityEditorPath: settings.get<string>('unityEditorPath', ''),
        // M4 语法诊断（默认值来自 contributes.configurationDefaults，与门槛测试联动）
        syntaxDiagnostics: settings.get<boolean>('syntaxDiagnostics', true),
        includeDiagnostics: settings.get<boolean>('includeDiagnostics', true),
        diagnosticsDebounceMs: settings.get<number>('diagnosticsDebounceMs', 800),
        maxDiagnosticsPerFile: settings.get<number>('maxDiagnosticsPerFile', 200),
        // M4 死分支灰化（规格 feature-dead-branch-dimming 范围 8/9/11）
        keywordPollMs: settings.get<number>('keywordPollMs', 5000),
        keywordLogScanBytes: settings.get<number>('keywordLogScanBytes', 512 * 1024),
        branchDebounceMs: settings.get<number>('branchDebounceMs', 700),
        // M5 类型诊断（规格 feature-type-diagnostics 范围 14；默认值与 `gate:type-diagnostics` 联动）
        typeDiagnostics: settings.get<boolean>('typeDiagnostics', true),
        dxcPath: settings.get<string>('dxcPath', ''),
        dxcTimeoutMs: settings.get<number>('dxcTimeoutMs', 5000),
        maxTypeDiagnosticsPerFile: settings.get<number>('maxTypeDiagnosticsPerFile', 100),
        // 宏覆盖（规格 feature-dxc-macro-overrides 范围 1；默认空列表＝门槛零漂移）
        dxcMacroOverrides: settings.get<string[]>('dxcMacroOverrides', []),
        // M5 格式化（规格 feature-formatting 范围 7；默认值与 `gate:format` 联动）
        formatting: {
          enable: settings.get<boolean>('formatting.enable', true),
          braceOnNewLine: settings.get<boolean>('formatting.braceOnNewLine', false),
          macroMatchIndent: settings.get<boolean>('formatting.macroMatchIndent', true),
          keepBlankLines: settings.get<number>('formatting.keepBlankLines', 1),
        },
        maxFormatFileSize: settings.get<number>('maxFormatFileSize', 1024 * 1024),
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

  // 灰化协商（规格 feature-dead-branch-dimming 范围 6）：客户端在 initialize 的
  // `capabilities.experimental['unityshader/inactiveRegions'] = true` 声明支持，server 才发通知。
  // vscode-languageclient v9 没有公开注入口：ClientOptions 无 capabilities 字段，
  // Middleware 也没有 initialize 钩子（v9 的 initialize 直连 connection，不过中间件）。
  // 因此覆盖实例方法 computeClientCapabilities —— 属实现细节，升级 v10 时要复查；
  // 集成用例「灰化协商」会在第一时间发现它失效。
  const capsHost = client as unknown as {
    computeClientCapabilities?: () => Record<string, unknown>;
  };
  const baseCaps = capsHost.computeClientCapabilities?.bind(client);
  capsHost.computeClientCapabilities = () => {
    const caps = baseCaps ? baseCaps() : {};
    caps.experimental = {
      ...((caps.experimental as Record<string, unknown> | undefined) ?? {}),
      'unityshader/inactiveRegions': true,
    };
    return caps;
  };

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

  // ---- M4 死分支灰化（T-047，规格 feature-dead-branch-dimming 范围 7/9）----
  interface RegionPayload {
    uri: string;
    version: number;
    regions: { start: { line: number; character: number }; end: { line: number; character: number }; condition: string }[];
  }
  /** uri → 最近一次推送（带 version，编辑后旧 Range 不得套到新文本上） */
  const regionStore = new Map<string, { version: number; regions: RegionPayload['regions'] }>();
  let lastAppliedCount = 0;

  // 颜色取主题的 `disabledForeground`（对标产品硬编码 grey，不照抄）；
  // 该色在多数主题里不存在，故同时给 `opacity` 兜底——两者是独立的渲染属性，
  // 主题有色时用它，没色时 opacity 仍然生效（规格范围 7「取不到时回退」）。
  const dimType = vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor('disabledForeground'),
    opacity: '0.45',
  });

  const applyDecorations = (editor: vscode.TextEditor | undefined): void => {
    if (!editor) {
      lastAppliedCount = 0;
      return;
    }
    const entry = regionStore.get(editor.document.uri.toString());
    if (!entry || entry.version !== editor.document.version) {
      // 版本不匹配（编辑后旧推送）→ 不套装饰（规格约束）
      editor.setDecorations(dimType, []);
      lastAppliedCount = 0;
      return;
    }
    editor.setDecorations(
      dimType,
      entry.regions.map(
        (r) => new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character)
      )
    );
    lastAppliedCount = entry.regions.length;
  };

  let lastActiveEditor: vscode.TextEditor | undefined;
  const onActiveEditor = (editor: vscode.TextEditor | undefined): void => {
    // 装饰只作用于活动编辑器：切走的编辑器清空（规格范围 7）
    if (lastActiveEditor && lastActiveEditor !== editor) lastActiveEditor.setDecorations(dimType, []);
    lastActiveEditor = editor;
    applyDecorations(editor);
  };

  client.onNotification('unityshader/inactiveRegions', (payload: RegionPayload) => {
    if (!payload || typeof payload.uri !== 'string') return;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === payload.uri);
    if (doc && doc.version !== payload.version) {
      regionStore.delete(payload.uri); // 过期推送：丢弃，不产生装饰（规格异常表）
      if (lastActiveEditor && lastActiveEditor.document.uri.toString() === payload.uri) {
        lastActiveEditor.setDecorations(dimType, []);
        lastAppliedCount = 0;
      }
      return;
    }
    regionStore.set(payload.uri, { version: payload.version, regions: payload.regions ?? [] });
    if (lastActiveEditor && lastActiveEditor.document.uri.toString() === payload.uri) {
      applyDecorations(lastActiveEditor);
    }
  });

  context.subscriptions.push(
    dimType,
    vscode.window.onDidChangeActiveTextEditor(onActiveEditor),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      regionStore.delete(doc.uri.toString()); // didClose 清理（规格范围 7）
    }),
    vscode.commands.registerCommand('unityshader.refreshShaderKeywords', async () => {
      if (!client) return null;
      const r = (await client.sendRequest('workspace/executeCommand', {
        command: 'unityshader/refreshKeywords',
      })) as { disabled?: number; regions?: number } | null;
      void vscode.window.showInformationMessage(
        `Unity Shader: 已重读 Unity 关键字（disabled=${r?.disabled ?? 0}，死分支 ${r?.regions ?? 0} 处）`
      );
      return r;
    }),
    // 测试钩子：当前活动编辑器上的灰化 Range 数（集成测试断言装饰落地）
    vscode.commands.registerCommand('unityshader/__testInactiveDecorations', () => ({
      editor: lastActiveEditor?.document.uri.toString() ?? null,
      version: lastActiveEditor?.document.version ?? null,
      stored: lastActiveEditor ? (regionStore.get(lastActiveEditor.document.uri.toString())?.regions.length ?? 0) : 0,
      applied: lastAppliedCount,
      totalStored: regionStore.size,
      conditions: lastActiveEditor
        ? (regionStore.get(lastActiveEditor.document.uri.toString())?.regions ?? []).map((r) => r.condition)
        : [],
      ranges: lastActiveEditor
        ? (regionStore.get(lastActiveEditor.document.uri.toString())?.regions ?? []).map((r) => ({
            start: r.start,
            end: r.end,
          }))
        : [],
    })),
    // 测试钩子：带参数转发到 server 的 unityshader/refreshKeywords（可指定 fixture 日志路径）
    vscode.commands.registerCommand('unityshader/__testRefreshKeywords', async (args?: { logPath?: string | null }) => {
      if (!client) return null;
      return client.sendRequest('workspace/executeCommand', {
        command: 'unityshader/refreshKeywords',
        arguments: [args ?? {}],
      });
    })
  );
  onActiveEditor(vscode.window.activeTextEditor);

  context.subscriptions.push(
    vscode.commands.registerCommand('unityshader.showIndexStats', async () => {
      if (!client) return;
      const stats = await client.sendRequest('workspace/executeCommand', {
        command: 'unityshader/__indexStats',
      });
      void vscode.window.showInformationMessage(`Unity Shader index: ${JSON.stringify(stats)}`);
    }),
    // M5 类型诊断：对当前文档强制重算（绕缓存；规格 feature-type-diagnostics 范围 9）
    vscode.commands.registerCommand('unityshader.runTypeDiagnostics', async () => {
      if (!client) return null;
      const uri = activeFileUri();
      const res = (await client.sendRequest('workspace/executeCommand', {
        command: 'unityshader/runTypeDiagnostics',
        arguments: uri ? [{ uri }] : [],
      })) as { counts?: { produced?: number; skippedSyntaxError?: boolean; dxcMissing?: string | null }; state?: string } | null;
      if (!res) return null;
      if (res.state && res.state !== 'ok') {
        void vscode.window.showInformationMessage(`Unity Shader 类型诊断不可用（${res.state}）：见 Output 面板 [dxc] 行`);
      } else {
        const n = res.counts?.produced ?? 0;
        void vscode.window.showInformationMessage(
          res.counts?.skippedSyntaxError
            ? 'Unity Shader 类型诊断：文档有语法错误，已跳过 DXC（修好语法后自动恢复）'
            : `Unity Shader 类型诊断：${n} 条`
        );
      }
      return res;
    }),
    // M6a（T-072）变体分析报告：分析在 server（只读），这里只把结果写进**专用 Output 通道**
    vscode.commands.registerCommand('unityshader.reportVariants', async () => {
      if (!client) return null;
      const uri = activeFileUri();
      const res = (await client.sendRequest('workspace/executeCommand', {
        command: 'unityshader/reportVariants',
        arguments: uri ? [{ uri }] : [],
      })) as VariantReportResult | null;
      return showVariantReport(res);
    }),
    vscode.commands.registerCommand('unityshader.reportVariantsProject', async () => {
      if (!client) return null;
      const res = (await client.sendRequest('workspace/executeCommand', {
        command: 'unityshader/reportVariantsProject',
      })) as VariantReportResult | null;
      return showVariantReport(res);
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

  // M6a（T-072）：变体报告写进**专用** Output 通道，不混进 'Unity Shader Tools' 日志通道
  variantsChannel = vscode.window.createOutputChannel('Unity Shader Variants');
  context.subscriptions.push(variantsChannel);

  // ---- T-075/T-076：ADR 0006 第 2/3 层（规格 feature-language-id-coexistence）----
  // 自愈只处理「`files.associations` 把我们的扩展名指向未注册 id」这一种 plaintext
  // （三条件判定在 languageIdFix.shouldSelfHeal）；用户手动选的 plaintext 不动。
  const langIdChannel = vscode.window.createOutputChannel('Unity Shader Language ID');
  context.subscriptions.push(langIdChannel);
  const langIdLog = (line: string): void => {
    langIdChannel.appendLine(line);
    trace(line);
  };
  /** 本会话已切过的文档 uri：一份至多一次；用户切回 plaintext 不再切（规格范围 6） */
  const switchedDocs = new Set<string>();
  let langIdSwitches = 0;

  const assocEntries = (): AssocEntry[] => {
    const cfg = vscode.workspace.getConfiguration('files').inspect('associations');
    return mergeAssociationEntries(
      cfg?.workspaceValue as Record<string, string> | undefined,
      cfg?.globalValue as Record<string, string> | undefined
    );
  };

  const runSelfHeal = async (reason: string): Promise<void> => {
    if (vscode.workspace.getConfiguration('unityShader').get<boolean>('autoFixLanguageId', true) === false) return;
    const registered = new Set(await vscode.languages.getLanguages());
    const invalid = invalidAssociationEntries(assocEntries(), registered);
    let fixed = 0;
    let scanned = 0;
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== 'file') continue;
      scanned++;
      if (switchedDocs.has(doc.uri.toString())) continue;
      if (!shouldSelfHeal({ fileName: doc.fileName, languageId: doc.languageId }, invalid)) continue;
      const to = targetIdFor(doc.fileName);
      if (!to) continue;
      try {
        await vscode.languages.setTextDocumentLanguage(doc, to);
        switchedDocs.add(doc.uri.toString());
        langIdSwitches++;
        fixed++;
        langIdLog(`[language-id] switched=${path.basename(doc.fileName)} to=${to} trigger=${reason}`);
      } catch {
        /* 文档已关闭或被拒：跳过，不崩（规格异常表） */
      }
    }
    if (fixed > 0 || reason === 'activate' || reason === 'test') {
      langIdLog(`[language-id] self-heal fixed=${fixed} scanned=${scanned} trigger=${reason}`);
    }
  };

  interface FixAssociationsResult {
    fixed: number;
    scanned: number;
    target?: AssocScope;
    error?: string;
    skippedMixed: string[];
  }
  const fixFileAssociations = async (forcedTarget?: unknown): Promise<FixAssociationsResult> => {
    const registered = new Set(await vscode.languages.getLanguages());
    const entries = assocEntries();
    const plan = planAssociationRewrite(entries, registered);
    const scanned = entries.length;
    if (plan.rewrite.length === 0) {
      langIdLog(
        `[language-id] fixed=0 scanned=${scanned} nothing-to-fix` +
          (plan.skippedMixed.length ? ` skipped=mixed-glob:${plan.skippedMixed.join(',')}` : '')
      );
      void vscode.window.showInformationMessage('Unity Shader：没有需要修复的文件关联');
      return { fixed: 0, scanned, skippedMixed: plan.skippedMixed };
    }
    let target: AssocScope | undefined;
    if (forcedTarget === 'workspace' || forcedTarget === 'user') {
      target = forcedTarget; // 编程式调用/集成测试：跳过对话框（真实用户走命令面板，无参数 → 弹窗）
    } else {
      const labels = commandTargets(vscode.workspace.workspaceFolders !== undefined).map((t) =>
        t === 'workspace' ? 'Workspace' : 'User'
      );
      const picked = await vscode.window.showWarningMessage(
        `Unity Shader：发现 ${plan.rewrite.length} 条文件关联指向未注册的语言 id（${plan.rewrite
          .map((r) => `"${r.glob}"→"${r.fromId}"`)
          .join('、')}）。把修复写到哪一级设置？`,
        { modal: true },
        ...labels
      );
      if (!picked) return { fixed: 0, scanned, error: 'cancelled', skippedMixed: plan.skippedMixed };
      target = picked === 'Workspace' ? 'workspace' : 'user';
    }
    const cfg = vscode.workspace.getConfiguration('files');
    const scope = target === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    const inspected = cfg.inspect('associations');
    const current =
      ((target === 'workspace' ? inspected?.workspaceValue : inspected?.globalValue) ?? {}) as Record<string, string>;
    try {
      // 条目级写回：只改命中条目，其余键原样保留（规格约束「不整对象覆盖」）
      await cfg.update('associations', mergeAssociations(current, plan), scope);
    } catch (err) {
      langIdLog(`[language-id] write-failed=${String(err).slice(0, 160)} target=${target}`);
      void vscode.window.showErrorMessage('Unity Shader：写入文件关联失败（settings 可能只读）');
      return { fixed: 0, scanned, target, error: 'write-failed', skippedMixed: plan.skippedMixed };
    }
    langIdLog(`[language-id] fixed=${plan.rewrite.length} scanned=${scanned} target=${target}`);
    if (plan.skippedMixed.length) langIdLog(`[language-id] skipped=mixed-glob ${plan.skippedMixed.join(' ')}`);
    // T-077：写回设置后，对仍处 plaintext 的匹配文档再跑一次自愈判定（规格范围 10）
    await runSelfHeal('after-fix');
    return { fixed: plan.rewrite.length, scanned, target, skippedMixed: plan.skippedMixed };
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('unityshader.fixFileAssociations', (target?: unknown) => fixFileAssociations(target)),
    // 测试钩子：跑一次自愈扫描，返回切换集合与累计切换次数（幂等断言：≤1/会话）
    vscode.commands.registerCommand('unityshader/__testLanguageIdScan', async () => {
      await runSelfHeal('test');
      return { switched: [...switchedDocs], switches: langIdSwitches };
    }),
    vscode.commands.registerCommand('unityshader/__testLanguageIdState', () => ({
      switches: langIdSwitches,
      switched: [...switchedDocs],
      autoFix: vscode.workspace.getConfiguration('unityShader').get<boolean>('autoFixLanguageId', true),
    }))
  );

  // 第 2 层接线：activate 时对已打开文档补跑 + 订阅新打开（**不新增** `onLanguage:plaintext`
  // 激活事件——规格约束：不为自愈扩大激活面，plaintext 文档只在扩展已激活时被处理）
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.uri.scheme === 'file') void runSelfHeal('open');
    })
  );
  void runSelfHeal('activate');

  client.start().then(undefined, (err) => {
    trace(`start() rejected: ${err && err.message ? err.message : String(err)}`);
  });
}

/** M6a（T-072）：变体分析报告的客户端侧收口。分析全在 server（只读），这里只呈现。 */
let variantsChannel: vscode.OutputChannel | undefined;

interface VariantReportResult {
  error?: string;
  scope?: string;
  files?: number;
  shaders?: number;
  builtinGroups?: number;
  materials?: { mapped?: number; unmapped?: number; evidence?: string };
  suggestions?: number;
  lines?: string[];
}

function showVariantReport(res: VariantReportResult | null): VariantReportResult | null {
  if (!res) return null;
  if (res.error === 'no-open-document') {
    void vscode.window.showInformationMessage(
      'Unity Shader 变体报告：没有活动文档（要汇总整个工程请用 “Report Shader Variants (Project)”）'
    );
    return res;
  }
  if (res.error === 'no-workspace') {
    void vscode.window.showInformationMessage('Unity Shader 变体报告：没有打开工作区文件夹');
    return res;
  }
  if (!variantsChannel) variantsChannel = vscode.window.createOutputChannel('Unity Shader Variants');
  variantsChannel.clear();
  variantsChannel.appendLine(
    `# Unity Shader 变体报告 · ${res.scope ?? 'file'}：文件 ${res.files ?? 0}，shader ${res.shaders ?? 0}，内置组 ${res.builtinGroups ?? 0}`
  );
  for (const l of res.lines ?? []) variantsChannel.appendLine(l);
  variantsChannel.show(true);
  return res;
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) return undefined;
  return client.stop();
}
