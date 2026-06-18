// [VISION-ARG-FIX v0.76.5] Regression guard for native runtime prompt options.
//
// 背景：Lynn 原生 agent runtime 的 Agent.prompt() 签名是：
//   prompt(input: string, options?: { images?: ImageContent[] }): Promise<void>;
//
// 第二参数必须是由 toSessionPromptOptions() 构造的 prompt options。历史上 Lynn
// 在切换底层 runtime 时出现过两类回归：把 images 包成不被 runtime 识别的裸对象，
// 或者绕开 helper 直接 inline `{ images: ... }`，导致图片从未真正送达模型。
//
// 此测试用静态扫描做守护：
//   1) 确保源码里不再出现 `{ images: opts.images }` / `{ images: opts?.images }` 之类的对象包装。
//   2) 确保 session.prompt() 的第二参数不是 `{` 起头的对象字面量。
//   3) 确保入口使用 toSessionPromptOptions() helper 构造视觉 prompt options。
//
// 如果未来有人重新引入这个 bug（refactor 顺手包了对象），这个测试会立刻红。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const GUARDED_FILES = [
  "core/session-coordinator.ts",
  "core/bridge-session-manager.ts",
];

function readSource(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

describe("[VISION-ARG-FIX] native runtime prompt image-argument regression guard", () => {
  // 历史演化说明:
  //   v0.76.5: prompt(input, images?: ImageContent[]) 签名 · 直接传数组
  //   v0.76.6+: prompt(input, options?: { images?: ImageContent[] }) · 改用 toSessionPromptOptions 统一构造
  //   任何版本都不应该出现 `{ images: opts.images }` 这种裸字面量 - 那是 v0.76.5 修过的 bug
  it.each(GUARDED_FILES)(
    "%s · does not use deprecated { images: opts.images } bare literal",
    (file) => {
      const src = readSource(file);
      const badWrapping = /\{\s*images\s*:\s*opts\??\.images\s*\}/g;
      const matches = src.match(badWrapping) || [];
      expect(
        matches,
        `Found ${matches.length} instance(s) of legacy { images: opts.images } literal in ${file}. ` +
        `Use toSessionPromptOptions(opts.images) helper instead.`,
      ).toHaveLength(0);
    },
  );

  it.each(GUARDED_FILES)(
    "%s · session.prompt() uses _promptOpts variable (not inline bare { images: ... })",
    (file) => {
      const src = readSource(file);
      // 允许 session.prompt(text, _promptOpts) 或 session.prompt(text, variable_name)
      // 禁止 session.prompt(text, { images: ... }) 这种内联对象字面量
      const inlineObj = /\.prompt\s*\([^,)]+,\s*\{\s*images\b/g;
      const matches = src.match(inlineObj) || [];
      expect(
        matches,
        `Found ${matches.length} inline { images: ... } object literal at session.prompt call site in ${file}. ` +
        `Use a named variable from toSessionPromptOptions() instead.`,
      ).toHaveLength(0);
    },
  );

  it.each(GUARDED_FILES)(
    "%s · uses toSessionPromptOptions helper (v0.76.6 canonicalized) for images",
    (file) => {
      const src = readSource(file);
      // v0.76.6 之后 · 两边都应该用 toSessionPromptOptions(opts.images) 统一
      // 而不是裸传数组 · 因为视觉字段布局需要由 helper 统一 canonicalize
      const usesHelper = /toSessionPromptOptions\s*\(/.test(src);
      expect(
        usesHelper,
        `${file} should use toSessionPromptOptions() helper to build prompt options with correct image shape for the native runtime.`,
      ).toBe(true);
    },
  );

  it.each(GUARDED_FILES)(
    "%s · carries a [VISION-ARG-FIX ...] marker (any version) near prompt call site",
    (file) => {
      const src = readSource(file);
      const hasMarker = /\[VISION-ARG-FIX v0\.\d+\.\d+\]/.test(src);
      expect(
        hasMarker,
        `${file} should carry a [VISION-ARG-FIX vX.Y.Z] marker near session.prompt() to signal the image-arg invariant is being actively enforced.`,
      ).toBe(true);
    },
  );

  it("native runtime prompt signature remains options-based", () => {
    const runtimeTypes = readSource("core/agent-runtime/create-session.ts");
    const hasOptionsSig = /prompt\s*\(\s*\w+\s*:\s*string\s*,\s*options\?\s*:\s*PromptOptions\s*\)/.test(runtimeTypes);
    expect(
      hasOptionsSig,
      "Native runtime prompt() signature changed. Re-check core/session-coordinator.ts and core/bridge-session-manager.ts toSessionPromptOptions usage.",
    ).toBe(true);
  });
});
