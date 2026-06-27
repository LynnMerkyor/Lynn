import http from "node:http";

export async function startScriptedOpenAIProvider({ script = [], defaultModel = "scripted-model" } = {}) {
  const state = {
    requestCount: 0,
    requests: [],
  };
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, requestCount: state.requestCount }));
      return;
    }
    if (req.method !== "POST" || !isChatCompletionsPath(req.url || "")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", async () => {
      state.requestCount += 1;
      const count = state.requestCount;
      const body = parseJson(raw);
      state.requests.push({ count, body, raw });
      const step = pickStep(script, count, body);
      await writeScriptedResponse(res, step, { count, defaultModel });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("scripted provider failed to bind");
  const origin = `http://127.0.0.1:${address.port}`;
  let closed = false;
  return {
    origin,
    baseUrl: `${origin}/v1`,
    get requestCount() {
      return state.requestCount;
    },
    get requests() {
      return state.requests;
    },
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function isChatCompletionsPath(url) {
  return /(?:^|\/)chat\/completions(?:\?|$)/.test(String(url || ""));
}

function parseJson(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function pickStep(script, count, body) {
  if (!Array.isArray(script) || script.length === 0) {
    return { content: "" };
  }
  for (const candidate of script) {
    if (!candidate || typeof candidate !== "object") continue;
    if (candidate.matchModel && String(body?.model || "") !== String(candidate.matchModel)) continue;
    if (candidate.matchRequest && Number(candidate.matchRequest) !== count) continue;
    if (candidate.matchLastUserContains) {
      const lastUser = lastMessageText(body?.messages, "user");
      if (!lastUser.includes(String(candidate.matchLastUserContains))) continue;
    }
    if (candidate.matchModel || candidate.matchRequest || candidate.matchLastUserContains) return candidate;
  }
  return script[Math.min(count - 1, script.length - 1)] || { content: "" };
}

async function writeScriptedResponse(res, step, context) {
  if (step?.delayMs) await sleep(Number(step.delayMs));
  if (step?.status && Number(step.status) >= 400) {
    res.writeHead(Number(step.status), { "content-type": "application/json" });
    res.end(JSON.stringify({ error: step.error || `scripted status ${step.status}` }));
    return;
  }

  const headers = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" };
  res.writeHead(200, headers);
  if (typeof step?.rawSse === "string") {
    res.end(step.rawSse);
    return;
  }

  for (const payload of buildSsePayloads(step || {}, context)) {
    res.write(`data: ${payload}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function buildSsePayloads(step, context) {
  if (Array.isArray(step.payloads)) {
    return step.payloads.map((payload) => typeof payload === "string" ? payload : JSON.stringify(payload));
  }
  const payloads = [];
  for (const sideEvent of step.sideEvents || []) {
    payloads.push(JSON.stringify(sideEvent));
  }
  for (const reasoning of stringChunks(step.reasoning || step.reasoningContent)) {
    payloads.push(JSON.stringify({
      id: `chatcmpl-scripted-${context.count}`,
      object: "chat.completion.chunk",
      model: step.model || context.defaultModel,
      choices: [{ index: 0, delta: { reasoning_content: reasoning } }],
    }));
  }
  const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
  if (toolCalls.length) {
    payloads.push(JSON.stringify({
      id: `chatcmpl-scripted-${context.count}`,
      object: "chat.completion.chunk",
      model: step.model || context.defaultModel,
      choices: [{
        index: 0,
        delta: {
          tool_calls: toolCalls.map((toolCall, index) => ({
            index,
            id: toolCall.id || `call_${context.count}_${index}`,
            type: "function",
            function: {
              name: toolCall.name || toolCall.function?.name || "",
              arguments: typeof toolCall.arguments === "string"
                ? toolCall.arguments
                : JSON.stringify(toolCall.args || toolCall.function?.arguments || {}),
            },
          })),
        },
      }],
    }));
    payloads.push(JSON.stringify({
      id: `chatcmpl-scripted-${context.count}`,
      object: "chat.completion.chunk",
      model: step.model || context.defaultModel,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    }));
  }
  for (const content of stringChunks(step.content || step.text)) {
    payloads.push(JSON.stringify({
      id: `chatcmpl-scripted-${context.count}`,
      object: "chat.completion.chunk",
      model: step.model || context.defaultModel,
      choices: [{ index: 0, delta: { content } }],
    }));
  }
  if (step.usage) {
    payloads.push(JSON.stringify({
      id: `chatcmpl-scripted-${context.count}`,
      object: "chat.completion.chunk",
      model: step.model || context.defaultModel,
      choices: [],
      usage: step.usage,
    }));
  }
  return payloads;
}

function stringChunks(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const text = String(value || "");
  return text ? [text] : [];
}

function lastMessageText(messages, role) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (role && list[i]?.role !== role) continue;
    return contentText(list[i]?.content);
  }
  return "";
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof part.text === "string") return part.text;
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
