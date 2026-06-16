# 前沿模型 × 蒸馏/基准 横向评测(MMLU-500 / GPQA-198 / coding-100)

> 测于 2026-06-13~14。前沿 agentic CLI(KIMI 2.7 / Opus 4.8 / GPT-5.5)+ DeepSeek V4-Pro + Lynn 蒸馏/基准,同一套考题横向对比。

## 〇、2026-06-15 bench 修订(TS/BASH 改日常题)

**动机**:原 TS 10 题全是类型体操(递归条件类型 / 模板字面量类型 / `Expect<Equal>` 断言),原 BASH 全是 awk 体操(中位数 / 合并区间 / `RS=""` 段落 / PIPESTATUS / 带引号 CSV)——不代表日常编码。已全部重写为日常任务(TS: groupBy/chunk/deepEqual/LRUCache/parseQuery/EventEmitter/formatBytes/flattenObject/memoize/retry,运行时判定、去掉类型断言关;BASH: grep -c / awk 求和 / sort -u / wc / sed / `-F,` 等)。

**同时修了一个真 bug**:BASH 题原让模型"自己 printf 生成数据"但 test 写死期望值 → 模型编的数据 ≠ 期望 → 全 `exec-fail`(SELFTEST 用 canonical 自带数据所以假绿 10/10,把洞盖住)。修法:prompt 里写死确切输入数据。**⇒ 老 bench 的 BASH 列本就部分不可靠**(未指定数据的题 = 在考"猜数据")。

**修复后新 bench 首轮(3 云模型,全量 100;其余 8 语言两版一致)**:
| 模型 | 新 bench 100 | (旧 bench) | 新 TS | 新 BASH |
|---|---|---|---|---|
| DS-V4-Pro | **97** | 90 | 9/10 | 10/10 |
| ds-flash | **96** | 80 | 9/10 | 10/10 |
| step-3.7-flash | **89** | 75 | 8/10 | 10/10 |

题库:`dgx:/home/merkyor/tmp/lynn-coding-100-current/problems/{03_typescript,08_bash}.mjs`(旧题同目录 `.bak`)。

> ⚠️ 下方"## 一"及之后是**旧 bench** 数据,**TS/BASH 列已过时**,保留供对照与方法参考。

## 一、coding-100 全模型横评(按 80 题排序)

「80 题」= 排除 cpp/bash 的跨平台一致口径(python/js/ts/rust/go/sql/css/html),**最公平可比**;cpp/bash 因执行机器不同(Spark Linux 原生 vs Mac clang-shim/bash5)不完全可比。

| 模型 | 80 题 | 满 100 | 口径 | 机器 |
|---|---|---|---|---|
| GPT-5.5 | **93.8%** | 89 | agentic(codex) | Mac |
| DS-V4-Pro | **93.8%** | 90 | 单发(DeepSeek API) | Spark |
| KIMI 2.7 Code | 88.8% | 86 | agentic(kimi-code) | Spark |
| DS-V4-flash (ds-flash) | 85.0% | 80 | 单发 | Spark |
| Opus 4.8 | 83.8% | 78 | agentic(claude-internal) | Mac |
| step-3.7-flash | 80.0% | 75 | 单发 | Spark |
| 35B-A3B base | 75.0% | 72 | 单发 | Spark |
| 35B-A3B 蒸馏 | 66.2% | 63 | 单发 | Spark |
| 9B base | 63.8% | 63 | 单发 | Spark |
| 9B 蒸馏 | 47.5% | 45 | 单发 | Spark |
| gemma4-12B 蒸馏 | 30.0% | 25 | 单发 | Spark |
| gemma4-12B base | 27.5% | 24 | 单发 | Spark |

**梯度**:GPT-5.5 ≈ DS-V4-Pro > KIMI > ds-flash > Opus > step3.7 > 35B-A3B > 9B > gemma。
**亮点**:DS-V4-Pro **单发**就与 agentic 的 GPT-5.5 并列第一 → teacher coding 实力硬。

## 二、MMLU-500 / GPQA-198 横评(有数据的)

