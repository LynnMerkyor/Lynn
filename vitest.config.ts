import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 10_000,
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
