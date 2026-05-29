import fs from "node:fs/promises";
import path from "node:path";

export async function resolveInsideWorkspace(cwd: string, input = "."): Promise<string> {
  const root = await fs.realpath(path.resolve(cwd));
  const resolved = path.resolve(root, input);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`path escapes workspace: ${input}`);
  }
  return resolved;
}

export function displayPath(cwd: string, filePath: string): string {
  const relative = path.relative(path.resolve(cwd), filePath);
  return relative && !relative.startsWith("..") ? relative : filePath;
}
