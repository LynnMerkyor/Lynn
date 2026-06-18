# PLAN — 用自研 runtime 替换 Pi SDK(`@mariozechner/pi-*`)

> 状态:**已落地主迁移(2026-06-19 / commit `e6406600`)** · 作者:Lynn/Claude · 日期:2026-06-18
> 关联:[CLAUDE.md](../CLAUDE.md) 模型路由纪律 · 受 KunAgent/Kun "零厂商 Agent SDK" 思路启发

---

## 2026-06-19 落地状态

当前工作树已完成本计划的主迁移:
- `@mariozechner/pi-*` 依赖已从 `package.json` / lockfile 移除。
- `scripts/patch-pi-sdk.cjs` 与 build-server 的 Pi patch/prune 逻辑已删除。
- 四个会话入口统一走 `core/agent-runtime/create-session.ts` 的 Lynn native runtime。
- `core/brain-managed-tools.ts` 已成为 Brain 托管工具的单一清单。

本文保留为迁移设计记录与后续 hardening checklist。下文早期章节仍会描述迁移前的 Pi SDK 结构,用于解释为什么做这次替换。

## 0. 背景与动机

### 0.1 "PI-SDK" 是什么
Lynn **桌面端 `core/` 的 Agent 运行时** = `@mariozechner/pi-*`(Pi SDK,Apache 2.0,badlogic/pi-mono):
- `pi-ai`(~22K LOC):多 provider 传输层(OpenAI/Anthropic/Google/… 20+,流式、工具调用解析、OAuth、thinking 路由)
- `pi-agent-core`(~1K LOC):agent loop / turn 引擎 / 工具执行编排
- `pi-coding-agent`(~32K LOC):`createAgentSession()`、内置工具(read/write/edit/bash/grep)、SessionManager、ModelRegistry、AuthStorage、Skills、compaction
- `pi-tui`(~8K LOC):终端 UI —— **桌面端不需要(有 Electron renderer),只 CLI 才用**

Lynn 是 `liliMozi/openhanako` 的 fork,并用 `scripts/patch-pi-sdk.cjs`(686 行,postinstall)给编译后的 Pi SDK 打 6 个补丁。

### 0.2 为什么要替换(动机)
1. **补丁层极脆**:6 个补丁全靠 **字符串 needle 匹配改编译产物**,Pi SDK 一升版就可能静默失效。其中 **Patch 3B(Brain 托管工具 trace 抑制)** 失效 = 线上"金价串到英伟达"内容串台 + 红叉假失败回归,且无报错。另有 `BRAIN_MANAGED_CUSTOM_TOOLS` 清单在 **3 处手工同步**(patch / `session-tool-runtime.ts` / `session-event-handler.ts`)。
2. **痛点都在 Pi SDK 边界**:近期 prod 故障(内容串台、工具双执行、空答)几乎都发生在"请求构造 + 流解析"那一层(`pi-ai` 的 `openai-completions`)。Lynn 不拥有这层 → 只能事后打补丁。
3. **战略差异化(与 Kun 对比)**:Kun = 本地 BYOK 单 runtime;**Lynn = 云端 Brain V2 多模型 + 复核**。Brain V2 当前策略:**Step 3.7 Flash 在第一位(编排/执行),Hanako 复核 DS V4 优先,MiMo/GLM 作为后续 fallback**。这套"快执行 + 稳复核"的混合架构,要求客户端 loop 能**忠实参与**(本地工具 + Brain 已执行工具的区分、复核结果的渲染)。Patch 3B 的存在恰恰证明:**只要不拥有 loop,这套差异化就得靠脆弱补丁硬撑**。

### 0.3 不是 license 问题
Pi SDK 是 **Apache 2.0**(干净),与 [[dont-fork-agpl-inference-engines]] 铁律无关。本替换纯属 **控制力 / 稳定性 / 维护成本** 取舍。

---

## 1. 现状盘点

