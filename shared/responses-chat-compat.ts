import type { ServerResponse } from 'node:http';

export interface ResponsesChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: Array<{
    id?: string;
    type?: 'function';
    function: { name: string; arguments?: string };
  }>;
  tool_call_id?: string;
}

export interface ResponsesToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export type ResponsesStreamChunk =
  | { type: 'reasoning'; delta: string }
  | { type: 'content'; delta: string }
  | { type: 'tool_call_delta'; delta: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }
  | { type: 'usage'; usage: unknown }
  | { type: 'finish'; reason: string }
  | { type: 'error'; error: string }
  | { type: string; [key: string]: unknown };

type JsonObject = Record<string, unknown>;

type ResponseContentPart = Record<string, unknown>;
type ResponseOutputItem = Record<string, unknown>;

export interface NormalizedResponsesRequest {
  model: string;
  messages: ResponsesChatMessage[];
  tools: ResponsesToolDefinition[];
  toolNameMap: Record<string, ResponsesToolNameMapping>;
  droppedToolTypes: string[];
  reasoningEffort: string | null;
  extraBody: JsonObject;
  stream: boolean;
}

interface ToolOutputState {
  item: ResponseOutputItem;
  outputIndex: number;
  arguments: string;
  wireName: string;
  added: boolean;
}

export interface ResponsesToolNameMapping {
  name: string;
  namespace?: string;
  kind: 'function' | 'custom';
}

const PROVIDER_HOSTED_TOOL_TYPES = new Set([
  'web_search',
  'web_search_preview',
  'file_search',
  'computer_use_preview',
  'image_generation',
  'code_interpreter',
]);

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

function normalizeMessageContent(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return textOf(content);
  const parts: Array<Record<string, unknown>> = [];
  for (const rawPart of content) {
    if (typeof rawPart === 'string') {
      parts.push({ type: 'text', text: rawPart });
      continue;
    }
    const part = recordOf(rawPart);
    const type = String(part.type || '');
    if (type === 'input_text' || type === 'output_text' || type === 'text') {
      parts.push({ type: 'text', text: textOf(part.text) });
      continue;
    }
    if (type === 'input_image' || type === 'image_url') {
      const imageUrl = typeof part.image_url === 'string'
        ? part.image_url
        : typeof part.url === 'string'
          ? part.url
          : recordOf(part.image_url).url;
      if (imageUrl) parts.push({ type: 'image_url', image_url: { url: imageUrl } });
      continue;
    }
    if (type === 'input_audio') {
      parts.push({ type: 'input_audio', input_audio: part.input_audio || part.audio || part });
      continue;
    }
  }
  if (parts.length === 1 && parts[0].type === 'text') return String(parts[0].text || '');
  return parts;
}

function stableNameHash(value: string): string {
  let hash = 2_166_136_261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function flattenedToolName(namespace: string | undefined, name: string): string {
  const joined = namespace ? `${namespace}__${name}` : name;
  const safe = joined.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (safe.length <= 128) return safe;
  return `${safe.slice(0, 119)}_${stableNameHash(joined)}`;
}

function mappedWireName(item: Record<string, unknown>, toolNameMap: Record<string, ResponsesToolNameMapping>): string {
  const name = String(item.name || '');
  const namespace = typeof item.namespace === 'string' && item.namespace ? item.namespace : undefined;
  const match = Object.entries(toolNameMap).find(([, mapping]) => mapping.name === name && mapping.namespace === namespace);
  return match?.[0] || flattenedToolName(namespace, name);
}

function appendFunctionCall(messages: ResponsesChatMessage[], item: Record<string, unknown>, toolNameMap: Record<string, ResponsesToolNameMapping>): void {
  const callId = String(item.call_id || item.id || `call_${messages.length}`);
  const custom = item.type === 'custom_tool_call';
  const toolCall = {
    id: callId,
    type: 'function' as const,
    function: {
      name: mappedWireName(item, toolNameMap),
      arguments: custom ? JSON.stringify({ input: textOf(item.input) }) : textOf(item.arguments || '{}'),
    },
  };
  const previous = messages[messages.length - 1];
  if (previous?.role === 'assistant' && Array.isArray(previous.tool_calls)) {
    previous.tool_calls.push(toolCall);
    return;
  }
  messages.push({ role: 'assistant', content: '', tool_calls: [toolCall] });
}

export function responsesInputToChatMessages(
  input: unknown,
  instructions?: unknown,
  toolNameMap: Record<string, ResponsesToolNameMapping> = {},
): ResponsesChatMessage[] {
  const messages: ResponsesChatMessage[] = [];
  if (typeof instructions === 'string' && instructions.trim()) {
    messages.push({ role: 'system', content: instructions });
  }
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;
  for (const rawItem of input) {
    if (typeof rawItem === 'string') {
      messages.push({ role: 'user', content: rawItem });
      continue;
    }
    const item = recordOf(rawItem);
    const type = String(item.type || 'message');
    if (type === 'message') {
      messages.push({
        role: String(item.role || 'user'),
        content: normalizeMessageContent(item.content),
      });
      continue;
    }
    if (type === 'function_call' || type === 'custom_tool_call') {
      appendFunctionCall(messages, item, toolNameMap);
      continue;
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: String(item.call_id || item.id || ''),
        content: textOf(item.output),
      });
      continue;
    }
    if (type === 'reasoning' || type === 'item_reference') continue;
    throw new Error(`Unsupported Responses input item type: ${type}`);
  }
  return messages;
}

