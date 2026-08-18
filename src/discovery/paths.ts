function normalizeProjectPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/^["']+|["']+$/g, '').replace(/\\/g, '/');
  return normalized ? normalized.toLowerCase() : undefined;
}

export function projectPathsMatch(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeProjectPath(left);
  const normalizedRight = normalizeProjectPath(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

export { normalizeProjectPath };
