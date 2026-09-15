import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { workspaceFolderEntriesForProject, type ProjectWorkspaceFolder } from '../discovery/project.js';
import { ContentLengthDecoder, encodeContentLengthJson } from '../protocol/framing.js';
import type { LspDiagnosticMode, SemanticCheckTiming, VerseCompilerDiagnostic, VerseProjectMetadata } from '../types.js';

const DEFAULT_TIMEOUT_MS = 120000;
const DIAGNOSTIC_SETTLE_MS = 1200;
const DIAGNOSTIC_QUIET_MS = 10000;
const SHUTDOWN_TIMEOUT_MS = 1000;

interface LspPosition {
  line?: unknown;
  character?: unknown;
}

interface LspRange {
  start?: LspPosition;
  end?: LspPosition;
}

interface LspDiagnostic {
  severity?: unknown;
  message?: unknown;
  source?: unknown;
  code?: unknown;
  range?: LspRange;
}

interface LspMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

type LspId = number | string;

export interface LspWorkspaceFolder {
  uri: string;
  name: string;
}

export interface LspProtocolObservation {
  clientMethods: string[];
  serverMethods: string[];
  serverRequests: string[];
  configurationSections: Array<string | null>;
  registrations: string[];
  serverCapabilities?: Record<string, unknown>;
  workspaceDiagnosticAdvertised: boolean;
  textDocumentDiagnosticAdvertised: boolean;
  workspaceDiagnosticRequested: boolean;
  workspaceDiagnosticCompleted: boolean;
  workspaceDiagnosticError?: string;
  pullDiagnosticRequested: boolean;
  pullDiagnosticCompleted: number;
  pullDiagnosticError?: string;
}

export interface LspCheckRun {
  diagnostics: VerseCompilerDiagnostic[];
  sourceDiagnostics: VerseCompilerDiagnostic[];
  metadataDiagnostics: VerseCompilerDiagnostic[];
  filesChecked: number;
  timing: SemanticCheckTiming;
  connected: boolean;
  diagnosticMode: LspDiagnosticMode;
  protocol: LspProtocolObservation;
  childProcessId?: number;
  spawnedExecutablePath?: string;
  shutdownClean: boolean;
  error?: string;
}

