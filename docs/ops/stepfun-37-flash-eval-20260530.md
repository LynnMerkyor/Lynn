# StepFun 3.7 Flash Evaluation Snapshot - 2026-05-30

This note preserves the live evaluation data used to justify making
`step-3.7-flash` the Lynn Brain text/coding head route, plus a Lynn CLI BYOK
preset and Fleet fast-coding worker profile.

Update after the high-budget run: the original medium+16K snapshot below
underestimated StepFun because hard reasoning cases ran out of answer budget.
The current default route is:

```text
StepFun 3.7 Flash high+32K -> MiMo V2.5 Pro -> Spark Qwen 3.6 35B A3B
```

MiMo remains the multimodal/native-search fallback: images, audio, video, and
native-search-heavy paths are capability-gated to MiMo.

## Summary

| Dimension | Result |
|---|---:|
| Observed generation speed | ~215-220 TPS |
| Production CodeBuddy coding tasks | 6/6 pass |
| Self-hosted agentic coding harness | 3/3 pass |
| General agentic tool chain | 5/5 pass |
| GPQA Diamond 198, medium+16K think-on (superseded) | 118/198 = 59.60% |
| GPQA Diamond 198, **high+32K think-on** | **70.71%** |
| MMLU 500, **high+32K 5-shot** | **92.20%** |
| Extra coding/tools suite | **21/21** |
| High+32K parse failures | GPQA pf=2 / MMLU pf=0 |

## GPQA Diamond Comparison

| Model / mode | GPQA Diamond 198 |
|---|---:|
| StepFun `step-3.7-flash` high+32K | **70.71%** |
| MiMo V2.5 Pro | 66.67% |
| StepFun `step-3.7-flash` medium+16K (superseded) | 59.60% / 63.10% excl. parse-fail |
| Qwen3.6-35B-A3B BF16 canonical | 45.45% |
| Qwen3.6-35B-A3B Q4_K_M imatrix | 50.00% |
| Qwen3.5-9B Q4_K_M MTP | 44.44% |

Interpretation:
- StepFun high+32K is both faster and stronger than MiMo and the current 35B
  APEX fallback on this GPQA run.
- Spark/local 35B still matters for privacy and zero marginal API cost.
- StepFun should be the default text/coding head route. MiMo stays second for
  multimodal/native-search breadth and as a high-quota fallback.

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
- Medium+16K GPQA 59.60% is superseded by high+32K GPQA 70.71%; keep the
  high+32K budget for hard reasoning.
- Remaining parse failures are much lower (GPQA pf=2) but still show why answer
  extraction and sufficient max tokens matter.
- Long-task stability still needs more Lynn-native Fleet soak testing beyond the
  coding spikes above.

## Lynn V0.80 Placement

- Add `stepfun` as a CLI BYOK preset: `baseUrl`, `apiKey`, `model`.
- Expose `stepfun-flash` in GUI Fleet as a fast coding worker.
- Brain v2 default route is StepFun 3.7 Flash high+32K -> MiMo V2.5 Pro -> Spark
  Qwen 3.6 35B A3B.
- Keep MiMo as the second route and multimodal/native-search owner.
- Keep Spark/local routes as privacy and zero-cost local fallback options.
