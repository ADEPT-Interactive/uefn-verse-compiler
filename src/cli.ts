import { pathToFileURL } from 'node:url';
import { checkVerseProject, compileVerseProject, discoverToolchain, discoverVerseCompiler, discoverVerseProjectMetadata, getVerseCompilerStatus } from './index.js';
import type { LspDiagnosticMode, SemanticCheckResult, ToolchainSnapshot, VerseCompilerDiagnostic, WorkflowCompileResult } from './types.js';

const USAGE = 'Usage: uefn-verse-compiler [discover|status|compile|check|doctor|backends] [--project <path>] [--process-id <pid>] [--timeout-ms <ms>] [--lsp-path <path>] [--diagnostic-mode <push|workspace|pull|both>] [--include-paths] [--json] [--debug].';

export interface CliOptions {
  command: 'discover' | 'status' | 'compile' | 'check' | 'doctor' | 'backends';
  projectPath?: string;
  preferredProcessId?: number;
  timeoutMs?: number;
  lspPath?: string;
  diagnosticMode?: LspDiagnosticMode;
  includePaths: boolean;
  json: boolean;
  debug: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const command = (argv[0] || 'status') as CliOptions['command'];
  if (!['discover', 'status', 'compile', 'check', 'doctor', 'backends'].includes(command)) throw new Error(USAGE);
  let projectPath: string | undefined;
  let preferredProcessId: number | undefined;
  let timeoutMs: number | undefined;
  let lspPath: string | undefined;
  let diagnosticMode: LspDiagnosticMode | undefined;
  let includePaths = false;
  let json = false;
  let debug = false;
  const valueFor = (index: number, name: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.\n${USAGE}`);
    return value;
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') json = true;
    else if (argument === '--debug') debug = true;
    else if (argument === '--include-paths') includePaths = true;
    else if (argument === '--project') projectPath = valueFor(index++, '--project');
    else if (argument === '--process-id') preferredProcessId = Number(valueFor(index++, '--process-id'));
    else if (argument === '--timeout-ms') timeoutMs = Number(valueFor(index++, '--timeout-ms'));
    else if (argument === '--lsp-path') lspPath = valueFor(index++, '--lsp-path');
    else if (argument === '--diagnostic-mode') {
      const value = valueFor(index++, '--diagnostic-mode') as LspDiagnosticMode;
      if (value !== 'push' && value !== 'workspace' && value !== 'pull' && value !== 'both') throw new Error('--diagnostic-mode must be push, workspace, pull, or both.');
      diagnosticMode = value;
    }
    else if (argument === '--help' || argument === '-h') throw new Error(USAGE);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (preferredProcessId !== undefined && (!Number.isInteger(preferredProcessId) || preferredProcessId < 1)) throw new Error('--process-id must be a positive integer.');
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 120000)) throw new Error('--timeout-ms must be an integer between 250 and 120000.');
  if (lspPath !== undefined && lspPath.trim() === '') throw new Error('--lsp-path must not be empty.');
  if (diagnosticMode !== undefined && command !== 'check') throw new Error('--diagnostic-mode is only valid with check.');
  return { command, projectPath, preferredProcessId, timeoutMs, lspPath, diagnosticMode, includePaths, json, debug };
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

function semanticJson(result: SemanticCheckResult): Record<string, unknown> {
  return {
    schemaVersion: 1,
    resultType: 'semantic-check',
    status: result.status,
    success: result.success,
    connected: result.connected,
    semantic: true,
    authoritative: false,
    projectPath: result.projectPath,
    filesChecked: result.filesChecked,
    numErrors: result.numErrors,
    numWarnings: result.numWarnings,
    numSourceErrors: result.numSourceErrors,
    numSourceWarnings: result.numSourceWarnings,
    numMetadataErrors: result.numMetadataErrors,
    numMetadataWarnings: result.numMetadataWarnings,
    metadataHealth: result.metadataHealth,
    diagnosticMode: result.diagnosticMode,
    errors: result.diagnostics.filter(diagnostic => diagnostic.severity === 'error'),
    warnings: result.diagnostics.filter(diagnostic => diagnostic.severity === 'warning'),
    diagnostics: result.diagnostics,
    sourceDiagnostics: result.sourceDiagnostics,
    metadataDiagnostics: result.metadataDiagnostics,
    timing: result.timing,
    backend: result.backend,
    metadata: result.metadata,
    ...(result.error ? { error: result.error } : {}),
  };
}

function metadataJson(metadata: NonNullable<ToolchainSnapshot['metadata']>, includePaths: boolean): Record<string, unknown> {
  return {
    projectName: metadata.projectName,
    metadataAvailable: metadata.metadataAvailable,
    metadataFreshness: metadata.metadataFreshness,
    sourceFileCount: metadata.sourceFiles.length,
    packageCount: metadata.packages.length,
    packages: metadata.packages.map(packageInfo => ({
      name: packageInfo.name,
      role: packageInfo.role,
      readOnly: packageInfo.readOnly,
      digestFileCount: packageInfo.digestFiles.length,
      ...(includePaths ? { directory: packageInfo.directory, digestFiles: packageInfo.digestFiles } : {}),
    })),
    ...(includePaths ? {
      descriptorPath: metadata.descriptorPath,
      projectRoot: metadata.projectRoot,
      contentPath: metadata.contentPath,
      workspaceFilePath: metadata.workspaceFilePath,
      vprojectPath: metadata.vprojectPath,
      generatedRoot: metadata.generatedRoot,
      sourceFiles: metadata.sourceFiles,
    } : { pathsOmitted: true }),
    ...(metadata.error ? { error: metadata.error } : {}),
  };
}

function toolchainJson(snapshot: ToolchainSnapshot, includePaths: boolean): Record<string, unknown> {
  const installation = snapshot.installation;
  const runtime = snapshot.runtime;
  return {
    schemaVersion: 1,
    resultType: 'toolchain-report',
    platform: snapshot.platform,
    installation: {
      uefnVersion: installation.uefnVersion,
      uefnBuildId: installation.uefnBuildId,
      verseExtensionVersion: installation.verseExtensionVersion,
      verseLanguageServerVersion: installation.verseLanguageServerVersion,
      workflowServerModuleRegistered: installation.workflowServerModuleRegistered,
      verseCompilerModuleRegistered: installation.verseCompilerModuleRegistered,
      dedicatedCommandletExecutableAvailable: installation.dedicatedCommandletExecutableAvailable,
      ...(includePaths ? {
        uefnRoot: installation.uefnRoot,
        uefnExecutable: installation.uefnExecutable,
        verseExtensionPath: installation.verseExtensionPath,
        verseLanguageServerPath: installation.verseLanguageServerPath,
        commandletExecutable: installation.commandletExecutable,
      } : { pathsOmitted: true }),
    },
    runtime: {
      uefnRunning: runtime.uefnRunning,
      uefnProcessIds: runtime.uefnProcessIds,
      vsCodeRunning: runtime.vsCodeRunning,
      verseLanguageServerRunning: runtime.verseLanguageServerRunning,
      activeProjectDetected: Boolean(runtime.activeProjectPath),
      ...(includePaths ? { activeProjectPath: runtime.activeProjectPath } : {}),
    },
    metadata: snapshot.metadata ? metadataJson(snapshot.metadata, includePaths) : undefined,
    backends: snapshot.backends.map(backend => ({
      id: backend.id,
      name: backend.name,
      available: backend.available,
      version: backend.version,
      reason: backend.reason,
      capabilities: backend.capabilities,
      ...(includePaths ? { executablePath: backend.executablePath } : {}),
    })),
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

function printSemantic(result: SemanticCheckResult): void {
  process.stdout.write(`${result.status}: ${result.success ? 'success' : result.error ?? 'failed'}\n`);
  process.stdout.write('semantic=true authoritative=false (not an authoritative UEFN build)\n');
  process.stdout.write(`files=${result.filesChecked} errors=${result.numErrors} warnings=${result.numWarnings} source-errors=${result.numSourceErrors} metadata-errors=${result.numMetadataErrors}\n`);
  process.stdout.write(`metadata-health=${result.metadataHealth} diagnostic-mode=${result.diagnosticMode ?? 'push'}\n`);
  for (const diagnostic of result.diagnostics) process.stdout.write(`${diagnostic.severity ?? 'message'}:${diagnosticLocation(diagnostic)} ${diagnostic.message}\n`);
}

function printBackends(snapshot: ToolchainSnapshot): void {
  for (const backend of snapshot.backends) {
    process.stdout.write(`${backend.name}\n`);
    process.stdout.write(`  available: ${backend.available ? 'yes' : 'no'}\n`);
    process.stdout.write(`  requires UEFN running: ${backend.capabilities.requiresUefnProcess}\n`);
    process.stdout.write(`  requires UEFN GUI: ${backend.capabilities.requiresUefnGui}\n`);
    process.stdout.write(`  semantic analysis: ${backend.capabilities.semanticAnalysis}\n`);
    process.stdout.write(`  authoritative compilation: ${backend.capabilities.authoritativeCompilation}\n`);
    if (backend.reason) process.stdout.write(`  reason: ${backend.reason}\n`);
  }
  process.stdout.write('No headless authoritative compile backend is claimed by this report.\n');
}

function printDoctor(snapshot: ToolchainSnapshot): void {
  const installation = snapshot.installation;
  const runtime = snapshot.runtime;
  process.stdout.write(`UEFN: ${installation.uefnVersion ?? 'not detected'}\n`);
  if (installation.uefnRoot) process.stdout.write(`install=${installation.uefnRoot}\n`);
  process.stdout.write(`Verse LSP: ${installation.verseLanguageServerPath ? 'available' : 'not found'}${installation.verseLanguageServerVersion ? ` (${installation.verseLanguageServerVersion})` : ''}\n`);
  if (installation.verseLanguageServerPath) process.stdout.write(`lsp=${installation.verseLanguageServerPath}\n`);
  process.stdout.write(`UEFN running: ${runtime.uefnRunning ? 'yes' : 'no'}; VS Code running: ${runtime.vsCodeRunning ? 'yes' : 'no'}\n`);
  process.stdout.write(`Workflow module registered: ${installation.workflowServerModuleRegistered ? 'yes' : 'no'}; VerseCompiler module registered: ${installation.verseCompilerModuleRegistered ? 'yes' : 'no'}\n`);
  process.stdout.write(`Dedicated commandlet executable: ${installation.dedicatedCommandletExecutableAvailable ? installation.commandletExecutable : 'not found'}\n`);
  if (snapshot.metadata) {
    process.stdout.write(`Project metadata: ${snapshot.metadata.metadataAvailable ? 'available' : 'unavailable'} (${snapshot.metadata.projectName})\n`);
    if (snapshot.metadata.metadataFreshness) process.stdout.write(`metadata freshness: ${snapshot.metadata.metadataFreshness}\n`);
    process.stdout.write(`source files=${snapshot.metadata.sourceFiles.length} packages=${snapshot.metadata.packages.length} digest files=${snapshot.metadata.packages.reduce((count, packageInfo) => count + packageInfo.digestFiles.length, 0)}\n`);
    if (snapshot.metadata.error) process.stdout.write(`${snapshot.metadata.error}\n`);
  }
  printBackends(snapshot);
}

export function exitCodeForStatus(status: string | undefined, success: boolean): number {
  if (success) return EXIT_CODES.success;
  if (status === 'compiled') return EXIT_CODES.compilationErrors;
  if (status === 'checked-with-errors') return EXIT_CODES.compilationErrors;
  if (status === 'multiple-sessions-ambiguous') return EXIT_CODES.ambiguousSession;
  if (status === 'uefn-not-running' || status === 'project-not-loaded' || status === 'compiler-not-initialized' || status === 'project-mismatch') return EXIT_CODES.compilerUnavailable;
  if (status === 'metadata-unavailable' || status === 'metadata-invalid' || status === 'language-server-unavailable' || status === 'project-unrecognized') return EXIT_CODES.compilerUnavailable;
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
    if (options.command === 'check') {
      if (!options.projectPath) {
        process.stderr.write('check requires --project <path>.\n');
        return EXIT_CODES.invalidArguments;
      }
      const result = await checkVerseProject({
        projectPath: options.projectPath,
        timeoutMs: options.timeoutMs,
        lspPath: options.lspPath,
        ...(options.diagnosticMode ? { lspOptions: { diagnosticMode: options.diagnosticMode } } : {}),
      });
      if (options.json) process.stdout.write(`${JSON.stringify(semanticJson(result), null, 2)}\n`);
      else printSemantic(result);
      return exitCodeForStatus(result.status, result.success);
    }
    if (options.command === 'doctor' || options.command === 'backends') {
      const metadata = options.projectPath ? discoverVerseProjectMetadata(options.projectPath) : undefined;
      const snapshot = await discoverToolchain({
        projectPath: options.projectPath,
        preferredProcessId: options.preferredProcessId,
        metadata,
        environment: options.lspPath ? { ...process.env, UEFN_VERSE_LSP_PATH: options.lspPath } : undefined,
      });
      if (options.json) process.stdout.write(`${JSON.stringify(toolchainJson(snapshot, options.includePaths), null, 2)}\n`);
      else if (options.command === 'backends') printBackends(snapshot);
      else printDoctor(snapshot);
      return EXIT_CODES.success;
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
