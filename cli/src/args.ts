export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
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
      "shot",
      "command",
      "timeout-ms",
      "timeout",
      "query",
      "pattern",
      "max-bytes",
      "max-steps",
      "steps",
      "text",
      "content",
      "data-dir",
      "resume",
      "session",
      "title",
      "agent-command",
      "provider",
      "base-url",
      "api-base",
      "api-key",
      "model",
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
