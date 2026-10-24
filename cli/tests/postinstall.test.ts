import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "lynn install 空格 ")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it("does not touch user shims during local or isolated global installation", async () => {
  const source = fileURLToPath(new URL("../scripts/postinstall.mjs", import.meta.url));
  const packageRoot = path.join(root, "package space");
  await fs.mkdir(path.join(packageRoot, "scripts"), { recursive: true });
  await fs.mkdir(path.join(packageRoot, "bin"));
  await fs.copyFile(source, path.join(packageRoot, "scripts/postinstall.mjs"));
  await fs.writeFile(path.join(packageRoot, "bin/lynn.mjs"), "");
  const userBin = path.join(root, ".local/bin");
  const prefix = path.join(root, "prefix");
  await fs.mkdir(userBin, { recursive: true });
  await fs.mkdir(path.join(prefix, "bin"), { recursive: true });
  if (process.platform === "win32") {
    execFileSync(process.execPath, [source]);
    return;
  }
  const userLink = path.join(userBin, "lynn");
  await fs.symlink("/missing/unrelated-tool", userLink);
  const run = (global: string, extra = {}) => execFileSync(process.execPath, [path.join(packageRoot, "scripts/postinstall.mjs")], {
    env: { ...process.env, HOME: root, npm_config_global: global, npm_config_prefix: prefix, LYNN_REPAIR_USER_SHIM: "0", ...extra },
  });
  run("false"); run("true"); run("true", { LYNN_REPAIR_USER_SHIM: "1" });
  expect(await fs.readlink(userLink)).toBe("/missing/unrelated-tool");
  const officialLink = path.join(prefix, "bin/Lynn");
  await fs.symlink(path.join(packageRoot, "bin/lynn.mjs"), officialLink);
  run("true");
  expect(await fs.readdir(path.join(prefix, "bin"))).toEqual(["Lynn"]);
  expect(await fs.realpath(officialLink)).toBe(await fs.realpath(path.join(packageRoot, "bin/lynn.mjs")));
  await fs.unlink(officialLink);
  const ownedLink = path.join(prefix, "bin/lynn");
  await fs.symlink("/missing/@lynn/cli/bin/lynn.mjs", ownedLink);
  run("true");
  expect(await fs.realpath(ownedLink)).toBe(await fs.realpath(path.join(packageRoot, "bin/lynn.mjs")));
});
