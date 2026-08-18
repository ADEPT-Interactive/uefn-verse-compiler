import net from 'node:net';
import { discoverVerseCompiler } from '../discovery/discover.js';
import { hasEndpointOverride, resolveWorkflowEndpoint, validateWorkflowEndpoint } from '../discovery/endpoint.js';
import { findMessages, findNumber, normalizeDiagnostics } from '../diagnostics/normalize.js';
import { ContentLengthDecoder, encodeContentLengthJson } from '../protocol/framing.js';
import type { CompileVerseOptions, VerseCompilerSession, VerseCompilerStatusResult, WorkflowCompileResult } from '../types.js';

interface TransportResult extends WorkflowCompileResult {
  protocolFailure?: boolean;
}

function requestCompile(session: VerseCompilerSession, timeoutMs: number): Promise<TransportResult> {
  return new Promise(resolve => {
    const client = new net.Socket();
    const decoder = new ContentLengthDecoder();
    const notifications: unknown[] = [];
    let connected = false;
    let finished = false;
    const finish = (result: TransportResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      client.destroy();
      resolve({ ...result, session });
    };
    const timeout = setTimeout(() => finish({ success: false, connected, status: 'compile-request-failed', error: 'Verse Workflow Server timed out before returning a final compileProject response.' }), timeoutMs);
    client.connect(session.port, session.host, () => {
      connected = true;
      client.write(encodeContentLengthJson({ seq: 1, type: 1, command: 'compileProject', params: {} }));
    });
    client.on('data', chunk => {
      try {
        for (const body of decoder.push(chunk)) {
          let response: Record<string, unknown>;
          try {
            response = JSON.parse(body) as Record<string, unknown>;
          } catch {
            finish({ success: false, connected: true, status: 'compile-request-failed', protocolFailure: true, notifications, error: 'Workflow response contained invalid JSON.' });
            return;
          }
          if (response.type !== 2 || response.command !== 'compileProject') {
            notifications.push(response);
            continue;
          }
          const numErrors = findNumber(response, 'numErrors');
          const numWarnings = findNumber(response, 'numWarnings');
          const finalMessages = findMessages(response);
          const messages = finalMessages && finalMessages.length > 0 ? finalMessages : (notifications.length > 0 ? notifications : finalMessages);
          const diagnostics = normalizeDiagnostics(messages);
          if (numErrors === undefined) {
            finish({ success: false, connected: true, status: 'compile-request-failed', protocolFailure: true, numWarnings, messages, notifications, diagnostics, error: 'Final compile response did not include numErrors; success cannot be verified.' });
            return;
          }
          finish({
            success: numErrors === 0,
            connected: true,
            status: 'compiled',
            numErrors,
            numWarnings,
            messages,
            notifications,
            diagnostics,
            error: numErrors > 0 ? `Verse compilation failed with ${numErrors} error(s).` : undefined,
          });
          return;
        }
      } catch (error) {
        finish({ success: false, connected: true, status: 'compile-request-failed', protocolFailure: true, notifications, error: error instanceof Error ? error.message : 'Workflow response framing failed.' });
      }
    });
    client.on('error', error => finish({ success: false, connected, status: 'compile-request-failed', error: `Could not connect to the Verse Workflow Server at ${session.host}:${session.port}: ${error.message}` }));
    client.on('close', () => {
      if (!finished) finish({ success: false, connected, status: 'compile-request-failed', notifications, error: 'Workflow Server closed before returning a final compile result.' });
    });
  });
}

/** Return discovery state without pretending that a TCP listener is a successful compile. */
export async function getVerseCompilerStatus(options: CompileVerseOptions = {}): Promise<VerseCompilerStatusResult> {
  const discovery = await discoverVerseCompiler(options);
  return {
    status: discovery.sessions.length > 0 ? 'compiler-discovered' : discovery.status,
    available: discovery.sessions.length > 0,
    sessions: discovery.sessions,
    activeProjectPath: discovery.activeProjectPath,
    processes: discovery.processes,
    error: discovery.error,
  };
}

/** Compile through the live UEFN Workflow Server; static syntax checks are not substituted. */
export async function compileVerseProject(options: CompileVerseOptions = {}): Promise<WorkflowCompileResult> {
  const timeoutMs = Math.max(250, options.timeoutMs ?? 15000);
  let explicitEndpoint = options.endpoint;
  if (explicitEndpoint) {
    try {
      explicitEndpoint = validateWorkflowEndpoint(explicitEndpoint);
    } catch (error) {
      return { success: false, connected: false, status: 'compile-request-failed', error: error instanceof Error ? error.message : 'Verse compiler endpoint override is invalid.' };
    }
  } else if (hasEndpointOverride(options.environment ?? process.env)) {
    try {
      explicitEndpoint = resolveWorkflowEndpoint(options.environment ?? process.env);
    } catch (error) {
      return { success: false, connected: false, status: 'compile-request-failed', error: error instanceof Error ? error.message : 'Verse compiler endpoint override is invalid.' };
    }
  }

  let discovery = explicitEndpoint
    ? {
      status: 'compiler-not-initialized' as const,
      sessions: [{ host: explicitEndpoint.host, port: explicitEndpoint.port, projectPath: options.projectPath, source: 'override' as const, transport: 'tcp-content-length-json' as const, discoveredAt: (options.now ?? (() => new Date()))().toISOString() }],
      processes: [],
    }
    : await discoverVerseCompiler(options);
  if (discovery.sessions.length === 0) return { success: false, connected: false, status: discovery.status, error: discovery.error ?? `Verse compiler unavailable: ${discovery.status}.` };

  let lastResult: WorkflowCompileResult | undefined;
  for (let attempt = 0; attempt < (explicitEndpoint ? 1 : 2); attempt += 1) {
    for (const session of discovery.sessions.slice(0, 8)) {
      const result = await requestCompile(session, timeoutMs);
      lastResult = result;
      if (result.status !== 'compile-request-failed') return result;
    }
    if (explicitEndpoint) break;
    discovery = await discoverVerseCompiler(options);
    if (discovery.sessions.length === 0) return lastResult ?? { success: false, connected: false, status: discovery.status, error: discovery.error };
  }
  return lastResult ?? { success: false, connected: false, status: 'compile-request-failed', error: 'No Verse compiler session could be contacted.' };
}
