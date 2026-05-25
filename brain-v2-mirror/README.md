# Brain v2 Mirror

This directory mirrors the deployable Brain v2 runtime from `/opt/lobster-brain-v2`.

Keep this tree self-contained enough to run `npm test` locally. Do not commit production-only runtime files such as `.env`, `node_modules/`, `*.bak*`, or generated logs under `data/`.

Current entry points:

- `server.ts`: HTTP/SSE routes for Brain v2. Run with `npm start` (`tsx server.ts`).
- `router.ts`: provider/tool orchestration.
- `verifier-middleware.ts`: asynchronous tool-result verifier.
- `deep-research.ts`: multi-candidate research orchestrator; no quality gate or output rewriting.
- `agent-checkpoint.ts`: trajectory checkpoint evaluator.

Production deployment still runs from `/opt/lobster-brain-v2`; sync intentionally and run the mirror tests before deployment.
