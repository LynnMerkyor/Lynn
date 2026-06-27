# Agent Regression Kit

Agent Regression Kit is a small, adapter-driven regression runner for AI agents. The core runner is intentionally independent from Lynn: it loads a case bank, materializes fixtures, calls an adapter operation, evaluates deterministic assertions, and emits a JSON report.

The important distinction: this is not primarily a model-quality eval. It is an Agent runtime contract runner. A case may assert the visible answer, but it should prefer durable behavior: route choice, request body shape, event trace, tool call order, tool arguments, evidence handoff, retries, empty-answer fallback, and stale-context pollution.

## Shape

- `src/core.mjs`: adapter-neutral runner, fixture handling, selection, assertions, and reports.
- `src/fake-openai-provider.mjs`: adapter-neutral scripted OpenAI-compatible SSE provider for deterministic agent-runtime traces, including `/health`, `/models`, and `/v1/chat/completions`.
- `case-bank.schema.json`: portable JSON schema for case banks.
- `cases/lynn-backend-v1.json`: Lynn's first backend/CLI regression case bank.
- `adapters/lynn.mjs`: Lynn-specific operations that call the real backend routing, tool, stream, and retry helpers.

## Case Design

Cases are deterministic by default. They should prove backend contracts such as route intent, tool prefetch decisions, pseudo-tool suppression, stream chunk handling, evidence-tool budgets, retry behavior, and prompt/history pollution guards. Live model or web checks should be kept for a future `nightly` lane so release gates stay stable.

For agent-runtime cases, use a scripted provider and assert the event/request trace rather than natural-language snapshots. Lynn's `native_session_trace` operation starts the fake provider, points a real native session at it, optionally registers fixture tools, runs one or more prompts, and returns:

- `events`, `eventTypes`, `assistantEventTypes`
- `toolStarts`, `toolEnds`
- `finalText`, `finalTexts`
- `provider.requests`, including `lastUserText`, `lastToolText`, and `toolNames`
- `diagnostics`, a compact contract summary for turn closure, visible answers, tool handoff, reasoning-only fallback, stale prompt echoes, and parse errors
- canonical session `messages`

Lynn's `cli_provider_trace` operation uses the same fake provider through the real `cli/bin/lynn.mjs` prompt command in JSON mode. That gives v1 a cheap CLI shell regression without requiring live Brain or StepFun.

Lynn's `brain_v2_route_trace` operation starts the fake provider in the parent process, then runs Brain v2 `router.run()` in an isolated child process with `BRAIN_V2_ENABLE_P_FAKE=1`. This keeps provider-registry module state and cooldown maps from leaking between cases while still letting the parent inspect the fake provider's `/models` probes and `/chat/completions` requests. The operation also disables Lynn's direct realtime prefetch shortcuts for the child process, so weather/sports/market prompts prove the real provider route instead of a deterministic bypass.

`scripted_provider_probe` verifies the fake provider's health/model endpoints before a case relies on it. Keep this kind of probe in the kit so provider health/cooldown bugs are caught before live Brain-route work starts.

Minimal case:

```json
{
  "id": "route.local-novel-read",
  "level": "smoke",
  "operation": "route_intent",
  "input": { "prompt": "读一下当前目录里的小说第一章" },
  "assertions": [
    { "path": "intent", "equals": "utility" }
  ]
}
```

## Lynn Commands

```bash
npm run test:agent-regression:smoke
npm run test:agent-regression
npm run test:agent-regression:nightly
```

The command writes a report under `/tmp/lynn-agent-regression/` by default.

## Layering

- Layer 1: deterministic helper contracts, no model or server.
- Layer 2: native runtime trace with scripted OpenAI-compatible SSE provider.
- Layer 3: route/runtime shell traces through real Brain v2 router or `cli/bin/lynn.mjs` and the scripted provider.
- Layer 4: future live smoke, only structure invariants; never assert full model prose.
