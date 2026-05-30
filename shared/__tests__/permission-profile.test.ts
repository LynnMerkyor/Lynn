import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERMISSION_PROFILE,
  isFullAccessPermission,
  normalizeApprovalMode,
  normalizePermissionProfile,
  normalizeSandboxMode,
} from "../permission-profile.js";

describe("permission profile contract", () => {
  it("normalizes the canonical approval and sandbox modes", () => {
    expect(normalizeApprovalMode("ask")).toBe("ask");
    expect(normalizeApprovalMode("on-failure")).toBe("on-failure");
    expect(normalizeApprovalMode("never")).toBe("never");
    expect(normalizeApprovalMode("yolo")).toBe("yolo");
    expect(normalizeApprovalMode("always")).toBeNull();

    expect(normalizeSandboxMode("read-only")).toBe("read-only");
    expect(normalizeSandboxMode("workspace-write")).toBe("workspace-write");
    expect(normalizeSandboxMode("danger-full-access")).toBe("danger-full-access");
    expect(normalizeSandboxMode("workspace")).toBeNull();
  });

  it("falls back field-by-field instead of trusting malformed profiles", () => {
    expect(normalizePermissionProfile({ approval: "yolo", sandbox: "wat" })).toEqual({
      approval: "yolo",
      sandbox: DEFAULT_PERMISSION_PROFILE.sandbox,
    });
    expect(normalizePermissionProfile(null)).toEqual(DEFAULT_PERMISSION_PROFILE);
  });

  it("recognizes the strong local-permission modes", () => {
    expect(isFullAccessPermission({ approval: "yolo", sandbox: "workspace-write" })).toBe(true);
    expect(isFullAccessPermission({ approval: "ask", sandbox: "danger-full-access" })).toBe(true);
    expect(isFullAccessPermission(DEFAULT_PERMISSION_PROFILE)).toBe(false);
  });
});
