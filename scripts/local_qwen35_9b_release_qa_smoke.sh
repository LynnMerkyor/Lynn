#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Qwen3.6-27B MTP Q5_K_M Release QA Smoke
#
# One-command local QA for the current Mac Q5_K_M stable track.
# Assumes the user has ALREADY started llama-server via:
#   bash scripts/local_qwen35_9b_q4km_llamacpp_server.sh
#
# Tests:
#   1. /v1/models endpoint
#   2. Plain English chat
#   3. Chinese chat
#   4. Thinking-on answer budget
#   5. JSON response_format
#   6. OpenAI tool-call contract
#   7. Short multi-turn (2 rounds)
#   8. 32K-ish long context (opt-in: SKIP_LONG=0)
#
# Output: JSON report to reports/qwen36_27b_mtp/local_qwen36_27b_mtp_release_qa_smoke_<stamp>.json
#
# Usage:
#   bash scripts/local_qwen35_9b_release_qa_smoke.sh
#   BASE_URL=http://localhost:8080/v1 bash scripts/local_qwen35_9b_release_qa_smoke.sh
#   SKIP_LONG=0 bash scripts/local_qwen35_9b_release_qa_smoke.sh
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BASE_URL="${BASE_URL:-http://127.0.0.1:18099/v1}"
MODEL="${MODEL:-qwen36-27b-dsv4pro-distill-q5km-imatrix}"
TIMEOUT="${TIMEOUT:-120}"
SKIP_LONG="${SKIP_LONG:-1}"
STAMP="${STAMP:-$(date +%Y%m%d_%H%M%S)}"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/reports/qwen36_27b_mtp}"
OUT_JSON="${OUT_DIR}/local_qwen36_27b_mtp_release_qa_smoke_${STAMP}.json"

mkdir -p "$OUT_DIR"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Qwen3.6-27B MTP Q5_K_M Release QA Smoke                 ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Endpoint:  $BASE_URL"
echo "  Model:     $MODEL"
echo "  Skip long: $SKIP_LONG"
echo "  Output:    $OUT_JSON"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Health pre-check
# ─────────────────────────────────────────────────────────────────────────────
HEALTH_URL="${BASE_URL%/v1}/health"
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 "$HEALTH_URL" 2>/dev/null)" || HTTP_CODE="000"

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "  [FAIL] Server not responding at $HEALTH_URL (HTTP $HTTP_CODE)" >&2
  echo "" >&2
  echo "  Please start the server first:" >&2
  echo "    bash scripts/local_qwen35_9b_q4km_llamacpp_server.sh" >&2
  echo "" >&2
  echo "  Low-config 9B/4B downgrade flows remain available from Settings." >&2
  exit 1
fi
echo "  [OK] Server healthy"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Run QA via embedded Python (stdlib only, no pip deps)
# ─────────────────────────────────────────────────────────────────────────────
exec python3 - "$BASE_URL" "$MODEL" "$TIMEOUT" "$SKIP_LONG" "$OUT_JSON" "$STAMP" <<'PY'
from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

base_url, model, timeout_raw, skip_long_raw, out_json, stamp = sys.argv[1:]
timeout = float(timeout_raw)
skip_long = skip_long_raw in ("1", "true", "yes")


def post(endpoint: str, payload: dict, *, max_time: float = 0) -> dict:
    url = base_url.rstrip("/") + "/" + endpoint.lstrip("/")
    if endpoint.strip("/") == "chat/completions":
        payload = dict(payload)
        payload.setdefault("chat_template_kwargs", {"enable_thinking": False})
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    t0 = time.time()
    effective_timeout = max_time if max_time > 0 else timeout
    with urllib.request.urlopen(req, timeout=effective_timeout) as resp:
        raw = resp.read().decode("utf-8", "replace")
    elapsed = time.time() - t0
    return {"data": json.loads(raw), "elapsed_sec": elapsed}


def get(endpoint: str) -> dict:
    url = base_url.rstrip("/") + "/" + endpoint.lstrip("/")
    req = urllib.request.Request(url)
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", "replace")
    elapsed = time.time() - t0
    return {"data": json.loads(raw), "elapsed_sec": elapsed}


def extract_content(resp_data: dict) -> str:
    try:
        message = resp_data["choices"][0]["message"]
        return message.get("content") or ""
    except (KeyError, IndexError, TypeError):
        return ""


def extract_reasoning(resp_data: dict) -> str:
    try:
        message = resp_data["choices"][0]["message"]
        return message.get("reasoning_content") or message.get("reasoning") or ""
    except (KeyError, IndexError, TypeError):
        return ""


