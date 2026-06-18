import fs from "node:fs";
import path from "node:path";
import type { ResourceLoader } from "./types.js";

export class DefaultResourceLoader implements ResourceLoader {
  [key: string]: unknown;

  private readonly cwd: string;
  private readonly agentDir: string;
  private appendPrompt = "";

  constructor(options: { cwd?: string; agentDir?: string; [key: string]: unknown } = {}) {
    this.cwd = options.cwd || process.cwd();
    this.agentDir = options.agentDir || path.join(process.env.HOME || this.cwd, ".lynn");
  }

  async reload(): Promise<void> {
    const candidates = [
      path.join(this.cwd, "CLAUDE.md"),
      path.join(this.cwd, "AGENTS.md"),
      path.join(this.agentDir, "MEMORY.md"),
    ];
    const parts: string[] = [];
    for (const file of candidates) {
      try {
        const text = fs.readFileSync(file, "utf8").trim();
        if (text) parts.push(text);
      } catch {
        // Optional project memory files are best-effort.
      }
    }
    this.appendPrompt = parts.join("\n\n");
  }

  getAppendSystemPrompt(): string {
    return this.appendPrompt;
  }

  getSystemPrompt(): string {
    return this.appendPrompt;
  }

  getSkills(): unknown[] {
    return [];
  }
}
