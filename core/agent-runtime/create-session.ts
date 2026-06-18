import {
  createAgentSession,
  type CreateAgentSessionOptions,
} from "@mariozechner/pi-coding-agent";

export type LynnCreateAgentSessionOptions = CreateAgentSessionOptions;

export function createLynnAgentSession(options: CreateAgentSessionOptions) {
  return createAgentSession(options);
}
