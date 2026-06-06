export function completeJsonBoundary(text: string): number | null {
  const start = firstJsonStart(text);
  if (start < 0) return null;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index] || "";
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }
    if (char === "}" || char === "]") {
      if (!stack.length || stack.at(-1) !== char) return null;
      stack.pop();
      if (!stack.length) return index + 1;
    }
  }

  return null;
}

function firstJsonStart(text: string): number {
  const object = text.indexOf("{");
  const array = text.indexOf("[");
  if (object < 0) return array;
  if (array < 0) return object;
  return Math.min(object, array);
}
