import { pathToFileURL } from 'node:url';
import { compileVerseProject, discoverVerseCompiler, getVerseCompilerStatus } from './index.js';
import type { VerseCompilerDiagnostic, WorkflowCompileResult } from './types.js';

export interface CliOptions {
  command: 'discover' | 'status' | 'compile';
  projectPath?: string;
  preferredProcessId?: number;
  timeoutMs?: number;
  json: boolean;
  debug: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const command = (argv[0] || 'status') as CliOptions['command'];
  if (!['discover', 'status', 'compile'].includes(command)) throw new Error('Usage: uefn-verse-compiler [discover|status|compile] [--project <path>] [--process-id <pid>] [--timeout-ms <ms>] [--json] [--debug].');
  let projectPath: string | undefined;
  let preferredProcessId: number | undefined;
  let timeoutMs: number | undefined;
  let json = false;
  let debug = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') json = true;
    else if (argument === '--debug') debug = true;
    else if (argument === '--project' && argv[index + 1]) projectPath = argv[++index];
    else if (argument === '--process-id' && argv[index + 1]) preferredProcessId = Number(argv[++index]);
    else if (argument === '--timeout-ms' && argv[index + 1]) timeoutMs = Number(argv[++index]);
    else if (argument === '--help' || argument === '-h') throw new Error('Usage: uefn-verse-compiler [discover|status|compile] [--project <path>] [--process-id <pid>] [--timeout-ms <ms>] [--json] [--debug].');
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (preferredProcessId !== undefined && (!Number.isInteger(preferredProcessId) || preferredProcessId < 1)) throw new Error('--process-id must be a positive integer.');
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 120000)) throw new Error('--timeout-ms must be an integer between 250 and 120000.');
  return { command, projectPath, preferredProcessId, timeoutMs, json, debug };
}

export const EXIT_CODES = {
  success: 0,
  compilationErrors: 1,
  compilerUnavailable: 2,
  ambiguousSession: 3,
  invalidArguments: 4,
  clientError: 5,
} as const;

function diagnosticLocation(diagnostic: VerseCompilerDiagnostic): string {
  if (!diagnostic.file) return '';
  return ` ${diagnostic.file}${diagnostic.line === undefined ? '' : `:${diagnostic.line}${diagnostic.column === undefined ? '' : `:${diagnostic.column}`}`}`;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (/token|cookie|authorization|password|secret|credential|sessionid/i.test(key)) sanitized[key] = '[redacted]';
    else sanitized[key] = sanitizeValue(child);
  }
  return sanitized;
}

function compileJson(result: WorkflowCompileResult, debug: boolean): Record<string, unknown> {
  const diagnostics = result.diagnostics ?? [];
  const output: Record<string, unknown> = {
    schemaVersion: 1,
    status: result.status ?? 'compile-request-failed',
    success: result.success,
    connected: result.connected,
    numErrors: result.numErrors ?? 0,
    numWarnings: result.numWarnings ?? 0,
    errors: diagnostics.filter(diagnostic => diagnostic.severity === 'error'),
    warnings: diagnostics.filter(diagnostic => diagnostic.severity === 'warning'),
    diagnostics,
    session: result.session,
  };
  if (result.error) output.error = result.error;
  if (debug) {
    output.messages = sanitizeValue(result.messages ?? []);
    output.notifications = sanitizeValue(result.notifications ?? []);
  }
  return output;
}

function discoveryJson(result: Awaited<ReturnType<typeof discoverVerseCompiler>> | Awaited<ReturnType<typeof getVerseCompilerStatus>>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    status: result.status,
    available: 'available' in result ? result.available : result.sessions.length > 0,
    activeProjectPath: result.activeProjectPath,
    processes: result.processes,
    sessions: result.sessions,
    ...(result.error ? { error: result.error } : {}),
  };
}

function printCompile(result: WorkflowCompileResult): void {
  process.stdout.write(`${result.status ?? 'unknown'}: ${result.success ? 'success' : result.error ?? 'failed'}\n`);
  process.stdout.write(`errors=${result.numErrors ?? 0} warnings=${result.numWarnings ?? 0}\n`);
  for (const diagnostic of result.diagnostics ?? []) process.stdout.write(`${diagnostic.severity ?? 'message'}:${diagnosticLocation(diagnostic)} ${diagnostic.message}\n`);
}

function printDiscovery(result: Awaited<ReturnType<typeof discoverVerseCompiler>> | Awaited<ReturnType<typeof getVerseCompilerStatus>>): void {
  process.stdout.write(`${result.status}\n`);
  if (result.activeProjectPath) process.stdout.write(`project=${result.activeProjectPath}\n`);
  for (const session of result.sessions) process.stdout.write(`candidate=${session.host}:${session.port} pid=${session.processId ?? 'unknown'} source=${session.source}\n`);
  if (result.error) process.stdout.write(`${result.error}\n`);
}

export function exitCodeForStatus(status: string | undefined, success: boolean): number {
  if (success) return EXIT_CODES.success;
  if (status === 'compiled') return EXIT_CODES.compilationErrors;
  if (status === 'multiple-sessions-ambiguous') return EXIT_CODES.ambiguousSession;
  if (status === 'uefn-not-running' || status === 'project-not-loaded' || status === 'compiler-not-initialized' || status === 'project-mismatch') return EXIT_CODES.compilerUnavailable;
  return EXIT_CODES.clientError;
}

export async function runCli(argv: string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Invalid arguments.'}\n`);
    return EXIT_CODES.invalidArguments;
  }
  try {
    if (options.command === 'compile') {
      const result = await compileVerseProject({ projectPath: options.projectPath, preferredProcessId: options.preferredProcessId, timeoutMs: options.timeoutMs });
      if (options.json) process.stdout.write(`${JSON.stringify(compileJson(result, options.debug), null, 2)}\n`);
      else printCompile(result);
      return exitCodeForStatus(result.status, result.success);
    }
    const result = options.command === 'status'
      ? await getVerseCompilerStatus({ projectPath: options.projectPath, preferredProcessId: options.preferredProcessId })
      : await discoverVerseCompiler({ projectPath: options.projectPath, preferredProcessId: options.preferredProcessId });
    if (options.json) process.stdout.write(`${JSON.stringify(discoveryJson(result), null, 2)}\n`);
    else printDiscovery(result);
    return result.sessions.length > 0 ? EXIT_CODES.success : exitCodeForStatus(result.status, false);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Compiler client error.'}\n`);
    return EXIT_CODES.clientError;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
