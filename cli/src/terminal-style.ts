export function supportsColor(
  stream: Pick<NodeJS.WriteStream, "isTTY"> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isTruthy(env.LYNN_FORCE_COLOR) || isTruthy(env.FORCE_COLOR) || isTruthy(env.CLICOLOR_FORCE)) return true;
  if (isTruthy(env.LYNN_NO_COLOR)) return false;
  if (env.NO_COLOR !== undefined) return false;
  if (!stream?.isTTY) return false;
  return env.TERM !== "dumb";
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

export function red(text: string, enabled: boolean): string {
  return enabled ? `\x1b[31m${text}\x1b[0m` : text;
}

export function yellow(text: string, enabled: boolean): string {
  return enabled ? `\x1b[33m${text}\x1b[0m` : text;
}

export function orange(text: string, enabled: boolean): string {
  return enabled ? `\x1b[38;5;208m${text}\x1b[0m` : text;
}

export function cyan(text: string, enabled: boolean): string {
  return enabled ? `\x1b[36m${text}\x1b[0m` : text;
}

export function brightCyan(text: string, enabled: boolean): string {
  return enabled ? `\x1b[1;36m${text}\x1b[0m` : text;
}

export function green(text: string, enabled: boolean): string {
  return enabled ? `\x1b[32m${text}\x1b[0m` : text;
}

export function dim(text: string, enabled: boolean): string {
  return enabled ? `\x1b[2m${text}\x1b[0m` : text;
}

export function bold(text: string, enabled: boolean): string {
  return enabled ? `\x1b[1m${text}\x1b[0m` : text;
}

export function dangerLine(text: string, enabled: boolean): string {
  return orange(text, enabled);
}
