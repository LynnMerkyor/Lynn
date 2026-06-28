# PLAN — Lynn Agent Regression Harness

> 状态:**已过 codex 5.5XH 复核 → GO-with-changes**(2026-06-27)。本节(§-1)为复核修订,**优先级高于下方原始设计**;原始设计保留作推导记录。
> 日期:2026-06-27
> 作者:Claude(调研 + 设计)· 用户(方向决策)· Codex(提议可行性 + 复核)

---

## -1. 复核修订(codex gpt-5.5 xhigh,read-only 翻代码核对)

### 判决:GO-with-changes
方向成立,但有三处核心前提被代码核对推翻,且**仓库里已存在 v1 实现**,必须先修设计再动手。

### 🔴 最大发现:`agent-regression-kit/` 已存在(commit `c41c2822`,2026-06-27)
本设计稿独立重新推导出了同一套架构(算验证方向),但 **Codex 已先搭好 v1,提议"新建 `tests/agent-regression/`"是平行造轮子,作废。一切落到扩现有 kit。** 现有 kit 已实现:
- adapter 化 runner(`agent-regression-kit/src/core.mjs`):JSON case bank + level(smoke/release/nightly)+ tag 选择 + 12 种 deterministic 断言 + fixture 临时目录 + JSON 报告。
- 脚本化 OpenAI-SSE 假 provider(`src/fake-openai-provider.mjs`):`/health`+`/chat/completions`,按 model/请求#/lastUserContains 匹配脚本步,支持 content / reasoning_content / 增量 tool_calls / usage / 4xx-5xx / delayMs / rawSse,记录 requests。**这就是设计稿说的"拱心石",已经在了。**
- Lynn adapter(`adapters/lynn.mjs`):`route_intent` / `native_session_trace` / `cli_provider_trace` 三 operation,调真后端、把真 native session 指向假 provider,返回 events/toolStarts/finalText/provider.requests/messages。
- 同款定位(README:5「Agent runtime contract runner, not model-quality eval」)、四层、`case-bank.schema.json`,且已焊进 `release:preflight`(package.json:86)。

### 被推翻的事实(以此为准,覆盖下方原始设计)
1. **`core/agent.ts` 不是 CLI/GUI 共用 loop 入口(原 §2.1 错)。** CLI loop 在 `cli/src/code-agent-loop.ts:212`;GUI 走 WS `server/routes/chat.ts` → `core/session-coordinator.ts:348` → `core/agent-runtime/create-session.ts:591`。**两段不同的 loop。** 好消息:kit 的 adapter 已用 `native_session_trace` vs `cli_provider_trace` 两个 operation 抽掉了这个差异——不需要"共用入口",需要"每 surface 一个 adapter operation"。
2. **事件名错(原 §3 错)。** WS accepted 是 `prompt_accepted`(`chat.ts:474`)非 `prompt_start`;可见文本 `text_delta`(`stream-emitters.ts:124`);GUI runtime 最终事件是 `message_end/agent_end`(`create-session.ts:463`)非 `assistant_final`;`turn_close` 是 lifecycle/debug hook **不是客户端事件**。
3. **WS-only 事件流证明不了所有收口 reason。** stale release 只 emit `turn_end`+log,无 `turn_close reason`(`chat.ts:138-173`)。漏的收口事件:tool auth timeout/persisted final(`tool-turn-finalizer.ts:640`)、edit rollback discard(`:390`)、reasoning-only/empty fallback(`hub-event-forwarder.ts:584`)。**必须加 lifecycle/diagnostic event sink**,光接 WS 不够。

