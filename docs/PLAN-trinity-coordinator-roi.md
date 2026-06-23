# Lynn 协调器学习化 — TRINITY/Conductor 借鉴可行性 & ROI 评估

> 日期 2026-06-23 · 来源:Sakana AI FUGU(河豚)= TRINITY(`arXiv:2512.04695`)+ Conductor(`arXiv:2512.04388`)+ GitHub 技术报告
> 触发:用户判断「TRINITY 不涉及 RL;Conductor 的 RL 可用 A2A 协议等工程手段替代」——本评估证实该判断成立。

## 0. 三句话结论
1. **TRINITY = 进化(separable CMA-ES),明确不用 RL**;协调器只是 **Qwen3-0.6B + ~1万参数 head**,每轮给池中某模型派 Thinker/Worker/Verifier。**几乎是为 Lynn 现有基建量身定做。**
2. **Conductor = RL(7B)**,学的是 A2A 通信拓扑 + 每个 agent 的提示词。**这部分可以不学**:用 **A2A 协议(工程)做通信层 + TRINITY 进化协调器做策略层 + 角色模板做提示** = RL-free 的 FUGU-lite,代价是放弃"RL 涌现出人想不到的拓扑/最优提示"那点尾部收益。
3. **建议:做 TRINITY 这条(进化协调器),跳过 Conductor 的 RL,通信层用 A2A/轻协议。** 先跑一个 Phase-1 小实验,对照现有手写 DS 编排(横评赢家)看是否更便宜/更准。

---

## 1. 两篇论文到底是什么(读原文后)

### TRINITY — An Evolved LLM Coordinator(进化,非 RL)
- **协调器** = `Qwen3-0.6B`(取倒数第二 token 的 1024 维隐向量)+ 一个线性 head(`1024 → L+3` logits,**~10K 参数**)+ 可选奇异值微调(~9K)。输出 = L 个候选模型 + 3 个角色(Thinker/Worker/Verifier)的 logits。
- **训练** = **separable CMA-ES**(协方差矩阵自适应进化策略)。论文明说:在高维 + 严格预算下,CMA-ES **优于 RL、模仿学习、随机搜索**(利用 block-ε-separability)。**无梯度、无 reward model。**
- **预算**:population λ=32;评估预算 **1.5k–40k 次**(10K 维问题);每候选复测 mCMA=16;3 seeds;最多 5 轮 / 4096 token。
- **池子**:7 个 LLM(GPT-5 / Gemini-2.5-pro / Claude-4-Sonnet 闭源 + Gemma-3-27B / DeepSeek-R1-Distill-Qwen-32B / Qwen-3-32B 开源两模式)。
- **结果**:跨 coding/math/reasoning/knowledge 超过任一单体 + 现有方法,OOD 稳健,LiveCodeBench **86.2% SOTA**。
- **代码**:论文称"源码+权重在补充材料",当前未见公开 GitHub(需按论文复现,但方法极简)。

### Conductor — Orchestrate Agents in Natural Language(RL)
- **7B Conductor**,RL 端到端学:① **agent-to-agent 通信拓扑** ② 给每个 worker 的**定向提示词**。
- 随机化 agent 池训练 → 适配任意开/闭源池;允许把自己选作 worker → **递归拓扑 / test-time scaling**。
- 结论:"LM 协作可被 RL 解锁,强协作策略在纯 reward 最大化中自发涌现"。
- **这正是成本/复杂度最高、也最'黑盒'的部分。**

---

## 2. 为什么 TRINITY 几乎是为 Lynn 量身定做(infra fit 逐项)

| TRINITY 需要 | Lynn 现成的 | 命中 |
|---|---|---|
| 协调器基座 Qwen3-0.6B | Lynn 是 Qwen 3.6 全家桶,拿 0.6B 是 trivial | ✅ |
| 候选模型池 | A3B(本地)/ Step 3.7 / DeepSeek / GLM / Spark + Brain 路由可统一调 | ✅ |
| **fitness = 任务成功打分** | **`eval_orch_review.py` + DS-Pro 判官(真沙箱 success/false_verify)已建好** | ✅✅ 最大白送 |
| 角色 Thinker/Worker/Verifier | manager(A3B)/ worker(3.7)/ judge(复核) 已是这三角 | ✅ |
| 协调器用隐状态(白盒小模型) | Lynn 跑本地模型,能取 hidden state | ✅ |
| 代表性任务集 | 已有 coding-100 / bug-77 / GPQA / A股票池 / 横评 20 题 | ✅ |

> 换句话说:TRINITY 论文里最难搭的"评测/打分飞轮",**Lynn 在横评那轮已经搭完了**——复现 TRINITY 主要就是"接上 0.6B + 一个 head + pycma"。

---

## 3. 复现成本(具体估算)

- **训练态**:无梯度、无 RL infra。一个 `pycma`(separable CMA-ES)ask/tell 循环优化 10K 维 head。
- **真实开销 = 进化期的池子推理调用**:粗估 `评估数(3k–10k) × 复测(16) × 每评估任务(批) × 轮数(≤5) × 每轮 1 次池模型调用`。量级在 **十万~百万次推理**,**全是 inference 不是训练**。
  - Lynn 可把池子主力压到**本地 A3B/Spark + 便宜云**,成本可控,跑几天即可;比 RL(需 rollout/奖励/策略梯度/不稳定)**省一个数量级的工程**。
