/**
 * Groq provider plugin
 *
 * 超低延迟推理，支持 Llama、Mixtral 等开源模型。
 * 文档：https://console.groq.com/docs
 */

import type { ProviderPlugin } from "../../core/types.js";

export const groqPlugin: ProviderPlugin = {
  id: "groq",
  displayName: "Groq",
  authType: "api-key",
  defaultBaseUrl: "https://api.groq.com/openai/v1",
  defaultApi: "openai-completions",
};
