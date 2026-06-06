# Lynn Harness Efficiency Gate - StepFun-first

Status: draft for v0.80.x efficiency work

## North star

The default interactive route stays StepFun 3.7 Flash cloud first. The goal is to make real Lynn tasks finish sooner in wall-clock time while preserving exhaustive search, adversarial verification, and corrective reruns.

This gate must not reward "shorter because less careful". It rewards less waiting, less idle serial work, and fewer repeated failed attempts.

## Non-goals

Do not optimize by:

- lowering `--max-steps` for coding tasks;
- disabling auto-verify, plan contract, checkpoint/resume, rewind, refuter, or adversarial validation;
- suppressing model retries that are needed to repair a wrong state;
- forcing short answers for tasks that ask for analysis, review, or an exhaustive solution;
- moving the default interactive route from StepFun cloud to local 9B/35B.

Local 9B/35B remains opt-in: offline, privacy-sensitive, batch, or fallback only.

## What "faster" means

Measure task-level wall-clock, not only decode TPS.

Required metrics per run:

- `wall_ms`: start to final terminal event;
- `ttft_ms`: start to first visible assistant delta;
- `first_tool_ms`: start to first tool start, when tools are used;
- `final_answer_ms`: start to final visible answer;
- `tool_steps`: total tool calls;
- `validation_steps`: typecheck/test/refuter/auto-verify steps;
- `repair_steps`: retries that corrected a failed state;
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

### 3. Parallelism where it is semantically safe

Allowed:

- independent read/search probes;
- background session summarization after the visible answer;
- independent verifier/refuter passes after a candidate solution exists.

Not allowed:

- parallel destructive writes to the same worktree;
- bypassing plan order when later steps depend on previous tool results;
- making the router answer on behalf of the model.

### 4. Early stop only at objective boundaries

Early stop is allowed only when the output format has a crisp completion condition:

- JSON/schema all required fields present;
- patch/diff generated and applied;
- verifier answer captured;
- a single required answer in an eval task.

Early stop is not allowed for open-ended architecture review, code review, long analysis, or "find the best solution" tasks unless an explicit verifier/refuter says enough evidence has been collected.

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

## Release rule

Do not ship an efficiency optimization if it improves wall-clock by making the agent less willing to verify, repair, or search for the best solution. Lynn's product promise is fast enough engineering discipline, not fast shallow answers.
