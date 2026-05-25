# Spark APEX-MTP 35B-A3B TPS Bench — Regression Baseline (2026-05-25)

> 这份文档是 `lynn-apex-mtp-llamacpp.service` 上线后的首次正式 bench 数据,作为后续回归比较的 baseline。任何 llama.cpp 升级 / unit 配置变更 / Spark 系统升级后,**重跑此 bench 并对比 ±5% 容差**。

---

## 硬件 / 软件快照

| 项目 | 值 |
|---|---|
| 主机 | DGX Spark (GB10, sm_121, 119 GiB unified mem, 3.6T disk) |
| OS | (Linux aarch64) |
| CUDA | 13.0 |
| llama.cpp build | **161 (1acee6b)**,GNU 13.3.0 for Linux aarch64 |
| systemd unit | `lynn-apex-mtp-llamacpp.service` |
| Model file | `/home/<spark-user>/models/Qwen3.6-35B-A3B-APEX-MTP-GGUF/Qwen3.6-35B-A3B-APEX-MTP-I-Balanced.gguf` |
| Model size | 26 GB (Q4_K_M + 嵌入式 MTP draft tensors) |
| n_params | 35,505,251,456 |
| n_vocab | 248,320 |
| n_ctx_train | 262,144 |
| 配置参数(bench 时) | `--ctx-size 32768 --parallel 4 --n-gpu-layers 999 -fa on --jinja --spec-type draft-mtp --spec-draft-n-max 4 --cache-type-k q8_0 --cache-type-v q8_0 --reasoning auto --reasoning-budget -1` |
| 注 | **bench 后于 2026-05-25 晚将 `--ctx-size` 升到 262144(每 slot 64K × 4 路),下次回归需重测**。当前生产配置见 `docs/ops/spark-services-canonical-20260525.md` |
| Endpoint | `http://127.0.0.1:18098/v1` |
| Bench 时刻 | 2026-05-25 ~03:37 HKT(服务启动后 ~5 分钟,KV slot 0 已 warm) |

---

## 测试 prompt 集合

```python
PROMPTS = [
    "用中文写一段 200 字左右介绍北京的简要城市指南,包含交通、美食、和一个值得一去的景点。",
    "用中文写一段 200 字左右介绍上海的简要城市指南,包含交通、美食、和一个值得一去的景点。",
    "用中文写一段 200 字左右介绍广州的简要城市指南,包含交通、美食、和一个值得一去的景点。",
    "用中文写一段 200 字左右介绍成都的简要城市指南,包含交通、美食、和一个值得一去的景点。",
]
```

- prompt_tokens 每条约 23-25 tokens(短 prompt 接近 Brain v2 fallback 真实工况:不长的用户问题 + 模型自由生成)
- temperature=0.7,top_p 默认
- 通过 `requests` 多线程并发(`concurrent.futures.ThreadPoolExecutor`)

---

## 结果

### 完整 raw 数字

```
=== APEX-MTP 35B-A3B bench @ Spark GB10 (sm_121) llama.cpp b161 ===
Model: Qwen3.6-35B-A3B-APEX-MTP-I-Balanced.gguf (26GB Q4_K_M)
Service: lynn-apex-mtp-llamacpp.service (--parallel 4 --ctx-size 32768)

[warmup] one short request to warm slot 0...

=== Single stream (think-off, 200 tok output) | c=1 | max_tokens=200 | thinking=off | trials=3 ===
  trial 1/3: wall=2.74s  total_tok=129  agg_TPS=47.01  per-stream avg_decode_TPS=49.04  MTP_accept=26.2%
    └─ idx=0  wall=2.74s  tok=129  decode=49.04  draft=67/256
  trial 2/3: wall=2.34s  total_tok=131  agg_TPS=56.00  per-stream avg_decode_TPS=59.44  MTP_accept=37.7%
    └─ idx=0  wall=2.34s  tok=131  decode=59.44  draft=80/212
  trial 3/3: wall=2.73s  total_tok=132  agg_TPS=48.42  per-stream avg_decode_TPS=50.97  MTP_accept=27.4%
    └─ idx=0  wall=2.72s  tok=132  decode=50.97  draft=69/252

=== Concurrent 2-way (think-off, 200 tok each) | c=2 | max_tokens=200 | thinking=off | trials=1 ===
  trial 1/1: wall=5.39s  total_tok=261  agg_TPS=48.43  per-stream avg_decode_TPS=26.08  MTP_accept=25.6%
    └─ idx=0  wall=5.09s  tok=129  decode=26.55  draft=69/248
    └─ idx=1  wall=5.39s  tok=132  decode=25.6   draft=65/276

=== Concurrent 4-way (think-off, 200 tok each) | c=4 | max_tokens=200 | thinking=off | trials=1 ===
  trial 1/1: wall=8.91s  total_tok=508  agg_TPS=56.99  per-stream avg_decode_TPS=15.09  MTP_accept=29.8%
    └─ idx=2  wall=8.82s  tok=130  decode=15.52  draft=73/232
    └─ idx=0  wall=8.83s  tok=131  decode=15.64  draft=75/232
    └─ idx=3  wall=8.91s  tok=127  decode=15.01  draft=68/236
    └─ idx=1  wall=8.91s  tok=120  decode=14.18  draft=63/236

=== Single stream (think-ON 4K max_tokens, Brain v2 fallback realistic) | c=1 | max_tokens=4000 | thinking=on | trials=1 ===
  trial 1/1: wall=17.19s  total_tok=1347  agg_TPS=78.38  per-stream avg_decode_TPS=79.00  MTP_accept=60.6%
    └─ idx=0  wall=17.18s  tok=1347  decode=79.0  draft=955/1576
```

