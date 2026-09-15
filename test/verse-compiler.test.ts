import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { compileVerseProject, describeBackends, discoverToolchain, discoverVerseProjectMetadata, fileUriToPath, normalizeLspDiagnostics, resolveWorkflowEndpoint, runVerseLspCheck, workspaceFolderEntriesForProject, workspaceFoldersForProject } from '../src/index.ts';
import { parseCliArgs, exitCodeForStatus } from '../src/cli.ts';
import { discoverVerseCompiler } from '../src/discovery/discover.ts';
import { parseNetstatListeners, extractActiveProjectFile, extractProjectFile } from '../src/discovery/windows.ts';
import { ContentLengthDecoder, encodeContentLengthJson } from '../src/protocol/framing.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CompilerBackendCapabilities, CompilerDiscoverySystem, LoopbackListener, ToolchainInstallation, ToolchainRuntimeState, VerseProjectMetadata } from '../src/types.ts';

function fakeSystem(overrides: Partial<CompilerDiscoverySystem> = {}): CompilerDiscoverySystem {
  return {
    listUefnProcesses: async () => [{ processId: 10, projectPath: "D:/Verse Projects/Café's Game/Café's Game.uefnproject" }],
    listLoopbackListeners: async () => [{ host: '127.0.0.1', port: 31962, processId: 10 }],
    readActiveProjectFile: async () => "D:/Verse Projects/Café's Game/Café's Game.uefnproject",
    ...overrides,
  };
}

