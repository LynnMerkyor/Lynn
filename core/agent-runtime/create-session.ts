import { randomUUID } from "node:crypto";
import path from "node:path";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { sanitizeMessagesBeforePrompt } from "../session-prompt-sanitizer.js";
import type {
  AgentSessionEvent,
  AgentSessionEventListener,
  Api,
  ChatAssistantToolCall,
  ChatMessage,
  ImageContent,
  LoadExtensionsResult,
  MessageContent,
  Model,
  PromptOptions,
  ResourceLoader,
  TextContent,
  ThinkingLevel,
  Tool,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "./types.js";

export interface LynnCreateAgentSessionOptions {
  cwd?: string;
  agentDir?: string;
  authStorage?: unknown;
  modelRegistry?: ModelRegistry;
  model?: Model | null;
  thinkingLevel?: ThinkingLevel;
  scopedModels?: Record<string, unknown>;
  tools?: ToolDefinition[];
  customTools?: ToolDefinition[];
  resourceLoader?: ResourceLoader;
  sessionManager?: SessionManager;
  settingsManager?: SettingsManager;
  requestHeaders?: Record<string, string>;
  requestMetadata?: Record<string, unknown>;
  [key: string]: unknown;
}

type RuntimeTool = ToolDefinition & {
  execute?: (toolCallId: string, params: unknown, runtime?: unknown) => Promise<ToolResult> | ToolResult;
};

type StreamToolCallAccumulator = {
  id: string;
  index: number;
  name: string;
  arguments: string;
};

type OpenAiChunk = {
  object?: string;
  type?: string;
  meta?: Record<string, unknown>;
  tool_progress?: Record<string, unknown>;
  error?: unknown;
  code?: unknown;
  choices?: Array<{
    delta?: Record<string, unknown>;
    message?: Record<string, unknown>;
    finish_reason?: string | null;
  }>;
  usage?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      const record = asRecord(part);
      if (typeof record.text === "string") return record.text;
      return "";
    }).join("");
  }
  return content == null ? "" : String(content);
}

function maybeJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return String(value ?? "");
  }
}

function normalizeToolResult(result: unknown): ToolResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { content: [{ type: "text", text: String(result ?? "") }] };
  }
  const record = result as ToolResult;
  if (Array.isArray(record.content)) return record;
  if (typeof record.text === "string") return { ...record, content: [{ type: "text", text: record.text }] };
  return record;
}

function toolResultToMessageContent(result: ToolResult): string {
  if (Array.isArray(result.content) && result.content.length) {
    return result.content.map((part) => {
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.data === "string") return `[${part.type || "data"}:${part.mimeType || "unknown"}]`;
      return maybeJson(part);
    }).filter(Boolean).join("\n");
  }
  if (result.details !== undefined) return maybeJson(result.details);
  return maybeJson(result);
}

function eventTextDelta(text: string): AgentSessionEvent {
  return {
    type: "message_update",
    role: "assistant",
    assistantMessageEvent: { type: "text_delta", text, delta: text } as any,
  };
}

function eventThinkingDelta(text: string): AgentSessionEvent {
  return {
    type: "message_update",
    role: "assistant",
    assistantMessageEvent: { type: "thinking_delta", text, delta: text } as any,
  };
}

function eventError(error: string): AgentSessionEvent {
  return {
    type: "message_update",
    role: "assistant",
    assistantMessageEvent: { type: "error", error },
  };
}

function normalizeTools(tools: ToolDefinition[] | undefined): RuntimeTool[] {
  return (tools || [])
    .filter((tool): tool is RuntimeTool => !!tool && typeof tool.name === "string" && !!tool.name)
    .map((tool) => ({ ...tool }));
}

function toolToOpenAi(tool: RuntimeTool): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.parameters || { type: "object", properties: {} },
    },
  };
}

function isImagePart(part: unknown): part is ImageContent {
  const record = asRecord(part);
  return record.type === "image" || record.type === "image_url" || Boolean(record.source);
}

function imagePartToOpenAi(part: ImageContent | Record<string, unknown>): Record<string, unknown> {
  const record = asRecord(part);
  if (record.type === "image_url") return record;
  const source = asRecord(record.source);
  const mediaType = String(record.mediaType || record.mimeType || source.media_type || source.mimeType || "image/png");
  const data = String(record.data || source.data || "");
  if (data.startsWith("data:")) return { type: "image_url", image_url: { url: data } };
  return { type: "image_url", image_url: { url: `data:${mediaType};base64,${data}` } };
}

