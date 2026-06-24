export function pathIdentityKey(value: string): string {
  const trimmed = String(value || '').trim().replace(/[\\/]+$/g, '');
  const slashNormalized = trimmed.replace(/\\/g, '/');
  if (/^[a-z]:/i.test(slashNormalized) || slashNormalized.startsWith('//')) {
    return slashNormalized.toLowerCase();
  }
  return slashNormalized;
}

export function uniquePathList(paths: Iterable<unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of paths) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = pathIdentityKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export function pathDisplayName(folderPath: string | null | undefined, fallback = ''): string {
  const raw = String(folderPath || '').trim();
  if (!raw) return fallback;
  const trimmed = raw.replace(/[\\/]+$/g, '');
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || trimmed || fallback || raw;
}
