/**
 * Mistral AI provider plugin
 *
 * 文档：https://docs.mistral.ai
 */

import type { ProviderPlugin } from "../../core/types.js";

export const mistralPlugin: ProviderPlugin = {
  id: "mistral",
  displayName: "Mistral AI",
  authType: "api-key",
  defaultBaseUrl: "https://api.mistral.ai/v1",
  defaultApi: "openai-completions",
};