export function responsesToolsToChatTools(tools: unknown): ResponsesToolDefinition[] {
  return normalizeResponsesTools(tools).tools;
}

function normalizeResponsesTools(tools: unknown): {
  tools: ResponsesToolDefinition[];
  toolNameMap: Record<string, ResponsesToolNameMapping>;
  droppedToolTypes: string[];
} {
  if (!Array.isArray(tools)) return { tools: [], toolNameMap: {}, droppedToolTypes: [] };
  const normalized: ResponsesToolDefinition[] = [];
  const toolNameMap: Record<string, ResponsesToolNameMapping> = {};
  const droppedToolTypes = new Set<string>();
  const add = (rawTool: unknown, location: string, namespace?: string) => {
    const tool = recordOf(rawTool);
    const nested = recordOf(tool.function);
    const kind = String(tool.type || nested.type || '');
    if (kind !== 'function' && kind !== 'custom') {
      throw new Error(`Unsupported Responses tool type at ${location}: ${kind || 'missing'}`);
    }
    const name = String(tool.name || nested.name || '').trim();
    if (!name) throw new Error(`Responses ${kind} tool at ${location} has no name`);
    const wireName = flattenedToolName(namespace, name);
    const mapping: ResponsesToolNameMapping = { name, ...(namespace ? { namespace } : {}), kind };
    const existing = toolNameMap[wireName];
    if (existing && (existing.name !== mapping.name || existing.namespace !== mapping.namespace || existing.kind !== mapping.kind)) {
      throw new Error(`Responses tool name collision after Chat flattening: ${wireName}`);
    }
    toolNameMap[wireName] = mapping;
    normalized.push({
      type: 'function',
      function: {
        name: wireName,
        description: typeof tool.description === 'string' ? tool.description : typeof nested.description === 'string' ? nested.description : undefined,
        parameters: kind === 'custom'
          ? {
              type: 'object',
              properties: { input: { type: 'string', description: 'Complete raw input for this custom tool.' } },
              required: ['input'],
              additionalProperties: false,
            }
          : tool.parameters || nested.parameters || { type: 'object', properties: {} },
      },
    });
  };
  tools.forEach((rawTool, index) => {
    const tool = recordOf(rawTool);
    const type = String(tool.type || '');
    if (PROVIDER_HOSTED_TOOL_TYPES.has(type)) {
      droppedToolTypes.add(type);
      return;
    }
    if (tool.type === 'namespace') {
      const namespace = String(tool.name || '').trim();
      if (!namespace) throw new Error(`Responses namespace tool at index ${index} has no name`);
      if (!Array.isArray(tool.tools)) throw new Error(`Responses namespace tool at index ${index} has no tools array`);
      tool.tools.forEach((child, childIndex) => add(child, `index ${index}.${childIndex}`, namespace));
      return;
    }
    add(tool, `index ${index}`);
  });
  return { tools: normalized, toolNameMap, droppedToolTypes: [...droppedToolTypes] };
}

