import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { interpolateString, safeSlug } from "./path.mjs";

export async function prepareFixture(fixture, context) {
  const prefix = safeSlug(context.case?.id || "agent-regression");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  context.vars.fixtureRoot = root;
  context.addCleanup(() => fs.rm(root, { recursive: true, force: true }));

  for (const file of fixture.files || []) {
    const rel = String(file.path || "").replace(/^[/\\]+/, "");
    if (!rel || rel.includes("..")) {
      throw new Error(`Unsafe fixture file path in ${context.case?.id}: ${file.path}`);
    }
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, interpolateString(String(file.content || ""), context.vars), file.encoding || "utf8");
  }
}