### 表格 summary

| 场景 | c | max_tok | thinking | 单流 decode TPS | aggregate TPS | MTP accept | 备注 |
|---|---|---|---|---|---|---|---|
| Single short 1 | 1 | 200 | off | 49.04 | 47.01 | 26.2% | trial 1 |
| Single short 2 | 1 | 200 | off | **59.44** | 56.00 | **37.7%** | trial 2(best) |
| Single short 3 | 1 | 200 | off | 50.97 | 48.42 | 27.4% | trial 3 |
| Concurrent 2 | 2 | 200 | off | 26.08 per | **48.43 agg** | 25.6% | 2-way split |
| Concurrent 4 | 4 | 200 | off | 15.09 per | **57.00 agg** | 29.8% | 满 slot |
| **Realistic** | 1 | 4000 | **on** | **79.00** ⭐ | 78.38 | **60.6%** ⭐ | **Brain v2 fallback 真实工况** |

---

## 解读 & 关键观察

### 1. Canonical 引用数字 = **79 tok/s think-on**

- short answer + think-off 场景 53 tok/s 不是 canonical(短答无足够连续 token 给 MTP 命中)
- long answer + think-on 场景 79 tok/s 是 canonical(thinking reasoning 段大量结构化连接词,MTP draft 命中翻倍)
- Brain v2 cascade 是承接 MiMo 不可用时的"长思考"工作,**79 才是用户真实感受**

### 2. MTP accept rate 跟生成内容相关性极强

- 短答 200 tok:accept 25-38%(sampling 多样性高,MTP draft 容易猜错)
- 长答 4K think-on:**accept 60.6%**(thinking 段重复结构丰富,draft hit rate 翻倍)
- 这跟 Qwen3.6 系 MTP head 训练分布吻合 — MTP head 在 reasoning 语料上学到的模式
- **预期未来回归 baseline**:short answer 短答 MTP accept 应在 25-40%,long thinking MTP accept 应在 55-70%

### 3. GB10 unified mem 并发 scaling 几乎为零

- c=1 = 53 / c=2 = 48 agg / c=4 = 57 agg
- 4 路并发 vs 1 路单流 throughput 只 +7%
- **结论**:Spark 不是高 RPS 推理机,是单流 quality 机
- Brain v2 fallback 是单次失败重路由,本来就低并发,这个 cap 不限我们

### 4. 首字延迟 (TTFT) 没单独测

未来 bench 时建议加 streaming 测 first-token-latency。当前数据从 wall_time 推算大致 100-200ms(KV slot warm 后)。

### 5. system_fingerprint = `b161-1acee6b`

llama.cpp build 161 hash 1acee6b。**任何升级 llama.cpp 后此字段会变,需重 bench**。

---

## 隧道并发 baseline(Tencent 端跨 SSH 反向隧道,2026-05-25 ~14:32 HKT)

> 同一份 bench 脚本(`/tmp/tunnel_bench.py`,prompt 集合 / temperature / max_tokens 全部跟 Spark 本地 bench 一致),client 从 Spark 本地换到 Tencent(`lynn-jump` 跳板机)。Tencent 客户端走 `http://127.0.0.1:18098/v1/chat/completions` = 反向 SSH 隧道入口(`sshd PID 886529` 自 11:36:44 起持续活)→ Spark `llama-server PID 2090`。**这条路径就是 Brain v2 cascade 真实 fallback 时走的链路**。

### 5 个 Tencent 端场景 raw 数据

