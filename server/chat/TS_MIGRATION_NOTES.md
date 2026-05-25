# Chat Leaf Helper TypeScript Migration Notes

## Scope

### Phase 1 — JSDoc annotations (v0.79.2)
- Added `// @ts-check` plus JSDoc typedefs to these leaf helpers:
  `provider-route-meta.js`, `stream-event-emitter.js`, `stream-sanitizer.js`,
  `translation-intent.js`, `turn-retry-policy.js`, `turn-quality-gate.js`,
  `artifact-shape.js`, `tool-use-behavior.js`, and
  `local-qwen35-direct-policy.js`.
- Kept all files as `.js`; no route, package, script, core, shared, or desktop
  files were changed.

### Phase 2 — Full TypeScript conversion (v0.79.3)
- Converted 9 leaf helpers from `.js` + JSDoc to real `.ts`:
  `content-utils`, `stream-state`, `artifact-shape`, `provider-route-meta`,
  `tool-use-behavior`, `rate-limit`, `stream-sanitizer`,
  `local-qwen35-direct-policy`, `code-verification-postscript`.
- Added explicit exported types: `ArtifactPayload`, `ProviderRouteMeta`,
  `ToolDisableDecision`, `RateLimitDecision`, `StreamSanitizerResult`,
  `SessionStateStore`, `LocalQwen35Message`.
- Removed stale `@ts-check` and JSDoc-only typedefs where TypeScript replaces
  them. Import specifiers remain `.js` (NodeNext convention).
- No route, package, script, core, shared, or desktop files were changed.

## Migration Order

1. Convert the pure shims first: `stream-sanitizer.ts`,
   `turn-quality-gate.js`, and most of `turn-retry-policy.js`.
2. Convert shape/metadata helpers next: `artifact-shape.ts`,
   `provider-route-meta.ts`, and `stream-event-emitter.js`.
3. Convert prompt policy helpers after their imported context helpers are typed:
   `translation-intent.js`, `tool-use-behavior.ts`, and
   `local-qwen35-direct-policy.ts`.

## Test Coverage

- Existing direct tests cover provider route metadata, stream sanitizer,
  translation intent, turn retry policy, turn quality gate, tool-use behavior,
  and local Qwen direct policy.
- New direct tests cover `artifact-shape.js`, `stream-event-emitter.js`,
  `content-utils`, `rate-limit`, and `code-verification-postscript`.
- Run:
  `npm run typecheck:runtime`
- Run targeted Vitest:
  `npx vitest run tests/provider-route-meta.test.js tests/stream-event-emitter.test.js tests/stream-sanitizer.test.js tests/translation-intent.test.js tests/turn-retry-policy.test.js tests/turn-quality-gate.test.js tests/artifact-shape.test.js tests/tool-use-behavior.test.js tests/local-qwen35-direct-policy.test.js tests/content-utils.test.js tests/rate-limit.test.js tests/code-verification-postscript.test.js`
