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

# Qwen3.5-9B Q4_K_M imatrix GGUF（Lynn 本地智能体推荐版）

这是 Lynn 首发本地 9B 路线使用的 Qwen3.5-9B GGUF 量化包，面向 llama.cpp / 本地 OpenAI-compatible endpoint。

定位很简单：**本地 9B，日常无限用。** 让 Lynn 客户端在 Mac / Windows / Linux 上自动安装或定位 llama.cpp、下载模型、启动本地端点，并把它注册成 Lynn 的本地优先模型；云端 MIMO/Brain 仍作为兜底。

English summary: this is Lynn's recommended Qwen3.5-9B Q4_K_M imatrix GGUF artifact for local-agent inference through llama.cpp. It is intended to be downloaded and started automatically by the Lynn client after user authorization.

## 文件

| 文件 | 大小 | SHA256 | 备注 |
|---|---:|---|---|
| `Qwen3.5-9B-Q4_K_M-imatrix.gguf` | 5.89GB decimal / 5.49GiB | `9437f5bf0dd0c97800caaf902f41e6a6aa00223ab232f159eda41dcbbb492645` | Lynn imatrix 校准 Q4_K_M 发布文件 |

> 与官方 default/RTN Q4_K_M 区分：本仓库文件名带 `imatrix`，Lynn 客户端默认下载这一版。官方 default RTN 会作为对照测试项保留，不作为默认推荐。

## 为什么选择这一版

我们最后选择 Qwen3.5-9B + Q4_K_M imatrix 作为 Lynn 本地首发，是因为它在端侧体验、质量、体积和生态成熟度之间最均衡：

- llama.cpp/GGUF 生态成熟，Mac 和 CUDA 都能跑，runtime 小，部署维护成本低。
- 5.9GB 文件量级适合大多数 16GB+ 内存设备；24GB MacBook Air 可以比较从容地跑 32K thinking。
- thinking-on 32K 下，9B 的能力接近 35B A3B 的实用区间，适合日常智能体、本地代码解释、长文档和工具流。
- 与 Lynn-native NVFP4 相比，Q4_K_M 牺牲少量量化精度，但换来跨平台、低依赖和即装即用。

English note: we chose this artifact because it gives the best release trade-off across local usability, model quality, file size, and runtime maturity. Lynn's native NVFP4 engine remains a Pro/NVIDIA path, while this GGUF route is the default consumer local path.

## 评测摘要

所有数字来自 Lynn 内部同口径评测；标注 `thinking-on 32K` 的项目允许模型输出长思考，`excl_pf` 表示排除因 32K 仍未收口导致无法解析最终选项的样本。

### Qwen3.5-9B thinking-off（短输出/默认推理）

| 版本 | MMLU 500 5-shot | GPQA Diamond 198 | 备注 |
|---|---:|---:|---|
| BF16 official | 77.20% | 44.95% | 官方 BF16 基线 |
| Q4_K_M imatrix GGUF | 76.00% | 37.37% | llama.cpp, thinking off |
| Lynn-native W4A16 NVFP4 | 75.20% | 42.93% | Lynn engine, thinking off |

### Qwen3.5-9B thinking-on 32K（能力上限）

| 版本 | MMLU | GPQA Diamond | 备注 |
|---|---:|---:|---|
| Q4_K_M imatrix GGUF | 92.00% (92/100), parse_fail 0 | 72.22% naive (143/198) / 81.71% excl_pf, parse_fail 23 | 推荐本地路线 |
| Lynn-native W4A16 NVFP4 | 91.00% (91/100), parse_fail 1 | 56.00% naive (28/50) / 70.00% excl_pf, parse_fail 10 | GPQA 当前仅 50 题样本 |
| BF16 official | 87.00% (87/100), parse_fail 1 | running / pending | R6000 BF16 GPQA50 仍在补测 |
| Q4_K_M default RTN | pending | pending | 对照基线,不是默认推荐 |

### 如何解读这些数字

- MMLU：Q4_K_M imatrix 在当前 9B thinking-on 100 题门禁里是最强观测档。
- GPQA：`naive` 会把 32K 内仍未给出可解析选项的样本算错；`excl_pf` 展示模型在成功收口时的能力。两个数都保留，是为了区分“能力错误”和“长思考未收口”。
- 产品侧不应该把所有 parse fail 静默算作模型能力差，而应该提供继续生成、重试或更高 token 预算。

English interpretation:

- MMLU: Q4_K_M imatrix is effectively at the current best observed 9B level in our 100-sample thinking-on gate.
- GPQA: naive score is penalized by parse failures, mostly long chemistry/organic-chemistry reasoning that still hits 32K; `excl_pf` gives the model's score when it actually emits a parseable final answer.
- This is why the model card reports both naive and excl_pf.

## 本地使用方式（llama.cpp）

Lynn Desktop 会在用户授权后自动完成下载、启动和 provider 注册。下面只是手动等价命令，普通用户不需要自己执行：

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

## 工具调用门禁

工具调用 / 结构化智能体门禁已经进入 Lynn 客户端发布清单，完成后会补到本模型卡。当前发布状态：

| 门禁 | 状态 |
|---|---|
| MMLU / GPQA 质量 | 部分完成；BF16 GPQA 和 default RTN Q4_K_M 待补 |
| llama.cpp endpoint smoke | 已在 Lynn setup scripts 实现 |
| Tool-call / structured output | 待补 |
| 客户端自动安装与 provider 注册 | 已在 Lynn app 分支实现 |

## 来源与集成信息

- 基座模型：Qwen3.5-9B。
- 格式：GGUF Q4_K_M, 带 imatrix 校准。
- 运行目标：llama.cpp server / OpenAI-compatible endpoint。
- Lynn 集成：本地 provider id `local-qwen35-9b-q4km-imatrix`。

English provenance:

- Base model: Qwen3.5-9B.
- Format: GGUF Q4_K_M with imatrix calibration.
- Runtime target: llama.cpp server / OpenAI-compatible endpoint.
- Lynn integration: local provider id `local-qwen35-9b-q4km-imatrix`.