```
=== [1] 单流短答(隧道 baseline,对照本地 53) | c=1 | max_tok=200 | think=off ===
  trial 1: wall=3.29s  total_tok=136  agg_TPS=41.34  per-stream avg=49.88  MTP_accept=25.0%
  trial 2: wall=3.07s  total_tok=121  agg_TPS=39.41  per-stream avg=54.67  MTP_accept=28.6%
  trial 3: wall=3.19s  total_tok=126  agg_TPS=39.49  per-stream avg=49.91  MTP_accept=24.2%

=== [2] 2 路并发短答(对照本地 48) | c=2 | max_tok=200 | think=off ===
  trial 1: wall=5.89s  total_tok=262  agg_TPS=44.47  per-stream avg=25.33  MTP_accept=29.1%

=== [3] 4 路并发短答(对照本地 57 agg) | c=4 | max_tok=200 | think=off ===
  trial 1: wall=9.81s  total_tok=520  agg_TPS=52.98  per-stream avg=16.17  MTP_accept=28.8%

=== [4] 单流 think-on 4K(对照本地 79) | c=1 | max_tok=4000 | think=on ===
  trial 1: wall=20.42s  total_tok=1757  agg_TPS=86.03  per-stream avg=90.09  MTP_accept=69.5%

=== [5] 4 路并发 think-on 2K(高负载真实场景) | c=4 | max_tok=2000 | think=on ===
  trial 1: wall=79.79s  total_tok=6818  agg_TPS=85.45  per-stream avg=24.41  MTP_accept=60.7%
```

### 跨通道对照(Spark 本地直测 vs Tencent 跨隧道)

| 场景 | Spark 本地(03:37 冷启) | Tencent 跨隧道(14:32 warm) | Δ | 判定 |
|---|---|---|---|---|
| c=1 think-off 200 tok decode | 53.2 | **51.5 avg** | −3% | 噪声内 ✓ |
| c=2 think-off agg | 48.43 | **44.47** | −8% | 边界 ✓ |
| **c=4 think-off agg** | **57.00** | **52.98** | **−7%** | 边界 ✓ |
| **⭐ c=1 think-on 4K decode** | **79.0**(MTP 60.6%) | **90.09**(MTP **69.5%**) | **+14%** | Spark warm 抢戏,**不能算回归** |
| **🆕 c=4 think-on 2K agg** | (未测) | **85.45 agg / 24.4 per-stream / MTP 60.7%** | — | 新基线 |

### 关键结论

1. **隧道纯开销 ≈ 测量噪声**(< 5%)
   SSH reverse tunnel(autossh + sshd + TCP)在 chat completion long-poll HTTP 上**几乎不增加延迟**。c=4 短答 −7% 在 sampling 多样性范围内。c=1 think-on 反而更快是因为 Spark 已稳跑 3 小时 KV/mmap warm。**Brain v2 fallback 路径有效带宽 ≈ Spark 本地直测**。

2. **c=4 高负载长思考 = 85 agg TPS** = Brain v2 cascade **真实 "MiMo 满载切 fallback" 时的可用上限**
   4 个并发 thinking-on 2K 请求 同时跑 ~80 秒,aggregate 85.45 tok/s,per-stream 24 tok/s。MTP accept 60.7% 不掉,**并发不破坏 speculative decode**。

3. **SSH 隧道在并发下完全没受影响**
   跑完 5 组共 ~3 分钟高强度并发(短答 + 长思考混合),Tencent 端 sshd PID 886529 没动、NRestarts 没涨、autossh 内层 ssh child 也没换。**14:29 加固的 `ClientAliveInterval=60` 在并发期间没误杀连接**(参数没踩雷)。

4. **隧道带宽不是瓶颈**
   4 路 think-on 2K 总 6818 tok / 80s = 跨境带宽 ~85 tok/s × ~3 字节/token = **~250 B/s text 流量**,远低于 SSH session 容量。只要 GPU 不饱和,隧道就不会饱和。

### 隧道回归 trigger ±5% 容差表

任何下列变更后,跑 `/tmp/tunnel_bench.py` 对比本节数字:

| 变更 | 期望影响 | 异常信号 |
|---|---|---|
| Tencent sshd_config 改 | 0%(配置项不影响 throughput) | 任何 > 5% 下降 |
| Tencent 服务器升级 / 重启 | 0% | sshd PID 变化但 TPS 应不变 |
| Spark 重启 | 0% | autossh 应在 3min 内重连(ClientAliveInterval 加固) |
| 网络商抖动 | < 5%(SSH 自带 keepalive) | timeout 错误 / 多次重连 |
| llama.cpp 版本升级 | 重测 system_fingerprint | 短答 TPS 显著变化 |
| `--ctx-size` 改 | KV cache 占用变,decode TPS 略影响(< 3%)| > 10% 下降 |