### 真正的 GAP(= 本设计相对现有 kit 的增量 = 下一步路线)
1. **Brain v2 路由测试需要专用 `p-fake` provider**(别长期复用 step-3.7-flash):扩 `ProviderIdLiteral` + 注册 `p-fake`(`endpoint=env('BRAIN_FAKE_BASE')`,`wire:'openai'`,`tools=true`,`health_path:'/health'`)+ `BRAIN_V2_FORCE_PROVIDER=p-fake`。cooldown 是进程内 Map(`provider-registry.ts:178`)→ 空答/cooldown case 必须每 case 独立 Brain 进程或加 reset hook。
2. **假 provider 必须补 `/models`**:本地 probe 默认打 `/models`(`router.ts:185`),现 kit 只有 `/health`+`/chat/completions`,挂到 Step base 会 404→cooldown。
3. **local target 必须关掉绕过 provider 的 direct 路径**:`BRAIN_V2_DIRECT_KNOWN_OFFICIAL=0` / `BRAIN_V2_DIRECT_OFFICIAL_MODEL_PREFETCH=0` / `BRAIN_V2_DIRECT_WEATHER_PREFETCH=0` / `_SPORTS_PREFETCH=0` / `_MARKET_PREFETCH=0`(office/workspace direct reply + prefetch direct close 会绕开 provider:`prompt-turn-runner.ts:232`、`router.ts:1458`)。
4. **wire 方言清单**(假 server 要全支持):`/chat/completions`+`/v1/chat/completions`、`delta.content`、`delta.reasoning_content`、增量 `delta.tool_calls[i].function.arguments`、`finish_reason`、`usage`、4xx/5xx、delay/断流;若模拟 Brain→client 还要 `object:"lynn.provider"`/`"lynn.tool_progress"`/`"lynn.error"`(CLI 在 `brain-client.ts:198` 解析);容忍请求体回灌 `reasoning_content`(`router.ts:56`)。
5. **归一化跨 surface 事件词表 + 收口事件**:加 `tool.authorization.{requested,timeout,persisted_final}`、`edit.rollback.discarded`、`turn.close.reason`、`stream.stale_released`、`empty.visible_fallback`、`reasoning_only.visible_fallback`、`provider.{cooldown,fallback}`,经 diagnostic sink 而非只靠 WS。
6. **"fake Brain" vs "fake upstream provider" 是两类 target,分开命名**:`withBrainServer` 假的是 CLI 看到的 Brain `/v1/chat/completions`;Brain v2 provider 假的是上游 `/chat/completions`。断言对象不同。
7. golden-trace **必须白名单录制 + scrub**(高风险字段:Authorization/签名 header `brain-client.ts:422`、bearer key `create-session.ts:723`、messages/tools/body、图片 base64 `session-openai-adapter.ts:289`、tool args/results、本地路径/cwd/JSONL);raw VCR 进 `.gitignore`,repo 只存归一事件 + scrub 后摘要。
8. 仍缺:20 个历史 bug 回填、GUI Playwright + `data-testid` 注册表(kit 现仅 backend/CLI)。

### P0 前置条件(动手前)
唯一落点 = 扩 `agent-regression-kit`(不建第二套)→ 加 `p-fake` provider + route override env + cooldown 隔离 → 假 server 补 `/models` + 上面 wire 清单 → 每 case 独立 Brain 进程或 reset hook → local 默认关 direct 绕过 env → 加 diagnostic event sink → 录制模式先做 scrub 白名单。

---

## 0. 一句话定位

这不是"模型评测"工具,而是 **Agent 运行时行为的契约回归层**。

测的不是"答案漂不漂亮",而是:**请求是否进了正确路由 · 工具是否按预期调用 · 证据是否进 ledger / event stream · 空答/超时/失败/重试是否被正确收口 · 最终是否有可见答案 · 新请求是否不被旧 session/retry/edit 状态污染 · GUI 和 CLI 是否共享同一套后端行为。**

生态调研结论(2026-06):GitHub 上的"AI 测评工具"90% 解决前者(model-quality eval,LLM-as-judge 打分:promptfoo / deepeval / agentevals / ragas / Inspect / Braintrust / Phoenix)。后者(运行时行为契约)几乎没有现成框架,本质是"带 LLM 替身的确定性软件测试"。**因此:不引入重型 eval 框架当脊柱,在已有 vitest 底座上长出契约层,只借生态里的几个具体模式。**

