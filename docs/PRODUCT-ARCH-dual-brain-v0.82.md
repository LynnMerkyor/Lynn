# Lynn 产品架构 · 双脑分工(编排器 A3B + 执行器 3.7 Flash)

> 面向下个版本(v0.82+)的 GUI Fleet 与 CLI(黑灯工厂)。把蒸馏完成后的模型拓扑沉淀成产品架构。
> 数据依据见仓库首页「第一部分 · 引擎与模型」+ 蒸馏评测定论。

---

## 0. 一句话

**编排器(Manager)= 本地蒸馏 A3B,只负责「拆分 → 分派 → 验收 → 整合」;执行器(Worker)= 云端 Step 3.7 Flash,负责实际干活(coding / 执行)。** 派活的不写活,写活的不派活——两种能力,两个脑子。产品路由固定为 **A3B → step37 → DS-V4 Flash**,但本地 A3B 是 **单槽 manager/fallback**:GUI 交互优先,本地槽忙时 CLI/后台跳过 Spark 走云端。

---

## 1. 为什么分两个脑子(数据驱动)

蒸馏评测(同 harness)证明:**编排和执行是两种不同能力,一个模型同时拉满会互相挤占。**

| 角色 | 模型 | 它强在 | 它让位的 |
|---|---|---|---|
| **编排器 Manager** | 蒸馏 A3B(本地 Spark) | 端到端 26.6s(快 2.3×)· GPQA +7.6pp · 编排 0 假验证 · 决断不啰嗦 | raw coding 72→63(-9,被 worker 覆盖) |
| **执行器 Worker** | Step 3.7 Flash(云) | coding-100 = 75 · 够快 · 并发能并行 | 不做拆分/验收(那是 manager 的事) |
| **逃生舱 Escape** | DS-V4 Flash(云) | 硬题(并发等)兜底 | 只在 A3B 验收不过或 step37 返工失败时上 |

> 关键结论:20×5 权威全集中蒸馏 A3B 是 0 假验证;但 5 题难子集暴露过 1 次并发类假验证 → 任务完成判定**必须看 harness 客观信号,不信模型自报**。这条直接决定了下面的验收回路设计。

跨尺度反例(为什么编排器锁 35B):**9B 蒸馏是更差的编排器**(端到端 63.7s,过度思考翻车)——编排要的「果断」需要 35B 级容量,不是越小越好。

---

## 2. 运行时拓扑(三级)

```
用户任务
   │
   ▼
┌─────────────────────────────────────────────┐
│  编排器 Manager = 蒸馏 A3B(本地 Spark :18098)  │  ← 本地单槽,空闲才接管
│  ReAct 回路:拆分 → 分派 → 看观测 → 验收 → 整合   │
└───────────┬──────────────────────┬──────────┘
            │ delegate(派活)         │ 验收(harness 客观验证)
            ▼                        ▼
   ┌──────────────────┐      ┌───────────────────┐
   │ 执行器 Worker      │      │ harness 验证信号    │
   │ Step 3.7 Flash(云)│      │ bash/code_run/test │
   │ + 各家 coding CLI  │      │ (不信模型自报)      │
   └──────────────────┘      └───────────────────┘
            │ 硬题 / 验收不过 → 升级
            ▼
   ┌──────────────────┐
   │ 逃生舱 DS-V4 Flash │  ← 只在必要时
   └──────────────────┘
```

- **本地单槽**:Spark 蒸馏 A3B,77 tok/s,空闲时做 manager/fallback;GUI 交互优先,忙时 CLI/后台跳过本地。
- **云端执行**:StepFun 3.7 Flash 干 coding/执行;GUI Fleet 下可并行多 worker。
- **escalation 目标**:蒸馏的目的就是压低 escalation rate——本地 A3B 扛住大多数,省钱/私密/自主。

---

## 3. 控制回路 = ReAct(编排器的本质)

编排器的「拆分 → 分派 → 验收」本身就是一个 ReAct 回路,这正是我们蒸的思维方式:

```
Thought(想):怎么把任务拆成子步、派给谁
  → Action(做):<delegate> 给 worker / <code_run> 自己跑 / <bash>
  → Observation(看):worker 产出 + harness 真实验证信号
  → Thought:验收对不对?需不需要返工 / 升级?
  → ……循环到「自报完成」且 harness 确认
```

工具集(编排器侧):`delegate`(派给 worker)· `code_run`(自己验证性地跑)· `bash` · `read_file`。**验收一律走客观信号,不采信 worker 或自己的自报。**

---

## 4. 映射到 GUI(Fleet)

**Fleet = 编排器中枢 + 多 worker 并行 + 验收可视化。**