function contentToOpenAi(content: MessageContent | undefined): string | Array<Record<string, unknown>> {
  if (typeof content === "string" || content === undefined) return content || "";
  if (!Array.isArray(content)) return String(content);
  return content.map((part) => {
    if (typeof part === "string") return { type: "text", text: part };
    if (isImagePart(part)) return imagePartToOpenAi(part as ImageContent);
    const record = asRecord(part);
    if (record.type === "text") return { type: "text", text: String(record.text || "") };
    if (typeof record.text === "string") return { type: "text", text: record.text };
    return { type: "text", text: maybeJson(record) };
  });
}

function sanitizeMessagesForProvider(messages: ChatMessage[], model: Model): ChatMessage[] {
  const provider = String(model.provider || "").toLowerCase();
  const isDeepSeek = provider.includes("deepseek") || /^deepseek-/i.test(model.id || "");
  const next: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const text = contentToText(message.content).trim();
      const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
      if (!text && !hasToolCalls) continue;
      if (isDeepSeek) {
        const { reasoning_content: _drop, ...rest } = message;
        next.push(rest);
        continue;
      }
    }
    next.push({ ...message });
  }
  return next;
}

function toOpenAiMessages(messages: ChatMessage[], model: Model): Record<string, unknown>[] {
  return sanitizeMessagesForProvider(messages, model).map((message) => {
    const record: Record<string, unknown> = {
      role: message.role,
      content: contentToOpenAi(message.content),
    };
    if (message.name) record.name = message.name;
    if (message.tool_call_id) record.tool_call_id = message.tool_call_id;
    if (message.tool_calls?.length) record.tool_calls = message.tool_calls;
    return record;
  });
}

function baseUrlFor(model: Model): string {
  const raw = String(model.baseUrl || model.baseURL || "").replace(/\/+$/, "");
  if (!raw) throw new Error(`Model ${model.provider}/${model.id} has no baseUrl`);
  return raw;
}

function chatCompletionsUrl(model: Model): string {
  const base = baseUrlFor(model);
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

function thinkingPayload(model: Model, level: ThinkingLevel | undefined): Record<string, unknown> {
  const raw = String(level || "auto").toLowerCase();
  if (!raw || raw === "none" || raw === "off" || raw === "false" || raw === "disabled") return {};
  const provider = String(model.provider || "").toLowerCase();
  const format = String((model.compat as any)?.thinkingFormat || "");
  if (format === "qwen" || model.quirks?.includes("enable_thinking")) return { enable_thinking: true };
  if (format === "zai" || provider.includes("glm") || provider.includes("zai")) {
    return { thinking: { type: raw === "auto" ? "auto" : "enabled" } };
  }
  if (format === "deepseek" || provider.includes("deepseek")) return { reasoning_effort: raw === "auto" ? "low" : raw };
  return { reasoning_effort: raw === "auto" ? "low" : raw };
}

function buildRequestBody(
  model: Model,
  messages: ChatMessage[],
  tools: RuntimeTool[],
  thinkingLevel: ThinkingLevel | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: model.id,
    messages: toOpenAiMessages(messages, model),
    stream: true,
  };
  const maxTokens = Number(model.maxTokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = Math.min(maxTokens, 64_000);
  if (tools.length) {
    body.tools = tools.map(toolToOpenAi);
    body.tool_choice = "auto";
  }
  Object.assign(body, thinkingPayload(model, thinkingLevel));
  return body;
}

function parseSseBlocks(buffer: string): { payloads: string[]; rest: string } {
  const payloads: string[] = [];
  let cursor = 0;
  while (true) {
    const idx = buffer.indexOf("\n\n", cursor);
    if (idx < 0) break;
    const block = buffer.slice(cursor, idx);
    cursor = idx + 2;
    const data = block
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) payloads.push(data);
  }
  return { payloads, rest: buffer.slice(cursor) };
}

function parsePayload(payload: string): OpenAiChunk | null {
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as OpenAiChunk;
  } catch {
    return null;
  }
}

