import { describe, expect, it } from "vitest";

import {
  activeDownloadMatchesProfile,
  findResumableDownloadState,
  managerStartResult,
  runtimeUsesProfile,
} from "../desktop/local-model-controller.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const profile = {
  modelId: "qwen36-27b-dsv4pro-coding-q4-mtp",
  files: [{ fileName: "Q4_LynnStyle/Q4-imatrix-MTP-00001-of-00004.gguf" }],
};

describe("local model custom-start IPC result", () => {
  it("reports a ready endpoint as successful", () => {
    expect(managerStartResult(
      { status: "ready", port: 18099 },
      { modelId: "local-test", modelPath: "C:\\models\\test.gguf" },
    )).toEqual({
      ok: true,
      status: "ready",
      port: 18099,
      modelId: "local-test",
      modelPath: "C:\\models\\test.gguf",
    });
  });

  it("does not claim success when llama-server is missing", () => {
    const result = managerStartResult({
      status: "needs-binary",
      expectedPath: "C:\\Users\\test\\.lynn\\llamacpp\\bin\\llama-server.exe",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("llamacpp-binary-not-found");
    expect(result.detail).toContain("llama-server was not found in PATH");
  });

  it("does not claim the selected GGUF started when another endpoint owns the port", () => {
    expect(managerStartResult({
      status: "standby",
      reason: "external-instance",
      port: 18099,
    })).toMatchObject({
      ok: false,
      reason: "llamacpp-port-in-use",
      status: "standby",
    });
  });

  it("returns the child output when startup fails", () => {
    const result = managerStartResult({
      status: "failed",
      reason: "startup-timeout",
      error: "failed to load model shard",
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "startup-timeout",
      detail: "failed to load model shard",
      status: "failed",
    });
  });

  it("only treats the selected profile as the active download", () => {
    expect(activeDownloadMatchesProfile({ modelId: profile.modelId }, profile)).toBe(true);
    expect(activeDownloadMatchesProfile({ modelId: "qwen35-9b-q4km-imatrix" }, profile)).toBe(false);
  });

  it("only stops a local runtime whose model path belongs to the removed profile", () => {
    const root = "/tmp/lynn/models";
    expect(runtimeUsesProfile({ modelPath: "/tmp/lynn/models/Q4_LynnStyle/Q4-imatrix-MTP-00001-of-00004.gguf" }, root, profile)).toBe(true);
    expect(runtimeUsesProfile({ modelPath: "/tmp/lynn/models/Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf" }, root, profile)).toBe(false);
  });

  it("restores a nested parallel download from range segments after restart", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-resume-hint-"));
    const fileName = "Q4_LynnStyle/Q4-imatrix-MTP-00001-of-00004.gguf";
    const target = path.join(home, "models", fileName);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(`${target}.part.seg0`, "segment-a");
    fs.writeFileSync(`${target}.part.seg1`, "segment-b");
    const resumableProfile = {
      modelId: "resume-test",
      label: "Resume Test",
      fileName,
      expectedSize: 100,
      parallelSegments: 2,
      sources: [{ url: "https://example.com/model.gguf" }],
    };

    const state = findResumableDownloadState(home, [resumableProfile]);
    expect(state).toMatchObject({
      state: "paused",
      modelId: "resume-test",
      fileName,
      bytesTransferred: 18,
      totalBytes: 100,
      parallelSegments: 2,
    });
    fs.rmSync(home, { recursive: true, force: true });
  });
});
