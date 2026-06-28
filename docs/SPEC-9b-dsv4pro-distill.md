# SPEC：Qwen 9B Dense — DS-V4-Pro 通用 ReAct 轨迹蒸馏（Codex 实施需求书）

> 角色分工：本文档（Claude）= 需求 + 验收口径；**Codex = 落代码 + 跑训练/评测**；用户 = 产品决策 + GPU 实测复核。
> Claude 不碰 9B 实现，只复核产物。
> 日期：2026-06-25

---

## 0. 一句话目标
把**已在 27B / 35B 验证成功**的 DS-V4-Pro 通用「收口 + 工具纪律」SFT 轨迹，复制到 **Qwen3.5 9B Dense**，补齐 9B/27B/35B 家族矩阵。
**只蒸「怎么想 + 收口 + 怎么用工具」，绝不蒸知识/能力/事实。**

---

## 1. 背景（让 Codex 懂意图，别跑偏）
同一份 `lynn_prod_train.jsonl`(1842 条, 1 epoch) 在两档已收敛：

| 模型 (thinking-on) | GPQA-198 base→distill | MMLU-500 | parse_fail (撞32K空答) |
|---|---|---|---|
| 27B-MTP | 73.7 → **80.81** (+7.1) | +0.2 (不掉) | 14 → 0 |
| 35B-A3B | 72.7 → **80.3** (+7.6) | −1.6 | 12 → 2 |

- **增益主因 = 修「过度思考不收口」**（教模型想完就给答案，治撞 32K 空答），**不是变聪明**。中位生成 27B 蒸馏版仅 3006 tok。
- 同族（Qwen3.x Gated DeltaNet）→ 9B 预期可迁；这套轨迹**跨族会崩**（OPD Issue#1799），所以底模锁死 Qwen 9B，禁换。
- ⚠️ **9B 容量小，退化大概率比 27B/35B 大**（自蒸馏退化随规模减轻规律：1.7B 45.9% → 8B 12.1% → 27B 更轻）。**必须先量化退化再补救，禁止假设和 27B 一样干净。**

---

## 2. 不做什么（边界，硬约束）
- ❌ **不跨族**：底模只能是 Qwen3.5-9B-BF16，别换 Phi/Granite/Llama。
- ❌ **不灌知识/事实进权重**（黑盒 SFT 抬不高天花板，只增幻觉）。
- ❌ **不动 27B/35B 的已有产物 / 数据 / 配方**（只新增，不改旧）。
- ❌ **别在 Spark 另起第二个大模型**（统一内存 OOM 铁律）。9B 训练与现有 35B llama-server 共存已验证 OK（冒烟 loss 1.198）；但别再额外拉服务。
- ❌ 本任务是**通用轨迹**蒸馏，与现有 9B repo bug-hunter **专项**是两件事（关系见 §7）。

---

## 3. 输入资产（全现成，第一步先核实路径）
> **Codex 第一步：在 Spark/R6000 上 `ls` 核实下列路径真实存在再开工**（以下来自记忆，4–15 天前，可能漂移）。

| 资产 | Spark | R6000 |
|---|---|---|
| 底模 `Qwen3.5-9B-BF16` | `/home/merkyor/models/Qwen3.5-9B-BF16` | `/root/autodl-tmp/models/hf/Qwen3.5-9B-BF16` |
| 训练数据 `lynn_prod_train.jsonl`(1842) | （从 R6000 同步） | `/root/autodl-tmp/distill/**/lynn_prod_train.jsonl`（核实精确路径） |
| 训练脚本 `qlora_train.py` / `format_qlora.py` / `merge_lora.py` | 复用 bug-hunter 那套 | `output/distill-gen/repo-bughunter/` 同款 |
| 训练 venv | `/home/merkyor/venvs/bughunt`(torch 2.11 aarch64 + transformers 5.9.0 + peft 0.19.1 + accelerate + datasets) | bughunt venv |

- 配方基准 = `train9b.sh` 的 `qlora_train.py --dense --rank 64`（与 9B bug-hunter 同栈）。

---