async function startMockCompiler(port: number, response: unknown, options: { notifications?: unknown[]; malformed?: string; delayMs?: number; close?: boolean } = {}): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer(socket => {
    const decoder = new ContentLengthDecoder();
    socket.on('data', chunk => {
      for (const body of decoder.push(chunk)) {
        const request = JSON.parse(body) as Record<string, unknown>;
        assert.equal(request.command, 'compileProject');
        const frames = options.malformed
          ? [Buffer.from(options.malformed, 'ascii')]
          : [...(options.notifications ?? []), response].map(encodeContentLengthJson);
        const payload = Buffer.concat(frames);
        const send = () => {
          if (options.close) {
            socket.end(payload);
            return;
          }
          socket.write(payload.subarray(0, Math.min(7, payload.length)));
          setTimeout(() => socket.write(payload.subarray(Math.min(7, payload.length))), 2);
        };
        if (options.delayMs) setTimeout(send, options.delayMs);
        else send();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, port: address.port };
}

function fixtureProject(): { root: string; descriptor: string; generatedRoot: string; content: string; source: string; lsp: string; metadata: VerseProjectMetadata } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uefn-verse-compiler-'));
  const content = path.join(root, 'Content');
  const generatedRoot = path.join(root, 'generated');
  const verseDigestDirectory = path.join(generatedRoot, 'BuiltIn', 'Verse');
  const assetsDigestDirectory = path.join(generatedRoot, 'Assets');
  fs.mkdirSync(content, { recursive: true });
  fs.mkdirSync(path.join(generatedRoot, 'vproject'), { recursive: true });
  fs.mkdirSync(verseDigestDirectory, { recursive: true });
  fs.mkdirSync(assetsDigestDirectory, { recursive: true });
  const descriptor = path.join(root, 'Fixture.uefnproject');
  const source = path.join(content, 'Main.verse');
  const lsp = path.join(root, 'verse-lsp.exe');
  fs.writeFileSync(descriptor, JSON.stringify({ title: 'Fixture' }));
  fs.writeFileSync(path.join(root, 'Fixture.code-workspace'), JSON.stringify({ folders: [
    { name: 'Fixture source', path: content },
    { name: 'Fixture assets', path: assetsDigestDirectory },
    { name: 'Fixture vproject', path: path.join(generatedRoot, 'vproject') },
    { name: 'Fixture built-ins', path: path.join(generatedRoot, 'BuiltIn') },
  ] }));
  fs.writeFileSync(source, 'module Fixture\n');
  fs.writeFileSync(lsp, 'synthetic test executable placeholder');
  fs.writeFileSync(path.join(verseDigestDirectory, 'Verse.digest.verse'), '# synthetic digest placeholder\n');
  fs.writeFileSync(path.join(generatedRoot, 'vproject', 'Fixture.vproject'), JSON.stringify({ packages: [
    { desc: { name: 'Fixture', dirPath: content, settings: { role: 'Source' } }, readOnly: false },
    { desc: { name: 'Verse', dirPath: verseDigestDirectory, settings: { role: 'External' } }, readOnly: true },
  ] }));
  const metadata = discoverVerseProjectMetadata(descriptor, { savedVerseProjectRoot: generatedRoot });
  assert.equal(metadata.metadataAvailable, true);
  return { root, descriptor, generatedRoot, content, source, lsp, metadata };
}

class FakeLspProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  killed = false;
  private readonly decoder = new ContentLengthDecoder();
  private lastUri: string | undefined;
  initializeParams?: Record<string, unknown>;
  readonly requests: string[] = [];

  constructor(private readonly publishError: boolean, private readonly respondToInitialize = true) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        try {
          for (const body of this.decoder.push(Buffer.from(chunk))) this.handle(JSON.parse(body) as Record<string, unknown>);
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error('fake LSP request failed'));
        }
      },
    });
  }

  kill(): boolean {
    this.killed = true;
    this.emit('exit', 0, null);
    return true;
  }

  private send(value: unknown): void {
    this.stdout.write(encodeContentLengthJson(value));
  }

  private handle(request: Record<string, unknown>): void {
    if (typeof request.method === 'string') this.requests.push(request.method);
    if (request.method === 'initialize') {
      if (!this.respondToInitialize) return;
      this.initializeParams = request.params as Record<string, unknown>;
      this.send({ jsonrpc: '2.0', id: request.id, result: { capabilities: { textDocumentSync: 2 } } });
      this.send({ jsonrpc: '2.0', id: 'register-1', method: 'client/registerCapability', params: { registrations: [] } });
      return;
    }
    if (request.method === 'shutdown') {
      this.send({ jsonrpc: '2.0', id: request.id, result: null });
      return;
    }
    if (request.method === 'exit') {
      this.emit('exit', 0, null);
      return;
    }
    if (request.method === 'workspace/diagnostic') {
      this.send({ jsonrpc: '2.0', id: request.id, result: {
        items: this.lastUri ? [{ uri: this.lastUri, kind: 'full', items: this.publishError ? [{
          severity: 1,
          message: 'Synthetic unknown identifier',
          source: 'synthetic-lsp',
          code: 'S001',
          range: { start: { line: 2, character: 1 }, end: { line: 2, character: 8 } },
        }] : [] }] : [],
      } });
      return;
    }
    if (request.method !== 'textDocument/didChange') return;
    const params = request.params as { textDocument?: { uri?: unknown } } | undefined;
    const uri = typeof params?.textDocument?.uri === 'string' ? params.textDocument.uri : undefined;
    if (!uri) return;
    this.lastUri = uri;
    this.send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri,
        diagnostics: this.publishError ? [{
          severity: 1,
          message: 'Synthetic unknown identifier',
          source: 'synthetic-lsp',
          code: 'S001',
          range: { start: { line: 2, character: 1 }, end: { line: 2, character: 8 } },
        }] : [],
      },
    });
  }
}

const syntheticCapabilities: CompilerBackendCapabilities = {
  semanticAnalysis: 'yes',
  authoritativeCompilation: 'no',
  requiresUefnProcess: 'no',
  requiresUefnGui: 'no',
  requiresGeneratedProjectMetadata: 'yes',
  supportsIncremental: 'unknown',
  returnsDiagnostics: 'yes',
  producesArtifacts: 'no',
};

const syntheticInstallation: ToolchainInstallation = {
  verseLanguageServerPath: 'C:/Epic/verse-lsp.exe',
  verseLanguageServerVersion: 'test',
  workflowServerModuleRegistered: false,
  verseCompilerModuleRegistered: false,
  dedicatedCommandletExecutableAvailable: false,
};

const syntheticRuntime: ToolchainRuntimeState = {
  uefnRunning: false,
  uefnProcessIds: [],
  vsCodeRunning: false,
  verseLanguageServerRunning: false,
};

test('rejects non-loopback and malformed endpoint overrides', () => {
  assert.throws(() => resolveWorkflowEndpoint({ UEFN_VERSE_COMPILER_ENDPOINT: '192.168.1.9:1962' }), /local loopback/);
  assert.throws(() => resolveWorkflowEndpoint({ UEFN_VERSE_COMPILER_ENDPOINT: '127.0.0.1' }), /host:port/);
  assert.throws(() => resolveWorkflowEndpoint({ UEFN_VERSE_WORKFLOW_HOST: '127.0.0.1', UEFN_VERSE_WORKFLOW_PORT: '70000' }), /valid TCP port/);
});

