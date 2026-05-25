# Runtime TypeScript Migration Foundation (2026-05-25)

## Scope

This is a no-runtime-change foundation for future TypeScript migration work. Runtime JavaScript remains in place, and `npm run server` still starts `server/index.js`.

## Typecheck Gate

`npm run typecheck:runtime` runs `tsc -p tsconfig.runtime.json`.

The runtime config is strict and no-emit. It covers future TypeScript and declaration files under:

- `server/**/*.ts`
- `core/**/*.ts`
- `shared/**/*.ts`
- `lib/**/*.ts`

JavaScript is allowed only so existing relative `.js` imports can be resolved while the runtime remains JavaScript-first. `checkJs` stays off until each runtime island opts in explicitly.

## Guardrails

- Do not rename `server/index.js` as part of this foundation.
- Do not add a TypeScript server launch switch until a real loader or build path exists.
- Do not move runtime modules to TypeScript without a follow-up migration owner and tests.
- Keep model, BF16, GGUF, and dataset artifacts off local machines unless explicitly authorized.
