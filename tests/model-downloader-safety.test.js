import { createRequire } from "module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

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
    expect(validateModelTargetPath("/tmp/model.gguf")).toBe(path.resolve("/tmp/model.gguf"));
    expect(() => validateModelTargetPath("/tmp/model.bin")).toThrow(/must-end-with-gguf/);
    expect(() => new ModelDownloader({
      target: "/tmp/model.bin",
      sources: [{ url: "https://example.com/model.gguf" }],
    })).toThrow(/model-target/);
  });

  it("settles the active promise when a download is paused", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-downloader-pause-"));
    const downloader = new ModelDownloader({
      target: path.join(dir, "model.gguf"),
      expectedSize: 1024,
      parallelSegments: 1,
      sources: [{ url: "https://example.com/model.gguf" }],
    });
    const running = downloader.start();
    expect(downloader.pause()).toBe(true);
    await expect(running).resolves.toEqual({ ok: false, reason: "paused" });
    expect(downloader.getState().state).toBe("paused");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("settles the active promise when a download is cancelled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-downloader-cancel-"));
    const downloader = new ModelDownloader({
      target: path.join(dir, "model.gguf"),
      expectedSize: 1024,
      parallelSegments: 1,
      sources: [{ url: "https://example.com/model.gguf" }],
    });
    const running = downloader.start();
    downloader.cancel();
    await expect(running).resolves.toEqual({ ok: false, reason: "cancelled" });
    expect(downloader.getState().state).toBe("idle");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not let a failed source retry reopen a paused generation", async () => {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-downloader-retry-pause-"));
    const downloader = new ModelDownloader({
      target: path.join(dir, "model.gguf"),
      expectedSize: 1024,
      parallelSegments: 1,
      sources: [{ url: "https://example.com/model.gguf" }],
    });
    let attempts = 0;
    downloader._downloadFromSource = () => {
      attempts += 1;
      return Promise.reject(new Error("source-failed"));
    };
    const running = downloader.start();
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(attempts).toBe(1);
      expect(downloader.pause()).toBe(true);
      await expect(running).resolves.toEqual({ ok: false, reason: "paused" });

      await vi.advanceTimersByTimeAsync(2_000);
      expect(attempts).toBe(1);
      expect(downloader.getState().state).toBe("paused");

      downloader.paused = false;
      downloader.runGeneration += 1;
      downloader._beginNextSource(downloader.runGeneration - 1);
      expect(attempts).toBe(1);
    } finally {
      vi.useRealTimers();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancels a live parallel merge without leaving a resumable part", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-downloader-merge-cancel-"));
    const target = path.join(dir, "model.gguf");
    const part = `${target}.part`;
    const segmentA = `${part}.seg0`;
    const segmentB = `${part}.seg1`;
    fs.writeFileSync(segmentA, "segment");
    fs.writeFileSync(segmentB, "segment");
    const downloader = new ModelDownloader({
      target,
      expectedSize: 14,
      parallelSegments: 2,
      sources: [{ url: "https://example.com/model.gguf" }],
    });
    downloader.state = "downloading";

    const originalCreateReadStream = fs.createReadStream;
    fs.createReadStream = () => {
      const stream = new PassThrough();
      process.nextTick(() => {
        stream.write("segment");
        setTimeout(() => stream.end(), 50);
      });
      return stream;
    };
    try {
      const merging = downloader._downloadFromSourceParallel(
        "https://example.com/model.gguf",
        0,
        downloader.runGeneration,
      );
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 1000;
        const waitForMerge = () => {
          if (downloader.parallelStreams.length >= 2) return resolve();
          if (Date.now() >= deadline) return reject(new Error("parallel merge did not start"));
          setTimeout(waitForMerge, 5);
        };
        waitForMerge();
      });

      downloader.cancel();
      await expect(merging).resolves.toBeUndefined();
      expect(fs.existsSync(part)).toBe(false);
      expect(fs.existsSync(segmentA)).toBe(false);
      expect(fs.existsSync(segmentB)).toBe(false);
      expect(downloader.aborted).toBe(true);
    } finally {
      fs.createReadStream = originalCreateReadStream;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps range segments but removes a partial merge when paused", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-downloader-merge-pause-"));
    const target = path.join(dir, "model.gguf");
    const part = `${target}.part`;
    const segment = `${part}.seg0`;
    fs.writeFileSync(part, "partial merge");
    fs.writeFileSync(segment, "segment");
    const downloader = new ModelDownloader({
      target,
      expectedSize: 1024,
      parallelSegments: 2,
      sources: [{ url: "https://example.com/model.gguf" }],
    });
    downloader.state = "downloading";
    downloader.parallelSegmentPaths = [segment];

    expect(downloader.pause()).toBe(true);
    expect(fs.existsSync(part)).toBe(false);
    expect(fs.existsSync(segment)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("pauses a live parallel merge without deleting resumable range segments", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-downloader-live-merge-pause-"));
    const target = path.join(dir, "model.gguf");
    const part = `${target}.part`;
    const segmentA = `${part}.seg0`;
    const segmentB = `${part}.seg1`;
    fs.writeFileSync(segmentA, "segment");
    fs.writeFileSync(segmentB, "segment");
    const downloader = new ModelDownloader({
      target,
      expectedSize: 14,
      parallelSegments: 2,
      sources: [{ url: "https://example.com/model.gguf" }],
    });
    downloader.state = "downloading";

    const originalCreateReadStream = fs.createReadStream;
    fs.createReadStream = () => {
      const stream = new PassThrough();
      process.nextTick(() => {
        stream.write("segment");
        setTimeout(() => stream.end(), 50);
      });
      return stream;
    };
    try {
      const merging = downloader._downloadFromSourceParallel(
        "https://example.com/model.gguf",
        0,
        downloader.runGeneration,
      );
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 1000;
        const waitForMerge = () => {
          if (downloader.parallelStreams.length >= 2) return resolve();
          if (Date.now() >= deadline) return reject(new Error("parallel merge did not start"));
          setTimeout(waitForMerge, 5);
        };
        waitForMerge();
      });

      expect(downloader.pause()).toBe(true);
      await expect(merging).resolves.toBeUndefined();
      expect(fs.existsSync(part)).toBe(false);
      expect(fs.existsSync(segmentA)).toBe(true);
      expect(fs.existsSync(segmentB)).toBe(true);
    } finally {
      fs.createReadStream = originalCreateReadStream;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let a stale generation finalize a newer download", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-downloader-generation-"));
    const target = path.join(dir, "model.gguf");
    const part = `${target}.part`;
    fs.writeFileSync(part, "newer download data");
    const downloader = new ModelDownloader({
      target,
      expectedSize: 0,
      parallelSegments: 1,
      sources: [{ url: "https://example.com/model.gguf" }],
    });
    downloader.runGeneration = 2;

    await expect(downloader._finalizeDownload(1, null)).resolves.toBe("cancelled");
    expect(fs.existsSync(part)).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
