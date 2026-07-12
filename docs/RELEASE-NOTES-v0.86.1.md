# Lynn v0.86.1

V0.86.1 completes the GUI and CLI interaction pass built on the V0.86 security baseline.

## Highlights

- Ink Ctrl+C now cancels the active turn without exiting the REPL. The PTY gate runs the full Ink renderer, requires cancellation within one second, continues with another prompt, and verifies a clean `/exit`.
- CLI history is persistent, streaming Markdown is batched, tool start/result events update one row, and the input line supports a visible movable cursor.
- The default local Qwen3.6-27B Coding Q4 imatrix MTP download reports aggregate shard progress, transfer rate, and ETA, with pause, resume, cancel, and delete controls.
- Local-model recommendations can be snoozed for seven days or dismissed permanently. Low-spec devices are still not proactively prompted.
- Session search is always visible, long conversations expose a jump-to-latest action, and low-frequency composer controls move under a keyboard-dismissible More menu.
- User-visible errors are translated from internal transport/runtime codes into actionable explanations. Warm Paper and Midnight secondary text contrast is stronger.
- High-stakes and current-fact answers use bounded heterogeneous review: DS V4 Flash reviews first in the background, and only a `concerns` or `blocker` verdict can invoke one 15-second MiMo 2.5 Pro Token Plan arbitration. MiMo timeout keeps the DS V4 result; review never blocks or automatically rewrites the original answer.
- V0.86 browser permissions, OS sandboxing, IPC/SSRF guards, local-server authentication, per-session admission, tool cancellation, and cross-turn isolation remain enabled.

## Install

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.86.1.tgz"
Lynn --version
```

Desktop installers are available from the [download mirror](https://download.merkyorlynn.com/download.html) and [GitHub Releases](https://github.com/LynnMerkyor/Lynn/releases/tag/v0.86.1).

## Release Verification

The candidate must pass typecheck, runtime typecheck, unit/integration suites, Agent regression, Brain mirror/prod parity, full Ink and safe-terminal PTY smokes, CLI100, GUI100, packaged app checks, macOS signing/notarization/stapling/Gatekeeper verification, Windows packaging, and three-remote synchronization.

The same commit and release notes are published to:

- `github.com/LynnMerkyor/Lynn`
- `github.com/MerkyorLynn/Lynn`
- `gitee.com/merkyor/Lynn`
- `download.merkyorlynn.com`
