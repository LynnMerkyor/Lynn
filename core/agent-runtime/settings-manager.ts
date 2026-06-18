export class SettingsManager {
  private values = new Map<string, unknown>();

  constructor(initial?: Record<string, unknown>) {
    for (const [key, value] of Object.entries(initial || {})) {
      this.values.set(key, value);
    }
  }

  static create(initial?: Record<string, unknown>): SettingsManager {
    return new SettingsManager(initial);
  }

  static inMemory(initial?: Record<string, unknown>): SettingsManager {
    return new SettingsManager(initial);
  }

  get<T = unknown>(key: string, fallback?: T): T {
    return (this.values.has(key) ? this.values.get(key) : fallback) as T;
  }

  set(key: string, value: unknown): void {
    this.values.set(key, value);
  }

  delete(key: string): void {
    this.values.delete(key);
  }

  getActiveModel(): unknown {
    return this.get("activeModel");
  }

  setActiveModel(value: unknown): void {
    this.set("activeModel", value);
  }

  getThinkingLevel(): unknown {
    return this.get("thinkingLevel", "medium");
  }

  setThinkingLevel(value: unknown): void {
    this.set("thinkingLevel", value);
  }
}