function appendToolDelta(map: Map<number, StreamToolCallAccumulator>, raw: unknown, fallbackIndex: number): void {
  const record = asRecord(raw);
  const index = typeof record.index === "number" ? record.index : fallbackIndex;
  const current = map.get(index) || {
    id: typeof record.id === "string" && record.id ? record.id : `call_${index}_${randomUUID().slice(0, 8)}`,
    index,
    name: "",
    arguments: "",
  };
  if (typeof record.id === "string" && record.id) current.id = record.id;
  const fn = asRecord(record.function || record.functionCall);
  if (typeof fn.name === "string" && fn.name) current.name = fn.name;
  if (typeof fn.arguments === "string") current.arguments += fn.arguments;
  map.set(index, current);
}

function finalizeToolCalls(map: Map<number, StreamToolCallAccumulator>): ToolCall[] {
  return [...map.values()]
    .sort((a, b) => a.index - b.index)
    .filter((entry) => entry.name.trim())
    .map((entry) => ({
      id: entry.id,
      type: "function",
      function: {
        name: entry.name.trim(),
        arguments: entry.arguments || "{}",
      },
    }));
}

function isExecutableToolCall(toolCall: ToolCall | null | undefined): toolCall is ToolCall {
  return Boolean(toolCall?.id && toolCall.function?.name?.trim());
}

function safeJsonParse(value: string): unknown {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return { _raw: value };
  }
}

function roleMessage(role: ChatMessage["role"], content: MessageContent): ChatMessage {
  return { role, content };
}

function buildPromptUserContent(prompt: string, options?: PromptOptions): MessageContent {
  const images = Array.isArray(options?.images) ? options.images as ImageContent[] : [];
  if (!images.length) return prompt;
  const parts: Array<TextContent | ImageContent> = [{ type: "text", text: prompt }];
  for (const image of images) parts.push(image);
  return parts;
}

async function maybeString(value: unknown): Promise<string> {
  const resolved = await value;
  return typeof resolved === "string" ? resolved : "";
}

export class LynnAgentSession {
  readonly cwd: string;
  readonly sessionManager: SessionManager;
  readonly settingsManager: SettingsManager;
  readonly resourceLoader: ResourceLoader;
  readonly modelRegistry?: ModelRegistry;
  readonly scopedModels?: Record<string, unknown>;
  readonly requestHeaders: Record<string, string>;
  readonly requestMetadata?: Record<string, unknown>;
  readonly messages: ChatMessage[] = [];
  readonly agent: { state: { messages: ChatMessage[] }; replaceMessages: (messages: ChatMessage[]) => void };
  retryAttempt = 0;
  isStreaming = false;
  model: Model;
  thinkingLevel: ThinkingLevel;
  _customTools: RuntimeTool[];
  _baseToolsOverride: RuntimeTool[] | Record<string, RuntimeTool> | null = null;

  private tools: RuntimeTool[];
  private listeners = new Set<AgentSessionEventListener>();
  private abortController: AbortController | null = null;
  private pendingPrompts: Array<{ prompt: string; options?: PromptOptions }> = [];
  private disposed = false;

