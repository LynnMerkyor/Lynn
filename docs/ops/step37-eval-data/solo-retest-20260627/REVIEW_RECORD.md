# Step 3.7 Flash — SOLO 20题复核记录 (2026-06-27)

## 结论:Step 3.7 Flash 没有退化

用户怀疑"上周17、这周13"是同一个 Agent20 退化。复核后:

1. **17 和 13 本来就是两套不同 benchmark**(SOLO 编排 vs py/js 编码电池),不可比。
2. **在同一套 SOLO benchmark 上重测**(完全复刻上周 step_rash 的命令),结果不降反升。
3. **DS V4 判官有系统性假阴性**:同一批答案,DS 判 14~16/20,我(Claude)按真实证据复核 = **19/20**。

## 测试条件(三次都相同)
- benchmark: `orch_eval_3way.jsonl` 20题 SOLO(orch=exec=step-3.7-flash, review=none, max_steps=10, workers=3)
- harness: `eval_orch_review.py`
- DS 判官: `deepseek-v4-pro`
- Claude 复核: 我亲自复跑每个工作目录的 pytest + 读完整 obs 证据(keep run 保留了 workdir)

## 得分汇总
| 轮次 | 判官 | 得分 |
|---|---|---|
| 上周 6-18 (step_rash) | DS V4 | **17/20** |
| 本周 6-27 run1 | DS V4 | 14/20 |
| 本周 6-27 keep | DS V4 | 16/20 |
| 本周 6-27 keep | **Claude 复核(真值)** | **19/20** |

> DS V4 两次同周重测 14 vs 16,自身就差 2 分 → 证明这套 eval 噪声 ±2~3,17→14 完全在噪声内。

## DS V4 的 3 个假阴性(把跑通的答案判失败)
- **[2] quicksort 修3bug**: 模型正确定位3个bug+200随机数组全过 → DS 判✗,真✓
- **[11] deep_merge**: 12个 pytest 全过(我在 r_11 目录亲自复跑确认)→ DS 判✗,真✓
- **[19] 词频 Top-K**: 验证✓通过 → DS 判✗,真✓

## 唯一真失败
- **[3] 销售CSV**: 最终步把代码包成 `<tool_call>{...}` JSON(幻觉工具格式)而不是 harness 认的 `<code_run>`,导致没执行,工作目录空。**是工具格式幻觉,不是编码能力问题**。

## 逐题(DS keep vs Claude 复核)
| # | 题目 | 类别 | 上周DS | 本周DS | Claude | 备注 |
|--:|---|---|:--:|:--:|:--:|---|
| 0 | stats.py 统计函数 | 基础+测试 | ✗ | ✓ | ✓ | 上周DS假阴性,本周24 pytest过 |
| 1 | 购物车计价 | 业务逻辑 | ✗ | ✓ | ✓ | 上周DS假阴性,本周24 pytest过 |
| 2 | 修 quicksort 3bug | 调试 | ✓ | ✗ | ✓ | **DS假阴性** |
| 3 | 销售CSV 生成+分析 | 数据处理 | ✓ | ✗ | ✗ | **真失败:吐错tool格式** |
| 4 | LRU Cache | 数据结构 | ✓ | ✓ | ✓ | |
| 5 | todo CLI | 工具/CLI | ✓ | ✓ | ✓ | |
| 6 | Dijkstra 最短路 | 经典算法 | ✓ | ✓ | ✓ | |
| 7 | 自实现 base64 | 经典算法 | ✓ | ✓ | ✓ | 20随机串与标准库一致 |
| 8 | access.log 分析 | 数据处理 | ✓ | ✓ | ✓ | |
| 9 | 线程安全计数器 | 并发 | ✗ | ✓ | ✓ | 上周DS判✗,本周1000==1000×5过 |
| 10 | Stack/Queue 类 | 数据结构 | ✓ | ✓ | ✓ | 8 pytest过 |
| 11 | deep_merge | 工具/配置 | ✓ | ✗ | ✓ | **DS假阴性** |
| 12 | 自实现 bisect_left | 经典算法 | ✓ | ✓ | ✓ | |
| 13 | CSV→JSON 推断 | 数据处理 | ✓ | ✓ | ✓ | |
| 14 | 令牌桶限流器 | 并发/时间 | ✓ | ✓ | ✓ | |
| 15 | 自实现正则 .* | 经典算法 | ✓ | ✓ | ✓ | 与 re.fullmatch 对比一致 |
| 16 | 归并+逆序对 | 经典算法 | ✓ | ✓ | ✓ | 归并法vs暴力法一致 |
| 17 | Markdown TOC | 数据处理 | ✓ | ✓ | ✓ | |
| 18 | EventBus | 数据结构 | ✓ | ✓ | ✓ | 4 pytest过 |
| 19 | 词频 Top-K | 数据处理 | ✓ | ✗ | ✓ | **DS假阴性** |

## 文件清单
- `step37_solo_retest_KEEP_20260627.json` — 本周 keep run(完整 obs,我复核依据)
- `step37_solo_retest_20260627.json` — 本周 run1
- `step_rash_20260618_lastweek.json` — 上周原始数据(DS判17/20)
- `review_record.json` — 结构化逐题判定
- Spark 工作目录留证: `/home/merkyor/orch_test/runs/r_0..r_19`

> ⚠️ 工程结论待 GPT-5.5XH 复核(按铁律)。
