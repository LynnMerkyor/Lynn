# Agent Regression Kit

Agent Regression Kit is an adapter-driven harness for AI agent runtime contracts. It is designed to be used against local projects, GitHub/Gitee clones, and packaged apps by injecting a model API and generating a project-specific adapter/case bank.

The important distinction: this is not primarily a model-quality eval. It is an Agent runtime contract runner. A case may assert the visible answer, but it should prefer durable behavior: route choice, request body shape, event trace, tool call order, tool arguments, evidence handoff, retries, empty-answer fallback, and stale-context pollution.

Model ability is a separate layer. The harness first proves the runtime boundaries with deterministic providers; live model checks then add capability evidence using structural assertions rather than exact prose.

## Standalone Flow

```bash
# Inspect any local/GitHub/Gitee checkout.
ark inspect --project /path/to/agent-app

# Generate a starter harness in that project.
ark init --project /path/to/agent-app \
  --model-base-url '${ARK_MODEL_BASE_URL}' \
  --model '${ARK_MODEL_ID}' \
  --api-key-env ARK_MODEL_API_KEY

# Run the generated smoke contracts.
ark run \
  --adapter /path/to/agent-app/agent-regression/adapter.mjs \
  --case-bank /path/to/agent-app/agent-regression/cases/project-smoke.json \
  --level smoke
```

## Shape

- `bin/ark.mjs`: standalone CLI with `inspect`, `init`, and `run`.
- `src/index.mjs`: public API surface.
- `src/core/`: adapter-neutral runner, fixture handling, selection, and assertions.
- `src/project/`: project inspection and harness scaffolding.
- `src/harness/`: capability taxonomy and model-profile policy.
- `src/fake-providers/openai-compatible.mjs`: adapter-neutral scripted OpenAI-compatible SSE provider for deterministic agent-runtime traces, including `/health`, `/models`, and `/v1/chat/completions`.
- `src/reporters/`: console and JSON reporters.
- `case-bank.schema.json`: portable JSON schema for case banks.
- `cases/lynn-backend-v1.json`: Lynn's first backend/CLI regression case bank.
- `cases/lynn-gates-v1.json`: unified CLI/GUI gate case bank that wraps existing deterministic and live gates.
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

`command_gate` runs one or more existing package/script gates as a case-bank operation. Use it to centralize CLI/GUI gates without deleting their standalone scripts: fast renderer contracts live in `smoke`, deterministic Electron/CLI gates in `release`, and real live GUI/CLI task gates in `nightly`.

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
npm run test:agent-regression:gates:smoke
npm run test:agent-regression:gates
npm run test:agent-regression:gates:nightly
```

The command writes a report under `/tmp/lynn-agent-regression/` by default.

## Capability Harness

The generated `agent-regression/capability-plan.json` gives each project a starting map:

- `turn.lifecycle`: prompt accepted, progress observable, turn closes once.
- `context.isolation`: retry/edit/next prompt do not leak stale metadata or text.
- `provider.contract`: model API injection and request tracing work.
- `tool.trajectory`: tool choice, args, result handoff, and final answer are assertable.
- `failure.recovery`: empty answer, timeout, malformed stream, and provider errors are bounded.
- `cli.surface`: headless prompt surface is parseable and bounded.
- `gui.surface`: browser/Electron user actions emit expected runtime payloads.
- `live.capability`: live model checks use structural outcomes, not exact prose.

This lets weak, strong, local, and live models share the same runtime contract harness. The model profile only changes the live assertion policy.

## Layering

- Layer 1: deterministic helper contracts, no model or server.
- Layer 2: native runtime trace with scripted OpenAI-compatible SSE provider.
- Layer 3: route/runtime shell traces through real Brain v2 router or `cli/bin/lynn.mjs` and the scripted provider.
- Layer 4: future live smoke, only structure invariants; never assert full model prose.
