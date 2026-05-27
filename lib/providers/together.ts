/**
 * Together AI provider plugin
 *
 * 文档：https://docs.together.ai
 */

import type { ProviderPlugin } from "../../core/types.js";

export const togetherPlugin: ProviderPlugin = {
  id: "together",
  displayName: "Together AI",
  authType: "api-key",
  defaultBaseUrl: "https://api.together.xyz/v1",
  defaultApi: "openai-completions",
};
