/**
 * Fireworks AI provider plugin
 *
 * 文档：https://docs.fireworks.ai
 */

import type { ProviderPlugin } from "../../core/types.js";

export const fireworksPlugin: ProviderPlugin = {
  id: "fireworks",
  displayName: "Fireworks AI",
  authType: "api-key",
  defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
  defaultApi: "openai-completions",
};