### 1.1 耦合面(中偏紧,但缝可收口)
- Pi SDK 符号 **~35 个**,落在 core / hub / lib/tools 多处。Codex 复核指出:真实耦合比最初估计更深,不能只改 bridge。
- **真正的 session 创建入口有 4 个**,必须先统一到 Lynn 自己的薄工厂:
  - `core/session-coordinator.ts`(主聊天)
  - `core/bridge-session-manager.ts`(bridge guest / owner)
  - `core/session-isolated-executor.ts`(isolated / dry-run)
  - `hub/agent-executor.ts`(hub worker / agent executor)
- 其它 Pi 泄漏还包括:`core/constants.ts` 的 `codingTools`、`lib/sandbox/index.ts` 的内置工具构造器、`core/model-manager.ts` 的 `AuthStorage/ModelRegistry`、`core/engine.ts` 的 `DefaultResourceLoader`。这些不必在 P1a 一次性替换,但必须在文档与门禁里显式跟踪。
- 工具侧大量 `StringEnum` 只作为 JSON schema builder 使用,可在 P0 先替换成 Lynn 自有小工具,降低后续改动面。

### 1.2 必须复刻的契约(replacement 要提供的)
| 模块 | Pi 符号 | 说明 |
|---|---|---|
| 会话工厂 | `createAgentSession(opts) → {session}` | Pi session 工厂;P0 先把 4 个直接入口收敛到 Lynn 工厂 |
| 会话对象 | `session.prompt/abort/steer/setModel/subscribe` | 流式 + 多轮 + 工具 |
| 事件流 | `AgentSessionEvent`(message_update / toolcall_start/end / message_end …) | 串到 UI + 工具检测 |
| 传输 | `Model<Api>` / `pi-ai` stream | OpenAI 兼容,连 Brain/BYOK |
| 工具 | `ToolDefinition` / `codingTools` / `StringEnum` | schema + 执行 |
| 资源 | `ResourceLoader`(getSystemPrompt/getSkills) | system prompt + skills |
| 持久化 | `SessionManager`(open/create/getCwd/appendMessage) | JSONL 会话 |
| 凭据 | `AuthStorage` / `ModelRegistry` / `registerOAuthProvider` | key/OAuth |

### 1.3 补丁税与分阶段消除清单
| Patch | 作用 | 失效后果 | 可消除阶段 |
|---|---|---|---|
| 1 baseToolsOverride | 自定义工具塞进 session | Windows 工具全废 | **P1b/P2**:自研内置工具或自研 loop 后 |
| 2 deepseek schema | thinkingFormat 加 deepseek | DS thinking 400 | **P3**:去 Pi `ModelRegistry` 后 |
| 3A 空 tools 剥离 | 防 `tools:[]` 被 DashScope/火山 400 | 工具静默失败 | **P1a**:请求构造期不发空 |
| **3B Brain 工具 trace 抑制** | 防 Brain 已执行工具被本地二次跑 | **内容串台/假失败** | **P1a**:请求构造期过滤 + 共享清单 |
| 3C/3D thinking 格式 | GLM zai / DeepSeek reasoning_effort | 推理 400 | **P1a**:统一 `buildThinking` |
| 3E 请求头透传 | Brain 签名头 | Brain 401 | **P1a**:原生 fetch headers |
| 4/5 缺 usage 容错 | turn_end/stats 防 undefined | 边缘崩 | **P2**:自管 loop / usage 生命周期后 |
| 6 truncate 50→100KB | 读文件上限 | 长文档被切 | **P1b/P2**:自管 read 工具后 |
> 仍需保留(架构固有,非 Pi 锅):provider thinking 格式映射、Brain 托管工具识别、签名头注入、缺 usage 容错。