| 模型 | MMLU-500 | GPQA-198 |
|---|---|---|
| KIMI 2.7 Code | **93.2%** | 95.2% *(仅 62 题) |
| 27B 蒸馏 | ~92.4% | — |
| DS-V4-Pro | 90.6% | **92.4%**(159/172) |
| 35B-A3B | 84.4% | 49.5% |
| 9B 蒸馏 | 76.0% | 37.4% |

## 三、Caveat(读表必看)
1. **coding 口径混合**:KIMI/Opus/GPT = agentic CLI(能自测自纠,占优);DS-V4-Pro + 所有蒸馏/基准 = 单发。DS-V4-Pro 单发并列第一更显其强。
2. **GPQA 断层 + 存疑**:蒸馏 37-49%(可信),前沿 KIMI/DS 92-95%(反常高,GPQA Diamond frontier SOTA 才 ~85-90)→ **疑似 GPQA 公开集污染**(两前沿训练可能见过)或 2026 真涨。**前沿 GPQA 打问号**。两者还都是 partial(KIMI 62 / DS 172,KIMI 全 198 跑不动——思考太重 ~62 题吃光 3h 频限)。
3. **MMLU/GPQA 蒸馏数为旧测**(thinking-off / llama.cpp 服务),前沿为本次(thinking-on / CLI),口径不完全齐。
4. **coding 全部同 harness、80 题跨平台一致 = 最干净可比的一列**。
5. 单流 TPS:DS-V4-Pro ~60(直连流式);KIMI 2.7 ~21(有效,经 kimi-code、thinking-only)。

## 四、方法/复现要点
- **评测基建**:OpenAI 兼容代理(python http.server)`/v1/chat/completions` → shell 调对应 agentic CLI headless → 包成 OpenAI 格式 → 复用 harness。直连 API 的模型(DS/ds-flash/step3.7)无需代理。
  - MMLU/GPQA = `distill-rescue/distill/openai_{mmlu_500_5shot,gpqa_diamond}_eval.py`(`--base-url/--model/--api-key/--max-tokens`;**thinking 模型必给 `--max-tokens 32000`,否则推理吃光预算→content 空→parse_fail**)。
  - coding-100 = `distill-archive/coding-100/harness.mjs`(env `API_BASE/MODEL/API_KEY/MAX_TOKENS/CONC/OUT/PROBDIR`),题库 `tmp/lynn-coding-100-current/problems/*.mjs`,需 `npm install`(jsdom/css-tree/typescript)。
  - 代理加 retry-on-empty;**conc 2-3 干净,conc 6 压出空响应污染**。
- **CLI 接入**:
  - KIMI 2.7 = 只能 CLI(API 直连被拒)。`code.kimi.com/kimi-code/install.sh`;key 写 `~/.kimi-code/config.toml`;`kimi -p "..." --output-format stream-json`。¥199 Allegretto = 3h **token** 频限,coding 一轮烧光。
  - GPT-5.5 = 真 codex(`~/.local/bin/codex`,ChatGPT Plus/Pro OAuth)。`echo prompt|codex exec --skip-git-repo-check -s read-only --output-last-message <file>`;config `~/.codex/config.toml` 把 xhigh 降 `high`(xhigh 断流)。⚠️ `codex-internal`(codebuddy)headless 坏(强制 gpt-5.4、exec 不返回),别用。
  - Opus 4.8 = `claude-internal -p "<prompt>" --dangerously-skip-permissions`(codebuddy)。
  - DS-V4-Pro = DeepSeek API 直连(`api.deepseek.com`,`deepseek-v4-pro`,thinking-on);qwen CLI 只是壳(且其 settings.json 尾逗号会被 qwen 重置,已修)。
  - codex-internal/claude-internal = 内网,仅本地 Mac 终端可用(Spark 够不到)。
- **macOS 执行坑**:bash 3.2(GPL3 不升,brew bash5)、cpp 无 `bits/stdc++.h`(brew gcc 下载失败→改 `g++` wrapper = `clang++ -I<shim>`,shim = 含全部标准头的 bits/stdc++.h)。→ Opus/GPT 在 Mac 的 cpp/bash 不及 Spark Linux 口径,**coding 以 80 题为准**。
