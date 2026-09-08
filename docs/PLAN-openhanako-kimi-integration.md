# Lynn functional additions and Kimi Datasource

Requested by Lynn on 2026-09-08. All six workstreams remain in scope until implemented and verified. This is a development task; no release version or publication is implied.

## Scope and acceptance

- [x] Conversation body search: search saved user/assistant text across the current agent's sessions, return matching excerpts and open the correct session; preserve title/label search; handle empty, multilingual, stale and deleted records.
- [x] Lightweight automations: support direct reminders and explicit plugin actions alongside existing agent jobs; persist/migrate old jobs, expose the executor in the editor, retain run history/error handling, and never silently substitute an agent for an unavailable plugin action.
- [x] Unified session files: use stable session-scoped file identifiers for generated and uploaded files, with authenticated downloads usable by desktop, bridges and mobile. Validate ownership and real paths; preserve existing files and delivery compatibility.
- [x] Mobile PWA continuation: provide a responsive installable entry point for authenticated session history, messages and file downloads, with explicit device pairing/revocation and no caching of private API responses. Deployment must document HTTPS requirements.
- [x] MCP OAuth: support HTTP/SSE authorization discovery, PKCE/state, callback completion, local credential storage, token refresh and disconnect through MCP settings; keep existing stdio/static credentials working.
- [x] Kimi Datasource in MCP: include the official datasource and offer per-user QR device authorization that automatically enables it after login; also retain optional explicit discovery of the user's installed official plugin with a configuration preview. Do not share credentials through Brain, invent QR endpoints, or claim paid-source access without a live authenticated check.

## Sources and constraints

- OpenHanako/HanaAgent source reviewed at `1d3ef308299e9f630786384e77de45444ea59196` (Apache-2.0).
- Kimi Code official source reviewed at `0527dae16057a2a8ff79d765dbfe979dd714bf96`; verify the actual plugin manifest and authentication API before implementation.
- Existing optional tree-shadow candidate remains separate and disabled by default. It is not a replacement for any of these functional additions.
- Protect other worktrees and user changes. Test with isolated temporary homes and fake servers; never expose personal tokens in evidence or fixtures.

## Final development verification — 2026-09-08

All six requested integrations are implemented in this worktree. No release, installation, account authorization, or paid datasource query was performed.

- 120 tests pass across 16 targeted suites, including existing automation/history/prompt regressions.
- Renderer and runtime TypeScript checks pass; renderer and Vite server code bundles build successfully.
- Frontend architecture gate passes (305 modules, no runtime import cycles).
- New/changed functionality has no new ESLint errors. Two existing server files retain exactly their HEAD baseline of 49 errors (17 + 32).
- Hidden mobile UI test at 390 × 844: pairing, existing history, continued message, persisted reply and session-file listing verified. Temporary viewport and task-owned mobile server were cleaned up.
- Official unauthenticated Kimi device authorization endpoint returned HTTP 200, valid device/user-code fields, a www.kimi.com verification origin, and a 1,800-second expiry. No code/token values were saved in evidence. Actual account authorization and datasource quota remain user-controlled and untested.
- Bundled Kimi official stdio process initialized and exposed its two tools without an account; its pinned source SHA256 is unchanged. Nine shipped resource files matched source hashes.

See `docs/DEV-VERIFICATION-functional-kimi-20260908.md` for usage, limits and evidence locations.