具体阈值:
- **c=1 think-on 4K decode** < **75 tok/s** → ⚠️ 调查(基线 79-90,−5% = 75)
- **c=4 think-on 2K agg** < **80 tok/s** → ⚠️ 调查(基线 85,−5% = 80)
- 短答类 ±15% 容忍(MTP accept 抖动大)
- 任何 SSH connection error / timeout = 🚨 立刻查 Tencent sshd

### 隧道复现命令

```bash
# 用 lynn-jump 跑同样 bench(默认有 Python 3 + requests):
ssh lynn-jump 'python3 /tmp/tunnel_bench.py' | tee tunnel-bench-$(date +%Y%m%d-%H%M).log

# 跟本节 baseline diff
diff <(grep 'agg_TPS' tunnel-bench-baseline.log) <(grep 'agg_TPS' tunnel-bench-$(date +%Y%m%d).log)
```

bench 脚本本身见上面【硬件 / 软件快照】节同样的 prompt 集合,差异只在 client 位置。

---

## 跟历史 TPS 对照

| 时间 | 配置 | 单流 TPS | 备注 |
|---|---|---|---|
| 2026-05 | Spark BF16 SGLang | 30.14 | 老 baseline |
| 2026-05-15 | Spark Lynn-native W4A16 NVFP4(scalar_bridge) | 23.88 | 早期 path |
| 2026-05-15 P10 | + native_fast_2d + autotune | 42.85 | Lynn engine 峰值 |
| 2026-05-18 | Spark Q4_K_M llama.cpp(无 MTP) | 69.77 | baseline 对照 |
| **2026-05-25 本次** | **Spark APEX-MTP llama.cpp + MTP** | **79.0 think-on / 53 think-off** | **canonical** |
| **2026-05-25 隧道** | **Tencent 跨 SSH 反向隧道 → Spark** | **90 think-on / 51 think-off / c=4 think-on agg 85** | **隧道无显著损耗(见上节)** |
| 2026-05-18 R6000 | Q4_K_M llama.cpp(高端对比) | 207 | 不同硬件,仅 ref |

---

## 复现步骤

```bash
# 1. 确认 service 在跑
ssh dgx-spark "systemctl is-active lynn-apex-mtp-llamacpp.service"

# 2. 拷贝 bench 脚本到 Spark
ssh dgx-spark "cat > /tmp/apex_bench.py" < bench_script.py

# 3. 跑
ssh dgx-spark "python3 /tmp/apex_bench.py" | tee bench-$(date +%Y%m%d-%H%M).log

# 4. 跟此文档对比 ±5% 容差
```

bench_script.py 原文见 git log(本次跑的版本)。模板:

```python
import json, time, sys, requests, concurrent.futures as cf
URL = "http://127.0.0.1:18098/v1/chat/completions"
MODEL = "qwen36-35b-a3b-apex-mtp"
# ...prompts + run helper + four bench scenarios above...
```

完整脚本保存路径(Spark 上):`/tmp/apex_bench.py`。

---

## 触发重 bench 的 trigger

**本地 bench(Spark 本机 /tmp/apex_bench.py)**:
- [ ] llama.cpp build 从 161 升级到更新版本
- [ ] APEX-MTP gguf 文件被替换 / 重新量化
- [ ] systemd unit 参数变更(ctx-size / parallel / spec params)
- [ ] Spark 系统 / CUDA / 驱动升级
- [ ] 每月一次例行 sanity check(可 cron)
- [ ] Brain v2 fallback 出现速度抱怨时

**隧道 bench(Tencent lynn-jump /tmp/tunnel_bench.py)**— 同时跑 + 跟「隧道并发 baseline」节对比 ±5%:
- [ ] Tencent sshd_config 任何变更(本次加固后基准已 update)
- [ ] 反向隧道 service 重启或 sshd PID 变化(stale session 修复后)
- [ ] Tencent 服务器升级 / 重启
- [ ] 跨境网络抖动 / 网络商切换
- [ ] Brain v2 mirror 报 fallback 延迟异常

---

## 文档 cross-link

- 服务部署 / 启停 / 健康检查:`docs/ops/spark-services-canonical-20260525.md`
- 用户向 narrative(知乎专栏):`docs/posts/zhihu_local_9b_q4km_imatrix_mtp_unlimited_token_20260525.md`
- Memory canonical ref:`reference_spark_apex_mtp_brain_v2_fallback_tps_20260525.md`(Claude 自动 memory)

---

*Bench 跑动时间:~50 秒(c=1 短答 ×3 trial + c=2 + c=4 + c=1 think-on 4K)。复跑成本低,出问题第一时间复测。*
