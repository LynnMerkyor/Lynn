import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { McpOAuth, discoverMcpOAuth } from '../lib/mcp/oauth.js';
import { isPublicOAuthAddress, oauthRequest } from '../lib/mcp/oauth-request.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });
async function fixture() {
  let base = ''; let resourceMismatch = false; let refreshCount = 0; let tokenBody: URLSearchParams | undefined;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json'); let body = ''; for await (const chunk of req) body += chunk;
    if (req.url === '/mcp') { res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/resource", scope="data:read"` }).end('{}'); return; }
    if (req.url === '/resource') { res.end(JSON.stringify({ resource: `${base}/${resourceMismatch ? 'other' : 'mcp'}`, authorization_servers: [base] })); return; }
    if (req.url === '/.well-known/oauth-authorization-server') { res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, code_challenge_methods_supported: ['S256'] })); return; }
    if (req.url === '/register') { expect(JSON.parse(body).token_endpoint_auth_method).toBe('none'); res.end('{"client_id":"fixture-client"}'); return; }
    if (req.url === '/token') {
      const input = new URLSearchParams(body);
      if (input.get('grant_type') === 'authorization_code') { tokenBody = input; res.end('{"access_token":"first-secret","refresh_token":"refresh-secret","expires_in":1,"token_type":"Bearer"}'); }
      else { refreshCount++; expect(input.get('refresh_token')).toBe('refresh-secret'); res.end('{"access_token":"second-secret","expires_in":3600,"token_type":"Bearer"}'); }
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lynn-oauth-')); const oauth = new McpOAuth(directory);
  cleanups.push(() => { oauth.dispose(); server.close(); server.closeAllConnections(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { base, oauth, directory, corrupt: () => { resourceMismatch = true; }, refreshCount: () => refreshCount, tokenBody: () => tokenBody };
}
it('completes PKCE authorization, rejects wrong state, refreshes once and keeps tokens out of status', async () => {
  const fixtureData = await fixture(); const { base, oauth, directory } = fixtureData; const resource = `${base}/mcp`;
  const state = await oauth.start('data', resource); const url = new URL(state.authorizationUrl!);
  expect(url.searchParams.get('code_challenge_method')).toBe('S256'); expect(url.searchParams.get('resource')).toBe(resource); expect(url.searchParams.get('scope')).toBe('data:read');
  expect((await fetch(`${state.redirectUri}?state=wrong&code=code`)).status).toBe(400);
  expect((await fetch(`${state.redirectUri}?state=${url.searchParams.get('state')}&code=code`)).status).toBe(200);
  const verifier = fixtureData.tokenBody()!.get('code_verifier')!;
  expect(createHash('sha256').update(verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
  const headers = await Promise.all([oauth.headers('data', resource), oauth.headers('data', resource)]);
  expect(headers[0].Authorization).toBe('Bearer second-secret'); expect(fixtureData.refreshCount()).toBe(1);
  const file = path.join(directory, fs.readdirSync(directory)[0]); expect(JSON.parse(fs.readFileSync(file, 'utf8')).refreshToken).toBe('refresh-secret');
  if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(oauth.status('data', resource))).not.toContain('secret');
  oauth.disconnect('data', resource); expect(await oauth.headers('data', resource)).toEqual({});
});
it('rejects resource substitution and insecure remote authorization endpoints', async () => {
  const { base, corrupt } = await fixture(); corrupt();
  await expect(discoverMcpOAuth(`${base}/mcp`)).rejects.toThrow('does not match');
  await expect(discoverMcpOAuth('http://example.com/mcp')).rejects.toThrow('HTTPS');
});
it('blocks private, mapped and reserved addresses before making an OAuth request', async () => {
  for (const ip of ['10.0.0.1', '127.2.3.4', '169.254.169.254', '100.64.0.1', '192.168.1.1', '224.0.0.1', '::ffff:127.0.0.1', 'fc01::1', 'fe80::1', '2001:db8::1']) expect(isPublicOAuthAddress(ip)).toBe(false);
  expect(isPublicOAuthAddress('8.8.8.8')).toBe(true); expect(isPublicOAuthAddress('2606:4700::1111')).toBe(true);
  await expect(oauthRequest('https://[fc01::1]/token')).rejects.toThrow('private');
});
