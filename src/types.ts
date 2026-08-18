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
  severity?: 'error' | 'warning' | 'info' | 'log';
  message: string;
  file?: string;
  line?: number;
  column?: number;
  code?: string | number;
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

export interface VerseCompilerStatusResult {
  status: 'compiler-discovered' | DiscoveryStatus;
  available: boolean;
  sessions: VerseCompilerSession[];
  activeProjectPath?: string;
  processes: UefnProcessInfo[];
  error?: string;
}
