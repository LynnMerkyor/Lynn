/**
 * Xiaomi MiMo provider plugin
 *
 * 文档：https://dev.mi.com/mimo-open-platform
 */

import type { ProviderPlugin } from "../../core/types.js";

export const mimoPlugin: ProviderPlugin = {
  id: "mimo",
  displayName: "Xiaomi (MiMo)",
  authType: "api-key",
  defaultBaseUrl: "https://api.xiaomimimo.com/v1",
  defaultApi: "openai-completions",
};
