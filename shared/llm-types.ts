export type BuiltinProviderId =
  | "anthropic"
  | "baichuan"
  | "baidu-cloud"
  | "brain"
  | "dashscope"
  | "dashscope-coding"
  | "deepseek"
  | "fireworks"
  | "gemini"
  | "groq"
  | "hunyuan"
  | "infini"
  | "kimi-coding"
  | "local-qwen35-9b-q4km-imatrix"
  | "minimax"
  | "minimax-coding"
  | "minimax-oauth"
  | "mistral"
  | "modelscope"
  | "moonshot"
  | "ollama"
  | "openai"
  | "openai-codex-oauth"
  | "openrouter"
  | "perplexity"
  | "siliconflow"
  | "stepfun"
  | "stepfun-coding"
  | "tencent-coding"
  | "together"
  | "volcengine"
  | "volcengine-coding"
  | "xai"
  | "zhipu"
  | "zhipu-coding";

export type ProviderId = BuiltinProviderId | (string & {});
export type ModelId = string & {};

export type LLMApi =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-responses"
  | "openai-codex-responses"
  | (string & {});

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

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool" | "developer" | (string & {});
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
  throwOnReasoningOnly?: boolean;
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
