import path from "path";
import { debugLog } from "../../lib/debug-log.js";
import {
  artifactPreviewDedupeKey,
  artifactPreviewFromToolCall,
} from "./artifact-recovery.js";

type EmitStreamEvent = (sessionPath: any, ss: any, event: any) => void;

export function emitFileOutputsFromDetails(
  sessionPath: any,
  ss: any,
  emitStreamEvent: EmitStreamEvent,
  details: any = {},
) {
  const files = Array.isArray(details.files) ? [...details.files] : [];
  if (files.length === 0 && details.filePath) {
    files.push({ filePath: details.filePath, label: details.label, ext: details.ext || "" });
  }
  if (!ss.emittedFileOutputPaths || typeof ss.emittedFileOutputPaths.has !== "function") {
    ss.emittedFileOutputPaths = new Set();
  }
  let emitted = 0;
  for (const f of files) {
    if (!f?.filePath) continue;
    const key = path.resolve(String(f.filePath));
    if (ss.emittedFileOutputPaths.has(key)) continue;
    ss.emittedFileOutputPaths.add(key);
    emitStreamEvent(sessionPath, ss, {
      type: "file_output",
      filePath: f.filePath,
      label: f.label || path.basename(f.filePath),
      ext: f.ext || path.extname(f.filePath).replace(/^\./, ""),
    });
    emitted += 1;
  }
  return emitted;
}

export function emitFileOutputFromPath(
  sessionPath: any,
  ss: any,
  emitStreamEvent: EmitStreamEvent,
  filePath: any,
) {
  if (!filePath) return 0;
  return emitFileOutputsFromDetails(sessionPath, ss, emitStreamEvent, {
    filePath,
    label: path.basename(String(filePath)),
    ext: path.extname(String(filePath)).replace(/^\./, ""),
  });
}

export function emitRecoveredArtifact(
  sessionPath: any,
  ss: any,
  emitStreamEvent: EmitStreamEvent,
  artifact: any,
  source: any = "toolcall",
) {
  if (!ss || !artifact?.content) return false;
  ss.recoveredArtifactKeys = ss.recoveredArtifactKeys || new Set();
  const key = artifactPreviewDedupeKey(artifact);
  if (ss.recoveredArtifactKeys.has(key)) return false;
  ss.recoveredArtifactKeys.add(key);
  ss.hasOutput = true;
  emitStreamEvent(sessionPath, ss, artifact);
  debugLog()?.log("ws", `recovered artifact from ${source} · tool=${artifact.recoveredFromTool || "unknown"} · title=${artifact.title || ""} · session=${sessionPath || "unknown"}`);
  return true;
}

export function maybeRecoverArtifactFromMessageUpdate(
  sessionPath: any,
  ss: any,
  emitStreamEvent: EmitStreamEvent,
  event: any,
  source: any = "message_update",
) {
  const sub = event?.assistantMessageEvent;
  const preview = artifactPreviewFromToolCall(sub?.toolCall);
  return preview ? emitRecoveredArtifact(sessionPath, ss, emitStreamEvent, preview, source) : false;
}
