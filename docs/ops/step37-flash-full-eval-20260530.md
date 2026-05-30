# StepFun step-3.7-flash 全面测评报告

Date: 2026-05-30 (过夜自主测评)
Endpoint: `https://api.stepfun.com/step_plan/v1`(订阅 plan 档)
Model: step-3.7-flash(198B MoE / ~11B active,vision-language,256K ctx,MTP-3)

> 一句话:**step-3.7-flash 在 high+32K 下速度、学术质量、agentic 工具、跨语言编码全面强于 Lynn 现役 Spark 35B-APEX-MTP,并反超 MiMo 的 GPQA/MMLU 评估。当前 Brain v2 默认路由是 StepFun 3.7 Flash high+32K -> MiMo V2.5 Pro -> Spark Qwen 3.6 35B A3B。MiMo 仍负责多模态/native search 兜底。**

---

## 1. 速度(实测,云端 MTP)

| 场景 | TPS |
|---|---|
| 单流 think-on(reasoning-always) | **207–261**(均值 ~220) |
| 并发压力下(云 eval conc 4 + 多路测试同时) | 仍 **220+,零 429** |

- 对比:MiMo v2.5-pro(token-plan)~34 / 本地 Q3_K_M @ Spark 26 / 35B-APEX @ Spark 79
- **比 MiMo 快 ~6×,比本地 Q3_K_M 快 ~8×,比 35B-APEX 快 ~3×**
- `step_plan/v1` 端点限流宽松:整夜 GPQA 198 + MMLU 500 ×2 + agentic + 编码 battery 36 + 多次 bench 全程 **零 429 / 零 error**(旧 `api.stepfun.com/v1` 免费档 conc 6 就 94% 429,step_plan 是付费 plan 档)

---

## 2. 学术质量(全集,真数据集 on Spark)

| Benchmark | think-on | think-off(fast-mode) | parse_fail |
|---|---|---|---|
| **MMLU 500**(5-shot, high+32K) | **92.20%** | 86.6% | 0 |
| **GPQA Diamond 198**(high+32K) | **70.71%** | 50.0% | on=2 / off=13 |

- thinking/预算增益:GPQA 从 medium+16K 的 59.6% 拉到 high+32K 的 **70.71%**,
  parse_fail 从 11 降到 2。MMLU high+32K 为 **92.20%**。
- 结论:旧 medium+16K 把 step-3.7 低估了;硬推理必须给 high + 32K。

### 对比 Lynn 现役模型(canonical)
| 模型 | MMLU | GPQA Diamond |
|---|---|---|
| **step-3.7-flash high+32K(云)** | **92.20** | **70.71** |
| MiMo V2.5 Pro | 91.8 | 66.67 |
| Qwen3.6-35B-A3B BF16 | 86.40 | 45.45 |
| Qwen3.6-35B-A3B Q4_K_M | 83.00 | 50.00 |
| Qwen3.5-9B Q4_K_M(本地默认) | 76.00 | 44.44 |

**step-3.7-flash high+32K MMLU 与 GPQA 均反超 MiMo,且明显高于 35B-APEX。**

---

## 3. Agentic 工具使用(端到端循环,5/5)

真 tool-call 循环(调工具→拿结果→用结果→答),非单发判定:

| 测试 | 结果 |
|---|---|
| 计算器多步 | ✅ |
| 股价→计算器链式(用上一步结果) | ✅ |
| 天气+计算器多工具协同 | ✅ |
| 真 web_search(走 Zhipu)→ 综合作答 | ✅ |
| 不该调工具时不乱调(过触发控制) | ✅ |

---

## 4. 编码能力(过夜 battery,**36/36 = 100%**,via CodeBuddy 真生产 CLI)

全部 CodeBuddy + step-3.7-flash 真跑 + 独立编译/测试验证。

