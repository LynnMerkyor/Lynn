export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export const KNOWN_LONG_FLAGS = new Set([
  "agent", "agent-command", "api-base", "api-key", "apply", "approval", "ask", "audio",
  "base-url", "best", "brain-dir", "brain-url", "brief", "classic", "command", "content",
  "continue", "cwd", "data-dir", "duration", "end-silence-ms", "endurance", "exhaustive",
  "expect", "fast", "file", "force-escalate", "force-fail", "help", "id", "idle-timeout",
  "idle-timeout-ms", "image", "images", "json", "json-boundary-stop", "jsonl", "language",
  "legacy-tui", "list-tools", "long", "loop", "max-bytes", "max-seconds", "max-steps", "mock",
  "mock-brain", "mock-escape-output", "mock-fail", "mock-worker-output", "model", "no-ink",
  "no-route-smoke", "no-save-session", "no-send", "no-session", "no-speak", "offline", "once",
  "out", "output", "path", "pattern", "plain", "preset", "print", "prompt", "provider", "ptt",
  "push-to-talk", "query", "reasoning", "record", "resume", "rewind", "sandbox", "save-session",
  "seconds", "send", "server-url", "session", "shot", "show-reasoning", "silence-rms", "speak",
  "speech-rms", "speed", "steps", "stop-at-json", "task", "task-class", "text", "text-only",
  "timeout", "timeout-ms", "title", "tool", "transcribe-only", "tts", "ultra", "ultra-concurrency",
  "ultra-max-subtasks", "ultra-verify", "version", "voice", "voice-file", "voice-stdin",
  "worker-repair-rounds", "worktree",
]);

export function findUnknownLongFlags(argv: readonly string[]): string[] {
  const unknown = new Set<string>();
  for (const token of argv) {
    if (token === "--") break;
    if (!token.startsWith("--") || token === "--") continue;
    const body = token.slice(2);
    const name = flagName(body.includes("=") ? body.slice(0, body.indexOf("=")) : body);
    if (name && !KNOWN_LONG_FLAGS.has(name)) unknown.add(name);
  }
  return [...unknown];
}

export function suggestLongFlag(unknown: string): string | null {
  let best: { name: string; distance: number } | null = null;
  for (const name of KNOWN_LONG_FLAGS) {
    const distance = editDistance(unknown, name);
    if (!best || distance < best.distance) best = { name, distance };
  }
  return best && best.distance <= Math.max(2, Math.floor(unknown.length / 3)) ? best.name : null;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const previous = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[b.length];
}

function flagName(raw: string): string {
  return raw.replace(/^-+/, "");
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] || "";
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    const eq = token.indexOf("=");
    if (eq > 0) {
      flags[flagName(token.slice(0, eq))] = token.slice(eq + 1);
      continue;
    }

    const name = flagName(token);
    const next = argv[i + 1];
    const takesValue = [
      "p",
      "print",
      "prompt",
      "brain-url",
      "server-url",
      "brief",
      "task",
      "worktree",
      "id",
      "agent",
      "reasoning",
      "show-reasoning",
      "approval",
      "sandbox",
      "cwd",
      "tool",
      "path",
      "image",
      "images",
      "voice-file",
      "file",
      "audio",
      "speak",
      "tts",
      "output",
      "out",
      "voice",
      "speed",
      "record",
      "seconds",
      "duration",
      "language",
      "shot",
      "command",
      "timeout-ms",
      "timeout",
      "idle-timeout-ms",
      "idle-timeout",
      "max-seconds",
      "speech-rms",
      "silence-rms",
      "end-silence-ms",
      "query",
      "pattern",
      "max-bytes",
      "max-steps",
      "steps",
      "text",
      "content",
      "data-dir",
      "resume",
      "rewind",
      "session",
      "title",
      "agent-command",
      "preset",
      "provider",
      "base-url",
      "api-base",
      "api-key",
      "model",
      "ultra-max-subtasks",
      "ultra-concurrency",
      "expect",
      "task-class",
      "worker-repair-rounds",
      "mock-worker-output",
      "mock-escape-output",
      "escape-base-url",
      "escape-api-key",
      "escape-model",
    ].includes(name);
    if (takesValue && next && !next.startsWith("-")) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = true;
    }
  }

  const command = String(positionals.shift() || (flags.p || flags.print || flags.prompt ? "prompt" : "help"));
  return { command, positionals, flags };
}

export function getStringFlag(flags: Record<string, string | boolean>, ...names: string[]): string | null {
  for (const name of names) {
    const value = flags[name];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export function hasFlag(flags: Record<string, string | boolean>, ...names: string[]): boolean {
  return names.some((name) => flags[name] === true || typeof flags[name] === "string");
}
