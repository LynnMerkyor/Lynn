#!/usr/bin/env python3
"""Client-facing bootstrap for the Qwen3.5-9B local llama.cpp provider.

This is meant for the Lynn desktop/client UI, not for end users to run by hand:

1. The client calls `plan` and shows the resulting actions to the user.
2. If the user authorizes local setup, the client calls `execute` with
   `--yes-user-authorized`.
3. The script installs/downloads/registers/smokes through the existing setup
   entrypoint, then optionally starts the persistent local endpoint.

The safety rule is explicit: no install/download/start work happens unless the
caller supplies `--yes-user-authorized`.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SETUP_SCRIPT = ROOT / "scripts" / "local_qwen35_9b_setup.sh"
SERVER_SCRIPT = ROOT / "scripts" / "local_qwen35_9b_q4km_llamacpp_server.sh"
DEFAULT_MODEL_ROOT = Path.home() / "Models" / "Lynn" / "Qwen3.5-9B"
DEFAULT_PROVIDER = Path.home() / ".lynn-engine" / "providers" / "qwen35-9b-q4km-imatrix-gguf.json"
DEFAULT_PID_FILE = Path.home() / ".lynn-engine" / "run" / "qwen35-9b-q4km-imatrix.pid"
DEFAULT_LOG_FILE = Path.home() / ".lynn-engine" / "logs" / "qwen35-9b-q4km-imatrix.client.log"


def _json(payload: dict[str, Any], code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return code


def _which(name: str) -> str | None:
    return shutil.which(name)


def _probe_port(host: str, port: int) -> bool:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(0.4)
    try:
        return sock.connect_ex((host, port)) == 0
    finally:
        sock.close()


def _read_provider(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.expanduser().read_text(encoding="utf-8"))
    except Exception:
        return None


def _health(base_url: str) -> bool:
    try:
        root = base_url[:-3] if base_url.endswith("/v1") else base_url.rstrip("/")
        url = root + "/health"
        with urllib.request.urlopen(url, timeout=2) as resp:
            return 200 <= resp.status < 300
    except Exception:
        return False


def _find_gguf(model_root: Path, variant: str) -> Path | None:
    roots = [
        model_root / "q4_k_m",
        model_root,
        Path.home() / "Models",
        Path.home() / "models",
        Path.home() / "Downloads",
    ]
    terms = ["imatrix"] if variant == "imatrix" else ["default"]
    for root in roots:
        if not root.exists():
            continue
        candidates = sorted(root.rglob("*.gguf"))
        preferred = [
            p for p in candidates
            if "qwen3.5" in p.name.lower()
            and "9b" in p.name.lower()
            and "q4" in p.name.lower()
            and "k" in p.name.lower()
            and any(t in p.name.lower() for t in terms)
        ]
        if preferred:
            return preferred[0]
        fallback = [
            p for p in candidates
            if "qwen3.5" in p.name.lower()
            and "9b" in p.name.lower()
            and "q4" in p.name.lower()
            and "k" in p.name.lower()
        ]
        if fallback:
            return fallback[0]
    return None


def build_plan(args: argparse.Namespace) -> dict[str, Any]:
    model_root = Path(args.model_root).expanduser()
    provider_path = Path(args.provider_config).expanduser()
    host = args.host
    port = int(args.port)
    base_url = f"http://{host}:{port}/v1"
    provider = _read_provider(provider_path)
    gguf = _find_gguf(model_root, args.variant)
    llama_server = _which("llama-server") or _which("llama.cpp-server")
    has_brew = _which("brew") is not None
    running = _probe_port(host, port) and _health(base_url)

    actions: list[dict[str, Any]] = []
    if not llama_server:
        actions.append({
            "id": "install_runtime",
            "label": "Install llama.cpp runtime",
            "requires_user_authorization": True,
            "method": "homebrew" if platform.system() == "Darwin" and has_brew else "manual_or_app_managed",
        })
    if gguf is None:
        actions.append({
            "id": "download_model",
            "label": "Download Qwen3.5-9B Q4_K_M-imatrix GGUF",
            "requires_user_authorization": True,
            "approx_download_gib": 5.3,
            "artifact_id": "qwen35-9b-q4km-imatrix-gguf",
        })
    if provider is None:
        actions.append({
            "id": "register_provider",
            "label": "Write Lynn local-provider config",
            "requires_user_authorization": False,
            "path": str(provider_path),
        })
    if not running:
        actions.append({
            "id": "smoke_and_start",
            "label": "Smoke local endpoint and start server",
            "requires_user_authorization": True,
            "base_url": base_url,
        })

    return {
        "schema_version": "lynn-qwen35-local-client-bootstrap-plan-v1",
        "decision": "already_ready" if not actions else "needs_user_authorization",
        "default_provider": "mimo",
        "fallback_provider": "mimo",
        "target_provider": "local-qwen35-9b-q4km-imatrix",
        "base_url": base_url,
        "model": "qwen35-9b-q4km-imatrix",
        "model_root": str(model_root),
        "provider_config": str(provider_path),
        "observed": {
            "platform": platform.system(),
            "machine": platform.machine(),
            "llama_server": llama_server,
            "gguf": str(gguf) if gguf else None,
            "provider_config_exists": provider is not None,
            "endpoint_running": running,
            "homebrew_available": has_brew,
        },
        "actions": actions,
        "user_authorization_required": any(a.get("requires_user_authorization") for a in actions),
        "notes": [
            "The client must keep MIMO active until execute succeeds and smoke passes.",
            "The user authorizes the plan in the client UI; the user should not paste shell commands.",
        ],
    }


def _run_checked(cmd: list[str], *, env: dict[str, str] | None = None) -> None:
    subprocess.run(cmd, cwd=str(ROOT), env=env, check=True)


def _start_server(env_file: Path, pid_file: Path, log_file: Path) -> dict[str, Any]:
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    log_file.parent.mkdir(parents=True, exist_ok=True)
    shell = (
        f"set -euo pipefail; "
        f"source {shlex_quote(str(env_file))}; "
        f"exec bash {shlex_quote(str(SERVER_SCRIPT))}"
    )
    log_handle = log_file.open("ab")
    proc = subprocess.Popen(
        ["bash", "-lc", shell],
        cwd=str(ROOT),
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    pid_file.write_text(str(proc.pid) + "\n", encoding="utf-8")
    return {"pid": proc.pid, "pid_file": str(pid_file), "log_file": str(log_file)}


def shlex_quote(value: str) -> str:
    import shlex

    return shlex.quote(value)


def execute(args: argparse.Namespace) -> int:
    if not args.yes_user_authorized:
        return _json({
            "schema_version": "lynn-qwen35-local-client-bootstrap-result-v1",
            "ok": False,
            "error": "missing_user_authorization",
            "message": "Client must pass --yes-user-authorized after the user approves local setup.",
            "plan": build_plan(args),
        }, 2)

    model_root = Path(args.model_root).expanduser()
    provider_path = Path(args.provider_config).expanduser()
    env_file = model_root / "lynn-qwen35-9b-q4km.env"
    setup_cmd = [
        "bash",
        str(SETUP_SCRIPT),
        "--variant",
        args.variant,
        "--download",
        "--smoke",
        "--model-root",
        str(model_root),
        "--host",
        args.host,
        "--port",
        str(args.port),
        "--env-file",
        str(env_file),
    ]
    if args.install_runtime:
        setup_cmd.append("--install-runtime")

    env = os.environ.copy()
    env["LYNN_PROVIDER_CONFIG"] = str(provider_path)
    _run_checked(setup_cmd, env=env)

    start_info = None
    if args.start:
        start_info = _start_server(env_file, Path(args.pid_file).expanduser(), Path(args.log_file).expanduser())
        time.sleep(1.0)

    final_plan = build_plan(args)
    return _json({
        "schema_version": "lynn-qwen35-local-client-bootstrap-result-v1",
        "ok": True,
        "provider_config": str(provider_path),
        "env_file": str(env_file),
        "started": start_info,
        "status": final_plan,
    })


def status(args: argparse.Namespace) -> int:
    return _json(build_plan(args))


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_common(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--model-root", default=str(DEFAULT_MODEL_ROOT))
        sp.add_argument("--provider-config", default=str(DEFAULT_PROVIDER))
        sp.add_argument("--variant", choices=["imatrix", "default"], default="imatrix")
        sp.add_argument("--host", default="127.0.0.1")
        sp.add_argument("--port", default="18099")
        sp.add_argument("--pid-file", default=str(DEFAULT_PID_FILE))
        sp.add_argument("--log-file", default=str(DEFAULT_LOG_FILE))

    add_common(sub.add_parser("plan", help="Return the client authorization plan JSON."))
    add_common(sub.add_parser("status", help="Return current local-provider status JSON."))

    ex = sub.add_parser("execute", help="Execute the authorized plan.")
    add_common(ex)
    ex.add_argument("--yes-user-authorized", action="store_true")
    ex.add_argument("--install-runtime", action="store_true", default=True)
    ex.add_argument("--no-install-runtime", action="store_false", dest="install_runtime")
    ex.add_argument("--start", action="store_true", help="Start persistent endpoint after setup smoke.")

    args = p.parse_args()
    if args.cmd == "execute":
        return execute(args)
    return status(args)


if __name__ == "__main__":
    raise SystemExit(main())
