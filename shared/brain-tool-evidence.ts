type EvidenceToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type BrainToolEvidenceMessage = { role: "assistant" | "tool"; content: string; reasoning_content?: string; tool_calls?: EvidenceToolCall[]; tool_call_id?: string; name?: string };

export function brainToolEvidenceMessages(progress: { event?: unknown; name?: unknown; toolCall?: unknown; result?: unknown }): BrainToolEvidenceMessage[] {
  if (progress.event !== "end" || typeof progress.result !== "string") return [];
  const call = progress.toolCall && typeof progress.toolCall === "object" ? progress.toolCall as Record<string, unknown> : {};
  const functionCall = call.function && typeof call.function === "object" ? call.function as Record<string, unknown> : {};
  if (typeof call.id !== "string" || !call.id || typeof functionCall.name !== "string" || !functionCall.name || functionCall.name !== progress.name || typeof functionCall.arguments !== "string") return [];
  const toolCall: EvidenceToolCall = { id: call.id, type: "function", function: { name: functionCall.name, arguments: functionCall.arguments } };
  return [
    { role: "assistant", content: "", reasoning_content: "", tool_calls: [toolCall] },
    { role: "tool", tool_call_id: toolCall.id, name: toolCall.function.name, content: progress.result },
  ];
}
