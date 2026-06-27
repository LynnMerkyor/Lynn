export function createAdapter() {
  return {
    name: "minimal-agent",
    version: "example",
    async run(operation, input) {
      if (operation === "echo") {
        return {
          text: String(input.text || ""),
          eventTypes: ["prompt_accepted", "text_delta", "turn_end"],
        };
      }
      throw new Error(`Unsupported operation: ${operation}`);
    },
  };
}
