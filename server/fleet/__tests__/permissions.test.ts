import { describe, expect, it } from "vitest";
import { readPermissionStatus, permissionProfilePath } from "../permissions.js";

describe("readPermissionStatus", () => {
  it("reads an existing profile", async () => {
    const st = await readPermissionStatus({
      profilePath: "/x/cli.json",
      readFile: async () => JSON.stringify({ approval: "yolo", sandbox: "danger-full-access" }),
    });
    expect(st).toEqual({ exists: true, path: "/x/cli.json", approval: "yolo", sandbox: "danger-full-access" });
  });

  it("falls back to guarded defaults when the profile is missing", async () => {
    const st = await readPermissionStatus({
      profilePath: "/x/cli.json",
      readFile: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(st).toEqual({ exists: false, path: "/x/cli.json", approval: "ask", sandbox: "workspace-write" });
  });

  it("normalizes malformed profile fields through the shared contract", async () => {
    const st = await readPermissionStatus({
      profilePath: "/x/cli.json",
      readFile: async () => JSON.stringify({ approval: "always", sandbox: "read-only" }),
    });
    expect(st).toEqual({ exists: true, path: "/x/cli.json", approval: "ask", sandbox: "read-only" });
  });

  it("permissionProfilePath honors an explicit home", () => {
    expect(permissionProfilePath("/home/u/.lynn")).toBe("/home/u/.lynn/permissions/cli.json");
  });
});