## 4. 训练步骤
1. **格式化**：`format_qlora.py` → **per-assistant mask**（observation 当 user 角色 mask 掉，**只训 Thought + Action**，否则训到伪造 observation）。
   - ⚠️ **生成↔训练 system prompt 必须一致**。
2. **训练**：
   ```
   qlora_train.py --dense --device_map gpu0 --optim adamw_torch \
                  --maxlen 8192 --rank 64 --epochs 1
   ```
   - **BF16 + LoRA r64，禁 4bit**（bnb 这里只做 paged 优化器，Spark 无 bnb 用 `adamw_torch`）。
   - **1 epoch 早停**（eval_loss epoch1 触底）。
   - **Spark 两坑（已修进 qlora_train.py，确认仍在）**：① `--device_map gpu0`（GB10 统一内存会把层 offload 成 meta → 反向炸 `expected device meta but got cuda:0`）；② `--optim adamw_torch`（无 bnb）。
   - **peft↔transformers 不兼容** → 手动 `load_state_dict`。
   - pip 装栈走清华源（aliyun 对 Spark 仅 ~1.3MB/s）。
3. **merge**：`merge_lora.py` → merged BF16。
4. **GGUF**：merge 后 **patch config `mtp_num_hidden_layers=0`** 再 `convert_hf_to_gguf` → 量化到**与对照同一档**（base/distill 必须同 quant 做 apples-to-apples）。

- 训练机：**Spark**（1800 样本 1 epoch ~12–15h 过夜）；**R6000 若空**（~2–4h，优先）。先 `tmux ls` 查占用，**别杀别人会话**（R6000 可能被 vLLM 88G 占）。

---

## 5. 评测 / 判决（核心交付）
- **口径**：thinking-on，max_tokens ≥ 30K(32768)，**temp 0.6 / top_p 0.95，禁 greedy**。
- **样本**：MMLU **500** + GPQA Diamond **198**（canonical，不许子集）。
- **对照**：9B **base vs 9B distill**，**同 quant 同 harness 同口径**。
- **纪律**（踩过的坑，必守）：
  - **独占 GPU**（并发抢 slot 会假摔）。
  - reasoning_content 分离；剥 `<think>` 再 parse。
  - **冒烟先行**：serve 后先跑 1–2 题，深挖 turns 确认环境真能跑 + max_tokens 够（区分「真过度思考」vs「被截断」）→ 才放全量 → **头几题抽查**。**禁止跑满才发现环境/参数错。**
  - 监控写 json 逐题落盘（别看 stdout tail 缓冲）。
  - `pkill` 用 `[x]` 正则防自杀。

### 主指标（按重要性排序）
1. **parse_fail（收口）**：base vs distill 撞 32K 空答数 —— **这是核心增益**，预期大降。
2. **GPQA-198 delta**：预期涨（主要来自收口救回的题）。
3. **MMLU-500 守恒**：⚠️ 9B 小，可能掉，**先量化掉多少**。
4. 辅助：中位生成 token（看是否变克制）。

### 退化补救（铁律：先量化再补救）
- MMLU 不掉 / 微掉 → 只调 temp 1.0，收。
- 明显掉 → OPD（post-SFT healing；此处非跨族，崩风险小）或加重 replay 锚 `lynn_prod`(1842)。
- **禁止盲目上 OPD**，先看退化数据。

---

## 5B. 失控根因诊断（实测 2026-06-25，挖 Spark 旧产物）+ 鉴别实验矩阵

> 背景：之前训过的 `lynn-9b-dsthink`（adapter 在 `distill-archive/adapters/lynn-9b-dsthink`，r64/alpha128）实测 GPQA-Diamond 198：base 34.3% → distill **59.6%(+25.2pp)**，但 distill **parse_fail 61/198(31%)**、MMLU 87.4→84.0(−3.4)。用户描述为「推理+25% 但思维完全失控」。

### 🔴 已查实：所谓「失控」主要是 **harness 测量假象**，不是模型问题
拆 `gpqa_9b_distill.json` 的 61 个 parse_fail，**每一个的 `error` 字段都是 `ReadTimeout(read timeout=120.0)`、`response=""`、`usage={}`**。`diag_pf.py` 只判 `response==""`，把**超时没拿到 body** 误记成「空答/循环」。

