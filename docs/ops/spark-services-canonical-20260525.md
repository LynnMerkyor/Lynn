# Spark 服务 canonical 清单 (2026-05-25)

> DGX Spark GB10(sm_121,119 GiB unified mem,3.6T disk,CUDA 13.0,llama.cpp build 161)
> 当前角色:Lynn 桌面端 Brain v2 cascade **第二位 fallback**(MiMo ⭐ 后第一硬件级 fallback)+ 语音/ASR/TTS 服务后端

---

## TL;DR — Spark 长期只跑这 4 类

1. **35B APEX-MTP llama.cpp**(Brain v2 cascade #2)— `lynn-apex-mtp-llamacpp.service` 端口 18098
2. **语音 / ASR / Emotion**(Lynn 桌面端实时语音链路)— 端口 18000-18099 区间
3. **反向 SSH 隧道到 Tencent**(`dgx-reverse-tunnel*.service`)— 让 Brain v2 mirror 透过隧道访问 Spark 上游
4. **frpc**(应用层兜底通道,autossh 挂时救急)— `frpc.service`

**严禁长期驻留**:
- ❌ 4B/9B/27B 的 llama-server / SGLang / vLLM eval 服务(eval 跑完立刻杀)
- ❌ lynn-engine SP-* 系列实验进程
- ❌ R1 NVFP4 / W4A8 实验 docker 容器
- ❌ quality-eval 后台 poll 脚本

---

## 保留服务详表

| Unit | 端口 | 隧道 | Restart 策略 | 资源占用 | Log channel |
|---|---|---|---|---|---|
| **`lynn-apex-mtp-llamacpp.service`** | 127.0.0.1:18098 | ✅ via `dgx-reverse-tunnel-apex` → Tencent | `always`,15s 间隔,5/300s 上限 | ~42-55 GB stable(35B + KV q8 + MTP draft + prompt cache),当前 ctx-size=262144(每 slot 64K)| `journalctl -u lynn-apex-mtp-llamacpp` |
| `lynn-qwen3-asr.service` | 0.0.0.0:18007 | 走 frpc | `always`,10s 间隔 | <1GB | journal |
| `lynn-emotion2vec.service` | (HTTP) | 走 frpc | `always` | <500MB | journal |
| `sensevoice_server.py`(PID 静态,/opt/voice) | (local) | — | 用户态(无 systemd) | <600MB | stdout |
| **`dgx-reverse-tunnel-apex.service`** | `-R 127.0.0.1:18098` to Tencent | autossh | `always`,2s 间隔 | minimal | journal |
| `dgx-reverse-tunnel.service` | DGX 主通道 | autossh | `always` | minimal | journal |
| `frpc.service` | application-layer fallback | — | `always` | minimal | journal |

---

## Brain v2 cascade canonical 顺序

```
MiMo ⭐                                          ← 主力(api.merkyorlynn.com)
  ↓ (不可用 / 高负载 / 429)
Spark Qwen3.6-35B-A3B APEX-MTP                  ← 本表第一档
  ↓ (Spark 离线 / tunnel 抖断)
DeepSeek V4
  ↓
GLM-5
  ↓
Kimi K2.6
  ↓
Step / MiniMax
```

Brain v2 mirror(Tencent `<tencent-edge-ip>`)→ `127.0.0.1:18098`(via reverse tunnel)→ Spark `127.0.0.1:18098`(`lynn-apex-mtp-llamacpp.service`)。

---

## 启停 / 状态 / 日志 一行命令

```bash
# 状态
systemctl status lynn-apex-mtp-llamacpp.service
ss -tlnp | grep :18098
curl -sS http://127.0.0.1:18098/health

# 日志
journalctl -u lynn-apex-mtp-llamacpp.service -f
journalctl -u lynn-apex-mtp-llamacpp.service --since '1 hour ago'

# 启停
sudo systemctl {start,stop,restart} lynn-apex-mtp-llamacpp.service

# 隧道健康
systemctl show dgx-reverse-tunnel-apex.service -p NRestarts,ActiveEnterTimestamp
journalctl -u dgx-reverse-tunnel-apex.service --since '24 hours ago' | grep -ciE 'restart|fail|error|disconnect'
```

---

## TPS 参考(2026-05-25 bench,Spark GB10 / llama.cpp b161)

| 场景 | 单流 decode TPS | aggregate TPS | MTP accept | 备注 |
|---|---|---|---|---|
| c=1 think-off 200 tok(冷启短答) | **53.2** avg | 47-56 | 26-38% | 短答 MTP 命中率低 |
| c=2 think-off 200 tok | 26 per-stream | 48.4 agg | 25.6% | 2 路 split 几乎不增 |
| c=4 think-off 200 tok(满 slot) | 15 per-stream | 57.0 agg | 29.8% | agg 比 1 路只 +7% |
| ⭐ **c=1 think-on 4K(Brain v2 fallback 真实)** | **79.0** | 78.4 | **60.6%** | **canonical 引用数字** |

**Brain v2 fallback 实际工况 = 79 tok/s think-on 持续**(不是短答 53)。c=1-2 是常态,c=4 是 burst 上限。bench 原始数据见 `docs/ops/spark-apex-mtp-bench-20260525.md`(如已落盘)。

---

## 应急 — 完全重建 APEX-MTP service

如果 `lynn-apex-mtp-llamacpp.service` unit 文件意外被删,或需要换模型/参数,canonical unit 内容:

```ini
[Unit]
Description=Lynn V0.79 Qwen3.6-35B-A3B APEX-MTP llama.cpp server (Brain v2 fallback #2)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=<spark-user>
Group=<spark-user>
WorkingDirectory=/home/<spark-user>
Nice=-5
LimitNOFILE=65536

ExecStartPre=/bin/sh -c 'test -f /home/<spark-user>/models/Qwen3.6-35B-A3B-APEX-MTP-GGUF/Qwen3.6-35B-A3B-APEX-MTP-I-Balanced.gguf'
ExecStart=/home/<spark-user>/build/llama.cpp/build-cuda-sm121/bin/llama-server \
  -m /home/<spark-user>/models/Qwen3.6-35B-A3B-APEX-MTP-GGUF/Qwen3.6-35B-A3B-APEX-MTP-I-Balanced.gguf \
  --host 127.0.0.1 \
  --port 18098 \
  -a qwen36-35b-a3b-apex-mtp \
  --ctx-size 262144 \
  --parallel 4 \
  --threads 4 \
  --n-gpu-layers 999 \
  -fa on \
  --jinja \
  --spec-type draft-mtp \
  --spec-draft-n-max 4 \
  --cache-type-k q8_0 \
  --cache-type-v q8_0 \
  --reasoning auto \
  --reasoning-budget -1 \
  --metrics

TimeoutStartSec=600
Restart=always
RestartSec=15
StandardOutput=journal
StandardError=journal
SyslogIdentifier=lynn-apex-mtp-llamacpp

[Install]
WantedBy=multi-user.target
```

重建步骤:
```bash
sudo tee /etc/systemd/system/lynn-apex-mtp-llamacpp.service < /tmp/unit.ini
sudo systemctl daemon-reload
sudo systemctl enable --now lynn-apex-mtp-llamacpp.service
```

---

## 健康全套体检(粘贴即跑)

```bash
ssh dgx-spark bash << 'EOF'
echo "── 关键服务 ──"
systemctl is-active lynn-apex-mtp-llamacpp.service lynn-qwen3-asr.service lynn-emotion2vec.service dgx-reverse-tunnel-apex.service frpc.service
echo
echo "── 监听端口 ──"
ss -tlnp 2>/dev/null | grep -E ':18098|:18007|:18099' | head -5
echo
echo "── APEX 端点存活 ──"
curl -sS -m 5 http://127.0.0.1:18098/health
echo
echo "── 资源 ──"
free -h | head -3
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader 2>/dev/null
echo
echo "── 反向隧道 24h 抖动数 ──"
journalctl -u dgx-reverse-tunnel-apex.service --since '24 hours ago' --no-pager 2>/dev/null | grep -ciE 'restart|fail|error|disconnect'
EOF
```

---

## 历史 cleanup log

| 日期 | 动作 |
|---|---|
| 2026-05-25 | 杀 PID 617288(4B Q4_K_M-imatrix llama-server,12h 老);杀 PID 655578(9B Q4_K_M-imatrix-mtp llama-server);杀 PID 580833(quality-eval poll bash);reset-failed `dgx-reverse-tunnel-qwen36.service` 死 unit;`docker rm` 16 个 4-9 天前 lynn-eval/vflash exited 容器;部署 `lynn-apex-mtp-llamacpp.service` 上线 Brain v2 cascade #2 fallback。 |
| 2026-05-25 | bench(32K-per-slot 配置):c=1 think-off 53 / c=4 agg 57 / c=1 think-on **79** tok/s · MTP accept 60.6%(think-on 长生成路径)。 |
| 2026-05-25 (晚) | **`--ctx-size` 32768 → 262144**(每 slot 64K × 4 路并发),稳态内存 ~42 GiB → ~55 GiB used,available 余 ~65-77 GiB。试用期,如不稳可改回 32768。 |

---

## 不要忘的硬件 caveat

- **Spark sm_121 没有 native FP4 MMA**(ptxas reject `f8f6f4` / `e2m1x2`)— Lynn-native NVFP4 W4A16 路线在 Spark 跑 38.96 TPS,llama.cpp Q4_K_M 跑 69-79 TPS。**Spark 主路径 llama.cpp,不要再试 NVFP4 native**。
- **GB10 是 unified mem**(119 GiB),不是 dedicated GPU mem,启动 docker / 大 process 前必先 `free -h` 算预算。
- **35B Q4_K_M 加载约 30 秒**,`TimeoutStartSec=600` 留充足。
- **MTP accept rate 跟生成内容相关**:短答 25-38%,长 thinking 段 60%+。**短答场景不要期望 MTP 加速,长 reasoning / Brain v2 fallback 才发挥**。

---

*Last updated: 2026-05-25 · 见 git log 跟踪后续变更*
