# Spark Speculative Decoding + Runtime Gap Overnight Report

Date: 2026-06-17
Scope: Spark Qwen 9B / 27B / 35B-A3B MTP readiness, low-concurrency behavior, DFlash readiness, and runtime-gap profiling.

## Decision

**Default/product MTP: NO-GO.**

Reason: every tested MTP configuration produced real speed signal, but failed the greedy AR-vs-MTP token-exact correctness gate on at least one prompt. For Lynn default local models, this is not safe as a silent default.

**Spark low-concurrency serving with MTP: NO-GO.**

Reason: at c=4/8, MTP hurts aggregate throughput for 9B and 27B even though c=1 is faster. It is a single-stream trick, not a Spark serving/concurrency win.

**35B-A3B APEX-MTP: NO-GO.**

Reason: only +4-6% mean single-stream speedup, correctness gate still fails, and c=4 evidence is short-output/EOS-contaminated.

**DFlash on Qwen3.6: parked / readiness NO-GO.**

Reason: Spark has diffusion runtime/assets, but no local Qwen3.6 DFlash target+drafter artifact. No synthetic speed number was fabricated.

**Lynn Engine runtime-gap revival: NO-GO for base decode.**

Reason: real llama-server decode with CUDA Graph enabled shows only ~1.2% graph-to-graph gap after removing the pre-request wait gap. That is below the 3-5% threshold, far below the 15-30% threshold required to justify restarting runtime/compiler/persistent-execution work.

MTP path has large graph gap (~65.6%), but that is speculative draft/verify orchestration overhead, not a base llama.cpp runtime gap. If pursued, the target should be DFlash/speculative decoding implementation quality, not grouped-MoE FP4/kernel/runtime resurrection.

## Single-Stream MTP Matrix

| Model | Base tok/s | Best tested MTP | MTP tok/s | Speedup | Accept | Token-exact gate |
|---|---:|---|---:|---:|---:|---|
| Qwen3.5 9B MTP Q4_K_M | 37.70 | n=2, p_min=0.6 | 50.95 | 1.35x | 0.892 | FAIL |
| Qwen3.6 27B fused MTP Q4_K_M | 12.09 | n=2, p_min=0.6 | 19.17 | 1.58x | 0.893 | FAIL |
| Qwen3.6 27B Unsloth MTP Q4_K_M | 11.41 | n=2, p_min=0.6 | 18.45 | 1.62x | 0.793 | FAIL |
| Qwen3.6 35B-A3B APEX-MTP Q4_K_M | 78.07 | n=2, p_min=0.6 | 82.71 | 1.06x | 0.881 | FAIL |

Notes:
- n=3, p_min=0 sometimes gives higher raw TPS, but lower acceptance and still fails correctness.
- Some code prompts were token-exact, but broad prompt coverage failed. Product default requires all-pass.

## Low-Concurrency Sweep

Aggregate tok/s, 128 generated tokens per request unless noted.

| Model | Config | c=1 | c=4 | c=8 |
|---|---|---:|---:|---:|
| 9B | base | 36.95 | 118.90 | 171.99 |
| 9B | MTP n=2 p=0.6 | 60.99 | 51.21 | 53.33 |
| 27B fused | base | 11.91 | 38.53 | 55.58 |
| 27B fused | MTP n=2 p=0.6 | 17.99 | 19.39 | 19.99 |
| 35B-A3B APEX | base | short-output only | 67.44* | skipped |
| 35B-A3B APEX | MTP n=2 p=0.6 | short-output only | 72.47* | skipped |

\* 35B concurrency entries are not decisive: requests hit early EOS / short-output behavior (c=1 generated only 4 tokens; c=4 generated 265 total tokens). Do not use them as long-output serving evidence.

## Runtime Gap Profiling

Primary measurement: Nsight Systems over real `llama-server` handling one `/completion` request, `n_predict=64`, `ignore_eos=true`. The build reports `USE_GRAPHS=1`; the report uses CUDA Graph execution intervals, not raw kernel rows, because graph launches encapsulate the actual reused decode path.

| Path | Decode tok/s | Graphs reused | Draft accept | Request graph gap | Interpretation |
|---|---:|---:|---:|---:|---|
| 9B base | 37.89 | 63 | n/a | 1.20% | CUDA Graph has already closed the runtime gap; no Engine revival case. |
| 9B MTP n=2 p=0.6 | 51.95 | 11 | 0.846 | 65.62% | Speculative draft/verify orchestration has large idle/gap; optimize spec path, not base runtime. |

Secondary check: a `llama-bench` trace showed raw kernel-level gaps can look large if prompt/generation phase boundaries are mixed in. The server graph trace above is the decision metric.

## DFlash Readiness

Status: **NO-GO readiness-only**.

Spark contains diffusion runtime/build assets and non-Qwen diffusion-related models, but no local Qwen3.6 DFlash artifact. DFlash remains a high-potential lead only after a concrete Qwen3.6 DFlash drafter/target package is available.

## Service Restore

After profiling, the previously running private local services were restored and health-checked successfully. No external connection details or credentials are recorded here.

## Artifacts

Raw artifacts remain on Spark in the internal run directory. The local copy under `reports/stage6/spark_spec_runtime_20260617/` is sanitized for sharing.

Key files:
- `spec_matrix.json`
- `spec_matrix_summary.json`
- `concurrency_sweep_sanitized.json`
- `runtime_gap_server9b.json`
- `runtime_gap_fixed.json`
- `dflash_readiness_sanitized.json`
- `restore_status_sanitized.json`
- `FINAL_GO_NOGO.md`

## Recommendation

1. Keep Spark default on Q4_K_M/imatrix without MTP for production/default paths.
2. Do not restart Lynn Engine grouped-MoE/kernel/runtime work based on current Spark evidence.
3. If continuing speed research, restrict it to bounded speculative decoding work:
   - a real DFlash artifact for Qwen3.6,
   - a matched-head MTP/DFlash correctness gate,
   - c=1 latency and long-output stability.
4. For any MTP exposed to users, make it opt-in / experimental and visibly lossy-risk unless token-exact gate passes on the target workload.
