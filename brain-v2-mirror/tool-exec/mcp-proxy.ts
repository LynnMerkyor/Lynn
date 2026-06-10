// @ts-nocheck
// Brain v2 · 通用 MCP stdio 桥(V0.83 akshare 等外部工具族的统一接入位)
//
// 设计目标:tool-exec 的手写 switch 不再为每个新工具族扩 case —— 任何 MCP server
//(akshare/飞书/高德/IMAP…)经 env `MCP_SERVERS` 注册后,其工具自动并入 brain 的
// server-tools(列表注入 + 调用代理 + 60s LRU)。零运行时依赖:自带极简
// JSON-RPC 2.0 over stdio(newline-delimited,MCP 标准 transport),可逐字部署 prod。
//
// env 配置(brain .env):
//   MCP_SERVERS={"akshare":{"command":"python3","args":["-m","mcp_akshare"],"cacheTtlMs":60000}}
//     command/args  — 子进程启动命令
//     env           — 附加环境变量(合并 process.env)
//     cacheTtlMs    — 该 server 工具结果 LRU TTL(默认 60_000;akshare 防打爆数据源)
//     callTimeoutMs — 单次 tools/call 超时(默认 30_000)
//
// 同步/异步取舍:router 的 mergeWithServerTools 是同步调用,而 tools/list 必须异步。
// 因此模块加载即后台预热(warmup),merge 用缓存快照 —— 进程启动后第一回合可能
// 还看不到 MCP 工具(预热未完),下一回合自然出现。可用 whenMcpReady() 显式等待(测试用)。

import { spawn } from 'node:child_process';
import { makeLruCache } from './_helpers.js';

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const INIT_TIMEOUT_MS = 15_000;

// ── 配置解析 ────────────────────────────────────────────────────────────────
function parseServersConfig() {
  const raw = process.env.MCP_SERVERS;
  if (!raw || !String(raw).trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [name, cfg] of Object.entries(parsed)) {
      if (!cfg || typeof cfg !== 'object' || typeof cfg.command !== 'string' || !cfg.command) continue;
      out[name] = {
        command: cfg.command,
        args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
        env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
        cacheTtlMs: Number(cfg.cacheTtlMs) > 0 ? Number(cfg.cacheTtlMs) : DEFAULT_CACHE_TTL_MS,
        callTimeoutMs: Number(cfg.callTimeoutMs) > 0 ? Number(cfg.callTimeoutMs) : DEFAULT_CALL_TIMEOUT_MS,
      };
    }
    return out;
  } catch (e) {
    console.warn('[mcp-proxy] MCP_SERVERS 不是合法 JSON,忽略:', e.message || String(e));
    return {};
  }
}