借用 vs 自建:

| 来源 | 借什么 | 怎么用 |
|---|---|---|
| promptfoo(YAML schema / `trajectory:tool-used`) | case 文件格式 + 工具轨迹断言语义 | 参考,**不依赖**(2026-03 被 OpenAI 收购,只在 Layer 4 live 用,可替换) |
| agentevals(trajectory match) | 事件序列匹配模式(strict / unordered / subset) | 参考,落到我们自己的事件流契约 |
| LLMock(跨进程假 LLM server) | env 指向的可脚本化假 provider 架构 | **自建**(升级现有 `withBrainServer`) |
| @node-llm/testing(Vitest 原生 VCR) | 录制/回放 cassette 思路 | 参考 golden-trace 录制模式 |
| Playwright `_electron.launch` + electron-playwright-helpers | Electron e2e + IPC/dialog 桩 | **直接用**,补 jsdom-only 缺口 |

---

## 1. 设计原则

1. **事件流是断言基底,不是自然语言。** Lynn 后端已发命名事件(见 §3),把事件流快照当 case 的 canonical 产物,断言打在它上面,比断言文字稳。
2. **一个 case,三种 target。** 同一份 case 能打到 mock(进程内假 provider)/ local(假 provider 起 HTTP server + 真本地工具)/ live(真 Brain)。靠的是 `core/agent.ts` 已是 CLI/GUI 共用入口 + provider base URL 从 env 读。
3. **CLI 与 GUI 同核,后端先固化成最硬的回归层。** 大部分 case 在两个 surface 都跑,断言归一到同一套事件词表(§3)。
4. **case 用录制生成,不手写。** 修完 bug 跑一次录下修正后的事件轨迹当 reference(golden-trace),case 从真实运行长出来。
5. **live 层只断言结构不变量,不断言全文。** 真模型不可复现文字 → 只断言:工具开火 / 证据进 ledger / 可见答案非空 / 无 stale target / 关键 env 真实生效。
6. **每条 case 自带血缘。** 关联 issue id + 修复 commit,绿灯即证"这个历史坑死了"。
7. **加法,不破坏。** 现有 ~2600 vitest 测试原样保留;harness 是新增的 `tests/agent-regression/` + `cases/` + runner。

---

## 2. 架构总览

### 2.1 拱心石:env 指向的可脚本化假 Provider

整个架构的解锁点。现状已有种子:`cli/tests/code-agent-loop.test.ts` 的 `withBrainServer()`(`http.createServer` + SSE handler,拦 `POST /v1/chat/completions`,按轮次 `(body, count)` 变化响应)。把它升级成一个**常驻、env 指向、可按脚本逐轮编排**的假 provider:

```
                    ┌─────────────────────────────────────┐
   case.yaml  ──▶   │  Regression Runner                  │
                    │  - 加载 case + provider_script       │
                    │  - 选 target(mock/local/live)       │
                    │  - 选 surface(cli/gui)              │
                    └──────────────┬──────────────────────┘
                                   │
          ┌────────────────────────┼────────────────────────┐
          ▼                        ▼                        ▼
   target=mock              target=local              target=live
   进程内假 provider          假 provider 起 HTTP        真 Brain
   (vi.hoisted adapter)      server(env 指向)          (82.156.182.240 / WS)
   真本地工具=stub           真本地工具=真跑            真工具真跑
          │                        │                        │
          └────────────────────────┼────────────────────────┘
                                   ▼
                    共用入口:core/agent.ts(CLI)
                              server/routes/chat.ts WS hub(GUI)
                                   │
                                   ▼
                       归一化事件流(§3)→ 断言
```

**假 provider 脚本格式(§5)** 必须能逐轮产出:content delta / tool_call(name+args)/ 空答 / reasoning-only / 延迟到超时 / 错误(测 fallback)。wire 格式 = OpenAI 兼容 SSE(Lynn adapter 已说这个方言,`sse()` formatter 已存在)。

### 2.2 三个 target 的差异

