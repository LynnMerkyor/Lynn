export function writeJsonLine(value: unknown, out: NodeJS.WritableStream = process.stdout): void {
  out.write(`${JSON.stringify(value)}\n`);
}

export function nowIso(): string {
  return new Date().toISOString();
}
