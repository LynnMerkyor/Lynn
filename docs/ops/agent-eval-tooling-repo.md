# Agent Eval and Tooling Repository Plan

This document defines the split boundary for the standalone agent evaluation and regression tooling repo. Lynn keeps the app, CLI, Brain routes, and product-specific adapter. The new repo should hold the reusable harness, model-eval utilities, public case banks, and report tooling.

## Target

Create a separate repository under `LynnMerkyor`, recommended name: `agent-regression-kit`.

Keep Coding100, Agent20, and the automated Agent runtime regression tests in one repository. They should be separated by lane and schema, not by Git repository, because they share the same runner, adapter API, fake provider, model injection, timeout/retry envelope, report format, and result archive.

The repo should be usable against any agent project from a local directory, GitHub checkout, or Gitee checkout. A user provides:

- project directory or repository URL
- OpenAI-compatible model API endpoint, model id, and API key env name
- optional adapter hints for CLI, GUI, HTTP, or Electron surfaces

The harness then builds a project-specific regression layer: deterministic provider tests first, live model checks later, and reports that identify runtime-contract failures separately from model-capability failures.

## What Moves Out

- `agent-regression-kit/src/`: reusable runner, assertions, fixtures, project inspection, reporters, fake providers, and CLI.
- `agent-regression-kit/bin/ark.mjs`: standalone command entry.
- `agent-regression-kit/case-bank.schema.json`: public portable schema.
- `agent-regression-kit/examples/`: minimal adapter and case bank.
- Generic benchmark harnesses and model utilities from `tests/benchmarks/`.
- Public, scrubbed versions of Coding100 and Agent20 case banks.

## What Stays In Lynn

- `agent-regression-kit/adapters/lynn.mjs` until the external package has a stable plugin API.
- Lynn-specific case banks that depend on private Brain behavior or local product paths.
- Release gate wiring in `package.json`.
- Product regression results and release reports.

Once the external repo is stable, Lynn should depend on it as a package and keep only:

```text
agent-regression/
  adapter.mjs
  cases/
    lynn-backend-v1.json
    lynn-gates-v1.json
```

## Suggested Repo Layout

```text
agent-regression-kit/
  README.md
  package.json
  bin/
    ark.mjs
  packages/
    core/
    fake-providers/
    project-inspector/
    reporters/
    model-tools/
    execution-sandbox/
  case-banks/
    runtime-contracts/
    coding100/
    agent20/
    tool-abstain/
  adapters/
    examples/
    lynn/
  reports/
    examples/
  docs/
    schema.md
    adapter-api.md
    live-model-policy.md
```

## One Repo, Three Lanes

Use one repository with three explicit lanes:

- `runtime-regression`: deterministic Agent runtime contracts. This is the release-gate lane for stale context, retry pollution, tool-call trajectory, evidence handoff, empty-answer fallback, GUI/CLI surface contracts, and provider protocol drift.
- `model-eval`: live model capability suites such as Coding100 and Agent20. This lane measures pass rate, execution failure, timeout, token usage, reasoning budget, latency, and TPS. It should not block product releases unless explicitly promoted to a gate.
- `bench-reports`: reproducible result storage and report rendering. This lane keeps scrubbed JSON, markdown summaries, charts, and model comparison tables.

Do not split into separate repos until one of these becomes true:

- public dataset licensing requires different distribution terms
- result artifacts become too large and need Git LFS or a dataset hub
- the runner package needs independent npm release governance
- a third-party project wants only the harness without Lynn's case banks

## Case-Bank Policy

- `runtime-contracts`: deterministic agent runtime behavior, no live credentials.
- `coding100`: code-generation and tool-execution cases, with expected execution/verifier contracts.
- `agent20`: compact agentic coding/tool-use suite for latency, timeout, execution failure, empty-answer, and final-answer checks.
- `tool-abstain`: cases for when an agent should not call tools or should refuse unsupported tool paths.

Every case should declare:

- capability family
- required surface: CLI, HTTP, GUI, Electron, or adapter-native
- deterministic provider script or live model policy
- assertions over traces, tool calls, files, command results, and final answer visibility
- scrub rules for secrets, bearer tokens, signatures, and local paths

## Model Tools

The first model-tool package should include:

- OpenAI-compatible batch runner
- timeout and retry envelope
- token/reasoning budget tracking
- execution verifier for generated Python/JavaScript
- report merger for model, route, latency, tokens, TPS, pass rate, timeout rate, and execution-failure rate

This covers the current Coding100 and Agent20 workflow without tying it to Lynn internals.

## Hub Linking

GitHub, HuggingFace, and ModelScope should point to each other through cards and README links:

- Lynn GitHub README links to HuggingFace and ModelScope model cards.
- HuggingFace model cards include `Source`, `Harness`, and `Benchmarks` links back to GitHub.
- ModelScope model cards include the same source/harness links in the README.
- Benchmark dataset cards can link to the standalone `agent-regression-kit` repo instead of the Lynn app repo.

Recommended model-card block:

```markdown
## Source, Harness, and Benchmarks

- Source app: https://github.com/LynnMerkyor/Lynn
- Agent regression harness: https://github.com/LynnMerkyor/agent-regression-kit
- ModelScope mirror: https://modelscope.cn/models/Merkyor/Qwen3.6-35B-A3B-DSV4Pro-Thinking-Distill
- HuggingFace mirror: https://huggingface.co/nerkyor/Qwen3.6-35B-A3B-DSV4Pro-Thinking-Distill
```

## Release Order

1. Keep the current bundled kit green inside Lynn.
2. Create `LynnMerkyor/agent-regression-kit`.
3. Copy the generic kit and scrub project-specific assumptions.
4. Move Coding100 and Agent20 into public case-bank format.
5. Publish `ark` as the standalone CLI entry.
6. Make Lynn consume the external kit while preserving local release gates.