export interface LspCheckOptions {
  timeoutMs?: number;
  settleMs?: number;
  /** Bounded fallback when the server does not publish all expected diagnostics. */
  quietMs?: number;
  /** Diagnostic transport to use. The default is push diagnostics only. */
  diagnosticMode?: LspDiagnosticMode;
  /** Optional in-memory full-text replacements keyed by native source path; disk files are never changed. */
  sourceTexts?: Readonly<Record<string, string>>;
  /** Override the official extension's first workspace folder root path. */
  rootPath?: string | null;
  /** Override the official extension's first workspace folder root URI. */
  rootUri?: string | null;
  /** Override generated workspace folders, including their user-visible names. */
  workspaceFolders?: readonly LspWorkspaceFolder[];
  /** Value sent as LSP initialize.initializationOptions. */
  initializationOptions?: unknown;
  /** Deep-merged with the official-extension-shaped default client capabilities. */
  clientCapabilities?: Record<string, unknown>;
  /** Configuration values returned to workspace/configuration requests. */
  configuration?: Readonly<Record<string, unknown>> | ((item: Record<string, unknown>) => unknown);
  /** Whether to send a full-text didChange after didOpen; enabled for dirty in-memory probes. */
  sendDidChange?: boolean;
  /** Match Epic's extension by copying the bundled executable to a temporary path before spawn. */
  copyExecutableToTemp?: boolean;
  /** Arguments configured by verse.serverArguments. */
  serverArguments?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  shutdownTimeoutMs?: number;
  /** Observe the child while it is still alive; used by the acceptance harness for process evidence. */
  onSpawn?: (details: { pid: number; executablePath: string; cwd: string }) => void;
  spawnProcess?: (executablePath: string, options: { cwd: string; args?: readonly string[]; env?: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
  now?: () => number;
}

function defaultSpawn(executablePath: string, options: { cwd: string; args?: readonly string[]; env?: NodeJS.ProcessEnv }): ChildProcessWithoutNullStreams {
  return spawn(executablePath, [...(options.args ?? [])], {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: options.env ?? { ...process.env },
  });
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function severityFor(value: unknown): VerseCompilerDiagnostic['severity'] {
  if (typeof value === 'number') return ({ 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' } as const)[value];
  const normalized = String(value ?? '').toLowerCase();
  if (normalized.includes('error')) return 'error';
  if (normalized.includes('warn')) return 'warning';
  if (normalized.includes('info')) return 'info';
  if (normalized.includes('hint')) return 'hint';
  return undefined;
}

function positionLine(position: LspPosition | undefined): number | undefined {
  const value = asNumber(position?.line);
  return value === undefined ? undefined : Math.max(0, Math.floor(value)) + 1;
}

function positionColumn(position: LspPosition | undefined): number | undefined {
  const value = asNumber(position?.character);
  return value === undefined ? undefined : Math.max(0, Math.floor(value)) + 1;
}

/** Convert an LSP file URI to a native path, including Epic's percent-encoded Windows drive form. */
export function fileUriToPath(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') return undefined;
    const decodedPath = decodeURIComponent(parsed.pathname);
    if (/^\/[A-Za-z]:[\\/]/.test(decodedPath)) return decodedPath.slice(1).replace(/\//g, path.sep);
    return fileURLToPath(parsed);
  } catch {
    return undefined;
  }
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

/** Normalize an Epic LSP diagnostic into the package's one-based diagnostic shape. */
export function normalizeLspDiagnostics(uri: string, values: unknown[]): VerseCompilerDiagnostic[] {
  const file = fileUriToPath(uri);
  return values.flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const diagnostic = value as LspDiagnostic;
    if (typeof diagnostic.message !== 'string') return [];
    const result: VerseCompilerDiagnostic = {
      message: diagnostic.message,
      source: typeof diagnostic.source === 'string' && diagnostic.source ? diagnostic.source : 'epic-verse-lsp',
    };
    const severity = severityFor(diagnostic.severity);
    if (severity) result.severity = severity;
    if (file) result.file = file;
    const start = diagnostic.range?.start;
    const end = diagnostic.range?.end;
    const line = positionLine(start);
    const column = positionColumn(start);
    const endLine = positionLine(end);
    const endColumn = positionColumn(end);
    if (line !== undefined) result.line = line;
    if (column !== undefined) result.column = column;
    if (endLine !== undefined) result.endLine = endLine;
    if (endColumn !== undefined) result.endColumn = endColumn;
    if (typeof diagnostic.code === 'string' || typeof diagnostic.code === 'number') result.code = diagnostic.code;
    return [result];
  });
}

function workspaceUri(filePath: string): string {
  return pathToFileURL(filePath).href;
}

function diagnosticKey(uri: string): string {
  const filePath = fileUriToPath(uri);
  return filePath ? normalizePath(filePath) : uri;
}

function isDiagnosticValue(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string');
}

/** Accept standard LSP workspace diagnostic reports and the equivalent shape used by older Epic builds. */
function workspaceDiagnosticEntries(value: unknown): Array<{ uri: string; values: unknown[] }> {
  if (!value || typeof value !== 'object') return [];
  const record = value as { items?: unknown };
  if (!Array.isArray(record.items)) return [];
  const entries: Array<{ uri: string; values: unknown[] }> = [];
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object') return;
    const item = candidate as { uri?: unknown; items?: unknown; diagnostics?: unknown };
    if (typeof item.uri === 'string') {
      if (Array.isArray(item.items) && (item.items.length === 0 || item.items.every(isDiagnosticValue))) {
        entries.push({ uri: item.uri, values: item.items });
        return;
      }
      if (Array.isArray(item.diagnostics)) {
        entries.push({ uri: item.uri, values: item.diagnostics });
        return;
      }
    }
    if (Array.isArray(item.items)) for (const nested of item.items) visit(nested);
  };
  for (const item of record.items) visit(item);
  return entries;
}

function pullDiagnosticEntries(value: unknown): Array<{ uri?: string; values: unknown[] }> {
  if (Array.isArray(value)) return [{ values: value }];
  if (!value || typeof value !== 'object') return [];
  const record = value as { items?: unknown; uri?: unknown; diagnostics?: unknown };
  if (Array.isArray(record.items)) return [{ uri: typeof record.uri === 'string' ? record.uri : undefined, values: record.items }];
  if (Array.isArray(record.diagnostics)) return [{ uri: typeof record.uri === 'string' ? record.uri : undefined, values: record.diagnostics }];
  return [];
}

function responseError(value: unknown): string {
  if (!value || typeof value !== 'object') return 'Verse language server returned an error.';
  const record = value as Record<string, unknown>;
  return typeof record.message === 'string' ? record.message : 'Verse language server returned an error.';
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    child && typeof child === 'object' && !Array.isArray(child) ? cloneRecord(child as Record<string, unknown>) : child,
  ]));
}

