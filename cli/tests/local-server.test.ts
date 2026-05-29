import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fetchLocalServerJson, readLocalServerInfo } from "../src/local-server.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-local-server-"));
  tmpDirs.push(dir);
  return dir;
}

describe("local server discovery", () => {
  it("reports missing server-info without reading user secrets", async () => {
    const dir = await makeTmpDir();
    await expect(readLocalServerInfo(dir)).resolves.toMatchObject({ status: "missing" });
  });

  it("rejects stale server pid records", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(path.join(dir, "server-info.json"), JSON.stringify({
      pid: 9_999_999,
      port: 31234,
      token: "secret-token",
    }));

    await expect(readLocalServerInfo(dir)).resolves.toMatchObject({
      status: "stale",
      url: "http://127.0.0.1:31234",
    });
  });

  it("uses bearer auth when fetching local server JSON", async () => {
    const server = http.createServer((req, res) => {
      expect(req.headers.authorization).toBe("Bearer local-token");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a port");

    try {
      const body = await fetchLocalServerJson<{ ok: boolean }>({
        status: "ok",
        url: `http://127.0.0.1:${address.port}`,
        token: "local-token",
      }, "/api/providers/summary");
      expect(body).toEqual({ ok: true });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
