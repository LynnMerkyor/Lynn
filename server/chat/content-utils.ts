/**
 * Shared helpers for extracting displayable text from SDK message content.
 */

interface TextBlock {
  type: "text";
  text: string;
}

export function extractText(content: string | TextBlock[] | null | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: unknown): block is TextBlock =>
      (block as TextBlock)?.type === "text" && !!(block as TextBlock).text)
    .map((block) => block.text)
    .join("");
}
