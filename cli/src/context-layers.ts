import { createHash } from "node:crypto";
import type { ChatMessage } from "./brain-client.js";
import {
  normalizeRuntimeInstructionFrame,
  renderRuntimeInstructionFrame,
  stableRuntimePrefix,
  type RuntimeInstructionFrame,
} from "../../shared/runtime-instruction-frames.js";

export const CODE_CONTEXT_LAYER_ORDER = [
  "stable_prefix",
  "resume_history",
  "volatile_runtime",
  "current_user",
] as const;

export type CodeContextLayerName = typeof CODE_CONTEXT_LAYER_ORDER[number];

export interface CodeContextLayerDiagnostics {
  schemaVersion: 1;
  stablePrefixHash: string;
  stablePrefixChars: number;
  stableFrameCount: number;
  stableFrameKinds: string[];
  volatileFrameCount: number;
  volatileFrameKinds: string[];
  resumeMessageCount: number;
  layerOrder: CodeContextLayerName[];
}

export interface BuildCodeContextMessagesInput {
  frames: readonly RuntimeInstructionFrame[];
  resumeMessages?: readonly ChatMessage[];
  currentUserContent: ChatMessage["content"];
}

export interface BuildCodeContextMessagesResult {
  messages: ChatMessage[];
  diagnostics: CodeContextLayerDiagnostics;
}

export function buildCodeContextMessages(input: BuildCodeContextMessagesInput): BuildCodeContextMessagesResult {
  const stablePrefix = stableRuntimePrefix(input.frames);
  const volatileRuntimeMessages = volatileRuntimeFrames(input.frames).map((frame) => ({
    role: "user" as const,
    content: renderRuntimeInstructionFrame(frame),
  }));
  const messages: ChatMessage[] = [
    ...(stablePrefix ? [{ role: "system" as const, content: stablePrefix }] : []),
    ...(input.resumeMessages || []),
    ...volatileRuntimeMessages,
    { role: "user", content: input.currentUserContent },
  ];

  return {
    messages,
    diagnostics: computeCodeContextLayerDiagnostics(input.frames, input.resumeMessages?.length || 0),
  };
}

export function computeCodeContextLayerDiagnostics(
  frames: readonly RuntimeInstructionFrame[],
  resumeMessageCount = 0,
): CodeContextLayerDiagnostics {
  const normalized = frames.map((frame) => normalizeRuntimeInstructionFrame(frame));
  const stableFrames = normalized.filter((frame) => frame.stable && frame.cacheable);
  const volatileFrames = normalized.filter((frame) => !frame.stable || !frame.cacheable);
  const prefix = stableRuntimePrefix(frames);
  return {
    schemaVersion: 1,
    stablePrefixHash: hashStablePrefix(prefix),
    stablePrefixChars: prefix.length,
    stableFrameCount: stableFrames.length,
    stableFrameKinds: stableFrames.map((frame) => frame.kind),
    volatileFrameCount: volatileFrames.length,
    volatileFrameKinds: volatileFrames.map((frame) => frame.kind),
    resumeMessageCount,
    layerOrder: [...CODE_CONTEXT_LAYER_ORDER],
  };
}

function volatileRuntimeFrames(frames: readonly RuntimeInstructionFrame[]): RuntimeInstructionFrame[] {
  return frames
    .map((frame) => normalizeRuntimeInstructionFrame(frame))
    .filter((frame) => !frame.stable || !frame.cacheable);
}

function hashStablePrefix(prefix: string): string {
  return createHash("sha256").update(prefix).digest("hex").slice(0, 16);
}