test('parses only loopback listeners and extracts project paths as data', () => {
  const listeners = parseNetstatListeners([
    '  TCP    127.0.0.1:1962     0.0.0.0:0      LISTENING       10',
    '  TCP    [::1]:31962        [::]:0         LISTENING       10',
    '  TCP    0.0.0.0:1963       0.0.0.0:0      LISTENING       10',
    '  TCP    192.168.1.10:1964  0.0.0.0:0      LISTENING       10',
  ].join('\n'));
  assert.deepEqual(listeners, [
    { host: '127.0.0.1', port: 1962, processId: 10 },
    { host: '::1', port: 31962, processId: 10 },
  ]);
  const project = "D:\\Projects\\My Project\\Café's; & Data.uefnproject";
  assert.equal(extractProjectFile("-project=\"" + project + "\""), project);
  assert.equal(extractActiveProjectFile("Successfully opened project 'D:/Projects/Café's Game/Café's Game.uefnproject'"), "D:/Projects/Café's Game/Café's Game.uefnproject");
});

test('cleanly selects a matching project and rejects ambiguous instances', async () => {
  const result = await discoverVerseCompiler({
    projectPath: "d:\\VERSE PROJECTS\\CAFÉ'S GAME\\CAFÉ'S GAME.UEFNPROJECT",
    system: fakeSystem(),
    now: () => new Date('2026-08-18T00:00:00.000Z'),
  });
  assert.equal(result.sessions[0]?.port, 31962);
  assert.equal(result.sessions[0]?.projectPath, "D:/Verse Projects/Café's Game/Café's Game.uefnproject");

  const ambiguous = await discoverVerseCompiler({
    system: fakeSystem({ listUefnProcesses: async () => [{ processId: 10 }, { processId: 11 }], listLoopbackListeners: async () => [] }),
  });
  assert.equal(ambiguous.status, 'multiple-sessions-ambiguous');
  assert.equal(ambiguous.sessions.length, 0);
});

test('uses the historical fallback only after listener enumeration is empty', async () => {
  const result = await discoverVerseCompiler({ system: fakeSystem({ listLoopbackListeners: async () => [] }) });
  assert.equal(result.sessions[0]?.source, 'compatibility-port');
  assert.equal(result.sessions[0]?.port, 1962);
});

test('compiles on an alternate loopback port, retains notifications, and normalizes warnings', async t => {
  const mock = await startMockCompiler(0, { type: 2, command: 'compileProject', result: { numErrors: 0, numWarnings: 1, messages: [{ severity: 'warning', message: 'A warning', file: 'Main.verse', line: 4, column: 2 }] } }, { notifications: [{ type: 3, method: 'compileProgress', params: { state: 'started' } }] });
  t.after(() => mock.server.close());
  const result = await compileVerseProject({ endpoint: { host: '127.0.0.1', port: mock.port } });
  assert.equal(result.success, true);
  assert.equal(result.numErrors, 0);
  assert.equal(result.numWarnings, 1);
  assert.equal(result.notifications?.length, 1);
  assert.deepEqual(result.diagnostics?.[0], { severity: 'warning', message: 'A warning', file: 'Main.verse', line: 4, column: 2 });
});

test('uses authoritative errors and preserves useful diagnostic locations', async t => {
  const mock = await startMockCompiler(0, { type: 2, command: 'compileProject', result: { numErrors: 2, numWarnings: 0, messages: [{ severity: 'error', message: 'Expected expression', path: 'Source/Main.verse', line: 12, column: 8, code: 'V001' }] } });
  t.after(() => mock.server.close());
  const result = await compileVerseProject({ endpoint: { host: '127.0.0.1', port: mock.port } });
  assert.equal(result.status, 'compiled');
  assert.equal(result.success, false);
  assert.equal(result.numErrors, 2);
  assert.equal(result.diagnostics?.[0]?.line, 12);
  assert.equal(result.diagnostics?.[0]?.column, 8);
});

