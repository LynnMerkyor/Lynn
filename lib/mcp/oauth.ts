import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { oauthRequest } from "./oauth-request.js";

interface TokenRecord { resource: string; clientId: string; tokenEndpoint: string; accessToken: string; refreshToken?: string; expiresAt: number }
interface OAuthState { status: "idle" | "waiting" | "authorized" | "failed"; authorizationUrl?: string; redirectUri?: string; error?: string }
interface Flow { state: OAuthState; close(): void }
export interface McpOAuthConfig { clientId?: string; scope?: string }

function checkedUrl(value: unknown, allowLoopback: boolean): URL {
  if (typeof value !== "string") throw new Error("Missing OAuth endpoint");
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(allowLoopback && loopback && url.protocol === "http:"))) throw new Error("OAuth endpoints require HTTPS (HTTP is allowed only for local development)");
  if (!allowLoopback && (loopback || /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(url.hostname))) throw new Error("Remote OAuth discovery cannot use a private endpoint");
  return url;
}

async function jsonRequest(url: string, init: RequestInit = {}): Promise<Record<string, any>> {
  const response = await oauthRequest(url, init);
  if (!response.ok) throw new Error(`OAuth endpoint returned HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error("OAuth response is too large");
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid OAuth response");
  return data;
}
async function firstMetadata(urls: string[]) {
  for (const url of [...new Set(urls)]) { try { return await jsonRequest(url); } catch { /* Next standard discovery URL. */ } }
  throw new Error("OAuth metadata unavailable");
}

export async function discoverMcpOAuth(resource: string): Promise<Record<string, any>> {
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(resource).hostname);
  const server = checkedUrl(resource, local);
  let challenge = "";
  try {
    const response = await oauthRequest(server, { headers: { Accept: "application/json, text/event-stream" } }, true);
    challenge = response.headers.get("www-authenticate") || "";
    await response.body?.cancel();
  } catch { /* Well-known discovery remains available. */ }
  const hinted = challenge.match(/resource_metadata\s*=\s*"([^"]+)"/i)?.[1];
  const resourceMetadata = await firstMetadata(hinted ? [checkedUrl(hinted, local).href] : [
    `${server.origin}/.well-known/oauth-protected-resource${server.pathname === "/" ? "" : server.pathname}`,
    `${server.origin}/.well-known/oauth-protected-resource`,
  ]);
  if (typeof resourceMetadata.resource !== "string" || new URL(resourceMetadata.resource).href !== server.href) throw new Error("OAuth resource metadata does not match this MCP server");
  const issuer = checkedUrl(resourceMetadata.authorization_servers?.[0], local);
  const suffix = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");
  const metadata = await firstMetadata([
    `${issuer.origin}/.well-known/oauth-authorization-server${suffix}`,
    `${issuer.origin}/.well-known/openid-configuration${suffix}`,
    `${issuer.origin}${suffix}/.well-known/openid-configuration`,
  ]);
  if (new URL(String(metadata.issuer)).href !== issuer.href) throw new Error("OAuth issuer mismatch");
  if (!metadata.code_challenge_methods_supported?.includes("S256")) throw new Error("OAuth server must support PKCE S256");
  for (const key of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
    if (!metadata[key] && key === "registration_endpoint") continue;
    const endpoint = checkedUrl(metadata[key], local);
    if (endpoint.origin !== issuer.origin) throw new Error("OAuth endpoint must belong to its advertised issuer");
    metadata[key] = endpoint.href;
  }
  return { ...metadata, scope: challenge.match(/(?:^|[,\s])scope\s*=\s*"([^"]*)"/i)?.[1] || (Array.isArray(resourceMetadata.scopes_supported) ? resourceMetadata.scopes_supported.join(" ") : "") };
}

export class McpOAuth {
  private flows = new Map<string, Flow>();
  private refreshes = new Map<string, Promise<TokenRecord>>();
  constructor(private directory: string) {}
  private key(name: string, resource: string) { return createHash("sha256").update(name).update("\0").update(resource).digest("hex"); }
  private read(key: string): TokenRecord | null {
    try { return JSON.parse(fs.readFileSync(path.join(this.directory, `${key}.json`), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("Local MCP OAuth credentials are unreadable; sign in again"); }
  }
  private save(key: string, record: TokenRecord) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, `${key}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file);
  }
  status(name: string, resource: string): OAuthState {
    const key = this.key(name, resource);
    return { ...(this.flows.get(key)?.state || { status: this.read(key) ? "authorized" : "idle" }) };
  }
  disconnect(name: string, resource: string) {
    const key = this.key(name, resource); this.flows.get(key)?.close(); this.flows.delete(key);
    try { fs.unlinkSync(path.join(this.directory, `${key}.json`)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  dispose() { for (const flow of this.flows.values()) flow.close(); this.flows.clear(); }
  async start(name: string, resource: string, config: McpOAuthConfig = {}): Promise<OAuthState> {
    const key = this.key(name, resource);
    const previous = this.flows.get(key);
    if (previous?.state.status === "waiting") return { ...previous.state };
    previous?.close();
    const metadata = await discoverMcpOAuth(resource);
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    let consumed = false;
    let clientId = config.clientId || "";
    let redirectUri = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flow: Flow = { state: { status: "waiting" }, close: () => { clearTimeout(timer); server.close(); } };
    const server = http.createServer(async (req, res) => {
      res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.setHeader("Content-Security-Policy", "default-src 'none'");
      const url = new URL(req.url || "/", redirectUri);
      const received = url.searchParams.get("state") || "";
      if (req.method !== "GET" || url.pathname !== "/callback" || consumed || !/^[A-Za-z0-9_-]{43}$/.test(received) || !timingSafeEqual(Buffer.from(received), Buffer.from(state))) { res.writeHead(400).end("Invalid OAuth callback"); return; }
      consumed = true;
      try {
        const code = url.searchParams.get("code");
        if (url.searchParams.has("error") || !code) throw new Error("OAuth authorization was denied or cancelled");
        if (url.searchParams.has("iss") && new URL(url.searchParams.get("iss")!).href !== new URL(metadata.issuer).href) throw new Error("OAuth callback issuer mismatch");
        const token = await this.exchange(metadata.token_endpoint, { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier, resource });
        if (this.flows.get(key) !== flow || flow.state.status !== "waiting") throw new Error("OAuth authorization was cancelled or expired");
        this.save(key, this.tokenRecord(token, { resource, clientId, tokenEndpoint: metadata.token_endpoint, accessToken: "", expiresAt: 0 }));
        flow.state = { status: "authorized" };
        res.end("Authorization complete. Return to Lynn.");
      } catch (error) { flow.state = { status: "failed", error: (error as Error).message }; res.writeHead(400).end("Authorization failed. Return to Lynn."); }
      finally { flow.close(); }
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
    redirectUri = `http://127.0.0.1:${(server.address() as { port: number }).port}/callback`;
    try {
      if (!clientId) {
        if (!metadata.registration_endpoint) throw new Error("This MCP requires a registered OAuth client ID. Enter it in the server's OAuth settings.");
        const registration = await jsonRequest(metadata.registration_endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Lynn", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
        if (registration.client_secret || typeof registration.client_id !== "string" || !registration.client_id) throw new Error("MCP OAuth requires a public client with no client secret");
        clientId = registration.client_id;
      }
      const url = new URL(metadata.authorization_endpoint);
      const parameters = { response_type: "code", client_id: clientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: "S256", resource, scope: config.scope || metadata.scope || "" };
      for (const [key, value] of Object.entries(parameters)) if (value) url.searchParams.set(key, value);
      flow.state = { status: "waiting", authorizationUrl: url.href, redirectUri };
      this.flows.set(key, flow);
      timer = setTimeout(() => { flow.state = { status: "failed", error: "OAuth authorization expired" }; flow.close(); }, 5 * 60_000); timer.unref(); server.unref();
      return { ...flow.state };
    } catch (error) { flow.close(); throw error; }
  }
  private exchange(endpoint: string, body: Record<string, string>) { return jsonRequest(endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) }); }
  private tokenRecord(token: Record<string, any>, previous: TokenRecord): TokenRecord {
    if (typeof token.access_token !== "string" || !token.access_token || String(token.token_type || "Bearer").toLowerCase() !== "bearer") throw new Error("Invalid OAuth bearer token response");
    return { ...previous, accessToken: token.access_token, refreshToken: typeof token.refresh_token === "string" && token.refresh_token ? token.refresh_token : previous.refreshToken, expiresAt: Number.isFinite(Number(token.expires_in)) ? Date.now() + Math.max(0, Number(token.expires_in)) * 1000 : Number.MAX_SAFE_INTEGER };
  }
  async headers(name: string, resource: string, force = false): Promise<Record<string, string>> {
    const key = this.key(name, resource); let record = this.read(key);
    if (!record) return {};
    if (record.resource !== resource) throw new Error("MCP OAuth resource mismatch");
    if (force || record.expiresAt < Date.now() + 60000) {
      if (!record.refreshToken) throw new Error("MCP OAuth session expired; sign in again");
      let refreshing = this.refreshes.get(key);
      if (!refreshing) {
        const previous = record;
        refreshing = this.exchange(record.tokenEndpoint, { grant_type: "refresh_token", refresh_token: record.refreshToken, client_id: record.clientId, resource }).then(token => {
          const next = this.tokenRecord(token, previous);
          // Disconnect during refresh must not resurrect credentials.
          if (this.read(key)?.accessToken === previous.accessToken) this.save(key, next);
          else throw new Error("MCP OAuth credentials changed during refresh");
          return next;
        }).finally(() => this.refreshes.delete(key));
        this.refreshes.set(key, refreshing);
      }
      record = await refreshing;
    }
    return { Authorization: `Bearer ${record.accessToken}` };
  }
}