### 1.4 现成模板:CLI 已经零 Pi SDK
`@lynn/cli` **完全自研**(仅依赖 `ink`+`react`):`brain-client.ts`(fetch+SSE 传输)、`code-agent-loop.ts`(798 行 loop)、`provider-profile.ts`/`provider-presets.ts`(provider 体系)、`tools/registry.ts`、`usage-telemetry.ts`。探子评估 **~40-50% 可直接移植** 到 core 替换 Pi SDK。

---

## 2. 目标架构

```
                 ┌─────────────────────────────────────────────┐
   4 个 session 入口 ───────────► createLynnAgentSession(opts)   │   ← 统一接缝(§4)
                 │                      │                        │
                 │              LynnAgentSession                 │
                 │        (实现与 Pi 同形的 AgentSessionEvent 契约) │
                 │           │            │            │         │
                 │      owned loop   owned transport  tool reg   │
                 │   (←CLI code-    (←CLI brain-      (←CLI       │
                 │    agent-loop)    client + §5)     tools)      │
                 └─────────────────────────────────────────────┘
   保留(先不动): SessionManager / AuthStorage / Skills / MCP / vision  → 后期 P3 迁出
   丢弃: pi-ai · pi-agent-core · pi-coding-agent · pi-tui · patch-pi-sdk.cjs
```

---

## 3. 分阶段路线(已按 §8 Codex 复核修正工期与范围)

| 阶段 | 做什么 | 真实可删补丁 | 工期 |
|---|---|---|---|
| **P0 解耦零碎** | 统一 4 个入口工厂、集中 `BRAIN_MANAGED_CUSTOM_TOOLS`(现散 3 处)、替 `StringEnum`;锁 Pi 版本 `=x.y.z`;启动 Hana/Hanako legacy namespace 盘点与 alias 层。**暂不声称去 Pi** | — | 1-2w |
| **P1a 接管 transport** ⭐ | CLI `brain-client` 替 `pi-ai` openai-completions,quirk 进请求构造期;**保留 Pi loop** | 3A 空tools / 3B Brain trace / 3C-3D thinking / 3E 头 | 2-3w |
| **P1b 自研内置工具** | read/bash/write 等工具 parity | 1 baseToolsOverride / 6 truncate | 1-2w |
| **P2 接管 loop** | `createLynnAgentSession()`,**真 Pi 事件 parity** + tool runtime rebuild + compaction + session JSONL + abort/steer/setModel | 4/5 缺 usage(自管后) | 4-6w |
| **P3 收尾** | AuthStorage/ModelRegistry/ResourceLoader/OAuth/MCP/vision 迁出 | 2 deepseek schema(去 Pi ModelRegistry 后) | 4-8w |

> **关键修正(Codex)**:"P1 = 6 补丁全删"**不成立**。补丁 1 是 coding-agent 工厂问题,4/5/6/2 依赖 Pi 的 compaction/stats/read-tool/ModelRegistry → 要到 P1b/P2/P3 拥有对应模块才能删。**P1a 只能删 transport 类补丁(3A/3B/3C/3D/3E)**。
- **轻量版 = P0+P1a(+P1b)**:**3-5 周删掉 transport 类补丁、根除 Brain 串台风险**,保留 Pi coding-agent 补丁。(原稿"3-4 周删全部 6 补丁"高估,已更正。)
- **彻底版 = P0→P3**:~2-4 月,CLI 与桌面统一一套 runtime,retry/空答/污染一处修。

---

## 4. 接缝具体改法:4 个入口统一换缝(本节为重点)

### 4.1 现状
```ts
// 多处现状类似,直接依赖 Pi
import { createAgentSession, type AgentSession, type AgentSessionEvent,
         type CreateAgentSessionOptions, type ToolDefinition,
         SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import type { Api, ImageContent, Model } from "@mariozechner/pi-ai";

const { session } = await createAgentSession(opts);  // ← 现状:4 个入口各自直接调用
```
实际不是一个入口,而是 4 个入口各自直接调用 `createAgentSession()`。所以 P0 的第一步不是替换 bridge,而是新增 `core/agent-runtime/create-session.ts`,把这 4 个入口全部改为调用同一个薄工厂。只有先收口,feature flag 才能覆盖主聊天 / bridge / isolated / hub。

