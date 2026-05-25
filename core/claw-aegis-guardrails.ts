import {
  detectPromptInjection,
  formatInjectionWarning,
} from "../lib/sandbox/prompt-injection-detector.js";

export interface ToolResultTextBlock {
  type?: string;
  text?: unknown;
}

export interface ReadToolGuardrailEvent {
  toolName?: string;
  toolCall?: { name?: string } | null;
  isError?: boolean;
  result?: { content?: ToolResultTextBlock[] } | null;
}

export interface ReadToolGuardrailOptions {
  logger?: (message: string) => void;
  onError?: (error: unknown) => void;
}

export type ReadToolGuardrailResult =
  | { detected: false; skipped: true; reason: "not_read_tool" | "short_or_non_text" | "guardrail_error" }
  | { detected: false; skipped: false; matches: [] }
  | { detected: true; skipped: false; matches: ReturnType<typeof detectPromptInjection>["matches"]; warningAppended: boolean };

export function runReadToolPromptInjectionGuardrail(event: ReadToolGuardrailEvent | null | undefined, opts: ReadToolGuardrailOptions = {}): ReadToolGuardrailResult {
  const toolName = event?.toolName || event?.toolCall?.name || "";
  if ((toolName !== "read" && toolName !== "read_file") || event?.isError) {
    return { detected: false, skipped: true, reason: "not_read_tool" };
  }

  const block = event?.result?.content?.[0];
  const text = block?.text || "";
  if (typeof text !== "string" || text.length <= 50) {
    return { detected: false, skipped: true, reason: "short_or_non_text" };
  }

  try {
    const scan = detectPromptInjection(text);
    if (!scan.detected) {
      return { detected: false, skipped: false, matches: [] };
    }

    const warning = formatInjectionWarning(scan.matches);
    if (block?.type === "text") {
      block.text += warning;
    }
    opts.logger?.(`[ClawAegis] prompt injection 检测: ${scan.matches.length} 个模式命中 (tool=${toolName})`);
    return {
      detected: true,
      skipped: false,
      matches: scan.matches,
      warningAppended: block?.type === "text",
    };
  } catch (err) {
    opts.onError?.(err);
    return { detected: false, skipped: true, reason: "guardrail_error" };
  }
}
