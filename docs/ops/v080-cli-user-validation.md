# Lynn CLI v0.80 User Validation Plan

Date: 2026-05-29

This is the user-facing validation plan for the v0.80 CLI track. The goal is not to prove every future Fleet feature; it is to make sure a tester can install, launch, understand, and recover from the CLI without reading source code.

## Scope

The v0.80 CLI is a companion to the Lynn GUI:

- `Lynn` / `Lynn -p` for direct prompts through the local Brain router.
- `Lynn code` for local coding tasks and tool use.
- `Lynn see`, `Lynn ground`, and `Lynn ui2code` for MiMo vision workflows.
- `Lynn worker run --jsonl` as the worker protocol that GUI Fleet can spawn.

Current default model route:

- Model: MiMo through the local Brain router.
- Brain URL: `http://127.0.0.1:8790`.
- BYOK setup: Lynn GUI > Settings > Providers, plus future CLI helper commands.

Current pricing posture:

- v0.80 alpha validation can be treated as free use for testers.
- The CLI must still be designed for future BYOK and quota windows: provider source, Brain URL, and mock/offline mode must always be visible.

## Tester Install

For source testers:

```bash
cd /private/tmp/lynn-v080-cli-core
npm --prefix cli install
npm --prefix cli run build
```

If the terminal command was just linked or updated:

```bash
rehash
```

Expected:

```bash
Lynn version
```

prints `@lynn/cli 0.80.0-alpha.0`.

## Tier 0: Offline Smoke

These commands must work without the GUI and without any provider key:

```bash
Lynn version
Lynn doctor --offline
Lynn -p "你好" --mock-brain
Lynn code --list-tools
Lynn code "review the current diff" --mock-brain
Lynn worker run --brief /private/tmp/lynn-v080-cli-core/cli/fixtures/worker-brief.md --worktree /private/tmp/lynn-v080-cli-core --mock --jsonl
```

Vision smoke:

```bash
printf '\x89PNG\r\n\x1a\n' > /tmp/lynn-cli-smoke.png
Lynn see /tmp/lynn-cli-smoke.png "describe this UI" --mock-brain
Lynn ground /tmp/lynn-cli-smoke.png "Submit button" --mock-brain --json
Lynn ui2code /tmp/lynn-cli-smoke.png --mock-brain
```

Expected:

- No command requires network.
- `Lynn code` lists `read_file`, `grep`, `glob`, `apply_patch`, `bash`, and `write_file`.
- Worker JSONL contains `worker.started`, `worker.claims`, `test.finished`, `git.diff`, and `worker.finished`.
- Vision commands print `Mock Lynn see`, `vision.started`, or `Mock Lynn ui2code`.

## Tier 1: Brain Offline Recovery

With the GUI closed:

```bash
Lynn -p "你好"
Lynn code
```

Expected:

- The command must not dump a stack trace.
- It should say Brain is offline and tell the user to start Lynn GUI or use `--mock-brain`.
- `Lynn code` should keep a clean prompt and remain exit-able with `/exit` or Ctrl-D.

## Tier 2: GUI Online Route

Start the Lynn GUI, wait until the local Brain router is running, then:

```bash
Lynn doctor
Lynn -p "你好"
Lynn providers
Lynn code
```

Expected:

- `doctor` reports Brain reachable.
- `-p` returns content from the Brain route.
- The visible model route should be MiMo by default unless changed in GUI settings.
- `providers` must not print raw provider keys.

## Tier 3: MiMo CLI Differentiators

Use a real screenshot or mockup:

```bash
Lynn see ~/Desktop/screenshot.png "what is wrong with this UI?"
Lynn ground ~/Desktop/screenshot.png "the login button" --json
Lynn ui2code ~/Desktop/mockup.png "implement this as React"
```

Expected:

- `see` returns a UI-aware description, not generic image alt text.
- `ground --json` starts with a machine-readable coordinate object or a clear refusal if the model cannot localize.
- `ui2code` produces an implementation plan with component boundaries, layout, states, and accessibility notes.

## Tier 4: Coding Mode

Run:

```bash
Lynn code
```

Manual checks:

- Startup should look like a clean Codex-style terminal card, not a command dump.
- No left-side decorative `>` title marker in the card.
- `/fast` toggles quick MiMo mode.
- `/think` toggles deeper reasoning.
- `/mode yolo` shows a strong local-permission warning.
- Shift+Tab cycles permission mode.
- Tool calls must respect sandbox mode.

Destructive or write-capable behavior must be tested only in a temporary worktree.

## Permission Interop: GUI And CLI

The CLI and GUI must eventually share one permission model. The GUI is the visual authority; the CLI is a local execution surface that can temporarily override the active mode for one command.

Permission changes, tool guardrails, cacheable context, and Fleet locks must be represented as Lynn runtime instruction frames, not raw provider-specific `role: "system"` messages. See `shared/runtime-instruction-frames.ts`.

