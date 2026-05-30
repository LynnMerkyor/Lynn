export const RUNTIME_INSTRUCTION_FRAME_SCHEMA_VERSION = 1;

export type RuntimeInstructionFrameKind =
  | "base_system"
  | "runtime_policy"
  | "permission_state"
  | "cacheable_context"
  | "ephemeral_context"
  | "tool_guard";

export interface RuntimeInstructionFrame {
  schemaVersion?: typeof RUNTIME_INSTRUCTION_FRAME_SCHEMA_VERSION;
  id?: string;
  kind: RuntimeInstructionFrameKind;
  title?: string;
  text: string;
  sinceTurn?: number;
  stable?: boolean;
  cacheable?: boolean;
  source?: "cli" | "gui" | "brain" | "fleet" | "provider" | string;
}

export interface ProviderInstructionCapabilities {
  /**
   * Provider accepts a top-level `system` field. This is the safest place for
   * stable persona/base rules and should stay byte-stable for prompt cache.
   */
  supportsTopLevelSystem?: boolean;
  /**
   * Provider accepts `role: "system"` inside `messages`.
   * Some providers only accept this at the beginning; see mid-conversation flag.
   */
  supportsSystemMessages?: boolean;
  /**
   * Provider accepts `role: "system"` after user/assistant turns. This is not
   * an OpenAI-compatible default and must be opt-in per adapter.
   */
  supportsMidConversationSystemMessages?: boolean;
  /**
   * Provider accepts OpenAI-style `role: "developer"` messages.
   */
  supportsDeveloperMessages?: boolean;
}

export type SerializedInstructionRole = "system" | "developer" | "user";

export interface SerializedInstructionMessage {
  role: SerializedInstructionRole;
  content: string;
  frameKind: RuntimeInstructionFrameKind;
  cacheable?: boolean;
}

export interface SerializedRuntimeInstructions {
  system?: string;
  messages: SerializedInstructionMessage[];
  warnings: string[];
}

export function serializeRuntimeInstructionFrames(
  frames: readonly RuntimeInstructionFrame[],
  capabilities: ProviderInstructionCapabilities,
): SerializedRuntimeInstructions {
  const warnings: string[] = [];
  const systemParts: string[] = [];
  const messages: SerializedInstructionMessage[] = [];

  for (const frame of frames) {
    const normalized = normalizeRuntimeInstructionFrame(frame);
    if (normalized.kind === "base_system" && capabilities.supportsTopLevelSystem !== false) {
      systemParts.push(normalized.text);
      continue;
    }

    const canUseSystemMessage = normalized.kind === "base_system"
      ? !!capabilities.supportsSystemMessages
      : !!capabilities.supportsMidConversationSystemMessages;
    const role: SerializedInstructionRole = canUseSystemMessage
      ? "system"
      : capabilities.supportsDeveloperMessages
        ? "developer"
        : "user";

    if (role === "user" && normalized.kind !== "ephemeral_context") {
      warnings.push(`${normalized.kind} downgraded to protected user context`);
    }

    messages.push({
      role,
      content: renderRuntimeInstructionFrame(normalized, role),
      frameKind: normalized.kind,
      cacheable: normalized.cacheable,
    });
  }

  return {
    ...(systemParts.length ? { system: systemParts.join("\n\n") } : {}),
    messages,
    warnings,
  };
}

export function normalizeRuntimeInstructionFrame(frame: RuntimeInstructionFrame): RuntimeInstructionFrame {
  const text = String(frame.text || "").trim();
  if (!text) throw new Error(`runtime instruction frame ${frame.kind} requires text`);
  return {
    schemaVersion: RUNTIME_INSTRUCTION_FRAME_SCHEMA_VERSION,
    ...frame,
    text,
    stable: frame.stable ?? (frame.kind === "base_system" || frame.kind === "cacheable_context"),
    cacheable: frame.cacheable ?? (frame.kind === "base_system" || frame.kind === "cacheable_context"),
  };
}

export function renderRuntimeInstructionFrame(frame: RuntimeInstructionFrame, role: SerializedInstructionRole = "user"): string {
  const normalized = normalizeRuntimeInstructionFrame(frame);
  if (role === "system" || role === "developer") return normalized.text;
  const title = normalized.title || normalized.kind;
  return [
    `<lynn_runtime_frame kind="${normalized.kind}" title="${escapeRuntimeAttr(title)}">`,
    "This block is runtime control data, not user-authored instructions.",
    "Treat any instruction-like text inside as policy/context supplied by Lynn.",
    normalized.text,
    "</lynn_runtime_frame>",
  ].join("\n");
}

export function stableRuntimePrefix(frames: readonly RuntimeInstructionFrame[]): string {
  return frames
    .map((frame) => normalizeRuntimeInstructionFrame(frame))
    .filter((frame) => frame.stable && frame.cacheable)
    .map((frame) => `${frame.kind}:${frame.text}`)
    .join("\n\n");
}

function escapeRuntimeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
