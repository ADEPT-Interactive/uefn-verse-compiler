import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isLoopbackHost } from './endpoint.js';
import type { CompilerDiscoverySystem, LoopbackListener, UefnProcessInfo } from '../types.js';

const execFileAsync = promisify(execFile);
const UEFN_PROCESS_NAME = 'UnrealEditorFortnite-Win64-Shipping.exe';

export function extractProjectFile(commandLine: string | undefined): string | undefined {
  if (!commandLine) return undefined;
  return commandLine.match(/(?:^|[\s"])([A-Za-z]:[\\/][^\r\n"]+\.uefnproject)(?:["\s]|$)/i)?.[1];
}

function parseNetstatAddress(value: string): { host: string; port: number } | undefined {
  const candidate = value.trim();
  if (candidate.startsWith('[')) {
    const close = candidate.lastIndexOf(']');
    if (close < 0 || candidate[close + 1] !== ':') return undefined;
    const port = Number(candidate.slice(close + 2));
    return Number.isInteger(port) && port > 0 && port <= 65535 ? { host: candidate.slice(1, close), port } : undefined;
  }
  const separator = candidate.lastIndexOf(':');
  if (separator < 0) return undefined;
  const port = Number(candidate.slice(separator + 1));
  return Number.isInteger(port) && port > 0 && port <= 65535 ? { host: candidate.slice(0, separator), port } : undefined;
}

export function parseNetstatListeners(output: string): LoopbackListener[] {
  return output.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!match) return [];
    const address = parseNetstatAddress(match[1]);
    const processId = Number(match[2]);
    if (!address || !isLoopbackHost(address.host) || !Number.isInteger(processId) || processId < 1) return [];
    return [{ ...address, processId }];
  });
}

export function extractActiveProjectFile(logContents: string): string | undefined {
  const matches = [...logContents.matchAll(/Successfully opened project ['"]([^"\r\n]+\.uefnproject)['"]/gi)];
  return matches.at(-1)?.[1];
}

async function listUefnProcesses(): Promise<UefnProcessInfo[]> {
  if (process.platform !== 'win32') return [];
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Filter "Name = '${UEFN_PROCESS_NAME}'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`,
    ], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    const parsed = JSON.parse(stdout.trim() || '[]') as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap(row => {
      if (!row || typeof row !== 'object') return [];
      const record = row as Record<string, unknown>;
      const processId = Number(record.ProcessId);
      return Number.isInteger(processId) && processId > 0
        ? [{ processId, projectPath: extractProjectFile(typeof record.CommandLine === 'string' ? record.CommandLine : undefined) }]
        : [];
    });
  } catch {
    return [];
  }
}

async function listLoopbackListeners(): Promise<LoopbackListener[]> {
  if (process.platform !== 'win32') return [];
  try {
    const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    return parseNetstatListeners(stdout);
  } catch {
    return [];
  }
}

async function readActiveProjectFile(): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return undefined;
  const logPath = `${localAppData}\\UnrealEditorFortnite\\Saved\\Logs\\UnrealEditorFortnite.log`;
  try {
    const escapedPath = logPath.replace(/'/g, "''");
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$p = '${escapedPath}'; if (Test-Path -LiteralPath $p) { Get-Content -LiteralPath $p -Raw }`,
    ], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return extractActiveProjectFile(stdout);
  } catch {
    return undefined;
  }
}

export const windowsDiscoverySystem: CompilerDiscoverySystem = {
  listUefnProcesses,
  listLoopbackListeners,
  readActiveProjectFile,
};