### 4.2 三步换缝(零行为变更 → 渐进替换)

**Step 1 — 把契约"提"成 Lynn 自己的类型**(去掉对 Pi 类型的 import 泄漏)
```ts
// core/agent-runtime/contract.ts(新增 —— Lynn 自有契约,镜像 Pi 当前形状)
export interface LynnModel { provider: string; id: string; baseUrl?: string;
  apiKey?: string; reasoning?: boolean; /* …Brain 透传字段… */ }
export interface LynnImageContent { mediaType: string; data: string }
export interface LynnToolDefinition { name: string; description: string;
  parameters: object; execute(args: any, ctx: ToolCtx): Promise<ToolResult> }

export type AgentSessionEvent =
  | { type: "message_update"; partial: AssistantMessage }
  | { type: "toolcall_start"; id: string; name: string; args: unknown }
  | { type: "toolcall_end";   id: string; result: ToolResult }
  | { type: "message_end";    message: AssistantMessage; usage?: Usage }
  | { type: "error";          error: string };

export interface LynnAgentSession {
  prompt(opts: PromptOptions): Promise<void>;
  steer(text: string): void;
  abort(): void;
  setModel(model: LynnModel): void;
  subscribe(listener: (e: AgentSessionEvent) => void): () => void;
}
export interface CreateSessionOptions {
  model: LynnModel;
  tools: LynnToolDefinition[];
  resourceLoader: ResourceLoader;      // getSystemPrompt / getSkills
  settings: { maxCompletionTokens?: number; compaction?: CompactionPolicy };
  sessionManager: SessionManager;      // P1/P2 仍复用 Pi 的;P3 自研
  authStorage?: AuthStorage;
  requestHeaders?: Record<string,string>;   // ← Brain 签名头(原 Patch 3E)
}
export interface AgentRuntime {
  createSession(o: CreateSessionOptions): Promise<{ session?: LynnAgentSession; error?: string }>;
}
```

**Step 2 — 4 个入口统一依赖 Lynn 工厂(带 feature flag,可 A/B)**
```ts
// core/agent-runtime/create-session.ts(新增薄工厂)
import { getAgentRuntime } from "./index";                  // ← 暂时 pi-adapter,后续 lynn-native
import type { CreateSessionOptions, LynnAgentSession } from "./agent-runtime/contract";

const runtime = getAgentRuntime();   // env LYNN_OWN_RUNTIME 选 pi-adapter | lynn-native
const { session, error } = await runtime.createSession(opts);
```
```ts
// core/agent-runtime/index.ts
export function getAgentRuntime(): AgentRuntime {
  return process.env.LYNN_OWN_RUNTIME === "1"
    ? lynnNativeRuntime          // §5 自研 transport + CLI loop
    : piAdapterRuntime;          // 薄封装现有 Pi,默认,保证零回归
}
```

**Step 3 — `piAdapterRuntime` 先做透传**(把现有 `createAgentSession` 包成 `AgentRuntime`,**零行为变更**先合并),验证 4 个入口都走同一缝;再实现 `lynnNativeRuntime` 内部,用 flag 灰度切换。

### 4.3 为什么这样安全
- 4 个调用点(bridge / session-coordinator / isolated-executor / hub/agent-executor)**全走 `core/agent-runtime/create-session.ts` 一个工厂** → 一处切换、可回退。
- `pi-adapter` 与 `lynn-native` 并存,**同一台机器 A/B 对拍**(同任务跑两 runtime,比 success/工具调用/流式),通过才默认翻 flag。
- `lib/tools/*` 的 `StringEnum`(P0 先换)与 `LynnToolDefinition` 解耦,不卡在本阶段。

---

## 5. P1 transport 契约草图(本节为重点)

