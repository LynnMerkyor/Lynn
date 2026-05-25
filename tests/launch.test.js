import { describe, expect, it, vi } from "vitest";
import { canLoadBetterSqlite3, resolveLaunchPlan } from "../scripts/launch.js";

const serverFiles = (...paths) => vi.fn((path) => paths.includes(path));

describe("scripts/launch", () => {
  it("detects when better-sqlite3 can be opened by current runtime", () => {
    class FakeDatabase {
      close() {}
    }
    const requireFn = vi.fn((id) => {
      if (id === "better-sqlite3") return FakeDatabase;
      throw new Error(`unexpected module: ${id}`);
    });

    expect(canLoadBetterSqlite3(requireFn)).toBe(true);
    expect(requireFn).toHaveBeenCalledWith("better-sqlite3");
  });

  it("falls back to Electron runtime for server when better-sqlite3 ABI is incompatible", () => {
    const requireFn = vi.fn((id) => {
      if (id === "better-sqlite3") {
        throw new Error("NODE_MODULE_VERSION mismatch");
      }
      if (id === "electron") return "/Applications/Electron.app/Contents/MacOS/Electron";
      throw new Error(`unexpected module: ${id}`);
    });

    const plan = resolveLaunchPlan({
      mode: "server",
      extra: ["--inspect"],
      env: {},
      execPath: "/usr/local/bin/node",
      requireFn,
      fileExists: serverFiles("server/index.js"),
      nodeVersion: "v24.14.0",
    });

    expect(plan.bin).toBe("/Applications/Electron.app/Contents/MacOS/Electron");
    expect(plan.args).toEqual(["server/index.js", "--inspect"]);
    expect(plan.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(plan.warning).toContain("自动切换到 Electron 运行时");
  });

  it("keeps the current JS server path unchanged when only JS sources exist", () => {
    class FakeDatabase {
      close() {}
    }
    const requireFn = vi.fn((id) => {
      if (id === "better-sqlite3") return FakeDatabase;
      if (id === "electron") return "/Applications/Electron.app/Contents/MacOS/Electron";
      throw new Error(`unexpected module: ${id}`);
    });
    const resolveFn = vi.fn();

    const plan = resolveLaunchPlan({
      mode: "server",
      extra: ["--port", "9999"],
      env: {},
      execPath: "/usr/local/bin/node",
      requireFn,
      resolveFn,
      fileExists: serverFiles("server/index.js"),
    });

    expect(plan.bin).toBe("/usr/local/bin/node");
    expect(plan.args).toEqual(["server/index.js", "--port", "9999"]);
    expect(plan.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(plan.warning).toBeNull();
    expect(resolveFn).not.toHaveBeenCalled();
  });

  it("loads tsx for JS server entry when runtime leaf modules are TypeScript", () => {
    class FakeDatabase {
      close() {}
    }
    const requireFn = vi.fn((id) => {
      if (id === "better-sqlite3") return FakeDatabase;
      throw new Error(`unexpected module: ${id}`);
    });
    const resolveFn = vi.fn((id) => {
      if (id === "tsx") return "/repo/node_modules/tsx/dist/cli.mjs";
      throw new Error(`unexpected module: ${id}`);
    });

    const plan = resolveLaunchPlan({
      mode: "server",
      extra: ["--port", "9999"],
      env: {},
      execPath: "/usr/local/bin/node",
      requireFn,
      resolveFn,
      fileExists: serverFiles("server/index.js", "server/chat/content-utils.ts"),
    });

    expect(plan.bin).toBe("/usr/local/bin/node");
    expect(plan.args).toEqual(["--import", "tsx", "server/index.js", "--port", "9999"]);
    expect(plan.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(plan.warning).toBeNull();
    expect(resolveFn).toHaveBeenCalledWith("tsx");
  });

  it("uses tsx for an explicit TS source server path", () => {
    class FakeDatabase {
      close() {}
    }
    const requireFn = vi.fn((id) => {
      if (id === "better-sqlite3") return FakeDatabase;
      throw new Error(`unexpected module: ${id}`);
    });
    const resolveFn = vi.fn((id) => {
      if (id === "tsx") return "/repo/node_modules/tsx/dist/cli.mjs";
      throw new Error(`unexpected module: ${id}`);
    });

    const plan = resolveLaunchPlan({
      mode: "server",
      extra: ["--port", "9999"],
      env: { LYNN_SERVER_ENTRY: "ts" },
      execPath: "/usr/local/bin/node",
      requireFn,
      resolveFn,
      fileExists: serverFiles("server/index.js", "server/index.ts"),
    });

    expect(plan.bin).toBe("/usr/local/bin/node");
    expect(plan.args).toEqual(["--import", "tsx", "server/index.ts", "--port", "9999"]);
    expect(plan.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(plan.warning).toBeNull();
    expect(resolveFn).toHaveBeenCalledWith("tsx");
  });

  it("uses tsx with Electron RUN_AS_NODE fallback for a TS source server path", () => {
    const requireFn = vi.fn((id) => {
      if (id === "better-sqlite3") {
        throw new Error("NODE_MODULE_VERSION mismatch");
      }
      if (id === "electron") return "/Applications/Electron.app/Contents/MacOS/Electron";
      throw new Error(`unexpected module: ${id}`);
    });
    const resolveFn = vi.fn((id) => {
      if (id === "tsx") return "/repo/node_modules/tsx/dist/cli.mjs";
      throw new Error(`unexpected module: ${id}`);
    });

    const plan = resolveLaunchPlan({
      mode: "server",
      extra: ["--inspect"],
      env: { LYNN_SERVER_ENTRY: "ts" },
      execPath: "/usr/local/bin/node",
      requireFn,
      resolveFn,
      fileExists: serverFiles("server/index.ts"),
      nodeVersion: "v24.14.0",
    });

    expect(plan.bin).toBe("/Applications/Electron.app/Contents/MacOS/Electron");
    expect(plan.args).toEqual(["--import", "tsx", "server/index.ts", "--inspect"]);
    expect(plan.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(plan.warning).toContain("自动切换到 Electron 运行时");
    expect(resolveFn).toHaveBeenCalledWith("tsx");
  });

  it("uses tsx when auto mode finds server/index.ts and no server/index.js", () => {
    class FakeDatabase {
      close() {}
    }
    const requireFn = vi.fn((id) => {
      if (id === "better-sqlite3") return FakeDatabase;
      throw new Error(`unexpected module: ${id}`);
    });
    const resolveFn = vi.fn((id) => {
      if (id === "tsx") return "/repo/node_modules/tsx/dist/cli.mjs";
      throw new Error(`unexpected module: ${id}`);
    });

    const plan = resolveLaunchPlan({
      mode: "server",
      env: {},
      execPath: "/usr/local/bin/node",
      requireFn,
      resolveFn,
      fileExists: serverFiles("server/index.ts"),
    });

    expect(plan.bin).toBe("/usr/local/bin/node");
    expect(plan.args).toEqual(["--import", "tsx", "server/index.ts"]);
    expect(plan.warning).toBeNull();
  });

  it("throws a clear error when TypeScript server sources are selected without tsx", () => {
    const resolveFn = vi.fn(() => {
      throw new Error("Cannot find module 'tsx'");
    });

    expect(() => resolveLaunchPlan({
      mode: "server",
      env: { LYNN_SERVER_ENTRY: "ts" },
      resolveFn,
      fileExists: serverFiles("server/index.ts"),
    })).toThrow("TypeScript server sources require dev dependency `tsx`");
    expect(resolveFn).toHaveBeenCalledWith("tsx");
  });
});