| target | 假 provider | 本地工具 | 网络 | 速度 | 测什么 |
|---|---|---|---|---|---|
| **mock** | 进程内(vi.mock adapter) | stub | 无 | 最快(ms) | 路由 / 事件顺序 / 工具调用 / fallback / 空答收口 / reasoning-only / 超时打回 / prompt 污染 |
| **local** | 真 HTTP server(env 指向) | **真跑** | 仅本机 | 中(s) | 文件读写 / bash / 代码执行 / workspace / evidence ledger / JSONL 输出 |
| **live** | 无(真 Brain/StepFun) | 真跑 | 跨境 | 慢 | 真实 Brain/fallback 是否活着;只断言结构不变量 |

---

## 3. 事件流契约(归一化事件词表)

case 写在**稳定词表**上;runner 按 surface 把 Lynn 真实事件映射过来。这是"一个 case 跨 CLI/GUI/router 统一断言"的关键(等价 agentevals 把轨迹归一到 OpenAI message list)。

| 归一事件 | CLI 来源 | GUI 来源(WS / chat.ts) | Router 来源 |
|---|---|---|---|
| `prompt.accepted` | `runCode` 起 | `prompt_start {sessionPath,routeIntent,streamToken}` | — |
| `route.selected` | — | — | router `providerId` 选定 |
| `route.fallback` | — | — | `fallback_from` / `classifyProviderFallbackReason` |
| `assistant.thinking` | think 回调 | `thinking_start`/`think_text` | — |
| `tool.called` | tool 回调 | `tool_start {toolName}` / `tool_call {name,args}` | server tool inline |
| `tool.result` | tool 回调 | `tool_end {toolName,success}` / `tool_result` | — |
| `evidence.recorded` | ledger append | `hub-event-forwarder`(`REALTIME_EVIDENCE_TOOL_NAMES`) | — |
| `assistant.text` | text 回调 | `text_delta`(可见) | — |
| `assistant.final` | 完成 | `assistant_final` / `turn_end {hasOutput}` | — |
| `turn.closed` | — | `turn_close {reason}` | — |
| `retry.internal` | — | `internalRetryReason`(v0.79 后默认关) | — |
| `stream.released_stale` | — | `turn_close reason=stale_stream_release` | — |
| `busy.fenced` | — | `turn_close reason=busy_new_prompt` | — |

> ⚠️ **持久 WS 硬要求**:GUI-surface case 必须用**持久 WS**(整个 case 一条连接),不能每条 prompt 新建 WS——否则 internal-retry 文本与跨轮状态丢失,产生假阴性(已知坑:V8 测试脚本每 prompt 新 WS,真 Lynn UI 是持久 WS)。

---

## 4. Case 格式(YAML)

设计成**超集**:结构契约为主(必填),model-quality 断言可选(默认关,只在 live/nightly 开)。

### 4.1 Schema

```yaml
id: retry-no-stale-prompt           # 唯一 id
issue: IJV6WH                        # 血缘:线上 issue id(无则 internal-NNN)
fix_commit: ebdd48db                 # 血缘:修复 commit(录制时落)
tags: [retry, session, pollution]
surfaces: [cli, gui]                 # 在哪些 surface 跑(同核 → 多数 both)
targets: [mock]                      # mock / local / live
provider_script: retry-then-new      # mock/local 用:§5 假 provider 脚本 id
timeout_ms: 8000

steps:                               # 有序交互(多步:retry 后再问新问题)
  - send: { mode: prompt, text: "上一个问题" }
    expect:
      route: { provider: brain-v2 }
      events: [prompt.accepted, assistant.final]
      events_match: subsequence      # strict | subsequence | unordered
      visible_answer: true

  - action: retry_assistant          # 内置动作:重答上一条
    expect:
      replace_target: user-1         # 这一步**应该**带回滚目标(正确)

  - send: { mode: prompt, text: "这是一个全新的问题" }
    expect:
      visible_answer: true
      no_stale_replace_target: true  # 关键:新 prompt **不得**带 replaceFromMessageId/Index
      not_contains: ["上一个问题"]
      tool_calls: []

# 可选,仅 live/nightly:
model_quality:
  enabled: false
  judge: deepseek-v4-pro
  rubric: "答案直接回应了问题且无脑补"
```

