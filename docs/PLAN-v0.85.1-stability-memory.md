# Lynn V0.85.1 Stability + Memory UX Plan

Date: 2026-06-22

V0.85.1 is the stabilization release for the self-built Lynn Agent Core shipped in V0.85.0. It must keep the main path native to Lynn, avoid upstream SDK/fork dependency creep, and turn the new GUI/CLI-converged runtime into a calmer long-conversation experience.

## Release Goal

V0.85.1 focuses on three user-visible outcomes:

- The new native core stays the default path for GUI and CLI without route drift.
- Long conversations become recoverable and navigable instead of growing into fragile giant sessions.
- Memory recall becomes more targeted: current task branch first, relevant project/user memory second, old raw transcript last.

## Non-Goals

- Do not import Stello or any other conversation-topology runtime as a dependency.
- Do not fork or patch an upstream Agent SDK to carry core behavior.
- Do not redesign the entire app shell or memory stack in one pass.
- Do not hide low-quality tool failure behind instant empty fallback copy.

## Workstreams

1. Native session topology v0
   - Add shared topology metadata for session index entries.
   - Track parent session, root session, branch label, task status, summary, and resume hint.
   - Expose a small API for updating topology metadata.
   - Keep all metadata sidecar-based and backward compatible with existing JSONL sessions.

2. Long-session recovery
   - Detect oversized or slow-loading sessions before the GUI tries to hydrate them fully.
   - Prefer resume summaries and topology metadata for continuation.
   - Add a path for "continue in a branch" without copying the full parent transcript.

3. Memory injection discipline
   - Treat branch summary/resume hint as the nearest task memory.
   - Keep long-term memory and project memory as selective context, not unconditional prompt bulk.
   - Make memory/debug evidence inspectable without leaking noisy internals into normal answers.

4. GUI/CLI convergence
   - Keep CLI and GUI session indexes on the same metadata schema.
   - Add tests that prevent topology fields from existing in one surface but disappearing in the other.
   - Keep search/evidence behavior shared through the native core.

5. Quality gates
   - CLI 50 and GUI 50 remain release gates.
   - Add focused tests for topology metadata, session index compatibility, and long-conversation recovery primitives.
   - Add task cases for prediction/search questions where a failed narrow tool must not produce an instant empty answer.

## First Slice

The first implementation slice adds native topology metadata to the shared session index path:

- `shared/session-topology.ts`
- GUI session list type/display support
- CLI session store support
- server `/api/sessions/topology` metadata endpoint
- focused tests for normalization and index persistence

This gives V0.85.1 a stable foundation for branch/resume UX without changing the raw session message format.

## Implemented Slice

The current implementation extends the first slice into a map-first right rail:

- Shared `session-topology`, `session-digest`, and `evidence-safety-answer` modules.
- GUI and CLI session indexes preserve topology, digest, insight, and health metadata.
- Server APIs expose branch creation, topology updates, digest updates, insight inbox updates, and lightweight session maps.
- The right sidebar now defaults to a patrol + work map surface; legacy Jian/workspace files live under a secondary materials tab.
- The titlebar right badge is driven by unread insights and large/critical sessions, not by incidental Jian content.

This makes a 7GB-style session visible as a dangerous map node and encourages continuation through a branch instead of forcing the GUI to hydrate the giant parent conversation.
