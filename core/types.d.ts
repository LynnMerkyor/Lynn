export type ProviderId = string;
export type ModelId = string;

export type LLMApi =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-responses"
  | "openai-codex-responses"
  | string;

export type ProviderAuthType = "api-key" | "oauth" | "none" | string;

export interface ProviderModelEntry {
  id: ModelId;
  name?: string;
  context?: number;
  maxOutput?: number;
}

export interface ProviderConfig {
  api_key?: string;
  base_url?: string;
  api?: LLMApi;
  display_name?: string;
  auth_type?: ProviderAuthType;
  models?: Array<ModelId | ProviderModelEntry>;
  [key: string]: unknown;
}

export interface ProviderPlugin {
  id: ProviderId;
  displayName: string;
  authType: ProviderAuthType;
  defaultBaseUrl: string;
  defaultApi: LLMApi;
  authJsonKey?: ProviderId;
}

export interface ProviderEntry {
  id: ProviderId;
  displayName: string;
  authType: ProviderAuthType;
  baseUrl: string;
  api: LLMApi;
  authJsonKey?: ProviderId;
  isBuiltin: boolean;
}

export interface ProviderCredentials {
  apiKey: string;
  baseUrl: string;
  api: LLMApi;
}

export interface ProviderCredentialsSnake {
  api_key: string;
  base_url: string;
  api: LLMApi;
}

export type LLMRole = "system" | "user" | "assistant" | "tool" | "developer" | string;

export interface LLMContentBlock {
  type?: string;
  text?: string | { value?: string; text?: string };
  value?: string;
  refusal?: string;
  thinking?: string;
  reasoning?: string | Record<string, unknown>;
  reasoning_content?: string | unknown[];
  [key: string]: unknown;
}

export interface ToolCall {
  id?: string;
  type?: string;
  index?: number;
  name?: string;
  input?: unknown;
  arguments?: string | Record<string, unknown>;
  function?: {
    name?: string;
    arguments?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ToolResult {
  toolCallId?: string;
  tool_call_id?: string;
  name?: string;
  content?: string | LLMContentBlock[];
  output?: unknown;
  isError?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface LLMMessage {
  role: LLMRole;
  content?: string | Array<string | LLMContentBlock> | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  refusal?: string;
  reasoning?: string | Record<string, unknown>;
  reasoning_content?: string | unknown[];
  [key: string]: unknown;
}

export interface LLMRequest {
  api: LLMApi;
  apiKey?: string;
  baseUrl: string;
  model: ModelId;
  provider?: ProviderId;
  quirks?: string[];
  reasoning?: boolean;
  systemPrompt?: string;
  messages?: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  requestHeaders?: Record<string, string> | null;
}

export interface LLMChoice {
  index?: number;
  finish_reason?: string | null;
  message?: LLMMessage;
  delta?: Partial<LLMMessage>;
  [key: string]: unknown;
}

export interface LLMResponse {
  id?: string;
  model?: ModelId;
  choices?: LLMChoice[];
  content?: string | Array<string | LLMContentBlock>;
  output_text?: string;
  output?: Array<LLMMessage | LLMContentBlock | Record<string, unknown>>;
  error?: { message?: string; [key: string]: unknown };
  message?: string;
  [key: string]: unknown;
}

export interface ExecutionRoute {
  modelId: ModelId;
  providerId: ProviderId;
  api: LLMApi;
  apiKey: string;
  baseUrl: string;
}

export interface UtilityRoute {
  model: ModelId;
  provider: ProviderId;
  api: LLMApi;
  api_key: string;
  base_url: string;
  allow_missing_api_key?: boolean;
}

export interface UtilityExecutionConfig {
  utility: ModelId;
  utility_provider: ProviderId;
  utility_allow_missing_api_key: boolean;
  utility_large: ModelId;
  utility_large_provider: ProviderId;
  utility_large_allow_missing_api_key: boolean;
  api_key: string;
  base_url: string;
  api: LLMApi;
  large_api_key: string;
  large_base_url: string;
  large_api: LLMApi;
  utility_fallbacks: UtilityRoute[];
  utility_large_fallbacks: UtilityRoute[];
}

export interface ResolvedModel {
  id: ModelId;
  name?: string;
  provider: ProviderId;
  api?: LLMApi;
  baseUrl?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  maxTokens?: number;
  reasoning?: boolean;
  quirks?: string[];
  [key: string]: unknown;
}

export type ModelRef = ModelId | { id: ModelId; provider?: ProviderId } | ResolvedModel;
