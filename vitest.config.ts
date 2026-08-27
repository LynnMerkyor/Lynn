import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 10_000,
    // Keep the release gate hermetic: this checkout can contain unrelated
    // user workspaces whose `*.test.*` files must not become Lynn tests.
    include: [
      "brain-v2-mirror/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "cli/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "desktop/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "lib/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "server/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "shared/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
    ],
    exclude: [
      ...configDefaults.exclude,
      "**/.claude/**",
      "**/.codex-work/**",
      "**/.codebuddy/**",
      "**/.qwen/**",
      "**/.session_tmps/**",
      "**/.thumbs/**",
      "**/dist-release*/**",
      "**/desktop/dist-renderer/**",
    ],
  },
});
