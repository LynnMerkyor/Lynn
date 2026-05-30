import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBrainSignaturePayload, ensureCliBrainIdentity, signedBrainHeaders } from "../src/brain-auth.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-cli-auth-"));
  tmpDirs.push(dir);
  return dir;
}

describe("CLI Brain auth", () => {
  it("creates a reusable client identity and local Brain device file", () => {
    const home = makeHome();
    const identity = ensureCliBrainIdentity({ lynnHome: home });

    expect(identity.key).toMatch(/^ak_/);
    expect(identity.secret.length).toBeGreaterThan(32);
    expect(JSON.parse(fs.readFileSync(path.join(home, "user", "preferences.json"), "utf8"))).toMatchObject({
      client_agent_key: identity.key,
      client_agent_secret: identity.secret,
    });
    expect(JSON.parse(fs.readFileSync(path.join(home, "brain-devices", `${identity.key}.json`), "utf8"))).toMatchObject({
      key: identity.key,
      secret: identity.secret,
    });

    expect(ensureCliBrainIdentity({ lynnHome: home })).toEqual(identity);
  });

  it("signs Brain requests with the same payload shape Brain v2 verifies", () => {
    const home = makeHome();
    const headers = signedBrainHeaders({ lynnHome: home, pathname: "/v1/chat/completions" });
    const prefs = JSON.parse(fs.readFileSync(path.join(home, "user", "preferences.json"), "utf8")) as Record<string, string>;
    const payload = buildBrainSignaturePayload({
      method: "POST",
      pathname: "/v1/chat/completions",
      timestamp: headers["x-lynn-timestamp"],
      nonce: headers["x-lynn-nonce"],
      agentKey: prefs.client_agent_key,
    });

    expect(headers["x-agent-key"]).toBe(prefs.client_agent_key);
    expect(payload).toContain("\nPOST\n/v1/chat/completions\n");
    expect(headers["x-lynn-signature"]).toMatch(/^v1:[a-f0-9]{64}$/);
  });
});
