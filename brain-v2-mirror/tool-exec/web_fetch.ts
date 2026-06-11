// @ts-nocheck
// Brain v2 · tool-exec/web_fetch
// HTTP fetch + HTML strip,15s timeout,默认截断 8000 chars。
//
// 2026-06-10 SECURITY (SSRF guard): web_fetch 的 URL 由模型/用户控制,必须禁止它打到
// 私网 / loopback / link-local / 云元数据(169.254.0.0/16、metadata.tencentyun.com 等)。
// 三层防御:① URL 字符串层(scheme=http/https、禁用户名密码、禁字面私网 host);
// ② DNS 解析层(解析后任一地址落私网即拒,挡住 metadata 主机名 + 公网域名指向私网);
// ③ 连接层(undici Agent 注入 guardedLookup,connect 时按解析出的真实 IP 复检,封死
//    DNS-rebinding TOCTOU,且对每个 redirect hop 都生效)。redirect 改手动逐跳复检。
// 仅 LYNN_WEB_FETCH_ALLOW_PRIVATE=1 时放行私网(本地调试用,默认关)。
import dns from 'node:dns';

const ALLOW_PRIVATE = /^(1|true|yes|on)$/i.test(String(process.env.LYNN_WEB_FETCH_ALLOW_PRIVATE || '').trim());

const STRIP_PATTERNS = [
  [/<script[^>]*>[\s\S]*?<\/script>/gi, ''],
  [/<style[^>]*>[\s\S]*?<\/style>/gi, ''],
  [/<[^>]+>/g, ' '],
  [/&nbsp;/g, ' '],
  [/&lt;/g, '<'], [/&gt;/g, '>'], [/&amp;/g, '&'],
  [/\s+/g, ' '],
];

// ── SSRF host classification (ported from desktop/model-source-policy.cjs) ──
function stripIpv6Brackets(hostname) {
  const value = String(hostname || '').trim().toLowerCase();
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function parseIpv4Literal(hostname) {
  const parts = String(hostname || '').trim().split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function isPrivateIpv4(octets) {
  if (!Array.isArray(octets) || octets.length !== 4) return false;
  const [a, b, c] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)   // CGNAT 100.64/10
    || (a === 169 && b === 254)              // link-local + cloud metadata
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;                             // multicast + reserved
}

export function isLocalOrPrivateHost(hostname) {
  const host = stripIpv6Brackets(hostname).replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'ip6-localhost' || host === 'ip6-loopback') return true;
  if (host.endsWith('.local')) return true;
  const ipv4 = parseIpv4Literal(host);
  if (ipv4) return isPrivateIpv4(ipv4);
  if (host === '::1' || host === '0:0:0:0:0:0:0:1' || host.startsWith('fe80:')) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;            // ULA fc00::/7
  const mappedIpv4 = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedIpv4) return isPrivateIpv4(parseIpv4Literal(mappedIpv4[1]));
  return false;
}

// DNS lookup that rejects private/loopback resolved addresses. Used both as the
// pre-resolve check (assertSafeUrl) and as undici's connect.lookup (rebind-safe,
// validates the actual IP each connection/redirect hop connects to).
function guardedLookup(hostname, options, callback) {
  let opts, cb;
  if (typeof options === 'function') { cb = options; opts = {}; } else { opts = options || {}; cb = callback; }
  if (ALLOW_PRIVATE) return dns.lookup(hostname, opts, cb);
  dns.lookup(hostname, { all: true, family: opts.family || 0, hints: opts.hints }, (err, addresses) => {
    if (err) return cb(err);
    const list = Array.isArray(addresses) ? addresses : [];
    if (!list.length) return cb(new Error('web_fetch: DNS empty for ' + hostname));
    for (const a of list) {
      if (isLocalOrPrivateHost(a.address)) {
        const e = new Error('web_fetch: blocked private/loopback ' + hostname + ' -> ' + a.address);
        e.code = 'SSRF_BLOCKED';
        return cb(e);
      }
    }
    if (opts.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

function lookupAsync(hostname) {
  // dns.lookup has no built-in timeout; the 15s fetch AbortSignal runs AFTER this pre-resolve,
  // so a slow/blackholed resolver would hang the turn unbounded. Cap the DNS step at 5s.
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('web_fetch: DNS lookup timeout for ' + hostname)), 5000);
    guardedLookup(hostname, { all: true }, (err) => {
      clearTimeout(timer);
      if (err) reject(err); else resolve(true);
    });
  });
}

// URL-string + DNS validation. Throws on anything unsafe. Returns the parsed URL.
export async function assertSafeUrl(urlStr) {
  let u;
  try { u = new URL(String(urlStr || '')); } catch { throw new Error('invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('unsupported scheme ' + u.protocol);
  if (u.username || u.password) throw new Error('credentials in URL not allowed');
  if (!ALLOW_PRIVATE && isLocalOrPrivateHost(u.hostname)) throw new Error('blocked private/loopback host ' + u.hostname);
  if (!ALLOW_PRIVATE) await lookupAsync(u.hostname);   // resolve-and-check (metadata hostname / public→private)
  return u;
}

// undici Agent with connect-time lookup guard (rebind-safe). Best-effort: if
// undici can't be imported, fall back to the default dispatcher — the pre-resolve
// check in assertSafeUrl still blocks private targets (residual: rebind TOCTOU).
let ssrfDispatcher;
try {
  const { Agent } = await import('undici');
  ssrfDispatcher = new Agent({ connect: { lookup: guardedLookup } });
} catch {
  ssrfDispatcher = undefined;
}

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

export async function webFetch(url, maxLength = 8000, { log } = {}) {
  if (!url || typeof url !== 'string') return JSON.stringify({ error: 'invalid URL' });
  let target = url.trim();
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

  let current;
  try {
    current = await assertSafeUrl(target);
  } catch (e) {
    log && log('warn', 'tool-exec/web_fetch blocked: ' + e.message);
    return JSON.stringify({ error: 'blocked: ' + e.message });
  }
  log && log('info', 'tool-exec/web_fetch ' + current.toString());

  try {
    const MAX_HOPS = 5;
    let resp;
    for (let hop = 0; ; hop++) {
      resp = await fetch(current.toString(), {
        signal: AbortSignal.timeout(15_000),
        redirect: 'manual',
        dispatcher: ssrfDispatcher,
        headers: FETCH_HEADERS,
      });
      // Manual redirect: re-validate each hop's Location before following.
      if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
        if (hop >= MAX_HOPS) return JSON.stringify({ error: 'too many redirects' });
        let nextUrl;
        try {
          nextUrl = await assertSafeUrl(new URL(resp.headers.get('location'), current).toString());
        } catch (e) {
          log && log('warn', 'tool-exec/web_fetch blocked redirect: ' + e.message);
          return JSON.stringify({ error: 'blocked redirect: ' + e.message });
        }
        current = nextUrl;
        continue;
      }
      break;
    }
    if (!resp.ok) return JSON.stringify({ error: 'HTTP ' + resp.status });
    const ctype = resp.headers.get('content-type') || '';
    let text;
    if (ctype.includes('application/json')) {
      text = JSON.stringify(await resp.json(), null, 2);
    } else {
      text = await resp.text();
      for (const [re, rep] of STRIP_PATTERNS) text = text.replace(re, rep);
      text = text.trim();
    }
    if (text.length > maxLength) text = text.slice(0, maxLength) + '\n... (truncated)';
    return text || JSON.stringify({ error: 'empty response' });
  } catch (e) {
    log && log('warn', 'tool-exec/web_fetch error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}
