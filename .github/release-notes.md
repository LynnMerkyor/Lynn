# Lynn v0.79.4 Release Notes

> 发布日期:2026-05-26 · 代号:"Runtime TypeScript 工具链版"

v0.79.4 是 V0.79 线的运行时架构加固版。默认本地模型策略不变:继续推荐 **Qwen3.5-9B Q4_K_M imatrix MTP**,4B 只作为低配降级并保留 thinking-on 风险提示。本版重点是把工具链、实时信息和记忆检索叶子路径迁进 TypeScript,让发布前的静态门禁能覆盖更多真实热路径。

## 重点更新

- `lib/tools` 全量迁入 TypeScript:web search、realtime info/weather/news/sports、stock market、stock research、browser、channel/experience、install skill、snapshot restore 等工具现在都有类型边界。
- 记忆检索叶子路径继续收紧:`memory-search`、`user-profile` 和 `HybridRetriever` 已迁到 TS,并保留聚焦回归测试。
- Web/market/realtime 工具返回结构更清晰,Deep Research、本地工具调用和 chat/tool tiering 之间的协议漂移风险降低。
- `brain-v2-mirror`、`server/chat`、`shared` 的 V0.79.2/V0.79.3 TS 基建保持稳定,本版不改变生产 fallback 行为。
- 大中枢 JS 文件已列入 V0.79.5+ 单独波次:本次故意不动 `chat.js`、`voice-ws.js`、`engine.js`、`agent.js`、`session-coordinator.js`,避免在发布包中混入高风险中心重构。

## 回归门禁

- `npm run typecheck:runtime` ✓
- `npm run typecheck` ✓
- Full `npm test`:193 files / 1497 passed / 1 skipped ✓
- Build/package/notarization gates:macOS Apple Silicon / Intel DMG and Windows installer are rebuilt through the release gate for this version.

## English Summary

v0.79.4 is a runtime architecture-hardening release for the V0.79 line. The local model policy is unchanged:Qwen3.5-9B Q4_K_M imatrix MTP remains the recommended default, while 4B remains a low-config downgrade with its thinking-on risk documented.

Highlights:
- `lib/tools` is now fully typed: web search, realtime info/weather/news/sports, stock market, stock research, browser, channel/experience, install skill, snapshot restore, and related helpers now have TS boundaries.
- Memory retrieval leaf paths such as `memory-search`, `user-profile`, and `HybridRetriever` moved to TypeScript with focused regressions.
- Web, market, and realtime contracts are safer across Deep Research, local tools, and chat/tool tiering.
- Large central JS files are intentionally deferred to V0.79.5+ so this package stays stable.
- Release gates cover runtime typecheck, full TypeScript typecheck, full Vitest, and package/notarization validation for this release.
