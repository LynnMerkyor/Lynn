import fs from "node:fs/promises";
import path from "node:path";

function assertInsideRoot(root: string, candidate: string, input: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`path escapes workspace: ${input}`);
  }
}

async function resolveExistingParent(root: string, candidate: string, input: string): Promise<string> {
  const missing: string[] = [];
  let current = candidate;
  while (current && current !== root && current !== path.dirname(current)) {
    try {
      const real = await fs.realpath(current);
      assertInsideRoot(root, real, input);
      return path.join(real, ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      missing.push(path.basename(current));
      current = path.dirname(current);
    }
  }
  const realRoot = await fs.realpath(root);
  assertInsideRoot(root, realRoot, input);
  return path.join(realRoot, ...missing.reverse());
}

export async function resolveInsideWorkspace(cwd: string, input = "."): Promise<string> {
  const root = await fs.realpath(path.resolve(cwd));
  const resolved = path.resolve(root, input);
  assertInsideRoot(root, resolved, input);
  try {
    const real = await fs.realpath(resolved);
    assertInsideRoot(root, real, input);
    return real;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
  return resolveExistingParent(root, resolved, input);
}

export function displayPath(cwd: string, filePath: string): string {
  const relative = path.relative(path.resolve(cwd), filePath);
  return relative && !relative.startsWith("..") ? relative : filePath;
}