### 4.2 expect 字段全集

| 字段 | 含义 | 适用 target |
|---|---|---|
| `route.provider` / `route.fallback_from` | 路由命中 / fallback 来源 | all |
| `events` + `events_match` | 归一事件序列(子序列/严格/无序) | all |
| `tool_calls: [{name, args_match}]` | 工具调用 + 参数匹配(strict/subset) | all |
| `evidence_ledger: [{tool, present}]` | 证据进 ledger | local/live |
| `visible_answer: true\|false` (+`non_empty`) | 最终有可见答案 | all |
| `contains` / `not_contains` | 文本包含/排除(结构层用,非全文比对) | all |
| `no_stale_replace_target: true` | 无跨 prompt 污染 | all(GUI 重) |
| `recovery: {empty\|timeout\|tool_failed: closed_visible}` | 异常被正确收口 | mock/local |
| `env_invariant: {STEP_TEXT_MODEL: step-3.7-flash}` | 关键 env 真实生效 | live |

---

## 5. 假 Provider 脚本格式(keystone 细节)

`cases/providers/<id>.yaml`,描述假 provider **逐轮**怎么回:

```yaml
id: retry-then-new
turns:                               # 按收到的第 N 个上游请求匹配
  - match: { contains: "上一个问题" }
    emit: { content: "这是上一个回答。" }

  - match: { contains: "全新的问题" }
    emit:
      tool_call: { name: web_search, args: { query: "..." } }
    then:                            # 工具结果回灌后的下一轮
      emit: { content: "基于证据的答案。" }

# 异常剧本(测收口),各起一条 case:
# emit: { empty: true }                     # 空答 → 应触发收口/重试
# emit: { reasoning_only: "...只有思考无正文" }
# emit: { delay_ms: 999999 }                # 超时 → 应被 turn hard-abort 收口
# emit: { error: { status: 500 } }          # 上游错 → 应 fallback 到下一 provider
```

- **mock target**:脚本喂给进程内 `vi.hoisted` adapter。
- **local target**:脚本喂给常驻 HTTP server,env(`STEP_BASE` / Brain base URL)指向它;Lynn 真实启动、真跑本地工具。
- 录制模式:`--record` 把真 Brain 一次响应录成脚本 + 把归一事件流录成 reference(golden-trace)。

---

## 6. Runner

- 位置:`tests/agent-regression/runner.ts`(vitest 驱动)+ `scripts/agent-regression.mjs`(CLI 入口,供 gate)。
- 入参:`--target mock|local|live` `--surface cli|gui|both` `--filter <tag/id>` `--record`。
- 对每条 case:起目标环境 → 顺序执行 steps → 收归一事件流 → 比对 `expect` → 出结构化报告(pass/fail + 事件 diff)。
- GUI surface:持久 WS;CLI surface:`core/agent.ts` 回调。
- 失败输出 = 事件流 diff(期望 vs 实际),不是文字 diff。

---

## 7. Case Bank 规范

```
cases/
  providers/                 # 假 provider 脚本
    retry-then-new.yaml
    empty-then-recover.yaml
    timeout-fence.yaml
  contracts/                 # 通用行为契约(非某个具体 bug)
    routing-capability-gating.yaml
    tool-evidence-into-ledger.yaml
    busy-session-fence.yaml
  issues/                    # 每个线上 bug 固化一条
    IJV6WH-retry-pollution.yaml
    sports-direct-evidence-overwrite.yaml
    local-file-latex-false-evidence.yaml
    windows-d-drive-workspace.yaml
    reasoning-empty-answer.yaml
  golden/                    # 录制的 reference 事件轨迹
    IJV6WH-retry-pollution.trace.json
```

