# StepFun 3.7 Flash Evaluation Snapshot - 2026-05-30

This note preserves the live evaluation data used to justify adding
`step-3.7-flash` as a Lynn CLI BYOK preset and Fleet fast-coding worker profile.
It is not a default-route change: MiMo remains the default route through Lynn Brain.

## Summary

| Dimension | Result |
|---|---:|
| Observed generation speed | ~215-220 TPS |
| Production CodeBuddy coding tasks | 6/6 pass |
| Self-hosted agentic coding harness | 3/3 pass |
| General agentic tool chain | 5/5 pass |
| GPQA Diamond 198, think-on | 118/198 = 59.60% |
| GPQA Diamond excl. parse-fail | 63.10% |
| GPQA parse failures | 11/198 = 5.6% |

## GPQA Diamond Comparison

| Model | GPQA Diamond 198 |
|---|---:|
| StepFun `step-3.7-flash` | 59.60% / 63.10% excl. parse-fail |
| Qwen3.6-35B-A3B BF16 canonical | 45.45% |
| Qwen3.6-35B-A3B Q4_K_M imatrix | 50.00% |
| Qwen3.5-9B Q4_K_M MTP | 44.44% |

Interpretation:
- StepFun is both faster and stronger than the current 35B APEX fallback on this
  GPQA run.
- Spark/local 35B still matters for privacy and zero marginal API cost.
- StepFun should be positioned as an optional cloud fast-coding/high-quality fallback,
  not as a silent replacement for the MiMo default route.

## Production CLI Coding Evidence

StepFun was configured as a CodeBuddy custom OpenAI-compatible model:

```json
{
  "id": "step-3.7-flash",
  "name": "step-3.7-flash",
  "vendor": "Custom",
  "url": "https://api.stepfun.com/step_plan/v1",
  "supportsToolCall": true,
  "supportsImages": true,
  "supportsReasoning": true
}
```

Note: CodeBuddy sends `id` as the API model parameter, so `id` must equal the real
model name `step-3.7-flash`.

### CodeBuddy Tasks

| Language | Task type | Verification | Result |
|---|---|---|---:|
| Python | median bug fix | `python3` tests | pass |
| Python | CSV quoted comma parser | `python3` tests | pass |
| Python | LRU cache implementation | `python3` tests | pass |
| JavaScript | async `forEach` bug fix | `node` tests | pass |
| TypeScript | generic grouping type safety | `deno --check` | pass |
| Rust | word count implementation | `rustc` compile + run | pass |

Quality observations:
- Uses precise edit loops rather than whole-file rewrites in bug-fix tasks.
- Runs tests/compilers before declaring success.
- Uses idiomatic fixes where expected, such as `for...of + await` for JS async loops
  and Rust `entry(...).or_default()` style.

## Limitations

- `step-3.7-flash` is a cloud backend, so it consumes user BYOK/API quota and does
  not provide local privacy.
- GPQA 59.60% is strong for a flash-speed backend, but not top-tier frontier
  reasoning.
- 11 parse failures indicate that some hard think-on cases exhaust the answer budget
  before emitting a final choice.
- Long-task stability still needs more Lynn-native Fleet soak testing beyond the
  coding spikes above.

## Lynn V0.80 Placement

- Add `stepfun` as a CLI BYOK preset: `baseUrl`, `apiKey`, `model`.
- Expose `stepfun-flash` in GUI Fleet as a fast coding worker.
- Keep MiMo as the default route through Lynn Brain for broad multimodal/search/cache
  capability.
- Keep Spark/local routes as privacy and zero-cost local fallback options.