  constructor(options: LynnCreateAgentSessionOptions = {}) {
    this.cwd = path.resolve(options.cwd || process.cwd());
    this.sessionManager = options.sessionManager || SessionManager.create(this.cwd);
    this.settingsManager = options.settingsManager || SettingsManager.inMemory();
    this.resourceLoader = options.resourceLoader || new DefaultResourceLoader({ cwd: this.cwd, agentDir: options.agentDir });
    this.modelRegistry = options.modelRegistry;
    const fallbackModel = this.modelRegistry?.getAll?.()[0] || {
      provider: "brain",
      id: "default",
      api: "openai-completions" as Api,
      baseUrl: "",
      apiKey: "local",
    };
    this.model = (options.model || fallbackModel) as Model;
    this.thinkingLevel = options.thinkingLevel || "auto";
    this.scopedModels = options.scopedModels as Record<string, unknown> | undefined;
    this.requestHeaders = options.requestHeaders || {};
    this.requestMetadata = options.requestMetadata;
    this.tools = normalizeTools(options.tools);
    this._customTools = normalizeTools(options.customTools);
    this.agent = {
      state: { messages: this.messages },
      replaceMessages: (messages: ChatMessage[]) => {
        this.messages.splice(0, this.messages.length, ...messages);
        this.agent.state.messages = this.messages;
      },
    };
    this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.abort();
    this.listeners.clear();
  }

  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.isStreaming = false;
  }

  clearQueue(): void {
    this.pendingPrompts = [];
  }

  async prompt(prompt: string, options?: PromptOptions): Promise<void> {
    if (this.isStreaming) {
      const behavior = String(options?.streamingBehavior || "");
      if (behavior === "steer" || behavior === "followUp") {
        this.pendingPrompts.push({
          prompt,
          options: { ...options, streamingBehavior: undefined },
        });
        return;
      }
      throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
    }
    const userMessage = roleMessage("user", buildPromptUserContent(prompt, options));
    this.sessionManager.appendMessage(userMessage);
    this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
    await this.runTurn();
  }

  async steer(prompt: string, options?: PromptOptions): Promise<void> {
    return this.prompt(prompt, { ...options, streamingBehavior: "steer" });
  }

  async followUp(prompt: string, options?: PromptOptions): Promise<void> {
    return this.prompt(prompt, { ...options, streamingBehavior: "followUp" });
  }

  async sendUserMessage(prompt: string, options?: PromptOptions): Promise<void> {
    return this.prompt(prompt, options);
  }

  async sendCustomMessage(message: ChatMessage): Promise<void> {
    this.sessionManager.appendMessage(message);
    this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
  }

  async compact(): Promise<void> {
    this.emit({ type: "auto_compaction_end" });
  }

  async newSession(): Promise<void> {
    this.agent.replaceMessages([]);
  }

  setModel(model: Model): void {
    this.model = model;
    this.sessionManager.appendModelChange(model.provider, model.id);
  }

  cycleModel(): Model {
    const models = this.modelRegistry?.getAll?.() || [];
    if (!models.length) return this.model;
    const index = Math.max(0, models.findIndex((candidate) => candidate.provider === this.model.provider && candidate.id === this.model.id));
    this.setModel(models[(index + 1) % models.length]);
    return this.model;
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.thinkingLevel = level;
    this.sessionManager.appendThinkingLevelChange(String(level));
  }

  cycleThinkingLevel(): ThinkingLevel {
    const levels = this.getAvailableThinkingLevels();
    const index = Math.max(0, levels.indexOf(this.thinkingLevel));
    const next = levels[(index + 1) % levels.length];
    this.setThinkingLevel(next);
    return next;
  }

  getAvailableThinkingLevels(): ThinkingLevel[] {
    return ["none", "low", "medium", "high", "auto"];
  }

  supportsThinking(): boolean {
    return this.model.reasoning === true;
  }

  supportsXhighThinking(): boolean {
    return false;
  }

  setSteeringMode(): void {}
  setFollowUpMode(): void {}

  getAllTools(): RuntimeTool[] {
    const override = this._baseToolsOverride;
    const base = Array.isArray(override)
      ? override
      : override && typeof override === "object"
        ? Object.values(override)
        : this.tools;
    return [...base, ...this._customTools];
  }

  getActiveToolNames(): string[] {
    return this.getAllTools().map((tool) => tool.name);
  }

  setActiveToolsByName(names: string[]): void {
    const allow = new Set(names);
    this._baseToolsOverride = Object.fromEntries(this.tools.filter((tool) => allow.has(tool.name)).map((tool) => [tool.name, tool]));
  }

  getSessionStats(): Record<string, unknown> {
    return { messages: this.messages.length, model: `${this.model.provider}/${this.model.id}` };
  }

  getContextUsage(): Record<string, unknown> {
    return { usedTokens: 0, maxTokens: this.model.contextWindow || 0 };
  }

  _buildRuntime(opts?: { activeToolNames?: string[] }): Record<string, unknown> {
    if (Array.isArray(opts?.activeToolNames) && this._baseToolsOverride == null) this.setActiveToolsByName(opts.activeToolNames);
    return { cwd: this.cwd, session: this, sessionManager: this.sessionManager };
  }

  private emit(event: AgentSessionEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Listener failures should not break the turn.
      }
    }
  }

  private async runTurn(): Promise<void> {
    this.isStreaming = true;
    this.abortController = new AbortController();
    try {
      const system = [
        await maybeString(this.resourceLoader.getSystemPrompt?.()),
        await maybeString(this.resourceLoader.getAppendSystemPrompt?.()),
      ].filter(Boolean).join("\n\n");
      const rawContext = this.sessionManager.buildSessionContext().messages || [];
      const sanitizedContext = sanitizeMessagesBeforePrompt(rawContext);
      if (sanitizedContext.removed > 0 || sanitizedContext.rewritten > 0) {
        this.agent.replaceMessages(sanitizedContext.messages);
      }
      const baseContext = sanitizedContext.messages;
      const messages: ChatMessage[] = system ? [{ role: "system", content: system }, ...baseContext] : [...baseContext];
      const maxToolRounds = 8;
      for (let round = 0; round < maxToolRounds; round += 1) {
        const result = await this.callModel(messages);
        result.toolCalls = result.toolCalls.filter(isExecutableToolCall);
        if (result.assistant.content || result.assistant.tool_calls?.length) {
          messages.push(result.assistant);
        }
        if (!result.toolCalls.length) {
          const content = contentToText(result.assistant.content);
          const finalContent = content.trim()
            ? content
            : "模型这次没有返回可见内容。本轮已安全结束，避免空回复污染后续上下文；请点击「编辑重发」重试，或换个更明确的问题。";
          if (!content.trim()) this.emit(eventTextDelta(finalContent));
          const finalMessage: ChatMessage = {
            role: "assistant",
            content: finalContent,
            reasoning_content: result.reasoning || undefined,
          };
          this.sessionManager.appendMessage(finalMessage);
          this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
          this.emit({ type: "message_end", role: "assistant", message: finalMessage });
          this.emit({ type: "agent_end", messages: this.messages });
          return;
        }
        const assistantForHistory: ChatMessage = {
          role: "assistant",
          content: result.assistant.content || "",
          tool_calls: result.toolCalls as ChatAssistantToolCall[],
        };
        this.sessionManager.appendMessage(assistantForHistory);
        this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
        for (const toolCall of result.toolCalls) {
          const toolResult = await this.executeToolCall(toolCall);
          const content = toolResultToMessageContent(toolResult);
          const toolMessage: ChatMessage = {
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content,
          };
          messages.push(toolMessage);
          this.sessionManager.appendMessage(toolMessage);
        }
        this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
      }
      const fallback = "工具链已执行多轮但没有形成最终回复。本轮已安全结束，请缩小问题范围后重试。";
      const fallbackMessage: ChatMessage = { role: "assistant", content: fallback };
      this.emit(eventTextDelta(fallback));
      this.sessionManager.appendMessage(fallbackMessage);
      this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
      this.emit({ type: "message_end", role: "assistant", message: fallbackMessage });
      this.emit({ type: "agent_end", messages: this.messages });
    } catch (err) {
      if ((err as any)?.name === "AbortError") {
        this.emit(eventError("aborted"));
      } else {
        this.emit(eventError(err instanceof Error ? err.message : String(err)));
      }
      this.emit({ type: "agent_end", messages: this.messages });
    } finally {
      this.isStreaming = false;
      this.abortController = null;
      this.drainPendingPrompts();
    }
  }

  private drainPendingPrompts(): void {
    if (this.disposed || this.isStreaming || this.pendingPrompts.length === 0) return;
    const next = this.pendingPrompts.shift();
    if (!next) return;
    void this.prompt(next.prompt, next.options);
  }

  private async callModel(messages: ChatMessage[]): Promise<{ assistant: ChatMessage; toolCalls: ToolCall[]; reasoning: string }> {
    const tools = this.getAllTools();
    const body = buildRequestBody(this.model, messages, tools, this.thinkingLevel);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...this.requestHeaders,
    };
    if (this.model.apiKey && !headers.authorization && !headers.Authorization) {
      headers.authorization = `Bearer ${this.model.apiKey}`;
    }
    const response = await fetch(chatCompletionsUrl(this.model), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: this.abortController?.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`LLM request failed: ${response.status} ${response.statusText}${text ? ` · ${text.slice(0, 500)}` : ""}`);
    }
    if (!response.body) throw new Error("LLM response did not include a stream body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolDeltas = new Map<number, StreamToolCallAccumulator>();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseBlocks(buffer);
      buffer = parsed.rest;
      for (const payload of parsed.payloads) {
        if (payload === "[DONE]") continue;
        this.handleLynnSideEvent(payload);
        const chunk = parsePayload(payload);
        if (!chunk) continue;
        if (chunk.error && !chunk.choices) throw new Error(typeof chunk.error === "string" ? chunk.error : maybeJson(chunk.error));
        for (const choice of chunk.choices || []) {
          const delta = choice.delta || choice.message || {};
          const reasoning = typeof delta.reasoning_content === "string"
            ? delta.reasoning_content
            : typeof delta.reasoning === "string" ? delta.reasoning : "";
          if (reasoning) {
            reasoningParts.push(reasoning);
            this.emit(eventThinkingDelta(reasoning));
          }
          if (typeof delta.content === "string" && delta.content) {
            textParts.push(delta.content);
            this.emit(eventTextDelta(delta.content));
          }
          const rawToolCalls = delta.tool_calls || delta.toolCalls;
          if (Array.isArray(rawToolCalls)) {
            rawToolCalls.forEach((raw, index) => appendToolDelta(toolDeltas, raw, index));
          }
        }
      }
    }
    const toolCalls = finalizeToolCalls(toolDeltas);
    const content = textParts.join("");
    return {
      assistant: { role: "assistant", content, reasoning_content: reasoningParts.join("") || undefined },
      toolCalls,
      reasoning: reasoningParts.join(""),
    };
  }

  private handleLynnSideEvent(payload: string): void {
    const parsed = parsePayload(payload);
    if (!parsed) return;
    if (parsed.object === "lynn.provider") {
      this.emit({ type: "provider_meta", meta: parsed.meta || {} });
    }
    if (parsed.object === "lynn.tool_progress") {
      const progress = asRecord(parsed.tool_progress);
      this.emit({
        type: "tool_progress",
        name: String(progress.name || ""),
        event: String(progress.event || ""),
        ms: typeof progress.ms === "number" ? progress.ms : undefined,
        ok: typeof progress.ok === "boolean" ? progress.ok : undefined,
        summary: typeof progress.summary === "string" ? progress.summary : undefined,
        details: Array.isArray(progress.details) ? progress.details : undefined,
      });
    }
  }

  private async executeToolCall(toolCall: ToolCall): Promise<ToolResult> {
    const tool = this.getAllTools().find((candidate) => candidate.name === toolCall.function.name);
    const args = safeJsonParse(toolCall.function.arguments);
    this.emit({
      type: "message_update",
      role: "assistant",
      assistantMessageEvent: { type: "toolcall_start", toolCall },
    });
    this.emit({
      type: "tool_execution_start",
      toolName: toolCall.function.name,
      toolCallId: toolCall.id,
      args,
      toolCall,
    });
    if (!tool?.execute) {
      const result = { isError: true, content: [{ type: "text", text: `Tool not found: ${toolCall.function.name}` }] };
      this.emit({
        type: "tool_execution_end",
        toolName: toolCall.function.name,
        toolCallId: toolCall.id,
        args,
        result,
        isError: true,
      });
      return result;
    }
    try {
      const result = normalizeToolResult(await tool.execute(toolCall.id, args, this._buildRuntime()));
      this.emit({
        type: "tool_execution_end",
        toolName: toolCall.function.name,
        toolCallId: toolCall.id,
        args,
        result,
        isError: result.isError === true,
      });
      this.emit({
        type: "message_update",
        role: "assistant",
        assistantMessageEvent: { type: "toolcall_end", toolCall },
      });
      return result;
    } catch (err) {
      const result = {
        isError: true,
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      };
      this.emit({
        type: "tool_execution_end",
        toolName: toolCall.function.name,
        toolCallId: toolCall.id,
        args,
        result,
        isError: true,
      });
      return result;
    }
  }
}

export async function createLynnAgentSession(options: LynnCreateAgentSessionOptions = {}): Promise<{
  session: LynnAgentSession;
  extensionsResult: LoadExtensionsResult;
}> {
  const session = new LynnAgentSession(options);
  await session.resourceLoader.reload?.();
  return {
    session,
    extensionsResult: { extensions: [], diagnostics: [] },
  };
}
