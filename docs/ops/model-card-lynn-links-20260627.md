# Lynn model-card link patch · 2026-06-27

HF / ModelScope model cards should link back to the Lynn project and match the current local recommendation chain.

## GitHub release link

Use the release page, not only the repo homepage:

```md
[Download Lynn Agent](https://github.com/LynnMerkyor/Lynn/releases)
```

## 27B original weights card

Add this section near the top of the 27B original-weight model card:

```md
## Lynn Agent

This distilled 27B model is the recommended local reasoning model family for **Lynn Agent**. For desktop/edge use, Lynn recommends the GGUF sibling repo and starts from the Q5_K_M imatrix MTP quant.

- **Download Lynn Agent**: [GitHub Releases](https://github.com/LynnMerkyor/Lynn/releases)
- **Recommended edge runtime repo**: [Qwen3.6-27B-DSV4Pro-Thinking-Distill-GGUF](https://modelscope.cn/models/Merkyor/Qwen3.6-27B-DSV4Pro-Thinking-Distill-GGUF)
- **Default quant in Lynn**: `Qwen3.6-27B-DSV4Pro-Distill-MTP-Q5_K_M-imatrix.gguf`
```

Add this section near the top of the 27B GGUF model card:

```md
## Lynn Agent integration

This GGUF repo is the **default local model recommendation** for Lynn Agent. Lynn v0.85.5+ uses `Qwen3.6-27B-DSV4Pro-Distill-MTP-Q5_K_M-imatrix.gguf` as the first-choice edge model for 24GB+ VRAM / unified-memory machines.

- **Download Lynn Agent**: [GitHub Releases](https://github.com/LynnMerkyor/Lynn/releases)
- **Project**: [LynnMerkyor/Lynn](https://github.com/LynnMerkyor/Lynn)
- **Default quant in Lynn**: Q5_K_M imatrix + native MTP (`--spec-draft-n-max 3`)
- **Low-config downgrade**: 9B / 4B GGUF options stay manual-only inside Lynn settings
- **High-end option**: 32GB+ machines can choose the 35B-A3B Q5_K_M GGUF sibling
```

Add this section near the top of the 35B GGUF model card:

```md
## Lynn Agent integration

This GGUF repo is the **high-end local model option** for Lynn Agent. Lynn v0.85.5+ recommends the 27B Q5_K_M GGUF as the default local path, and exposes `Qwen3.6-35B-A3B-DSV4Pro-Distill-MTP-Q5_K_M-imatrix.gguf` for 32GB+ VRAM / unified-memory machines.

- **Download Lynn Agent**: [GitHub Releases](https://github.com/LynnMerkyor/Lynn/releases)
- **Project**: [LynnMerkyor/Lynn](https://github.com/LynnMerkyor/Lynn)
- **High-end quant in Lynn**: Q5_K_M imatrix + native MTP (`--spec-draft-n-max 3`)
- **Default local path**: 27B Q5_K_M GGUF for 24GB+ machines
- **Low-config downgrade**: 9B / 4B GGUF options stay manual-only inside Lynn settings
```

## Quantization table updates

27B GGUF:

```md
| `...-MTP-Q4_K_M-imatrix.gguf` | 16.8 GB | speed-first fallback |
| `...-MTP-Q5_K_M-imatrix.gguf` | 19.5 GB | **Lynn default recommendation (24GB+)** |
```

35B-A3B GGUF:

```md
| `...-MTP-Q4_K_M-imatrix.gguf` | ~21 GB | speed-first fallback |
| `...-MTP-Q5_K_M-imatrix.gguf` | ~25 GB | **Lynn high-end recommendation (32GB+)** |
```

## Run examples

27B default:

```bash
llama-server -m Qwen3.6-27B-DSV4Pro-Distill-MTP-Q5_K_M-imatrix.gguf \
  --spec-type draft-mtp --spec-draft-n-max 3 \
  -c 8192 --jinja --host 127.0.0.1 --port 8080
```

35B high-end:

```bash
llama-server -m Qwen3.6-35B-A3B-DSV4Pro-Distill-MTP-Q5_K_M-imatrix.gguf \
  --spec-type draft-mtp --spec-draft-n-max 3 \
  -c 8192 --jinja --host 127.0.0.1 --port 8080
```

## Auth note

The local HF token visible to `huggingface_hub` on 2026-06-27 could read these repos but received `401 Unauthorized` on upload. ModelScope CLI had local credentials but `modelscope modelcard -act download` hung without output for roughly two minutes, so the remote cards were not modified in this pass.
