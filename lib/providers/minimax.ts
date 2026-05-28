/**
 * MiniMax provider plugin (API key)
 *
 * MiniMax 按量付费 API 接入。与 minimax-oauth（走 OAuth）是同一厂商的不同接入方式。
 * 文档：https://platform.minimax.io/docs
 */

import type { ProviderPlugin } from "../../core/types.js";

export const minimaxPlugin: ProviderPlugin = {
  id: "minimax",
  displayName: "MiniMax",
  authType: "api-key",
  defaultBaseUrl: "https://api.minimaxi.com/v1",
  defaultApi: "openai-completions",
};
