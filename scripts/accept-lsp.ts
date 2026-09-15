import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  discoverToolchain,
  discoverVerseProjectMetadata,
  runVerseLspCheck,
  type LspDiagnosticMode,
  type LspCheckRun,
  type LspProtocolObservation,
  type SemanticCheckTiming,
  type VerseCompilerDiagnostic,
  type VerseProjectMetadata,
} from '../src/index.js';

type AcceptanceMode = 'gate-a' | 'experiment';

interface Arguments {
  projectPath: string;
  mode: AcceptanceMode;
  diagnosticMode: LspDiagnosticMode;
  timeoutMs: number;
  settleMs: number;
  quietMs: number;
  json: boolean;
}

interface ProcessRecord {
  name: string;
  processId: number;
}

interface SpawnRecord {
  processId: number;
  executablePath: string;
  cwd: string;
  aliveAtSpawn: boolean;
}

interface CaseEvidence {
  name: string;
  diagnosticMode: LspDiagnosticMode;
  connected: boolean;
  error?: string;
  shutdownClean: boolean;
  sourceErrors: number;
  sourceWarnings: number;
  metadataErrors: number;
  metadataWarnings: number;
  sourceDiagnostics: VerseCompilerDiagnostic[];
  metadataBreakdown: MetadataBreakdown[];
  timing: SemanticCheckTiming;
  protocol: ProtocolEvidence;
  process: {
    before: ProcessRecord[];
    during: ProcessRecord[];
    after: ProcessRecord[];
    spawned?: Omit<SpawnRecord, 'aliveAtSpawn'> & { aliveAtSpawn: boolean };
  };
  sourceHashesUnchanged: boolean;
  contractPassed: boolean;
  contractReasons: string[];
}

interface MetadataBreakdown {
  package: string;
  file: string;
  code: string | number;
  severity: string;
  messagePattern: string;
  count: number;
  example: VerseCompilerDiagnostic;
}

interface ProtocolEvidence {
  advertised: {
    workspaceDiagnostic: boolean;
    textDocumentDiagnostic: boolean;
  };
  requested: {
    workspaceDiagnostic: boolean;
    pullDiagnostic: boolean;
  };
  completed: {
    workspaceDiagnostic: boolean;
    pullDiagnostics: number;
  };
  workspaceDiagnosticError?: string;
  pullDiagnosticError?: string;
  clientMethods: string[];
  serverMethods: string[];
  registrations: string[];
  configurationSections: Array<string | null>;
}

const PROCESS_QUERY = [
  "$ErrorActionPreference='Stop'",
  "$targetNames=@('UnrealEditorFortnite-Win64-Shipping.exe','Code.exe','code-insiders.exe')",
  "Get-CimInstance Win32_Process | Where-Object { $_.Name -in $targetNames -or $_.Name -match '^verse-lsp.*\\.exe$' } | Select-Object Name,ProcessId | ConvertTo-Json -Compress",
].join('; ');

function usage(): string {
  return [
    'Usage: npm run accept:lsp -- --project <Project.uefnproject> [options]',
    '',
    'Options:',
    '  --mode gate-a|experiment       gate-a runs the clean case and invalid corpus (default: gate-a)',
    '  --diagnostic-mode push|workspace|pull|both  transport strategy (default: push)',
    '  --timeout-ms <n>               per-process deadline',
    '  --settle-ms <n>                post-completion quiet settle window',
    '  --quiet-ms <n>                 bounded missing-publication fallback',
    '  --json                         emit machine-readable sanitized evidence',
  ].join('\n');
}

