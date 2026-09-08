# Lynn V0.87 — UI, window light and capability consolidation

User-authorized scope (2026-09-08). Release version: **0.87.0**.

- [x] Preserve the original Lynn portrait; verify both bundled avatar SHA256 values against `output/release-v0.87.0/avatar-baseline.sha256`. Explicitly selected other agents keep their avatars.
- [x] Replace the upstream tree-shadow video with Lynn's own soft window light and leaf composition. Keep the appearance preference, theme accessibility, background pause and reduced-motion support. Visually verify the actual application.
- [x] Move the six professional expert presets and roundtable onboarding out of the default experience into an installable optional plugin. Preserve existing agents, channels and history.
- [x] Stop requesting new MOOD/PULSE/REFLECT and XING protocol blocks. Preserve legacy rendering, persona tone and useful workflow extraction as ordinary Markdown.
- [x] Remove the nine-item task mode picker and persistent persona injection. Preserve its useful templates as explicit slash commands. Keep actual deep research, writing layout and security modes.
- [x] Merge the separate gallery into the file panel's image filter. Preserve generation, folders and existing gallery files.
- [x] Move answer translation into the message menu. Preserve language choice and translated output.
- [x] Remove proactive local-model install promotion from chat. Preserve model settings installation and status for explicitly selected local models.
- [x] Narrow automatic review for ordinary searches and light edits; retain manual review, failures, high-stakes/time-sensitive checks and existing MiMo second-opinion gates.
- [x] Preserve the already released Kimi MCP login/data source integration, search, session files and automations.
- [ ] Update release metadata and notes to 0.87.0; run relevant tests, application UI checks and the required release gates.
- [ ] Build macOS arm64/x64 and Windows, sign/notarize macOS, verify the installed artifacts, publish the new release and independently verify all configured outlets.

Work only in `/Users/lynn/.codex/worktrees/821f/Lynn`, branch `codex/release-v0.87`. Do not modify the primary checkout or the daily application. Evidence belongs in `output/release-v0.87.0/`. Launch isolated QA with `LYNN_SKIP_VOICE_TUNNEL=1`.

## Development evidence

- Root: 3481 tests passed, 3 skipped. Brain: 370 passed. Both TypeScript checks passed.
- Optional plugin install/load/unload and preservation of existing data passed; expert manager and file preview follow-up: 8 passed.
- Both original avatar SHA256 values unchanged.
- Isolated real Electron UI: tree toggle, reduced motion, theme gating and pointer-events passed; real model reply and translation succeeded. File filtering, thumbnail loading, old gallery navigation and empty-folder return passed.
- Evidence: `output/release-v0.87.0/` (screenshots, interaction JSON, per-stage logs).
- Release gates remain in progress. Initial preflight stopped at a stale CLI README version (87/88 static checks); fixed and resumed from static checks in `overnight-continuation.log`. No remote release assets have been changed.
