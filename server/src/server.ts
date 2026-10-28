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

interface Settings {
  trace: 'off' | 'messages' | 'verbose';
  index: boolean;
  maxIndexFileSize: number; // bytes
  unityEditorPath?: string;
}

const DEFAULT_SETTINGS: Settings = {
  trace: 'off',
  index: true,
  maxIndexFileSize: 2 * 1024 * 1024,
};

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
      } as InitializeResult['capabilities'],
    };
  });

  connection.onInitialized(() => {
    // 文件监听由客户端 synchronize.fileEvents 建立并转发 didChangeWatchedFiles；
    // 服务端只声明静态能力，不做动态注册（少一层注册失败风险）
    runBackgroundIndex();
  });

  connection.onDidChangeConfiguration((change) => {
    const next = (change.settings?.unityShader ?? {}) as Partial<Settings>;
    settings = { ...DEFAULT_SETTINGS, ...next };
    log(`settings updated: index=${settings.index} maxFile=${settings.maxIndexFileSize}`);
  });

  documents.onDidOpen((e) => {
    const file = uriToFsPath(e.document.uri);
    if (store.isGenerated(file)) {
      log(`language features disabled for generated file: ${file}`);
      return;
    }
    store.open(file, e.document.getText());
    reindexFile(file, e.document.getText());
  });

  // TextDocuments 先 listen：它注册默认的 didChange 处理；
  // 下面再覆盖为原始 contentChanges 处理（tree-sitter 增量重解析需要编辑区间）。
  documents.listen(connection as never);

  connection.onDidChangeTextDocument((params) => {
    const file = uriToFsPath(params.textDocument.uri);
    const state = store.change(file, params.contentChanges as never);
    if (state && !state.generated) reindexFile(file, state.text);
  });

  documents.onDidClose((e) => {
    store.close(uriToFsPath(e.document.uri));
  });

  connection.onDidChangeWatchedFiles(({ changes }) => {
    for (const c of changes as FileEvent[]) {
      const file = uriToFsPath(c.uri);
      if (isGeneratedFile(file)) continue;
      if (c.type === 3 /* Deleted */) {
        index.removeFile(file);
        store.close(file);
      } else {
        try {
          reindexFile(file, fs.readFileSync(file, 'utf8'));
        } catch {
          index.removeFile(file);
        }
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
    if (params.command === 'unityshader/__indexStats') {
      return {
        pid: process.pid, // 集成测试据此断言进程身份与重启
        files: index.fileCount,
        symbols: index.symbolCount,
        indexing, // 集成测试据此等待首轮扫描完成（补全候选依赖包内符号）
        degraded: env.degradedReasons,
        includeRoots: includeCtx(),
      };
    }
    return null;
  });

  connection.listen();
}

if (require.main === module) {
  start();
}
