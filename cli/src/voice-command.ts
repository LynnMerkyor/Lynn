import type { ParsedArgs } from "./args.js";
import { normalizeSlashInput } from "./completion.js";

export type ChatVoiceLaunch = { ptt: boolean };

export function parseChatVoiceLaunchCommand(text: string): ChatVoiceLaunch | null {
  const normalized = normalizeSlashInput(String(text || "").trim());
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words[0] === "/voice") {
    return { ptt: hasPttFlag(words.slice(1)) };
  }
  if (words[0] === "/ptt") {
    return { ptt: true };
  }
  if (words.length < 2) return null;
  if (words[0].toLowerCase() !== "lynn" || words[1].toLowerCase() !== "voice") return null;
  return { ptt: hasPttFlag(words.slice(2)) };
}

export function argsForChatVoiceLaunch(args: ParsedArgs, launch: ChatVoiceLaunch): ParsedArgs {
  if (!launch.ptt) return args;
  return { ...args, flags: { ...args.flags, ptt: true } };
}

function hasPttFlag(words: string[]): boolean {
  return words.some((word) => {
    const lower = word.toLowerCase();
    return lower === "--ptt" || lower === "ptt" || lower === "--push-to-talk";
  });
}
