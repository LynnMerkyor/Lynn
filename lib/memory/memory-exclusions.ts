import fs from "fs";
import path from "path";

export interface MemoryExclusionsData {
  phrases: string[];
}

export interface MemoryFactLike {
  fact?: unknown;
  tags?: unknown;
  evidence?: unknown;
}

function normalizePhrase(value: unknown): string {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function safeReadJson<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export class MemoryExclusions {
  private _filePath: string;
  private _data: MemoryExclusionsData | null;

  constructor({ filePath }: { filePath: string }) {
    this._filePath = filePath;
    this._data = null;
  }

  private _load(): MemoryExclusionsData {
    if (this._data) return this._data;
    const raw = safeReadJson<{ phrases?: unknown } | null>(this._filePath, null);
    this._data = {
      phrases: Array.isArray(raw?.phrases)
        ? [...new Set(raw.phrases.map((item) => normalizePhrase(item)).filter(Boolean))]
        : [],
    };
    return this._data;
  }

  private _save(): void {
    const data = this._load();
    fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
    fs.writeFileSync(this._filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  list(): MemoryExclusionsData {
    const data = this._load();
    return { phrases: [...data.phrases] };
  }

  addPhrase(phrase: unknown): boolean {
    const normalized = normalizePhrase(phrase);
    if (!normalized) return false;
    const data = this._load();
    if (data.phrases.includes(normalized)) return false;
    data.phrases.push(normalized);
    this._save();
    return true;
  }

  removePhrase(phrase: unknown): boolean {
    const normalized = normalizePhrase(phrase);
    const data = this._load();
    const next = data.phrases.filter((item) => item !== normalized);
    if (next.length === data.phrases.length) return false;
    data.phrases = next;
    this._save();
    return true;
  }

  matchesFact(entry: MemoryFactLike | null | undefined): boolean {
    const data = this._load();
    if (data.phrases.length === 0) return false;
    const haystack = [
      entry?.fact || "",
      ...(Array.isArray(entry?.tags) ? entry.tags.map((item) => String(item || "")) : []),
      entry?.evidence || "",
    ].join(" ").toLowerCase();
    return data.phrases.some((phrase) => haystack.includes(phrase.toLowerCase()));
  }
}
