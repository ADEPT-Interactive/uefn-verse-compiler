import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { compileVerseProject, resolveWorkflowEndpoint } from '../src/index.ts';
import { parseCliArgs, exitCodeForStatus } from '../src/cli.ts';
import { discoverVerseCompiler } from '../src/discovery/discover.ts';
import { parseNetstatListeners, extractActiveProjectFile, extractProjectFile } from '../src/discovery/windows.ts';
import { ContentLengthDecoder, encodeContentLengthJson } from '../src/protocol/framing.ts';
import type { CompilerDiscoverySystem, LoopbackListener } from '../src/types.ts';

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
    command: 'compile', projectPath: 'D:/Project.uefnproject', preferredProcessId: 42, timeoutMs: undefined, json: true, debug: false,
  });
  assert.throws(() => parseCliArgs(['compile', '--process-id', '0']), /positive integer/);
  assert.equal(exitCodeForStatus('compiled', true), 0);
  assert.equal(exitCodeForStatus('compiled', false), 1);
  assert.equal(exitCodeForStatus('uefn-not-running', false), 2);
  assert.equal(exitCodeForStatus('multiple-sessions-ambiguous', false), 3);
  assert.equal(exitCodeForStatus('compile-request-failed', false), 5);
});