test('uses diagnostic notifications when the final messages array is empty', async t => {
  const mock = await startMockCompiler(0, { type: 2, command: 'compileProject', result: { numErrors: 1, numWarnings: 0, messages: [] } }, {
    notifications: [{ type: 0, command: 'diagnostic', params: { messages: [{ severity: 'error', message: 'Bad Verse', file: 'Main.verse', line: 7, column: 3 }] } }],
  });
  t.after(() => mock.server.close());
  const result = await compileVerseProject({ endpoint: { host: '127.0.0.1', port: mock.port } });
  assert.equal(result.success, false);
  assert.equal(result.diagnostics?.[0]?.line, 7);
  assert.equal(result.diagnostics?.[0]?.column, 3);
});

test('reports malformed protocol frames and bounded timeouts without throwing', async t => {
  const malformed = await startMockCompiler(0, {}, { malformed: 'Content-Length: 4\r\n\r\nnope' });
  t.after(() => malformed.server.close());
  const malformedResult = await compileVerseProject({ endpoint: { host: '127.0.0.1', port: malformed.port } });
  assert.equal(malformedResult.status, 'compile-request-failed');
  assert.match(malformedResult.error ?? '', /invalid JSON/i);

  const timeout = await startMockCompiler(0, {}, { delayMs: 1000 });
  t.after(() => timeout.server.close());
  const timeoutResult = await compileVerseProject({ endpoint: { host: '127.0.0.1', port: timeout.port }, timeoutMs: 250 });
  assert.equal(timeoutResult.status, 'compile-request-failed');
  assert.match(timeoutResult.error ?? '', /timed out/i);
});

test('re-discovers after a stale session connection', async t => {
  const live = await startMockCompiler(0, { type: 2, command: 'compileProject', result: { numErrors: 0, numWarnings: 0, messages: [] } });
  t.after(() => live.server.close());
  let discoveryCount = 0;
  const system: CompilerDiscoverySystem = fakeSystem({
    listLoopbackListeners: async (): Promise<LoopbackListener[]> => {
      discoveryCount += 1;
      return [{ host: '127.0.0.1', port: discoveryCount === 1 ? 1 : live.port, processId: 10 }];
    },
  });
  const result = await compileVerseProject({ projectPath: "D:/Verse Projects/Café's Game/Café's Game.uefnproject", system, timeoutMs: 250 });
  assert.equal(result.success, true);
  assert.ok(discoveryCount >= 2);
});

test('historical port 1962 remains a tested compatibility endpoint when available', async t => {
  let mock: { server: net.Server; port: number };
  try {
    mock = await startMockCompiler(1962, { type: 2, command: 'compileProject', result: { numErrors: 0, numWarnings: 0, messages: [] } });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      t.skip('Port 1962 is already owned by a local process.');
      return;
    }
    throw error;
  }
  t.after(() => mock.server.close());
  const result = await compileVerseProject({ endpoint: { host: '127.0.0.1', port: 1962 } });
  assert.equal(result.success, true);
});

test('CLI argument and exit-code contracts are deterministic', () => {
  assert.deepEqual(parseCliArgs(['compile', '--project', 'D:/Project.uefnproject', '--process-id', '42', '--json']), {
    command: 'compile', projectPath: 'D:/Project.uefnproject', preferredProcessId: 42, timeoutMs: undefined, lspPath: undefined, diagnosticMode: undefined, includePaths: false, json: true, debug: false,
  });
  assert.deepEqual(parseCliArgs(['check', '--project', 'D:/Project.uefnproject', '--lsp-path', 'D:/verse-lsp.exe', '--include-paths']), {
    command: 'check', projectPath: 'D:/Project.uefnproject', preferredProcessId: undefined, timeoutMs: undefined, lspPath: 'D:/verse-lsp.exe', diagnosticMode: undefined, includePaths: true, json: false, debug: false,
  });
  assert.equal(parseCliArgs(['check', '--project', 'D:/Project.uefnproject', '--diagnostic-mode', 'workspace']).diagnosticMode, 'workspace');
  assert.throws(() => parseCliArgs(['compile', '--diagnostic-mode', 'push']), /only valid with check/);
  assert.throws(() => parseCliArgs(['compile', '--process-id', '0']), /positive integer/);
  assert.throws(() => parseCliArgs(['check', '--project']), /requires a value/);
  assert.equal(exitCodeForStatus('compiled', true), 0);
  assert.equal(exitCodeForStatus('compiled', false), 1);
  assert.equal(exitCodeForStatus('uefn-not-running', false), 2);
  assert.equal(exitCodeForStatus('multiple-sessions-ambiguous', false), 3);
  assert.equal(exitCodeForStatus('checked-with-errors', false), 1);
  assert.equal(exitCodeForStatus('metadata-unavailable', false), 2);
  assert.equal(exitCodeForStatus('metadata-invalid', false), 2);
  assert.equal(exitCodeForStatus('compile-request-failed', false), 5);
});

