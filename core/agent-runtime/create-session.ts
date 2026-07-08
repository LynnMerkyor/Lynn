import path from "node:path";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { sanitizeMessagesBeforePrompt } from "../session-prompt-sanitizer.js";
import { normalizeToolAliasName } from "../engine-tool-runtime.js";
import {
  filterOutBrainManagedCustomTools,
  isBrainManagedCustomToolName,
} from "../brain-managed-tools.js";
import { isBrainProvider } from "../../shared/brain-provider.js";
import {
  STEP_EXECUTE_TOOL_NAME,
  ModelCallTimeoutError,
  appendToolDelta,
  asRecord,
  buildFallbackSynthesisMessages,
  buildPromptUserContent,
  buildRequestBody,
  buildStepExecutorPolicyPrompt,
  chatCompletionsUrl,
  contentToText,
  countAnyStepDelegationEvidenceToolMessages,
  countUsableStepDelegationEvidenceToolMessages,
  createTimedSignal,
  defaultModelCallTimeoutMs,
  eventError,
  eventTextDelta,
  eventThinkingDelta,
  extractToolCallsFromContent,
  fallbackInstruction,
  fallbackInstructionWithToolUse,
  fallbackModelCallTimeoutMs,
  fallbackRank,
  finalizeToolCalls,
  hasAnyToolEvidence,
  hasUsableToolEvidence,
  isExecutableToolCall,
  isStepExecutorModel,
  isUnsafeFinalAnswerText,
  latestUserQuestion,
  maybeJson,
  maybeString,
  modelIdentity,
  normalizeFinalAnswerText,
  normalizeToolCallForExecution,
  normalizeToolResult,
  normalizeTools,
  parsePayload,
  parseSseBlocks,
  roleMessage,
  stringField,
  toolNameKey,
  toolResultToMessageContent,
  type ModelCallOptions,
  type ModelFallbackReason,
  type RuntimeTool,
  type StreamToolCallAccumulator,
} from "./session-runtime-helpers.js";
import { buildEvidenceSafetyAnswer } from "../../shared/evidence-safety-answer.js";
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

  private readonly fallbackBaseTools: RuntimeTool[];
  private readonly fallbackCustomTools: RuntimeTool[];
  private tools: RuntimeTool[];
  private listeners = new Set<AgentSessionEventListener>();
  private abortController: AbortController | null = null;
  private pendingPrompts: Array<{ prompt: string; options?: PromptOptions }> = [];
  private disposed = false;
  private stepExecuteDepth = 0;

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
    this.fallbackBaseTools = normalizeTools(options.tools);
    this.fallbackCustomTools = normalizeTools(options.customTools);
    this.tools = isBrainProvider(this.model?.provider)
      ? filterOutBrainManagedCustomTools(this.fallbackBaseTools)
      : [...this.fallbackBaseTools];
    this._customTools = isBrainProvider(this.model?.provider)
      ? filterOutBrainManagedCustomTools(this.fallbackCustomTools)
      : [...this.fallbackCustomTools];
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
    const isBrain = isBrainProvider(model?.provider);
    this.tools = isBrain ? filterOutBrainManagedCustomTools(this.fallbackBaseTools) : [...this.fallbackBaseTools];
    this._customTools = isBrain ? filterOutBrainManagedCustomTools(this.fallbackCustomTools) : [...this.fallbackCustomTools];
    if (isBrain && Array.isArray(this._baseToolsOverride)) {
      this._baseToolsOverride = filterOutBrainManagedCustomTools(this._baseToolsOverride);
    } else if (isBrain && this._baseToolsOverride && typeof this._baseToolsOverride === "object") {
      this._baseToolsOverride = Object.fromEntries(
        Object.entries(this._baseToolsOverride)
          .filter(([, tool]) => !isBrainManagedCustomToolName(tool?.name)),
      );
    }
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
    const tools = [...base, ...this._customTools];
    const stepExecute = this.createStepExecuteTool();
    if (stepExecute && !tools.some((tool) => toolNameKey(tool.name) === toolNameKey(STEP_EXECUTE_TOOL_NAME))) {
      tools.push(stepExecute);
    }
    return tools;
  }

  private getFallbackTools(): RuntimeTool[] {
    return [...this.fallbackBaseTools, ...this.fallbackCustomTools];
  }

  private findStepExecutorModel(): Model | null {
    if (isStepExecutorModel(this.model)) return null;
    const models = this.modelRegistry?.getAll?.() || [];
    return models.find((candidate) => {
      if (!candidate || isBrainProvider(candidate.provider)) return false;
      if (!isStepExecutorModel(candidate)) return false;
      if (modelIdentity(candidate) === modelIdentity(this.model)) return false;
      return Boolean(candidate.baseUrl || candidate.baseURL);
    }) || null;
  }

  private createStepExecuteTool(): RuntimeTool | null {
    const stepModel = this.findStepExecutorModel();
    if (!stepModel) return null;
    return {
      name: STEP_EXECUTE_TOOL_NAME,
      description: [
        "Step 3.7 Flash 是高速执行/总结器；把一个明确子任务交给它完成。",
        "当已有搜索/行情/赛程/天气等工具证据、需要整理表格/列表/代码/文档，或工具调用已超过 1 次仍需形成答案时优先调用。",
        "只传一个清晰可执行的 task 和必要 context；闲聊、澄清、复查、文件修改/删除、命令执行、付款等有副作用任务不要调用。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "要交给 Step 3.7 Flash 执行的明确子任务。",
          },
          context: {
            type: "string",
            description: "必要上下文或已知事实，保持精简。",
          },
        },
        required: ["task"],
        additionalProperties: false,
      },
      execute: async (_toolCallId, params) => this.executeStepTask(stepModel, params),
    };
  }

  private shouldAutoDelegateToStep(messages: ChatMessage[], round: number): boolean {
    if (isStepExecutorModel(this.model)) return false;
    if (!this.findStepExecutorModel()) return false;
    const anyEvidenceToolCount = countAnyStepDelegationEvidenceToolMessages(messages);
    const evidenceToolCount = countUsableStepDelegationEvidenceToolMessages(messages);
    if (anyEvidenceToolCount > 0 && evidenceToolCount === 0) return true;
    if (evidenceToolCount >= 2) return true;
    return round >= 2 && evidenceToolCount >= 1;
  }

  private async executeStepTask(stepModel: Model, params: unknown): Promise<ToolResult> {
    if (this.stepExecuteDepth > 0) {
      return {
        isError: true,
        content: [{ type: "text", text: "step_execute 已在执行中，避免递归调用。" }],
      };
    }
    const record = asRecord(params);
    const task = stringField(record, ["task", "prompt", "instruction", "query"]) || latestUserQuestion(this.messages);
    const context = stringField(record, ["context", "evidence", "background", "notes"]);
    if (!task) {
      return {
        isError: true,
        content: [{ type: "text", text: "step_execute 缺少可执行的 task。" }],
      };
    }
    const messages: ChatMessage[] = [
      roleMessage("system", [
        "你是 Step 3.7 Flash 执行器。",
        "你的职责是完成调用方交给你的一个明确子任务，并返回可直接使用的结果。",
        "不要调用工具，不要解释内部路由；如果信息不足，列出已知内容和缺口。",
      ].join("\n")),
      roleMessage("user", [
        `任务：${task}`,
        context ? `\n上下文：\n${context}` : "",
        "\n请输出简明、可执行、可直接交回主模型使用的结果。",
      ].filter(Boolean).join("\n")),
    ];
    this.stepExecuteDepth += 1;
    try {
      const result = await this.callModel(messages, {
        model: stepModel,
        tools: [],
        streamText: false,
        timeoutMs: fallbackModelCallTimeoutMs(),
      });
      const text = contentToText(result.assistant.content).trim();
      if (!text) {
        return {
          isError: true,
          content: [{ type: "text", text: "Step 3.7 Flash 执行器没有返回可见内容。" }],
        };
      }
      return {
        content: [{ type: "text", text: `Step 3.7 Flash 执行结果：\n${text}` }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: `Step 3.7 Flash 执行器失败：${err instanceof Error ? err.message : String(err)}`,
        }],
      };
    } finally {
      this.stepExecuteDepth -= 1;
    }
  }

  getActiveToolNames(): string[] {
    return this.getAllTools().map((tool) => tool.name);
  }

  private resolveToolByName(name: string, tools = this.getAllTools()): RuntimeTool | undefined {
    const exact = tools.find((candidate) => candidate.name === name);
    if (exact) return exact;
    const normalized = normalizeToolAliasName(name);
    if (!normalized) return undefined;
    return tools.find((candidate) => normalizeToolAliasName(candidate.name) === normalized);
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

  private finishAssistantAnswer(
    content: string,
    reasoning: string | undefined,
    opts: { streamedText?: boolean; contentDeltas?: string[] } = {},
  ): void {
    const finalContent = normalizeFinalAnswerText(content);
    if (!opts.streamedText) {
      const deltas = opts.contentDeltas?.length ? opts.contentDeltas : [finalContent];
      for (const delta of deltas) {
        if (delta) this.emit(eventTextDelta(delta));
      }
    }
    const finalMessage: ChatMessage = {
      role: "assistant",
      content: finalContent,
      reasoning_content: reasoning || undefined,
    };
    this.sessionManager.appendMessage(finalMessage);
    this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
    this.emit({ type: "message_end", role: "assistant", message: finalMessage });
    this.emit({ type: "agent_end", messages: this.messages });
  }

  private fallbackModels(currentModel: Model): Model[] {
    const models = this.modelRegistry?.getAll?.() || [];
    const blocked = new Set([modelIdentity(currentModel), modelIdentity(this.model)]);
    const seen = new Set<string>();
    return models
      .map((model) => ({ model, rank: fallbackRank(model), identity: modelIdentity(model) }))
      .filter(({ model, rank, identity }) => {
        if (!Number.isFinite(rank) || blocked.has(identity) || seen.has(identity)) return false;
        if (!model.baseUrl && !model.baseURL) return false;
        seen.add(identity);
        return true;
      })
      .sort((a, b) => a.rank - b.rank)
      .map(({ model }) => model);
  }

  private emitFallbackRoute(activeModel: Model, fromModel: Model, reason: ModelFallbackReason): void {
    this.emit({
      type: "provider_meta",
      activeProvider: activeModel.id || activeModel.provider,
      fallbackFrom: [{
        id: fromModel.id || fromModel.provider,
        provider: fromModel.provider,
        reason,
      }],
    });
  }

  private async finishWithFallback(
    baseMessages: ChatMessage[],
    reason: ModelFallbackReason,
    fromModel: Model,
  ): Promise<boolean> {
    const originalEvidenceMessages = hasAnyToolEvidence(baseMessages) ? [...baseMessages] : [];
    const candidates = this.fallbackModels(fromModel);
    if (!candidates.length) {
      const evidenceSafetyAnswer = buildEvidenceSafetyAnswer(originalEvidenceMessages.length ? originalEvidenceMessages : baseMessages);
      if (evidenceSafetyAnswer) {
        this.finishAssistantAnswer(evidenceSafetyAnswer, undefined, { streamedText: false });
        return true;
      }
      return false;
    }
    let sharedMessages = [...baseMessages];
    let latestEvidenceMessages = originalEvidenceMessages.length ? [...originalEvidenceMessages] : [];
    for (const candidate of candidates) {
      try {
        this.emitFallbackRoute(candidate, fromModel, reason);
        const existingAnyEvidence = hasAnyToolEvidence(sharedMessages);
        const existingUsableEvidence = hasUsableToolEvidence(sharedMessages);
        if (existingAnyEvidence) latestEvidenceMessages = [...sharedMessages];
        const availableFallbackTools = this.getFallbackTools();
        const allowTools = !existingUsableEvidence && availableFallbackTools.length > 0;
        const fallbackTools = allowTools ? availableFallbackTools : [];
        let workingMessages = existingUsableEvidence
          ? buildFallbackSynthesisMessages(sharedMessages, reason)
          : [
            ...sharedMessages,
            roleMessage("user", allowTools ? fallbackInstructionWithToolUse(reason) : fallbackInstruction(reason)),
          ];
        const maxFallbackToolRounds = allowTools ? 1 : 0;
        for (let round = 0; round <= maxFallbackToolRounds; round += 1) {
          const result = await this.callModel(workingMessages, {
            model: candidate,
          tools: round < maxFallbackToolRounds ? fallbackTools : [],
          streamText: false,
          timeoutMs: fallbackModelCallTimeoutMs(),
        });
          result.toolCalls = result.toolCalls.filter(isExecutableToolCall);
          const content = contentToText(result.assistant.content);
          if (content.trim() && !isUnsafeFinalAnswerText(content)) {
            this.finishAssistantAnswer(content, result.reasoning, {
              streamedText: false,
            });
            return true;
          }
          if (!result.toolCalls.length || round >= maxFallbackToolRounds) break;
          const assistantForHistory: ChatMessage = {
            role: "assistant",
            content: "",
            tool_calls: result.toolCalls as ChatAssistantToolCall[],
          };
          workingMessages.push(assistantForHistory);
          this.sessionManager.appendMessage(assistantForHistory);
          this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
          for (const toolCall of result.toolCalls) {
            const toolResult = await this.executeToolCall(toolCall, fallbackTools);
            const toolMessage: ChatMessage = {
              role: "tool",
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
              content: toolResultToMessageContent(toolResult),
            };
            workingMessages.push(toolMessage);
            this.sessionManager.appendMessage(toolMessage);
          }
          this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
          if (hasAnyToolEvidence(workingMessages)) {
            latestEvidenceMessages = [...workingMessages];
          }
          if (hasUsableToolEvidence(workingMessages)) {
            workingMessages = buildFallbackSynthesisMessages(workingMessages, reason);
          }
        }
        sharedMessages = workingMessages;
      } catch {
        // Try the next fallback model. The visible turn should end with either a
        // usable answer or the explicit safety fallback below, not intermediate noise.
      }
    }
    const evidenceSafetyAnswer = buildEvidenceSafetyAnswer(
      latestEvidenceMessages.length
        ? latestEvidenceMessages
        : originalEvidenceMessages.length ? originalEvidenceMessages : sharedMessages,
    );
    if (evidenceSafetyAnswer) {
      this.finishAssistantAnswer(evidenceSafetyAnswer, undefined, { streamedText: false });
      return true;
    }
    return false;
  }

  private async runTurn(): Promise<void> {
    this.isStreaming = true;
    this.abortController = new AbortController();
    let fallbackMessages: ChatMessage[] = [];
    try {
      const stepExecutorPolicy = this.findStepExecutorModel() ? buildStepExecutorPolicyPrompt() : "";
      const system = [
        await maybeString(this.resourceLoader.getSystemPrompt?.()),
        await maybeString(this.resourceLoader.getAppendSystemPrompt?.()),
        stepExecutorPolicy,
      ].filter(Boolean).join("\n\n");
      const rawContext = this.sessionManager.buildSessionContext().messages || [];
      const sanitizedContext = sanitizeMessagesBeforePrompt(rawContext);
      if (sanitizedContext.removed > 0 || sanitizedContext.rewritten > 0) {
        this.agent.replaceMessages(sanitizedContext.messages);
      }
      const baseContext = sanitizedContext.messages;
      const messages: ChatMessage[] = system ? [{ role: "system", content: system }, ...baseContext] : [...baseContext];
      fallbackMessages = messages;
      const maxToolRounds = 3;
      for (let round = 0; round < maxToolRounds; round += 1) {
        const result = await this.callModel(messages, { timeoutMs: defaultModelCallTimeoutMs() });
        result.toolCalls = result.toolCalls.filter(isExecutableToolCall);
        if (!result.toolCalls.length) {
          const content = contentToText(result.assistant.content);
          if (!content.trim()) {
            const handled = await this.finishWithFallback(messages, "empty_response", this.model);
            if (handled) return;
            this.finishAssistantAnswer(
              "模型这次没有返回可见内容。本轮已安全结束，避免空回复污染后续上下文；请点击「编辑重发」重试，或换个更明确的问题。",
              result.reasoning,
              { streamedText: false },
            );
            return;
          }
          if (isUnsafeFinalAnswerText(content)) {
            const handled = await this.finishWithFallback(messages, "empty_response", this.model);
            if (handled) return;
            const evidenceSafetyAnswer = buildEvidenceSafetyAnswer(messages);
            if (evidenceSafetyAnswer) {
              this.finishAssistantAnswer(evidenceSafetyAnswer, undefined, { streamedText: false });
              return;
            }
            this.finishAssistantAnswer(
              "模型返回的答案与当前日期或已有证据冲突。本轮已停止输出以避免误导；请点击「编辑重发」重新查询。",
              result.reasoning,
              { streamedText: false },
            );
            return;
          }
          this.finishAssistantAnswer(content, result.reasoning, {
            streamedText: result.streamedText,
            contentDeltas: result.contentDeltas,
          });
          return;
        }
        const assistantForHistory: ChatMessage = {
          role: "assistant",
          content: "",
          tool_calls: result.toolCalls as ChatAssistantToolCall[],
        };
        messages.push(assistantForHistory);
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
        fallbackMessages = messages;
        if (this.shouldAutoDelegateToStep(messages, round)) {
          const handled = await this.finishWithFallback(messages, "tool_round_limit", this.model);
          if (handled) return;
        }
      }
      const handled = await this.finishWithFallback(messages, "tool_round_limit", this.model);
      if (handled) return;
      const evidenceSafetyAnswer = buildEvidenceSafetyAnswer(messages);
      if (evidenceSafetyAnswer) {
        this.finishAssistantAnswer(evidenceSafetyAnswer, undefined, { streamedText: false });
        return;
      }
      this.finishAssistantAnswer(
        "工具链已执行多轮但没有形成最终回复。本轮已安全结束，请缩小问题范围后重试。",
        undefined,
        { streamedText: false },
      );
    } catch (err) {
      const isAbortError = (err as any)?.name === "AbortError";
      const handled = fallbackMessages.length
        ? await this.finishWithFallback(fallbackMessages, "model_error", this.model)
        : false;
      if (handled) return;
      if (isAbortError) {
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

  private async callModel(messages: ChatMessage[], options: ModelCallOptions = {}): Promise<{
    assistant: ChatMessage;
    toolCalls: ToolCall[];
    reasoning: string;
    contentDeltas: string[];
    streamedText: boolean;
  }> {
    const model = options.model || this.model;
    const tools = options.tools ?? this.getAllTools();
    const streamTextImmediately = options.streamText ?? tools.length === 0;
    const body = buildRequestBody(model, messages, tools, this.thinkingLevel);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...this.requestHeaders,
    };
    if (model.apiKey && !headers.authorization && !headers.Authorization) {
      headers.authorization = `Bearer ${model.apiKey}`;
    }
    const timed = createTimedSignal(this.abortController?.signal, options.timeoutMs ?? defaultModelCallTimeoutMs());
    try {
      const response = await fetch(chatCompletionsUrl(model), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: timed.signal,
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
              if (streamTextImmediately) this.emit(eventTextDelta(delta.content));
            }
            const rawToolCalls = delta.tool_calls || delta.toolCalls;
            if (Array.isArray(rawToolCalls)) {
              rawToolCalls.forEach((raw, index) => appendToolDelta(toolDeltas, raw, index));
            }
            const rawFunctionCall = delta.function_call || delta.functionCall;
            if (rawFunctionCall) {
              appendToolDelta(toolDeltas, { index: 0, function: rawFunctionCall }, 0);
            }
          }
        }
      }
      const content = textParts.join("");
      const toolCalls = finalizeToolCalls(toolDeltas);
      const parsedContentToolCalls = toolCalls.length || !tools.length
        ? []
        : extractToolCallsFromContent(content, tools);
      return {
        assistant: { role: "assistant", content, reasoning_content: reasoningParts.join("") || undefined },
        toolCalls: toolCalls.length ? toolCalls : parsedContentToolCalls,
        reasoning: reasoningParts.join(""),
        contentDeltas: textParts,
        streamedText: streamTextImmediately,
      };
    } catch (err) {
      if (timed.didTimeout()) throw new ModelCallTimeoutError(options.timeoutMs ?? defaultModelCallTimeoutMs());
      throw err;
    } finally {
      timed.cleanup();
    }
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

  private async executeToolCall(toolCall: ToolCall, tools = this.getAllTools()): Promise<ToolResult> {
    const normalized = normalizeToolCallForExecution(toolCall.function.name, toolCall.function.arguments, tools);
    toolCall.function.name = normalized.name;
    toolCall.function.arguments = maybeJson(normalized.args);
    let tool = this.resolveToolByName(toolCall.function.name, tools);
    if (!tool?.execute && isBrainManagedCustomToolName(toolCall.function.name)) {
      tool = this.resolveToolByName(toolCall.function.name, this.getFallbackTools());
    }
    const args = normalized.args;
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
      const result = {
        isError: true,
        content: [{
          type: "text",
          text: `工具当前不可用：${toolCall.function.name}。请改用 web_search 或 web_fetch 获取公开来源。`,
        }],
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
