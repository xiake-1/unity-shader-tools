/** LSP server 入口（规格范围 1/2、T-002 与 T-009～T-012 的接线处）
 *
 * 能力：textDocumentSync=incremental、workspace/didChangeWatchedFiles。
 * 不做任何用户可见语言功能（跳转/补全/诊断属 M2～M5 各自规格）。
 * 索引在 initialize 之后后台进行，不阻塞握手与文档事件（规格约束）。
 */
import './bootTrace'; // 必须最先 import：先留痕，再加载 grammar
import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  FileEvent,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'fs';
import * as path from 'path';

import { DocumentStore } from './documentStore';
import { SymbolIndex } from './symbolIndex';
import { discoverUnityEnvironment, type UnityEnvironment } from './unityProject';
import { resolveInclude, type IncludeContext } from './includeResolver';
import { isGeneratedFile } from './tempFiles';
import { provideDefinition } from './definition';
import { provideCompletion } from './completion';
import { provideHover } from './hover';
import { provideReferences } from './references';
import { prepareRename, rename } from './rename';
import {
  computeFileDiagnostics,
  treesForFile,
  diagnosticLogLine,
  DEFAULT_MAX_DIAGNOSTICS_PER_FILE,
} from './diagnostics';
import { ExemptionTable } from './errorExemption';
import { UnityKeywordSource, keywordHealthLine } from './unityKeywordSource';
import { collectInactiveRegions, type InactiveRegion } from './inactiveRegions';

interface Settings {
  trace: 'off' | 'messages' | 'verbose';
  index: boolean;
  maxIndexFileSize: number; // bytes
  unityEditorPath?: string;
  // M4 语法诊断（规格 feature-syntax-diagnostics 范围 9）
  syntaxDiagnostics: boolean;
  includeDiagnostics: boolean;
  diagnosticsDebounceMs: number;
  maxDiagnosticsPerFile: number;
  // M4 死分支灰化（规格 feature-dead-branch-dimming 范围 8/9/11）
  keywordPollMs: number;
  keywordLogScanBytes: number;
  branchDebounceMs: number;
}

const DEFAULT_SETTINGS: Settings = {
  trace: 'off',
  index: true,
  maxIndexFileSize: 2 * 1024 * 1024,
  // 默认值与 `npm run gate:diagnostics` 的门槛结果联动（规格范围 7）：
  // 门槛 PASS（真实语料语法诊断总数 = 0）→ 默认 true；门槛 FAIL → 必须改回 false。
  syntaxDiagnostics: true,
  includeDiagnostics: true,
  diagnosticsDebounceMs: 800,
  maxDiagnosticsPerFile: DEFAULT_MAX_DIAGNOSTICS_PER_FILE,
  keywordPollMs: 5000,
  keywordLogScanBytes: 512 * 1024,
  branchDebounceMs: 700,
};

/** 客户端在 `initialize` 的 `capabilities.experimental` 里声明支持时才发通知（规格范围 6） */
export const INACTIVE_REGIONS_NOTIFICATION = 'unityshader/inactiveRegions';

const SHADER_EXT = /\.(shader|hlsl|hlslinc|cginc)$/i;

