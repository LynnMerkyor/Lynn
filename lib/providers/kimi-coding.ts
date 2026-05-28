/**
 * Kimi Coding Plan provider plugin
 *
 * 月之暗面 Kimi 会员 Coding 权益，走 Anthropic 兼容协议。
 * 与 moonshot (OpenAI 兼容) 是同一厂商的不同接入方式。
 *
 * 文档：https://www.kimi.com/code/docs/more/third-party-agents.html
 */

import type { ProviderPlugin } from "../../core/types.js";

export const kimiCodingPlugin: ProviderPlugin = {
  id: "kimi-coding",
  displayName: "Kimi Coding Plan",
  authType: "api-key",
  defaultBaseUrl: "https://api.kimi.com/coding/",
  defaultApi: "anthropic-messages",
};