export function normalizeResponsesRequest(body: JsonObject): NormalizedResponsesRequest {
  const model = String(body.model || 'lynn-v2');
  const reasoning = recordOf(body.reasoning);
  const extraBody: JsonObject = {};
  for (const key of ['temperature', 'top_p', 'parallel_tool_calls', 'tool_choice', 'max_output_tokens', 'metadata']) {
    if (body[key] !== undefined) extraBody[key] = body[key];
  }
  if (body.max_output_tokens !== undefined) extraBody.max_tokens = body.max_output_tokens;
  const normalizedTools = normalizeResponsesTools(body.tools);
  const messages = responsesInputToChatMessages(body.input, body.instructions, normalizedTools.toolNameMap);
  if (normalizedTools.droppedToolTypes.length) {
    messages.unshift({
      role: 'system',
      content: `This Chat-Completions BYOK backend does not provide these Responses server-hosted tools: ${normalizedTools.droppedToolTypes.join(', ')}. Do not claim or attempt to use them; use only the function tools included in this request.`,
    });
  }
  return {
    model,
    messages,
    tools: normalizedTools.tools,
    toolNameMap: normalizedTools.toolNameMap,
    droppedToolTypes: normalizedTools.droppedToolTypes,
    reasoningEffort: typeof reasoning.effort === 'string' ? reasoning.effort : null,
    extraBody,
    stream: body.stream !== false,
  };
}

function normalizedUsage(raw: unknown): Record<string, unknown> | null {
  const usage = recordOf(raw);
  if (!Object.keys(usage).length) return null;
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? (inputTokens + outputTokens));
  return {
    input_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    output_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    total_tokens: Number.isFinite(totalTokens) ? totalTokens : 0,
  };
}

export class ResponsesCompatEmitter {
  private readonly responseId: string;
  private readonly createdAt: number;
  private readonly output: ResponseOutputItem[] = [];
  private readonly tools = new Map<number, ToolOutputState>();
  private messageItem: ResponseOutputItem | null = null;
  private messageText = '';
  private lastUsage: Record<string, unknown> | null = null;
  private started = false;
  private terminalStatus: 'completed' | 'failed' | null = null;
  private terminalError = '';
  private sequenceNumber = 0;

