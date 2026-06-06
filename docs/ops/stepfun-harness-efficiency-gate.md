# Lynn Harness Efficiency Gate - StepFun-first

Status: draft for v0.80.x efficiency work

## North star

The default interactive route stays StepFun 3.7 Flash cloud first. The goal is to make real Lynn tasks spend less time waiting or repeating unproductive work while preserving exhaustive search, adversarial verification, and corrective reruns.

This gate must not reward "shorter because less careful". It rewards less waiting, less idle serial work, and fewer repeated failed attempts. It must not reward shorter generations, fewer repair attempts, or fewer verification passes when those steps are needed to reach the best solution.

## Non-goals

Do not optimize by:

- lowering `--max-steps` for coding tasks;
- disabling auto-verify, plan contract, checkpoint/resume, rewind, refuter, or adversarial validation;
- suppressing model retries that are needed to repair a wrong state;
- forcing short answers for tasks that ask for analysis, review, or an exhaustive solution;
- moving the default interactive route from StepFun cloud to local 9B/35B.

Local 9B/35B remains opt-in: offline, privacy-sensitive, batch, or fallback only.

## Route availability gate

Before using a local 9B/35B route in the default path, prove that it is actually reachable and warm on the user's machine. A distilled A3B planner can be useful, but it is not a required dependency for the default interactive CLI path.

Run the route smoke when changing router priority, local-model service setup, or Spark tunnel assumptions:

```bash
npm run bench:cli-routes
```

This runs real `Lynn -p --json` turns through the product default StepFun path and probes the local Spark OpenAI-compatible endpoint. Spark failures are recorded as availability evidence, not as a script failure, unless `--require-spark` is set:

```bash
node scripts/cli-route-latency-smoke.mjs --require-spark
```

Interpretation:

- StepFun success with low TTFT means the cloud route can carry the default interactive path.
- Spark unavailable means local A3B/35B must stay opt-in/offline/batch/fallback for that environment.
- Spark reachable and warm can justify local opt-in workflows, background critic/compression, or privacy-sensitive work, but should not add a new failure point to the default interactive path.

The release default should remain StepFun-first unless the route smoke proves the local route is both reachable and materially better for a specific task class without reducing success, validation, or repair coverage.

## What "faster" means

Measure task-level wall-clock, not only decode TPS.

Primary objective:

- `success_per_hour`: passed tasks divided by total wall-clock hours.

This is the main product metric. Optimizing tokens/second alone can make the harness skip verification and return faster wrong answers. Optimizing `success_per_hour` keeps verification in the objective function: a cheap verifier, a useful repair pass, or an adversarial check is good when it increases successful completed work per hour.

Required metrics per run:

- `wall_ms`: start to final terminal event;
- `ttft_ms`: start to first visible assistant delta;
- `first_tool_ms`: start to first tool start, when tools are used;
- `final_answer_ms`: start to final visible answer;
- `tool_steps`: total tool calls;
- `validation_steps`: typecheck/test/refuter/auto-verify steps;
- `repair_steps`: retries that corrected a failed state; these are valid quality work, not waste;
- `waste_steps`: denied duplicate commands, repeated failed commands with same fingerprint, empty answers, or known no-op tool calls;
- `max_steps_reached`: whether the task exhausted the loop;
- `success`: task-specific verifier result;
- `quality_notes`: verifier/refuter summary, not model self-assessment.

Useful extra metrics:

- rolling decode TPS;
- prefix-cache hit ratio;
- prompt/input/output token counts;
- server route and fallback route;
- number of user approvals required.

## What can be optimized

### 1. Less waiting

- Keep StepFun cloud as the hot default route.
- Avoid cold local-model startup in the default path.
- Prefer streaming UI immediately; do not wait for whole responses.
- Prioritize interactive user turns over background summarization/indexing.

### 2. Stable prefix / prefix cache

- Keep runtime knowledge, tool schema, style contract, and stable frames ordered consistently.
- Do not churn stable prefix with per-turn volatile content.
- Track prefix-cache as a rolling UI metric, but do not create context anxiety.

Expected win: shorter TTFT/prefill for repeated sessions, especially tool-heavy code tasks.

Pure wins that do not reduce correctness, such as prefix-cache reuse and hot cloud routing, can be used aggressively. They reduce waiting rather than thinking.

### 3. Parallelism where it is semantically safe

Allowed:

- independent read/search probes;
- background session summarization after the visible answer;
- independent verifier/refuter passes after a candidate solution exists.

Not allowed:

- parallel destructive writes to the same worktree;
- bypassing plan order when later steps depend on previous tool results;
- making the router answer on behalf of the model.

### 4. Boundary stop only at objective boundaries

Boundary stop is allowed only when the output format has a crisp completion condition:

- JSON/schema all required fields present;
- patch/diff generated and applied;
- verifier answer captured;
- a single required answer in an eval task.

Boundary stop is not allowed for open-ended architecture review, code review, long analysis, or "find the best solution" tasks unless an explicit verifier/refuter says enough evidence has been collected. It is a parser/format boundary, not a quality shortcut.

Boundary stop trims generation tail, not validation. A coding task still cannot be declared complete until the deterministic verifier or auto-verify has passed.

### 5. Fewer wasted retries, not fewer valid repairs

Do reduce:

- repeated identical denied shell commands;
- repeated broad scans such as `find /` or `glob **/*` outside a workspace;
- retry loops after the same tool error without changing parameters;
- empty-visible-answer retries caused by hidden reasoning only.

Do not reduce:

