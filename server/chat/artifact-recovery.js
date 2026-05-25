import { getToolArgs, isToolCallBlock } from "../../core/llm-utils.js";
import { normalizeArtifactPayload } from "./artifact-shape.js";

const ARTIFACT_TOOL_NAMES = new Set(["create_artifact", "create_report"]);

function normalizeArgs(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return typeof raw === "object" ? raw : null;
}

export function artifactPreviewDedupeKey(artifact) {
  const title = String(artifact?.title || "");
  const content = String(artifact?.content || "");
  return [
    artifact?.artifactId || "",
    artifact?.artifactType || "",
    title.slice(0, 80),
    content.length,
    content.slice(0, 120),
  ].join("|");
}

export function artifactPreviewFromToolCall(toolCall, { fallbackIdPrefix = "recovered-artifact" } = {}) {
  if (!toolCall || typeof toolCall !== "object") return null;
  const name = String(toolCall.name || toolCall.function?.name || "").trim();
  if (!ARTIFACT_TOOL_NAMES.has(name)) return null;

  const args = normalizeArgs(getToolArgs(toolCall) || toolCall.function?.arguments);
  if (!args) return null;
  const callId = String(toolCall.id || toolCall.toolCallId || toolCall.callId || "").trim();
  const artifact = normalizeArtifactPayload(args, {
    fallbackId: callId,
    fallbackIdPrefix,
    messageType: "artifact",
  });
  if (!artifact) return null;

  return {
    ...artifact,
    recovered: true,
    recoveredFromTool: name,
  };
}

export function artifactPreviewsFromContent(content, opts = {}) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(isToolCallBlock)
    .map((block) => artifactPreviewFromToolCall(block, opts))
    .filter(Boolean);
}
