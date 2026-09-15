export const HISTORICAL_WORKFLOW_PORT = 1962;

export type CompilerStatus =
  | 'compiled'
  | 'uefn-not-running'
  | 'project-not-loaded'
  | 'compiler-not-initialized'
  | 'project-mismatch'
  | 'multiple-sessions-ambiguous'
  | 'compile-request-failed';

export type DiscoveryStatus = Exclude<CompilerStatus, 'compiled' | 'compile-request-failed'>;

export type SemanticCheckStatus =
  | 'checked-clean'
  | 'checked-with-errors'
  | 'metadata-unavailable'
  | 'metadata-invalid'
  | 'language-server-unavailable'
  | 'project-unrecognized'
  | 'check-failed';

export type LspDiagnosticMode = 'push' | 'workspace' | 'pull' | 'both';

export type CompilerBackendId = 'workflow' | 'epic-verse-lsp';

export type CapabilityState = 'yes' | 'no' | 'unknown';

export interface CompilerBackendCapabilities {
  semanticAnalysis: CapabilityState;
  authoritativeCompilation: CapabilityState;
  requiresUefnProcess: CapabilityState;
  requiresUefnGui: CapabilityState;
  requiresGeneratedProjectMetadata: CapabilityState;
  supportsIncremental: CapabilityState;
  returnsDiagnostics: CapabilityState;
  producesArtifacts: CapabilityState;
}

export interface CompilerBackendDescriptor {
  id: CompilerBackendId;
  name: string;
  available: boolean;
  version?: string;
  executablePath?: string;
  reason?: string;
  capabilities: CompilerBackendCapabilities;
}

export interface WorkflowEndpoint {
  host: string;
  port: number;
}

export interface VerseCompilerSession extends WorkflowEndpoint {
  processId?: number;
  projectPath?: string;
  source: 'override' | 'process-listener' | 'compatibility-port';
  transport: 'tcp-content-length-json';
  discoveredAt: string;
}

export interface VerseCompilerDiagnostic {
  severity?: 'error' | 'warning' | 'info' | 'hint' | 'log';
  message: string;
  file?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  code?: string | number;
  source?: string;
}

export interface UefnProcessInfo {
  processId: number;
  projectPath?: string;
}

export interface LoopbackListener extends WorkflowEndpoint {
  processId: number;
}

export interface CompilerDiscoverySystem {
  listUefnProcesses(): Promise<UefnProcessInfo[]>;
  listLoopbackListeners(): Promise<LoopbackListener[]>;
  readActiveProjectFile(): Promise<string | undefined>;
}

export interface CompilerDiscoveryOptions {
  projectPath?: string;
  preferredProcessId?: number;
  environment?: NodeJS.ProcessEnv;
  system?: CompilerDiscoverySystem;
  now?: () => Date;
}

export interface CompilerDiscoveryResult {
  status: DiscoveryStatus;
  sessions: VerseCompilerSession[];
  activeProjectPath?: string;
  processes: UefnProcessInfo[];
  error?: string;
}

export interface CompileVerseOptions extends CompilerDiscoveryOptions {
  timeoutMs?: number;
  endpoint?: WorkflowEndpoint;
}

export interface WorkflowCompileResult {
  success: boolean;
  connected: boolean;
  status?: CompilerStatus;
  numErrors?: number;
  numWarnings?: number;
  /** Raw final-result messages retained for library consumers; CLI JSON omits them unless --debug is used. */
  messages?: unknown[];
  /** Raw non-final protocol notifications retained for debugging and protocol compatibility work. */
  notifications?: unknown[];
  diagnostics?: VerseCompilerDiagnostic[];
  session?: VerseCompilerSession;
  error?: string;
}

export interface VerseProjectPackage {
  name: string;
  directory?: string;
  role?: string;
  readOnly?: boolean;
  digestFiles: string[];
}

export type ProjectMetadataFreshness = 'fresh-by-mtime' | 'possibly-stale' | 'unknown';

export interface VerseProjectMetadata {
  projectName: string;
  descriptorPath: string;
  projectRoot: string;
  contentPath: string;
  workspaceFilePath?: string;
  vprojectPath?: string;
  generatedRoot?: string;
  packages: VerseProjectPackage[];
  sourceFiles: string[];
  metadataAvailable: boolean;
  /** A conservative timestamp heuristic; it is not a substitute for a UEFN build. */
  metadataFreshness?: ProjectMetadataFreshness;
  error?: string;
}

export interface SemanticCheckTiming {
  /** Time from starting the check until the LSP child process was spawned. */
  spawnMs?: number;
  /** Backwards-compatible time from starting the check until initialize completed. */
  startupMs?: number;
  /** Time spent waiting for the initialize response. */
  initializeMs?: number;
  /** Time from start until the first diagnostic publication/report, including an empty report. */
  firstDiagnosticMs?: number;
  /** Time spent waiting for workspace/diagnostic, when requested. */
  workspaceDiagnosticMs?: number;
  /** Time from start until the source/report completion criteria and quiet period were satisfied. */
  analysisSettledMs?: number;
  /** Time spent completing protocol shutdown and child cleanup. */
  shutdownMs?: number;
  totalMs: number;
}

export type SemanticMetadataHealth = 'clean' | 'invalid' | 'unverified';

export interface SemanticCheckResult {
  status: SemanticCheckStatus;
  success: boolean;
  connected: boolean;
  authoritative: false;
  semantic: true;
  projectPath?: string;
  filesChecked: number;
  numErrors: number;
  numWarnings: number;
  numSourceErrors: number;
  numSourceWarnings: number;
  numMetadataErrors: number;
  numMetadataWarnings: number;
  /** Whether generated metadata was checked, rejected, or intentionally left unverified. */
  metadataHealth: SemanticMetadataHealth;
  diagnosticMode?: LspDiagnosticMode;
  diagnostics: VerseCompilerDiagnostic[];
  sourceDiagnostics: VerseCompilerDiagnostic[];
  metadataDiagnostics: VerseCompilerDiagnostic[];
  timing: SemanticCheckTiming;
  backend?: CompilerBackendDescriptor;
  metadata?: VerseProjectMetadata;
  error?: string;
}

export interface ToolchainInstallation {
  uefnRoot?: string;
  uefnExecutable?: string;
  uefnVersion?: string;
  uefnBuildId?: string;
  verseExtensionPath?: string;
  verseExtensionVersion?: string;
  verseLanguageServerPath?: string;
  verseLanguageServerVersion?: string;
  workflowServerModuleRegistered: boolean;
  verseCompilerModuleRegistered: boolean;
  commandletExecutable?: string;
  dedicatedCommandletExecutableAvailable: boolean;
}

export interface ToolchainRuntimeState {
  uefnRunning: boolean;
  uefnProcessIds: number[];
  vsCodeRunning: boolean;
  verseLanguageServerRunning: boolean;
  activeProjectPath?: string;
}

export interface ToolchainSnapshot {
  platform: NodeJS.Platform;
  installation: ToolchainInstallation;
  runtime: ToolchainRuntimeState;
  metadata?: VerseProjectMetadata;
  backends: CompilerBackendDescriptor[];
}

export interface VerseCompilerStatusResult {
  status: 'compiler-discovered' | DiscoveryStatus;
  available: boolean;
  sessions: VerseCompilerSession[];
  activeProjectPath?: string;
  processes: UefnProcessInfo[];
  error?: string;
}
