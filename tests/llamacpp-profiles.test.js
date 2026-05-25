import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

const {
  DEFAULT_MODEL_ID,
  canonicalizeLlamacppModelId,
  listLlamacppDownloadProfiles,
  resolveLlamacppDownloadProfile,
} = require("../desktop/llamacpp-profiles.cjs");

describe("llama.cpp model profile boundary", () => {
  it("keeps historical aliases but resolves them to canonical model ids", () => {
    expect(canonicalizeLlamacppModelId("local-qwen35-9b-q4km-imatrix")).toBe(DEFAULT_MODEL_ID);
    expect(resolveLlamacppDownloadProfile("local-qwen35-4b-q4km")).toMatchObject({
      known: true,
      canonicalModelId: "qwen35-4b-q4km",
      profile: { modelId: "qwen35-4b-q4km" },
    });
  });

  it("defaults empty requests to the stable 9B profile", () => {
    expect(resolveLlamacppDownloadProfile()).toMatchObject({
      known: true,
      canonicalModelId: DEFAULT_MODEL_ID,
      profile: { modelId: DEFAULT_MODEL_ID },
    });
  });

  it("does not silently accept unknown IPC model ids", () => {
    const resolved = resolveLlamacppDownloadProfile("../../../not-a-model");
    expect(resolved).toMatchObject({
      known: false,
      requestedModelId: "../../../not-a-model",
      canonicalModelId: DEFAULT_MODEL_ID,
      profile: { modelId: DEFAULT_MODEL_ID },
    });
  });

  it("exposes one option per canonical downloadable model", () => {
    const ids = listLlamacppDownloadProfiles().map((profile) => profile.modelId);
    expect(ids).toEqual([
      "qwen35-4b-q4km",
      "qwen35-9b-q4km-imatrix",
      "qwen36-35b-a3b-q4km-imatrix",
    ]);
  });
});
