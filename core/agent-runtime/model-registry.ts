import fs from "node:fs";
import path from "node:path";
import type { Api, Model } from "./types.js";
import type { AuthStorage } from "./auth-storage.js";

interface ModelsJsonModel {
  id?: string;
  name?: string;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  vision?: boolean;
  reasoning?: boolean;
  compat?: Record<string, unknown>;
  quirks?: string[];
  [key: string]: unknown;
}

interface ModelsJsonProvider {
  baseUrl?: string;
  baseURL?: string;
  api?: Api;
  apiKey?: string;
  models?: ModelsJsonModel[];
  [key: string]: unknown;
}

interface ModelsJson {
  providers?: Record<string, ModelsJsonProvider>;
}

export class ModelRegistry {
  private readonly authStorage: AuthStorage;
  private readonly modelsFile: string;
  private models: Model[] = [];
  private error: Error | null = null;

  constructor(authStorage: AuthStorage, modelsFile: string) {
    this.authStorage = authStorage;
    this.modelsFile = modelsFile;
    this.refresh();
  }

  refresh(): void {
    try {
      const json = JSON.parse(fs.readFileSync(this.modelsFile, "utf8")) as ModelsJson;
      const next: Model[] = [];
      for (const [providerId, provider] of Object.entries(json.providers || {})) {
        for (const entry of provider.models || []) {
          if (!entry?.id) continue;
          next.push({
            provider: providerId,
            id: entry.id,
            name: entry.name || entry.id,
            api: provider.api || "openai-completions",
            apiKey: provider.apiKey,
            baseUrl: provider.baseUrl || provider.baseURL,
            baseURL: provider.baseUrl || provider.baseURL,
            input: Array.isArray(entry.input) ? [...entry.input] : ["text"],
            contextWindow: typeof entry.contextWindow === "number" ? entry.contextWindow : undefined,
            maxTokens: typeof entry.maxTokens === "number" ? entry.maxTokens : undefined,
            vision: entry.vision === true,
            reasoning: entry.reasoning === true,
            compat: entry.compat,
            quirks: Array.isArray(entry.quirks) ? [...entry.quirks] : undefined,
            metadata: { source: path.basename(this.modelsFile) },
          });
        }
      }
      this.models = next;
      this.error = null;
    } catch (err) {
      this.models = [];
      this.error = err instanceof Error ? err : new Error(String(err));
    }
  }

  getError(): Error | null {
    return this.error;
  }

  getAll(): Model[] {
    return [...this.models];
  }

  async getAvailable(): Promise<Model[]> {
    return this.getAll();
  }

  find(provider: string, modelId?: string): Model | undefined {
    if (modelId) {
      return this.models.find((model) => model.provider === provider && model.id === modelId);
    }
    return this.models.find((model) => model.id === provider || `${model.provider}/${model.id}` === provider);
  }

  getApiKey(provider: string): string | undefined {
    const model = this.models.find((entry) => entry.provider === provider);
    return typeof model?.apiKey === "string" ? model.apiKey : undefined;
  }

  getApiKeyForProvider(provider: string): string | undefined {
    return this.getApiKey(provider);
  }

  isUsingOAuth(provider: string): boolean {
    return Boolean(this.authStorage.get(`oauth:${provider}`));
  }

  registerProvider(): void {
    this.refresh();
  }

  unregisterProvider(): void {
    this.refresh();
  }
}
