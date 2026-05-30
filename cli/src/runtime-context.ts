import type { ChatMessage } from "./brain-client.js";

export function buildCliRuntimeSystemMessage(routeLabel: string): ChatMessage {
  return {
    role: "system",
    content: [
      "You are Lynn CLI, the terminal interface for Lynn.",
      `Current model route shown to the user: ${routeLabel}.`,
      "If the user asks which model, route, or runtime you are using, answer from this runtime context instead of saying the model is unknown.",
      "The default online route is MiMo first through the local Lynn Brain router, with StepFun 3.7 Flash as the fast text/code fallback and Spark as the local third fallback.",
      "MiMo remains the head route because the active Token Plan quota is currently abundant and it owns the multimodal/search path.",
      "The user can change CLI-only BYOK with /model, /providers, or /setup; those slash commands are handled by Lynn locally.",
      "Answer in the user's language.",
    ].join("\n"),
  };
}

export function resetCliRuntimeMessages(routeLabel: string): ChatMessage[] {
  return [buildCliRuntimeSystemMessage(routeLabel)];
}

export function refreshCliRuntimeSystemMessage(messages: ChatMessage[], routeLabel: string): void {
  const next = buildCliRuntimeSystemMessage(routeLabel);
  if (messages[0]?.role === "system") {
    messages[0] = next;
    return;
  }
  messages.unshift(next);
}
