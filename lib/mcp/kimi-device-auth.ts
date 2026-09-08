import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseKimiLoginOutput, type KimiLoginState } from './kimi-datasource.js';

// Official public Kimi Code device-flow client, pinned to the reviewed OAuth source.
const CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
const HOST = 'https://auth.kimi.com';
interface Token { access_token: string; refresh_token: string; expires_at: number; expires_in: number; scope: string; token_type: string }
const refreshing = new Map<string, Promise<void>>();
async function post(endpoint: string, values: Record<string, string>, signal?: AbortSignal) {
  const response = await fetch(`${HOST}/api/oauth/${endpoint}`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ client_id: CLIENT_ID, ...values }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
  const data = await response.json() as Record<string, any>;
  return { ok: response.ok, status: response.status, data };
}
function tokenFromResponse(data: Record<string, any>, previous?: Token): Token {
  const expires = Number(data.expires_in);
  if (typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(expires) || expires <= 0 || !(data.refresh_token || previous?.refresh_token)) throw new Error('Invalid Kimi authorization response');
  return { access_token: data.access_token, refresh_token: data.refresh_token || previous!.refresh_token, expires_at: Math.floor(Date.now() / 1000) + expires, expires_in: expires, scope: typeof data.scope === 'string' ? data.scope : previous?.scope || '', token_type: data.token_type || 'Bearer' };
}
function credentialPath(home: string) { return path.join(home, 'credentials/kimi-code.json'); }
function save(home: string, token: Token) {
  const file = credentialPath(home); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`; fs.writeFileSync(temp, JSON.stringify(token), { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file);
}
export async function refreshManagedKimiCredentials(home: string): Promise<void> {
  let previous: Token;
  try { previous = JSON.parse(fs.readFileSync(credentialPath(home), 'utf8')); }
  catch { throw new Error('Sign in to Kimi Datasource in MCP settings first'); }
  if (previous.expires_at > Date.now() / 1000 + 60) return;
  const pending = refreshing.get(home); if (pending) return pending;
  const run = (async () => {
    const response = await post('token', { grant_type: 'refresh_token', refresh_token: previous.refresh_token });
    if (!response.ok) throw new Error(`Kimi session expired (HTTP ${response.status}); sign in again in MCP settings`);
    const current = JSON.parse(fs.readFileSync(credentialPath(home), 'utf8')) as Token;
    if (current.refresh_token !== previous.refresh_token) return;
    save(home, tokenFromResponse(response.data, previous));
  })().finally(() => refreshing.delete(home));
  refreshing.set(home, run); return run;
}

export class KimiDeviceLogin {
  constructor(private onAuthorized?: () => Promise<void>) {}
  private state: KimiLoginState = { id: '', status: 'idle' };
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  getState() { return { ...this.state }; }
  cancel() { this.controller?.abort(); this.controller = null; if (this.timer) clearTimeout(this.timer); this.timer = null; this.state = { id: this.state.id, status: 'cancelled' }; return this.getState(); }
  async start(home: string) {
    if (this.state.status === 'waiting') return this.getState();
    const controller = new AbortController(); this.controller = controller; this.state = { id: randomUUID(), status: 'waiting' };
    try {
      const response = await post('device_authorization', {}, controller.signal);
      const data = response.data;
      if (!response.ok) throw new Error(`Kimi authorization unavailable (HTTP ${response.status})`);
      const url = typeof data.verification_uri_complete === 'string' ? parseKimiLoginOutput(data.verification_uri_complete).url : undefined;
      if (!url || typeof data.device_code !== 'string' || !data.device_code || typeof data.user_code !== 'string' || !data.user_code) throw new Error('Invalid Kimi device authorization response');
      if (controller.signal.aborted) return this.getState();
      this.state = { id: this.state.id, status: 'waiting', url, code: data.user_code };
      const expiresAt = Date.now() + Math.min(1800, Math.max(1, Number(data.expires_in) || 600)) * 1000;
      let interval = Math.max(5, Number(data.interval) || 5) * 1000;
      const poll = async () => {
        if (controller.signal.aborted) return;
        try {
          if (Date.now() >= expiresAt) throw new Error('Kimi login expired. Start again.');
          const result = await post('token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: data.device_code }, controller.signal);
          if (controller.signal.aborted) return;
          if (result.ok) { save(home, tokenFromResponse(result.data)); await this.onAuthorized?.(); if (!controller.signal.aborted) this.state = { id: this.state.id, status: 'complete' }; this.controller = null; return; }
          if (result.data.error === 'slow_down') interval += 5000;
          else if (result.data.error !== 'authorization_pending' && result.status < 500 && result.status !== 429) throw new Error(result.data.error === 'access_denied' ? 'Kimi authorization denied' : 'Kimi login expired or failed. Start again.');
          this.timer = setTimeout(poll, interval); this.timer.unref();
        } catch (error) { if (!controller.signal.aborted) { this.state = { id: this.state.id, status: 'failed', error: (error as Error).message }; this.controller = null; } }
      };
      this.timer = setTimeout(poll, interval); this.timer.unref(); return this.getState();
    } catch (error) { if (!controller.signal.aborted) this.state = { id: this.state.id, status: 'failed', error: (error as Error).message }; throw error; }
  }
}
