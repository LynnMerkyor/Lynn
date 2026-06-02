import type { Writable } from "node:stream";
import { getStringFlag, hasFlag, type ParsedArgs } from "./args.js";
import { nowIso, writeJsonLine } from "./jsonl.js";
import { resolveDataDir } from "./session/store.js";
import { supportsColor } from "./terminal-style.js";
import {
  applyCodeRewind,
  parseCodeRewindSpec,
  readCodeRewindSession,
  renderCodeRewindApply,
  renderCodeRewindList,
  renderCodeRewindPreview,
  resolveCodeRewindSessionPath,
} from "./code-rewind.js";

interface CodeRewindStreams {
  output: Writable;
  errorOutput: Writable;
}

export async function runCodeRewindCommand(args: ParsedArgs, json: boolean, streams: CodeRewindStreams): Promise<number> {
  try {
    const dataDir = resolveDataDir(getStringFlag(args.flags, "data-dir"));
    const spec = parseCodeRewindSpec(String(getStringFlag(args.flags, "rewind") || "last"), hasFlag(args.flags, "apply"));
    const sessionPath = await resolveCodeRewindSessionPath(spec.sessionRef, dataDir);
    const session = await readCodeRewindSession(sessionPath);
    if (spec.ordinal === null) {
      const text = renderCodeRewindList(session, supportsColor(streams.output));
      if (json) writeJsonLine({ type: "session.rewind.list", ts: nowIso(), sessionPath, checkpoints: session.checkpoints });
      else streams.output.write(`${text}\n`);
      return 0;
    }
    if (!spec.apply) {
      const text = renderCodeRewindPreview(session, spec.ordinal, supportsColor(streams.output));
      if (json) writeJsonLine({ type: "session.rewind.preview", ts: nowIso(), sessionPath, ordinal: spec.ordinal, text });
      else streams.output.write(`${text}\n`);
      return 0;
    }
    const result = await applyCodeRewind({ sessionPath, ordinal: spec.ordinal });
    if (json) writeJsonLine({ type: "session.rewind.applied", ts: nowIso(), ...result });
    else streams.output.write(`${renderCodeRewindApply(result, supportsColor(streams.output))}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) writeJsonLine({ type: "session.rewind.error", ts: nowIso(), error: message });
    else streams.errorOutput.write(`rewind failed: ${message}\n`);
    return 1;
  }
}

export async function runCodeRewindSlash(raw: string, args: ParsedArgs, streams: CodeRewindStreams): Promise<void> {
  try {
    const dataDir = resolveDataDir(getStringFlag(args.flags, "data-dir"));
    const spec = parseCodeRewindSpec(raw);
    const sessionPath = await resolveCodeRewindSessionPath(spec.sessionRef, dataDir);
    const session = await readCodeRewindSession(sessionPath);
    if (spec.ordinal === null) {
      streams.output.write(`${renderCodeRewindList(session, supportsColor(streams.output))}\n\n`);
    } else if (spec.apply) {
      const result = await applyCodeRewind({ sessionPath, ordinal: spec.ordinal });
      streams.output.write(`${renderCodeRewindApply(result, supportsColor(streams.output))}\n\n`);
    } else {
      streams.output.write(`${renderCodeRewindPreview(session, spec.ordinal, supportsColor(streams.output))}\n\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    streams.errorOutput.write(`rewind failed: ${message}\n\n`);
  }
}
