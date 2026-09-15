import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { discoverVerseCompiler } from './discover.js';
import { windowsDiscoverySystem } from './windows.js';
import type {
  CompilerBackendCapabilities,
  CompilerBackendDescriptor,
  CompilerDiscoverySystem,
  ToolchainInstallation,
  ToolchainRuntimeState,
  ToolchainSnapshot,
  VerseProjectMetadata,
} from '../types.js';

const execFileAsync = promisify(execFile);
const UEFN_PROCESS_NAME = 'UnrealEditorFortnite-Win64-Shipping.exe';
const LSP_ENV = 'UEFN_VERSE_LSP_PATH';

export interface ToolchainProcessInfo {
  processId: number;
  name: string;
  executablePath?: string;
}

interface VersionFile {
  MajorVersion?: unknown;
  MinorVersion?: unknown;
  PatchVersion?: unknown;
  Changelist?: unknown;
  BuildId?: unknown;
  BranchName?: unknown;
}

interface LauncherInstallation {
  AppName?: unknown;
  InstallLocation?: unknown;
}

export interface ToolchainDiscoverySystem {
  listProcesses(): Promise<ToolchainProcessInfo[]>;
}

export interface ToolchainDiscoveryOptions {
  environment?: NodeJS.ProcessEnv;
  projectPath?: string;
  preferredProcessId?: number;
  metadata?: VerseProjectMetadata;
  system?: ToolchainDiscoverySystem;
  compilerSystem?: CompilerDiscoverySystem;
}

const workflowCapabilities: CompilerBackendCapabilities = {
  semanticAnalysis: 'yes',
  authoritativeCompilation: 'yes',
  requiresUefnProcess: 'yes',
  requiresUefnGui: 'unknown',
  requiresGeneratedProjectMetadata: 'yes',
  supportsIncremental: 'unknown',
  returnsDiagnostics: 'yes',
  producesArtifacts: 'unknown',
};

const lspCapabilities: CompilerBackendCapabilities = {
  semanticAnalysis: 'yes',
  authoritativeCompilation: 'no',
  requiresUefnProcess: 'no',
  requiresUefnGui: 'no',
  requiresGeneratedProjectMetadata: 'yes',
  supportsIncremental: 'yes',
  returnsDiagnostics: 'yes',
  producesArtifacts: 'no',
};

function parseRows(value: unknown): ToolchainProcessInfo[] {
  const rows = Array.isArray(value) ? value : [value];
  return rows.flatMap(row => {
    if (!row || typeof row !== 'object') return [];
    const record = row as Record<string, unknown>;
    const processId = Number(record.ProcessId);
    const name = typeof record.Name === 'string' ? record.Name : '';
    if (!Number.isInteger(processId) || processId < 1 || !name) return [];
    return [{ processId, name, executablePath: typeof record.ExecutablePath === 'string' ? record.ExecutablePath : undefined }];
  });
}