function parsePositive(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${flag} must be a positive number.`);
  return Math.floor(parsed);
}

function parseArguments(argv: string[]): Arguments {
  let projectPath: string | undefined;
  let mode: AcceptanceMode = 'gate-a';
  let diagnosticMode: LspDiagnosticMode = 'push';
  let timeoutMs = 120000;
  let settleMs = 1200;
  let quietMs = 10000;
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
    if (argument === '--mode') {
      const value = argv[++index];
      if (value !== 'gate-a' && value !== 'experiment') throw new Error('--mode must be gate-a or experiment.');
      mode = value;
      continue;
    }
    if (argument === '--diagnostic-mode') {
      const value = argv[++index] as LspDiagnosticMode | undefined;
      if (value !== 'push' && value !== 'workspace' && value !== 'pull' && value !== 'both') {
        throw new Error('--diagnostic-mode must be push, workspace, pull, or both.');
      }
      diagnosticMode = value;
      continue;
    }
    if (argument === '--timeout-ms') {
      timeoutMs = parsePositive(argv[++index] ?? '', argument);
      continue;
    }
    if (argument === '--settle-ms') {
      settleMs = parsePositive(argv[++index] ?? '', argument);
      continue;
    }
    if (argument === '--quiet-ms') {
      quietMs = parsePositive(argv[++index] ?? '', argument);
      continue;
    }
    if (argument === '--json') {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!projectPath) throw new Error(`--project is required.\n\n${usage()}`);
  if (mode === 'gate-a' && diagnosticMode !== 'push') {
    throw new Error('Gate A acceptance uses push diagnostics only; use --mode experiment for another strategy.');
  }
  return { projectPath: path.resolve(projectPath), mode, diagnosticMode, timeoutMs, settleMs, quietMs, json };
}

function snapshotProcesses(): ProcessRecord[] {
  if (process.platform !== 'win32') throw new Error('The real Epic LSP acceptance harness requires Windows.');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROCESS_QUERY], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  }).trim();
  if (!output) return [];
  const value = JSON.parse(output) as unknown;
  const rows = Array.isArray(value) ? value : [value];
  return rows.flatMap(row => {
    if (!row || typeof row !== 'object') return [];
    const record = row as Record<string, unknown>;
    const name = typeof record.Name === 'string' ? record.Name : undefined;
    const processId = Number(record.ProcessId);
    return name && Number.isInteger(processId) && processId > 0 ? [{ name, processId }] : [];
  });
}

function forbiddenProcesses(processes: ProcessRecord[]): ProcessRecord[] {
  return processes.filter(record => /^(?:UnrealEditorFortnite-Win64-Shipping|Code|code-insiders)\.exe$/i.test(record.name));
}

function lspProcesses(processes: ProcessRecord[]): ProcessRecord[] {
  return processes.filter(record => /^verse-lsp.*\.exe$/i.test(record.name));
}

function normalized(value: string): string {
  return path.normalize(value).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

function sanitizePath(value: string | undefined, projectRoot: string): string | undefined {
  if (!value) return value;
  let result = value.replace(/\\/g, '/');
  const replacements = [
    [process.env.USERPROFILE, '<USER_PROFILE>'],
    [process.env.LOCALAPPDATA, '<LOCALAPPDATA>'],
    [process.env.TEMP, '<TEMP>'],
    [process.env.TMP, '<TEMP>'],
    [projectRoot, '<PROJECT_ROOT>'],
  ] as const;
  for (const [source, replacement] of replacements) {
    if (source) result = result.replace(source.replace(/\\/g, '/'), replacement);
  }
  return result.replace(/^[A-Za-z]:\//, '<DRIVE>/');
}

function sha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sourceHashes(metadata: VerseProjectMetadata): Map<string, string> {
  return new Map(metadata.sourceFiles.map(filePath => [normalized(filePath), sha256(filePath)]));
}

function hashesEqual(left: Map<string, string>, right: Map<string, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) if (right.get(key) !== value) return false;
  return true;
}

function packageForFile(filePath: string | undefined, metadata: VerseProjectMetadata): string {
  if (!filePath) return '<unknown>';
  const normalizedFile = normalized(filePath);
  if (metadata.vprojectPath && normalizedFile === normalized(metadata.vprojectPath)) return '.vproject';
  const packageInfo = metadata.packages.find(candidate => candidate.directory && (
    normalizedFile === normalized(candidate.directory) || normalizedFile.startsWith(`${normalized(candidate.directory)}/`)
  ));
  return packageInfo?.name ?? '<other-generated-file>';
}

function messagePattern(message: string): string {
  return message.split(/\r?\n/, 1)[0]
    .replace(/`[^`]+`/g, '`<name>`')
    .replace(/\([^)]{0,180}\)/g, '(...)')
    .replace(/\s+/g, ' ')
    .trim();
}

