import { createHash } from "node:crypto";
import {
  normalizeRuntimeInstructionFrame,
  stableRuntimePrefix,
  type RuntimeInstructionFrame,
} from "../../../shared/runtime-instruction-frames.js";

export interface StablePrefixDiagnostics {
  schemaVersion: 1;
  stablePrefixHash: string;
  stablePrefixChars: number;
  stableFrameCount: number;
  stableFrameKinds: string[];
}

export function computeStablePrefixDiagnostics(frames: readonly RuntimeInstructionFrame[]): StablePrefixDiagnostics {
  const stableFrames = frames
    .map((frame) => normalizeRuntimeInstructionFrame(frame))
    .filter((frame) => frame.stable && frame.cacheable);
  const prefix = stableRuntimePrefix(frames);
  return {
    schemaVersion: 1,
    stablePrefixHash: hashStablePrefix(prefix),
    stablePrefixChars: prefix.length,
    stableFrameCount: stableFrames.length,
    stableFrameKinds: stableFrames.map((frame) => frame.kind),
  };
}

function hashStablePrefix(prefix: string): string {
  return createHash("sha256").update(prefix).digest("hex").slice(0, 16);
}