- **复现工作量**:中等。0.6B + 线性 head + CMA-ES + 把现有 judge 当 fitness。代码未开源,但方法简单到可直接照论文写。

---

## 4. 你的 A2A 主张评估(对,但要分层)

Conductor 的 RL 同时学了**两层**,A2A 只替代得了其中一层:

| Conductor 学的东西 | 能否用工程替代 | 用什么替代 |
|---|---|---|
| **通信传输/格式**(怎么传消息) | ✅ 能 | **A2A 协议**(Agent2Agent,标准 agent card + task/message + streaming)或轻量内部协议 |
| **拓扑策略**(谁连谁、谁先谁后) | 🟡 部分 | **TRINITY 进化协调器**(它本就按轮派角色+模型 = 序列拓扑)或模板化拓扑 |
| **每 agent 的提示词** | 🟡 部分 | **角色模板**(Thinker/Worker/Verifier 固定提示)替代 RL 学出来的提示 |

**结论**:A2A 单独 ≠ 替代 Conductor(它只是"管子")。但 **A2A(传输)+ TRINITY 进化协调器(策略)+ 角色模板(提示)= RL-free 的 FUGU-lite**,逻辑自洽。
- **代价**:放弃 Conductor 用 RL 涌现的"人想不到的高效拓扑 + 逐 agent 最优提示"——这是榨基准最后几个点的部分。
- 对 Lynn(产品要的是**可靠 + 便宜 + 可控**,不是刷榜最后 2%),**这个取舍划算**。
- 注:Lynn 内部池调用本走 Brain(OpenAI 兼容),**未必需要 A2A 全套**;A2A 是"要跟外部 agent 互操作"时的标准选项,内部编排用轻协议即可。

---

## 5. ROI 判断

**收益(相对现有手写 DS 级联编排,即横评赢家 DS编排+复核 18/20):**
1. **编排变便宜**:用 **0.6B 协调器**替代"A3B(35B)/DS-Pro 当编排头",dispatch 脑子成本/延迟大降——**正中 Lynn"本地便宜编排"的护城河叙事**。
2. **学习式选模型**:按任务学派谁,胜过写死级联 `Step→Spark→DeepSeek/GLM`。
3. **fitness 直接编码 Lynn KPI**:`success − cost − false_verify` → 协调器天然学会"本地能扛就别上云"(= **压 escalation rate**,Lynn 蒸馏的核心 KPI),且**可量化对比**。
4. **池子可热插拔**:加/换模型只需重评,不必重写路由。

**成本/风险:**
1. 进化期推理预算($/时间)——但 Lynn 有 Spark+便宜云+现成 harness,可控。
2. 代码未开源 → 照论文复现(中等工作量)。
3. **战略重定义(必须正视)**:这把 Lynn 从"**A3B 当编排头**"改成"**0.6B 进化协调器编排一个含 A3B 的池**"。A3B 不废,降为强力 worker/Thinker;但**编排脑换成廉价进化器**。这是真实架构决策,不是 drop-in——但方向上**更便宜、更本地、更自主**,与 Lynn 叙事一致。
4. 需要代表性任务集覆盖 Lynn 真实任务面(coding/research/A股/chat),否则进化过拟合。

**判定:值得做一个 scoped Phase-1 验证。** infra 契合度极高、RL-free、与 KPI 对齐;主要不确定性是"进化出来的 0.6B 协调器能否打平/超过现有手写 DS 编排"。

---

## 6. 建议的最小验证实验(Phase 1)

**目标**:证伪/证实"进化协调器 ≥ 现有手写 DS 编排,且编排更便宜"。

1. **池**:A3B(本地)、Step 3.7、DeepSeek、GLM(L=4)。角色 Thinker/Worker/Verifier。
2. **协调器**:Qwen3-0.6B + `1024→(4+3)` head;输入倒数第二 token 隐向量。
3. **fitness**:复用 `eval_orch_review.py` 的判官 = `success − λ₁·cost − λ₂·false_verify`(直接编码 KPI)。
4. **训练集 / 验证集**:从 coding-100 / bug-77 / 横评 20 题 / A股票池 抽代表性子集;留 OOD 子集测泛化。
5. **进化**:`pycma` separable CMA-ES,λ=32,预算先 3k 评估,mCMA=8(省钱),跑在 Spark + 便宜云。
6. **基线对照**:现有手写 DS 编排+复核(横评赢家)。
7. **判定**:进化协调器 success ≥ 基线 **且** 编排侧成本/延迟更低 → 采纳;否则记录负结果。
8. 采纳后:通信层上 A2A/轻协议;**Conductor 的 RL 跳过**。

**纪律**:Mac 不跑计算(放 Spark);进化期别在 Spark 另起大模型(OOM 铁律);先冒烟 1-2 评估确认环境真能跑再放全量(吃过"跑完才发现沙箱缺 pytest"的亏)。

---
*依据:TRINITY/Conductor abstract + TRINITY 正文实验节(arxiv html v1)+ FUGU GitHub README。技术报告 PDF 未逐页读(系统集成细节),如需可补。*
