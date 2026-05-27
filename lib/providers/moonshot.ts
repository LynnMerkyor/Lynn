/**
 * Moonshot (月之暗面 / Kimi) provider plugin
 *
 * 文档：https://platform.moonshot.cn/docs/api
 */

import type { ProviderPlugin } from "../../core/types.js";

export const moonshotPlugin: ProviderPlugin = {
  id: "moonshot",
  displayName: "Moonshot (Kimi)",
  authType: "api-key",
  defaultBaseUrl: "https://api.moonshot.cn/v1",
  defaultApi: "openai-completions",
};
