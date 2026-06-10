// mcp-proxy 桥测试 — 用真子进程跑一个最小 MCP stdio server(newline-delimited JSON-RPC),
// 验证 initialize 握手 / tools/list 注入 / tools/call 代理 / 60s LRU / dispatcher 接线。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// 最小 MCP server:echo 工具回显参数 + 自增调用计数(LRU 命中断言用:命中则计数不变)。
const FAKE_SERVER_JS = `
let calls = 0;
let buf = '';
process.stdin.on('data', (c) => {
  buf += String(c);
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    if (msg.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '0' } });
    else if (msg.method === 'tools/list') reply({ tools: [{ name: 'fake_echo', description: 'echo with call counter', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });
    else if (msg.method === 'tools/call') { calls += 1; reply({ content: [{ type: 'text', text: 'echo:' + (msg.params?.arguments?.text || '') + ' calls=' + calls }] }); }
    // notifications(无 id)不回包
  }
});
`;

let mcp;
let toolExec;

beforeAll(async () => {
  process.env.MCP_SERVERS = JSON.stringify({
    fake: { command: process.execPath, args: ['-e', FAKE_SERVER_JS], cacheTtlMs: 60_000 },
  });
  mcp = await import('../tool-exec/mcp-proxy.js');
  mcp.resetMcpForTests();
  await mcp.whenMcpReady();
  toolExec = await import('../tool-exec/index.js');
});

afterAll(() => {
  mcp.resetMcpForTests();
  delete process.env.MCP_SERVERS;
});

describe('mcp-proxy bridge', () => {
  it('warms up and exposes MCP tools as OpenAI-style defs', () => {
    expect(mcp.mcpConfigured()).toBe(true);
    const defs = mcp.getMcpToolDefs();
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({
      type: 'function',
      function: { name: 'fake_echo', description: 'echo with call counter' },
    });
    expect(defs[0].function.parameters).toMatchObject({ type: 'object' });
  });

  it('proxies tools/call and returns the text content', async () => {
    const out = await mcp.executeMcpTool('fake_echo', { text: 'hi' });
    expect(out).toContain('echo:hi');
  });

  it('serves identical calls from the LRU within TTL (data-source protection)', async () => {
    const first = await mcp.executeMcpTool('fake_echo', { text: 'cached' });
    const second = await mcp.executeMcpTool('fake_echo', { text: 'cached' });
    // 命中缓存 → 子进程计数不再自增 → 两次返回完全一致
    expect(second).toBe(first);
    // 不同参数 → 真调用 → 计数前进
    const third = await mcp.executeMcpTool('fake_echo', { text: 'fresh' });
    expect(third).not.toBe(first);
  });

  it('returns a structured error for unknown tools', async () => {
    const out = await mcp.executeMcpTool('nope', {});
    expect(JSON.parse(out)).toMatchObject({ error: expect.stringContaining('unknown mcp tool') });
  });

  it('wires into the dispatcher: isServerTool / mergeWithServerTools / executeServerTool', async () => {
    expect(toolExec.isServerTool('fake_echo')).toBe(true);
    const merged = toolExec.mergeWithServerTools([], undefined);
    expect(merged.some((t) => t.function?.name === 'fake_echo')).toBe(true);
    const out = await toolExec.executeServerTool('fake_echo', JSON.stringify({ text: 'via-dispatcher' }));
    expect(out).toContain('echo:via-dispatcher');
  });
});
