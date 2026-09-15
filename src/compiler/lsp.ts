import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { workspaceFoldersForProject } from '../discovery/project.js';
import { ContentLengthDecoder, encodeContentLengthJson } from '../protocol/framing.js';
import type { SemanticCheckTiming, VerseCompilerDiagnostic, VerseProjectMetadata } from '../types.js';

const DEFAULT_TIMEOUT_MS = 120000;
const DIAGNOSTIC_SETTLE_MS = 1200;
const DIAGNOSTIC_QUIET_MS = 10000;

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

export interface LspCheckRun {
  diagnostics: VerseCompilerDiagnostic[];
  sourceDiagnostics: VerseCompilerDiagnostic[];
  metadataDiagnostics: VerseCompilerDiagnostic[];
  filesChecked: number;
  timing: SemanticCheckTiming;
  connected: boolean;
  error?: string;
}

export interface LspCheckOptions {
  timeoutMs?: number;
  settleMs?: number;
  /** Fallback quiet period when the server does not implement workspace/diagnostic. */
  quietMs?: number;
  /** Optional in-memory full-text replacements keyed by native source path; disk files are never changed. */
  sourceTexts?: Readonly<Record<string, string>>;
  spawnProcess?: (executablePath: string, options: { cwd: string }) => ChildProcessWithoutNullStreams;
  now?: () => number;
}

