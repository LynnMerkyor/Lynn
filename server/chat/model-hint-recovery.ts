import { readFile } from "node:fs/promises";

export async function emitModelHintFromSessionTail(
  sessionPath: any,
  ss: any,
  emitStreamEvent: (sessionPath: any, ss: any, event: any) => void,
) {
  try {
    const raw = await readFile(sessionPath, "utf-8").catch(() => "");
    if (!raw) return;
    const lines = raw.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const entry = JSON.parse(lines[i]);
        const mm = entry?.message;
        if (mm?.role === "assistant" && mm.model) {
          const model = String(mm.model || "").trim();
          const provider = String(mm.provider || "").trim();
          emitStreamEvent(sessionPath, ss, { type: "model_hint", model: provider ? `${provider}/${model}` : model });
          return;
        }
      } catch {
        // Skip malformed JSONL rows.
      }
    }
  } catch {
    // Model hint recovery is best-effort.
  }
}
