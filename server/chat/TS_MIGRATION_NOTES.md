# Chat Leaf Helper TypeScript Migration Notes

## Scope

- Added `// @ts-check` plus JSDoc typedefs to these leaf helpers:
  `provider-route-meta.js`, `stream-event-emitter.js`, `stream-sanitizer.js`,
  `translation-intent.js`, `turn-retry-policy.js`, `turn-quality-gate.js`,
  `artifact-shape.js`, `tool-use-behavior.js`, and
  `local-qwen35-direct-policy.js`.
- Kept all files as `.js`; no route, package, script, core, shared, or desktop
  files were changed.
- The annotations document current runtime contracts without introducing hidden
  prompt rewrites, fallback synthesis, or local model downloads.

## Migration Order

1. Convert the pure shims first: `stream-sanitizer.js`,
   `turn-quality-gate.js`, and most of `turn-retry-policy.js`.
2. Convert shape/metadata helpers next: `artifact-shape.js`,
   `provider-route-meta.js`, and `stream-event-emitter.js`.
3. Convert prompt policy helpers after their imported context helpers are typed:
   `translation-intent.js`, `tool-use-behavior.js`, and
   `local-qwen35-direct-policy.js`.

## Test Coverage

- Existing direct tests cover provider route metadata, stream sanitizer,
  translation intent, turn retry policy, turn quality gate, tool-use behavior,
  and local Qwen direct policy.
- New direct tests cover `artifact-shape.js` and `stream-event-emitter.js`.
- Run:
  `npm run typecheck`
- Run targeted Vitest:
  `npx vitest run tests/provider-route-meta.test.js tests/stream-event-emitter.test.js tests/stream-sanitizer.test.js tests/translation-intent.test.js tests/turn-retry-policy.test.js tests/turn-quality-gate.test.js tests/artifact-shape.test.js tests/tool-use-behavior.test.js tests/local-qwen35-direct-policy.test.js`
