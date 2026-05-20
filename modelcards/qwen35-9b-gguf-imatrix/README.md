---
license: apache-2.0
tags:
  - qwen
  - qwen3.5
  - gguf
  - q4_k_m
  - imatrix
  - llama.cpp
  - local-agent
language:
  - zh
  - en
pipeline_tag: text-generation
---

# Qwen3.5-9B Q4_K_M imatrix GGUF for Lynn Local Agent

这是 Lynn 首发本地 9B 路线使用的 Qwen3.5-9B GGUF 量化包，面向 llama.cpp / 本地 OpenAI-compatible endpoint。

定位很简单：**本地 9B，日常无限用。** 让 Lynn 客户端在 Mac / Windows / Linux 上自动安装或定位 llama.cpp、下载模型、启动本地端点，并把它注册成 Lynn 的本地优先模型；云端 MIMO/Brain 仍作为兜底。

## Files

| File | Size | SHA256 | Notes |
|---|---:|---|---|
| `Qwen3.5-9B-Q4_K_M-imatrix.gguf` | 5.89GB decimal / 5.49GiB | `9437f5bf0dd0c97800caaf902f41e6a6aa00223ab232f159eda41dcbbb492645` | Lynn imatrix-calibrated Q4_K_M release artifact |

> 与官方 default/RTN Q4_K_M 区分：本仓库文件名带 `imatrix`，Lynn 客户端默认下载这一版。官方 default RTN 会作为对照测试项保留，不作为默认推荐。

## Why this model

我们最后选择 Qwen3.5-9B + Q4_K_M imatrix 作为 Lynn 本地首发，是因为它在端侧体验、质量、体积和生态成熟度之间最均衡：

- llama.cpp/GGUF 生态成熟，Mac 和 CUDA 都能跑，runtime 小，部署维护成本低。
- 5.9GB 文件量级适合大多数 16GB+ 内存设备；24GB MacBook Air 可以比较从容地跑 32K thinking。
- thinking-on 32K 下，9B 的能力接近 35B A3B 的实用区间，适合日常智能体、本地代码解释、长文档和工具流。
- 与 Lynn-native NVFP4 相比，Q4_K_M 牺牲少量量化精度，但换来跨平台、低依赖和即装即用。

## Evaluation snapshot

所有数字来自 Lynn 内部同口径评测；标注 `thinking-on 32K` 的项目允许模型输出长思考，`excl_pf` 表示排除因 32K 仍未收口导致无法解析最终选项的样本。

### Qwen3.5-9B thinking-off

| Variant | MMLU 500 5-shot | GPQA Diamond 198 | Notes |
|---|---:|---:|---|
| BF16 official | 77.20% | 44.95% | official BF16 baseline |
| Q4_K_M imatrix GGUF | 76.00% | 37.37% | llama.cpp, thinking off |
| Lynn-native W4A16 NVFP4 | 75.20% | 42.93% | Lynn engine, thinking off |

### Qwen3.5-9B thinking-on 32K

| Variant | MMLU | GPQA Diamond | Notes |
|---|---:|---:|---|
| Q4_K_M imatrix GGUF | 92.00% (92/100), parse_fail 0 | 72.22% naive (143/198) / 81.71% excl_pf, parse_fail 23 | recommended local route |
| Lynn-native W4A16 NVFP4 | 91.00% (91/100), parse_fail 1 | 56.00% naive (28/50) / 70.00% excl_pf, parse_fail 10 | GPQA currently only 50-sample |
| BF16 official | 87.00% (87/100), parse_fail 1 | running / pending | R6000 BF16 GPQA50 still running at card creation time |
| Q4_K_M default RTN | pending | pending | requested as baseline comparison; not default route |

### Interpretation

- MMLU: Q4_K_M imatrix is effectively at the current best observed 9B level in our 100-sample thinking-on gate.
- GPQA: naive score is penalized by parse failures, mostly long chemistry/organic-chemistry reasoning that still hits 32K; `excl_pf` gives the model's score when it actually emits a parseable final answer.
- This is why the model card reports both naive and excl_pf. For product UX, Lynn should surface long-thinking timeout/continuation instead of silently treating every parse failure as a wrong answer.

## Local usage with llama.cpp

Lynn Desktop will handle this automatically after user authorization. Manual equivalent:

```bash
modelscope download --model Merkyor/Qwen3.5-9B-GGUF-imatrix \
  Qwen3.5-9B-Q4_K_M-imatrix.gguf \
  --local_dir ~/Models/Lynn/Qwen3.5-9B/q4_k_m

llama-server \
  --model ~/Models/Lynn/Qwen3.5-9B/q4_k_m/Qwen3.5-9B-Q4_K_M-imatrix.gguf \
  --host 127.0.0.1 \
  --port 18099 \
  --ctx-size 32768 \
  --parallel 4 \
  --n-gpu-layers 999 \
  --jinja \
  --reasoning auto
```

OpenAI-compatible endpoint:

```text
base_url = http://127.0.0.1:18099/v1
api_key  = local
model    = qwen35-9b-q4km-imatrix
```

## Tool-call gate

Tool-call / structured-agent gate is planned for the Lynn client release checklist and will be added here when complete. Current release status:

| Gate | Status |
|---|---|
| MMLU / GPQA quality | partial complete; BF16 GPQA and default RTN Q4_K_M pending |
| llama.cpp endpoint smoke | implemented in Lynn setup scripts |
| Tool-call / structured output | pending |
| Client auto setup and provider registration | implemented in Lynn app branch |

## Provenance

- Base model: Qwen3.5-9B.
- Format: GGUF Q4_K_M with imatrix calibration.
- Runtime target: llama.cpp server / OpenAI-compatible endpoint.
- Lynn integration: local provider id `local-qwen35-9b-q4km-imatrix`.
