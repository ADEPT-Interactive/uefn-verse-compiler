import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkVerseProject, compileVerseProject, discoverVerseProjectMetadata, getVerseCompilerStatus, projectPathsMatch } from '../src/index.js';
import type { LspDiagnosticMode, SemanticCheckResult, VerseCompilerDiagnostic, WorkflowCompileResult } from '../src/types.js';

type ParityVariant = {
  name: string;
  category: string;
  expectedCode?: string;
  text: string;
};

interface Arguments {
  projectPath: string;
  sourcePath?: string;
  processId?: number;
  timeoutMs: number;
  settleMs: number;
  restoreWaitMs: number;
  diagnosticMode: LspDiagnosticMode;
  lspPath?: string;
  json: boolean;
  confirmDisposable: boolean;
}

interface DiagnosticSummary {
  count: number;
  codes: string[];
  categories: string[];
  examples: string[];
}

interface CaseEvidence {
  variant: string;
  category: string;
  expectedCode?: string;
  variantHash: string;
  sourceHashAfterLsp: string;
  sourceHashAfterWorkflow: string;
  lsp: {
    status: string;
    success: boolean;
    diagnosticMode?: LspDiagnosticMode;
    metadataHealth: string;
    source: DiagnosticSummary;
    metadataErrors: number;
    metadataWarnings: number;
    timing: SemanticCheckResult['timing'];
    error?: string;
  };
  workflow: {
    status?: string;
    success: boolean;
    numErrors?: number;
    numWarnings?: number;
    diagnostics: DiagnosticSummary;
    elapsedMs: number;
    error?: string;
  };
  restored: boolean;
  passed: boolean;
  reasons: string[];
}

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_SETTLE_MS = 1200;
const DEFAULT_RESTORE_WAIT_MS = 500;

function usage(): string {
  return [
    'Usage: npm run parity:verse -- --project <disposable.uefnproject> --confirm-disposable [options]',
    '',
    'Options:',
    '  --source <path>                 exact source file to mutate; required when the project has multiple Verse files',
    '  --process-id <pid>              UEFN process that owns the Workflow listener',
    '  --diagnostic-mode push|workspace|pull|both  LSP transport (default: push)',
    '  --timeout-ms <n>                LSP/Workflow deadline (default: 120000)',
    '  --settle-ms <n>                 LSP quiet settle window (default: 1200)',
    '  --restore-wait-ms <n>           wait before final restoration verification (default: 500)',
    '  --lsp-path <path>               explicit Verse language-server executable',
    '  --json                          emit machine-readable evidence',
  ].join('\n');
}