| 层 | 角色 | 实现 |
|---|---|---|
| 中枢 | 蒸馏 A3B 编排器 | 本地 Spark,把任务拆成子任务、分派、收集、验收 |
| Worker 池 | Step 3.7 Flash + 各家 coding CLI(Claude Code / Codex / …)统一适配器 | 可并行;GLM-5.0 Turbo **并发只锁 2 → 不入 fleet,只当 fallback** |
| 可视 | 编排器思考(拆分计划)/ 各 worker 实时状态 / 验收通过与否 | GUI 把「派活—干活—验收」三段透明化 |

用户看到的:**一个会拆活的大脑 + 一群在干活的手 + 每件活的客观验收灯**。

---

## 5. 映射到 CLI(黑灯工厂 / lights-out)

**CLI = 无人值守执行器,编排器把子任务派给 CLI worker 自动跑。**

- **黑灯工厂-P**:A3B 编排器拆分后,子任务交 CLI 执行器无人值守完成。
- **Agent Quick Contract**:单次无交互任务 → 打印 JSON/JSONL 后退出(可被编排器消费 / 脚本化)。
- **Fleet worker 模式**:同一套适配器,GUI Fleet 与各家 coding CLI 通用;CLI 既可当 worker 被 A3B 派活,也可独立跑。
- 验收同样走 harness 客观信号(CLI 退出码 / 测试结果 / 文件状态),不靠 worker 自报。

---

## 6. 路由 / 升级策略

```
1. 任务进来 → 若本地 A3B 空闲且不是 GUI 前台抢占场景,由 A3B 编排器拆分
2. 纯决策/规划/验收 → A3B 本地完成(不出机)
3. 需要写代码/执行 → delegate 给 Step 3.7 Flash(或指定 coding CLI worker)
4. A3B 验收(harness)通过 → 整合反馈,结束
5. 验收不过 / 硬题(高并发等)→ 升级 DS-V4 Flash 逃生舱
```

- **KPI**:① false-verify 率(编排器乱报完成的比例,目标 0)② escalation 率(升级到云逃生舱的比例,越低越省)。
- prod 仍保持 StepFun 头位保障交互响应;**蒸馏完成后本地 A3B 进入单槽 manager/fallback**,不能并发抢 GUI 的 llama.cpp slot。

升级规则必须产品化,不能只靠模型自称「难」:

- harness fail 达到 2 次,且失败原因不同;
- 同一 worker 返工超过 2 轮仍未通过客观验收;
- 并发/线程安全/权限/数据迁移等高风险题型;
- A3B 没有给出可验证验收证据,或验收证据缺失关键文件/命令/测试;
- step37 输出互相矛盾或无法落地为文件/测试结果。

本地 A3B 可用性规则同样产品化:

- local slots busy >= 1 → 跳过 Spark,由 Step 3.7 Flash / DS-V4 Flash 接住;
- GUI interactive active → 跳过 Spark,保护前台手感;
- local endpoint loading / occupied / not ready → 跳过 Spark,不让 CLI 阻塞在冷启动;
- 强制本地只允许在 endpoint running 且 slot idle 时生效。

---

## 7. 速度 / 质量预算

| 环节 | 指标 |
|---|---|
| A3B 编排(Spark) | 77 tok/s · 端到端 26.6s(决断、少 token);MTP 仅作可选加速闸 |
| A3B 质量 | MMLU 90.2 · GPQA-Diamond 80.3(硬推理够用) |
| 3.7 Flash 执行 | coding-100 = 75 · 云端低延迟 · 可并行 |
| 兜底 | DS-V4 Flash,只在硬题/返工失败 |

---

## 8. v0.82+ 落地清单

- [x] Spark 蒸馏 A3B 升本地单槽 manager/fallback(已把 :18098 换成蒸馏 gguf,77 tok/s)
- [ ] A3B 编排 MTP(Claude 并行测试;只有 token-exact/harness 质量损失 <=5% 才允许进入可选 profile,不得阻塞 v0.82)
- [ ] GUI Fleet:编排器中枢 + 多 worker 并行 + 验收可视化
- [x] CLI:manager JSONL 派活 + harness 验收 + DS-V4 Flash escalation 闭环(`Lynn manager run --jsonl`;可承接 A3B 计划输出)
- [x] 路由配置固化三级:本地 A3B → 3.7 Flash → DS-V4 Flash;本地 busy guard 已接入 Brain router
- [ ] 模型路由纪律锁定:STEP_TEXT_MODEL = step-3.7-flash(执行头),不得静默降级

---

## 9. 一图记住

> **A3B 是「会派活、能验收、不乱报完成」的脑子(本地、决断、省/私);3.7 Flash 是「够强够快」的手(云、执行)。GUI 把这套并行化、可视化;CLI 把这套无人值守化。**
