# Lynn Runtime Instruction Frames

Date: 2026-05-29

This note captures the lesson from Claude Code's mid-conversation system-message change without copying its provider-specific wire format.

## Problem

Some providers can accept system-level instructions only as a top-level `system` field. Others may accept `role: "system"` in `messages`, and a smaller set may accept system messages in the middle of a conversation. OpenAI-compatible and DeepSeek-compatible endpoints must not be assumed to support mid-conversation `role: "system"` messages.

If Lynn lets every surface inject provider-shaped messages directly, the same session can work on one model and 400 on another.

## Decision

Lynn uses an internal runtime instruction frame IR:

- `base_system` - stable persona/base policy; should stay cache-stable.
- `runtime_policy` - `/fast`, `/think`, mode changes, task-local rules.
- `permission_state` - ask/yolo/sandbox state from CLI, GUI, or Fleet.
- `cacheable_context` - stable project/context payload.
- `ephemeral_context` - current progress, search snippets, transient state.
- `tool_guard` - storm guard, forbidden files, center locks, download rules.

Implementation lives in `shared/runtime-instruction-frames.ts`.

## Serialization Rule

Provider adapters convert frames into the provider's native shape:

| Provider capability | Base system | Runtime frames |
|---|---|---|
| Top-level system only | `system` field | Protected user context block |
| Mid-system supported | `system` field | `role: "system"` message |
| Developer messages supported | system/developer as supported | `role: "developer"` message |
| Unknown compatible endpoint | Protected user context block | Protected user context block |

Only a provider adapter may opt into mid-conversation system messages.

## Cache Discipline

Stable frames must be byte-stable:

- Keep `base_system` unchanged across turns.
- Keep `cacheable_context` deterministic and append-only.
- Put transient status into `ephemeral_context`.
- Put permission changes into `permission_state` instead of rewriting base system.

This lets MiMo/DeepSeek-style long tasks preserve prompt-cache economics while still allowing dynamic runtime controls.

## CLI/Fleet Use

`Lynn code` should emit frames for:

- `/fast` -> `runtime_policy`.
- `/think` -> `runtime_policy`.
- `/mode yolo` -> `permission_state` + `tool_guard`.
- Worker center locks -> `tool_guard`.
- Search/vision context -> `ephemeral_context` or `cacheable_context` depending on stability.

GUI Fleet should display these frames as runtime state, not user-authored chat.

## Test Requirement

Any adapter that serializes runtime frames must prove:

- DeepSeek/OpenAI-compatible mode never places `role: "system"` inside `messages`.
- Anthropic mid-system mode only does so when explicitly opted in.
- Cacheable frames can be hashed or rendered independently from ephemeral frames.

