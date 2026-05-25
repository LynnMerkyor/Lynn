import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

const {
  INSECURE_MODEL_SOURCE_ENV,
  ModelDownloader,
  normalizeDownloadSources,
  validateModelSourceUrl,
  validateModelTargetPath,
} = require("../desktop/model-downloader.cjs");

function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value == null) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (previous == null) delete process.env[name];
    else process.env[name] = previous;
  }
}

describe("model downloader safety boundary", () => {
  it("accepts public http/https GGUF sources and normalizes source metadata", () => {
    expect(validateModelSourceUrl("https://example.com/models/Model.GGUF?download=1"))
      .toBe("https://example.com/models/Model.GGUF?download=1");

    const sources = normalizeDownloadSources([
      "https://example.com/models/Qwen3.5-9B-Q4_K_M.gguf",
      { id: "hf mirror", label: "HF Mirror", url: "http://downloads.example.org/model.gguf" },
    ]);

    expect(sources).toEqual([
      {
        id: "example.com",
        label: "example.com",
        url: "https://example.com/models/Qwen3.5-9B-Q4_K_M.gguf",
      },
      {
        id: "hf-mirror",
        label: "HF Mirror",
        url: "http://downloads.example.org/model.gguf",
      },
    ]);
  });

  it("rejects non-network, credentialed, private, and non-GGUF sources", () => {
    expect(() => normalizeDownloadSources([{ url: "file:///tmp/model.gguf" }]))
      .toThrow(/unsupported-url-scheme/);
    expect(() => normalizeDownloadSources([{ url: "https://token@example.com/model.gguf" }]))
      .toThrow(/credentials-not-allowed/);
    expect(() => normalizeDownloadSources([{ url: "https://localhost/model.gguf" }]))
      .toThrow(/local-or-private-host-not-allowed/);
    expect(() => normalizeDownloadSources([{ url: "https://192.168.1.2/model.gguf" }]))
      .toThrow(/local-or-private-host-not-allowed/);
    expect(() => normalizeDownloadSources([{ url: "https://example.com/model.bin" }]))
      .toThrow(/source-must-end-with-gguf/);
    expect(() => normalizeDownloadSources([{ url: "https://example.com/download?file=model.gguf" }]))
      .toThrow(/source-must-end-with-gguf/);
  });

  it("blocks private and non-routable hosts for initial sources and redirects", () => {
    const blockedHosts = [
      "http://10.1.2.3/model.gguf",
      "http://172.20.1.2/model.gguf",
      "http://100.64.1.2/model.gguf",
      "http://169.254.1.2/model.gguf",
      "http://198.18.0.1/model.gguf",
      "http://[::1]/model.gguf",
      "http://[fd00::1]/model.gguf",
      "http://printer.local/model.gguf",
    ];
    for (const url of blockedHosts) {
      expect(() => validateModelSourceUrl(url)).toThrow(/local-or-private-host-not-allowed/);
      expect(() => validateModelSourceUrl(url.replace(/\.gguf$/, ""), { enforceGgufPath: false }))
        .toThrow(/local-or-private-host-not-allowed/);
    }
  });

  it("keeps redirect validation strict while allowing signed non-GGUF paths", () => {
    expect(validateModelSourceUrl("https://cdn.example.com/signed/download?id=1", {
      context: "redirect",
      enforceGgufPath: false,
    })).toBe("https://cdn.example.com/signed/download?id=1");

    expect(() => validateModelSourceUrl("http://127.0.0.1/model-cache", {
      context: "redirect",
      enforceGgufPath: false,
    })).toThrow(/local-or-private-host-not-allowed/);

    expect(() => validateModelSourceUrl("https://token@example.com/signed/download", {
      context: "redirect",
      enforceGgufPath: false,
    })).toThrow(/credentials-not-allowed/);
  });

  it("requires an explicit env override for private model sources", () => {
    withEnv(INSECURE_MODEL_SOURCE_ENV, "1", () => {
      expect(validateModelSourceUrl("http://127.0.0.1:8000/model.gguf"))
        .toBe("http://127.0.0.1:8000/model.gguf");
    });
  });

  it("rejects unsafe target paths before any network request can start", () => {
    expect(validateModelTargetPath("/tmp/model.gguf")).toBe("/tmp/model.gguf");
    expect(() => validateModelTargetPath("/tmp/model.bin")).toThrow(/must-end-with-gguf/);
    expect(() => new ModelDownloader({
      target: "/tmp/model.bin",
      sources: [{ url: "https://example.com/model.gguf" }],
    })).toThrow(/model-target/);
  });
});