function metadataBreakdown(diagnostics: VerseCompilerDiagnostic[], metadata: VerseProjectMetadata, projectRoot: string): MetadataBreakdown[] {
  const groups = new Map<string, MetadataBreakdown>();
  for (const diagnostic of diagnostics) {
    const packageName = packageForFile(diagnostic.file, metadata);
    const code = diagnostic.code ?? '<none>';
    const severity = diagnostic.severity ?? '<none>';
    const pattern = messagePattern(diagnostic.message);
    const key = `${packageName}\0${diagnostic.file ?? ''}\0${String(code)}\0${severity}\0${pattern}`;
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, {
      package: packageName,
      file: sanitizePath(diagnostic.file, projectRoot) ?? '<unknown>',
      code,
      severity,
      messagePattern: pattern,
      count: 1,
      example: {
        ...diagnostic,
        ...(diagnostic.file ? { file: sanitizePath(diagnostic.file, projectRoot) } : {}),
      },
    });
  }
  return [...groups.values()].sort((left, right) => right.count - left.count || left.package.localeCompare(right.package) || String(left.code).localeCompare(String(right.code)));
}

function scrubDiagnostic(diagnostic: VerseCompilerDiagnostic, projectRoot: string): VerseCompilerDiagnostic {
  return {
    ...diagnostic,
    ...(diagnostic.file ? { file: sanitizePath(diagnostic.file, projectRoot) } : {}),
  };
}

function protocolEvidence(protocol: LspProtocolObservation): ProtocolEvidence {
  return {
    advertised: {
      workspaceDiagnostic: protocol.workspaceDiagnosticAdvertised,
      textDocumentDiagnostic: protocol.textDocumentDiagnosticAdvertised,
    },
    requested: {
      workspaceDiagnostic: protocol.workspaceDiagnosticRequested,
      pullDiagnostic: protocol.pullDiagnosticRequested,
    },
    completed: {
      workspaceDiagnostic: protocol.workspaceDiagnosticCompleted,
      pullDiagnostics: protocol.pullDiagnosticCompleted,
    },
    ...(protocol.workspaceDiagnosticError ? { workspaceDiagnosticError: protocol.workspaceDiagnosticError } : {}),
    ...(protocol.pullDiagnosticError ? { pullDiagnosticError: protocol.pullDiagnosticError } : {}),
    clientMethods: [...new Set(protocol.clientMethods)],
    serverMethods: [...new Set(protocol.serverMethods)],
    registrations: [...new Set(protocol.registrations)],
    configurationSections: protocol.configurationSections,
  };
}

function expectedVariant(name: string, text: string): { required: boolean; pattern: RegExp } {
  if (name === 'clean') return { required: true, pattern: /$a/ };
  if (name === 'syntax') return { required: true, pattern: /Unexpected|Verse uses|syntax|parse/i };
  if (name === 'unknown-identifier') return { required: true, pattern: /Unknown identifier|DefinitelyMissing/i };
  if (name === 'type-mismatch') return { required: true, pattern: /incompatible|initializer|int|type|matches/i };
  if (name === 'effect-violation') return { required: true, pattern: /suspending|Sleep|effect|not allowed/i };
  if (name === 'invalid-import') return { required: true, pattern: /logical.scope|module|import|Definitely|invalid/i };
  if (name === 'invalid-override') return { required: false, pattern: /override|parent function/i };
  if (name === 'invalid-access') return { required: false, pattern: /access|public|qualifier|module/i };
  return { required: false, pattern: /argument|type|string|matches/i };
}

