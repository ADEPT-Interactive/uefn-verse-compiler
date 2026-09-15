import fs from 'node:fs';
import { discoverVerseProjectMetadata, type ProjectDiscoveryOptions } from '../discovery/project.js';
import { discoverToolchain } from '../discovery/toolchain.js';
import { runVerseLspCheck, type LspCheckOptions } from './lsp.js';
import type { SemanticCheckResult, SemanticCheckStatus, VerseProjectMetadata } from '../types.js';

export interface CheckVerseOptions extends ProjectDiscoveryOptions {
  projectPath: string;
  timeoutMs?: number;
  lspPath?: string;
  lspOptions?: Omit<LspCheckOptions, 'timeoutMs'>;
}

function emptyResult(status: SemanticCheckStatus, metadata: VerseProjectMetadata, error?: string): SemanticCheckResult {
  return {
    status,
    success: false,
    connected: false,
    authoritative: false,
    semantic: true,
    projectPath: metadata.descriptorPath,
    filesChecked: 0,
    numErrors: 0,
    numWarnings: 0,
    numSourceErrors: 0,
    numSourceWarnings: 0,
    numMetadataErrors: 0,
    numMetadataWarnings: 0,
    metadataHealth: 'unverified',
    diagnosticMode: 'push',
    diagnostics: [],
    sourceDiagnostics: [],
    metadataDiagnostics: [],
    timing: { totalMs: 0 },
    metadata,
    error,
  };
}

/** Perform an explicit semantic check through Epic's installed Verse language server. */
export async function checkVerseProject(options: CheckVerseOptions): Promise<SemanticCheckResult> {
  const metadata = discoverVerseProjectMetadata(options.projectPath, options);
  if (!options.projectPath.toLowerCase().endsWith('.uefnproject') || !fs.existsSync(metadata.descriptorPath)) {
    return emptyResult('project-unrecognized', metadata, metadata.error ?? 'A valid .uefnproject path is required.');
  }
  if (!metadata.metadataAvailable) return emptyResult('metadata-unavailable', metadata, metadata.error);

  const environment = options.lspPath
    ? { ...(options.environment ?? process.env), UEFN_VERSE_LSP_PATH: options.lspPath }
    : options.environment;
  const toolchain = await discoverToolchain({ ...options, environment, metadata });
  const backend = toolchain.backends.find(candidate => candidate.id === 'epic-verse-lsp');
  if (!backend?.available || !toolchain.installation.verseLanguageServerPath) {
    return {
      ...emptyResult('language-server-unavailable', metadata, backend?.reason ?? 'Epic Verse language-server executable was not found.'),
      backend,
    };
  }
  if (metadata.sourceFiles.length === 0) {
    return {
      status: 'checked-clean',
      success: true,
      connected: false,
      authoritative: false,
      semantic: true,
      projectPath: metadata.descriptorPath,
      filesChecked: 0,
      numErrors: 0,
      numWarnings: 0,
      numSourceErrors: 0,
      numSourceWarnings: 0,
      numMetadataErrors: 0,
      numMetadataWarnings: 0,
      metadataHealth: 'unverified',
      diagnosticMode: 'push',
      diagnostics: [],
      sourceDiagnostics: [],
      metadataDiagnostics: [],
      timing: { totalMs: 0 },
      backend,
      metadata,
    };
  }

  const run = await runVerseLspCheck(metadata, toolchain.installation.verseLanguageServerPath, {
    ...options.lspOptions,
    timeoutMs: options.timeoutMs,
  });
  const numErrors = run.diagnostics.filter(diagnostic => diagnostic.severity === 'error').length;
  const numWarnings = run.diagnostics.filter(diagnostic => diagnostic.severity === 'warning').length;
  const numSourceErrors = run.sourceDiagnostics.filter(diagnostic => diagnostic.severity === 'error').length;
  const numSourceWarnings = run.sourceDiagnostics.filter(diagnostic => diagnostic.severity === 'warning').length;
  const numMetadataErrors = run.metadataDiagnostics.filter(diagnostic => diagnostic.severity === 'error').length;
  const numMetadataWarnings = run.metadataDiagnostics.filter(diagnostic => diagnostic.severity === 'warning').length;
  const metadataWasExplicitlyAudited = run.diagnosticMode === 'workspace' || run.diagnosticMode === 'both';
  const status: SemanticCheckStatus = run.error
    ? (run.connected ? 'check-failed' : 'language-server-unavailable')
    : numSourceErrors > 0 ? 'checked-with-errors'
      : metadataWasExplicitlyAudited && numMetadataErrors > 0 ? 'metadata-invalid'
        : 'checked-clean';
  const metadataHealth = run.diagnosticMode === 'push' || run.diagnosticMode === 'pull'
    ? 'unverified' as const
    : numMetadataErrors > 0 ? 'invalid' as const : 'clean' as const;
  return {
    status,
    success: status === 'checked-clean',
    connected: run.connected,
    authoritative: false,
    semantic: true,
    projectPath: metadata.descriptorPath,
    filesChecked: run.filesChecked,
    numErrors,
    numWarnings,
    numSourceErrors,
    numSourceWarnings,
    numMetadataErrors,
    numMetadataWarnings,
    metadataHealth,
    diagnosticMode: run.diagnosticMode,
    diagnostics: run.diagnostics,
    sourceDiagnostics: run.sourceDiagnostics,
    metadataDiagnostics: run.metadataDiagnostics,
    timing: run.timing,
    backend,
    metadata,
    ...(run.error ? { error: run.error } : status === 'metadata-invalid' ? { error: 'Generated project metadata produced semantic diagnostics; source results may be incomplete.' } : {}),
  };
}
