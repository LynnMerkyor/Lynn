/**
 * xAI (Grok) provider plugin
 *
 * 文档：https://docs.x.ai
 */

import type { ProviderPlugin } from "../../core/types.js";

export const xaiPlugin: ProviderPlugin = {
  id: "xai",
  displayName: "xAI (Grok)",
  authType: "api-key",
  defaultBaseUrl: "https://api.x.ai/v1",
  defaultApi: "openai-completions",
};