目标:用**自研传输**替掉 `pi-ai` 的 `openai-completions` 流路径,**把 transport 类补丁搬到"请求构造期"**(而非事后改流)。蓝本 = CLI `brain-client.ts`。

### 5.1 传输接口
```ts
// core/agent-runtime/transport.ts(新增)
export interface ChatRequest {
  model: LynnModel;
  messages: WireMessage[];
  tools: LynnToolDefinition[];        // 已剔除 Brain 托管工具(见 5.3)
  maxTokens: number;
  reasoningEffort?: "off"|"low"|"medium"|"high"|"xhigh";
  headers?: Record<string,string>;    // 签名头
  signal?: AbortSignal;
}
export type StreamEvent =
  | { type: "text_delta";      text: string }
  | { type: "reasoning_delta"; text: string }       // reasoning_content 分离
  | { type: "toolcall_delta";  id: string; name?: string; argsDelta: string }  // 局部 JSON
  | { type: "toolcall_end";    id: string; name: string; args: unknown }
  | { type: "tool_progress";    name: string; result?: unknown; status?: string } // Brain 已执行/进度(见 5.3)
  | { type: "usage";           usage: Usage }
  | { type: "done";            finishReason: "stop"|"toolUse"|"length" }
  | { type: "error";           error: string };

export interface Transport {
  streamChat(req: ChatRequest): AsyncIterable<StreamEvent>;   // fetch + SSE,见 CLI brain-client
}
```

### 5.2 请求构造器(补丁逻辑搬家处)
```ts
// 每 provider 的 thinking 格式(原 Patch 3C/3D 一次性收敛成数据表;Patch 2 仍等 P3 去 Pi ModelRegistry)
function buildThinking(model: LynnModel, effortRaw?: string): object {
  const fmt = THINK_FORMAT[model.provider];           // "zai" | "qwen" | "deepseek" | "step" | "none"
  // ⚠️(Codex 修正)桌面默认 effort = "auto"(Brain/deepseek auto→off,其它→medium),bridge guest 传 "none"
  const effort = normalizeEffort(model, effortRaw);   // 统一 auto|none|off|low|medium|high|xhigh,none/off/disabled→不发字段
  if (!effort || effort === "off" || effort === "none") {
    return fmt === "zai" ? {} /* GLM:省略字段,别发 disabled */
         : fmt === "qwen" ? { enable_thinking: false }
         : fmt === "deepseek" ? { thinking: { type: "disabled" } } : {};
  }
  return fmt === "zai"      ? { thinking: { type: "enabled" } }
       : fmt === "qwen"     ? { enable_thinking: true }
       : fmt === "deepseek" ? { thinking: { type: "enabled", reasoning_effort: mapEffort(effort) } }
       : fmt === "step"     ? { reasoning_effort: mapEffort(effort) } : {};
}

function buildBody(req: ChatRequest) {
  const body: any = { model: req.model.id, messages: req.messages,
                      max_tokens: req.maxTokens, stream: true, ...buildThinking(req.model, req.reasoningEffort) };
  if (req.tools.length) body.tools = toOpenAITools(req.tools);   // 原 Patch 3A:空则不发 tools 字段
  return body;
}
// 头:原 Patch 3E —— 直接 fetch(url,{headers:{...auth, ...req.headers}}),签名头原生支持
```

### 5.3 Brain 托管工具(原 Patch 3B 降级)
- **P0 先建共享清单**:`core/brain-managed-tools.ts`,供 `session-tool-runtime`、`session-event-handler`、`session-prompt-sanitizer`、未来 transport 同时引用。现状是 3 处手工同步,不是已经消灭。
- **请求构造期**:`tools` 在上层剔除 `BRAIN_MANAGED_CUSTOM_TOOLS`(`web_search/stock_market/...`)→ 避免 Brain 已执行工具被本地二次跑。
- **事件契约**沿用现有语义:`tool_progress` / `lynn.tool_progress` / `<lynn_tool_progress>` 是真实 UI/CLI 事件,不要另造只能内部理解的事件名。
- **流解析期**:遇到这些名字的 tool_call chunk → 映射为现有 `tool_progress` / `tool_execution_*` UI 事件(供 UI 展示"Brain 已查"),**不**当本地工具执行、**不**写 "tool not found"、`finishReason: toolUse → stop`(若无本地工具)。这与 Brain V2 "Step 执行 + Hanako(DS V4 优先,MiMo/GLM fallback)复核" 的服务端语义对齐:客户端只渲染,不重复执行。

