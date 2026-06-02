import type { ChatMessage } from "./brain-client.js";
import type { CodeToolRequest } from "./code-tool-protocol.js";
import { createWorkspaceSnapshot, recordWorkspaceSnapshotForRequest, restoreWorkspaceSnapshot, type WorkspaceSnapshot } from "./code-snapshot.js";
import { bold, cyan, dim, green, red, supportsColor, yellow } from "./terminal-style.js";

export interface ChatRewindCheckpoint {
  id: number;
  label: string;
  messageLength: number;
  snapshot: WorkspaceSnapshot | null;
}

export interface ChatRewindState {
  nextId: number;
  checkpoints: ChatRewindCheckpoint[];
  active: ChatRewindCheckpoint | null;
}

export interface ChatRewindCommand {
  ordinal: number | null;
  apply: boolean;
}

export interface ChatRewindApplyResult {
  checkpoint: ChatRewindCheckpoint;
  restored: boolean;
  messageCount: number;
  restoreMessage: string | null;
}

export function createChatRewindState(): ChatRewindState {
  return { nextId: 1, checkpoints: [], active: null };
}

export function beginChatRewindTurn(state: ChatRewindState, label: string, messageLength: number): ChatRewindCheckpoint {
  const checkpoint: ChatRewindCheckpoint = {
    id: state.nextId,
    label: label.replace(/\s+/g, " ").trim().slice(0, 80) || "untitled turn",
    messageLength,
    snapshot: null,
  };
  state.nextId += 1;
  state.checkpoints.push(checkpoint);
  state.active = checkpoint;
  return checkpoint;
}

export function finishChatRewindTurn(state: ChatRewindState, checkpoint: ChatRewindCheckpoint): void {
  if (state.active === checkpoint) state.active = null;
}

export function parseChatRewindCommand(raw: string): ChatRewindCommand | null {
  if (!/^\/rewind(?:\s|$)/.test(raw.trim())) return null;
  const tokens = raw.trim().split(/\s+/).slice(1);
  let ordinal: number | null = null;
  let apply = false;
  for (const token of tokens) {
    if (token === "--apply" || token === "-y") {
      apply = true;
      continue;
    }
    if (/^\d+$/.test(token) && ordinal === null) ordinal = Number(token);
  }
  return { ordinal, apply };
}

export function maybeRecordChatRewindSnapshot(state: ChatRewindState, cwd: string, request: CodeToolRequest): WorkspaceSnapshot | null {
  if (!state.active) return null;
  if (request.tool !== "write_file" && request.tool !== "apply_patch") return state.active.snapshot;
  const current = state.active.snapshot || createWorkspaceSnapshot(cwd);
  state.active.snapshot = recordWorkspaceSnapshotForRequest(cwd, current, request);
  return state.active.snapshot;
}

export function renderChatRewind(state: ChatRewindState, command: ChatRewindCommand, color = supportsColor(process.stdout)): string {
  if (!state.checkpoints.length) return "No chat rewind checkpoints yet.";
  if (command.ordinal === null) return renderChatRewindList(state, color);
  const ranked = rankedChatCheckpoints(state);
  const checkpoint = ranked[command.ordinal - 1];
  if (!checkpoint) return `No chat rewind checkpoint #${command.ordinal}.`;
  const files = checkpoint.snapshot?.entries || 0;
  const skipped = checkpoint.snapshot?.skipped?.length || 0;
  const lines = [
    bold(`Preview chat rewind #${command.ordinal}`, color),
    `Target: ${checkpoint.label}`,
    `Messages kept: ${checkpoint.messageLength}`,
    files ? `${green("restore touched files", color)}: ${files}` : dim("No file edits recorded for this turn.", color),
  ];
  if (skipped) lines.push(`${yellow("skipped oversized/non-file", color)}: ${skipped}`);
  lines.push(dim("Only files touched by Lynn tools will be restored; unrelated files are untouched.", color));
  lines.push(dim(`Apply with /rewind ${command.ordinal} --apply`, color));
  return lines.join("\n");
}

export function applyChatRewind(state: ChatRewindState, ordinal: number, messages: ChatMessage[], cwd: string, color = supportsColor(process.stdout)): string {
  const result = applyChatRewindState(state, ordinal, messages, cwd);
  const lines = [
    green(`Chat rewind #${ordinal} applied`, color),
    `Target: ${result.checkpoint.label}`,
    `Messages kept: ${result.messageCount}`,
  ];
  if (result.restoreMessage) lines.push(result.restored ? green(result.restoreMessage, color) : red(result.restoreMessage, color));
  else lines.push(dim("No file edits recorded for this turn.", color));
  return lines.join("\n");
}

export function applyChatRewindState(state: ChatRewindState, ordinal: number, messages: ChatMessage[], cwd: string): ChatRewindApplyResult {
  const ranked = rankedChatCheckpoints(state);
  const checkpoint = ranked[ordinal - 1];
  if (!checkpoint) throw new Error(`No chat rewind checkpoint #${ordinal}.`);
  let restoreMessage: string | null = null;
  let restored = false;
  for (const candidate of ranked.slice(0, ordinal)) {
    if (!candidate.snapshot?.available) continue;
    const result = restoreWorkspaceSnapshot(cwd, candidate.snapshot);
    restoreMessage = result.message;
    restored = restored || result.ok;
  }
  messages.splice(checkpoint.messageLength);
  state.checkpoints = state.checkpoints.filter((candidate) => candidate.messageLength < checkpoint.messageLength);
  state.active = null;
  return { checkpoint, restored, messageCount: messages.length, restoreMessage };
}

function renderChatRewindList(state: ChatRewindState, color: boolean): string {
  return [
    "Chat rewind checkpoints:",
    ...rankedChatCheckpoints(state).map((checkpoint, index) => {
      const files = checkpoint.snapshot?.entries ? ` · ${checkpoint.snapshot.entries} touched` : "";
      return `${dim(`${index + 1}.`, color)} ${cyan(checkpoint.label, color)}${dim(files, color)}`;
    }),
    dim("Type a number to preview. After preview, type y/apply to restore. Or use /rewind N --apply.", color),
  ].join("\n");
}

function rankedChatCheckpoints(state: ChatRewindState): ChatRewindCheckpoint[] {
  return [...state.checkpoints].reverse();
}
