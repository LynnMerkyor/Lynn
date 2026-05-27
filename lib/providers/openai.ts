/**
 * OpenAI provider plugin
 */

import type { ProviderPlugin } from "../../core/types.js";

export const openaiPlugin: ProviderPlugin = {
  id: "openai",
  displayName: "OpenAI",
  authType: "api-key",
  defaultBaseUrl: "https://api.openai.com/v1",
  defaultApi: "openai-completions",
};