### 5.4 SSE 解析(蓝本 brain-client `parseSsePayloads`)
- 逐行 `data:` → JSON;`choices[0].delta`:`content`→text_delta、`reasoning_content`→reasoning_delta、`tool_calls[].function`→toolcall_delta(局部 JSON 累积,完成再 `toolcall_end`)。
- 缺 `usage` 容错(原 Patch 4/5):自管 usage,缺则置 0。
- chunk 边界缓冲(参考 server `stream-sanitizer.js`)。

### 5.5 补丁 → 落点对照(验收用)
| 旧补丁 | 新落点 | 阶段 |
|---|---|
| 1 baseToolsOverride | 工厂直接收 `tools` / 自研工具 parity | P1b/P2 |
| 2 deepseek schema | 去 Pi `ModelRegistry` 后由 Lynn provider profile 管 | P3 |
| 3C / 3D thinking | `buildThinking()` 数据表 | P1a |
| 3A 空 tools | `buildBody()` 条件加字段 | P1a |
| 3B Brain trace | §5.3 请求剔除 + 现有 `tool_progress` / UI 事件 | P1a |
| 3E 头 | 原生 fetch headers | P1a |
| 4/5 usage | §5.4 自管 usage / loop | P2 |
| 6 truncate | 自研 read 工具常量 | P1b/P2 |

---

## 6. 风险 / 权衡 / 回退
- **provider 成熟度**:`pi-ai` 支持 20+;Lynn 实际只需 ~5(Brain / Step / DeepSeek / GLM / MiMo + BYOK openai-compatible),全 OpenAI 兼容 → 可控。CLI 已扛着同样的集合。
- **回退**:`LYNN_OWN_RUNTIME` flag + `pi-adapter` 常驻;出问题翻回 Pi,零风险灰度。
- **parity 测试**:同任务集跑 `pi-adapter` vs `lynn-native`,对比 success / 工具调用序列 / 流式增量 / usage。
- **6 补丁行为 → 回归用例**:内容串台(3B)、各 provider thinking(2/3C/3D)、签名头(3E)、空 tools(3A)、缺 usage(4/5)、长文件读(6)。
- **与 openhanako 上游分叉**:Lynn 已重度定制,上游合并价值低,可接受。

## 7. 建议
**先做 P0 + P1a(必要时含 P1b)**:ROI 最高,**3-5 周删除 transport 类补丁(3A/3B/3C/3D/3E)、根除内容串台与 Brain 头脆弱**,保留 Pi coding-agent 侧补丁。按**入口/provider/session 分级灰度**(`pi | native-transport | native-loop`),Brain auth/stream 失败能回退。做完再评估 P1b/P2/P3 是否把 CLI 与桌面统一成一套 Lynn 自有 runtime。

---
## 8. Codex 复核 — 修正与补充(已并入)
> codex-cli 0.140 `exec -s read-only` (high) 对照源码复核,结论"方向合理"但以下需修正(§3/§5/§7 已据此改):

**A. Pi 类型泄漏比 §1.1 深(不止 19 文件)**:`core/constants.ts`(codingTools/grep/find/ls)、`lib/sandbox/index.ts`(createReadTool/createBashTool…)、`core/model-manager.ts`(AuthStorage/ModelRegistry/registerOAuthProvider)、`core/engine.ts`(DefaultResourceLoader)。

