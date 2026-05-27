/**
 * Google Gemini provider plugin
 *
 * 通过 OpenAI 兼容接口接入。
 * 文档：https://ai.google.dev/gemini-api/docs/openai
 */

import type { ProviderPlugin } from "../../core/types.js";

export const geminiPlugin: ProviderPlugin = {
  id: "gemini",
  displayName: "Google Gemini",
  authType: "api-key",
  defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  defaultApi: "openai-completions",
};