async function listProcesses(): Promise<ToolchainProcessInfo[]> {
  if (process.platform !== 'win32') return [];
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('${UEFN_PROCESS_NAME}','Code.exe','code.exe','code-insiders.exe','verse-lsp.exe') } | Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress`,
    ], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    return parseRows(JSON.parse(stdout.trim() || '[]') as unknown);
  } catch {
    return [];
  }
}

export const windowsToolchainDiscoverySystem: ToolchainDiscoverySystem = { listProcesses };

function readJson(filePath: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function installRootFromExecutable(executablePath: string): string | undefined {
  const normalized = path.normalize(executablePath);
  const marker = `${path.sep}FortniteGame${path.sep}Binaries${path.sep}Win64${path.sep}`.toLowerCase();
  const lower = normalized.toLowerCase();
  const index = lower.lastIndexOf(marker);
  return index >= 0 ? normalized.slice(0, index) : undefined;
}

function launcherRoots(environment: NodeJS.ProcessEnv): string[] {
  const programData = environment.PROGRAMDATA;
  if (!programData) return [];
  const launcherManifest = path.join(programData, 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat');
  const value = readJson(launcherManifest) as { InstallationList?: unknown } | undefined;
  if (!value || !Array.isArray(value.InstallationList)) return [];
  return value.InstallationList.flatMap(entry => {
    const installation = entry as LauncherInstallation;
    const appName = typeof installation.AppName === 'string' ? installation.AppName : '';
    const installLocation = typeof installation.InstallLocation === 'string' ? installation.InstallLocation : undefined;
    return installLocation && /fortnite|uefn/i.test(appName) ? [installLocation] : [];
  });
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(/[^0-9]+/).filter(Boolean).map(Number);
  const rightParts = right.split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference) return difference;
  }
  return left.localeCompare(right);
}

interface LanguageServerCandidate {
  extensionPath?: string;
  extensionVersion?: string;
  languageServerPath: string;
  languageServerVersion?: string;
}

function extensionCandidate(extensionPath: string): LanguageServerCandidate | undefined {
  const languageServerPath = path.join(extensionPath, 'bin', 'Win64', 'verse-lsp.exe');
  if (!fs.existsSync(languageServerPath)) return undefined;
  const packageJson = readJson(path.join(extensionPath, 'package.json')) as { version?: unknown } | undefined;
  const extensionVersion = typeof packageJson?.version === 'string' ? packageJson.version : undefined;
  return { extensionPath, extensionVersion, languageServerPath, languageServerVersion: extensionVersion };
}

function findLanguageServer(environment: NodeJS.ProcessEnv): LanguageServerCandidate | undefined {
  const explicit = environment[LSP_ENV]?.trim();
  if (explicit) {
    const candidate = extensionCandidate(path.dirname(path.dirname(path.dirname(explicit))));
    if (fs.existsSync(explicit)) return candidate ?? { languageServerPath: explicit };
    return undefined;
  }
  const profile = environment.USERPROFILE ?? environment.HOME;
  if (!profile) return undefined;
  const extensionRoots = [
    path.join(profile, '.vscode', 'extensions'),
    path.join(profile, '.vscode-insiders', 'extensions'),
  ];
  const candidates: LanguageServerCandidate[] = [];
  for (const root of extensionRoots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^epicgames\.verse(?:-|$)/i.test(entry.name)) continue;
      const candidate = extensionCandidate(path.join(root, entry.name));
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates.sort((left, right) => compareVersions(right.extensionVersion ?? '', left.extensionVersion ?? ''))[0];
}

function readUefnVersion(root: string | undefined): { version?: string; buildId?: string } {
  if (!root) return {};
  const versionPath = path.join(root, 'FortniteGame', 'Binaries', 'Win64', 'UnrealEditorFortnite-Win64-Shipping.version');
  const value = readJson(versionPath) as VersionFile | undefined;
  if (!value) return {};
  const major = Number(value.MajorVersion);
  const minor = Number(value.MinorVersion);
  const patch = Number(value.PatchVersion);
  const changelist = Number(value.Changelist);
  return {
    version: Number.isInteger(major) && Number.isInteger(minor) && Number.isInteger(patch)
      ? `${major}.${minor}.${patch}${Number.isInteger(changelist) ? ` (CL ${changelist})` : ''}`
      : undefined,
    buildId: typeof value.BuildId === 'string' ? value.BuildId : Number.isInteger(changelist) ? String(changelist) : undefined,
  };
}

function moduleFlags(root: string | undefined): { workflow: boolean; compiler: boolean } {
  if (!root) return { workflow: false, compiler: false };
  const modulePath = path.join(root, 'FortniteGame', 'Binaries', 'Win64', 'UnrealEditorFortnite-Win64-Shipping.modules');
  const value = readJson(modulePath) as { Modules?: unknown } | undefined;
  if (!value?.Modules || typeof value.Modules !== 'object') return { workflow: false, compiler: false };
  const names = Object.keys(value.Modules as Record<string, unknown>);
  return {
    workflow: names.includes('VerseWorkflowServer'),
    compiler: names.includes('VerseCompiler'),
  };
}

function commandletPath(root: string | undefined): string | undefined {
  if (!root) return undefined;
  const candidates = [
    path.join(root, 'Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe'),
    path.join(root, 'FortniteGame', 'Binaries', 'Win64', 'UnrealEditorFortnite-Cmd.exe'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate));
}

function backend(id: 'workflow' | 'epic-verse-lsp', available: boolean, extra: Partial<CompilerBackendDescriptor> = {}): CompilerBackendDescriptor {
  return {
    id,
    name: id === 'workflow' ? 'UEFN Workflow Server' : 'Epic Verse Language Server',
    available,
    capabilities: id === 'workflow' ? workflowCapabilities : lspCapabilities,
    ...extra,
  };
}

export function describeBackends(installation: ToolchainInstallation, runtime: ToolchainRuntimeState, workflowAvailable: boolean): CompilerBackendDescriptor[] {
  const workflowReason = workflowAvailable
    ? undefined
    : runtime.uefnRunning
      ? 'UEFN is running, but no usable process-owned Workflow Server session was discovered.'
      : 'UEFN is not running.';
  return [
    backend('epic-verse-lsp', Boolean(installation.verseLanguageServerPath), {
      version: installation.verseLanguageServerVersion,
      executablePath: installation.verseLanguageServerPath,
      reason: installation.verseLanguageServerPath ? undefined : 'Epic Verse language-server executable was not found in an installed extension.',
    }),
    backend('workflow', workflowAvailable, {
      reason: workflowReason,
    }),
  ];
}

/** Inspect locally installed UEFN/Verse components and current process state without launching or mutating Epic tools. */
export async function discoverToolchain(options: ToolchainDiscoveryOptions = {}): Promise<ToolchainSnapshot> {
  const environment = options.environment ?? process.env;
  const system = options.system ?? windowsToolchainDiscoverySystem;
  const processes = await system.listProcesses();
  const uefnProcesses = processes.filter(record => record.name.toLowerCase() === UEFN_PROCESS_NAME.toLowerCase());
  const uefnExecutable = uefnProcesses.map(record => record.executablePath).find(Boolean);
  const uefnRoot = (uefnExecutable ? installRootFromExecutable(uefnExecutable) : undefined)
    ?? environment.UEFN_INSTALL_ROOT
    ?? launcherRoots(environment).find(candidate => fs.existsSync(candidate));
  const languageServer = findLanguageServer(environment);
  const version = readUefnVersion(uefnRoot);
  const flags = moduleFlags(uefnRoot);
  const dedicatedCommandlet = commandletPath(uefnRoot);
  const activeProjectPath = await (options.compilerSystem ?? windowsDiscoverySystem).readActiveProjectFile();
  const runtime: ToolchainRuntimeState = {
    uefnRunning: uefnProcesses.length > 0,
    uefnProcessIds: uefnProcesses.map(record => record.processId),
    vsCodeRunning: processes.some(record => /^(?:code|code-insiders)\.exe$/i.test(record.name)),
    verseLanguageServerRunning: processes.some(record => record.name.toLowerCase() === 'verse-lsp.exe'),
    activeProjectPath,
  };
  const workflowDiscovery = await discoverVerseCompiler({ projectPath: options.projectPath, preferredProcessId: options.preferredProcessId, system: options.compilerSystem });
  const installation: ToolchainInstallation = {
    uefnRoot,
    uefnExecutable: uefnExecutable ?? (uefnRoot ? path.join(uefnRoot, 'FortniteGame', 'Binaries', 'Win64', UEFN_PROCESS_NAME) : undefined),
    uefnVersion: version.version,
    uefnBuildId: version.buildId,
    verseExtensionPath: languageServer?.extensionPath,
    verseExtensionVersion: languageServer?.extensionVersion,
    verseLanguageServerPath: languageServer?.languageServerPath,
    verseLanguageServerVersion: languageServer?.languageServerVersion,
    workflowServerModuleRegistered: flags.workflow,
    verseCompilerModuleRegistered: flags.compiler,
    commandletExecutable: dedicatedCommandlet,
    dedicatedCommandletExecutableAvailable: Boolean(dedicatedCommandlet),
  };
  return {
    platform: process.platform,
    installation,
    runtime,
    metadata: options.metadata,
    backends: describeBackends(installation, runtime, workflowDiscovery.sessions.length > 0),
  };
}
