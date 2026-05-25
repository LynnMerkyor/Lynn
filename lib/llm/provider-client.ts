/**
 * lib/llm/provider-client.js — Provider 认证 header 和连通性探测 URL 构造
 *
 * callProviderText 已迁移到 core/llm-client.js（走 Pi SDK），
 * 本文件只保留 test/health 路由需要的辅助函数。
 */

import { t } from "../../shared/i18n-runtime.js";
import { readSignedClientAgentHeaders } from "../../core/client-agent-identity.js";

export type ProviderApiProtocol =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-codex-responses"
  | "openai-responses"
  | string;

export type ProviderAuthHeaderOptions = {
  allowMissingApiKey?: boolean;
  method?: string;
  pathname?: string;
};

export type ProviderAuthHeaders = Record<string, string>;

export type ProviderProbe = {
  url: string;
  method: "GET" | "POST";
};

/**
 * 构建 provider 认证 header
 * 被 /api/providers/test 和 /api/models/health 路由使用
 */
export function buildProviderAuthHeaders(
  api: ProviderApiProtocol,
  apiKey?: string | null,
  opts: ProviderAuthHeaderOptions = {},
): ProviderAuthHeaders {
  const allowMissingApiKey = opts.allowMissingApiKey === true;
  const method = String(opts.method || "GET").toUpperCase();
  const pathname = typeof opts.pathname === "string" && opts.pathname.trim()
    ? opts.pathname.trim()
    : (api === "anthropic-messages" ? "/v1/messages" : "/models");
  if (!api) {
    throw new Error(t("error.missingApiProtocol"));
  }
  if (!apiKey && !allowMissingApiKey) {
    throw new Error(t("error.missingApiKey"));
  }

  if (api === "anthropic-messages") {
    const headers: ProviderAuthHeaders = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(allowMissingApiKey ? readSignedClientAgentHeaders({ method, pathname }) : {}),
    };
    if (apiKey) headers["x-api-key"] = apiKey;
    return headers;
  }

  if (api === "openai-completions" || api === "openai-codex-responses" || api === "openai-responses") {
    const headers: ProviderAuthHeaders = {
      "Content-Type": "application/json",
      ...(allowMissingApiKey ? readSignedClientAgentHeaders({ method, pathname }) : {}),
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    return headers;
  }

  throw new Error(t("error.unsupportedApiProtocol", { api }));
}

/**
 * 构建连通性探测 URL（统一 test/health 两条路由的 URL 逻辑）
 *
 * Anthropic 协议：POST baseUrl/v1/messages（和 Pi SDK Anthropic provider 一致）
 * OpenAI 兼容协议：GET baseUrl/models
 *
 */
export function buildProbeUrl(baseUrl: string | null | undefined, api: ProviderApiProtocol): ProviderProbe {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (api === "anthropic-messages") {
    return { url: `${base}/v1/messages`, method: "POST" };
  }
  return { url: `${base}/models`, method: "GET" };
}
