# Lynn v0.82.0 Dual-Brain Iteration Plan

Status: active iteration plan
Owner split: Codex drives product architecture / routing / Fleet / CLI; Claude runs Spark MTP gate in parallel.

## Objective

Ship Lynn v0.82.0 as a dual-brain product release:

- **Manager:** local distilled Qwen3.6-35B-A3B on Spark.
- **Worker:** cloud `step-3.7-flash` for coding and execution.
- **Escape:** `DS-V4 Flash` for hard failures and high-risk tasks.

QoS rule: the local A3B manager is a single-slot resource. GUI interactive work wins that slot. CLI/background work must skip local A3B when the endpoint is loading, occupied, or already generating, and continue through StepFun/DS-V4 Flash instead of slowing the foreground user.

The release goal is not higher raw decode TPS. The goal is shorter successful task wall-clock, lower false-verify risk, and a visible manager-worker-harness loop in GUI and CLI.

## Non-Goals

- Do not block v0.82.0 on MTP, DFlash, TRT-LLM, or private kernels.
- Do not make 9B the manager; 9B distilled thinking is a quality rescue, not a reliable orchestrator.
- Do not trust model self-reported completion.
- Do not put GLM into the high-concurrency Fleet worker pool while its concurrency cap is 2.
- Do not make DS-V4 Pro the default escape route for this release; the fixed route is `A3B -> step37 -> DS-V4 Flash`.

## Release Lanes

| lane | owner | deliverable | gate |
|---|---|---|---|
| A. Manager route | Codex | local A3B manager profile, routing metadata, health/availability semantics | route smoke passes or fails closed to step37 |
| B. Worker route | Codex | step37 Fleet worker profile, JSONL event contract reuse | worker mock + one real coding smoke |
| C. Harness acceptance | Codex | objective verification schema and escalation rules | false-verify fixture must fail closed |
| D. GUI Fleet | Codex | manager task tree + worker cards + validation lights | UI smoke with mock event stream |
| E. CLI lights-out | Codex | A3B delegate loop + worker invocation + JSONL terminal result | headless mock + one small coding fixture |
| F. MTP optional | Claude | distilled A3B MTP correctness / quality report | enable only if token-exact or quality loss <=5%; otherwise disabled |

## Routing Contract

Default order:

```text
local-a3b-manager -> step-3.7-flash-worker -> ds-v4-flash-escape
```

The manager may complete locally only for planning, routing, read-only judgment, compression, and verification-summary tasks. Coding or file-changing tasks are delegated unless the task is explicitly local-only and low risk.

Local manager availability:

- `local-a3b-manager` concurrency limit is 1.
- If llama.cpp `/slots` reports busy >= 1, Brain skips Spark and preserves the fallback chain.
- If GUI interactive work is active, CLI/background manager work stays on StepFun even when Spark is technically idle.
- If the local endpoint is loading, occupied by another model, or not ready, the CLI must not wait on it.

Escalate to DS-V4 Flash when any of these are true:

- harness fail reaches 2 attempts with different failure causes;
- the same worker needs more than 2 repair rounds;
- task class is high risk: concurrency, permissions, data migration, security-sensitive changes, or irreversible file operations;
- manager cannot cite objective evidence for its acceptance decision;
- worker output cannot be reduced to file changes, command results, tests, or other machine-checkable evidence.

## MTP Boundary

MTP is optional for v0.82.0:

- If Claude reports quality loss above 5%, MTP is disabled.
- If MTP is non-token-exact but quality loss is <=5%, it can only be an explicit experimental profile, not the default manager route.
- If MTP is token-exact / harness-exact and materially improves manager wall-clock, it may become an opt-in speed profile.
- Product docs must describe manager speed as 77 tok/s baseline unless the gate passes.

## Acceptance Schema

Every delegated task must produce machine-readable evidence:

```json
{
  "taskId": "string",
  "managerModel": "local-a3b-distill",
  "workerModel": "step-3.7-flash",
  "escapeModel": "ds-v4-flash",
  "status": "passed|failed|escalated",
  "objectiveEvidence": [
    {"kind": "test", "ok": true, "summary": "npm test passed"},
    {"kind": "diff", "ok": true, "summary": "2 files changed within owned scope"}
  ],
  "falseVerifyRisk": "none|suspected|confirmed",
  "escalationReason": null
}
```

The final user-visible completion state must be derived from `objectiveEvidence`, not from a model's final sentence.

## GUI Fleet Scope

v0.82.0 GUI Fleet needs four visible surfaces:

- manager plan/task tree;
- worker cards with agent, status, stream, and current command/test;
- validation lights: pending / passed / failed / escalated;
- escalation badge when DS-V4 Flash is used.

It does not need a full new visual system. Reuse existing Fleet worker JSONL and add manager-level grouping.

## CLI Scope

v0.82.0 CLI lights-out mode needs:

- a manager invocation profile for local A3B;
- a `delegate` action that emits worker brief files;
- worker JSONL consumption through the existing Fleet contract;
- terminal JSONL with `manager.started`, `manager.delegated`, `manager.validation`, `manager.finished`.

The CLI may start with mock/local fixtures before real model traffic.

## Gate Tests

Stop implementation and run gates when these files are wired:

- manager route resolver fixture; **wired in `shared/dual-brain-route.ts`**
- local A3B single-slot busy guard; **wired in `brain-v2-mirror/router.ts`**
- worker profile resolver fixture; **route constants wired, live worker resolver remains next**
- acceptance schema validator fixture; **wired in `shared/dual-brain-route.ts`**
- false-verify fail-closed fixture; **covered by `shared/__tests__/dual-brain-route.test.ts`**
- manager JSONL event fixture; **covered by `shared/__tests__/fleet-events.test.ts`**
- GUI mock event-stream fixture; **covered by Fleet reducer manager-event test**
- CLI mock delegate fixture; **next implementation boundary**

Minimum commands to run at the gate:

```bash
npm test -- --runInBand
npm run typecheck
npm run release:cli-efficiency
```

If the repo does not currently expose one of these scripts, record the missing script as a gate gap rather than inventing a silent pass.

## Immediate Order

1. Fix architecture docs to lock `A3B -> step37 -> DS-V4 Flash`.
2. Add route/profile constants and schema names. **Done.**
3. Add acceptance schema validator. **Done.**
4. Add manager JSONL event types. **Done.**
5. Wire GUI mock event stream. **First reducer support done; full visual surface next.**
6. Wire CLI mock delegate loop. **QoS guard done; delegate loop remains next boundary.**
7. Stop at gate tests.
