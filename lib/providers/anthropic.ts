/**
 * Anthropic provider plugin (API key)
 */

import type { ProviderPlugin } from "../../core/types.js";

export const anthropicPlugin: ProviderPlugin = {
  id: "anthropic",
  displayName: "Anthropic",
  authType: "api-key",
  defaultBaseUrl: "https://api.anthropic.com",
  defaultApi: "anthropic-messages",
};
