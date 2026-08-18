import { HISTORICAL_WORKFLOW_PORT, type CompilerDiscoveryOptions, type CompilerDiscoveryResult, type CompilerDiscoverySystem, type UefnProcessInfo, type VerseCompilerSession } from '../types.js';
import { hasEndpointOverride, resolveWorkflowEndpoint } from './endpoint.js';
import { normalizeProjectPath, projectPathsMatch } from './paths.js';
import { windowsDiscoverySystem } from './windows.js';

function validateOptions(options: CompilerDiscoveryOptions): void {
  if (options.preferredProcessId !== undefined && (!Number.isInteger(options.preferredProcessId) || options.preferredProcessId < 1)) {
    throw new Error('preferredProcessId must be a positive integer.');
  }
}

function discoveredSession(processId: number | undefined, projectPath: string | undefined, host: string, port: number, source: VerseCompilerSession['source'], now: () => Date): VerseCompilerSession {
  return { host, port, processId, projectPath, source, transport: 'tcp-content-length-json', discoveredAt: now().toISOString() };
}

function sortListeners<T extends { port: number; processId: number }>(listeners: T[]): T[] {
  return [...listeners].sort((left, right) => {
    const leftPriority = left.port === HISTORICAL_WORKFLOW_PORT ? 0 : 1;
    const rightPriority = right.port === HISTORICAL_WORKFLOW_PORT ? 0 : 1;
    return leftPriority - rightPriority || left.port - right.port || left.processId - right.processId;
  });
}

function unavailable(status: CompilerDiscoveryResult['status'], processes: UefnProcessInfo[], activeProjectPath: string | undefined, error: string): CompilerDiscoveryResult {
  return { status, sessions: [], processes, activeProjectPath, error };
}

/** Discover local UEFN-owned compiler listeners without scanning arbitrary ports. */
export async function discoverVerseCompiler(options: CompilerDiscoveryOptions = {}): Promise<CompilerDiscoveryResult> {
  validateOptions(options);
  const environment = options.environment ?? process.env;
  const now = options.now ?? (() => new Date());

  if (hasEndpointOverride(environment)) {
    try {
      const endpoint = resolveWorkflowEndpoint(environment);
      return { status: 'compiler-not-initialized', sessions: [discoveredSession(undefined, options.projectPath, endpoint.host, endpoint.port, 'override', now)], processes: [] };
    } catch (error) {
      return unavailable('compiler-not-initialized', [], undefined, error instanceof Error ? error.message : 'Verse compiler endpoint override is invalid.');
    }
  }

  const system: CompilerDiscoverySystem = options.system ?? windowsDiscoverySystem;
  const processes = await system.listUefnProcesses();
  const activeProjectPath = await system.readActiveProjectFile();
  const requestedProject = normalizeProjectPath(options.projectPath);

  if (processes.length === 0) return unavailable('uefn-not-running', processes, activeProjectPath, 'UEFN is not running.');

  let selectedProcesses: UefnProcessInfo[] = [];
  if (options.preferredProcessId !== undefined) {
    const selected = processes.find(processInfo => processInfo.processId === options.preferredProcessId);
    if (!selected) return unavailable('project-mismatch', processes, activeProjectPath, `No active UEFN process matched process ID ${options.preferredProcessId}.`);
    if (requestedProject && selected.projectPath && !projectPathsMatch(selected.projectPath, requestedProject)) {
      return unavailable('project-mismatch', processes, activeProjectPath, 'The selected UEFN process is associated with a different project.');
    }
    selectedProcesses = [selected];
  } else if (requestedProject) {
    selectedProcesses = processes.filter(processInfo => projectPathsMatch(processInfo.projectPath, requestedProject));
    if (selectedProcesses.length > 1) return unavailable('multiple-sessions-ambiguous', processes, activeProjectPath, 'Multiple UEFN processes match the requested project.');
    if (selectedProcesses.length === 0 && activeProjectPath && !projectPathsMatch(activeProjectPath, requestedProject)) {
      return unavailable('project-mismatch', processes, activeProjectPath, `UEFN is currently associated with a different project (${activeProjectPath}).`);
    }
    if (selectedProcesses.length === 0 && processes.length > 1) {
      return unavailable('multiple-sessions-ambiguous', processes, activeProjectPath, 'Multiple UEFN processes are active and no authoritative project-to-process match was available.');
    }
    if (selectedProcesses.length === 0 && processes.length === 1 && !activeProjectPath) {
      return unavailable('project-not-loaded', processes, activeProjectPath, 'UEFN is running but no matching project has been identified.');
    }
    if (selectedProcesses.length === 0) selectedProcesses = processes;
  } else {
    const activeMatches = activeProjectPath ? processes.filter(processInfo => projectPathsMatch(processInfo.projectPath, activeProjectPath)) : [];
    if (activeMatches.length === 1) selectedProcesses = activeMatches;
    else if (processes.length === 1) selectedProcesses = processes;
    else return unavailable('multiple-sessions-ambiguous', processes, activeProjectPath, 'Multiple UEFN processes are active and no authoritative project-to-process match was available.');
  }

  if (selectedProcesses.length !== 1) return unavailable('multiple-sessions-ambiguous', processes, activeProjectPath, 'Multiple UEFN processes are active and no authoritative project-to-process match was available.');
  const selectedProcess = selectedProcesses[0];
  const listeners = sortListeners((await system.listLoopbackListeners()).filter(listener => listener.processId === selectedProcess.processId));
  const projectPath = selectedProcess.projectPath ?? (requestedProject ? options.projectPath : activeProjectPath);
  const sessions = listeners.map(listener => discoveredSession(listener.processId, projectPath, listener.host, listener.port, 'process-listener', now));
  if (sessions.length > 0) return { status: 'compiler-not-initialized', sessions, activeProjectPath, processes };

  return {
    status: 'compiler-not-initialized',
    sessions: [discoveredSession(selectedProcess.processId, projectPath, '127.0.0.1', HISTORICAL_WORKFLOW_PORT, 'compatibility-port', now)],
    activeProjectPath,
    processes,
    error: 'UEFN is running but did not expose a discoverable loopback listener; the historical Workflow Server endpoint will be probed for compatibility.',
  };
}