test('normalizes Epic LSP URI, severity, range, and code fields', () => {
  const uri = 'file:///C%3A/Verse%20Projects/Main.verse';
  assert.equal(fileUriToPath(uri), path.normalize('C:/Verse Projects/Main.verse'));
  assert.deepEqual(normalizeLspDiagnostics(uri, [{
    severity: 1,
    message: 'Expected expression',
    code: 3506,
    source: 'uLang',
    range: { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } },
  }]), [{
    severity: 'error',
    message: 'Expected expression',
    source: 'uLang',
    file: path.normalize('C:/Verse Projects/Main.verse'),
    line: 1,
    column: 2,
    endLine: 1,
    endColumn: 5,
    code: 3506,
  }]);
});

test('discovers synthetic project metadata, digests, and timestamp freshness', t => {
  const fixture = fixtureProject();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  assert.equal(fixture.metadata.vprojectPath, path.join(fixture.generatedRoot, 'vproject', 'Fixture.vproject'));
  assert.equal(fixture.metadata.sourceFiles.length, 1);
  assert.equal(fixture.metadata.packages.length, 2);
  assert.equal(fixture.metadata.packages[1]?.digestFiles.length, 1);
  assert.equal(fixture.metadata.metadataFreshness, 'fresh-by-mtime');
  assert.equal(workspaceFoldersForProject(fixture.metadata).length, 4);
  assert.deepEqual(workspaceFolderEntriesForProject(fixture.metadata).map(entry => entry.name), [
    'Fixture source',
    'Fixture assets',
    'Fixture vproject',
    'Fixture built-ins',
  ]);
});

test('reports explicit backend capabilities without inventing a headless compiler', () => {
  const backends = describeBackends(syntheticInstallation, syntheticRuntime, false);
  assert.deepEqual(backends.map(backend => backend.id), ['epic-verse-lsp', 'workflow']);
  assert.deepEqual(backends.find(backend => backend.id === 'epic-verse-lsp')?.capabilities, syntheticCapabilities);
  assert.equal(backends.find(backend => backend.id === 'epic-verse-lsp')?.capabilities.authoritativeCompilation, 'no');
  assert.equal(backends.find(backend => backend.id === 'workflow')?.capabilities.authoritativeCompilation, 'yes');
  assert.equal(backends.some(backend => backend.id === 'headless'), false);
});

test('discovers injected UEFN, LSP, module, and Workflow evidence without touching the host', async t => {
  const fixture = fixtureProject();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const uefnRoot = path.join(fixture.root, 'Epic');
  const binaryDirectory = path.join(uefnRoot, 'FortniteGame', 'Binaries', 'Win64');
  fs.mkdirSync(binaryDirectory, { recursive: true });
  const executable = path.join(binaryDirectory, 'UnrealEditorFortnite-Win64-Shipping.exe');
  fs.writeFileSync(executable, 'synthetic executable placeholder');
  fs.writeFileSync(path.join(binaryDirectory, 'UnrealEditorFortnite-Win64-Shipping.version'), JSON.stringify({ MajorVersion: 6, MinorVersion: 0, PatchVersion: 0, Changelist: 123, BuildId: '122' }));
  fs.writeFileSync(path.join(binaryDirectory, 'UnrealEditorFortnite-Win64-Shipping.modules'), JSON.stringify({ Modules: { VerseCompiler: {}, VerseWorkflowServer: {} } }));
  const compilerSystem = fakeSystem({
    listUefnProcesses: async () => [{ processId: 10, projectPath: fixture.descriptor }],
    readActiveProjectFile: async () => fixture.descriptor,
  });
  const snapshot = await discoverToolchain({
    projectPath: fixture.descriptor,
    environment: { ...process.env, UEFN_VERSE_LSP_PATH: fixture.lsp },
    system: { listProcesses: async () => [
      { processId: 10, name: 'UnrealEditorFortnite-Win64-Shipping.exe', executablePath: executable },
      { processId: 11, name: 'Code.exe', executablePath: 'C:/Code.exe' },
    ] },
    compilerSystem,
  });
  assert.equal(snapshot.installation.uefnRoot, uefnRoot);
  assert.equal(snapshot.installation.uefnVersion, '6.0.0 (CL 123)');
  assert.equal(snapshot.installation.workflowServerModuleRegistered, true);
  assert.equal(snapshot.installation.verseCompilerModuleRegistered, true);
  assert.equal(snapshot.runtime.vsCodeRunning, true);
  assert.equal(snapshot.backends.find(backend => backend.id === 'epic-verse-lsp')?.available, true);
  assert.equal(snapshot.backends.find(backend => backend.id === 'workflow')?.available, true);
});