def extract_text(resp_data: dict) -> str:
    content = extract_content(resp_data)
    if content.strip():
        return content
    return extract_reasoning(resp_data)


# ─────────────────────────────────────────────────────────────────────────────
results: list[dict] = []
passed = 0
failed = 0


def record(test_id: str, ok: bool, detail: str = "", **extra):
    global passed, failed
    if ok:
        passed += 1
        print(f"  [PASS] {test_id}: {detail[:80]}")
    else:
        failed += 1
        print(f"  [FAIL] {test_id}: {detail[:120]}", file=sys.stderr)
    results.append({"test_id": test_id, "ok": ok, "detail": detail, **extra})


# ─────────────────────────────────────────────────────────────────────────────
# Test 1: /v1/models
# ─────────────────────────────────────────────────────────────────────────────
print("━━━ Test 1: /v1/models ━━━")
try:
    r = get("models")
    models_list = r["data"].get("data", [])
    model_ids = [m.get("id", "") for m in models_list]
    if any(model.lower() in mid.lower() for mid in model_ids):
        record("models_endpoint", True, f"model found: {model_ids}")
    elif models_list:
        record("models_endpoint", True, f"model listed (different name): {model_ids}")
    else:
        record("models_endpoint", False, "empty model list")
except Exception as e:
    record("models_endpoint", False, str(e))

# ─────────────────────────────────────────────────────────────────────────────
# Test 2: Plain English chat
# ─────────────────────────────────────────────────────────────────────────────
print("━━━ Test 2: English chat ━━━")
try:
    r = post("chat/completions", {
        "model": model,
        "messages": [{"role": "user", "content": "What is 2+2? Answer with just the number."}],
        "max_tokens": 512,
        "temperature": 0,
    })
    content = extract_text(r["data"])
    ok = len(content.strip()) > 0 and "4" in content
    record("english_chat", ok, content.strip()[:100], elapsed_sec=r["elapsed_sec"])
except Exception as e:
    record("english_chat", False, str(e))

# ─────────────────────────────────────────────────────────────────────────────
# Test 3: Chinese chat
# ─────────────────────────────────────────────────────────────────────────────
print("━━━ Test 3: Chinese chat ━━━")
try:
    r = post("chat/completions", {
        "model": model,
        "messages": [{"role": "user", "content": "用一句话回答：中国的首都是哪里？"}],
        "max_tokens": 768,
        "temperature": 0,
    })
    content = extract_text(r["data"])
    ok = len(content.strip()) > 0
    has_beijing = "北京" in content
    record("chinese_chat", ok, f"{'北京 found' if has_beijing else content.strip()[:80]}",
           elapsed_sec=r["elapsed_sec"], has_beijing=has_beijing)
except Exception as e:
    record("chinese_chat", False, str(e))

# ─────────────────────────────────────────────────────────────────────────────
# Test 4: Thinking-on answer budget
# ─────────────────────────────────────────────────────────────────────────────
print("━━━ Test 4: Thinking-on answer budget ━━━")
try:
    r = post("chat/completions", {
        "model": model,
        "messages": [{"role": "user", "content": "默认本地27B MTP门禁测试：请只回复 OK。"}],
        "max_tokens": 8192,
        "temperature": 0,
        "chat_template_kwargs": {"enable_thinking": True},
    }, max_time=300)
    content = extract_content(r["data"]).strip()
    reasoning = extract_reasoning(r["data"])
    ok = content == "OK"
    record("thinking_on_budget", ok, content[:100] or "(empty content)",
           elapsed_sec=r["elapsed_sec"], reasoning_chars=len(reasoning))
except Exception as e:
    record("thinking_on_budget", False, str(e))

# ─────────────────────────────────────────────────────────────────────────────
# Test 5: JSON response_format
# ─────────────────────────────────────────────────────────────────────────────
print("━━━ Test 5: JSON response_format ━━━")
try:
    r = post("chat/completions", {
        "model": model,
        "messages": [
            {"role": "system", "content": "You output JSON only. No markdown fences."},
            {"role": "user", "content": 'Return a JSON object: {"model":"qwen3.5-9b","quant":"Q4_K_M","ready":true}'},
        ],
        "max_tokens": 1024,
        "temperature": 0,
        "response_format": {"type": "json_object"},
    })
    content = extract_content(r["data"]).strip()
    # Strip markdown fences if present
    if content.startswith("```"):
        lines = content.split("\n")
        content = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
    parsed = json.loads(content)
    ok = isinstance(parsed, dict)
    record("json_format", ok, json.dumps(parsed)[:100], elapsed_sec=r["elapsed_sec"])
