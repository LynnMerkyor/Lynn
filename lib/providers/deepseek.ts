/**
 * DeepSeek provider plugin
 */

import type { ProviderPlugin } from "../../core/types.js";

export const deepseekPlugin: ProviderPlugin = {
  id: "deepseek",
  displayName: "DeepSeek",
  authType: "api-key",
  defaultBaseUrl: "https://api.deepseek.com/v1",
  defaultApi: "openai-completions",
};
