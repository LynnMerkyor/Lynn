import type { ClientToolResult, ToolRunContext } from "./types.js";
import { isIP } from "node:net";

// Read-only web fetch + zero-dependency HTML simplification. Native, in-process,
// SSRF-guarded, size/time bounded. The CLI counterpart of GA's optHTML — for the
// GUI the same job runs in an Electron BrowserView against a (possibly logged-in)
// real tab; here we fetch static HTML over Node and strip it to readable text.

const DEFAULT_MAX_CHARS = 12000;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export function webScanEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LYNN_CLI_WEB_SCAN === "1";
}

/** Block loopback / private / link-local / cloud-metadata hosts (SSRF guard). */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0" || h === "::1" || h === "::") return true;
  if (h === "169.254.169.254" || h === "metadata.google.internal") return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
  }
  if (isIP(h) === 6) {
    if (/^(fc|fd|fe[89ab]|ff)/.test(h)) return true;
    if (h.startsWith("::ffff:")) {
      const mapped = h.slice(7);
      if (isIP(mapped) === 4) return isBlockedHost(mapped);
      const parts = mapped.split(":").map(part => Number.parseInt(part, 16));
      if (parts.length === 2 && parts.every(Number.isFinite)) return isBlockedHost(`${parts[0]! >> 8}.${parts[0]! & 255}.${parts[1]! >> 8}.${parts[1]! & 255}`);
      return true;
    }
  }
  return false;
}

export function validateWebUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`web_scan: invalid URL "${raw}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`web_scan: only http/https allowed (got ${url.protocol})`);
  }
  if (url.username || url.password) throw new Error("web_scan: URL credentials are not allowed");
  if (isBlockedHost(url.hostname)) {
    throw new Error(`web_scan: blocked host (loopback/private/metadata): ${url.hostname}`);
  }
  return url;
}

const ENTITY: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " ",
};
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITY[m] || m)
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return _; } });
}

export interface SimplifiedPage {
  title: string;
  text: string;
  truncated: boolean;
}

/** Strip a static HTML document to token-frugal readable text. */
export function simplifyHtml(html: string, maxChars = DEFAULT_MAX_CHARS): SimplifiedPage {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim();
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|svg|head|template|iframe)\b[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|ul|ol|table|blockquote|pre)\s*>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const truncated = s.length > maxChars;
  if (truncated) s = `${s.slice(0, maxChars)}\n…[truncated ${s.length - maxChars} more chars]`;
  return { title, text: s, truncated };
}

export async function webScanTool(ctx: ToolRunContext, rawUrl: string): Promise<ClientToolResult> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(ctx.signal?.reason);
  if (ctx.signal?.aborted) onAbort();
  else ctx.signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!rawUrl) throw new Error("url is required for web_scan");
    let url = validateWebUrl(rawUrl);
    controller.signal.throwIfAborted();
    const timeoutMs = ctx.timeoutMs && ctx.timeoutMs > 0 ? Math.min(ctx.timeoutMs, 60000) : DEFAULT_TIMEOUT_MS;
    timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response | undefined;
    for (let hop = 0; hop <= 5; hop++) {
      controller.signal.throwIfAborted();
      res = await fetch(url, {
        signal: controller.signal,
        redirect: "manual",
        headers: { "user-agent": "Lynn-CLI-web_scan/1.0", accept: "text/html,text/plain,*/*" },
      });
      if (![301, 302, 303, 307, 308].includes(res.status)) break;
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (!location || hop === 5) throw new Error("web_scan: invalid or excessive redirects");
      url = validateWebUrl(new URL(location, url).href);
    }
    if (!res) throw new Error("web_scan: no response");
    const contentType = res.headers.get("content-type") || "";
    const raw = await readCapped(res, MAX_BODY_BYTES);
    const isHtml = /html/i.test(contentType) || /^\s*</.test(raw);
    const page = isHtml
      ? simplifyHtml(raw)
      : { title: "", text: raw.slice(0, DEFAULT_MAX_CHARS), truncated: raw.length > DEFAULT_MAX_CHARS };
    return {
      ok: res.ok,
      tool: "web_scan",
      output: { url: url.toString(), status: res.status, contentType, title: page.title, truncated: page.truncated, text: page.text },
    };
  } catch (error) {
    return { ok: false, tool: "web_scan", error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", onAbort);
  }
}

/** Stream the body and stop at maxBytes so a huge response can't blow up memory/tokens. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, maxBytes);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= out.length) break;
    const take = Math.min(chunk.length, out.length - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(out);
}
