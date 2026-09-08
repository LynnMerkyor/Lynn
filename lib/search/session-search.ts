import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

export interface SessionSearchHit { path: string; snippet: string; role: string; }
const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();

export function searchableMessage(entry: Record<string, any>): { text: string; role: string } | null {
  if (!entry || typeof entry !== "object") return null;
  const message = entry.type === "message" ? entry.message : entry;
  if (!message || !["user", "assistant"].includes(message.role)) return null;
  const text = typeof message.content === "string" ? message.content : Array.isArray(message.content)
    ? message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n") : "";
  return { text: text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, ""), role: message.role };
}

/** Search only enumerated session files; images, tool results and reasoning are excluded. */
export async function searchSessionBodies(sessions: { path: string }[], query: string, options: {
  baseDir: string; signal?: AbortSignal; limit?: number; maxFileBytes?: number;
}): Promise<{ hits: SessionSearchHit[]; skipped: number; truncated: boolean }> {
  const needle = normalize(query);
  const result = { hits: [] as SessionSearchHit[], skipped: 0, truncated: false };
  if (!needle) return result;
  if (needle.length > 256) throw new Error("Search query is too long");
  const base = await fs.realpath(options.baseDir);
  const limit = Math.max(1, Math.min(options.limit || 50, 100));
  for (const session of sessions) {
    options.signal?.throwIfAborted();
    if (result.hits.length >= limit) { result.truncated = true; break; }
    try {
      const real = await fs.realpath(session.path);
      const relative = path.relative(base, real);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { result.skipped++; continue; }
      const stat = await fs.stat(real);
      if (!stat.isFile() || stat.size > (options.maxFileBytes ?? 50 * 1024 * 1024)) { result.skipped++; continue; }
      const stream = createReadStream(real, { encoding: "utf8", signal: options.signal });
      const reader = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of reader) {
          options.signal?.throwIfAborted();
          let entry;
          try { entry = JSON.parse(line); } catch { continue; }
          const message = searchableMessage(entry);
          if (!message) continue;
          const text = normalize(message.text);
          const index = text.indexOf(needle);
          if (index < 0) continue;
          // Use normalized text so Unicode normalization never misaligns the excerpt.
          const start = Math.max(0, index - 48);
          const end = Math.min(text.length, index + needle.length + 96);
          result.hits.push({ path: session.path, role: message.role, snippet: `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}` });
          break;
        }
      } finally { reader.close(); stream.destroy(); }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      result.skipped++;
    }
  }
  return result;
}
