/**
 * OpenAI Codex OAuth provider plugin
 *
 * 通过 OAuth 接入，对应 auth.json 中的 openai-codex 条目。
 */

import type { ProviderPlugin } from "../../core/types.js";

export const openaiCodexOAuthPlugin: ProviderPlugin = {
  id: "openai-codex-oauth",
  displayName: "OpenAI Codex (OAuth)",
  authType: "oauth",
  defaultBaseUrl: "",
  defaultApi: "openai-codex-responses",
  authJsonKey: "openai-codex",
};
