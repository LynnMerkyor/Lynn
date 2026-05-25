import { describe, expect, it } from "vitest";

import {
  artifactToolArguments,
  looksLikeHtml,
  normalizeArtifactPayload,
  normalizeArtifactType,
} from "../server/chat/artifact-shape.js";

describe("artifact shape helpers", () => {
  it("normalizes artifact type from explicit type or content", () => {
    expect(normalizeArtifactType("code", "<html>still code</html>")).toBe("code");
    expect(normalizeArtifactType("unknown", "<!doctype html><html></html>")).toBe("html");
    expect(normalizeArtifactType("", "# Report")).toBe("markdown");
    expect(looksLikeHtml("<style>body{}</style>")).toBe(true);
  });

  it("normalizes payloads without relying on generated fallback ids", () => {
    const payload = normalizeArtifactPayload({
      html: "<html><body>Hello</body></html>",
      label: "Preview",
    }, {
      fallbackId: "artifact-test",
      messageType: "artifact",
    });

    expect(payload).toEqual({
      type: "artifact",
      artifactId: "artifact-test",
      artifactType: "html",
      title: "Preview",
      content: "<html><body>Hello</body></html>",
      language: "html",
    });
  });

  it("rejects empty payloads and converts normalized payloads to tool arguments", () => {
    expect(normalizeArtifactPayload(null)).toBeNull();
    expect(normalizeArtifactPayload({ content: "   " })).toBeNull();

    const artifact = normalizeArtifactPayload({
      id: "markdown-1",
      type: "markdown",
      title: "Summary",
      content: "Done",
    });

    expect(artifactToolArguments(artifact)).toEqual({
      artifactId: "markdown-1",
      type: "markdown",
      title: "Summary",
      content: "Done",
      language: undefined,
    });
    expect(artifactToolArguments(null)).toBeNull();
  });
});
