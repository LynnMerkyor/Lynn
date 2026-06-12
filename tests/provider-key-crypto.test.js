import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decryptApiKey, encryptApiKey } from "../core/provider-key-crypto.ts";

const ENC_SALT = "hanako-provider-keys-v1";
const ENC_ALGO = "aes-256-gcm";
const tempRoots = [];
const oldHanaHome = process.env.HANA_HOME;

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  if (oldHanaHome === undefined) delete process.env.HANA_HOME;
  else process.env.HANA_HOME = oldHanaHome;
});

describe("provider API key crypto", () => {
  it("stores a stable seed in the Lynn data dir and ignores HANA_HOME", () => {
    const lynnHome = mkHome("lynn-provider-key-");
    const hanakoHome = mkHome("openhanako-provider-key-");
    process.env.HANA_HOME = hanakoHome;

    const encrypted = encryptApiKey("sk-stable", lynnHome);

    expect(encrypted).toMatch(/^enc:/);
    expect(decryptApiKey(encrypted, lynnHome)).toBe("sk-stable");
    expect(fs.existsSync(path.join(lynnHome, ".provider-key-seed"))).toBe(true);
    expect(fs.existsSync(path.join(hanakoHome, ".provider-key-seed"))).toBe(false);
  });

  it("does not decrypt a seed-backed key with another Lynn data dir", () => {
    const firstHome = mkHome("lynn-provider-key-a-");
    const secondHome = mkHome("lynn-provider-key-b-");

    const encrypted = encryptApiKey("sk-private", firstHome);

    expect(decryptApiKey(encrypted, firstHome)).toBe("sk-private");
    expect(decryptApiKey(encrypted, secondHome)).toBe("");
  });

  it("can read legacy hostname-derived ciphertext for smooth migration", () => {
    const lynnHome = mkHome("lynn-provider-key-legacy-");
    const legacy = encryptLegacyHostnameKey("sk-legacy");

    expect(decryptApiKey(legacy, lynnHome)).toBe("sk-legacy");
  });

  it("treats malformed or undecryptable encrypted values as missing", () => {
    const lynnHome = mkHome("lynn-provider-key-bad-");

    expect(decryptApiKey("enc:not:enough", lynnHome)).toBe("");
    expect(decryptApiKey("enc:000000000000000000000000:badtag:baddata", lynnHome)).toBe("");
  });
});

function mkHome(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function encryptLegacyHostnameKey(plaintext) {
  const material = `${os.hostname()}:${os.userInfo().username}`;
  const key = crypto.pbkdf2Sync(material, ENC_SALT, 100000, 32, "sha256");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENC_ALGO, key, iv);
  let enc = cipher.update(plaintext, "utf8", "hex");
  enc += cipher.final("hex");
  return `enc:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${enc}`;
}