### Canonical Permission Levels

| User-facing mode | CLI flag | Local file writes | Shell commands | Intended use |
|---|---|---:|---:|---|
| Ask | `--approval ask` | Prompt first | Prompt first | New users and unknown repos |
| On failure | `--approval on-failure` | Allowed in workspace | Retry prompts on failure | Routine edits |
| Never ask | `--approval never` | Allowed in workspace | Allowed in workspace | Trusted automation |
| YOLO | `--approval yolo --sandbox danger-full-access` | Full local power | Full local power | Explicit expert mode only |

Sandbox levels:

| Sandbox | CLI flag | Meaning |
|---|---|---|
| Read only | `--sandbox read-only` | No writes, no mutating tools |
| Workspace write | `--sandbox workspace-write` | Writes only inside current workspace/worktree |
| Full access | `--sandbox danger-full-access` | No path sandbox; must show strong warning |

### Interop Rules

- GUI Settings stores the default permission profile for the current user.
- CLI loads the same profile from the Lynn data directory when no explicit flag is passed.
- CLI flags override the profile for that process only.
- CLI and GUI changes produce runtime instruction frames such as `permission_state`, `runtime_policy`, or `tool_guard`.
- GUI Fleet workers inherit the GUI profile unless the dispatch form explicitly changes it.
- Worker JSONL must include the effective permission mode in `worker.claims` or an equivalent startup event.
- Server-side Fleet must re-check forbidden globs and center-file locks even if a worker claims it behaved.
- Provider API keys and paid-search keys never move from GUI/Brain into the CLI process.

### First-run Permission Verification

For a new user, the first successful CLI setup should prove four things:

```bash
Lynn permissions
Lynn code --tool write_file --path /tmp/lynn-permission-test.txt --text ok --sandbox read-only --approval yolo --json
Lynn code --tool write_file --path /tmp/lynn-permission-test.txt --text ok --sandbox workspace-write --approval yolo --json
Lynn code
```

Expected:

- `Lynn permissions` shows the effective profile, its source, and whether it came from GUI settings, env, or CLI defaults.
- Read-only mode blocks `write_file`.
- Workspace-write mode allows writes only inside the selected cwd/worktree.
- `/mode yolo` in interactive mode shows a red, explicit warning before enabling full local power.

### GUI Verification

In the GUI:

- Settings > Permissions must show the same default profile that `Lynn permissions` reports.
- Fleet Dispatch must show the effective mode before launching a worker.
- Worker cards must surface permission-sensitive events: writes, shell commands, denied actions, forbidden files, and center locks.
- Cancel/retry must not silently escalate permissions.

### Future Implementation Checklist

- Add `Lynn permissions` to read and print the effective permission profile.
- Add a shared permission profile type under `shared/`.
- Serialize runtime instruction frames per provider capability; never assume mid-conversation `role: "system"` works outside opted-in Anthropic adapters.
- Store GUI defaults in the Lynn data directory, not only localStorage.
- Make CLI, GUI Fleet, and server Fleet resolve permissions through one helper.
- Add release-gate tests for read-only denial, workspace write allow, and YOLO warning text.

## Tier 5: GUI Fleet Integration

Once Fleet is integrated:

```bash
Lynn worker run --brief task.md --worktree /path/to/worktree --jsonl
```

Expected:

- GUI Workers panel can play the JSONL stream.
- Claims, tests, changed files, forbidden files, and status transitions render without a page refresh.
- Cancel/retry controls affect only the selected worker.
- No worker may write outside its declared worktree.

## Automated Gate

Release gate must include:

```bash
npm run build:cli
npm --prefix cli run typecheck
npm --prefix cli test -- --run
npm run test:cli
npm run release:gate -- --quick --no-build --no-ui
```

`scripts/cli-smoke.mjs` is the canonical automated smoke test. It should keep growing whenever a new CLI surface becomes user-visible.

## Future BYOK And Quota Plan

Current alpha can be free for validation, but the CLI must preserve the following windows:

- `Lynn providers` lists configured provider status without printing secrets.
- CLI supports `--brain-url` so advanced users can point to a compatible router.
- GUI remains the first BYOK setup surface.
- A later CLI command can open or print setup guidance for provider keys.
- Quota-sensitive modes should be explicit: fast mode, thinking mode, vision mode, and worker mode.

## Acceptance Bar

v0.80 CLI is acceptable only when:

- A fresh user can run `Lynn`, understand the default model route, and recover from Brain offline.
- Mock mode works without network.
- GUI online mode works through local Brain.
- CLI and GUI have a documented permission model, and CLI read-only/workspace-write checks are tested.
- Coding mode has read/grep/glob/apply_patch/bash/write_file with permission controls.
- MiMo vision has at least one working image path workflow.
- Worker JSONL can be consumed by GUI Fleet.
- CLI smoke is part of release gate.
