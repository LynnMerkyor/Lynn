import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [ip, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]] as const) blocked.addSubnet(ip, prefix, "ipv4");
blocked.addSubnet("2001:db8::", 32, "ipv6");
const globalV6 = new BlockList(); globalV6.addSubnet("2000::", 3, "ipv6");
export function isPublicOAuthAddress(address: string): boolean {
  return isIP(address) === 4 ? !blocked.check(address, "ipv4") : isIP(address) === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

/** Resolve once and pin the socket to a checked address. Never follow redirects. */
export async function oauthRequest(value: string | URL, init: RequestInit = {}, headersOnly = false): Promise<Response> {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const local = ["localhost", "127.0.0.1", "::1"].includes(hostname);
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) throw new Error("Invalid OAuth endpoint");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
    lookup(hostname, { all: true }),
    new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("OAuth DNS timeout")), 5000); timeout.unref(); }),
  ]).finally(() => clearTimeout(timeout));
  if (!addresses.length || addresses.some(item => local ? !["127.0.0.1", "::1"].includes(item.address) : !isPublicOAuthAddress(item.address))) throw new Error("Remote OAuth discovery cannot use a private endpoint");
  const address = addresses[0];
  return new Promise<Response>((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(url, {
      method: init.method || "GET", headers: Object.fromEntries(new Headers(init.headers)),
      signal: AbortSignal.timeout(15000),
      lookup: (_hostname, options, callback) => {
        // Node may request an address list for autoSelectFamily.
        if (typeof options === "object" && options.all) callback(null, [address] as any);
        else callback(null, address.address, address.family);
      },
    }, response => {
      const headers = new Headers(); for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      if (headersOnly) { resolve(new Response(null, { status: response.statusCode || 500, headers })); response.destroy(); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { response.destroy(new Error("OAuth response is too large")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve(new Response([204, 304].includes(response.statusCode || 0) ? null : Buffer.concat(chunks), { status: response.statusCode || 500, headers })));
    });
    request.on("error", reject);
    if (init.body) request.write(String(init.body));
    request.end();
  });
}