- a repair pass after a failing test;
- a refuter/adversarial pass;
- a second implementation attempt after verification proves the first wrong;
- additional targeted reads needed to make a final judgment.

The preferred optimization is to make verification cheaper:

- reuse stable-prefix and prompt-cache across repair reruns;
- run deterministic auto-verify before asking a model to judge;
- gate adversarial model verification by uncertainty and task risk, not by a blanket "always off";
- parallelize only independent probes and independent verifiers; preserve `verify -> fix -> rerun` dependencies.

## Gate task set

The gate should include both fast-path tasks and exhaustive tasks.

### A. Fast interactive

Purpose: TTFT and perceived responsiveness.

- Ask for current CLI version/runtime knowledge.
- Ask a short technical explanation.
- Ask a small web/search question with citations.

Success: visible answer, no hidden-only result, no unnecessary tool storm.

### B. Local read-only tool task

Purpose: avoid "cannot list/read" regressions.

- `pwd`/`ls` equivalent request in chat.
- read a small README section under `--cwd`.

Success: uses local shortcuts or approved safe read-only tools; no whole-disk scan.

### C. Search with sources

Purpose: source traceability.

- query a live topic;
- show compressed tool summary and source details link/card.

Success: at least one cited source or explicit "no usable source"; no source-less factual claim.

### D. Small coding fix

Purpose: code path speed without weakening verification.

- one-file bug fix;
- verifier must pass.

Success: edit + test/typecheck; no final answer before verification.

### E. Cross-file refactor

Purpose: StepFun chain/tool robustness.

- rename field/signature across multiple files;
- include a point-free callback or equivalent trap.

Success: typecheck/test pass; refuter/auto-verify runs; repairs are counted as valid if they converge.

### F. Exhaustive/ultra review

Purpose: do not over-optimize away deep work.

- architecture review or "find best solution";
- allow sufficient reads/searches/refuter passes.

Success: quality rubric wins over shortest time. Measure wall-clock, but do not fail simply for spending time on useful evidence.

## Acceptance criteria

For fast interactive tasks:

- p50 wall-clock improves by at least 20% over baseline, or TTFT improves by at least 25%;
- no success-rate regression;
- no increase in empty-visible-answer failures.

For coding/refactor tasks:

- success rate must remain >= baseline;
- verification/refuter steps must remain present;
- p95 wall-clock should not regress by more than 15% unless quality improves and the report explains why.

For exhaustive tasks:

- success/quality rubric is primary;
- efficiency win is fewer waste steps and fewer repeated failed commands, not less analysis.
- the gate should allow more tool calls, more verification, or more repair when those steps expand coverage or improve the answer.

## Baseline and experiment matrix

Baseline:

- current StepFun cloud route;
- high reasoning;
- existing tool harness;
- local models disabled unless explicitly requested.

Experiment flags:

- `prefix-cache-stable`: stable frame order + cache telemetry checked;
- `interactive-priority`: background work does not block visible answer;
- `schema-stop`: only for schema/eval tasks;
- `parallel-read-probes`: independent read/search probes only;
- `waste-loop-guard`: repeated denied/error tool fingerprints are halted earlier.

Every experiment must report:

- task success;
- wall-clock deltas;
- quality notes;
- which guardrails stayed enabled.

Use the compare mode to gate experiments:

```bash
node scripts/cli-efficiency-gate.mjs --compare \
  --baseline output/baseline.json \
  --experiment output/experiment.json
```

The comparison fails if an experiment:

- lowers success rate;
- increases failed tasks, waste steps, or max-step hits;
- removes validation work from coding/refactor tasks;
- misses tasks present in the baseline.

For prefix-cache and TTFT work, use repeated runs rather than a single sample:

```bash
npm run build:cli
LYNN_EFFICIENCY_LIVE=1 node scripts/cli-efficiency-gate.mjs \
  --suite smoke \
  --repeat 3 \
  --label stepfun-cache-warmup \
  --out output/stepfun-cache-warmup.json
```

Repeated runs keep a unique run id (`task#1`, `task#2`, ...) while preserving the base `taskId`, so reports can show both per-run variance and per-task warming. Compare baseline and experiment with the same repeat count; a speedup only counts if success rate and validation coverage stay intact.

The report summary includes `taskStats[]` for repeated runs. For each base task it records:

- per-task success rate and `successPerHour`;
- p50/p90 wall-clock and TTFT;
- total validation, waste, prompt, and prefix-cache hit tokens;
- first-run and last-run snapshots;
- `cacheHitTokensDelta`, `wallMsDelta`, and `ttftMsDelta` from first to last run.

Use these per-task fields to distinguish a real prefix-cache win from noise. A useful StepFun-first optimization should make repeated runs warmer or less variable without reducing task success or validation coverage.

Compare mode also prints per-task deltas. Read this table before accepting a speed claim:

- `p50Wall` and `p50TTFT` show where the time moved;
- `cache` shows whether prefix-cache changes helped the task type that should benefit;
- `validation` and `waste` show whether speed came from better harness behavior or from accidentally removing quality work.

The per-task table is attribution, not a shortcut. A task getting faster is useful only when success and validation stay intact.

Add `--require-speedup` only when an experiment is explicitly meant to prove a speed win. Without that flag, compare mode is a quality regression gate: it allows neutral speed results but blocks shallow speedups.

## Release rule

Do not ship an efficiency optimization if it improves wall-clock by making the agent less willing to verify, repair, rerun a failed attempt, or search for the best solution. Lynn's product promise is fast enough engineering discipline, not fast shallow answers.
