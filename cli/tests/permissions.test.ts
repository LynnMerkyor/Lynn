import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { renderPermissions, resolveEffectivePermissions } from "../src/permissions.js";

let tmp = "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-permissions-"));
});

afterEach(async () => {
  delete process.env.LYNN_CLI_APPROVAL;
  delete process.env.LYNN_CLI_SANDBOX;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("CLI permission profile", () => {
  it("defaults to guarded workspace-write mode", async () => {
    const permissions = await resolveEffectivePermissions(parseArgs(["permissions", "--data-dir", tmp]));

    expect(permissions.approval).toBe("ask");
    expect(permissions.sandbox).toBe("workspace-write");
    expect(permissions.source).toBe("default");
    expect(permissions.guiProfileFound).toBe(false);
  });

  it("reads future GUI profile files", async () => {
    const dir = path.join(tmp, "permissions");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "cli.json"), JSON.stringify({ approval: "never", sandbox: "read-only" }), "utf8");

    const permissions = await resolveEffectivePermissions(parseArgs(["permissions", "--data-dir", tmp]));

    expect(permissions.approval).toBe("never");
    expect(permissions.sandbox).toBe("read-only");
    expect(permissions.source).toBe("gui-profile");
    expect(permissions.guiProfileFound).toBe(true);
  });

  it("lets flags override env and GUI profile", async () => {
    process.env.LYNN_CLI_APPROVAL = "never";
    process.env.LYNN_CLI_SANDBOX = "read-only";

    const permissions = await resolveEffectivePermissions(parseArgs([
      "permissions",
      "--data-dir",
      tmp,
      "--approval",
      "yolo",
      "--sandbox",
      "danger-full-access",
    ]));

    expect(permissions.approval).toBe("yolo");
    expect(permissions.sandbox).toBe("danger-full-access");
    expect(permissions.source).toBe("flags");
    expect(renderPermissions(permissions)).toContain("WARNING");
  });
});

