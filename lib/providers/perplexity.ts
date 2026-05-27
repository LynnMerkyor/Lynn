/**
 * Perplexity provider plugin
 *
 * 搜索增强 LLM。
 * 文档：https://docs.perplexity.ai
 */

import type { ProviderPlugin } from "../../core/types.js";

export const perplexityPlugin: ProviderPlugin = {
  id: "perplexity",
  displayName: "Perplexity",
  authType: "api-key",
  defaultBaseUrl: "https://api.perplexity.ai",
  defaultApi: "openai-completions",
};