  constructor(
    private readonly model: string,
    private readonly stream: boolean,
    private readonly writeEvent: (event: JsonObject) => void,
    responseId = `resp_lynn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    private readonly toolNameMap: Record<string, ResponsesToolNameMapping> = {},
  ) {
    this.responseId = responseId;
    this.createdAt = Math.floor(Date.now() / 1_000);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.emit({ type: 'response.created', response: this.responseObject('in_progress') });
    this.emit({ type: 'response.in_progress', response: this.responseObject('in_progress') });
  }

  onChunk(chunk: ResponsesStreamChunk, _meta?: unknown): void {
    if (this.terminalStatus) return;
    this.start();
    if (chunk.type === 'content') {
      const message = this.ensureMessage();
      this.messageText += chunk.delta;
      this.emit({
        type: 'response.output_text.delta',
        item_id: message.id,
        output_index: this.output.indexOf(message),
        content_index: 0,
        delta: chunk.delta,
      });
      return;
    }
    if (chunk.type === 'tool_call_delta') {
      const deltas = Array.isArray(chunk.delta) ? chunk.delta : [];
      for (const delta of deltas) this.emitToolDelta(delta);
      return;
    }
    if (chunk.type === 'usage') {
      this.lastUsage = normalizedUsage(chunk.usage);
      return;
    }
    if (chunk.type === 'error') {
      this.fail(chunk.error);
    }
  }

  complete(): JsonObject {
    if (this.terminalStatus) return this.responseObject(this.terminalStatus, this.terminalError);
    this.start();
    this.finalizeItems();
    this.terminalStatus = 'completed';
    const response = this.responseObject('completed');
    this.emit({ type: 'response.completed', response });
    return response;
  }

  fail(error: unknown): JsonObject {
    if (this.terminalStatus) return this.responseObject(this.terminalStatus, this.terminalError);
    this.start();
    this.finalizeItems();
    this.terminalStatus = 'failed';
    this.terminalError = textOf(error);
    const response = this.responseObject('failed', this.terminalError);
    this.emit({ type: 'response.failed', response });
    return response;
  }

  private ensureMessage(): ResponseOutputItem {
    if (this.messageItem) return this.messageItem;
    const item: ResponseOutputItem = {
      type: 'message',
      id: `msg_${this.responseId}`,
      status: 'in_progress',
      role: 'assistant',
      content: [],
    };
    this.messageItem = item;
    const outputIndex = this.output.push(item) - 1;
    this.emit({ type: 'response.output_item.added', output_index: outputIndex, item: { ...item } });
    const part = { type: 'output_text', annotations: [], text: '' };
    this.emit({ type: 'response.content_part.added', item_id: item.id, output_index: outputIndex, content_index: 0, part });
    return item;
  }

  private emitToolDelta(delta: { index?: number; id?: string; function?: { name?: string; arguments?: string } }): void {
    const index = delta.index ?? 0;
    let state = this.tools.get(index);
    if (!state) {
      const callId = delta.id || `call_${this.responseId}_${index}`;
      const item: ResponseOutputItem = {
        type: 'function_call',
        id: `fc_${this.responseId}_${index}`,
        call_id: callId,
        name: '',
        arguments: '',
        status: 'in_progress',
      };
      const outputIndex = this.output.push(item) - 1;
      state = { item, outputIndex, arguments: '', wireName: '', added: false };
      this.tools.set(index, state);
    }
    if (delta.id) state.item.call_id = delta.id;
    if (delta.function?.name) {
      state.wireName += delta.function.name;
      this.applyToolName(state);
    }
    if (delta.function?.arguments) {
      this.ensureToolAdded(state);
      state.arguments += delta.function.arguments;
      if (state.item.type === 'custom_tool_call') {
        state.item.input = '';
      } else {
        state.item.arguments = state.arguments;
        this.emit({
          type: 'response.function_call_arguments.delta',
          item_id: state.item.id,
          output_index: state.outputIndex,
          delta: delta.function.arguments,
        });
      }
    }
  }

  private applyToolName(state: ToolOutputState): void {
    const mapping = this.toolNameMap[state.wireName];
    state.item.name = mapping?.name || state.wireName;
    if (mapping?.namespace) state.item.namespace = mapping.namespace;
    else delete state.item.namespace;
    if (mapping?.kind === 'custom') {
      state.item.type = 'custom_tool_call';
      delete state.item.arguments;
      state.item.input = '';
    } else {
      state.item.type = 'function_call';
      delete state.item.input;
      state.item.arguments = state.arguments;
    }
  }

  private ensureToolAdded(state: ToolOutputState): void {
    if (state.added) return;
    this.applyToolName(state);
    state.added = true;
    this.emit({ type: 'response.output_item.added', output_index: state.outputIndex, item: { ...state.item } });
  }

  private finalizeItems(): void {
    if (this.messageItem) {
      const outputIndex = this.output.indexOf(this.messageItem);
      const part = { type: 'output_text', annotations: [], text: this.messageText };
      this.messageItem.status = 'completed';
      this.messageItem.content = [part];
      this.emit({ type: 'response.output_text.done', item_id: this.messageItem.id, output_index: outputIndex, content_index: 0, text: this.messageText });
      this.emit({ type: 'response.content_part.done', item_id: this.messageItem.id, output_index: outputIndex, content_index: 0, part });
      this.emit({ type: 'response.output_item.done', output_index: outputIndex, item: { ...this.messageItem } });
    }
    for (const state of this.tools.values()) {
      this.ensureToolAdded(state);
      state.item.status = 'completed';
      if (state.item.type === 'custom_tool_call') {
        let input = state.arguments;
        try {
          const parsed = JSON.parse(state.arguments) as Record<string, unknown>;
          if (typeof parsed.input === 'string') input = parsed.input;
        } catch {}
        state.item.input = input;
      } else {
        state.item.arguments = state.arguments;
        this.emit({ type: 'response.function_call_arguments.done', item_id: state.item.id, output_index: state.outputIndex, arguments: state.arguments });
      }
      this.emit({ type: 'response.output_item.done', output_index: state.outputIndex, item: { ...state.item } });
    }
  }

  private responseObject(status: 'in_progress' | 'completed' | 'failed', error?: string): JsonObject {
    return {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      status,
      model: this.model,
      output: this.output.map((item) => ({ ...item })),
      parallel_tool_calls: true,
      usage: this.lastUsage,
      error: status === 'failed' ? { code: 'lynn_responses_bridge_error', message: error || 'Responses bridge failed' } : null,
    };
  }

  private emit(event: JsonObject): void {
    if (!this.stream) return;
    this.sequenceNumber += 1;
    this.writeEvent({ ...event, sequence_number: this.sequenceNumber });
  }
}

export function writeResponsesSse(res: ServerResponse, event: JsonObject): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
