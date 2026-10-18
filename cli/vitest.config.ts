import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 10_000,
    setupFiles: [new URL("./tests/setup.ts", import.meta.url).pathname],
  },
});
