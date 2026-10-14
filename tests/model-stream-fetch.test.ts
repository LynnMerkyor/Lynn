import http from "node:http";
import { once } from "node:events";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { modelStreamFetch } from "../shared/model-stream-fetch.js";
import { modelStreamFetch as cloudModelStreamFetch } from "../brain-v2-mirror/wire-adapter/_model-fetch.js";

const previous = getGlobalDispatcher();
const agent = new Agent({ headersTimeout: 50, bodyTimeout: 50 });
const durationMs = process.env.LYNN_TEST_LONG_SILENCE === "1" ? 310_000 : 1300;
beforeAll(() => setGlobalDispatcher(agent));
afterAll(async () => { setGlobalDispatcher(previous); await agent.close(); });

it("delegates through the current dispatcher and overrides only stream phase limits", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
  const dispatchMock = vi.spyOn(agent, "dispatch").mockReturnValue(true);
  const controller = new AbortController();
  try {
    for (const implementation of [modelStreamFetch, cloudModelStreamFetch]) {
      await implementation("http://localhost", { method: "POST", body: "{}", signal: controller.signal });
      const options = fetchMock.mock.calls.at(-1)![1] as RequestInit & { dispatcher: { dispatch: Agent["dispatch"] } };
      expect(options.signal).toBe(controller.signal);
      const request = { origin: "http://localhost", path: "/", method: "POST" as const, headersTimeout: 300000, bodyTimeout: 300000, opaque: "keep" };
      options.dispatcher.dispatch(request, {});
      expect(dispatchMock).toHaveBeenLastCalledWith({ ...request, headersTimeout: 0, bodyTimeout: 0 }, {});
      expect(getGlobalDispatcher()).toBe(agent);
    }
  } finally { fetchMock.mockRestore(); dispatchMock.mockRestore(); }
});

it("keeps silent header and body waits alive on both client and cloud transports", async () => {
  await Promise.all([modelStreamFetch, cloudModelStreamFetch].flatMap(implementation => [false, true].map(async bodyWait => {
    const server = http.createServer((request, response) => {
      request.resume();
      if (bodyWait) { response.writeHead(200); response.write("start-"); }
      const timer = setTimeout(() => response.end("complete"), durationMs);
      response.once("close", () => clearTimeout(timer));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const started = Date.now();
    try {
      const response = await implementation(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(durationMs + 5000) });
      expect(await response.text()).toBe(bodyWait ? "start-complete" : "complete");
      expect(Date.now() - started).toBeGreaterThanOrEqual(durationMs);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  })));
}, durationMs + 15000);

it("still cancels a stalled request through the caller signal", async () => {
  const server = http.createServer(request => request.resume());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    for (const implementation of [modelStreamFetch, cloudModelStreamFetch]) {
      await expect(implementation(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(20) })).rejects.toThrow();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