function variants(baseText: string): Array<{ name: string; text: string }> {
  const effectNeedle = '        LogDebug("Device lifecycle ended.")';
  const wrongArgumentNeedle = '    LogWarning(Message:string):void =';
  const effectText = baseText.includes(effectNeedle)
    ? baseText.replace(effectNeedle, `${effectNeedle}\n        Sleep(0.0)`)
    : `${baseText}\n\nEffectViolationProbe():void =\n        Sleep(0.0)\n`;
  return [
    { name: 'syntax', text: `${baseText}\n\nSyntaxProbe := !\n` },
    { name: 'unknown-identifier', text: `${baseText}\n\nUnknownIdentifierProbe:int = DefinitelyMissing\n` },
    { name: 'type-mismatch', text: `${baseText}\n\nTypeMismatchProbe:int = "not an integer"\n` },
    { name: 'effect-violation', text: effectText },
    { name: 'invalid-import', text: `using { /Definitely/No/Such/Module }\n${baseText}` },
    { name: 'invalid-override', text: `${baseText}\n\nInvalidOverrideProbe<override>():void =\n        return\n` },
    { name: 'invalid-access', text: `${baseText}\n\nInvalidAccessProbe<public> := 1\n` },
    { name: 'wrong-argument', text: baseText.includes(wrongArgumentNeedle)
      ? baseText.replace(wrongArgumentNeedle, `    WrongArgumentProbe():void =\n        LogDebug(1)\n\n${wrongArgumentNeedle}`)
      : `${baseText}\n\nmanaged_transactions_device.WrongArgumentProbe():void =\n        LogDebug(1)\n` },
  ];
}

function sourceErrors(result: Pick<LspCheckRun, 'sourceDiagnostics'>): VerseCompilerDiagnostic[] {
  return result.sourceDiagnostics.filter(diagnostic => diagnostic.severity === 'error');
}