| 类别 | 通过 | 内容 |
|---|---|---|
| **真 Lynn 代码 bug 修复** | **6/6** | tool-storm / search-context / audio-transcribe / types / router / web-search —— **注入 bug → CodeBuddy 修 → 真 tsc/vitest 验证 → git reset** |
| **Lynn 工程 pattern** | **12/12** | provider-cascade / retry-backoff / LRU / SSE-parser / token-bucket / stable-stringify / capability-filter / debounce / event-emitter / async-pool / deep-merge / ring-buffer / cooldown-tracker |
| **算法** | **8/8** | merge-intervals / topo-sort / trie / BFS-shortest / kth-largest / edit-distance / sliding-window-max / running-median |
| **跨语言** | **10/10** | Python(decorator/context-manager/asyncio-gather)· JS(event-bus)· TS(discriminated-union/泛型)· Rust(Result-parse/iterator-chain)· C(链表反转) |

代码质量观察:用 entry API 惯用法(Rust)、`csv.reader` 标准库、`Record<K,T[]>` 严格泛型(过 deno --check)、正确诊断 forEach-async 坑 —— **地道,非凑测试**。

原始数据:`/tmp/lynn-step37-bench/RESULTS.jsonl` + `SUMMARY.json`。

---

## 5. 量化版本(本地自托管路径,Q3_K_M)

| | 值 |
|---|---|
| 官方 GGUF Q3_K_M | 88GB,Spark Q3_K_M @ GB10 = **26 TPS**(纯 dense) |
| **MTP** | ❌ **官方 GGUF 丢了 MTP head**(arch step35,无 nextn/mtp tensor;实测 think-on 26 = think-off,零 speculative 加速) |
| 自量化 Q4_K_M(112GB)能否带 MTP | ❌ 转换脚本 `--mtp` 只支持 Qwen3.5/3.6,step35 不支持;且 112GB > Spark 119GB 装不下 |

**结论:本地自托管 step-3.7 不划算**(26 TPS 无 MTP + 吃满显存)。**云端才是正确用法**(220 TPS + MTP + 全质量)。

---

## 6. Brain v2 集成(已落地)

- 代码:`brain-v2-mirror/provider-registry.ts`—— universalOrder 头位:
  `step-3.7-flash` -> `mimo` -> `apex-spark-i-balanced`。
- StepFun 以 `default_reasoning_effort=high` + `max_tokens=32768` 运行;
  `vision/audio/video=false`,所以多模态自动经 capability gate 落 MiMo。
- brain.env:`STEP37_KEY/BASE/MODEL` 已配
- 缺的 native search 由 Lynn 工具体系补齐:① tool-call 循环(step-3.7 调 web_search,Brain tool-exec 多源聚合执行,实测 5/5)② pre-search 注入(native_search=false 自动触发 MiMo 预搜索)
- CodeBuddy:`~/.codebuddy/models.json` 已加 `custom-local:step-3.7-flash`(id 必须 = API 真名)

---

## 7. 最终定位

```
质量:  step-3.7-flash high+32K (MMLU 92.2 / GPQA 70.7) > MiMo (91.8 / 66.7) > 35B-APEX (86/45) > 9B (76/44)
速度:  step-3.7 (220) > 35B-APEX (79) > 9B本地 (78) > 本地Q3_K_M (26)
编码:  step-3.7 36/36 全过(真 Lynn 代码 + 算法 + 5 语言)
```

step-3.7-flash 作 Brain v2 cascade **头位**合理:文本/编码又快又强。MiMo 作第二位,负责多模态/native search 与高额度兜底;Spark 作第三位,负责本地零成本/隐私兜底。

**对 v0.80 lynn-cli / Worker Fleet:step-3.7-flash 是验证扎实的 fast coding backend**(220 TPS + 编码 36/36),CodeBuddy 已可直接用,可作 DeepSeek V4 Pro 之外的并行 worker 后端选项。

唯一要盯:**step_plan 是订阅档,确认 key 的月度配额上限**,跑满会断。

---

## 8. 数据可复现

- TPS / agentic / 编码 battery 脚本:`/tmp/stepfun-eval/`(overnight_step37_battery.mjs / agentic_tooluse_test.mjs / cb_multilang_battery.mjs)
- 学术 eval(Spark):`~/stepfun-eval/cloud-step37/`(gpqa/mmlu on+off jsonl + summary.json)
- 全程 APEX 生产服务未受影响(云 eval 纯 HTTP,不占 Spark GPU)
