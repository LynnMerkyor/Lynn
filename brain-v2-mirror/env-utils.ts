// Brain v2 · env parsing helpers

export function positiveEnvNumber(key: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[key];
  const value = Number(raw === undefined || raw === '' ? fallback : raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