证据链（全部实测）：
- 评测器 `openai_gpqa_diamond_eval.py`：`stream=False`（硬编码）、`--timeout` 默认 **120.0s**、**从不记录 `finish_reason`**（行字段只有 id/answer/prediction/correct/response/usage/error）。
- `run9b_eval.sh` 实跑：`--max-tokens 30000 --concurrency 4`，**timeout 没传 = 用默认 120s**。
- 服务：`Qwen3.5-9B-lynn-dsthink-Q4_K_M-imatrix.gguf`，`llama-server --jinja -ngl 99 -c 131072 --parallel 4`。
- 推论：max_tokens 给到 30000 + **并发 4 摊薄单请求 TPS** + 120s 非流式读墙 → 任何思考 wall-time >120s 的题直接 ReadTimeout → 计为「失控」。base 比 distill 更啰嗦 → 超时更多(118)。
- 模版已排除：base `tokenizer_config` 是标准 Qwen3 模版(7756 字符)，`eos=<|im_end|>`，训练用标准 `<think>\n{th}\n</think>\n\n{ans}`（`format_unified.py`）。

### 四选一结论（量化 / 贪婪 / 模版 / 模型）
| 假设 | 判决 | 依据 |
|---|---|---|
| **贪婪解码** | ❌ 否 | 评测是 temp 0.6 / top_p 0.95，非 greedy |
| **模版** | ❌ 基本排除 | 标准 Qwen3 模版 + 正确 eos + 标准训练格式 |
| **量化** | 🟡 加速器非根因 | Q4 比 F16/BF16 慢 + 并发 4 摊薄 → 更易撞 120s 墙；可能也更易循环。**未独立验证** |
| **模型（真失控）** | ❓ 被掩盖，未测 | 模型确实思考较长(所以>120s)，但「真跑到 30K runaway」还是「只思考 8K 被并发+120s 掐」**无法区分**——harness 没存 finish_reason |
| **🔴 harness 超时/非流式（第五项）** | ✅ **头号原因** | 61 个 error 全是 ReadTimeout 120s；stream=False + concurrency 4 |

**所以：在修好测量之前，没有任何一项（量化/模版/模型）被证明是病因。** 必须先去掉 harness 假象，才能谈后面三者。

### 鉴别实验矩阵（Codex 按序跑，每步只改一个变量）
> 全程 Spark 只读/单模型，禁起第二个大模型（OOM 铁律）。迭代用 40 题子集快跑，定论用全量 198。

- **Step 0 — 修测量（基石，先做，不做后面全是噪音）**
  - 改评测器：`stream=True`、`timeout≥1200s`（或不设读超时只靠 max_tokens 收口）、**`concurrency=1`**（独占，消除摊薄）、**记录 `finish_reason` + `usage.completion_tokens` + 完整原始 response(含 `<think>`)**。
  - 重跑 distill Q4 GPQA-198 → 把「失败」重新分类：`finish_reason=stop`(收口了) / `=length`(真撞 30K runaway) / 收敛且正确 / 思维是**重复循环**(n-gram 复读) vs **连贯但长**。**这一步直接给出真·失控率。**
- **Step 1 — 量化轴(生产现实档,固定 Step0 harness)**：从 `lynn-9b-f16.gguf` 现转 **Q8_0(近无损天花板,≈F16 在噪声内,~9.5G)/ Q6_K(甜点,~7.5G)/ Q4_K_M-imatrix(原始档,~5.6G)** 同题跑。⛔ **不测 BF16/F16**(非生产,Q8_0 已等价天花板且小一半)。比 真 runaway 率(finish_reason=length)、中位 completion_tokens、TPS、准确率。关键差值:Q4_K_M(修后)−旧Q4(120s)=harness 影响;Q8_0−Q4_K_M=量化影响。
  - **Step 1b — FP8 lane(另一条 serving 栈)**:FP8 是生产合适档但 **llama.cpp GGUF 无此格式**,走 vLLM/SGLang(Spark FP8+MTP 已验证 / 4090 原生 FP8)。单独测,不混进 GGUF sweep。
