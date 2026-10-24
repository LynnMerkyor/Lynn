import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runClientTool } from "../src/tools/registry.js";

const darwin = process.platform === "darwin";
let tmp = "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-sbx-"));
  process.env.LYNN_CLI_OS_SANDBOX = "1";
});

afterEach(async () => {
  delete process.env.LYNN_CLI_OS_SANDBOX;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe.skipIf(!darwin)("macOS seatbelt sandbox", () => {
  it("allows writes inside the workspace and denies writes outside it", async () => {
    const inside = await runClientTool(
      { cwd: tmp, approval: "yolo", sandbox: "workspace-write" },
      { name: "bash", command: "node -e \"require('fs').writeFileSync('inside.txt','ok')\"" },
    );
    expect(inside.ok).toBe(true);
    expect(await fs.readFile(path.join(tmp, "inside.txt"), "utf8")).toBe("ok");

    const escapeName = `.lynn-sbx-escape-${Date.now()}`;
    const escapeFile = path.join(os.homedir(), escapeName);
    const outside = await runClientTool(
      { cwd: tmp, approval: "yolo", sandbox: "workspace-write" },
      { name: "bash", command: `node -e "require('fs').writeFileSync(process.env.HOME+'/${escapeName}','x')"` },
    );
    expect(outside.ok).toBe(false);
    await expect(fs.access(escapeFile)).rejects.toThrow();
  });

  it("keeps danger-full-access unconfined", async () => {
    const file = path.join(os.homedir(), `.lynn-sbx-open-${Date.now()}`);
    const result = await runClientTool(
      { cwd: tmp, approval: "yolo", sandbox: "danger-full-access" },
      { name: "bash", command: `node -e "require('fs').writeFileSync('${file}','x')"` },
    );
    await fs.rm(file, { force: true });
    expect(result.ok).toBe(true);
  });
});
