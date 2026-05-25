# Lynn v0.79.3 Release Notes

> 发布日期:2026-05-25 · 代号:"TypeScript 安全迁移候选"

v0.79.3 是 V0.79 线的架构安全推进版。默认本地模型策略不变:继续推荐 **Qwen3.5-9B Q4_K_M imatrix MTP**,4B 只作为低配降级并保留 thinking-on 风险提示。本版重点是把更多运行热路径迁进 TypeScript 边界,同时保持发版风险可控。

## 重点更新

- `server/chat` 多个叶子 helper 迁到 TS:artifact recovery、stream event emitter、turn state、tool summary、local Qwen direct runner、voice fallback orchestrator 等。
- `server/routes` 轻量路由和 `shared` runtime 工具继续迁 TS,减少字符串 typo、隐式 `unknown` 和跨模块协议漂移。
- `brain-v2-mirror` TS island 保持稳定,本轮不改生产 fallback 行为。
- `core/session-coordinator.js`、`core/engine.js` 等大文件已评估但暂不合入,避免为追求 JS 占比牺牲 V0.79.3 稳定性。
- macOS 本轮按无公证候选包发布:保留签名校验,跳过 Apple notarization;首次打开可能需要按 macOS 提示确认。

## 回归门禁

- `npm run typecheck:runtime` ✓
- `npm run typecheck` ✓
- Targeted regression:10 files / 70 passed ✓
- Full `npm test`:185 files / 1463 passed / 1 skipped ✓
- Build gates:server / main / renderer ✓
- Release package gates:macOS Apple Silicon / Intel signed DMG, Windows signed NSIS installer, static release regression 37/37, live smoke `Failed:0; blocker:0; critical:0` ✓

## English Summary

v0.79.3 is an architecture-hardening release for the V0.79 line. The local model policy is unchanged:Qwen3.5-9B Q4_K_M imatrix MTP remains the recommended default, while 4B remains a low-config downgrade with its thinking-on risk documented.

Highlights:
- More `server/chat`, `server/routes`, and `shared` runtime helpers now have TypeScript boundaries.
- Chat/artifact hot paths such as stream emitters, turn state, tool summary, local Qwen direct runner, and voice fallback are easier to maintain.
- Large core files were intentionally deferred to keep this release stable.
- macOS artifacts are shipped as non-notarized candidates this round; signing checks remain, but Apple notarization is skipped.
- Package gates passed for Apple Silicon DMG, Intel DMG, Windows installer, static release regression, and live smoke.
