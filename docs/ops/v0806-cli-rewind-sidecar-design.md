# Lynn CLI rewind design: sidecar snapshots only

## Why git checkpoints are not acceptable

Whole-tree git checkpoints are unsafe for Lynn CLI long tasks.

- They hash and store every dirty file, including unrelated large binaries such as exe/pdf artifacts.
- They can make `.git/objects` grow quickly in repositories with generated assets.
- Restoring with a whole-tree checkout can roll back files that Lynn never edited, including files another process is still updating.

Rewind must never mean "restore the entire working tree". It should mean "restore the files Lynn actually touched".

## Principle

For every tool write, snapshot only the preimage of the target file before Lynn edits it.

This mirrors the desktop Brain edit rollback model:

1. A write-like tool is about to edit `path`.
2. Lynn records the preimage of that single file in a sidecar JSON file under `~/.lynn/cli-snapshots/`.
3. Lynn runs the tool.
4. Rewind restores only those recorded paths.

Files that Lynn did not touch are not read, stored, restored, or deleted.

## Snapshot format

Each sidecar snapshot stores:

- `id`: stable snapshot id.
- `createdAt`: ISO timestamp.
- `entries[]`: one entry per touched path.
- `entry.path`: workspace-relative path.
- `entry.existed`: whether the file existed before the edit.
- `entry.dataBase64`: previous contents for existing regular files.
- `entry.mode`: previous file mode when available.
- `entry.skippedReason`: present when the file was too large, outside the workspace, or not a regular file.

Large files are skipped by policy. The current cap is intentionally small so generated binaries are not copied into Lynn state.

## Rewind model

Rewind is a pairing of session history and file preimages.

### Record

At each user turn:

1. Start a turn checkpoint.
2. Reuse the active sidecar snapshot for that turn.
3. Before each `write_file` or `apply_patch`, record the target file preimage if it has not already been recorded for this snapshot.
4. Attach the snapshot id to the session JSONL metadata for that turn.

### Preview

`/rewind` should list recent checkpoints:

```text
1. before "refactor parser"      3 files touched
2. before "run tests and fix"    1 file touched
3. before "update docs"          docs/README.md
```

`/rewind 2` previews:

- session turn that will become the new head.
- files that will be restored.
- files that will be deleted because Lynn created them after the target point.
- files that cannot be restored because their preimage was skipped.

Preview does not mutate files.

### Apply

`/rewind 2 --apply`:

1. Stops the active agent loop.
2. Restores sidecar preimages for touched files in reverse turn order until the target checkpoint.
3. Removes files that Lynn created after the target checkpoint.
4. Writes a new trimmed session JSONL copy rather than editing the old file in place.
5. Resumes from that trimmed session if the user continues.

## Commands

Interactive:

```text
/rewind
/rewind 2
/rewind 2 --apply
```

Headless:

```bash
Lynn code --rewind <session.jsonl>#2 --json
Lynn code --resume <trimmed-session.jsonl> --long "continue"
```

## Events

Future JSONL events should be explicit:

- `session.rewind.preview`
- `session.rewind.applied`
- `session.rewind.skipped_file`

These should include snapshot ids, relative paths, skipped reasons, and whether a file was restored or deleted.

## Safety tests

Rewind is not complete until these tests pass:

- Unrelated dirty binary file changes survive rewind.
- A file Lynn created is removed when rewinding before its creation.
- A file Lynn modified is restored to the exact preimage.
- A file too large to snapshot is reported as skipped and never overwritten.
- Torn session lines are ignored while finding checkpoints.
- No `.git/objects` growth is required for snapshots.

## Non-goals

- No whole-tree `git stash create`.
- No `git checkout <ref> -- .`.
- No rollback of files Lynn did not touch.
- No system prompt injection to explain rewind to the model.

