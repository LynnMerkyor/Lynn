# PLAN — Lynn 记忆系统 ACE 式改进方案(v2,已并入 codex 复核)

> 状态:设计草案 · 日期:2026-06-20 · 依据 ACE [arXiv:2510.04618](https://arxiv.org/abs/2510.04618)
> ⚠️ v1 把基线建错了(用了未挂载的旁路 `server/routes/memory.ts`)。codex 复核纠正:**主链路是 `lib/memory/`**。本 v2 已据真实代码重写。

---

## 0. 一句话(修正后)
Lynn 的**主记忆系统(`lib/memory/`)已经相当成熟**,已具备 ACE 的多数要素。真正缺的只有三样:**① 负反馈(只奖不罚)② 注入→结果追踪 ③ 语义去重/Curator 式合并**。所以这是**精准补三个洞**,不是搬整套 ACE。

## 1. ACE 核心(读后提炼,准确)
Generator(产出+标记条目有用/误导)→ Reflector(批判轨迹蒸馏教训)→ Curator(合成紧凑 **delta**,**确定性非 LLM** 合并)。playbook=结构化条目{id+helpful/harmful 计数+内容};**增量 delta** 防 context collapse / brevity bias;**grow-and-refine**(新 id 追加、旧条目原地更新计数、**语义 embedding 去重**);吃执行反馈无需标注;agent +10.6% / 金融 +8.6% / 在线 +17.1%;**命门=Reflector 质量**。

## 2. 真实基线(codex 纠正)
**主记忆 = `lib/memory/`**:`FactStore` + `ProactiveRecall` + `HybridRetriever` + `memory-ticker` + `SkillDistiller` + `deep-memory`。
- **`facts` 表已很丰富**(`lib/memory/fact-store.ts` 实读):`importance_score`、`hit_count`、`last_accessed_at`、`category`('other'/pitfall/procedure/task/project_decision…)、`confidence`、`evidence`、`source`、`project_path`、`tags` + FTS5 + `fact_links` + schema 迁移(user_version)。
- **召回**:`HybridRetriever` 已混合 tag / FTS / vector / recency / **importance** / category;召回后 `markAccessed()` 给命中条目 **hit_count++ / 提 importance**(已是正反馈雏形)。
- **注入路径**(真实):`SessionCoordinator.prompt()` → `prepareSessionTurnContext()` → `agent.recallForMessage()`(走 `ProactiveRecall`)→ 写 `_lastRecallContext` → `session-resource-loader` append 进 system prompt。**不是** `buildMemoryContext()`。
- **已有"Reflector 雏形"**:session 结束跑经验提取/项目记忆/画像/`SkillDistiller`;每日 `deep-memory` 从 summary diff 提结构化事实写 `FactStore`。
- ⚠️ **`server/routes/memory.ts` 是未挂载的旁路 API**(`server/index.ts` 没 mount、主代码没 import),**本方案忽略它**(或单独标为候选 API)。

**ACE 要素 × Lynn 真实现状:**
| ACE 要素 | Lynn 真实 | 状态 |
|---|---|---|
| 结构化条目+id+元数据 | `facts` 全字段 + category | ✅ 已有 |
| helpful 计数 | `hit_count` / `importance_score`(召回即加) | 🟡 **只有正反馈** |
| harmful 计数 | 无 | ❌ **缺** |
| 召回混合排序 | HybridRetriever(tag/FTS/vec/recency/importance) | ✅ 已有 |
| Reflector 蒸馏 | SkillDistiller + deep-memory + 经验提取 | ✅ 有(但非条目级 helpful/harmful 治理) |
| Curator delta 合并 | deep-memory 基本**追加**,只精确/字符串去重 | ❌ **缺语义合并** |
| grow-and-refine 去重 | 无语义去重、无低质裁剪 | ❌ **缺** |
| 防 collapse(增量非重写) | 追加式 | ✅ 已对 |

## 3. 真实差距(只剩三个洞)
1. **只奖不罚 + 召回即加权的隐患**:`markAccessed` "被召回就 hit_count++/提 importance" → **会强化错误记忆**(被召回 ≠ 真有用)。缺 `harmful_count` 和"注入后到底帮没帮上"的结果信号。
2. **无注入→结果追踪**:不知道某条 fact 注入后这轮是成功/失败/被纠正,反馈无从谈起。
3. **deep-memory 追加式,无语义去重/合并**:重复事实越堆越多(真正的 ACE grow-and-refine 缺口)。

## 4. 改进方案(分阶段,落在真实 `lib/memory/`)

### P0 — 负反馈 + 注入→结果追踪(ROI 最高、最小改动)
- **schema**(`fact-store.ts` 新迁移,向后兼容):`facts` 加 `harmful_count INTEGER DEFAULT 0`、`last_used_outcome TEXT`、`last_used_at TEXT`。
- **追踪注入条目**:`ProactiveRecall`/`recallForMessage` 返回里**保留本轮注入的 fact id 列表**,挂到 session turn 上下文(`_lastRecallContext` 已是落点)。
- **真实 outcome 回写**(用**强信号**,不用"未被纠正=helpful"这种弱信号):
  - **harmful++**:用户明确纠错 / 工具失败 / 答案被**重做或编辑重发**(这些信号客户端/复核层都有)。
  - **helpful++**:仅在**明确完成信号**时(任务通过/被采纳)。
- **召回排序纳入负权**:HybridRetriever 打分加 `-g(harmful_count)`,harmful 高的下沉/隐藏;并给 `markAccessed` 的"召回即加权"降温(改成"注入并产生正 outcome 才加"),修第 3.1 隐患。
- **验收**:被标 harmful 的条目逐步不再注入;同类 query 召回质量随轮次上升。A/B(开/关负反馈)在自有任务集上 eval。

### P1 — 策略治理(复用现有,别新建表)
- **不新增 `kind=fact|strategy` 表**;策略 = 复用现有 **`category`**(pitfall/procedure/project_decision…)+ `experience/` + `learned-skills/`。
- **增强 `SkillDistiller`(它就是现成 Reflector)**:对失败/被纠正/高价值 turn,蒸馏 1 条紧凑策略写入对应 category,并走 P0 的 helpful/harmful 治理(让策略也能被淘汰)。
- **Curator 确定性合并**:写入前与同 category top-k 余弦比对,命中相近条目**原地更新+计数合并**,否则追加——而不是 deep-memory 现在的纯追加。
- **验收**:会失败的任务第二遍因策略积累而成功率升;策略条目不爆炸。

### P2 — grow-and-refine 去重/裁剪
- **语义去重**:写入/惰性时,新 fact vs 同 scope top-k 余弦 > 阈值 → 合并(留 helpful 高者、计数相加)。**重点修 `deep-memory` 重复追加**。
- **低质裁剪**:`harmful≫helpful` 且陈旧 → 降权/软删;每 scope 软上限,超了按 `score=f(importance,helpful,harmful,recency)` 惰性裁尾。
- **验收**:长期运行条目数收敛、低质被裁。

## 5. 风险 / 纪律(并入 codex)
1. **Reflector 命门**(ACE 明确):记忆模型实际是 `utility_large → utility → chat` 解析(**不是 DS-Flash**,v1 写错);弱 Reflector → 记忆变噪音。Curator 端用确定性闸门 + harmful 自净兜。
2. **别用弱信号**:"未被纠正=helpful" 太弱、会强化错误;只用明确 outcome。
3. **PII**:`FactStore`/pinned 有 `scrubPII`,新写入路径**必须走同款 scrub**,别绕。
4. **隔离**:`FactStore` 是 **agentDir scoped**(按 agent/用户),旁路 route 是全局 `~/.lynn/memory.db` 仅按 source——两套隔离模型不同,strategy/helpful 必须按真实 scope 隔离,别串用户。
5. **增量上线**:P0 先上(加 3 列 + 注入追踪 + 强信号回写),env flag 灰度 + A/B eval,见效再 P1/P2。

## 6. 优先级
**先做 P0**:加 `harmful_count`/outcome + 注入 id 追踪 + 强信号回写 + 召回负权,顺手修"召回即加权"隐患。改动最小、直接补上"只奖不罚"这个最大的洞,且不动现有成熟链路。P1(策略治理复用 category/SkillDistiller)、P2(语义去重)随后。

---
*v2 修正:codex CLI(read-only, high)对照 `lib/memory/*` 复核,纠正 v1 基线错误(误用旁路 route)。真实文件:`lib/memory/{fact-store,retriever,proactive-recall,memory-ticker,deep-memory,skill-distiller}.ts` + 注入链 `core/{session-coordinator,session-turn-context,session-resource-loader,agent}.ts`。实施前以 brain 侧实际部署复核迁移与集成点。*