except json.JSONDecodeError as e:
    record("json_format", False, f"JSON parse error: {e}", raw_content=content[:200])
except Exception as e:
    record("json_format", False, str(e))

# ─────────────────────────────────────────────────────────────────────────────
# Test 6: OpenAI tool-call contract
# ─────────────────────────────────────────────────────────────────────────────
print("━━━ Test 6: Tool call contract ━━━")
try:
    r = post("chat/completions", {
        "model": model,
        "messages": [
            {"role": "user", "content": "Call get_weather for Beijing. Do not answer directly."},
        ],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Get weather for one city.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "location": {"type": "string"},
                        },
                        "required": ["location"],
                    },
                },
            }
        ],
        "tool_choice": "auto",
        "max_tokens": 128,
        "temperature": 0,
    })
    choice = (r["data"].get("choices") or [{}])[0]
    message = choice.get("message") or {}
    tool_calls = message.get("tool_calls") or []
    raw = json.dumps(message, ensure_ascii=False)
    ok = any(
        (call.get("function") or {}).get("name") == "get_weather"
        and "beijing" in json.dumps(call.get("function") or {}, ensure_ascii=False).lower()
        for call in tool_calls
    )
    record("tool_call_weather", ok, raw[:200], elapsed_sec=r["elapsed_sec"],
           finish_reason=choice.get("finish_reason"), tool_calls=tool_calls)
except Exception as e:
    record("tool_call_weather", False, str(e))

# ─────────────────────────────────────────────────────────────────────────────
# Test 7: Multi-turn (2 rounds)
# ─────────────────────────────────────────────────────────────────────────────
print("━━━ Test 7: Multi-turn ━━━")
try:
    messages = [{"role": "user", "content": "Remember this number: 42."}]
    r1 = post("chat/completions", {
        "model": model,
        "messages": messages,
        "max_tokens": 768,
        "temperature": 0,
    })
    c1 = extract_text(r1["data"])
    messages.append({"role": "assistant", "content": c1})
    messages.append({"role": "user", "content": "What number did I ask you to remember?"})
    r2 = post("chat/completions", {
        "model": model,
        "messages": messages,
        "max_tokens": 768,
        "temperature": 0,
    })
    c2 = extract_text(r2["data"])
    ok = "42" in c2
    record("multi_turn", ok, f"Round 2: {c2.strip()[:80]}",
           elapsed_sec=r1["elapsed_sec"] + r2["elapsed_sec"])
except Exception as e:
    record("multi_turn", False, str(e))

# ─────────────────────────────────────────────────────────────────────────────
# Test 8: 32K-ish long context (opt-in)
# ─────────────────────────────────────────────────────────────────────────────
print("━━━ Test 8: Long context (32K) ━━━")
if skip_long:
    record("long_context_32k", True, "SKIPPED (SKIP_LONG=1)", skipped=True)
else:
    try:
        # Generate ~28K chars of filler + a needle
        filler = "The quick brown fox jumps over the lazy dog. " * 700  # ~31.5K chars
        needle = "The secret code is PINEAPPLE-7749."
        # Insert needle in the middle
        mid = len(filler) // 2
        long_prompt = filler[:mid] + " " + needle + " " + filler[mid:]
        r = post("chat/completions", {
            "model": model,
            "messages": [
                {"role": "user", "content": long_prompt + "\n\nWhat is the secret code mentioned above?"},
            ],
            "max_tokens": 1024,
            "temperature": 0,
        }, max_time=300)
        content = extract_text(r["data"])
        ok = "PINEAPPLE" in content.upper() or "7749" in content
        record("long_context_32k", ok, content.strip()[:100], elapsed_sec=r["elapsed_sec"])
    except Exception as e:
        record("long_context_32k", False, str(e))

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
total = passed + failed
all_ok = failed == 0

report = {
    "schema": "lynn-qwen36-27b-mtp-q5km-release-qa-smoke-v1",
    "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
    "stamp": stamp,
    "base_url": base_url,
    "model": model,
    "skip_long": skip_long,
    "passed": passed,
    "failed": failed,
    "total": total,
    "all_ok": all_ok,
    "results": results,
}

out_path = Path(out_json)
out_path.parent.mkdir(parents=True, exist_ok=True)
out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

print("")
print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
print(f"  Results: {passed} passed, {failed} failed ({total} total)")
print(f"  Report:  {out_json}")
if all_ok:
    print("  Status:  ALL PASS ✓")
else:
    print("  Status:  SOME FAILURES ✗")
print("")
raise SystemExit(0 if all_ok else 2)
PY