**B. `AgentSessionEvent` 契约太薄**:真实消费者还依赖 `message_update.assistantMessageEvent`、`tool_execution_start/end`、`message_end`、`agent_end`、`skill_activated`、`auto_compaction_end`(见 `core/session-event-handler.ts`、`hub/agent-executor.ts`、`core/bridge-session-manager.ts`)。契约需补 `isStreaming/sessionManager/turnCount/setThinkingLevel`。

**C. 私有字段要转正式 API**:safe mode / plan mode / no-tool turn 现在直接改 Pi 私有 `_customTools/_baseToolsOverride/_buildRuntime`(`core/session-tool-runtime.ts`、`core/session-coordinator.ts`)→ 新 runtime 必须提供正式 `setToolRuntime()/withToolsDisabledForTurn()`。

**D. Brain trace 实为 3 处清单**(`session-tool-runtime` + `session-event-handler` + `session-prompt-sanitizer`)——"消灭到 1 处"是目标非现状 → 新建共享 `core/brain-managed-tools.ts` 供过滤/事件抑制/上下文清洗统一 import。**进度事件名用现有 `tool_progress`**(CLI `brain-client.ts` 解析 `lynn.tool_progress`,桌面 `core/events.ts` 解析 `<lynn_tool_progress>`);不要新增替代现有 UI 事件的私有 trace 名。

**E. `buildThinking` 要 normalize**(§5.2 已改):桌面默认 effort=`"auto"`(Brain/deepseek auto→off、其它→medium),bridge guest 传 `"none"`;原稿只识别 `"off"`,收 `"none"` 会误开 thinking。

**F. 缺口**:① parity 测试覆盖 **4 个入口**(主聊天 / bridge guest+owner / isolated dry-run / hub agent-executor),非只 bridge;② 回退**按入口/provider/session 分级**,非全局单 flag;③ provider 覆盖——CLI 目前只 OpenAI-compatible(`cli/src/reasoning.ts` 只塞 reasoning_effort),桌面 ModelRegistry/OAuth/Minimax 仍在 Pi,**不能说"CLI 已扛同样集合"**;④ **vision**:桌面有 Pi 特定图片形态 + vision 剥离(`bridge-session-manager.ts`/`session-coordinator.ts`),新 loop 须明确 wire image schema;⑤ **MCP 不能纯 P3**:工具构建已传 `activeMcpServers`(`session-tool-runtime.ts`),P2 接管 loop 时即须处理 MCP 注册与权限边界。

---

## 9. 并行迁移线:Hana/Hanako legacy namespace 清理

> 目标:趁 Pi SDK/runtime 替换这次大整理,把 OpenHanako/Hana 时代遗留的**工程命名**清掉;但保留用户真正理解的 **Hanako 复查品牌**。不要一把梭全局替换。

### 9.1 现状盘点(2026-06-18 初扫)

文件名层面仍有明确遗留:
- `shared/hana-root.ts`
- `desktop/src/react/hooks/use-hana-fetch.ts`
- `desktop/src/react/__tests__/hooks/use-hana-fetch.test.ts`
- `lib/**/hanako.md` 模板族
- `desktop/src/assets/Hanako.png` / `Hanako-1600.jpg`

代码/配置层面有几类:
- **Electron preload/global API**:`window.hana` 仍是大量前端入口;`desktop/src/modules/platform.js` 已把 `window.platform = window.hana`,这是迁移切口。
- **HTTP helper**:`hanaFetch` / `hanaUrl` 分布在设置、聊天、输入、状态栏等组件。
- **localStorage / event / CSS namespace**:`hana-theme`、`hana-task-mode`、`hana-current-channel`、`hana-*` 自定义事件、`.hana-toggle`、`--hana-text`。
- **协议/运维**:`hana-cli` WebSocket subprotocol、`hanako-notary` 默认 notary profile、`persist:hana-browser` 分区名。
- **兼容迁移**:对 `~/.hanako`、OpenHanako 污染数据、自愈脚本的引用是历史兼容逻辑,不能删,但应该收拢到 `legacy/openhanako` 命名空间。
- **产品角色**:`Hanako` 作为复查角色/头像/文案仍是当前产品语义,不属于必须删除项;但内部字段应避免把 reviewer、yuan、legacy Hanako 混成一件事。

