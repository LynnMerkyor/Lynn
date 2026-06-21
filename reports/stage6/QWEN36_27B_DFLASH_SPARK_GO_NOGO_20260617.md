# Qwen3.6-27B DFlash Spark GO/NO-GO (2026-06-17)

## Verdict

**NO-GO for Lynn default / product path.** DFlash on the tested GGUF stack has a strong single-stream speed signal, but it fails token-exact correctness on all prompts and collapses under c=4/c=8 concurrency.

This result is still useful: it confirms DFlash is worth watching as a research lead, but not ready to replace the current Spark Qwen3.6 path without a stricter verified runtime/config.

## Setup

- Hardware class: DGX Spark / sm_121
- Runtime: spiritbuun/buun-llama-cpp DFlash fork, CUDA sm_121 build
- Target: Qwen3.6-27B Q4_K_M GGUF
- Drafter: spiritbuun Qwen3.6-27B-DFlash GGUF q8_0 drafter
- Sources: [spiritbuun GGUF](https://huggingface.co/spiritbuun/Qwen3.6-27B-DFlash-GGUF), [z-lab DFlash](https://huggingface.co/z-lab/Qwen3.6-27B-DFlash)

## Correctness Gate

| Prompt | Token-exact | Base tok/s | DFlash tok/s | DFlash accept |
|---:|---|---:|---:|---:|
| 0 | FAIL | 12.143 | 22.298 | 0.3659 |
| 1 | FAIL | 12.158 | 18.437 | 0.2581 |
| 2 | FAIL | 12.101 | 16.113 | 0.2102 |

Result: **0/3 token-exact PASS**. This alone blocks product/default adoption.

## Concurrency Sweep

| Lane | Mode | Aggregate tok/s | Accept rate | vs base | Wall time |
|---|---|---:|---:|---:|---:|
| c=1 | base | 11.586 | - | 1.000x | 11.048s |
| c=1 | dflash | 28.648 | 0.5291 | 2.473x | 4.468s |
| c=4 | base | 32.702 | - | 1.000x | 15.656s |
| c=4 | dflash | 9.092 | 0.0982 | 0.278x | 56.316s |
| c=8 | base | 42.044 | - | 1.000x | 24.355s |
| c=8 | dflash | 6.250 | 0.0149 | 0.149x | 163.852s |

## Interpretation

- c=1 shows real speed potential: **28.648 vs 11.586 tok/s aggregate, 2.47x**.
- c=4 and c=8 are clear regressions: DFlash drops to **0.278x** and **0.149x** of base respectively.
- Acceptance falls sharply with concurrency: **52.9% -> 9.8% -> 1.5%**.
- The tested path also produced unstable formatting/reasoning artifacts in short prompts, so it is not just a throughput-only issue.

## Decision

- Do not use this DFlash GGUF path as Lynn Spark default.
- Keep it as a research lead only if a strict verified runtime/config appears.
- For current Spark product path, stay with Qwen3.6-35B-A3B Q4_K_M / known stable llama.cpp serving.

## Artifact

- Sanitized metrics: `reports/stage6/qwen36_27b_dflash_spark_20260617/metrics_sanitized.json`