async function runCase(
  name: string,
  text: string,
  metadata: VerseProjectMetadata,
  lspPath: string,
  args: Arguments,
): Promise<CaseEvidence> {
  const projectRoot = metadata.projectRoot;
  const before = snapshotProcesses();
  const reasons: string[] = [];
  if (forbiddenProcesses(before).length > 0) reasons.push('UEFN or VS Code was already running before the case.');
  if (lspProcesses(before).length > 0) reasons.push('A pre-existing Verse language-server process was already running before the case.');
  const beforeHashes = sourceHashes(metadata);
  let during: ProcessRecord[] = [];
  let spawned: SpawnRecord | undefined;
  let spawnObservationError: string | undefined;
  let result: LspCheckRun;
  if (reasons.length === 0) {
    result = await runVerseLspCheck(metadata, lspPath, {
      diagnosticMode: args.diagnosticMode,
      sourceTexts: { [metadata.sourceFiles[0] as string]: text },
      timeoutMs: args.timeoutMs,
      settleMs: args.settleMs,
      quietMs: args.quietMs,
      onSpawn: details => {
        let aliveAtSpawn = false;
        try {
          during = snapshotProcesses();
          aliveAtSpawn = during.some(record => record.processId === details.pid);
        } catch (error) {
          spawnObservationError = error instanceof Error ? error.message : 'Could not observe the spawned process.';
        }
        spawned = { processId: details.pid, executablePath: details.executablePath, cwd: details.cwd, aliveAtSpawn };
      },
    });
    if (spawnObservationError) reasons.push(spawnObservationError);
  } else {
    result = {
      connected: false,
      error: 'Acceptance precondition failed.',
      shutdownClean: false,
      diagnostics: [],
      sourceDiagnostics: [],
      metadataDiagnostics: [],
      filesChecked: 0,
      timing: { totalMs: 0 },
      diagnosticMode: args.diagnosticMode,
      protocol: {
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
      },
    };
  }
  const after = snapshotProcesses();
  const afterHashes = sourceHashes(metadata);
  const errors = sourceErrors(result);
  const warnings = result.sourceDiagnostics.filter(diagnostic => diagnostic.severity === 'warning');
  const metadataErrors = result.metadataDiagnostics.filter(diagnostic => diagnostic.severity === 'error');
  const metadataWarnings = result.metadataDiagnostics.filter(diagnostic => diagnostic.severity === 'warning');
  const expected = expectedVariant(name, text);
  const diagnosticText = errors.map(diagnostic => diagnostic.message).join('\n');
  const isClean = name === 'clean';
  if (isClean && errors.length !== 0) reasons.push(`Clean source produced ${errors.length} source error(s).`);
  if (!isClean && expected.required && (errors.length === 0 || !expected.pattern.test(diagnosticText))) {
    reasons.push(`Expected a source diagnostic matching ${expected.pattern}, but received ${errors.length} source error(s).`);
  }
  if (result.connected !== true) reasons.push('The language server did not complete initialization.');
  if (result.shutdownClean !== true) reasons.push('The language server did not complete clean shutdown.');
  if (!hashesEqual(beforeHashes, afterHashes)) reasons.push('A source-file hash changed during the in-memory probe.');
  if (forbiddenProcesses(after).length > 0) reasons.push('UEFN or VS Code remained running after the case.');
  if (lspProcesses(after).length > 0) reasons.push('A Verse language-server process remained after the case.');
  if (spawned && !spawned.aliveAtSpawn) reasons.push('The acceptance observer did not see the spawned LSP alive.');
  if (!spawned && reasons.length === 0) reasons.push('The run did not expose a spawned LSP process id.');
  if (args.diagnosticMode === 'pull' && !result.protocol.textDocumentDiagnosticAdvertised && !result.error) {
    reasons.push('Pull diagnostics were neither advertised nor reported as unsupported.');
  }
  return {
    name,
    diagnosticMode: args.diagnosticMode,
    connected: result.connected,
    ...(result.error ? { error: result.error } : {}),
    shutdownClean: result.shutdownClean,
    sourceErrors: errors.length,
    sourceWarnings: warnings.length,
    metadataErrors: metadataErrors.length,
    metadataWarnings: metadataWarnings.length,
    sourceDiagnostics: result.sourceDiagnostics.map(diagnostic => scrubDiagnostic(diagnostic, projectRoot)),
    metadataBreakdown: name === 'clean' ? metadataBreakdown(result.metadataDiagnostics, metadata, projectRoot) : [],
    timing: result.timing,
    protocol: protocolEvidence(result.protocol),
    process: {
      before,
      during,
      after,
      ...(spawned ? {
        spawned: {
          processId: spawned.processId,
          executablePath: sanitizePath(spawned.executablePath, projectRoot) ?? '<unknown>',
          cwd: sanitizePath(spawned.cwd, projectRoot) ?? '<unknown>',
          aliveAtSpawn: spawned.aliveAtSpawn,
        },
      } : {}),
    },
    sourceHashesUnchanged: hashesEqual(beforeHashes, afterHashes),
    contractPassed: reasons.length === 0,
    contractReasons: reasons,
  };
}