// ── 单个 MCP server 的 stdio client ─────────────────────────────────────────
function createMcpClient(serverName, cfg) {
  let child = null;
  let nextId = 1;
  const pending = new Map(); // id → {resolve, reject, timer}
  let stdoutBuf = '';
  let initialized = null;    // Promise — 握手完成

  function fail(reason) {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    pending.clear();
    child = null;
    initialized = null;
  }

  function ensureSpawned() {
    if (child) return;
    child = spawn(cfg.command, cfg.args, {
      env: { ...process.env, ...cfg.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    stdoutBuf = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuf += String(chunk);
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg && msg.id != null && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(`${serverName} rpc error: ${msg.error.message || JSON.stringify(msg.error)}`));
          else p.resolve(msg.result);
        }
      }
    });
    child.stderr.on('data', () => { /* server 自己的日志,不并入协议流 */ });
    child.on('exit', (code) => fail(`mcp server "${serverName}" exited (code=${code}); will respawn on next call`));
    child.on('error', (err) => fail(`mcp server "${serverName}" spawn failed: ${err.message || String(err)}`));
  }

  function request(method, params, timeoutMs) {
    ensureSpawned();
    const id = nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`mcp "${serverName}" ${method} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { child.stdin.write(payload); }
      catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  function notify(method, params) {
    ensureSpawned();
    try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }) + '\n'); }
    catch { /* 下一次 request 会触发 respawn 路径 */ }
  }

  async function ensureInitialized() {
    if (!child) initialized = null;
    if (!initialized) {
      initialized = (async () => {
        await request('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'lynn-brain-v2', version: '1.0' },
        }, INIT_TIMEOUT_MS);
        notify('notifications/initialized');
      })();
      initialized.catch(() => { initialized = null; });
    }
    return initialized;
  }

  return {
    async listTools() {
      await ensureInitialized();
      const result = await request('tools/list', {}, INIT_TIMEOUT_MS);
      return Array.isArray(result?.tools) ? result.tools : [];
    },
    async callTool(toolName, args) {
      await ensureInitialized();
      const result = await request('tools/call', { name: toolName, arguments: args || {} }, cfg.callTimeoutMs);
      // MCP 标准:result.content = [{type:'text',text}...];文本拼接,非文本回退 JSON。
      if (Array.isArray(result?.content)) {
        const texts = result.content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text);
        if (texts.length) return texts.join('\n');
      }
      return JSON.stringify(result ?? null);
    },
    kill() {
      if (child) { try { child.kill('SIGTERM'); } catch { /* noop */ } }
      fail(`mcp server "${serverName}" killed`);
    },
  };
}

// ── 全局注册表(server → client / tool → server)──────────────────────────────
let SERVERS = parseServersConfig();
const clients = new Map();      // serverName → client
const caches = new Map();       // serverName → lru
let toolIndex = new Map();      // toolName → { server, def }
let cachedToolDefs = [];        // OpenAI function-tool 形状的快照(merge 同步用)
let warmupPromise = null;

function clientFor(serverName) {
  let c = clients.get(serverName);
  if (!c) {
    c = createMcpClient(serverName, SERVERS[serverName]);
    clients.set(serverName, c);
  }
  return c;
}

function cacheFor(serverName) {
  let c = caches.get(serverName);
  if (!c) {
    c = makeLruCache(200, SERVERS[serverName].cacheTtlMs);
    caches.set(serverName, c);
  }
  return c;
}

async function refreshToolIndex(log) {
  const nextIndex = new Map();
  const nextDefs = [];
  for (const serverName of Object.keys(SERVERS)) {
    try {
      const tools = await clientFor(serverName).listTools();
      for (const tool of tools) {
        if (!tool || typeof tool.name !== 'string' || !tool.name) continue;
        if (nextIndex.has(tool.name)) {
          log && log('warn', `mcp-proxy: tool name collision "${tool.name}" (kept ${nextIndex.get(tool.name).server}, ignored ${serverName})`);
          continue;
        }
        nextIndex.set(tool.name, { server: serverName, def: tool });
        nextDefs.push({
          type: 'function',
          function: {
            name: tool.name,
            description: String(tool.description || `MCP tool from ${serverName}`),
            parameters: tool.inputSchema && typeof tool.inputSchema === 'object'
              ? tool.inputSchema
              : { type: 'object', properties: {} },
          },
        });
      }
      log && log('info', `mcp-proxy: server "${serverName}" exposed ${tools.length} tool(s)`);
    } catch (e) {
      log && log('warn', `mcp-proxy: server "${serverName}" tools/list failed: ${e.message || String(e)}`);
    }
  }
  toolIndex = nextIndex;
  cachedToolDefs = nextDefs;
}

// ── 公开 API(index.ts 接线用)────────────────────────────────────────────────
export function mcpConfigured() {
  return Object.keys(SERVERS).length > 0;
}

/** 后台预热;重复调用幂等。测试/启动序列可 await。 */
export function whenMcpReady(log) {
  if (!mcpConfigured()) return Promise.resolve();
  if (!warmupPromise) warmupPromise = refreshToolIndex(log).catch(() => {});
  return warmupPromise;
}

/** merge 同步快照:预热完成前为空数组(首回合后自然出现)。 */
export function getMcpToolDefs() {
  if (mcpConfigured() && !warmupPromise) whenMcpReady();
  return cachedToolDefs;
}

export function isMcpTool(name) {
  return toolIndex.has(name);
}

export async function executeMcpTool(name, args, { log } = {}) {
  const entry = toolIndex.get(name);
  if (!entry) return JSON.stringify({ error: 'unknown mcp tool: ' + name });
  const cache = cacheFor(entry.server);
  const cacheKey = name + ' ' + JSON.stringify(args ?? {});
  const hit = cache.get(cacheKey);
  if (hit != null) {
    log && log('info', `mcp-proxy: ${name} cache hit`);
    return hit;
  }
  try {
    const out = await clientFor(entry.server).callTool(name, args);
    cache.set(cacheKey, out);
    return out;
  } catch (e) {
    log && log('warn', `mcp-proxy: ${name} failed: ${e.message || String(e)}`);
    return JSON.stringify({ error: e.message || String(e) });
  }
}

/** 测试钩子:杀子进程、清状态、按当前 env 重读配置。 */
export function resetMcpForTests() {
  for (const [, c] of clients) c.kill();
  clients.clear();
  caches.clear();
  toolIndex = new Map();
  cachedToolDefs = [];
  warmupPromise = null;
  SERVERS = parseServersConfig();
}