function parsePositive(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${flag} must be a positive number.`);
  return Math.floor(parsed);
}

function parseArguments(argv: string[]): Arguments {
  let projectPath: string | undefined;
  let sourcePath: string | undefined;
  let processId: number | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let settleMs = DEFAULT_SETTLE_MS;
  let restoreWaitMs = DEFAULT_RESTORE_WAIT_MS;
  let diagnosticMode: LspDiagnosticMode = 'push';
  let lspPath: string | undefined;
  let json = false;
  let confirmDisposable = false;
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
    if (argument === '--source') {
      sourcePath = argv[++index];
      continue;
    }
    if (argument === '--process-id') {
      processId = parsePositive(argv[++index] ?? '', argument);
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
    if (argument === '--restore-wait-ms') {
      restoreWaitMs = parsePositive(argv[++index] ?? '', argument);
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
    if (argument === '--lsp-path') {
      lspPath = argv[++index];
      continue;
    }
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--confirm-disposable') {
      confirmDisposable = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!projectPath) throw new Error(`--project is required.\n\n${usage()}`);
  if (!confirmDisposable) throw new Error('--confirm-disposable is required because this workflow writes deterministic variants to the selected source file.');
  return {
    projectPath: path.resolve(projectPath),
    ...(sourcePath ? { sourcePath: path.resolve(sourcePath) } : {}),
    ...(processId === undefined ? {} : { processId }),
    timeoutMs,
    settleMs,
    restoreWaitMs,
    diagnosticMode,
    ...(lspPath ? { lspPath: path.resolve(lspPath) } : {}),
    json,
    confirmDisposable,
  };
}

function hashBytes(value: Uint8Array): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashFile(filePath: string): string {
  return hashBytes(fs.readFileSync(filePath));
}

function normalized(value: string): string {
  return path.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
}

function diagnosticCategory(diagnostic: VerseCompilerDiagnostic): string {
  const code = String(diagnostic.code ?? '');
  if (code === '3100') return 'syntax';
  if (code === '3506') return 'unknown-identifier';
  if (code === '3509') return 'type';
  if (code === '3512') return 'effect';
  if (code === '3587') return 'import';
  const message = diagnostic.message;
  if (/syntax|parse|unexpected/i.test(message)) return 'syntax';
  if (/unknown identifier|not found/i.test(message)) return 'unknown-identifier';
  if (/incompatible|initializer|type|argument/i.test(message)) return 'type';
  if (/suspend|effect|sleep/i.test(message)) return 'effect';
  if (/import|logical scope|module/i.test(message)) return 'import';
  return 'other';
}

function firstLine(message: string): string {
  return message.split(/\r?\n/, 1)[0].replace(/\s+/g, ' ').trim();
}

function summarizeDiagnostics(diagnostics: VerseCompilerDiagnostic[]): DiagnosticSummary {
  const codes = [...new Set(diagnostics.map(diagnostic => String(diagnostic.code ?? '<none>')))].sort();
  const categories = [...new Set(diagnostics.map(diagnosticCategory))].sort();
  const examples = [...new Set(diagnostics.map(diagnostic => firstLine(diagnostic.message)))].slice(0, 4);
  return { count: diagnostics.length, codes, categories, examples };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function sourcePathFor(metadata: ReturnType<typeof discoverVerseProjectMetadata>, requested?: string): string {
  const sourcePath = requested ? path.resolve(requested) : metadata.sourceFiles.length === 1 ? metadata.sourceFiles[0] : undefined;
  if (!sourcePath) throw new Error(`The project has ${metadata.sourceFiles.length} Verse source files; pass --source <path> to select exactly one disposable file.`);
  if (!sourcePath.toLowerCase().endsWith('.verse')) throw new Error(`Selected parity source is not a .verse file: ${sourcePath}`);
  if (!metadata.sourceFiles.some(candidate => normalized(candidate) === normalized(sourcePath))) {
    throw new Error('Selected parity source is not one of the discovered project source files.');
  }
  const relative = path.relative(metadata.projectRoot, sourcePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Selected parity source must remain inside the project root.');
  }
  return sourcePath;
}

function variants(baseText: string): ParityVariant[] {
  return [
    { name: 'clean', category: 'clean', text: baseText },
    {
      name: 'syntax',
      category: 'syntax',
      expectedCode: '3100',
      text: `${baseText}\n\nParitySyntaxProbe := !\n`,
    },
    {
      name: 'unknown-identifier',
      category: 'unknown-identifier',
      expectedCode: '3506',
      text: `${baseText}\n\nParityUnknownIdentifierProbe:int = DefinitelyMissing\n`,
    },
    {
      name: 'type-mismatch',
      category: 'type',
      expectedCode: '3509',
      text: `${baseText}\n\nParityTypeMismatchProbe:int = "not an integer"\n`,
    },
    {
      name: 'effect-violation',
      category: 'effect',
      expectedCode: '3512',
      text: `${baseText}\n\nParityEffectViolationProbe():void =\n        Sleep(0.0)\n`,
    },
    {
      name: 'invalid-import',
      category: 'import',
      expectedCode: '3587',
      text: `using { /Definitely/No/Such/Module }\n${baseText}`,
    },
  ];
}

function sourceDiagnostics(result: SemanticCheckResult): VerseCompilerDiagnostic[] {
  return result.sourceDiagnostics.filter(diagnostic => diagnostic.severity === 'error');
}

function summarizeLsp(result: SemanticCheckResult): CaseEvidence['lsp'] {
  return {
    status: result.status,
    success: result.success,
    diagnosticMode: result.diagnosticMode,
    metadataHealth: result.metadataHealth,
    source: summarizeDiagnostics(sourceDiagnostics(result)),
    metadataErrors: result.numMetadataErrors,
    metadataWarnings: result.numMetadataWarnings,
    timing: result.timing,
    ...(result.error ? { error: result.error } : {}),
  };
}

function summarizeWorkflow(result: WorkflowCompileResult, elapsedMs: number): CaseEvidence['workflow'] {
  return {
    status: result.status,
    success: result.success,
    numErrors: result.numErrors,
    numWarnings: result.numWarnings,
    diagnostics: summarizeDiagnostics((result.diagnostics ?? []).filter(diagnostic => diagnostic.severity === 'error')),
    elapsedMs,
    ...(result.error ? { error: result.error } : {}),
  };
}

function matchesExpectedCode(summary: DiagnosticSummary, expectedCode: string | undefined): boolean {
  return expectedCode === undefined || summary.codes.includes(expectedCode);
}

async function runCase(
  variant: ParityVariant,
  metadata: ReturnType<typeof discoverVerseProjectMetadata>,
  args: Arguments,
  sourcePath: string,
): Promise<CaseEvidence> {
  const variantHash = hashFile(sourcePath);
  const reasons: string[] = [];
  const lsp = await checkVerseProject({
    projectPath: args.projectPath,
    timeoutMs: args.timeoutMs,
    ...(args.lspPath ? { lspPath: args.lspPath } : {}),
    lspOptions: { diagnosticMode: args.diagnosticMode, settleMs: args.settleMs },
  });
  const sourceHashAfterLsp = hashFile(sourcePath);
  const workflowStartedAt = performance.now();
  const workflow = await compileVerseProject({
    projectPath: args.projectPath,
    ...(args.processId === undefined ? {} : { preferredProcessId: args.processId }),
    timeoutMs: args.timeoutMs,
  });
  const workflowElapsedMs = Math.round(performance.now() - workflowStartedAt);
  const sourceHashAfterWorkflow = hashFile(sourcePath);
  const lspSource = sourceDiagnostics(lsp);
  if (variant.name === 'clean') {
    if (lspSource.length !== 0) reasons.push(`LSP reported ${lspSource.length} source error(s) for the clean variant.`);
    if (workflow.numErrors !== 0 || !workflow.success) reasons.push(`Workflow clean baseline was not successful (numErrors=${workflow.numErrors ?? 'unknown'}).`);
  } else {
    if (lspSource.length === 0) reasons.push('LSP did not report a source error for the invalid variant.');
    if (!matchesExpectedCode(summarizeDiagnostics(lspSource), variant.expectedCode)) reasons.push(`LSP source codes did not include expected ${variant.expectedCode}.`);
    if (workflow.numErrors === undefined || workflow.numErrors < 1 || workflow.success) reasons.push('Workflow did not report a failed compile for the invalid variant.');
  }
  if (summarizeDiagnostics(lspSource).categories.length > 0 && !summarizeDiagnostics(lspSource).categories.includes(variant.category) && variant.name !== 'clean') {
    reasons.push(`LSP source categories did not include expected ${variant.category}.`);
  }
  if (sourceHashAfterLsp !== variantHash) reasons.push('LSP changed the selected source file.');
  if (sourceHashAfterWorkflow !== variantHash) reasons.push('Workflow changed the selected source file before restoration.');
  if (!lsp.metadata || lsp.metadata.projectRoot !== metadata.projectRoot) reasons.push('LSP rediscovered a different project root during parity.');
  return {
    variant: variant.name,
    category: variant.category,
    ...(variant.expectedCode ? { expectedCode: variant.expectedCode } : {}),
    variantHash,
    sourceHashAfterLsp,
    sourceHashAfterWorkflow,
    lsp: summarizeLsp(lsp),
    workflow: summarizeWorkflow(workflow, workflowElapsedMs),
    restored: false,
    passed: reasons.length === 0,
    reasons,
  };
}

function printEvidence(evidence: CaseEvidence[], projectPath: string, sourcePath: string, originalHash: string, restorationError?: string): void {
  process.stdout.write(`project=${projectPath}\nsource=${sourcePath}\noriginal-sha256=${originalHash}\n`);
  for (const item of evidence) {
    process.stdout.write(`${item.variant}: ${item.passed ? 'passed' : 'failed'}; lsp-source=${item.lsp.source.count} [${item.lsp.source.codes.join(',') || 'none'}]; workflow-errors=${item.workflow.numErrors ?? 'unknown'}; metadata=${item.lsp.metadataHealth}/${item.lsp.metadataErrors}; lsp-ms=${item.lsp.timing.totalMs}; workflow-ms=${item.workflow.elapsedMs}\n`);
    if (item.reasons.length > 0) process.stdout.write(`  ${item.reasons.join(' | ')}\n`);
  }
  if (restorationError) process.stdout.write(`restoration-error=${restorationError}\n`);
}

async function main(argv: string[]): Promise<number> {
  let args: Arguments;
  try {
    args = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Invalid arguments.'}\n`);
    return 4;
  }
  const metadata = discoverVerseProjectMetadata(args.projectPath);
  if (!metadata.metadataAvailable) {
    process.stderr.write(`Project metadata is unavailable: ${metadata.error ?? 'unknown reason'}\n`);
    return 2;
  }
  const workflowStatus = await getVerseCompilerStatus({
    projectPath: args.projectPath,
    ...(args.processId === undefined ? {} : { preferredProcessId: args.processId }),
  });
  const matchingSession = workflowStatus.sessions.some(session => projectPathsMatch(session.projectPath, args.projectPath));
  if (!workflowStatus.activeProjectPath || !projectPathsMatch(workflowStatus.activeProjectPath, args.projectPath) || !matchingSession) {
    process.stderr.write('No owner-confirmed active UEFN project matched the requested disposable project; no source mutation was performed.\n');
    return 2;
  }
  const sourcePath = sourcePathFor(metadata, args.sourcePath);
  const originalBytes = fs.readFileSync(sourcePath);
  const originalHash = hashBytes(originalBytes);
  const evidence: CaseEvidence[] = [];
  let fatalError: string | undefined;
  let restorationError: string | undefined;
  const restoreOriginal = (): void => {
    fs.writeFileSync(sourcePath, originalBytes);
    const restored = fs.readFileSync(sourcePath);
    if (!restored.equals(originalBytes)) throw new Error(`Source restoration hash mismatch; expected ${originalHash}, got ${hashBytes(restored)}.`);
  };
  try {
    for (const variant of variants(originalBytes.toString('utf8'))) {
      fs.writeFileSync(sourcePath, variant.text, 'utf8');
      try {
        await delay(args.restoreWaitMs);
        const item = await runCase(variant, metadata, args, sourcePath);
        evidence.push(item);
      } finally {
        restoreOriginal();
      }
      evidence[evidence.length - 1].restored = true;
    }
  } catch (error) {
    fatalError = error instanceof Error ? error.message : 'Parity run failed.';
  } finally {
    try {
      restoreOriginal();
      await delay(args.restoreWaitMs);
      const finalHash = hashFile(sourcePath);
      if (finalHash !== originalHash) throw new Error(`Final source restoration hash mismatch; expected ${originalHash}, got ${finalHash}.`);
    } catch (error) {
      restorationError = error instanceof Error ? error.message : 'Source restoration failed.';
    }
  }
  let finalHash: string | undefined;
  try { finalHash = hashFile(sourcePath); } catch { /* The restoration error below is the useful failure. */ }
  const output = {
    schemaVersion: 1,
    projectPath: args.projectPath,
    sourcePath,
    originalHash,
    diagnosticMode: args.diagnosticMode,
    evidence,
    fatalError,
    restorationError,
    restored: restorationError === undefined && finalHash === originalHash,
    passed: fatalError === undefined && restorationError === undefined && evidence.length === variants(originalBytes.toString('utf8')).length && evidence.every(item => item.passed && item.restored),
  };
  if (args.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else printEvidence(evidence, args.projectPath, sourcePath, originalHash, fatalError ?? restorationError);
  if (fatalError && !restorationError) process.stderr.write(`parity-fatal-error=${fatalError}\n`);
  if (restorationError) process.stderr.write(`parity-restoration-error=${restorationError}\n`);
  return output.passed ? 0 : restorationError ? 2 : 1;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; });
