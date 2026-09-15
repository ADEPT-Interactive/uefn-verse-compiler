import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { discoverToolchain, discoverVerseProjectMetadata, fileUriToPath, normalizeLspDiagnostics, workspaceFolderEntriesForProject } from '../src/index.js';
import { officialClientCapabilities } from '../src/compiler/lsp.js';
import { ContentLengthDecoder, encodeContentLengthJson } from '../src/protocol/framing.js';
import type { LspDiagnosticMode, VerseCompilerDiagnostic } from '../src/types.js';

interface Arguments {
  projectPath: string;
  settleMs: number;
  timeoutMs: number;
  json: boolean;
}

interface Publication {
  uri: string;
  diagnostics: VerseCompilerDiagnostic[];
  atMs: number;
}

interface Waiter {
  predicate: (publication: Publication) => boolean;
  resolve: (publication: Publication) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Measurement {
  project: string;
  sourceFile: string;
  diagnosticMode: LspDiagnosticMode;
  sourceHashUnchanged: boolean;
  initial: {
    sourceDiagnostics: number;
    sourcePublicationReceived: boolean;
    firstPublicationMs?: number;
    settledMs: number;
  };
  warmInvalid: {
    expectedCode: number;
    sourceDiagnostics: number;
    matched: boolean;
    editToDiagnosticMs?: number;
    examples: string[];
    error?: string;
  };
  warmClean: {
    sourceDiagnostics: number;
    matched: boolean;
    editToDiagnosticMs?: number;
    error?: string;
  };
  crossFile: {
    available: boolean;
    reason?: string;
  };
  lifecycle: {
    spawnMs: number;
    initializeMs: number;
    totalMs: number;
    shutdownClean: boolean;
  };
  error?: string;
}

const DEFAULT_SETTLE_MS = 1200;
const DEFAULT_TIMEOUT_MS = 30000;

function usage(): string {
  return [
    'Usage: npm run measure:lsp -- --project <Project.uefnproject> [options]',
    '',
    'Options:',
    '  --settle-ms <n>   settle window after initial load (default: 1200)',
    '  --timeout-ms <n>  per warm edit deadline (default: 30000)',
    '  --json             emit machine-readable evidence',
  ].join('\n');
}

function positive(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${flag} must be a positive number.`);
  return Math.floor(parsed);
}

function parseArguments(argv: string[]): Arguments {
  let projectPath: string | undefined;
  let settleMs = DEFAULT_SETTLE_MS;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (argument === '--project') {
      projectPath = argv[++index];
      continue;
    }
    if (argument === '--settle-ms') {
      settleMs = positive(argv[++index] ?? '', argument);
      continue;
    }
    if (argument === '--timeout-ms') {
      timeoutMs = positive(argv[++index] ?? '', argument);
      continue;
    }
    if (argument === '--json') {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!projectPath) throw new Error(`--project is required.\n\n${usage()}`);
  return { projectPath: path.resolve(projectPath), settleMs, timeoutMs, json };
}

function assertNoEditorProcesses(): void {
  if (process.platform !== 'win32') throw new Error('The real persistent LSP probe requires Windows.');
  const query = "$names=@('UnrealEditorFortnite-Win64-Shipping.exe','Code.exe','code-insiders.exe'); Get-CimInstance Win32_Process | Where-Object { $_.Name -in $names -or $_.Name -match '^verse-lsp.*\\.exe$' } | Select-Object Name,ProcessId | ConvertTo-Json -Compress";
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', windowsHide: true }).trim();
  if (output) throw new Error('UEFN, VS Code, or a pre-existing Verse language-server process is running; the persistent probe will not overlap it.');
}

function uriKey(uri: string): string {
  return uri.toLowerCase();
}

function diagnosticExamples(diagnostics: VerseCompilerDiagnostic[]): string[] {
  return [...new Set(diagnostics.map(diagnostic => diagnostic.message.split(/\r?\n/, 1)[0]))].slice(0, 4);
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

class PersistentLspProbe {
  private readonly decoder = new ContentLengthDecoder();
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly waiters: Waiter[] = [];
  private readonly latest = new Map<string, Publication>();
  private nextId = 1;
  private exited = false;
  private exitError: Error | undefined;
  readonly startedAt = performance.now();

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', chunk => {
      try {
        for (const body of this.decoder.push(Buffer.from(chunk))) this.handle(JSON.parse(body) as Record<string, unknown>);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('LSP framing failed.'));
      }
    });
    child.stderr.on('data', () => undefined);
    child.on('error', error => this.fail(error));
    child.on('exit', (code, signal) => {
      this.exited = true;
      if (!this.exitError && !this.pending.size && !this.waiters.length) return;
      this.fail(new Error(`Verse language server exited before the persistent probe completed (code=${code ?? 'null'}, signal=${signal ?? 'none'}).`));
    });
  }

  private fail(error: Error): void {
    if (!this.exitError) this.exitError = error;
    for (const callback of this.pending.values()) callback.reject(error);
    this.pending.clear();
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
  }

  private send(message: Record<string, unknown>): void {
    if (this.child.stdin.destroyed || this.exited) throw this.exitError ?? new Error('Verse language server is not running.');
    this.child.stdin.write(encodeContentLengthJson(message));
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => { this.pending.set(id, { resolve, reject }); });
    this.send({ jsonrpc: '2.0', id, method, params });
    return result;
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private handle(message: Record<string, unknown>): void {
    const method = typeof message.method === 'string' ? message.method : undefined;
    const id = typeof message.id === 'number' ? message.id : undefined;
    if (method && id !== undefined) {
      if (method === 'workspace/configuration') {
        const params = message.params && typeof message.params === 'object' && Array.isArray((message.params as Record<string, unknown>).items)
          ? (message.params as Record<string, unknown>).items as unknown[]
          : [];
        this.send({ jsonrpc: '2.0', id, result: params.map(item => item && typeof item === 'object' ? defaultConfiguration(item as Record<string, unknown>) : null) });
      } else {
        this.send({ jsonrpc: '2.0', id, result: null });
      }
      return;
    }
    if (method === 'textDocument/publishDiagnostics' && message.params && typeof message.params === 'object') {
      const params = message.params as Record<string, unknown>;
      if (typeof params.uri !== 'string') return;
      const diagnostics = Array.isArray(params.diagnostics) ? normalizeLspDiagnostics(params.uri, params.diagnostics) : [];
      const publication = { uri: params.uri, diagnostics, atMs: Math.round(performance.now() - this.startedAt) };
      this.latest.set(uriKey(params.uri), publication);
      for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
        const waiter = this.waiters[index];
        if (!waiter || !waiter.predicate(publication)) continue;
        this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(publication);
      }
      return;
    }
    if (id === undefined) return;
    const callback = this.pending.get(id);
    if (!callback) return;
    this.pending.delete(id);
    if (message.error && typeof message.error === 'object') {
      const errorMessage = (message.error as Record<string, unknown>).message;
      callback.reject(new Error(typeof errorMessage === 'string' ? errorMessage : 'LSP request failed.'));
    } else callback.resolve(message.result);
  }

  latestFor(uri: string): Publication | undefined {
    return this.latest.get(uriKey(uri));
  }

  waitFor(predicate: (publication: Publication) => boolean, timeoutMs: number, includeExisting = true): Promise<Publication> {
    if (includeExisting) {
      const existing = [...this.latest.values()].find(predicate);
      if (existing) return Promise.resolve(existing);
    }
    if (this.exitError) return Promise.reject(this.exitError);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error('Timed out waiting for the expected LSP publication.'));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async shutdown(timeoutMs: number): Promise<boolean> {
    if (this.exited) return !this.exitError;
    try {
      await this.request('shutdown', null);
      this.notify('exit', null);
      this.child.stdin.end();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('LSP shutdown timed out.')), timeoutMs);
        this.child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      return true;
    } catch {
      if (!this.child.killed) this.child.kill();
      return false;
    }
  }
}

function copyToTemp(executablePath: string): { directory: string; executablePath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verse-lsp-warm-'));
  const executable = path.join(directory, path.basename(executablePath));
  fs.copyFileSync(executablePath, executable);
  return { directory, executablePath: executable };
}

async function measure(args: Arguments): Promise<Measurement> {
  assertNoEditorProcesses();
  const metadata = discoverVerseProjectMetadata(args.projectPath);
  if (!metadata.metadataAvailable) throw new Error(metadata.error ?? 'Project metadata is unavailable.');
  if (metadata.sourceFiles.length === 0) throw new Error('The selected project has no Verse source files.');
  const sourceFile = metadata.sourceFiles[0] as string;
  const sourceText = fs.readFileSync(sourceFile, 'utf8');
  const sourceHash = cryptoHash(sourceText);
  const toolchain = await discoverToolchain({ projectPath: args.projectPath, metadata });
  const lspPath = toolchain.installation.verseLanguageServerPath;
  if (!lspPath) throw new Error('The installed Epic Verse language server was not found.');
  const workspaceFolders = workspaceFolderEntriesForProject(metadata).map(entry => ({ uri: pathToFileURL(entry.path).href, name: entry.name }));
  const firstFolder = workspaceFolders[0];
  if (!firstFolder) throw new Error('The generated project workspace has no folders.');
  const temp = copyToTemp(lspPath);
  const startedAt = performance.now();
  let probe: PersistentLspProbe | undefined;
  let shutdownClean = false;
  let error: string | undefined;
  let initialSourceDiagnostics: VerseCompilerDiagnostic[] = [];
  let initialPublication: Publication | undefined;
  let warmInvalidPublication: Publication | undefined;
  let warmCleanPublication: Publication | undefined;
  let warmInvalidError: string | undefined;
  let warmCleanError: string | undefined;
  let initializeMs = 0;
  let spawnMs = 0;
  let initialSettledMs = 0;
  try {
    const child = spawn(temp.executablePath, [], { cwd: fileUriToPath(firstFolder.uri), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    probe = new PersistentLspProbe(child);
    spawnMs = Math.round(performance.now() - startedAt);
    const initializeStartedAt = performance.now();
    const initializeResult = await probe.request('initialize', {
      processId: process.pid,
      rootPath: fileUriToPath(firstFolder.uri),
      rootUri: firstFolder.uri,
      capabilities: officialClientCapabilities(),
      trace: 'off',
      workspaceFolders,
    });
    initializeMs = Math.round(performance.now() - initializeStartedAt);
    if (!initializeResult || typeof initializeResult !== 'object') throw new Error('Verse language server did not return initialization data.');
    probe.notify('initialized', {});
    const sourceUri = pathToFileURL(sourceFile).href;
    const firstPublicationPromise = probe.waitFor(() => true, args.timeoutMs).catch(() => undefined);
    probe.notify('textDocument/didOpen', { textDocument: { uri: sourceUri, languageId: 'verse', version: 1, text: sourceText } });
    probe.notify('textDocument/didChange', { textDocument: { uri: sourceUri, version: 2 }, contentChanges: [{ text: sourceText }] });
    initialPublication = await firstPublicationPromise;
    await new Promise(resolve => setTimeout(resolve, args.settleMs));
    initialSettledMs = Math.round(performance.now() - startedAt);
    initialSourceDiagnostics = probe.latestFor(sourceUri)?.diagnostics ?? [];
    const invalidText = `${sourceText}\n\nPersistentUnknownIdentifierProbe:int = DefinitelyMissing\n`;
    const invalidStartedAt = performance.now();
    const invalidPublicationPromise = probe.waitFor(publication => uriKey(publication.uri) === uriKey(sourceUri)
      && publication.diagnostics.some(diagnostic => diagnostic.code === 3506 || /DefinitelyMissing/.test(diagnostic.message)), args.timeoutMs, false);
    probe.notify('textDocument/didChange', { textDocument: { uri: sourceUri, version: 3 }, contentChanges: [{ text: invalidText }] });
    let warmInvalidMs: number | undefined;
    try {
      warmInvalidPublication = await invalidPublicationPromise;
      warmInvalidMs = Math.round(performance.now() - invalidStartedAt);
    } catch (caught) { warmInvalidError = caught instanceof Error ? caught.message : 'Timed out waiting for invalid warm diagnostics.'; }
    const cleanStartedAt = performance.now();
    const cleanPublicationPromise = probe.waitFor(publication => uriKey(publication.uri) === uriKey(sourceUri)
      && publication.diagnostics.length === 0, args.timeoutMs, false);
    probe.notify('textDocument/didChange', { textDocument: { uri: sourceUri, version: 4 }, contentChanges: [{ text: sourceText }] });
    let warmCleanMs: number | undefined;
    try {
      warmCleanPublication = await cleanPublicationPromise;
      warmCleanMs = Math.round(performance.now() - cleanStartedAt);
    } catch (caught) { warmCleanError = caught instanceof Error ? caught.message : 'Timed out waiting for clean warm diagnostics.'; }
    shutdownClean = await probe.shutdown(Math.min(args.timeoutMs, 5000));
    const sourceHashUnchanged = cryptoHash(fs.readFileSync(sourceFile, 'utf8')) === sourceHash;
    return {
      project: metadata.projectName,
      sourceFile: '<PROJECT_ROOT>/' + path.relative(metadata.projectRoot, sourceFile).replace(/\\/g, '/'),
      diagnosticMode: 'push',
      sourceHashUnchanged,
      initial: {
        sourceDiagnostics: initialSourceDiagnostics.length,
        sourcePublicationReceived: probe.latestFor(sourceUri) !== undefined,
        ...(initialPublication ? { firstPublicationMs: initialPublication.atMs } : {}),
        settledMs: initialSettledMs,
      },
      warmInvalid: {
        expectedCode: 3506,
        sourceDiagnostics: warmInvalidPublication?.diagnostics.length ?? 0,
        matched: warmInvalidPublication?.diagnostics.some(diagnostic => diagnostic.code === 3506 || /DefinitelyMissing/.test(diagnostic.message)) ?? false,
        ...(warmInvalidMs === undefined ? {} : { editToDiagnosticMs: warmInvalidMs }),
        examples: diagnosticExamples(warmInvalidPublication?.diagnostics ?? []),
        ...(warmInvalidError ? { error: warmInvalidError } : {}),
      },
      warmClean: {
        sourceDiagnostics: warmCleanPublication?.diagnostics.length ?? 0,
        matched: warmCleanPublication?.diagnostics.length === 0,
        ...(warmCleanMs === undefined ? {} : { editToDiagnosticMs: warmCleanMs }),
        ...(warmCleanError ? { error: warmCleanError } : {}),
      },
      crossFile: metadata.sourceFiles.length > 1
        ? { available: true }
        : { available: false, reason: 'The selected project exposes one Verse source file; no second source document was available for a cross-file edit.' },
      lifecycle: {
        spawnMs,
        initializeMs,
        totalMs: Math.round(performance.now() - startedAt),
        shutdownClean,
      },
    };
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'Persistent LSP measurement failed.';
    if (probe && !shutdownClean) shutdownClean = await probe.shutdown(Math.min(args.timeoutMs, 5000));
    return {
      project: metadata.projectName,
      sourceFile: '<PROJECT_ROOT>/' + path.relative(metadata.projectRoot, sourceFile).replace(/\\/g, '/'),
      diagnosticMode: 'push',
      sourceHashUnchanged: cryptoHash(fs.readFileSync(sourceFile, 'utf8')) === sourceHash,
      initial: {
        sourceDiagnostics: initialSourceDiagnostics.length,
        sourcePublicationReceived: initialPublication !== undefined,
        ...(initialPublication ? { firstPublicationMs: initialPublication.atMs } : {}),
        settledMs: initialSettledMs || Math.round(performance.now() - startedAt),
      },
      warmInvalid: { expectedCode: 3506, sourceDiagnostics: warmInvalidPublication?.diagnostics.length ?? 0, matched: false, examples: diagnosticExamples(warmInvalidPublication?.diagnostics ?? []), ...(warmInvalidError ? { error: warmInvalidError } : {}) },
      warmClean: { sourceDiagnostics: warmCleanPublication?.diagnostics.length ?? 0, matched: false, ...(warmCleanError ? { error: warmCleanError } : {}) },
      crossFile: { available: false, reason: 'Measurement failed before cross-file availability could be assessed.' },
      lifecycle: { spawnMs, initializeMs, totalMs: Math.round(performance.now() - startedAt), shutdownClean },
      error,
    };
  } finally {
    try { fs.rmSync(temp.directory, { recursive: true, force: true }); } catch { /* exact temporary directory cleanup is best effort after process exit */ }
  }
}

function cryptoHash(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function main(argv: string[]): Promise<number> {
  let args: Arguments;
  try { args = parseArguments(argv); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Invalid arguments.'}\n`);
    return 4;
  }
  try {
    const result = await measure(args);
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      process.stdout.write(`project=${result.project} source=${result.sourceFile}\n`);
      process.stdout.write(`initial: source=${result.initial.sourceDiagnostics} publication=${result.initial.sourcePublicationReceived} first=${result.initial.firstPublicationMs ?? 'not-observed'}ms settled=${result.initial.settledMs}ms\n`);
      process.stdout.write(`warm invalid: matched=${result.warmInvalid.matched} source=${result.warmInvalid.sourceDiagnostics} edit-to-diagnostic=${result.warmInvalid.editToDiagnosticMs ?? 'not-observed'}ms\n`);
      process.stdout.write(`warm clean: matched=${result.warmClean.matched} source=${result.warmClean.sourceDiagnostics} edit-to-diagnostic=${result.warmClean.editToDiagnosticMs ?? 'not-observed'}ms\n`);
      process.stdout.write(`lifecycle: spawn=${result.lifecycle.spawnMs}ms initialize=${result.lifecycle.initializeMs}ms total=${result.lifecycle.totalMs}ms shutdown=${result.lifecycle.shutdownClean ? 'clean' : 'unclean'} source-unchanged=${result.sourceHashUnchanged}\n`);
      if (result.error) process.stdout.write(`error=${result.error}\n`);
    }
    return result.error || !result.sourceHashUnchanged || !result.warmInvalid.matched || !result.warmClean.matched || !result.lifecycle.shutdownClean ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Persistent LSP measurement failed.'}\n`);
    return 2;
  }
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; });