function sanitizedDoctor(metadata: VerseProjectMetadata, toolchain: Awaited<ReturnType<typeof discoverToolchain>>): Record<string, unknown> {
  const lspPath = toolchain.installation.verseLanguageServerPath;
  const uefnVersion = toolchain.installation.uefnVersion;
  const lspVersion = toolchain.installation.verseLanguageServerVersion;
  const buildMatch = uefnVersion?.match(/CL\s+(\d+)/i)?.[1];
  const lspBuild = lspVersion?.match(/(\d{5,})/)?.[1];
  return {
    platform: toolchain.platform,
    runtime: {
      uefnRunning: toolchain.runtime.uefnRunning,
      vsCodeRunning: toolchain.runtime.vsCodeRunning,
      verseLanguageServerRunning: toolchain.runtime.verseLanguageServerRunning,
      activeProjectDetected: Boolean(toolchain.runtime.activeProjectPath),
    },
    installation: {
      uefnVersion,
      uefnBuildId: toolchain.installation.uefnBuildId,
      verseExtensionVersion: toolchain.installation.verseExtensionVersion,
      verseLanguageServerVersion: lspVersion,
      lspBuildMatchesUefnChangelist: Boolean(buildMatch && lspBuild && buildMatch === lspBuild),
      languageServerPresent: Boolean(lspPath),
      workflowServerModuleRegistered: toolchain.installation.workflowServerModuleRegistered,
      verseCompilerModuleRegistered: toolchain.installation.verseCompilerModuleRegistered,
      dedicatedCommandletExecutableAvailable: toolchain.installation.dedicatedCommandletExecutableAvailable,
    },
    metadata: {
      projectName: metadata.projectName,
      metadataAvailable: metadata.metadataAvailable,
      metadataFreshness: metadata.metadataFreshness,
      sourceFileCount: metadata.sourceFiles.length,
      packageCount: metadata.packages.length,
      packageNames: metadata.packages.map(packageInfo => packageInfo.name),
      workspaceFolderCount: metadata.workspaceFilePath ? 'generated-workspace-present' : 'fallback-topology',
    },
    backends: toolchain.backends.map(backend => ({
      id: backend.id,
      available: backend.available,
      version: backend.version,
      capabilities: backend.capabilities,
    })),
  };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const metadata = discoverVerseProjectMetadata(args.projectPath);
  if (!metadata.metadataAvailable) throw new Error(metadata.error ?? 'Generated project metadata is unavailable.');
  if (metadata.sourceFiles.length === 0) throw new Error('The selected project contains no Verse source files.');
  const toolchain = await discoverToolchain({ projectPath: args.projectPath, metadata });
  const lspPath = toolchain.installation.verseLanguageServerPath;
  if (!lspPath) throw new Error('The installed Epic Verse language server was not found.');
  const initialProcesses = snapshotProcesses();
  const result: {
    harness: Record<string, unknown>;
    doctor: Record<string, unknown>;
    initialProcessState: ProcessRecord[];
    cases: CaseEvidence[];
    contractPassed: boolean;
  } = {
    harness: {
      mode: args.mode,
      diagnosticMode: args.diagnosticMode,
      project: '<PROJECT_ROOT>',
      sanitized: true,
      sourceOverridesPersisted: false,
    },
    doctor: sanitizedDoctor(metadata, toolchain),
    initialProcessState: initialProcesses,
    cases: [],
    contractPassed: false,
  };
  if (forbiddenProcesses(initialProcesses).length > 0) throw new Error('Gate A requires UEFN and VS Code to be absent before every run.');
  if (lspProcesses(initialProcesses).length > 0) throw new Error('Gate A requires no pre-existing Verse language-server process.');
  const baseText = fs.readFileSync(metadata.sourceFiles[0] as string, 'utf8');
  if (args.mode === 'gate-a') {
    result.cases.push(await runCase('clean', baseText, metadata, lspPath, args));
    for (const variant of variants(baseText)) result.cases.push(await runCase(variant.name, variant.text, metadata, lspPath, args));
  } else {
    result.cases.push(await runCase('clean', baseText, metadata, lspPath, args));
  }
  const finalProcesses = snapshotProcesses();
  const allCasesPass = result.cases.every(caseResult => caseResult.contractPassed);
  const finalProcessPass = forbiddenProcesses(finalProcesses).length === 0 && lspProcesses(finalProcesses).length === 0;
  result.harness.finalProcessState = finalProcesses;
  result.contractPassed = allCasesPass && finalProcessPass;
  if (!result.contractPassed) {
    result.harness.failure = 'One or more acceptance-contract checks failed.';
  }
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`mode=${args.mode} diagnostic-mode=${args.diagnosticMode} contract=${result.contractPassed ? 'passed' : 'failed'}\n`);
    for (const caseResult of result.cases) {
      process.stdout.write(`${caseResult.name}: source-errors=${caseResult.sourceErrors} metadata-errors=${caseResult.metadataErrors} total=${caseResult.timing.totalMs ?? 0}ms shutdown=${caseResult.shutdownClean ? 'clean' : 'unclean'} contract=${caseResult.contractPassed ? 'passed' : 'failed'}\n`);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  if (!result.contractPassed) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
