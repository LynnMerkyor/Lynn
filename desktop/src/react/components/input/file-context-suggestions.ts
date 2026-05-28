const FILE_CONTEXT_PATTERN = /\b([A-Za-z0-9_./-]+\.(?:tsx?|jsx?|css|json|md|py|rs|go|java|vue|svelte|swift|kt|kts|c|cc|cpp|h|hpp|m|mm|sql|yaml|yml|toml|sh))\b/i;

export function detectInlineFileSuggestion(inputValue: string): string | null {
  const match = inputValue.match(FILE_CONTEXT_PATTERN);
  return match ? match[1] : null;
}
