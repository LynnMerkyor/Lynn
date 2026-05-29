# @lynn/cli

Terminal and worker-runner interface for Lynn v0.80.

This package is intentionally thin: provider keys and model routing stay in the
local Lynn server / Brain chain. The CLI handles terminal UX, worker JSONL, and
local file/shell orchestration.

## Quick start

```bash
Lynn version
Lynn doctor --offline
Lynn "summarize this repo"
Lynn -p "summarize this repo" --json
Lynn exec "review the current diff" --reasoning auto --show-reasoning auto
Lynn code "review the current diff"
Lynn chat
cat README.md | Lynn "summarize this file"
Lynn - < README.md
```

`Lynn` is the primary command. Lowercase `lynn` is kept as a compatibility
alias for scripts and terminal muscle memory.

## Worker mode

`Lynn worker run` is the stable adapter between Lynn GUI Fleet and coding CLIs.
It reads a task brief, emits Fleet JSONL events, and can wrap external agents.

```bash
Lynn worker run --brief task.md --worktree . --mock --jsonl
Lynn worker run --brief task.md --worktree . --agent codex-cli --jsonl
Lynn worker run --brief task.md --worktree . --agent claude-code --jsonl
Lynn worker run --brief task.md --worktree . --agent opencode --jsonl
Lynn worker run --brief task.md --worktree . --agent qwen-cli --jsonl
Lynn worker run --brief task.md --worktree . --agent kimi-cli --jsonl
```

For one-off adapters, pass `--agent-command`:

```bash
Lynn worker run --brief task.md --worktree . \
  --agent custom \
  --agent-command "node ./scripts/my-worker.mjs" \
  --jsonl
```

External workers receive `LYNN_WORKER_ID`, `LYNN_WORKER_AGENT`, and
`LYNN_NO_MODEL_DOWNLOADS=1`. Lines that already match Fleet JSONL are forwarded;
plain stdout/stderr lines are wrapped as `worker.progress` events.

Built-in worker adapters are non-interactive by default and receive the full
task brief with Lynn's guardrails prepended. The current templates are:

| Agent | Command shape |
| --- | --- |
| `codex-cli` | `codex exec --cd <worktree> --json --dangerously-bypass-approvals-and-sandbox <brief>` |
| `claude-code` | `claude -p <brief> --add-dir <worktree> --output-format stream-json --include-partial-messages --dangerously-skip-permissions` |
| `claude-internal` | `claude-internal -p <brief> --add-dir <worktree> --output-format stream-json --include-partial-messages --permission-mode bypassPermissions` |
| `qwen-cli` | `qwen -p <brief> --add-dir <worktree> --output-format stream-json --include-partial-messages --approval-mode yolo --yolo` |
| `kimi-cli` | `kimi --work-dir <worktree> --print --output-format stream-json --yolo --afk -p <brief>` |
| `opencode` | `opencode run --format json --cwd <worktree> <brief>` |

Fleet still validates claimed ownership, forbidden globs, and resulting diffs on
the Lynn side; worker CLI flags only prevent the external agent from stalling on
interactive approval prompts.
