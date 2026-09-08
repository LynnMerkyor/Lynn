import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { createServer as createHttpsServer } from "node:https";
import QRCode from "qrcode";
import { fromRoot } from "../../shared/lynn-root.js";
import { readCookieValue } from "../auth-token.js";
import { sessionIdForPath, registerSessionFile, resolveSessionFile } from "../../lib/session-files.js";
import { MobileDeviceStore } from "./device-store.js";

interface Session { path: string; title?: string | null; firstMessage?: string | null; agentId?: string | null }
interface Dependencies {
  home: string;
  listSessions(): Promise<Session[]> | Session[];
  request(url: string, init?: RequestInit): Promise<Response> | Response;
  send(sessionPath: string, text: string): Promise<unknown>;
  isStreaming(sessionPath: string): boolean;
  abort(sessionPath: string): Promise<unknown>;
}
interface Config { enabled: boolean; port: number; publicUrl: string }
const ASSETS: Record<string, [string, string]> = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/app.css': ['app.css', 'text/css'], '/sw.js': ['sw.js', 'text/javascript'], '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'], '/icon.svg': ['icon.svg', 'image/svg+xml'] };

export class MobileService {
  readonly devices: MobileDeviceStore;
  readonly app = new Hono();
  private server: ReturnType<typeof serve> | null = null;
  private config: Config = { enabled: false, port: 0, publicUrl: '' };
  private busy = new Map<string, { deviceId: string; error?: string }>();
  private changing: Promise<unknown> = Promise.resolve();
  private readError?: string;
  constructor(private deps: Dependencies) {
    this.devices = new MobileDeviceStore(path.join(deps.home, 'user/mobile-devices.json'));
    try { const config = JSON.parse(fs.readFileSync(path.join(deps.home, 'user/mobile.json'), 'utf8')); this.config = { enabled: config.enabled === true, port: Number(config.port) || 0, publicUrl: String(config.publicUrl || '') }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.readError = 'Mobile settings are unreadable. Repair the local file before enabling mobile access.'; }
    this.configureRoutes();
  }
  private secure() { return !!(process.env.LYNN_MOBILE_CERT && process.env.LYNN_MOBILE_KEY) || this.config.publicUrl.startsWith('https:'); }
  private urls() {
    if (!this.server) return [];
    if (this.config.publicUrl) return [this.config.publicUrl];
    const addresses = Object.values(os.networkInterfaces()).flat().filter(address => address?.family === 'IPv4' && !address.internal).map(address => address!.address);
    return [...new Set(addresses.length ? addresses : ['127.0.0.1'])].map(address => `${this.secure() ? 'https' : 'http'}://${address}:${this.config.port}`);
  }
  status() { return { enabled: !!this.server, port: this.config.port, publicUrl: this.config.publicUrl, urls: this.urls(), secure: this.secure(), devices: this.devices.list(), error: this.readError || this.devices.readError }; }
  async restore() { if (this.config.enabled) await this.start(); }
  private persist() {
    const directory = path.join(this.deps.home, 'user'); fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'mobile.json'); const temp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.config), { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file);
  }
  update(enabled: boolean, publicUrl?: string) {
    const operation = this.changing.catch(() => {}).then(async () => {
      if (this.readError || this.devices.readError) throw new Error(this.readError || this.devices.readError);
      if (publicUrl) { const url = new URL(publicUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Mobile public URL must be an HTTP(S) origin'); }
      await this.stop(); this.config = { ...this.config, enabled, publicUrl: publicUrl === undefined ? this.config.publicUrl : publicUrl.replace(/\/$/, '') };
      if (enabled) await this.start(); this.persist(); return this.status();
    });
    this.changing = operation; return operation;
  }
  private async start() {
    if (this.server) return;
    if (this.readError || this.devices.readError) throw new Error(this.readError || this.devices.readError);
    const cert = process.env.LYNN_MOBILE_CERT; const key = process.env.LYNN_MOBILE_KEY;
    if (!!cert !== !!key) throw new Error('Configure both LYNN_MOBILE_CERT and LYNN_MOBILE_KEY for HTTPS');
    const options = { fetch: this.app.fetch, hostname: process.env.LYNN_MOBILE_BIND || '0.0.0.0', port: this.config.port };
    const server = cert && key ? serve({ ...options, createServer: createHttpsServer, serverOptions: { cert: fs.readFileSync(cert), key: fs.readFileSync(key) } }) : serve(options);
    try { await new Promise<void>((resolve, reject) => { server.once('error', reject); if (server.listening) resolve(); else server.once('listening', resolve); }); }
    catch (error) { server.close(); throw error; }
    this.server = server; this.config.port = (server.address() as { port: number }).port;
  }
  async stop() { const server = this.server; this.server = null; this.devices.clearPairing(); if (server) { (server as import('node:http').Server).closeAllConnections?.(); await new Promise<void>(resolve => server.close(() => resolve())); } }
  async pairing() {
    const url = this.urls()[0]; if (!url) throw new Error('Enable mobile access first');
    const pair = this.devices.createPairing(); const link = `${url}/#pair=${pair.code}`;
    return { url: link, expiresAt: pair.expiresAt, qr: await QRCode.toDataURL(link, { width: 240, margin: 2 }) };
  }
  private async session(id: string) {
    if (!/^[a-f0-9]{32}$/.test(id)) return null;
    return (await this.deps.listSessions()).find(session => { try { return sessionIdForPath(session.path) === id; } catch { return false; } }) || null;
  }
  private configureRoutes() {
    this.app.use('*', async (c, next) => {
      c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff'); c.header('Referrer-Policy', 'no-referrer');
      const host = c.req.header('host') || '';
      const configured = this.urls().map(value => new URL(value).host);
      const allowed = new Set([...configured, `127.0.0.1:${this.config.port}`, `localhost:${this.config.port}`]);
      if (!allowed.has(host)) return c.json({ error: 'Unrecognized mobile host' }, 403);
      const origin = c.req.header('origin');
      if (origin && ![...allowed].some(value => origin === `http://${value}` || origin === `https://${value}`)) return c.json({ error: 'Invalid origin' }, 403);
      if (c.req.path.startsWith('/api/') && c.req.path !== '/api/pair') {
        const token = readCookieValue(c.req.header('cookie'), 'lynn_mobile') || (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
        if (!this.devices.authenticate(token)) return c.json({ error: 'Pair this device in Lynn settings' }, 401);
      }
      await next();
    });
    this.app.use('/api/*', bodyLimit({ maxSize: 12 * 1024 * 1024 }));
    for (const [url, [file, type]] of Object.entries(ASSETS)) this.app.get(url, c => {
      c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      c.header('Content-Type', `${type}; charset=utf-8`);
      return c.body(fs.readFileSync(fromRoot('server', 'mobile', 'public', file)));
    });
    this.app.post('/api/pair', async c => {
      try {
        const body = await c.req.json(); if (typeof body.code !== 'string' || body.code.length > 100) throw new Error('Invalid pairing code');
        const result = this.devices.pair(body.code, typeof body.name === 'string' ? body.name : 'Mobile');
        c.header('Set-Cookie', `lynn_mobile=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${this.secure() ? '; Secure' : ''}`);
        return c.json({ ok: true });
      } catch { return c.json({ error: 'Pairing code is invalid, expired, or the device limit was reached. Generate a new code in Lynn settings.' }, 400); }
    });
    this.app.get('/api/sessions', async c => c.json({ sessions: (await this.deps.listSessions()).flatMap(session => {
      try { return [{ id: sessionIdForPath(session.path), title: session.title || session.firstMessage || 'Lynn', busy: this.deps.isStreaming(session.path) || this.busy.has(session.path) }]; } catch { return []; }
    }) }));
    this.app.get('/api/sessions/:id/messages', async c => {
      const session = await this.session(c.req.param('id')); if (!session) return c.json({ error: 'Session not found' }, 404);
      const before = c.req.query('before');
      const response = await this.deps.request(`/api/sessions/messages?path=${encodeURIComponent(session.path)}&limit=100${before && /^\d+$/.test(before) ? `&before=${before}` : ''}`);
      if (!response.ok) return response;
      return c.json({ ...await response.json(), busy: this.busy.has(session.path) || this.deps.isStreaming(session.path) });
    });
    this.app.post('/api/sessions/:id/messages', async c => {
      const session = await this.session(c.req.param('id')); if (!session) return c.json({ error: 'Session not found' }, 404);
      if (this.busy.has(session.path) || this.deps.isStreaming(session.path)) return c.json({ error: 'This session is busy. Wait for the current reply.' }, 409);
      const body = await c.req.json();
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 50000) return c.json({ error: 'Enter a message up to 50,000 characters' }, 400);
      const fileIds: unknown[] = Array.isArray(body.fileIds) ? body.fileIds.slice(0, 9) : [];
      let attachments: string[];
      try { attachments = fileIds.map(id => { if (typeof id !== 'string') throw new Error(); const { file, localPath } = resolveSessionFile(session.path, id); return `[Attachment: ${file.name}] ${localPath}`; }); }
      catch { return c.json({ error: 'Attachment unavailable in this session' }, 400); }
      const text = [body.text.trim(), ...attachments].join('\n\n');
      this.busy.set(session.path, { deviceId: '' });
      try { await this.deps.send(session.path, text); return c.json({ ok: true }); }
      catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Message failed' }, 500); }
      finally { this.busy.delete(session.path); }
    });
    this.app.post('/api/sessions/:id/abort', async c => {
      const session = await this.session(c.req.param('id')); if (!session) return c.json({ error: 'Session not found' }, 404);
      await this.deps.abort(session.path); return c.json({ ok: true });
    });
    this.app.post('/api/sessions/:id/upload', async c => {
      const session = await this.session(c.req.param('id')); if (!session) return c.json({ error: 'Session not found' }, 404);
      const form = await c.req.formData(); const file = form.get('file');
      if (!file || typeof file === 'string' || file.size > 10 * 1024 * 1024) return c.json({ error: 'Choose one file up to 10 MB' }, 400);
      const directory = path.join(this.deps.home, 'mobile-staging'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(directory, randomUUID() + path.extname(file.name).slice(0, 16));
      try { fs.writeFileSync(temporary, Buffer.from(await file.arrayBuffer()), { flag: 'wx', mode: 0o600 }); return c.json(registerSessionFile(session.path, temporary, { copy: true, name: file.name })); }
      finally { try { fs.unlinkSync(temporary); } catch { /* No leftover source on success or failure. */ } }
    });
    this.app.get('/api/session-files/:sessionId', c => this.deps.request(c.req.path));
    this.app.get('/api/session-files/:sessionId/:fileId', c => this.deps.request(c.req.path));
    this.app.onError((_error, c) => c.json({ error: 'Mobile request failed' }, 500));
  }
}

export function createMobileSettingsRoute(service: MobileService) {
  const route = new Hono();
  route.get('/mobile/settings', c => c.json(service.status()));
  route.post('/mobile/settings', async c => {
    try { const body = await c.req.json(); if (typeof body.enabled !== 'boolean' || body.publicUrl !== undefined && typeof body.publicUrl !== 'string') throw new Error('Invalid mobile settings'); return c.json(await service.update(body.enabled, body.publicUrl)); }
    catch (error) { return c.json({ error: (error as Error).message }, 400); }
  });
  route.post('/mobile/pairing', async c => { try { return c.json(await service.pairing()); } catch (error) { return c.json({ error: (error as Error).message }, 400); } });
  route.delete('/mobile/devices/:id', c => { service.devices.revoke(c.req.param('id')); return c.json({ ok: true }); });
  return route;
}
