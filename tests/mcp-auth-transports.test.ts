import http from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { createMcpConnection, type McpConnectionBase } from '../lib/mcp-client-connections.js';
const servers: http.Server[] = []; const connections: McpConnectionBase[] = [];
afterEach(() => { for (const connection of connections.splice(0)) connection.close(); for (const server of servers.splice(0)) { server.closeAllConnections(); server.close(); } });
async function listen(handler: http.RequestListener) { const server = http.createServer(handler); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; }
it('refreshes HTTP authorization and carries the negotiated session and version over an open event stream', async () => {
  const observed: Array<{ method: string; session?: string; version?: string }> = [];
  const base = await listen(async (req, res) => {
    if (req.headers.authorization !== 'Bearer refreshed') { res.writeHead(401).end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const message = JSON.parse(body); observed.push({ method: message.method, session: req.headers['mcp-session-id'] as string, version: req.headers['mcp-protocol-version'] as string });
    if (message.method === 'initialize') { res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-fixture' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {} } })); return; }
    if (!message.id) { res.writeHead(202).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] } })}\n\n`);
    // Deliberately leave this stream open: the matching RPC result is complete.
  });
  const connection = createMcpConnection('fixture', { transport: 'http', url: `${base}/mcp` }); connections.push(connection);
  let refreshes = 0; connection.setAuthorizationProvider(async force => { if (force) refreshes++; return { Authorization: `Bearer ${refreshes ? 'refreshed' : 'expired'}` }; });
  await connection.connect(); expect((await connection.listTools())[0].name).toBe('lookup'); expect(refreshes).toBe(1);
  expect(observed.find(item => item.method === 'tools/list')).toMatchObject({ session: 'session-fixture', version: '2025-06-18' });
});
it('authenticates both SSE streams and their JSON-RPC POST messages', async () => {
  let stream: http.ServerResponse; const authorization: string[] = [];
  const base = await listen(async (req, res) => {
    authorization.push(String(req.headers.authorization));
    if (req.method === 'GET') { stream = res; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('event: endpoint\ndata: /messages\n\n'); return; }
    let body = ''; for await (const chunk of req) body += chunk; const message = JSON.parse(body);
    if (message.id) stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'initialize' ? { protocolVersion: '2024-11-05' } : { tools: [{ name: 'sse_lookup', inputSchema: {} }] } })}\n\n`);
    res.writeHead(202).end();
  });
  const connection = createMcpConnection('fixture', { transport: 'sse', url: `${base}/events` }); connections.push(connection);
  connection.setAuthorizationProvider(async () => ({ Authorization: 'Bearer local-fixture' }));
  await connection.connect(); expect((await connection.listTools())[0].name).toBe('sse_lookup'); expect(authorization.length).toBeGreaterThanOrEqual(3); expect(authorization.every(header => header === 'Bearer local-fixture')).toBe(true);
});
