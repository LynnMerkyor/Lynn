"use strict";

const { lookup } = require("dns").promises;
const { isIP } = require("net");

// SSRF guard for the model-driven browser agent. A logged-in, autonomous browser
// must not be navigable to internal services (the local brain server, GPU
// endpoints, LAN hosts, cloud metadata). Opt out with LYNN_BROWSER_ALLOW_PRIVATE=1
// for deliberate local-dev browsing.

function isBlockedBrowserHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0" || h === "::1" || h === "::") return true;
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
    if (a >= 224 || (a === 255 && b === 255)) return true;
  }
  if (
    h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")
    || h.startsWith("::ffff:127") || h.startsWith("::ffff:10")
    || h.startsWith("::ffff:192.168") || /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(h)
    || h.startsWith("::ffff:169.254")
  ) return true;
  return false;
}

function isAllowedBrowserUrl(url, env) {
  const e = env || process.env;
  try {
    const p = new URL(url);
    if (p.protocol !== "http:" && p.protocol !== "https:") return false;
    if (e.LYNN_BROWSER_ALLOW_PRIVATE !== "1" && isBlockedBrowserHost(p.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

async function isAllowedBrowserUrlResolved(url, env, lookupFn = lookup) {
  const e = env || process.env;
  if (!isAllowedBrowserUrl(url, e)) return false;
  if (e.LYNN_BROWSER_ALLOW_PRIVATE === "1") return true;
  try {
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
    if (isIP(hostname)) return !isBlockedBrowserHost(hostname);
    const results = await lookupFn(hostname, { all: true });
    return Array.isArray(results)
      && results.length > 0
      && results.every((entry) => !isBlockedBrowserHost(entry?.address));
  } catch {
    return false;
  }
}

module.exports = { isBlockedBrowserHost, isAllowedBrowserUrl, isAllowedBrowserUrlResolved };
