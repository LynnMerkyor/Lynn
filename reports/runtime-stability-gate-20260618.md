# Lynn Runtime Stability Gate - 2026-06-18

Generated: 2026-06-18 23:08 CST

## Scope

This pass absorbs the stable runtime patterns we decided to borrow from Kun at the engineering-pattern level only:

- context hygiene around retry/regenerate and poisoned turns;
- stream/event recovery when switching back to an active session;
- ToolStorm / inflight duplicate suppression for identical concurrent tool calls;
- real GUI and CLI gates before any packaging decision.

No Kun source code was copied.

## Changes

### Retry / Regenerate Hygiene

- `AssistantMessage` no longer resends assistant retries through a side path.
- `retryAssistantResponse()` now reuses the normal prompt path, anchored at the preceding user message.
- The retry path sends `replaceFromMessageId` and `replaceFromMessageIndex`, so local UI state and server history are truncated consistently.
- If resend fails, Lynn restores the draft to the composer and does not trim the visible branch.

### Stream Recovery

- Session stream replay buffer default increased from 200 to 1000 events.
- Replay capacity can be tuned with `LYNN_STREAM_REPLAY_MAX_EVENTS`.
- Switching into an active streaming session now immediately requests stream resume instead of waiting for the watchdog.

### ToolStorm / Inflight

- Tool calls now get a stable per-session inflight key based on tool name and serialized params.
- Identical concurrent calls in the same session are deduped for a short TTL.
- Calls in different sessions are not deduped.
- Inflight keys are released after the original tool call settles.

## Verification

### Unit / Integration

```bash
npm test -- desktop/src/react/__tests__/stores/prompt-actions.test.ts tests/engine-tool-runtime.test.js tests/session-stream-store.test.js
```

Result: PASS, 3 files / 28 tests.

```bash
npm test -- tests/chat-route-events.test.js tests/session-prompt-sanitizer.test.js tests/tool-turn-finalizer-persistence.test.ts
```

Result: PASS, 3 files / 60 tests.

```bash
npm run typecheck
```

Result: PASS.

### Real GUI Gate

First attempt failed before app launch because the root `better-sqlite3` native module was not loadable by the gate Node runtime:

```text
better-sqlite3 native module cannot be loaded by this gate's Node.
```

Recovery:

```bash
npm rebuild better-sqlite3
```

Then:

```bash
npm run gate:gui-task
```

Result: PASS.

Evidence:

```text
[gate-gui-task] PASS - 真实 GUI 对话链路完成
```

### Real CLI Gate

```bash
npm run gate:cli-task
```

Result: PASS, 22 checks / 0 failures.

Covered:

- default StepFun route;
- visible answer;
- no reasoning leak;
- code-generation task;
- reasoning-only empty-answer adversarial case;
- `--fast` low-latency route.

### Electron UI Smoke

```bash
npm run test:release:ui
```

Result: PASS.

Scenarios:

- home;
- short;
- tools;
- image-tool-empty;
- long-code.

Report directory:

```text
output/ui-smoke-2026-06-18T15-07-49-285Z
```

## Packaging Readiness

The runtime changes are verified locally and through real GUI/CLI gates. Since the Gitee retry/regenerate fix touches GUI client code and local runtime code, users will need a newly packaged GUI build to receive it.

This report does not mean notarization or upload was performed. It only establishes that the current worktree is ready for the next packaging decision.

