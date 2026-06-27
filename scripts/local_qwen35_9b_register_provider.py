#!/usr/bin/env python3
"""Write the Lynn local-provider contract for Lynn's local llama.cpp model.

The desktop/client side can consume this JSON directly, or mirror the fields
into its own settings store. The key rule is conservative: keep MIMO as
fallback and switch local-first only after checksum + smoke gates pass.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
import time
from pathlib import Path
from typing import Any


def _sha256(path: Path) -> str | None:
    if not path.exists() or path.stat().st_size == 0:
        return None
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _binary_version(path: Path) -> str | None:
    try:
        out = subprocess.check_output(
            [str(path), "--version"],
            text=True,
            stderr=subprocess.STDOUT,
            timeout=5,
        )
    except Exception:
        return None
    return out.splitlines()[0].strip() if out.splitlines() else None


def _model_profile(served_name: str, gguf: Path) -> dict[str, str]:
    text = f"{served_name} {gguf.name}".lower()
    if "35b" in text:
        return {
            "display_name": "Qwen3.6-35B-A3B Q5_K_M MTP Local",
            "model_family": "Qwen3.6-35B-A3B",
            "recommendation": "35B-A3B Q5_K_M MTP is the 32GB+ high-capability local upgrade.",
            "quant": "Q5_K_M",
        }
    if "27b" in text:
        return {
            "display_name": "Qwen3.6-27B Q5_K_M MTP Local",
            "model_family": "Qwen3.6-27B-DSV4Pro",
            "recommendation": "27B Q5_K_M MTP is Lynn's default recommended local model for 24GB+ machines.",
            "quant": "Q5_K_M",
        }
    if "9b" in text:
        return {
            "display_name": "Qwen3.5-9B MTP Local",
            "model_family": "Qwen3.5-9B",
            "recommendation": "9B MTP is a low-config downgrade when the default 27B path is too heavy.",
            "quant": "Q4_K_M",
        }
    return {
        "display_name": "Qwen3.5-4B Local",
        "model_family": "Qwen3.5-4B",
        "recommendation": "4B Q4_K_M is a low-config downgrade; thinking-on may produce empty long reasoning.",
        "quant": "Q4_K_M",
    }


def build_payload(args: argparse.Namespace) -> dict[str, Any]:
    gguf = Path(args.gguf).expanduser().resolve()
    llama_server = Path(args.llama_server).expanduser().resolve()
    endpoint = f"http://{args.host}:{args.port}/v1"
    size_bytes = gguf.stat().st_size if gguf.exists() else None
    profile = _model_profile(args.served_name, gguf)

    return {
        "schema_version": "lynn-local-provider-v1",
        "generated_at_unix": int(time.time()),
        "provider_id": f"local-{args.served_name}",
        "display_name": profile["display_name"],
        "status": "configured_pending_smoke",
        "default_provider": "mimo",
        "fallback_provider": "mimo",
        "activation_policy": "local_first_after_smoke",
        "runtime": {
            "kind": "llama.cpp",
            "binary": str(llama_server),
            "version": _binary_version(llama_server),
            "host": args.host,
            "port": int(args.port),
            "base_url": endpoint,
            "api_key": "local",
            "model": args.served_name,
            "ctx_size": int(args.ctx_size),
            "parallel": int(args.parallel),
            "n_gpu_layers": int(args.gpu_layers),
            "reasoning": "auto",
        },
        "artifact": {
            "artifact_id": args.artifact_id,
            "model_family": profile["model_family"],
            "quant": profile["quant"],
            "variant": args.variant,
            "format": "GGUF",
            "path": str(gguf),
            "size_bytes": size_bytes,
            "sha256": _sha256(gguf) if args.hash else None,
        },
        "client_env": {
            "OPENAI_BASE_URL": endpoint,
            "OPENAI_API_KEY": "local",
            "OPENAI_MODEL": args.served_name,
            "GGUF": str(gguf),
            "LLAMA_SERVER": str(llama_server),
        },
        "launch": {
            "env_file": str(Path(args.env_file).expanduser().resolve()),
            "command": "bash scripts/local_qwen35_9b_q4km_llamacpp_server.sh",
            "smoke_command": "bash scripts/local_qwen35_9b_release_qa_smoke.sh",
        },
        "smoke_required": [
            "download_manifest",
            "sha256",
            "llama_cpp_v1_models",
            "chat_32_tokens",
            "tool_call_weather",
        ],
        "platform": {
            "system": platform.system(),
            "machine": platform.machine(),
        },
        "notes": [
            "The Lynn client must keep MIMO available until smoke_required passes.",
            profile["recommendation"],
            "35B Q4_K_M imatrix remains an optional high-memory upgrade through the local model manager.",
        ],
    }


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--artifact-id", required=True)
    p.add_argument("--variant", choices=["imatrix", "default"], required=True)
    p.add_argument("--gguf", required=True)
    p.add_argument("--llama-server", required=True)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", default="18099")
    p.add_argument("--served-name", required=True)
    p.add_argument("--ctx-size", default="32768")
    p.add_argument("--parallel", default="4")
    p.add_argument("--gpu-layers", default="999")
    p.add_argument("--env-file", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--hash", action="store_true", help="Compute SHA256 now.")
    args = p.parse_args()

    payload = build_payload(args)
    out = Path(args.output).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[qwen35-provider] wrote {out}")
    print(f"[qwen35-provider] base_url={payload['runtime']['base_url']} model={args.served_name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