- **Step 2 — 解码轴**（取最优量化）：temp {0.6, 1.0} ×（+`repetition_penalty 1.05` / +`min_p 0.05` / +`presence_penalty`）。→ 采样对循环长度的影响（jackrong：temp1.0 灭 loop）。
- **Step 3 — 模版轴**：dump 服务 GGUF 内嵌 jinja 模版，确认与 base 7756 字符模版一致、`</think>` 与 `<|im_end|>` 停词正确、`enable_thinking` 行为对；测 **budget forcing**（思考到 N tok 强插 `</think>\n答案：`）。→ 确认模版无锅 + 拿到零训练的收口手段。
- **Step 4 — 残差 = 模型/训练**：若 Step0–3 后 `finish_reason=length`(真 30K runaway) 仍高 → 才是真·模型收口病 → 走 §5「退化补救」重训（砍长 trace / DPO 收口 / OPD）。

### 已就绪的修复资产（Spark）
- adapter `distill-archive/adapters/lynn-9b-dsthink`、`distill-rescue/lora-out/lynn-9b-dsthink`
- DPO 全套 `distill-rescue/`：`dpo_gen.py`/`dpo_label.py`/`dpo_pairs.jsonl`（「挑收敛样本」= 收口偏好数据，最好按 9B 自己的失败重生成）
- 诊断 `diag_pf.py`（⚠️ 需改：当前把 ReadTimeout 误判成空答，应改为读 finish_reason）

---

## 6. 交付物
- merged BF16：`/home/merkyor/models/Qwen3.5-9B-lynn-dsv4pro-merged`（或同惯例命名）。
- GGUF（与 base 对照同 quant）。
- **判决表**：base vs distill × { parse_fail, GPQA-198, MMLU-500, 中位生成 token } + 结论一句话（**收口是否迁移到 9B**）。
- 报告 md 落 `output/distill-gen/` 或 reports/。

---

## 7. 与现有 9B repo bug-hunter 的关系（用户决策点）
- 现有 9B repo bug-hunter = **专项**（抓 repo bug），已把 `lynn_prod`(1842) 当 **replay 锚**混进训练。
- 本任务 = **通用** DS-V4-Pro 轨迹（收口 / 工具纪律）。
- 两条路：
  - **(A) 独立训通用版**（默认）→ 拿干净的家族矩阵数据点（9B/27B/35B 同口径可比）。
  - (B) 合并成多任务 SFT（通用 + bug-hunter 一锅）。
- **默认走 (A)**，除非用户改判 (B)。

---

## 8. 风险 / 坑清单（给 Codex 的预警）
1. **9B 退化更大** → 必先 base vs distill 量化，别套用 27B「+0.2 不掉」的乐观。
2. **空答的三种假象**：可能是真过度思考、被 max_tokens 截断、**或被 HTTP 读超时掐断**（上一版 9B 的「31% 失控」实为 `stream=False`+120s timeout+并发4 的 ReadTimeout，见 §5B）。**评测必 stream=True + timeout≥1200s + 记录 finish_reason**，否则测量本身就是 bug。
3. **长跑前必冒烟 + 跑中途抽查**（这是被用户带火气强调过的纪律）。
4. **R6000 占用**：可能被其它会话 vLLM 88G 占，查 tmux，别杀 `vs`/`dg`。
5. **GGUF 转换**：merge 后 config `mtp_num_hidden_layers` 必改 0，否则 convert 失败。
6. **底模禁换族**：换非 Qwen 系 = 跨族崩，本 SPEC 作废。

---

## 9. 验收（Claude 复核 + 用户 GPU 实测）
- [ ] 路径核实通过、冒烟通过（1–2 题深挖 turns）。
- [ ] base/distill 同 quant 同口径全量跑完，judge 未静默死（decomp/score 非全 0）。
- [ ] 判决表四项齐全 + 收口迁移结论。
- [ ] 若 MMLU 明显掉，给出已量化的补救方案（非盲上）。
