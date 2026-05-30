# @lynn/cli

Terminal and worker-runner interface for Lynn v0.80.

This package is intentionally thin. When the Lynn client GUI is running, model routing uses
the local Lynn server / Brain chain and defaults to MiMo. When the client GUI is not
running, the CLI can fall back to a user-owned OpenAI-compatible BYOK endpoint.
The CLI handles terminal UX, worker JSONL, and local file/shell orchestration.

## Quick start

Install from the Lynn Tencent mirror:

```bash
npm install -g https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.80.0-alpha.0.tgz

# Rolling preview build for testers:
npm install -g https://download.merkyorlynn.com/downloads/cli/lynn-cli-latest.tgz
```

The package installs the `Lynn` command. If you installed an older preview that
also created a lowercase `lynn` shim, remove that old shim once or reinstall
with `--force`.

If npm dependency downloads are slow in mainland China, keep the Lynn tarball URL
as-is and add a registry mirror for third-party dependencies:

```bash
npm install -g https://download.merkyorlynn.com/downloads/cli/lynn-cli-latest.tgz \
  --registry=https://registry.npmmirror.com
```

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

`Lynn` is the primary command. The npm package intentionally avoids installing a
separate lowercase `lynn` binary because macOS default filesystems are
case-insensitive and npm cannot safely create both shims in the same prefix.

## CLI-only BYOK fallback

MiMo default routing is provided by the local Lynn client GUI / Brain server. A
standalone npm install cannot ship Lynn's server-side keys. For CLI-only use,
configure your own OpenAI-compatible endpoint:

```bash
Lynn providers set
```

The interactive setup asks for three standard OpenAI-compatible fields:

1. API URL - copy the base URL from your provider docs. It usually ends with
   `/v1`, for example `https://api.openai.com/v1`.
2. API Key - create or copy it from your provider console.
3. Model name - copy the exact model id from the provider's model list.

For scripts, pass the same fields as flags:

```bash
Lynn providers set \
  --base-url https://api.example.com/v1 \
  --api-key <api-key> \
  --model model-id
```

Common presets fill the API URL and model name while still requiring your own
key:

```bash
Lynn providers set --preset mimo --api-key <token-plan-key>
Lynn providers set --preset stepfun --api-key <stepfun-key>
Lynn providers presets
```

The profile is stored in `~/.lynn/providers/cli.json` with the key redacted in
terminal output. `Lynn -p`, `Lynn chat`, `Lynn code`, and built-in Lynn workers
try the local Brain first; if it is offline, they use this BYOK provider.

For full MiMo default routing, web search, GUI Fleet, and provider management,
install and open the Lynn client GUI.

## Worker mode

`Lynn worker run` is the stable adapter between Lynn client GUI Fleet and coding CLIs.
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

## Code tools

`Lynn code --tool bash` and `write_file` require `--approval yolo`. Bash commands
default to a 120 second timeout and cap captured stdout/stderr to keep stuck
commands from blocking Fleet workers:

```bash
Lynn code --tool bash --command "npm test" --approval yolo --timeout-ms 300000 --json
```
