import { getToolArgs, isToolCallBlock } from "../../core/llm-utils.js";
import type { ContentBlock } from "../../core/llm-utils.js";
import { normalizeArtifactPayload } from "./artifact-shape.js";
import type { ArtifactPayload } from "./artifact-shape.js";

const ARTIFACT_TOOL_NAMES = new Set(["create_artifact", "create_report"]);

interface ArtifactRecoveryOptions {
  fallbackIdPrefix?: string;
}

interface ProviderFunctionCall {
  name?: unknown;
  arguments?: unknown;
}

interface ArtifactToolCallLike extends ContentBlock {
  id?: unknown;
  toolCallId?: unknown;
  callId?: unknown;
  function?: ProviderFunctionCall;
}

export interface RecoveredArtifactPreview extends ArtifactPayload {
  recovered: true;
  recoveredFromTool: string;
}

function normalizeArgs(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  return typeof raw === "object" ? raw as Record<string, unknown> : null;
}

export function artifactPreviewDedupeKey(artifact: Partial<ArtifactPayload> | null | undefined): string {
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

export function artifactPreviewFromToolCall(
  toolCall: unknown,
  { fallbackIdPrefix = "recovered-artifact" }: ArtifactRecoveryOptions = {},
): RecoveredArtifactPreview | null {
  if (!toolCall || typeof toolCall !== "object") return null;
  const call = toolCall as ArtifactToolCallLike;
  const name = String(call.name || call.function?.name || "").trim();
  if (!ARTIFACT_TOOL_NAMES.has(name)) return null;

  const args = normalizeArgs(getToolArgs(call) || call.function?.arguments);
  if (!args) return null;
  const callId = String(call.id || call.toolCallId || call.callId || "").trim();
  const artifact = normalizeArtifactPayload(args as Parameters<typeof normalizeArtifactPayload>[0], {
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

export function artifactPreviewsFromContent(content: unknown, opts: ArtifactRecoveryOptions = {}): RecoveredArtifactPreview[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block): block is ArtifactToolCallLike => isToolCallBlock(block as ContentBlock))
    .map((block) => artifactPreviewFromToolCall(block, opts))
    .filter((preview): preview is RecoveredArtifactPreview => Boolean(preview));
}
