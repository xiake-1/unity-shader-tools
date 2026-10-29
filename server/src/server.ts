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
import { isGeneratedFile, isCgSource } from './tempFiles';
import { provideDefinition, docTrees } from './definition';
import { analyzeVariants, variantDetailLines, variantSummaryLine } from './variantReport';
import { collectMaterialSources, materialScanLine, scanMaterials, suggestStripping } from './materialScan';
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
import { Diagnostic, DiagnosticSeverity, TextEdit, Range, Position } from 'vscode-languageserver';
import {
  TypeDiagnosticsProvider,
  typeDiagnosticLogLine,
  type TypeCounts,
  DEFAULT_MAX_TYPE_DIAGNOSTICS_PER_FILE,
} from './typeDiagnostics';
import { resolveDxc, probeDxc, dxcHealthLine, type DxcResolved, type DxcProbe, type DxcResolution } from './dxcRunner';
import { DxcExemptionTable } from './dxcExemption';
import {
  formatDocument,
  formatHealthLine,
  isHlslSource,
  DEFAULT_MAX_FORMAT_FILE_SIZE,
} from './formatter';
import {
  DEFAULT_FORMAT_SWITCHES,
  normalizeFormatSwitches,
  resolveIndentOptions,
  type FormatSwitches,
} from './formatSettings';
import { parseMacroOverrides, EMPTY_OVERRIDES, type MacroOverrides } from './dxcMacroTable';

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
  // M5 类型诊断（规格 feature-type-diagnostics 范围 14）
  typeDiagnostics: boolean;
  dxcPath: string;
  dxcTimeoutMs: number;
  maxTypeDiagnosticsPerFile: number;
  // 宏覆盖（规格 feature-dxc-macro-overrides 范围 1：`NAME` / `NAME=VALUE` / `-NAME`）
  dxcMacroOverrides: string[];
  // M5 格式化（规格 feature-formatting 范围 7：专属 4 开关；缩进宽度走 FormattingOptions）
  formatting: FormatSwitches;
  maxFormatFileSize: number;
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
  // 默认值与 `npm run gate:type-diagnostics` 的门槛结果联动（规格范围 12）：
  // 门槛 PASS（三源语料类型诊断总数 = 0）→ 默认 true；门槛 FAIL → 必须改回 false。
  typeDiagnostics: true,
  dxcPath: '',
  dxcTimeoutMs: 5000,
  maxTypeDiagnosticsPerFile: DEFAULT_MAX_TYPE_DIAGNOSTICS_PER_FILE,
  // 默认空列表 → 宏集与门槛基线字节相同（feature-dxc-macro-overrides 约束「门槛零漂移」）
  dxcMacroOverrides: [],
  // 默认值与 `npm run gate:format` 的门槛结果联动（规格 feature-formatting 范围 9）：
  // 门槛 PASS → true；门槛 FAIL → 必须改回 false（server 也就不宣告 documentFormattingProvider）
  formatting: DEFAULT_FORMAT_SWITCHES,
  maxFormatFileSize: DEFAULT_MAX_FORMAT_FILE_SIZE,
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
    editorPathSource: 'none',
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
  /** 格式化请求与产出计数（`__indexStats` 与集成测试用） */
  let formatRequests = 0;
  let formatVerbatimBytes = 0;
  let formatChangedBytes = 0;
  /** 语法诊断与类型诊断**共用同一次 publishDiagnostics**（规格约束：合并推送、不互相覆盖残留） */
  const syntaxDiags = new Map<string, Diagnostic[]>();
  const typeDiags = new Map<string, Diagnostic[]>();

  const pathToUri = (p: string): string => {
    const slash = p.replace(/\\/g, '/');
    return /^([a-zA-Z]):/.test(slash) ? `file:///${encodeURI(slash)}` : `file://${encodeURI(slash)}`;
  };

  /** 合并两类诊断后一次发布（谁后算完都不覆盖另一方的结果） */
  const publishMerged = (file: string): void => {
    const uri = openUris.get(file) ?? pathToUri(file);
    diagPublishes++;
    connection.sendDiagnostics({
      uri,
      diagnostics: [...(syntaxDiags.get(file) ?? []), ...(typeDiags.get(file) ?? [])],
    });
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
    if (!settings.syntaxDiagnostics && !settings.includeDiagnostics) {
      // 两个开关都关：清空旧语法诊断，不残留（规格异常表）
      syntaxDiags.delete(file);
      publishMerged(file);
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
    syntaxDiags.set(file, res.diagnostics);
    publishMerged(file);
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
    syntaxDiags.delete(file);
    typeDiags.delete(file);
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

  // ---- M5 类型诊断（DXC）（T-056，规格 feature-type-diagnostics；ADR 0010）----

  /** dxc 定位结果与版本。定位失败 → 零类型诊断 + 一次性提示 + 日志 `dxc=missing`（规格范围 4 + 异常表） */
  const dxcState: {
    /** `resolveDxc` 的原始结果（健康行与失败原因用） */
    resolution: DxcResolution | null;
    /** 只有定位 + 探活都成功才非空 —— 跑编译只认这个 */
    resolved: DxcResolved | null;
    probe: DxcProbe | null;
    version: string | null;
    /** 状态标签（`ok` / `missing-configured` / `dll-missing` …），集成测试与门槛断言用 */
    state: string;
    notified: boolean;
  } = { resolution: null, resolved: null, probe: null, version: null, state: 'not-probed', notified: false };
  const typeProvider = new TypeDiagnosticsProvider(2);
  let typeRuns = 0;
  let lastTypeCounts: TypeCounts | null = null;

  // T-079：用户宏覆盖（feature-dxc-macro-overrides）。解析一次存着，`prepareTypeRun` 直接用；
  // 缓存键含最终宏串（`macros.join(',')`），列表一变键就变，无需手动清缓存。
  let macroOverrides: MacroOverrides = EMPTY_OVERRIDES;
  const syncMacroOverrides = (): void => {
    macroOverrides = parseMacroOverrides(settings.dxcMacroOverrides ?? []);
    if ((settings.dxcMacroOverrides ?? []).length > 0) {
      log(
        `[type] macro-overrides applied=${macroOverrides.defines.length} ` +
          `removed=${macroOverrides.removes.size} invalid=${macroOverrides.invalid.length}`
      );
    }
  };

  const notifyDxcUnavailable = (detail: string): void => {
    if (dxcState.notified) return; // 一次性提示（规格异常表「客户端一次性明确提示」）
    dxcState.notified = true;
    connection.window.showInformationMessage(`Unity Shader 类型诊断不可用：${detail}`);
  };

  /** 定位 + 探活 dxc（启动时一次；`unityShader.dxcPath` 变化时重跑） */
  const resolveDxcTool = async (): Promise<void> => {
    const r = resolveDxc({ configuredPath: settings.dxcPath, moduleDir: __dirname });
    dxcState.resolution = r;
    if (!r.ok) {
      dxcState.resolved = null;
      dxcState.probe = null;
      dxcState.version = null;
      dxcState.state = r.reason;
      log(`[type-diagnostics] dxc=missing reason=${r.reason} ${r.detail}`);
      notifyDxcUnavailable(r.detail);
      return;
    }
    const probe = await probeDxc(r.path);
    dxcState.probe = probe;
    dxcState.resolved = probe.ok ? r : null;
    dxcState.version = probe.ok ? probe.version ?? null : null;
    dxcState.state = probe.ok ? 'ok' : probe.reason;
    log(dxcHealthLine(r, probe));
    if (!probe.ok) notifyDxcUnavailable(probe.detail);
  };

  /** 跑一次类型诊断。触发面只有 `didOpen`/`didSave`/`didChangeWatchedFiles` 与命令 ——
   *  **`didChange` 不触发**（DXC 无增量，规格范围 9）。`force` = 命令强制重算（绕缓存）。 */
  const runTypeDiagnostics = async (file: string, force = false): Promise<void> => {
    if (isGeneratedFile(file) || isCgSource(file)) return;
    const state = store.get(file);
    if (!state) return; // 只对已打开的文档跑（规格约束）
    if (!settings.typeDiagnostics) {
      typeDiags.delete(file);
      typeProvider.clear(file);
      publishMerged(file);
      return;
    }
    if (force) typeProvider.clear(file);
    const uri = openUris.get(file);
    const version = uri ? documents.get(uri)?.version ?? 0 : 0;
    // 语法 Error 互斥（规格范围 8）：只数 Error —— include 未找到的 Warning 不触发跳过。
    // 开关开着时直接复用刚发布的语法诊断；**开关关掉时不能拿它当依据**（那时它是空的），
    // 否则关掉语法诊断会让带语法错误的文档去跑 DXC，把刚被压掉的错误换个来源再推一遍。
    let syntaxErrors = 0;
    if (settings.syntaxDiagnostics) {
      syntaxErrors = (syntaxDiags.get(file) ?? []).filter(
        (d) => d.severity === DiagnosticSeverity.Error
      ).length;
    } else {
      syntaxErrors = computeFileDiagnostics(treesForFile(file, state.text), {
        file,
        maxPerFile: settings.maxDiagnosticsPerFile,
        exemptions: new ExemptionTable(),
        includeCtx: includeCtx(),
        syntaxDiagnostics: true,
        includeDiagnostics: false,
      }).counts.syntax;
    }
    const res = await typeProvider.run(file, state.text, {
      version,
      syntaxErrorCount: syntaxErrors,
      dxc: dxcState.resolved,
      dxcVersion: dxcState.version,
      includeCtx: includeCtx(),
      disabled: keywords.current.set,
      macroOverrides,
      tree: state.tree ?? undefined,
      timeoutMs: settings.dxcTimeoutMs,
      maxPerFile: settings.maxTypeDiagnosticsPerFile,
      exemptions: new DxcExemptionTable(),
    });
    typeRuns++;
    lastTypeCounts = res.counts;
    typeDiags.set(file, res.diagnostics);
    log(typeDiagnosticLogLine(file, res.counts));
    publishMerged(file);
  };

  /** 开关关掉 → 清空所有已打开文档的类型诊断（规格异常表「已有类型诊断清空」） */
  const clearAllTypeDiagnostics = (): void => {
    typeProvider.clearAll();
    for (const [file, diags] of [...typeDiags.entries()]) {
      if (diags.length === 0) continue;
      typeDiags.delete(file);
      publishMerged(file);
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
    // 嵌套对象不能靠浅合并（客户端只发部分键会把默认值整块替掉）
    settings.formatting = normalizeFormatSwitches(initOpts.settings?.formatting ?? DEFAULT_SETTINGS.formatting);
    syncMacroOverrides();
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
      } editor-path-source=${env.editorPathSource} degraded=${env.degradedReasons.join(',') || 'no'}`
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
        // M5 格式化（规格 feature-formatting 范围 9）：门槛 FAIL 或用户关掉 → 不宣告该能力。
        // 能力在 initialize 定死，改 `unityShader.formatting.enable` 需重载窗口（约束）
        documentFormattingProvider: settings.formatting.enable,
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
    // 类型诊断：定位并探活 dxc（失败 → 一次性提示 + `dxc=missing`，其余功能不受影响）
    void resolveDxcTool();
  });

  connection.onDidChangeConfiguration((change) => {
    const next = (change.settings?.unityShader ?? {}) as Partial<Settings>;
    const prevDxcPath = settings.dxcPath;
    const prevType = settings.typeDiagnostics;
    const prevFormatEnable = settings.formatting.enable;
    const prevOverridesKey = JSON.stringify(settings.dxcMacroOverrides ?? []);
    settings = { ...DEFAULT_SETTINGS, ...next };
    settings.formatting = normalizeFormatSwitches(next.formatting ?? DEFAULT_SETTINGS.formatting);
    log(
      `settings updated: index=${settings.index} maxFile=${settings.maxIndexFileSize} ` +
        `syntax=${settings.syntaxDiagnostics} include=${settings.includeDiagnostics} ` +
        `debounce=${settings.diagnosticsDebounceMs} maxDiag=${settings.maxDiagnosticsPerFile} ` +
        `type=${settings.typeDiagnostics} dxcPath=${settings.dxcPath || 'auto'} ` +
        `dxcTimeout=${settings.dxcTimeoutMs} maxTypeDiag=${settings.maxTypeDiagnosticsPerFile} ` +
        `format=${settings.formatting.enable} maxFormatFile=${settings.maxFormatFileSize}`
    );
    // 格式化能力在 initialize 定死：改开关只记提示，不假装即时生效（规格异常表）
    if (settings.formatting.enable !== prevFormatEnable) {
      log('format=capability-reload-required');
    }
    // 开关变化立即重发：关掉语法诊断时旧诊断必须清空，不残留（规格异常表）
    for (const file of openUris.keys()) publishNow(file);
    // 类型诊断开关关掉 → 清空已有类型诊断；`dxcPath` 改了 → 重新定位（规格范围 14）
    if (!settings.typeDiagnostics || !prevType) clearAllTypeDiagnostics();
    if (settings.dxcPath !== prevDxcPath) {
      dxcState.notified = false;
      void resolveDxcTool();
    }
    // T-079：覆盖列表变了 → 重解析 + 已打开文档重算（缓存键随宏串自然变化，无需保存）
    if (JSON.stringify(settings.dxcMacroOverrides ?? []) !== prevOverridesKey) {
      syncMacroOverrides();
      for (const file of openUris.keys()) void runTypeDiagnostics(file);
    }
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
    void runTypeDiagnostics(file); // didOpen 触发类型诊断（规格范围 9）
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
      // 类型诊断在语法诊断之后跑：互斥判定要读刚算完的语法 Error（规格范围 8）
      void runTypeDiagnostics(file);
    }
  });

  documents.onDidClose((e) => {
    const file = uriToFsPath(e.document.uri);
    clearDiagnostics(file, e.document.uri); // didClose 清空该文件诊断（规格范围 6）
    typeProvider.clear(file); // 取消未完成的 DXC 子进程并丢掉缓存
    typeDiags.delete(file);
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
        typeProvider.clear(file);
        typeDiags.delete(file);
        store.close(file);
        openUris.delete(file);
      } else {
        try {
          reindexFile(file, fs.readFileSync(file, 'utf8'));
        } catch {
          index.removeFile(file);
        }
        publishNow(file); // 外部修改（git 切分支等）驱动重算（规格异常表）
        if (openUris.has(file)) void runTypeDiagnostics(file); // 类型诊断同样重算（规格范围 9）
      }
    }
  });

  // M5 格式化（T-063，规格 feature-formatting 范围 1）：整篇一次、返回**单个覆盖全文的 TextEdit**；
  // 失败即不改（返回 null，编辑器零改动，范围 10）。
  // 方法名是 `onDocumentFormatting`（不是 `onFormatting`）——写错时可选链会静默跳过注册，
  // 表现为编辑器报 `Unhandled method textDocument/formatting`，所以这里不用可选链兜底。
  connection.onDocumentFormatting((params) => {
    const file = uriToFsPath(params.textDocument.uri);
    formatRequests++;
    const doc = documents.get(params.textDocument.uri);
    const state = store.get(file);
    const text = doc?.getText() ?? state?.text;
    const empty = { verbatimBytes: 0, changedBytes: 0, verbatimLines: 0 };
    if (text === undefined) {
      log(formatHealthLine(file, { text: null, reason: 'no-document', ...empty }));
      return null;
    }
    // 只有树与文本一致时才复用（ADR 0001 唯一 CST；不一致就重解析，别拿旧树排版）
    const trees =
      state && state.tree && state.text === text
        ? isHlslSource(file)
          ? { hlsl: state.tree }
          : { shaderlab: state.tree }
        : undefined;
    const out = formatDocument({
      file,
      text,
      indent: resolveIndentOptions(params.options),
      switches: settings.formatting,
      maxBytes: settings.maxFormatFileSize,
      trees,
    });
    log(formatHealthLine(file, out));
    if (out.text === null || out.text === text) return null;
    formatVerbatimBytes += out.verbatimBytes;
    formatChangedBytes += out.changedBytes;
    const lines = text.split('\n').length;
    return [TextEdit.replace(Range.create(Position.create(0, 0), Position.create(lines, 0)), out.text)];
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
    if (params.command === 'unityshader/runTypeDiagnostics') {
      // 客户端命令 unityshader.runTypeDiagnostics 的实现：对当前文档**强制重算**（绕缓存，规格范围 9）。
      // 可选参数 { uri } 只给集成测试用；缺省取活动文档。
      const args = (params.arguments ?? []) as { uri?: string }[];
      const file = args[0]?.uri ? uriToFsPath(args[0].uri) : [...openUris.keys()][0];
      if (!file) return { error: 'no-open-document' };
      await runTypeDiagnostics(file, true);
      return {
        file,
        counts: lastTypeCounts,
        dxc: dxcHealthLine(dxcState.resolution, dxcState.probe),
        state: dxcState.state,
      };
    }
    // M6a（T-072）变体分析报告：两个命令共用一个实现，**全程只读**（规格范围 10）。
    // 树复用 docTrees 的缓存（打开文档按树、磁盘文件按 mtime），分析函数自身不 parse。
    if (params.command === 'unityshader/reportVariants' || params.command === 'unityshader/reportVariantsProject') {
      const project = params.command === 'unityshader/reportVariantsProject';
      const args = (params.arguments ?? []) as { uri?: string }[];
      const file = args[0]?.uri ? uriToFsPath(args[0].uri) : [...openUris.keys()][0];
      if (!project && !file) return { error: 'no-open-document' };
      if (project && !env.projectRoot) return { error: 'no-workspace' };

      const targets = project ? [...index.fileNames()].sort() : [file as string];
      const entries: ReturnType<typeof analyzeVariants> = [];
      const lines: string[] = [];
      for (const f of targets) {
        const trees = docTrees(f, store);
        if (!trees) continue;
        const root = trees.labTree?.rootNode ?? trees.hlslTree?.rootNode;
        if (!root) continue;
        const es = analyzeVariants(root, f, trees.hlslTree?.rootNode ?? null);
        entries.push(...es);
        const worthListing = es.some((e) => e.shaderName !== null || e.groups.length > 0 || e.builtin.length > 0);
        if (worthListing) for (const e of es) lines.push(variantSummaryLine(e), ...variantDetailLines(e));
      }
      const sources = env.projectRoot ? collectMaterialSources(env.projectRoot) : { materials: [], metas: [] };
      const scan = scanMaterials(sources.materials, sources.metas);
      // 内置 Legacy Shaders 名单无可读来源（规格不在范围段）→ 显式记 unavailable，不静默给空清单
      lines.push(`shader-names=indexed=${index.shaderNameCount} builtin-shader-names=unavailable`);
      lines.push(materialScanLine(scan));
      const sug = suggestStripping(entries, scan);
      for (const s of sug.suggestions) {
        lines.push(`  建议核查 ${s.file}:${s.line} ${s.directive} 未被任何材质使用：${s.unusedKeywords.join(' ')}`);
      }
      if (sug.materialEvidence === 'none') {
        lines.push('  material-evidence=none → 只列组合，不出删除建议（规格范围 8 的门槛）');
      }
      for (const l of lines) log(l);
      return {
        scope: project ? 'project' : 'file',
        files: targets.length,
        shaders: entries.length,
        shaderNames: index.shaderNameCount,
        builtinGroups: entries.reduce((n, e) => n + e.builtin.length, 0),
        materials: { mapped: scan.mapped, unmapped: scan.unmapped, evidence: scan.evidence },
        suggestions: sug.suggestions.length,
        lines,
      };
    }
    if (params.command === 'unityshader/__indexStats') {
      return {
        pid: process.pid, // 集成测试据此断言进程身份与重启
        files: index.fileCount,
        symbols: index.symbolCount,
        shaderNames: index.shaderNameCount, // M6a（T-069）：shader 名计数
        indexing, // 集成测试据此等待首轮扫描完成（补全候选依赖包内符号）
        degraded: env.degradedReasons,
        editorPathSource: env.editorPathSource, // T-073：`editor-path-source=` 五值口径
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
        // M5 类型诊断：集成测试据此断言 dxc 状态、开关与计数
        typeDiagnostics: {
          enabled: settings.typeDiagnostics,
          runs: typeRuns,
          cachedFiles: typeProvider.cachedFiles,
          dxc: dxcHealthLine(dxcState.resolution, dxcState.probe),
          dxcState: dxcState.state,
          notified: dxcState.notified,
          settings: {
            timeoutMs: settings.dxcTimeoutMs,
            maxPerFile: settings.maxTypeDiagnosticsPerFile,
            dxcPath: settings.dxcPath,
          },
          // T-079：集成测试据此断言覆盖生效与非法条目计数
          macroOverrides: {
            applied: macroOverrides.defines.length,
            removed: macroOverrides.removes.size,
            invalid: macroOverrides.invalid.length,
          },
          lastCounts: lastTypeCounts,
        },
        // M5 格式化：集成测试据此断言能力宣告与请求计数
        formatting: {
          enabled: settings.formatting.enable,
          requests: formatRequests,
          verbatimBytes: formatVerbatimBytes,
          changedBytes: formatChangedBytes,
          switches: settings.formatting,
          maxBytes: settings.maxFormatFileSize,
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
