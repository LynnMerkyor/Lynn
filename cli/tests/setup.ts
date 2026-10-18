import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, vi } from "vitest";

if (expect.getState().testPath?.replaceAll("\\", "/").includes("/cli/tests/")) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-cli-unit-home-"));
  vi.stubEnv("LYNN_HOME", home);
  vi.stubEnv("LYNN_DATA_DIR", home);
  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });
}
