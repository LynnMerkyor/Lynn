# Lynn v0.79.7 Release Notes

> 发布日期:2026-05-28 · 代号:"LynnEngine TS + Final Central Runtime"

v0.79.7 是 V0.79 线最后一块中枢 TypeScript 收口版。默认本地模型策略不变:继续推荐 **Qwen3.5-9B Q4_K_M imatrix MTP**,4B 只作为低配降级并保留 thinking-on 风险提示。本版重点完成 `core/engine` LynnEngine 门面的 TypeScript 迁移,让 agent/session/config/model/plugin 组合入口进入 runtime typecheck。

## 重点更新

- `core/engine` 迁入 TypeScript:LynnEngine facade、manager 组合、Brain 注册预热、插件初始化、MCP 激活和事件广播进入 runtime typecheck;旧 `HanaEngine` import 保留兼容别名。
- 工具安全边界类型化:tool guard、工具名 alias、sandbox 参数、confirm store 和 session event dispatch 增加 typed wrapper。
- 前序中枢迁移继续受门禁覆盖:`server/routes/chat`、`core/session-coordinator`、`core/agent` 和 runtime TS 配置一起回归。
- 本地模型口径不变:默认仍是 Qwen3.5-9B Q4_K_M imatrix MTP;4B 保持低配降级并提示 thinking-on 风险。

## 回归门禁

- `npm run typecheck` ✓
- `npm run typecheck:runtime` ✓
- Focused content-filter/session regression:2 files / 20 passed ✓
- Full `npm test`:194 files / 1519 passed / 1 skipped ✓
- `npm run build:server` / `npm run build:main` / `npm run build:renderer` ✓
- Release static regression:37/37 passed ✓
- Electron UI smoke:home / short / tools / long-code passed ✓
- Packaged-server live regression:9/9 passed, failed 0, blocker 0, critical 0 ✓
- Build/package/notarization gates:macOS Apple Silicon / Intel DMG and Windows installer rebuilt; both macOS DMGs are signed, notarized, stapled, and Gatekeeper accepted.

## SHA256

- `Lynn-0.79.7-macOS-Apple-Silicon.dmg`: `2e23467ccab289c7a7f26431b403cb69b3b23d302995a74413fe721ce30023e3`
- `Lynn-0.79.7-macOS-Intel.dmg`: `7ebc086c7eedc311a71ed3b6ef82caece722a06235d51e472a6c2f5d9c94258d`
- `Lynn-0.79.7-Windows-Setup.exe`: `038bc1d9a5c9f81a6bfef9a49c990b08620e025af71c13e2735741f8505a5fcc`

## English Summary

v0.79.7 is the final central TypeScript cleanup release for the V0.79 line. The local model policy is unchanged:Qwen3.5-9B Q4_K_M imatrix MTP remains the recommended default, while 4B remains a low-config downgrade with its thinking-on risk documented.

Highlights:
- `core/engine` moved to TypeScript, bringing the LynnEngine facade, manager composition, Brain registration prewarm, plugin init, MCP activation, and event dispatch into runtime typecheck; legacy `HanaEngine` imports remain supported through a compatibility alias.
- Tool safety boundaries now have typed wrappers:tool guards, tool-name aliases, sandbox options, confirm store, and session events.
- Earlier central migrations remain covered by the same gate:`server/routes/chat`, `core/session-coordinator`, `core/agent`, and runtime TS config are tested together.
- Local model onboarding remains Qwen3.5-9B by default, with 4B kept as the low-config downgrade.
