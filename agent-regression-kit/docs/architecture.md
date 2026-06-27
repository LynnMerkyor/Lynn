# Agent Regression Kit Architecture

Agent Regression Kit is a runtime contract test harness for AI agent applications. It is deliberately not a model-quality eval framework. The core package does not know about Lynn, Electron, WebSocket routes, tools, or provider registries. It knows only four things:

- A case bank describes operations, fixtures, and deterministic assertions.
- An adapter knows how to drive one agent runtime.
- Fake providers make model behavior deterministic.
- Reporters turn traces and assertions into CI artifacts.

## Package Shape

```text
agent-regression-kit/
  bin/ark.mjs                         # generic CLI
  src/index.mjs                       # public API
  src/core/runner.mjs                 # case selection and execution
  src/core/assertions.mjs             # deterministic assertion library
  src/core/fixtures.mjs               # temp fixture materialization
  src/adapters/loader.mjs             # dynamic adapter loading
  src/fake-providers/openai-compatible.mjs
  src/reporters/{console,json}.mjs
  adapters/lynn.mjs                   # Lynn is a consumer adapter, not core
  cases/*.json                        # Lynn-owned case banks
```

The current repository keeps `adapters/lynn.mjs` and `cases/lynn-*.json` beside the package so existing Lynn gates keep working. In an independent repository, those Lynn-specific files should move back into Lynn and import `@agent-regression/kit`.

## Adapter Contract

An adapter is a plain JavaScript object:

```js
export function createAdapter() {
  return {
    name: "my-agent",
    version: "1.0.0",
    async setup(ctx) {},
    async run(operation, input, ctx) {
      return { finalText: "ok", events: [] };
    },
    async cleanup(ctx) {},
  };
}
```

`run()` returns any JSON-serializable output. Assertions address it with dot paths such as `finalText`, `events[0].type`, or `provider.requests[1].body.model`.

## CLI

```bash
ark --adapter ./test/agent-adapter.mjs --case-bank ./agent-regression/cases.json --level release
```

Adapter modules may export `default`, `createAdapter`, `createXAdapter`, or `adapter`. A specific export can be selected with `--adapter ./adapter.mjs#createMyAdapter`.

## Layering

- `smoke`: pure helpers and cheap deterministic traces.
- `release`: real local runtime with fake providers.
- `nightly`: slow GUI, CLI, or live checks.

Live checks should assert structure only: non-empty output, event closure, tool calls, provider selection, no stale context, no crash. They should not assert full prose.

## Fake Providers

`startScriptedOpenAIProvider()` exposes `/health`, `/models`, and `/v1/chat/completions`. It records request bodies and can script content, reasoning chunks, tool calls, usage frames, delays, raw SSE, and HTTP errors.

This is the main bridge from model nondeterminism to software regression testing.
