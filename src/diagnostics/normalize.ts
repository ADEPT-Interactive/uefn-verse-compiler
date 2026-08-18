import type { VerseCompilerDiagnostic } from '../types.js';

export function findNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record[key] === 'number') return record[key];
  for (const child of Object.values(record)) {
    const found = findNumber(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function findMessages(value: unknown): unknown[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.messages)) return record.messages;
  for (const child of Object.values(record)) {
    const found = findMessages(child);
    if (found) return found;
  }
  return undefined;
}

export function normalizeDiagnostics(messages: unknown[] | undefined): VerseCompilerDiagnostic[] {
  if (!messages) return [];
  const entries: Record<string, unknown>[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record.message === 'string') entries.push(record);
    Object.values(record).forEach(child => { if (child !== record.message) collect(child); });
  };
  messages.forEach(collect);
  return entries.map(record => {
    const rawSeverity = String(record.severity ?? record.level ?? '').toLowerCase();
    const severity = rawSeverity.includes('error') ? 'error' : rawSeverity.includes('warn') ? 'warning' : rawSeverity.includes('info') ? 'info' : rawSeverity.includes('log') ? 'log' : undefined;
    const result: VerseCompilerDiagnostic = { message: record.message as string };
    if (severity) result.severity = severity;
    if (typeof record.file === 'string') result.file = record.file;
    else if (typeof record.path === 'string') result.file = record.path;
    if (typeof record.line === 'number') result.line = record.line;
    if (typeof record.column === 'number') result.column = record.column;
    if (typeof record.code === 'string' || typeof record.code === 'number') result.code = record.code;
    return result;
  });
}
