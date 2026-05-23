/**
 * Local Qwen3-4B Thinking provider plugin.
 *
 * The model is served by llama.cpp on the user's machine. Startup/download is
 * managed by /api/local-qwen35-9b/*; once smoke passes, this provider becomes a
 * normal OpenAI-compatible local model.
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const localQwen35Plugin = {
  id: "local-qwen3-4b-thinking-2507-q4km-imatrix",
  displayName: "本地 Qwen3-4B Thinking",
  authType: "none",
  defaultBaseUrl: process.env.LYNN_LOCAL_QWEN35_BASE || "http://127.0.0.1:18099/v1",
  defaultApi: "openai-completions",
};
