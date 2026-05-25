# Multi-Agent TS Refactor Dispatch (2026-05-25)

## Roles

Codex is the integration owner for `codex/v0791-architecture-cleanup`: owns merge order, conflict resolution, final tests, and release judgment.

CLI-1 (`codebuddy`, GPT-5.5) owns `brain-v2-mirror/**` for the TypeScript island migration.

CLI-2 (`qwen`, MiMo 2.5 Pro) owns `server/routes/chat.js`, `server/chat/**`, and matching chat tests for the chat route split.

CLI-3 owns `desktop/src/react/**`, `.gitattributes`, and `docs/**` for UX wording, metrics cleanup, and language-stat calibration.

Claude acts as architecture and security reviewer and should avoid long-running edits to the center files owned by the CLI agents.

## Merge Order

1. Codex baseline: `543ec10 feat(chat): surface provider fallback route metadata`.
2. CLI-3: UX/docs/linguist cleanup.
3. CLI-1: `brain-v2-mirror` TS island.
4. CLI-2: `server/routes/chat.js` split.
5. Claude review.
6. Codex final gate and release decision.

## Boundaries

CLI-1 must not edit `server/**`, `core/**`, `desktop/**`, `lib/**`, or `shared/**`.

CLI-2 must not edit `brain-v2-mirror/**`, `desktop/**`, `core/**`, `lib/**`, or `shared/**`.

CLI-3 must not edit `brain-v2-mirror/**`, `server/**`, `core/**`, `lib/**`, or `shared/**`.

Cross-cutting fixes should be written as handoff notes instead of changing another agent's files.

## Current CLI-3 Notes

The provider fallback chip and `provider_meta` protocol bridge are already implemented in `543ec10`; CLI-3 should only polish UI wording around that behavior, not reimplement the protocol.

The local onboarding default is Qwen3.5-9B Q4_K_M imatrix MTP. Qwen3.5-4B is a low-configuration downgrade only, with explicit thinking-on risk wording. The 35B high-end local option is Qwen3.6-35B-A3B Q4_K_M imatrix with 24GB+ memory guidance.

HTML artifacts from Deep Research already normalize to `artifactType: "html"` and render as clickable chat preview cards through `ArtifactCard` and `openPreview`.

## Safety Rule

Do not download model, BF16, GGUF, dataset, or training packages to the local Mac without explicit user authorization. Model artifacts belong on Spark or other remote machines unless the user explicitly asks for local download.