function mergeRecords(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = cloneRecord(base);
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = mergeRecords(result[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** The capabilities emitted by the installed vscode-languageclient 5.x built-in features used by Epic's extension. */
export function officialClientCapabilities(): Record<string, unknown> {
  return {
    workspace: {
      applyEdit: true,
      workspaceEdit: {
        documentChanges: true,
        resourceOperations: ['create', 'rename', 'delete'],
        failureHandling: 'textOnlyTransactional',
      },
      configuration: true,
      workspaceFolders: true,
      didChangeConfiguration: { dynamicRegistration: true },
      didChangeWatchedFiles: { dynamicRegistration: true },
    },
    textDocument: {
      publishDiagnostics: { relatedInformation: true },
      synchronization: { dynamicRegistration: true, willSave: true, willSaveWaitUntil: true, didSave: true },
      completion: {
        dynamicRegistration: true,
        completionItem: {
          snippetSupport: true,
          commitCharactersSupport: true,
          documentationFormat: ['markdown', 'plaintext'],
          deprecatedSupport: true,
          preselectSupport: true,
        },
        contextSupport: true,
      },
      hover: { dynamicRegistration: true, contentFormat: ['markdown', 'plaintext'] },
      signatureHelp: { dynamicRegistration: true, signatureInformation: { documentationFormat: ['markdown', 'plaintext'] } },
      definition: { dynamicRegistration: true, linkSupport: true },
      references: { dynamicRegistration: true },
      documentHighlight: { dynamicRegistration: true },
      documentSymbol: { dynamicRegistration: true, hierarchicalDocumentSymbolSupport: true },
      codeAction: { dynamicRegistration: true, codeActionLiteralSupport: { codeActionKind: { valueSet: [] } }, dataSupport: true },
      codeLens: { dynamicRegistration: true },
      formatting: { dynamicRegistration: true },
      rangeFormatting: { dynamicRegistration: true },
      onTypeFormatting: { dynamicRegistration: true },
      rename: { dynamicRegistration: true, prepareSupport: true },
      documentLink: { dynamicRegistration: true, tooltipSupport: true },
    },
    window: {
      workDoneProgress: true,
      showMessage: { messageActionItem: { additionalPropertiesSupport: true } },
      showDocument: { support: true },
    },
    general: {
      regularExpressions: { engine: 'ECMAScript', version: 'ES2020' },
      markdown: { parser: 'marked', version: '1.1.0' },
    },
  };
}

function defaultConfiguration(item: Record<string, unknown>): unknown {
  const section = typeof item.section === 'string' ? item.section : undefined;
  const verse = { serverPath: '', serverArguments: [], syncFileEvents: true, trace: '', useRelease: false };
  if (!section) return { verse };
  if (section === 'verse') return verse;
  if (section === 'verse.serverPath') return verse.serverPath;
  if (section === 'verse.serverArguments') return verse.serverArguments;
  if (section === 'verse.syncFileEvents') return verse.syncFileEvents;
  if (section === 'verse.trace') return verse.trace;
  if (section === 'verse.useRelease') return verse.useRelease;
  return null;
}

function configurationFor(options: LspCheckOptions, item: Record<string, unknown>): unknown {
  if (typeof options.configuration === 'function') return options.configuration(item);
  if (options.configuration) {
    const section = typeof item.section === 'string' ? item.section : undefined;
    if (section && Object.prototype.hasOwnProperty.call(options.configuration, section)) return options.configuration[section];
  }
  return defaultConfiguration(item);
}

function copiedExecutable(executablePath: string): string {
  const extension = path.extname(executablePath);
  const base = path.basename(executablePath, extension);
  const preferred = path.join(process.env.TEMP ?? process.env.TMP ?? '.', `${base}-${process.pid}${extension}`);
  let candidate = preferred;
  let suffix = 1;
  while (fs.existsSync(candidate)) candidate = path.join(path.dirname(preferred), `${base}-${process.pid}-${suffix++}${extension}`);
  fs.copyFileSync(executablePath, candidate);
  return candidate;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Run the installed Epic Verse language server over project source without writing to the project. */
export async function runVerseLspCheck(
  metadata: VerseProjectMetadata,
  executablePath: string,
  options: LspCheckOptions = {},
): Promise<LspCheckRun> {
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const timeoutMs = Math.max(1000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const settleMs = Math.max(100, options.settleMs ?? DIAGNOSTIC_SETTLE_MS);
  const diagnosticMode = options.diagnosticMode ?? 'push';
  const timing: SemanticCheckTiming = { totalMs: 0 };
  const protocol: LspProtocolObservation = {
    clientMethods: [],
    serverMethods: [],
    serverRequests: [],
    configurationSections: [],
    registrations: [],
    workspaceDiagnosticAdvertised: false,
    textDocumentDiagnosticAdvertised: false,
    workspaceDiagnosticRequested: false,
    workspaceDiagnosticCompleted: false,
    pullDiagnosticRequested: false,
    pullDiagnosticCompleted: 0,
  };
  if (metadata.sourceFiles.length === 0) {
    timing.totalMs = Math.round(now() - startedAt);
    return {
      diagnostics: [],
      sourceDiagnostics: [],
      metadataDiagnostics: [],
      filesChecked: 0,
      timing,
      connected: false,
      diagnosticMode,
      protocol,
      shutdownClean: false,
    };
  }

  const entries = options.workspaceFolders ?? workspaceFolderEntriesForProject(metadata).map((entry: ProjectWorkspaceFolder) => ({
    uri: workspaceUri(entry.path),
    name: entry.name,
  }));
  const workspaceFolders = [...new Map(entries.map(entry => [entry.uri, entry])).values()];
  const firstWorkspacePath = workspaceFolders[0] ? fileUriToPath(workspaceFolders[0].uri) : undefined;
  const rootPath = options.rootPath === undefined ? firstWorkspacePath ?? metadata.contentPath : options.rootPath;
  const rootUri = options.rootUri === undefined ? workspaceFolders[0]?.uri ?? null : options.rootUri;
  const sourceOverrides = new Map(Object.entries(options.sourceTexts ?? {}).map(([filePath, text]) => [normalizePath(filePath), text]));
  const sourceUris = new Set(metadata.sourceFiles.map(filePath => normalizePath(filePath)));
  const diagnosticsByUri = new Map<string, VerseCompilerDiagnostic[]>();
  const decoder = new ContentLengthDecoder();
  const pending = new Map<LspId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const expectedSourceUris = [...sourceUris];
  const publishedUris = new Set<string>();
  let nextId = 1;
  let child: ChildProcessWithoutNullStreams;
  let childExited = false;
  let connected = false;
  let initialized = false;
  let shutdownSent = false;
  let shutdownResponseReceived = false;
  let shutdownClean = false;
  let finished = false;
  let workspaceReportReceived = diagnosticMode !== 'workspace' && diagnosticMode !== 'both';
  let pullExpected = 0;
  let pullCompleted = 0;
  let pullCapabilityResolved = diagnosticMode !== 'pull';
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveRun: (value: LspCheckRun) => void = () => undefined;
  let temporaryExecutablePath: string | undefined;
  let spawnedExecutablePath: string | undefined;
  let initializeStartedAt: number | undefined;
  let workspaceStartedAt: number | undefined;
  let shutdownStartedAt: number | undefined;
  let analysisSettled = false;
  let resolveError: string | undefined;

  const resultPromise = new Promise<LspCheckRun>(resolve => { resolveRun = resolve; });

  const recordClientMethod = (message: Record<string, unknown>): void => {
    if (typeof message.method === 'string') protocol.clientMethods.push(message.method);
  };

  const send = (message: Record<string, unknown>): void => {
    recordClientMethod(message);
    if (child.stdin.destroyed) return;
    child.stdin.write(encodeContentLengthJson(message));
  };

  const request = (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++;
    const promise = new Promise<unknown>((resolve, reject) => { pending.set(id, { resolve, reject }); });
    send({ jsonrpc: '2.0', id, method, params });
    return promise;
  };

  const stopProcess = (): void => {
    if (!child.killed && !childExited) child.kill();
    if (killTimer) clearTimeout(killTimer);
  };

  const cleanupTemporaryExecutable = (): void => {
    if (!temporaryExecutablePath) return;
    try { fs.unlinkSync(temporaryExecutablePath); } catch { /* It may already have been removed by the OS. */ }
    temporaryExecutablePath = undefined;
  };

  const buildResult = (error?: string): LspCheckRun => {
    const entriesForResult = [...diagnosticsByUri.entries()];
    const sourceDiagnostics = entriesForResult.filter(([uri]) => sourceUris.has(uri)).flatMap(([, values]) => values);
    const metadataDiagnostics = entriesForResult.filter(([uri]) => !sourceUris.has(uri)).flatMap(([, values]) => values);
    return {
      diagnostics: [...sourceDiagnostics, ...metadataDiagnostics],
      sourceDiagnostics,
      metadataDiagnostics,
      filesChecked: metadata.sourceFiles.length,
      timing: { ...timing, totalMs: Math.round(now() - startedAt) },
      connected,
      diagnosticMode,
      protocol: {
        ...protocol,
        serverCapabilities: protocol.serverCapabilities ? cloneRecord(protocol.serverCapabilities) : undefined,
        pullDiagnosticCompleted: pullCompleted,
      },
      childProcessId: child.pid ?? undefined,
      spawnedExecutablePath,
      shutdownClean,
      error,
    };
  };

  const resolveFinished = (error?: string): void => {
    if (finished) return;
    finished = true;
    if (settleTimer) clearTimeout(settleTimer);
    if (quietTimer) clearTimeout(quietTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
    for (const entry of pending.values()) entry.reject(new Error('Verse language server stopped.'));
    pending.clear();
    cleanupTemporaryExecutable();
    resolveRun(buildResult(error));
  };

  const finalizeShutdown = (error?: string): void => {
    if (shutdownStartedAt !== undefined) timing.shutdownMs = Math.round(now() - shutdownStartedAt);
    // A semantic-mode error (for example, unsupported pull diagnostics) does not make an
    // otherwise successful JSON-RPC shutdown unclean.
    if (shutdownResponseReceived && childExited) shutdownClean = true;
    resolveFinished(error);
  };

  const complete = (error?: string): void => {
    if (finished || shutdownSent) return;
    shutdownSent = true;
    resolveError = error;
    if (!initialized) {
      resolveFinished(error);
      stopProcess();
      return;
    }
    shutdownStartedAt = now();
    request('shutdown', null).then(() => {
      shutdownResponseReceived = true;
      send({ jsonrpc: '2.0', method: 'exit' });
      child.stdin.end();
      if (childExited) {
        finalizeShutdown(resolveError);
        return;
      }
      killTimer = setTimeout(() => {
        stopProcess();
        finalizeShutdown(resolveError ?? 'Verse language server did not shut down cleanly.');
      }, Math.max(100, options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS));
    }).catch(() => {
      finalizeShutdown(resolveError ?? 'Verse language server shutdown failed.');
      stopProcess();
    });
  };

  // Push diagnostics are notifications, not a complete-report protocol. Epic's server omits
  // empty publications for clean source files, so absence of a source notification is not an
  // error in push mode. Workspace and pull modes have an explicit completion signal; pull still
  // requires one response per opened source document.
  const sourceDiagnosticsComplete = (): boolean => diagnosticMode !== 'pull'
    || expectedSourceUris.every(uri => diagnosticsByUri.has(uri) || publishedUris.has(uri));
  const diagnosticRequestsComplete = (): boolean => {
    const workspaceComplete = (diagnosticMode !== 'workspace' && diagnosticMode !== 'both') || workspaceReportReceived;
    const pullComplete = diagnosticMode !== 'pull' || (pullCapabilityResolved && pullCompleted >= pullExpected);
    return workspaceComplete && pullComplete;
  };

  const finishWhenSettled = (): void => {
    if (!sourceDiagnosticsComplete() || !diagnosticRequestsComplete() || analysisSettled || finished || shutdownSent) return;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      analysisSettled = true;
      timing.analysisSettledMs = Math.round(now() - startedAt);
      complete();
    }, settleMs);
  };

  const startQuietFallback = (): void => {
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      if (analysisSettled || finished || shutdownSent) return;
      analysisSettled = true;
      timing.analysisSettledMs = Math.round(now() - startedAt);
      const missingSource = diagnosticMode === 'pull' && !sourceDiagnosticsComplete();
      const missingRequest = !diagnosticRequestsComplete();
      const error = missingSource
        ? 'Verse language server did not publish diagnostics for every source file before the quiet-period deadline.'
        : missingRequest
          ? 'Verse language server did not complete the requested diagnostic report before the quiet-period deadline.'
          : undefined;
      complete(error);
    }, Math.max(settleMs, options.quietMs ?? DIAGNOSTIC_QUIET_MS));
  };

  const handleMessage = (message: LspMessage): void => {
    const id = typeof message.id === 'number' || typeof message.id === 'string' ? message.id : undefined;
    const method = typeof message.method === 'string' ? message.method : undefined;
    if (method) protocol.serverMethods.push(method);
    if (method && id !== undefined) {
      protocol.serverRequests.push(method);
      if (method === 'workspace/configuration') {
        const params = isObject(message.params) && Array.isArray(message.params.items) ? message.params.items : [];
        const items = params.filter(isObject);
        for (const item of items) protocol.configurationSections.push(typeof item.section === 'string' ? item.section : null);
        send({ jsonrpc: '2.0', id, result: items.map(item => configurationFor(options, item)) });
      } else {
        if (method === 'client/registerCapability' && isObject(message.params) && Array.isArray(message.params.registrations)) {
          for (const registration of message.params.registrations) {
            if (isObject(registration) && typeof registration.method === 'string') protocol.registrations.push(registration.method);
          }
        }
        send({ jsonrpc: '2.0', id, result: null });
      }
      return;
    }
    if (method === 'textDocument/publishDiagnostics' && isObject(message.params)) {
      if (shutdownSent) return;
      const uri = message.params.uri;
      if (typeof uri !== 'string') return;
      const values = Array.isArray(message.params.diagnostics) ? message.params.diagnostics : [];
      diagnosticsByUri.set(diagnosticKey(uri), normalizeLspDiagnostics(uri, values));
      publishedUris.add(diagnosticKey(uri));
      if (timing.firstDiagnosticMs === undefined) timing.firstDiagnosticMs = Math.round(now() - startedAt);
      finishWhenSettled();
      return;
    }
    if (id !== undefined) {
      const callback = pending.get(id);
      if (!callback) return;
      pending.delete(id);
      if (message.error !== undefined) callback.reject(new Error(responseError(message.error)));
      else callback.resolve(message.result);
    }
  };

  let executableForSpawn = executablePath;
  try {
    if (options.copyExecutableToTemp ?? true) {
      temporaryExecutablePath = copiedExecutable(executablePath);
      executableForSpawn = temporaryExecutablePath;
    }
    spawnedExecutablePath = executableForSpawn;
    child = (options.spawnProcess ?? defaultSpawn)(executableForSpawn, {
      cwd: rootPath ?? metadata.contentPath,
      args: options.serverArguments,
      env: options.environment ?? { ...process.env },
    });
    if (child.pid !== undefined) options.onSpawn?.({
      pid: child.pid,
      executablePath: executableForSpawn,
      cwd: rootPath ?? metadata.contentPath,
    });
    timing.spawnMs = Math.round(now() - startedAt);
  } catch (error) {
    cleanupTemporaryExecutable();
    timing.totalMs = Math.round(now() - startedAt);
    return {
      diagnostics: [],
      sourceDiagnostics: [],
      metadataDiagnostics: [],
      filesChecked: 0,
      timing,
      connected: false,
      diagnosticMode,
      protocol,
      spawnedExecutablePath,
      shutdownClean: false,
      error: error instanceof Error ? `Could not start Verse language server: ${error.message}` : 'Could not start Verse language server.',
    };
  }

  const shutdownOnExit = (code: number | null): void => {
    childExited = true;
    if (shutdownSent) {
      if (shutdownResponseReceived) finalizeShutdown(resolveError);
      else finalizeShutdown(resolveError ?? 'Verse language server exited during shutdown.');
      return;
    }
    if (!finished) resolveFinished(initialized ? 'Verse language server exited before diagnostics settled.' : 'Verse language server exited before initialization.');
    void code;
  };

  child.stdout.on('data', chunk => {
    try {
      for (const body of decoder.push(Buffer.from(chunk))) {
        try {
          handleMessage(JSON.parse(body) as LspMessage);
        } catch {
          complete('Verse language server returned invalid JSON.');
        }
      }
    } catch (error) {
      complete(error instanceof Error ? error.message : 'Verse language server framing failed.');
    }
  });
  child.stderr.on('data', () => undefined);
  child.on('error', error => resolveFinished(`Verse language server process failed: ${error.message}`));
  child.on('exit', shutdownOnExit);

  timeoutTimer = setTimeout(() => {
    complete('Verse language server timed out before diagnostics settled.');
  }, timeoutMs);

  try {
    initializeStartedAt = now();
    const initializeResult = await request('initialize', {
      processId: process.pid,
      rootPath,
      rootUri,
      capabilities: mergeRecords(officialClientCapabilities(), options.clientCapabilities ?? {}),
      initializationOptions: options.initializationOptions,
      trace: 'off',
      workspaceFolders: workspaceFolders.length > 0 ? workspaceFolders : null,
    });
    timing.initializeMs = Math.round(now() - initializeStartedAt);
    timing.startupMs = Math.round(now() - startedAt);
    if (!isObject(initializeResult)) throw new Error('Verse language server did not return initialization data.');
    connected = true;
    initialized = true;
    if (isObject(initializeResult.capabilities)) {
      protocol.serverCapabilities = initializeResult.capabilities;
      const diagnosticProvider = initializeResult.capabilities.diagnosticProvider;
      protocol.workspaceDiagnosticAdvertised = Boolean(isObject(diagnosticProvider) && diagnosticProvider.workspaceDiagnostics === true);
      protocol.textDocumentDiagnosticAdvertised = Boolean(isObject(diagnosticProvider));
    }
    send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    for (const sourceFile of metadata.sourceFiles) {
      const uri = workspaceUri(sourceFile);
      const text = sourceOverrides.get(normalizePath(sourceFile)) ?? await readFile(sourceFile, 'utf8');
      send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'verse', version: 1, text } } });
      if (options.sendDidChange ?? true) {
        send({ jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri, version: 2 }, contentChanges: [{ text }] } });
      }
    }
    if (metadata.sourceFiles.length === 0) finishWhenSettled();
    else {
      startQuietFallback();
      if (diagnosticMode === 'workspace' || diagnosticMode === 'both') {
        protocol.workspaceDiagnosticRequested = true;
        workspaceStartedAt = now();
        request('workspace/diagnostic', { previousResultIds: [] }).then(value => {
          if (timing.firstDiagnosticMs === undefined) timing.firstDiagnosticMs = Math.round(now() - startedAt);
          workspaceReportReceived = true;
          if (isObject(value) && Array.isArray(value.items)) {
            for (const entry of workspaceDiagnosticEntries(value)) {
              diagnosticsByUri.set(diagnosticKey(entry.uri), normalizeLspDiagnostics(entry.uri, entry.values));
            }
          } else {
            protocol.workspaceDiagnosticError = 'Verse language server returned an invalid workspace diagnostic report.';
          }
          if (workspaceStartedAt !== undefined) timing.workspaceDiagnosticMs = Math.round(now() - workspaceStartedAt);
          protocol.workspaceDiagnosticCompleted = true;
          if (protocol.workspaceDiagnosticError) complete(protocol.workspaceDiagnosticError);
          else finishWhenSettled();
        }).catch(error => {
          protocol.workspaceDiagnosticCompleted = true;
          if (workspaceStartedAt !== undefined) timing.workspaceDiagnosticMs = Math.round(now() - workspaceStartedAt);
          protocol.workspaceDiagnosticError = error instanceof Error ? error.message : 'workspace/diagnostic failed.';
          complete(protocol.workspaceDiagnosticError);
        });
      }
      if (diagnosticMode === 'pull') {
        if (!protocol.textDocumentDiagnosticAdvertised) {
          protocol.pullDiagnosticError = 'The language server did not advertise textDocument/diagnostic support.';
          pullExpected = 0;
          pullCompleted = 0;
          pullCapabilityResolved = true;
          // Let the server drain the document notifications before issuing shutdown. Some Epic
          // builds exit the pipe without answering shutdown when it arrives in the same turn as
          // the initial didChange burst.
          await new Promise<void>(resolve => setTimeout(resolve, Math.min(settleMs, 500)));
          complete(protocol.pullDiagnosticError);
        } else {
          protocol.pullDiagnosticRequested = true;
          pullExpected = metadata.sourceFiles.length;
          pullCapabilityResolved = true;
          for (const sourceFile of metadata.sourceFiles) {
            const uri = workspaceUri(sourceFile);
            request('textDocument/diagnostic', { textDocument: { uri } }).then(value => {
              const entriesForPull = pullDiagnosticEntries(value);
              for (const entry of entriesForPull) {
                const targetUri = entry.uri ?? uri;
                diagnosticsByUri.set(diagnosticKey(targetUri), normalizeLspDiagnostics(targetUri, entry.values));
                publishedUris.add(diagnosticKey(targetUri));
                if (timing.firstDiagnosticMs === undefined) timing.firstDiagnosticMs = Math.round(now() - startedAt);
              }
              pullCompleted += 1;
              protocol.pullDiagnosticCompleted = pullCompleted;
              finishWhenSettled();
            }).catch(error => {
              pullCompleted += 1;
              protocol.pullDiagnosticCompleted = pullCompleted;
              protocol.pullDiagnosticError = error instanceof Error ? error.message : 'textDocument/diagnostic failed.';
              finishWhenSettled();
            });
          }
        }
      }
      finishWhenSettled();
    }
  } catch (error) {
    complete(error instanceof Error ? error.message : 'Verse language server initialization failed.');
  }

  return resultPromise;
}
