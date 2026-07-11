import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWebContent } from "../lib/tools/web-fetch.js";

describe("web_fetch SSRF boundary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never forwards a blocked private URL to the external reader fallback", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWebContent("http://127.0.0.1:8787/api/config"))
      .rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks additional non-public IPv4 and IPv4-mapped IPv6 ranges", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const url of [
      "http://100.64.0.1/",
      "http://198.18.0.1/",
      "http://224.0.0.1/",
      "http://[::ffff:192.168.1.2]/",
    ]) {
      await expect(fetchWebContent(url)).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
