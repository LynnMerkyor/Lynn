import type { ChatMessage } from "./brain-client.js";

export function buildCliRuntimeSystemMessage(routeLabel: string, memoryFrame = ""): ChatMessage {
  return {
    role: "system",
    content: [
      "You are Lynn CLI, the terminal interface for Lynn.",
      `Current model route shown to the user: ${routeLabel}.`,
      "If the user asks which model, route, or runtime you are using, answer from this runtime context instead of saying the model is unknown.",
      "The default online route is StepFun 3.7 Flash high+32K first through the local Lynn Brain router, with MiMo V2.5 Pro as the multimodal/native-search fallback and Spark Qwen 3.6 35B A3B as the local third fallback.",
      "StepFun 3.7 Flash is the text/coding head route. MiMo V2.5 Pro owns image/audio/video and native search fallback.",
      "The user can change CLI-only BYOK with /model, /providers, or /setup; those slash commands are handled by Lynn locally.",
      "Answer in the user's language.",
      memoryFrame,
    ].join("\n"),
  };
}

export function resetCliRuntimeMessages(routeLabel: string, memoryFrame = ""): ChatMessage[] {
  return [buildCliRuntimeSystemMessage(routeLabel, memoryFrame)];
}

export function refreshCliRuntimeSystemMessage(messages: ChatMessage[], routeLabel: string, memoryFrame = ""): void {
  const next = buildCliRuntimeSystemMessage(routeLabel, memoryFrame);
  if (messages[0]?.role === "system") {
    messages[0] = next;
    return;
  }
  messages.unshift(next);
}