铁律:**以后每个线上 bug 必须变成一条 `issues/` case**,关联 issue id + fix commit。发版前问一句"这些历史坑有没有重新炸"。

---

## 8. 前端层(Playwright + Electron)

补 jsdom-only 缺口。`_electron.launch` 指向 main 入口 + electron-playwright-helpers(IPC / dialog 桩)。`getByTestId` ↔ `data-testid`。

**10 条关键用户路径**:新建会话 · 输入问题等可见答案 · 点重新回答 · 再输入新问题(断言不复用旧问题)· 编辑重发 · 切模型 · 选 workspace · 附件/本地文件读取 · 设置页保存 provider · 下载/更新提示。

重点不是截图像不像,而是:路径能否走完 · 关键文本/按钮/状态是否出现 · WS payload 是否正确。

**配套**:建 `data-testid` 注册表(`desktop/src/react/testids.ts`),关键节点统一引用,禁止靠坐标点。

---

## 9. Gate 分级

| Gate | 触发 | 内容 | 预算 | 映射现有 |
|---|---|---|---|---|
| **PR smoke** | 每次 PR | mock 全量 + 5 条最关键 issue case | <5 min | 扩 `test:brain-v2:critical` |
| **release gate** | 发版前 | mock 全量 + local 全量 + GUI 10 路径 | 完整核心回归 | 接 `release:preflight` / `test:release:ui` |
| **nightly live** | 定时 | live 小而硬(CLI 真任务 / GUI 真任务 / sports·weather·stock 直证据 / vision / voice) | 长测 | 新增 cron |
| **quarantine** | 手动标记 | 不稳定 live case 单独隔离,**不阻断日常开发** | — | `tags: [quarantine]` |

---

## 10. 与现有测试的关系 / 非目标

- **加法**:现有 ~2600 vitest 测试 + cli/brain 子套件原样保留。harness 复用 vitest runner,新增目录。
- 现有 `prompt-actions.test.ts:357`(retry-pollution)= 第一条被泛化的模板:手写 TS → 声明式 case + 录制 reference。
- 现有 `withBrainServer` / `vi.hoisted` adapter / MSW = 假 provider 的现成地基。
- **非目标**:不做模型质量打分平台;不替换现有单测;不引入 Python eval 框架进核心;不依赖 promptfoo 当脊柱。

---

## 11. 落地阶段(按杠杆排)

1. **P0 拱心石**:`withBrainServer` → env 指向、可脚本化常驻假 provider(§5)。**用 retry-pollution 一条 case 证明它在 mock + live 两 target 跑通。** 架构成立 = 这步成立。
2. **P1 schema + runner**:定 YAML(§4)+ 三 target runner(§6)+ 归一事件词表(§3)落地。
3. **P2 case bank**:把最近 20 个真实 bug **录制**进 `issues/`。
4. **P3 前端**:`data-testid` 注册表 + Playwright 10 路径。
5. **P4 gate**:四级 gate 接 CI / cron。

---

## 12. 待评审的开放问题(给 Codex / GPT-5.5XH)

1. 归一事件词表(§3)是否覆盖全?有没有漏掉的关键收口事件(tool authorization grace / edit-rollback discard / 空答 cooldown)?
2. 假 provider 的 wire 方言:除了 OpenAI SSE,Brain v2 内部还有没有别的上游协议需要假 server 兼容(DeepSeek reasoning_content 回传、StepFun 变体)?
3. local target 起真 HTTP server 让 Lynn env 指向——会不会和 Brain v2 的 provider-registry 健康探测/cooldown 打架?要不要专门一个 `p-fake` provider 注册位?
4. live 层跨境(Mac → 腾讯 Brain)放 nightly,是否需要一个境内 runner(N5/Spark 起)避免抖动?(注:Mac 不做计算,但这是网络发起,非计算)
5. case 录制模式如何保证不把真实 key / PII 写进 golden trace(VCR 的 scrub 纪律)?
6. 与 `release:preflight` 现有门禁如何合并,避免双套 gate?
