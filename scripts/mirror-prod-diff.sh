#!/usr/bin/env bash
# mirror-prod-diff.sh — brain-v2-mirror(repo .ts 源)↔ prod(Tencent /opt/lobster-brain-v2 .js)漂移检测。
#
# 背景:prod 不走 git,历史上靠手工 surgical edit 同步,积累过 mirror↔prod 漂移
#(mimo reconcile 还过一次债)。本脚本只读不写,发布/部署前跑一遍:
#   1) 本地 mirror tsc --noEmit(类型门)
#   2) 远端逐文件对比:@ts-nocheck 的文件应当与 prod .js 逐字一致(strip 后缀差异);
#      真 TS 文件(router/registry/server/auth 等)无法直接比对源码,改比「关键锚点」:
#      provider 名单 / universalOrder / 工具名单等 grep 锚点,两边各取一份对照。
#
# 用法: scripts/mirror-prod-diff.sh [ssh-host]   # 默认 host = tencent
set -uo pipefail

HOST="${1:-tencent}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIRROR="$ROOT/brain-v2-mirror"
PROD="/opt/lobster-brain-v2"
PORT="${BRAIN_V2_PORT:-8790}"
FAIL=0
WARN=0

note() { printf '%s\n' "$*"; }
fail() { printf '✗ %s\n' "$*"; FAIL=1; }
warn() { printf '⚠ %s\n' "$*"; WARN=$((WARN+1)); }
ok()   { printf '✓ %s\n' "$*"; }

note "== ① mirror 本地类型门 =="
if (cd "$MIRROR" && npx tsc --noEmit -p tsconfig.json); then
  ok "tsc --noEmit clean"
else
  fail "mirror tsc 失败 — 先修类型再谈部署"
fi

note ""
note "== ② @ts-nocheck 文件逐字比对(可 verbatim 部署的那批)=="
# 这批文件 prod 直接以 .js 跑同样内容;内容漂移 = 有人单边改过。
NOCHECK_FILES=$(grep -rl "^// @ts-nocheck\|^//@ts-nocheck" "$MIRROR" --include="*.ts" | grep -v __tests__ | grep -v scripts/ || true)
for f in $NOCHECK_FILES; do
  rel="${f#"$MIRROR"/}"
  prod_js="$PROD/${rel%.ts}.js"
  remote=$(ssh "$HOST" "cat '$prod_js' 2>/dev/null" || true)
  if [ -z "$remote" ]; then
    fail "$rel → prod 缺 ${rel%.ts}.js"
    continue
  fi
  # -wB:忽略空白与空行(JS 不敏感;prod 侧历史上被格式化过)。真内容漂移照抓。
  # 注意:曾经 tsc 编译过的 prod 文件会有花括号/单行 if 重排,diff 文本无法归一 —
  # 这类差异降级为 ⚠ 人工复核,不挡退出码;部署安全的硬信号是 tsc 门 + ③ 锚点。
  if diff -wB -q <(printf '%s' "$remote") "$f" >/dev/null 2>&1; then
    ok "$rel ≡ prod (content)"
  else
    drift=$(diff -wB <(printf '%s' "$remote") "$f" | head -8)
    warn "$rel 与 prod 文本有差(可能仅 tsc 重排,需人工过目):"
    printf '%s\n' "$drift" | sed 's/^/    /'
  fi
done
[ -z "$NOCHECK_FILES" ] && note "  (没有 @ts-nocheck 文件)"

note ""
note "== ③ 真 TS 文件锚点对照(provider 名单 / 路由链 / 工具名单)=="
anchor() {
  local label="$1" local_cmd="$2" remote_cmd="$3"
  local lv rv
  lv=$(eval "$local_cmd" | sort | tr '\n' ' ')
  rv=$(ssh "$HOST" "$remote_cmd" | sort | tr '\n' ' ')
  if [ "$lv" = "$rv" ]; then
    ok "$label 一致: $lv"
  else
    fail "$label 漂移:"
    printf '    mirror: %s\n    prod  : %s\n' "$lv" "$rv"
  fi
}

anchor "provider ids" \
  "grep -o \"providerId('[^']*')\" '$MIRROR/provider-registry.ts' | sed \"s/providerId('\\(.*\\)')/\\1/\" | sort -u" \
  "grep -o \"providerId('[^']*')\" '$PROD/provider-registry.js' | sed \"s/providerId('\\(.*\\)')/\\1/\" | sort -u"

anchor "server tools" \
  "grep -o \"name: '[a-z_]*'\" '$MIRROR/tool-exec/index.ts' | sed \"s/name: '\\(.*\\)'/\\1/\" | sort -u" \
  "grep -o \"name: '[a-z_]*'\" '$PROD/tool-exec/index.js' | sed \"s/name: '\\(.*\\)'/\\1/\" | sort -u"

note ""
note "== ④ prod 运行态 smoke(ESM import / health / route)=="
if ssh "$HOST" "cd '$PROD' && node --input-type=module -e \"await import('./provider-registry.js'); await import('./tool-exec/index.js'); await import('./router.js'); console.log('esm-import-ok')\"" >/dev/null; then
  ok "prod 关键模块 ESM import clean"
else
  fail "prod 关键模块 ESM import 失败 — 远端 JS 可能缺 export/import 或依赖漂移"
fi

health_json=$(ssh "$HOST" "curl -fsS --max-time 5 'http://127.0.0.1:$PORT/health'" 2>/dev/null || true)
if printf '%s' "$health_json" | grep -q '"brain":"v2"'; then
  ok "prod /health ok"
else
  fail "prod /health 失败或不是 brain=v2: ${health_json:-<empty>}"
fi

local_route=$(cd "$MIRROR" && node --import tsx -e "const { getProviderStatusSnapshot } = await import('./provider-registry.ts'); console.log(getProviderStatusSnapshot().route.join(' '));" 2>/dev/null || true)
remote_route=$(ssh "$HOST" "node --input-type=module -e \"const r = await fetch('http://127.0.0.1:$PORT/v2/providers/status'); if (!r.ok) throw new Error('/v2/providers/status HTTP ' + r.status); const j = await r.json(); console.log((j.route || []).join(' '));\"" 2>/dev/null || true)
if [ -n "$local_route" ] && [ "$local_route" = "$remote_route" ]; then
  ok "运行态 route 一致: $local_route"
else
  fail "运行态 route 漂移:"
  printf '    mirror: %s\n    prod  : %s\n' "${local_route:-<empty>}" "${remote_route:-<empty>}"
fi

note ""
if [ "$FAIL" -ne 0 ]; then
  note "== 结果:硬信号失败(tsc 门 / 锚点 / 运行态 smoke,见 ✗)。部署前必须人工 reconcile,严禁 wholesale 转译覆盖 prod。=="
  exit 1
fi
if [ "$WARN" -gt 0 ]; then
  note "== 结果:硬信号全过(tsc + 锚点);$WARN 个文件文本有差(⚠,多为 tsc 重排),建议抽查。=="
else
  note "== 结果:mirror 与 prod 完全对齐(类型门 + verbatim 文件 + 锚点)=="
fi