export function uriToFsPath(uri: string): string {
  if (uri.startsWith('file://')) {
    const u = new URL(uri);
    let p = decodeURIComponent(u.pathname);
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
    return p.replace(/\//g, path.sep);
  }
  return uri;
}

function listFiles(root: string, limit = 4000): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'Temp' || e.name === 'obj' || e.name === '.git') continue;
        stack.push(full);
      } else if (SHADER_EXT.test(e.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

/** 索引源清单：工程内 + 包内 + 内置（规格范围 6） */
export function collectIndexSources(env: UnityEnvironment, settings: Settings): string[] {
  const files: string[] = [];
  if (env.projectRoot) {
    for (const sub of ['Assets', 'Packages']) {
      const dir = path.join(env.projectRoot, sub);
      if (fs.existsSync(dir)) files.push(...listFiles(dir));
    }
  }
  if (env.packageCacheDir) {
    try {
      for (const e of fs.readdirSync(env.packageCacheDir)) {
        if (!/^com\.unity\.render-pipelines\./i.test(e)) continue;
        const lib = path.join(env.packageCacheDir, e, 'ShaderLibrary');
        if (fs.existsSync(lib)) files.push(...listFiles(lib));
      }
    } catch {
      /* PackageCache 缺失 → 降级，已在 degradedReasons 记录 */
    }
  }
  if (env.cgIncludesDir) {
    try {
      for (const e of fs.readdirSync(env.cgIncludesDir)) {
        if (SHADER_EXT.test(e)) files.push(path.join(env.cgIncludesDir, e));
      }
    } catch {
      /* 同上 */
    }
  }
  return files.filter((f) => !isGeneratedFile(f));
}

export function start(): void {
  // 显式绑定 stdio：既满足 VS Code 的 stdio 传输，也让集成测试能直接 spawn 握手
  const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
  const documents = new TextDocuments(TextDocument);
  const store = new DocumentStore();
  const index = new SymbolIndex();

  let settings: Settings = { ...DEFAULT_SETTINGS };
  let env: UnityEnvironment = {
    projectRoot: null,
    editorDir: null,
    cgIncludesDir: null,
    packageCacheDir: null,
    editorVersion: null,
    degradedReasons: [],
  };
  let indexing = false;
  let degradeNotified = false;

  const includeCtx = (): IncludeContext => ({
    projectRoot: env.projectRoot,
    cgIncludesDir: env.cgIncludesDir,
    packageCacheDir: env.packageCacheDir,
  });

  const log = (msg: string): void => {
    connection.console.log(`[unityshader] ${msg}`);
  };

  const reindexFile = (file: string, text?: string): void => {
    if (isGeneratedFile(file)) return;
    try {
      const doc = store.get(file);
      const content = text ?? doc?.text ?? fs.readFileSync(file, 'utf8');
      if (Buffer.byteLength(content) > settings.maxIndexFileSize) {
        log(`skip oversized file: ${file}`);
        return;
      }
      index.indexFile(file, content, doc?.tree ?? undefined);
    } catch (err) {
      log(`index failed: ${file}: ${(err as Error).message}`);
    }
  };

  // ---- M4 语法诊断发布管线（T-040，规格范围 1/6）----
  /** 打开文档的 file → uri（publishDiagnostics 要 uri，store 的键是 fs 路径） */
  const openUris = new Map<string, string>();
  const diagTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 发布次数计数器：集成测试据此断言防抖（连续 5 次 didChange 只发 1 次） */
  let diagPublishes = 0;

  const pathToUri = (p: string): string => {
    const slash = p.replace(/\\/g, '/');
    return /^([a-zA-Z]):/.test(slash) ? `file:///${encodeURI(slash)}` : `file://${encodeURI(slash)}`;
  };

  /** 立即计算并发布（`didOpen`/`didSave`/`didChangeWatchedFiles` 走这里，规格范围 6） */
  const publishNow = (file: string): void => {
    if (isGeneratedFile(file)) return; // core §7：生成文件不产任何诊断
    const state = store.get(file);
    let text: string | null = state?.text ?? null;
    if (text === null) {
      // 未打开的磁盘文件：受索引大小上限约束（规格约束：上限只约束未打开的文件）
      try {
        const st = fs.statSync(file);
        if (st.size > settings.maxIndexFileSize) {
          log(`diagnostics skipped (oversized, not open): ${file}`);
          return;
        }
        text = fs.readFileSync(file, 'utf8');
      } catch {
        return;
      }
    }
    const uri = openUris.get(file) ?? pathToUri(file);
    if (!settings.syntaxDiagnostics && !settings.includeDiagnostics) {
      // 两个开关都关：清空旧诊断，不残留（规格异常表）
      diagPublishes++;
      connection.sendDiagnostics({ uri, diagnostics: [] });
      return;
    }
    const res = computeFileDiagnostics(treesForFile(file, text), {
      file,
      maxPerFile: settings.maxDiagnosticsPerFile,
      exemptions: new ExemptionTable(),
      includeCtx: includeCtx(),
      syntaxDiagnostics: settings.syntaxDiagnostics,
      includeDiagnostics: settings.includeDiagnostics,
    });
    diagPublishes++;
    connection.sendDiagnostics({ uri, diagnostics: res.diagnostics });
    log(diagnosticLogLine(file, res.counts));
  };

  /** didChange 走防抖：窗口内不发布中间态（规格范围 6，默认 800 ms，0 = 即时） */
  const schedulePublish = (file: string): void => {
    const delay = Math.max(0, Math.min(5000, settings.diagnosticsDebounceMs));
    const existing = diagTimers.get(file);
    if (existing) clearTimeout(existing);
    if (delay === 0) {
      diagTimers.delete(file);
      publishNow(file);
      return;
    }
    diagTimers.set(
      file,
      setTimeout(() => {
        diagTimers.delete(file);
        publishNow(file);
      }, delay)
    );
  };

  const clearDiagnostics = (file: string, uri?: string): void => {
    const t = diagTimers.get(file);
    if (t) {
      clearTimeout(t);
      diagTimers.delete(file);
    }
    connection.sendDiagnostics({ uri: uri ?? pathToUri(file), diagnostics: [] });
  };

  // ---- M4 死分支灰化（T-046，规格 feature-dead-branch-dimming；ADR 0008）----
  // 日志路径按平台推导（规格约束）。测试用 `UNITYSHADER_KEYWORD_LOG` 指向 fixture 日志：
  // 规格的验收要求「Editor.log 用自包含 fixture」「fixture 指向不存在的日志路径」，
  // 而公开设置面只有三项（不含路径），故测试注入走环境变量，不进 contributes。
  const keywordLogOverride = process.env.UNITYSHADER_KEYWORD_LOG ?? undefined;
  const keywords = new UnityKeywordSource({
    scanBytes: DEFAULT_SETTINGS.keywordLogScanBytes,
    logPath: keywordLogOverride ?? null,
  });
  let lastHealthLine = '';
  /** 客户端未在 `capabilities.experimental` 声明支持 → 不发通知（规格异常表：功能静默缺席） */
  let clientWantsInactive = false;
  const branchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let disabledKey = '';
  let lastRegionTotal = 0;

  /** 求值 + 推送单个文档；返回本次 Range 数（健康行用它） */
  const pushInactive = (file: string): number => {
    if (!clientWantsInactive || isGeneratedFile(file)) return 0;
    const uri = openUris.get(file) ?? pathToUri(file);
    const doc = documents.get(uri);
    const text = doc?.getText() ?? store.get(file)?.text;
    if (text === undefined) return 0;
    const regions: InactiveRegion[] = [];
    for (const t of treesForFile(file, text)) {
      if (t.kind !== 'hlsl') continue; // ShaderLab 外壳没有预处理器（规格异常表）
      regions.push(...collectInactiveRegions(t.tree.rootNode, text, { disabled: keywords.current.set }));
    }
    connection.sendNotification(INACTIVE_REGIONS_NOTIFICATION, {
      uri,
      version: doc?.version ?? 0,
      regions,
    });
    lastRegionTotal = regions.length;
    return regions.length;
  };

  const pushAllInactive = (): number => {
    let total = 0;
    for (const f of openUris.keys()) total += pushInactive(f);
    return total;
  };

  /** 重读日志（mtime 未变则不重读）；集合变化 → 对已打开文档重算并推送（规格范围 8） */
  const refreshKeywords = (force: boolean, logPathOverride?: string | null): void => {
    if (logPathOverride !== undefined) keywords.setLogPath(logPathOverride);
    keywords.setScanBytes(settings.keywordLogScanBytes);
    const snap = keywords.refresh(force);
    const key = [...snap.set].sort().join(' ');
    if (key !== disabledKey) {
      disabledKey = key;
      pushAllInactive();
    }
    lastHealthLine = keywordHealthLine(snap, lastRegionTotal);
    log(lastHealthLine);
  };

  /** `didChange` 防抖（默认 700 ms，独立于语法诊断，规格范围 11） */
  const scheduleInactive = (file: string): void => {
    if (!clientWantsInactive) return;
    const delay = Math.max(0, Math.min(5000, settings.branchDebounceMs));
    const existing = branchTimers.get(file);
    if (existing) clearTimeout(existing);
    if (delay === 0) {
      branchTimers.delete(file);
      pushInactive(file);
      return;
    }
    branchTimers.set(
      file,
      setTimeout(() => {
        branchTimers.delete(file);
        pushInactive(file);
      }, delay)
    );
  };

  const startKeywordPolling = (): void => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (settings.keywordPollMs <= 0) return; // 0 = 关闭轮询（规格范围 8）
    pollTimer = setInterval(() => refreshKeywords(false), Math.max(1000, settings.keywordPollMs));
  };

  const notifyDegraded = (): void => {
    if (degradeNotified || env.degradedReasons.length === 0) return;
    degradeNotified = true;
    // 规格：降级只提示一次，不弹窗报错、不崩溃
    const reasons = env.degradedReasons.join(', ');
    connection.window.showInformationMessage(
      'Unity Shader Tools: 未识别到完整 Unity 工程（' +
        reasons +
        '）。ShaderLab 外壳与工程内符号可用，内置/包内符号不可用。'
    );
  };

  const runBackgroundIndex = (): void => {
    if (!settings.index || indexing) return;
    indexing = true;
    const files = collectIndexSources(env, settings);
    let done = 0;
    const startedAt = Date.now();
    const tick = (): void => {
      const batchStart = Date.now();
      while (done < files.length && Date.now() - batchStart < 20) {
        const f = files[done++];
        try {
          const st = fs.statSync(f);
          if (st.size > settings.maxIndexFileSize) continue;
          index.indexFile(f, fs.readFileSync(f, 'utf8'));
        } catch {
          /* 单文件失败不影响整体 */
        }
      }
      connection.sendNotification('unityshader/indexProgress', {
        done,
        total: files.length,
        symbols: index.symbolCount,
      });
      if (done < files.length) {
        setImmediate(tick);
      } else {
        indexing = false;
        log(
          `index done in ${Date.now() - startedAt}ms: files=${index.fileCount} ` +
            `symbols=${index.symbolCount} degraded=${env.degradedReasons.join(',') || 'no'}`
        );
      }
    };
    setImmediate(tick);
  };

  connection.onInitialize((params: InitializeParams): InitializeResult => {
    const workspaceFolders = (params.workspaceFolders ?? []).map((f) => uriToFsPath(f.uri));
    const initOpts = (params.initializationOptions ?? {}) as {
      activeFile?: string;
      settings?: Partial<Settings>;
    };
    if (initOpts.settings) settings = { ...DEFAULT_SETTINGS, ...initOpts.settings };
    // 灰化通知只在客户端声明支持时发（规格范围 6：capabilities.experimental 协商）
    const exp = (params.capabilities?.experimental ?? {}) as Record<string, unknown>;
    clientWantsInactive = exp[INACTIVE_REGIONS_NOTIFICATION] === true;
    const initFile = initOpts.activeFile ? uriToFsPath(String(initOpts.activeFile)) : null;
    env = discoverUnityEnvironment(initFile, workspaceFolders, {
      configuredEditorPath: settings.unityEditorPath,
    });
    log(
      `initialized: projectRoot=${env.projectRoot ?? 'null'} editor=${
        env.editorVersion ?? 'null'
      } degraded=${env.degradedReasons.join(',') || 'no'}`
    );
    notifyDegraded();
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        definitionProvider: true, // M2 转到定义（规格 feature-go-to-definition）
        completionProvider: {
          // M3 语义补全（规格 feature-completion，T-022）
          triggerCharacters: ['.', '"', '/', '\\'],
          resolveProvider: false, // M3 文档内联，不做二段 resolve
        },
        referencesProvider: true, // M3 引用查找（规格 feature-rename，T-029）
        renameProvider: { prepareProvider: true }, // M3 重命名两步流程（T-030）
        hoverProvider: true, // 悬停（规格 feature-hover，T-035）
        workspace: {
          fileOperations: {},
          // LSP 3.17 的静态 watched-files 能力在 workspace 下，类型定义未覆盖
          didChangeWatchedFiles: { dynamicRegistration: false },
        },
        // 灰化走 LSP 扩展通知（ADR 0008）：这里宣告服务端支持，客户端在 initialize 里宣告它支持
        experimental: { [INACTIVE_REGIONS_NOTIFICATION]: true },
      } as InitializeResult['capabilities'],
    };
  });

  connection.onInitialized(() => {
    // 文件监听由客户端 synchronize.fileEvents 建立并转发 didChangeWatchedFiles；
    // 服务端只声明静态能力，不做动态注册（少一层注册失败风险）
    runBackgroundIndex();
    // 灰化：启动时读一次日志并起轮询（mtime 未变不重读，规格范围 8）
    refreshKeywords(true);
    startKeywordPolling();
  });

  connection.onDidChangeConfiguration((change) => {
    const next = (change.settings?.unityShader ?? {}) as Partial<Settings>;
    settings = { ...DEFAULT_SETTINGS, ...next };
    log(
      `settings updated: index=${settings.index} maxFile=${settings.maxIndexFileSize} ` +
        `syntax=${settings.syntaxDiagnostics} include=${settings.includeDiagnostics} ` +
        `debounce=${settings.diagnosticsDebounceMs} maxDiag=${settings.maxDiagnosticsPerFile}`
    );
    // 开关变化立即重发：关掉语法诊断时旧诊断必须清空，不残留（规格异常表）
    for (const file of openUris.keys()) publishNow(file);
    // 灰化相关设置（轮询间隔 / 窗口 / 防抖）即时生效
    startKeywordPolling();
    refreshKeywords(true);
  });

  documents.onDidOpen((e) => {
    const file = uriToFsPath(e.document.uri);
    if (store.isGenerated(file)) {
      log(`language features disabled for generated file: ${file}`);
      return;
    }
    store.open(file, e.document.getText());
    reindexFile(file, e.document.getText());
    openUris.set(file, e.document.uri);
    publishNow(file); // didOpen 立即发布（规格范围 6）
    keywords.refresh(); // didOpen 读一次关键字（规格范围 8）
    pushInactive(file);
  });

  // TextDocuments 先 listen：它注册默认的 didChange 处理；
  // 下面再覆盖为原始 contentChanges 处理（tree-sitter 增量重解析需要编辑区间）。
  documents.listen(connection as never);

  connection.onDidChangeTextDocument((params) => {
    const file = uriToFsPath(params.textDocument.uri);
    const state = store.change(file, params.contentChanges as never);
    if (state && !state.generated) reindexFile(file, state.text);
    schedulePublish(file); // 防抖窗口内不发布中间态（规格范围 6）
    scheduleInactive(file); // 灰化独立防抖（规格范围 11）
  });

  documents.onDidSave((e) => {
    const file = uriToFsPath(e.document.uri);
    if (!store.isGenerated(file)) {
      publishNow(file); // didSave 立即发布
      pushInactive(file); // 灰化同样立即重算
    }
  });

  documents.onDidClose((e) => {
    const file = uriToFsPath(e.document.uri);
    clearDiagnostics(file, e.document.uri); // didClose 清空该文件诊断（规格范围 6）
    const bt = branchTimers.get(file);
    if (bt) {
      clearTimeout(bt);
      branchTimers.delete(file);
    }
    store.close(file);
    openUris.delete(file);
  });

  connection.onDidChangeWatchedFiles(({ changes }) => {
    for (const c of changes as FileEvent[]) {
      const file = uriToFsPath(c.uri);
      if (isGeneratedFile(file)) continue;
      if (c.type === 3 /* Deleted */) {
        index.removeFile(file);
        clearDiagnostics(file);
        store.close(file);
        openUris.delete(file);
      } else {
        try {
          reindexFile(file, fs.readFileSync(file, 'utf8'));
        } catch {
          index.removeFile(file);
        }
        publishNow(file); // 外部修改（git 切分支等）驱动重算（规格异常表）
      }
    }
  });

  // M2 转到定义（T-014～T-017）：生成文件不响应；索引进行中立即返回当前结果
  connection.onDefinition((params) => {
    const file = uriToFsPath(params.textDocument.uri);
    if (isGeneratedFile(file)) {
      log(`definition suppressed for generated file: ${file}`);
      return [];
    }
    try {
      return provideDefinition(file, params.position.line, params.position.character, {
        index,
        store,
        includeCtx: includeCtx(),
        projectRoot: env.projectRoot,
        log,
        indexing: () => indexing,
      });
    } catch (err) {
      log(`definition failed: ${(err as Error).message}`);
      return [];
    }
  });

  // M3 语义补全（T-022～T-027）：生成文件不响应；索引进行中立即返回当前结果
  connection.onCompletion((params) => {
    const file = uriToFsPath(params.textDocument.uri);
    if (isGeneratedFile(file)) {
      log(`completion suppressed for generated file: ${file}`);
      return { isIncomplete: false, items: [] };
    }
    try {
      return provideCompletion(file, params.position.line, params.position.character, {
        index,
        store,
        includeCtx: includeCtx(),
        projectRoot: env.projectRoot,
        log,
        indexing: () => indexing,
      });
    } catch (err) {
      log(`completion failed: ${(err as Error).message}`);
      return { isIncomplete: false, items: [] };
    }
  });

  // 悬停（T-035，规格 feature-hover）：生成文件不响应；异常吞掉返回 null
  connection.onHover((params) => {
    const file = uriToFsPath(params.textDocument.uri);
    if (isGeneratedFile(file)) {
      log(`hover suppressed for generated file: ${file}`);
      return null;
    }
    try {
      return provideHover(file, params.position.line, params.position.character, {
        index,
        store,
        includeCtx: includeCtx(),
        projectRoot: env.projectRoot,
        log,
        indexing: () => indexing,
      });
    } catch (err) {
      log(`hover failed: ${(err as Error).message}`);
      return null;
    }
  });

  // M3 引用查找（T-029）：生成文件不响应；上限 200 按优先级截断
  connection.onReferences((params) => {
    const file = uriToFsPath(params.textDocument.uri);
    if (isGeneratedFile(file)) {
      log(`references suppressed for generated file: ${file}`);
      return [];
    }
    try {
      return provideReferences(
        file,
        params.position.line,
        params.position.character,
        {
          index,
          store,
          includeCtx: includeCtx(),
          projectRoot: env.projectRoot,
          log,
          indexing: () => indexing,
        },
        !!params.context.includeDeclaration
      );
    } catch (err) {
      log(`references failed: ${(err as Error).message}`);
      return [];
    }
  });

  // M3 重命名（T-030/T-031）：prepareRename 拒绝内置/包内；rename 只生成用户源 edit；
  // Properties 属性改名后发 Info 资产失效提示
  connection.onPrepareRename((params) => {
    const file = uriToFsPath(params.textDocument.uri);
    const ctx = {
      index,
      store,
      includeCtx: includeCtx(),
      projectRoot: env.projectRoot,
      log,
      indexing: () => indexing,
    };
    const r = prepareRename(file, params.position.line, params.position.character, ctx);
    return r;
  });

  connection.onRenameRequest((params) => {
    const file = uriToFsPath(params.textDocument.uri);
    const ctx = {
      index,
      store,
      includeCtx: includeCtx(),
      projectRoot: env.projectRoot,
      log,
      indexing: () => indexing,
      notifyInfo: (msg: string) => void connection.window.showInformationMessage(msg),
    };
    return rename(file, params.position.line, params.position.character, params.newName, ctx);
  });

  // 测试钩子：模拟 server 崩溃，验证客户端重启策略（T-002 验收）
  connection.onExecuteCommand(async (params) => {
    if (params.command === 'unityshader/__testCrash') {
      log('crashing on request (test hook)');
      // 用硬终止模拟崩溃：Windows 上 process.abort() 可能触发 WER 对话框而挂住不退出
      setTimeout(() => {
        try {
          process.kill(process.pid);
        } catch {
          process.exit(1);
        }
      }, 10);
      return null;
    }
    if (params.command === 'unityshader/refreshKeywords') {
      // 客户端命令 unityshader.refreshShaderKeywords 的实现：强制重读日志 + 重算 + 推送。
      // 可选参数 { logPath } 只给集成测试用（指向 fixture 日志或不存在的日志）。
      const args = (params.arguments ?? []) as { logPath?: string | null }[];
      const override = args[0] && 'logPath' in args[0] ? args[0].logPath : undefined;
      refreshKeywords(true, override);
      return {
        disabled: keywords.current.disabled,
        regions: lastRegionTotal,
        health: lastHealthLine,
      };
    }
    if (params.command === 'unityshader/__indexStats') {
      return {
        pid: process.pid, // 集成测试据此断言进程身份与重启
        files: index.fileCount,
        symbols: index.symbolCount,
        indexing, // 集成测试据此等待首轮扫描完成（补全候选依赖包内符号）
        degraded: env.degradedReasons,
        includeRoots: includeCtx(),
        // M4：集成测试据此断言防抖与开关行为
        diagnosticsPublished: diagPublishes,
        diagnosticsSettings: {
          syntax: settings.syntaxDiagnostics,
          include: settings.includeDiagnostics,
          debounceMs: settings.diagnosticsDebounceMs,
        },
        // M4 灰化：集成测试据此断言协商结果与关键字状态
        inactiveRegions: {
          clientWants: clientWantsInactive,
          source: keywords.current.source,
          disabled: keywords.current.disabled.length,
          regions: lastRegionTotal,
          pollMs: settings.keywordPollMs,
          health: lastHealthLine,
        },
      };
    }
    return null;
  });

  connection.listen();
}

if (require.main === module) {
  start();
}