function defaultSpawn(executablePath: string, options: { cwd: string }): ChildProcessWithoutNullStreams {
  return spawn(executablePath, [], {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env },
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

function responseError(value: unknown): string {
  if (!value || typeof value !== 'object') return 'Verse language server returned an error.';
  const record = value as Record<string, unknown>;
  return typeof record.message === 'string' ? record.message : 'Verse language server returned an error.';
}

/** Run the installed Epic Verse language server over project source without writing to the project. */
export async function runVerseLspCheck(
  metadata: VerseProjectMetadata,
  executablePath: string,
  options: LspCheckOptions = {},
): Promise<LspCheckRun> {
  const startedAt = (options.now ?? (() => performance.now()))();
  const timeoutMs = Math.max(1000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const settleMs = Math.max(100, options.settleMs ?? DIAGNOSTIC_SETTLE_MS);
  const sourceFiles = metadata.sourceFiles;
  if (sourceFiles.length === 0) {
    return {
      diagnostics: [],
      sourceDiagnostics: [],
      metadataDiagnostics: [],
      filesChecked: 0,
      timing: { totalMs: Math.round((options.now ?? (() => performance.now()))() - startedAt) },
      connected: false,
    };
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    child = (options.spawnProcess ?? defaultSpawn)(executablePath, { cwd: metadata.contentPath });
  } catch (error) {
    return {
      diagnostics: [],
      sourceDiagnostics: [],
      metadataDiagnostics: [],
      filesChecked: 0,
      timing: { totalMs: Math.round((options.now ?? (() => performance.now()))() - startedAt) },
      connected: false,
      error: error instanceof Error ? `Could not start Verse language server: ${error.message}` : 'Could not start Verse language server.',
    };
  }

  const now = options.now ?? (() => performance.now());
  const sourceOverrides = new Map(Object.entries(options.sourceTexts ?? {}).map(([filePath, text]) => [normalizePath(filePath), text]));
  const workspacePaths = workspaceFoldersForProject(metadata);
  const workspaceFolders = [...new Set(workspacePaths)].map(folderPath => ({ uri: workspaceUri(folderPath), name: path.basename(folderPath) }));
  const sourceUris = new Set(sourceFiles.map(filePath => normalizePath(filePath)));
  const diagnosticsByUri = new Map<string, VerseCompilerDiagnostic[]>();
  const decoder = new ContentLengthDecoder();
  const pending = new Map<LspId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 1;
  let connected = false;
  let initialized = false;
  let shutdownSent = false;
  let workspaceReportReceived = false;
  let finished = false;
  let firstDiagnosticMs: number | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveRun: (value: LspCheckRun) => void = () => undefined;

  const resultPromise = new Promise<LspCheckRun>(resolve => { resolveRun = resolve; });

  const send = (message: Record<string, unknown>): void => {
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
    if (!child.killed) child.kill();
    if (killTimer) clearTimeout(killTimer);
  };

  const buildResult = (error?: string): LspCheckRun => {
    const entries = [...diagnosticsByUri.entries()];
    const sourceDiagnostics = entries.filter(([uri]) => sourceUris.has(uri)).flatMap(([, values]) => values);
    const metadataDiagnostics = entries.filter(([uri]) => !sourceUris.has(uri)).flatMap(([, values]) => values);
    return {
      diagnostics: [...sourceDiagnostics, ...metadataDiagnostics],
      sourceDiagnostics,
      metadataDiagnostics,
      filesChecked: sourceFiles.length,
      timing: {
        startupMs: initialized ? Math.round(now() - startedAt) : undefined,
        firstDiagnosticMs,
        totalMs: Math.round(now() - startedAt),
      },
      connected,
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
    resolveRun(buildResult(error));
  };

  const complete = (error?: string): void => {
    if (finished || shutdownSent) return;
    shutdownSent = true;
    if (!initialized) {
      resolveFinished(error);
      stopProcess();
      return;
    }
    request('shutdown', null).then(() => {
      send({ jsonrpc: '2.0', method: 'exit' });
      child.stdin.end();
      resolveFinished(error);
    }).catch(() => {
      resolveFinished(error ?? 'Verse language server shutdown failed.');
      stopProcess();
    });
    killTimer = setTimeout(() => {
      resolveFinished(error ?? 'Verse language server did not shut down cleanly.');
      stopProcess();
    }, 1000);
  };

  const finishWhenSettled = (): void => {
    if (!workspaceReportReceived && sourceUris.size > 0 && [...sourceUris].some(uri => !diagnosticsByUri.has(uri))) return;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      complete();
    }, settleMs);
  };

  const startQuietFallback = (): void => {
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => complete(), Math.max(settleMs, options.quietMs ?? DIAGNOSTIC_QUIET_MS));
  };

  const handleMessage = (message: LspMessage): void => {
    const id = typeof message.id === 'number' || typeof message.id === 'string' ? message.id : undefined;
    const method = typeof message.method === 'string' ? message.method : undefined;
    if (method && id !== undefined) {
      if (method === 'workspace/configuration') {
        const items = message.params && typeof message.params === 'object' && Array.isArray((message.params as { items?: unknown }).items)
          ? (message.params as { items: unknown[] }).items
          : [];
        send({ jsonrpc: '2.0', id, result: items.map(() => null) });
      } else {
        send({ jsonrpc: '2.0', id, result: null });
      }
      return;
    }
    if (method === 'textDocument/publishDiagnostics' && message.params && typeof message.params === 'object') {
      // Epic may publish a final empty set while it is tearing down. Preserve the analysis snapshot.
      if (shutdownSent) return;
      const params = message.params as { uri?: unknown; diagnostics?: unknown };
      if (typeof params.uri !== 'string') return;
      const diagnostics = Array.isArray(params.diagnostics) ? normalizeLspDiagnostics(params.uri, params.diagnostics) : [];
      diagnosticsByUri.set(diagnosticKey(params.uri), diagnostics);
      if (firstDiagnosticMs === undefined) firstDiagnosticMs = Math.round(now() - startedAt);
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

  child.stdout.on('data', chunk => {
    try {
      for (const body of decoder.push(chunk)) {
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
  child.on('error', error => {
    resolveFinished(`Verse language server process failed: ${error.message}`);
  });
  child.on('exit', () => {
    if (killTimer) clearTimeout(killTimer);
    if (!finished) resolveFinished(initialized ? 'Verse language server exited before diagnostics settled.' : 'Verse language server exited before initialization.');
  });

  timeoutTimer = setTimeout(() => {
    complete('Verse language server timed out before diagnostics settled.');
  }, timeoutMs);

  try {
    const initializeResult = await request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'uefn-verse-compiler', version: '0.1.0' },
      rootUri: workspaceFolders.length === 1 ? workspaceFolders[0].uri : null,
      capabilities: {
        workspace: {
          configuration: true,
          workspaceFolders: true,
          didChangeWatchedFiles: { dynamicRegistration: true },
        },
        textDocument: {
          publishDiagnostics: { relatedInformation: true },
          synchronization: { dynamicRegistration: true, didSave: true },
        },
        window: { workDoneProgress: true },
      },
      workspaceFolders,
    });
    if (!initializeResult || typeof initializeResult !== 'object') throw new Error('Verse language server did not return initialization data.');
    connected = true;
    initialized = true;
    send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    for (const sourceFile of sourceFiles) {
      const uri = workspaceUri(sourceFile);
      const text = sourceOverrides.get(normalizePath(sourceFile)) ?? await readFile(sourceFile, 'utf8');
      send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'verse', version: 1, text } } });
      send({ jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri, version: 2 }, contentChanges: [{ text }] } });
    }
    if (sourceFiles.length === 0) finishWhenSettled();
    else {
      startQuietFallback();
      request('workspace/diagnostic', { previousResultIds: [] }).then(value => {
        const entries = workspaceDiagnosticEntries(value);
        if (!value || typeof value !== 'object' || !Array.isArray((value as { items?: unknown }).items)) return;
        workspaceReportReceived = true;
        for (const entry of entries) {
          diagnosticsByUri.set(diagnosticKey(entry.uri), normalizeLspDiagnostics(entry.uri, entry.values));
          if (firstDiagnosticMs === undefined) firstDiagnosticMs = Math.round(now() - startedAt);
        }
        finishWhenSettled();
      }).catch(() => undefined);
    }
  } catch (error) {
    complete(error instanceof Error ? error.message : 'Verse language server initialization failed.');
  }

  return resultPromise;
}
