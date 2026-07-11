import { describe, expect, it } from "vitest";
import {
  isAllowedLocalOrigin,
  isLoopbackHostHeader,
  isTrustedLocalRequest,
} from "../server/request-security.js";

describe("local server request boundary", () => {
  it("accepts loopback host headers used by desktop and CLI", () => {
    expect(isLoopbackHostHeader("127.0.0.1:3210")).toBe(true);
    expect(isLoopbackHostHeader("localhost:3210")).toBe(true);
    expect(isLoopbackHostHeader("[::1]:3210")).toBe(true);
  });

  it("rejects DNS rebinding and malformed host headers", () => {
    expect(isLoopbackHostHeader("attacker.example:3210")).toBe(false);
    expect(isLoopbackHostHeader("127.0.0.1.attacker.example")).toBe(false);
    expect(isLoopbackHostHeader("")).toBe(false);
  });

  it("allows no Origin for native clients and loopback browser origins", () => {
    expect(isAllowedLocalOrigin("")).toBe(true);
    expect(isAllowedLocalOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedLocalOrigin("https://127.0.0.1:5173")).toBe(true);
    expect(isAllowedLocalOrigin("https://attacker.example")).toBe(false);
  });

  it("allows packaged Electron opaque origins only with a loopback Host", () => {
    expect(isTrustedLocalRequest({ host: "127.0.0.1:3210", origin: "null" })).toBe(true);
    expect(isTrustedLocalRequest({ host: "localhost:3210", origin: "file://" })).toBe(true);
    expect(isTrustedLocalRequest({ host: "attacker.example", origin: "null" })).toBe(false);
  });

  it("honors an explicit CORS origin without weakening the Host check", () => {
    expect(isTrustedLocalRequest({
      host: "127.0.0.1:3210",
      origin: "https://desktop.example",
      configuredOrigin: "https://desktop.example",
    })).toBe(true);
    expect(isTrustedLocalRequest({
      host: "attacker.example",
      origin: "https://desktop.example",
      configuredOrigin: "https://desktop.example",
    })).toBe(false);
  });
});