test('runs a synthetic stdio LSP through initialization, registration, didChange, diagnostics, and shutdown', async t => {
  const fixture = fixtureProject();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const child = new FakeLspProcess(true);
  const result = await runVerseLspCheck(fixture.metadata, fixture.lsp, {
    settleMs: 10,
    timeoutMs: 2000,
    spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
  });
  assert.equal(result.connected, true);
  assert.equal(result.filesChecked, 1);
  assert.equal(result.sourceDiagnostics.length, 1);
  assert.equal(result.sourceDiagnostics[0]?.line, 3);
  assert.equal(result.sourceDiagnostics[0]?.column, 2);
  assert.equal(result.sourceDiagnostics[0]?.endColumn, 9);
  assert.equal(result.shutdownClean, true);
  assert.equal(child.killed, false);
  assert.deepEqual(child.initializeParams?.workspaceFolders, [
    { uri: pathToFileURL(fixture.content).href, name: 'Fixture source' },
    { uri: pathToFileURL(path.join(fixture.generatedRoot, 'Assets')).href, name: 'Fixture assets' },
    { uri: pathToFileURL(path.join(fixture.generatedRoot, 'vproject')).href, name: 'Fixture vproject' },
    { uri: pathToFileURL(path.join(fixture.generatedRoot, 'BuiltIn')).href, name: 'Fixture built-ins' },
  ]);
  assert.equal(child.initializeParams?.rootPath, fixture.content);
  assert.equal(child.initializeParams?.rootUri, pathToFileURL(fixture.content).href);
  assert.equal(child.requests.includes('workspace/diagnostic'), false);
  assert.equal(result.timing.initializeMs !== undefined, true);
  assert.equal(result.timing.startupMs !== undefined, true);
  assert.equal(result.timing.analysisSettledMs !== undefined, true);
  assert.equal(result.timing.shutdownMs !== undefined, true);
});

test('supports explicit workspace diagnostics without making them the default push contract', async t => {
  const fixture = fixtureProject();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const child = new FakeLspProcess(true);
  const result = await runVerseLspCheck(fixture.metadata, fixture.lsp, {
    diagnosticMode: 'workspace',
    settleMs: 10,
    timeoutMs: 2000,
    spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
  });
  assert.equal(result.protocol.workspaceDiagnosticRequested, true);
  assert.equal(result.protocol.workspaceDiagnosticCompleted, true);
  assert.equal(result.timing.workspaceDiagnosticMs !== undefined, true);
  assert.equal(child.requests.includes('workspace/diagnostic'), true);
  assert.equal(result.shutdownClean, true);
});

test('reports unsupported pull diagnostics while preserving clean shutdown', async t => {
  const fixture = fixtureProject();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const child = new FakeLspProcess(false);
  const result = await runVerseLspCheck(fixture.metadata, fixture.lsp, {
    diagnosticMode: 'pull',
    settleMs: 10,
    timeoutMs: 2000,
    spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
  });
  assert.equal(result.protocol.textDocumentDiagnosticAdvertised, false);
  assert.match(result.error ?? '', /did not advertise/i);
  assert.equal(result.shutdownClean, true);
  assert.equal(child.killed, false);
  assert.equal(child.requests.includes('textDocument/diagnostic'), false);
});

test('returns a bounded failure when the LSP never initializes', async t => {
  const fixture = fixtureProject();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const child = new FakeLspProcess(false, false);
  const result = await runVerseLspCheck(fixture.metadata, fixture.lsp, {
    timeoutMs: 1000,
    spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
  });
  assert.equal(result.connected, false);
  assert.match(result.error ?? '', /timed out/i);
  assert.equal(child.killed, true);
});
