import { parseImageList } from "./media.js";
import { analyzePastedContext, summarizePastedContext } from "./pasted-context.js";

export interface PreparedCodeInput {
  task: string;
  mediaPaths: string[];
  contextSummary: string;
}

export function prepareCodeTaskInput(raw: string, cwd: string, defaultMediaPrompt: string): PreparedCodeInput {
  const context = analyzePastedContext(raw, cwd);
  const mediaPaths = context.imageRefs.map((ref) => ref.path);
  return {
    task: context.text || (mediaPaths.length ? defaultMediaPrompt : raw),
    mediaPaths,
    contextSummary: context.hasContext ? summarizePastedContext(context) : "",
  };
}

export function addCodeInputMediaFlags(
  flags: Record<string, string | boolean>,
  mediaPaths: readonly string[],
): Record<string, string | boolean> {
  if (!mediaPaths.length) return flags;
  const existing = typeof flags.images === "string" ? parseImageList(flags.images) : [];
  return {
    ...flags,
    images: [...existing, ...mediaPaths].join(";"),
  };
}
