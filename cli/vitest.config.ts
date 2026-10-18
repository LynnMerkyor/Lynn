import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    testTimeout: 10_000,
    setupFiles: [fileURLToPath(new URL("./tests/setup.ts", import.meta.url))],
  },
});