### 9.2 清理原则

1. **用户可见品牌与内部 legacy 分开**:保留 "Hanako · DS V4" 作为复查展示名(DeepSeek V4 Flash 优先,MiMo/GLM 备用);内部 API/文件名优先改成 `review` / `reviewer` / `lynn`。
2. **新增 Lynn 名,保留 Hana 兼容 alias**:先写 `window.lynn` / `lynnFetch` / `lynn-*` key,同时读取旧 `window.hana` / `hana-*`;至少保留 2-3 个版本再移除。
3. **迁移只写新键,读取双键**:localStorage、session prefs、browser partition、WS protocol 都采用 read-old/write-new。避免老用户升级后设置丢失。
4. **不动历史兼容语义**:`~/.hanako`、OpenHanako 数据修复、NOTICE/source attribution 必须保留,但挪到清晰的 legacy 模块/注释。
5. **每步有真实门禁**:Settings、主聊天、复查、CLI、websocket、browser viewer、onboarding 都要跑 installed gate;这类 rename 最容易是 UI 小按钮失灵。

### 9.3 分阶段执行

| 阶段 | 工作 | 风险 |
|---|---|---|
| **H0 盘点/冻结** | 生成 `reports/hanako-legacy-inventory.md`;标注 Keep(品牌/兼容) / Rename(工程命名) / Alias(读旧写新) | 低 |
| **H1 API alias** | preload 暴露 `window.lynn`,保留 `window.hana` alias;新增 `lynnFetch/lynnUrl`,旧 `hanaFetch` 只 re-export | 中 |
| **H2 存储/事件双轨** | `hana-*` localStorage/event 改为读旧写 `lynn-*`;CSS `.hana-*` 增加 `.lynn-*` 等价类 | 中 |
| **H3 文件与模块重命名** | `hana-root.ts→lynn-root.ts`, `use-hana-fetch.ts→use-lynn-fetch.ts`;保留 thin compatibility 文件 | 中 |
| **H4 语义收口** | reviewer 配置里把内部 `hanakoReviewerId` 迁为 `primaryReviewerId` 或 `reviewer.hanako.id`;仍显示 Hanako | 高 |
| **H5 删除 alias** | 多版本后再移除旧 `hana-*` 写入路径;保留 OpenHanako 数据迁移模块 | 高 |

### 9.4 与 Pi SDK 替换的关系

- **P0 同步做 H0/H1**:先建立 alias 和 inventory,不改变业务行为。
- **P1a/P1b 做 H2/H3**:transport 与工具收口时,顺手把 helper/import 名从 `hanaFetch` 迁到 `lynnFetch`。
- **P2 以后再碰 H4**:reviewer/yuan/agent 语义和自研 loop、复查事件契约强相关,不要在 transport 阶段贸然改。

### 9.5 验收门禁

- GUI installed gate:Settings 全 tab、主聊天、模型设置、复查卡片、browser viewer、onboarding。
- CLI gate:WS subprotocol `lynn-cli` 可用,`hana-cli` 兼容可用。
- 数据迁移:旧 `hana-*` localStorage 和 `~/.hanako` 哨兵用户升级后不丢配置,新写入只落 `lynn-*`。
- 搜索/复查:Hanako 复查显示 "Hanako · DS V4",但代码路径不再依赖 `hanaFetch`/`window.hana` 作为唯一 API。

---

*附:本文基于对 `core/`、`cli/`、`scripts/patch-pi-sdk.cjs`、`node_modules/@mariozechner/*` 的调研 + codex-cli 源码复核。实施前以源码为准复核每个接缝。*
