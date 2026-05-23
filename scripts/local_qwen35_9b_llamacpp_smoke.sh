#!/usr/bin/env bash
set -euo pipefail

# Lightweight first-run smoke used by local_qwen35_9b_setup.sh.
# It starts a transient llama.cpp server, verifies the OpenAI-compatible
# endpoint, sends one short prompt, then shuts the server down. Full release
# QA lives in scripts/local_qwen35_9b_release_qa_smoke.sh.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_SCRIPT="$ROOT/scripts/local_qwen35_9b_q4km_llamacpp_server.sh"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-18099}"
SERVED_NAME="${SERVED_NAME:-qwen35-4b-q4km}"
SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-900}"
LOG_DIR="${LOG_DIR:-$HOME/.lynn-engine/logs}"
LOG_FILE="${LOG_FILE:-$LOG_DIR/qwen35_4b_smoke_${PORT}.log}"

mkdir -p "$LOG_DIR"

cleanup() {
  if [[ -n "${SPID:-}" ]] && kill -0 "$SPID" 2>/dev/null; then
    kill "$SPID" 2>/dev/null || true
    sleep 2
    kill -9 "$SPID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if curl -fsS --max-time 2 "http://$HOST:$PORT/v1/models" >/dev/null 2>&1; then
  echo "[qwen35-smoke] reusing existing llama.cpp server on $HOST:$PORT"
else
  echo "[qwen35-smoke] starting transient llama.cpp server on $HOST:$PORT"
  HOST="$HOST" \
  PORT="$PORT" \
  SERVED_NAME="$SERVED_NAME" \
  GGUF="${GGUF:-}" \
  LLAMA_SERVER="${LLAMA_SERVER:-}" \
  CTX_SIZE="${CTX_SIZE:-32768}" \
  PARALLEL="${PARALLEL:-1}" \
  N_GPU_LAYERS="${N_GPU_LAYERS:-999}" \
  LOG_FILE="$LOG_FILE" \
    bash "$SERVER_SCRIPT" > "$LOG_FILE" 2>&1 &
  SPID=$!
fi

python3 - <<'PY'
import json
import os
import sys
import time
import urllib.error
import urllib.request

host = os.environ.get("HOST", "127.0.0.1")
port = int(os.environ.get("PORT", "18099"))
model = os.environ.get("SERVED_NAME", "qwen35-4b-q4km")
timeout = float(os.environ.get("SMOKE_TIMEOUT", "900"))
base = f"http://{host}:{port}"
deadline = time.time() + timeout

def get(path, wait=False):
    while True:
        try:
            with urllib.request.urlopen(base + path, timeout=3) as resp:
                return resp.status, resp.read().decode("utf-8", "ignore")
        except Exception:
            if not wait or time.time() > deadline:
                raise
            time.sleep(1)

get("/v1/models", wait=True)

payload = {
    "model": model,
    "messages": [
        {"role": "system", "content": "You are Lynn local smoke test."},
        {"role": "user", "content": "用一句中文回答：本地模型是否已经启动？"},
    ],
    "max_tokens": 512,
    "temperature": 0,
    "chat_template_kwargs": {"enable_thinking": False},
}
req = urllib.request.Request(
    base + "/v1/chat/completions",
    data=json.dumps(payload).encode("utf-8"),
    headers={"Content-Type": "application/json", "Authorization": "Bearer local"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        body = json.loads(resp.read().decode("utf-8", "ignore"))
except urllib.error.HTTPError as exc:
    print(exc.read().decode("utf-8", "ignore"), file=sys.stderr)
    raise

choice = (body.get("choices") or [{}])[0]
message = choice.get("message") or {}
content = (message.get("content") or "").strip()
reasoning = (message.get("reasoning_content") or "").strip()
usage = body.get("usage") or {}
completion_tokens = int(usage.get("completion_tokens") or 0)
if not content and not reasoning and completion_tokens <= 0:
    raise SystemExit("empty smoke response")

print(json.dumps({
    "ok": True,
    "base_url": base + "/v1",
    "model": model,
    "finish_reason": choice.get("finish_reason"),
    "completion_tokens": completion_tokens,
    "content_head": content[:120],
    "reasoning_head": reasoning[:120],
}, ensure_ascii=False, indent=2))
PY

echo "[qwen35-smoke] passed"
