import crypto from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import {
  ResponsesCompatEmitter,
  normalizeResponsesRequest,
  writeResponsesSse,
  type ResponsesChatMessage,
  type ResponsesStreamChunk,
  type ResponsesToolDefinition,
} from "../../shared/responses-chat-compat.js";
import { registerRemoteBrainDevice, signedBrainHeaders } from "./brain-auth.js";
import { brainEndpointUrl } from "./brain-url.js";
import { streamDirectProviderChat, type BrainStreamEvent, type ChatMessage, type ChatToolDefinition } from "./brain-client.js";
import type { CliProviderProfile } from "./provider-profile.js";
import type { ReasoningOptions } from "./reasoning.js";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

export interface CodexResponsesProxyOptions {
  brainUrl: string;
  provider?: CliProviderProfile | null;
  reasoning: ReasoningOptions;
  lynnHome?: string;
  host?: string;
}

export interface CodexResponsesProxy {
  baseUrl: string;
  bearerToken: string;
  mode: "brain" | "byok";
  stop(): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bearerValue(req: IncomingMessage): string {
  const value = String(req.headers.authorization || "");
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}

function safeTokenEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) throw new Error("Responses request exceeds 16 MiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { type: "invalid_request_error", message } }));
}

function toResponsesChunk(event: BrainStreamEvent): ResponsesStreamChunk | null {
  switch (event.type) {
    case "assistant.delta":
      return { type: "content", delta: event.text };
    case "reasoning.delta":
      return { type: "reasoning", delta: event.text };
    case "tool_call.delta":
      return {
        type: "tool_call_delta",
        delta: [{
          index: event.index,
          ...(event.id ? { id: event.id } : {}),
          function: {
            ...(event.name ? { name: event.name } : {}),
            ...(event.arguments ? { arguments: event.arguments } : {}),
          },
        }],
      };
    case "usage":
      return { type: "usage", usage: event.usage };
    case "brain.error":
      return { type: "error", error: event.error };
    case "done":
      return { type: "finish", reason: event.finishReason || "stop" };
    default:
      return null;
  }
}

function asCliMessages(messages: ResponsesChatMessage[]): ChatMessage[] {
  return messages as ChatMessage[];
}

function asCliTools(tools: ResponsesToolDefinition[]): ChatToolDefinition[] {
  return tools as ChatToolDefinition[];
}

async function handleDirectByok(
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: string,
  options: CodexResponsesProxyOptions & { provider: CliProviderProfile },
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch (error) {
    jsonError(res, 400, `invalid JSON: ${errorMessage(error)}`);
    return;
  }

  let normalized;
  try {
    normalized = normalizeResponsesRequest(body);
  } catch (error) {
    jsonError(res, 400, errorMessage(error));
    return;
  }

  if (normalized.stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-lynn-harness-mode": "byok-chat-compat",
    });
  }

  const abort = new AbortController();
  res.once("close", () => {
    if (!res.writableEnded) abort.abort(new Error("Codex Responses client disconnected"));
  });
  const emitter = new ResponsesCompatEmitter(
    options.provider.model,
    normalized.stream,
    (event) => {
      if (!res.writableEnded) writeResponsesSse(res, event);
    },
    undefined,
    normalized.toolNameMap,
  );
  emitter.start();
  let response: Record<string, unknown>;
  try {
    for await (const event of streamDirectProviderChat({
      brainUrl: "direct://cli-byok",
      messages: asCliMessages(normalized.messages),
      reasoning: options.reasoning,
      tools: asCliTools(normalized.tools),
      signal: abort.signal,
    }, options.provider)) {
      const chunk = toResponsesChunk(event);
      if (chunk) emitter.onChunk(chunk);
    }
    response = emitter.complete();
  } catch (error) {
    response = emitter.fail(errorMessage(error));
  }

  if (res.writableEnded || res.destroyed) return;
  if (normalized.stream) {
    res.end();
  } else {
    res.writeHead(200, {
      "content-type": "application/json",
      "x-lynn-harness-mode": "byok-chat-compat",
    });
    res.end(JSON.stringify(response));
  }
}

async function fetchBrainResponses(rawBody: string, options: CodexResponsesProxyOptions, signal: AbortSignal): Promise<Response> {
  const pathname = "/v1/responses";
  const request = () => fetch(brainEndpointUrl(options.brainUrl, pathname), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...signedBrainHeaders({ lynnHome: options.lynnHome, pathname }),
    },
    body: rawBody,
    signal,
  });
  let response = await request();
  if (response.status === 401 && await registerRemoteBrainDevice(options.brainUrl, { lynnHome: options.lynnHome })) {
    response = await request();
  }
  return response;
}

async function handleBrainForward(req: IncomingMessage, res: ServerResponse, rawBody: string, options: CodexResponsesProxyOptions): Promise<void> {
  const abort = new AbortController();
  res.once("close", () => {
    if (!res.writableEnded) abort.abort(new Error("Codex Responses client disconnected"));
  });
  let upstream: Response;
  try {
    upstream = await fetchBrainResponses(rawBody, options, abort.signal);
  } catch (error) {
    jsonError(res, 502, `Brain Responses proxy failed: ${errorMessage(error)}`);
    return;
  }
  const headers: Record<string, string> = {
    "content-type": upstream.headers.get("content-type") || "application/json",
    "x-lynn-harness-mode": upstream.headers.get("x-lynn-harness-mode") || "brain-model-only",
  };
  const brainVersion = upstream.headers.get("x-brain-version");
  if (brainVersion) headers["x-brain-version"] = brainVersion;
  res.writeHead(upstream.status, headers);
  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise<void>((resolve) => res.once("drain", resolve));
    }
    res.end();
  } finally {
    reader.releaseLock();
  }
}

export async function startCodexResponsesProxy(options: CodexResponsesProxyOptions): Promise<CodexResponsesProxy> {
  const host = options.host || "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("Codex Responses proxy may only listen on loopback");
  }
  const bearerToken = crypto.randomBytes(32).toString("hex");
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/responses") {
      jsonError(res, 404, "not found");
      return;
    }
    const presented = bearerValue(req);
    const valid = safeTokenEqual(presented, bearerToken);
    if (!valid) {
      jsonError(res, 401, "invalid local harness token");
      return;
    }
    let rawBody: string;
    try {
      rawBody = await readRequestBody(req);
    } catch (error) {
      jsonError(res, 413, errorMessage(error));
      return;
    }
    try {
      if (options.provider) await handleDirectByok(req, res, rawBody, { ...options, provider: options.provider });
      else await handleBrainForward(req, res, rawBody, options);
    } catch (error) {
      if (!res.headersSent) jsonError(res, 500, errorMessage(error));
      else if (!res.writableEnded) res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Codex Responses proxy did not receive a TCP port");
  }
  return {
    baseUrl: `http://${host}:${address.port}/v1`,
    bearerToken,
    mode: options.provider ? "byok" : "brain",
    stop: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections();
    }),
  };
}
