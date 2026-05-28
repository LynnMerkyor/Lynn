/**
 * Hub — 消息调度中枢
 *
 * 同进程模式：Hub 和 HanaEngine 跑在同一个 Node 进程里。
 * hub.send() 内部直接调 engine 方法，行为零变化。
 * EventBus 通过 engine.setEventBus() 注入，统一事件广播。
 *
 * 模块：
 *   EventBus      — 统一事件总线
 *   ChannelRouter  — 频道 triage + 调度
 *   GuestHandler   — Guest 留言机
 *   Scheduler      — Heartbeat + Cron
 */

import { EventBus } from "./event-bus.js";
import type { EventCallback, EventFilter, HubEvent } from "./event-bus.js";
import { ChannelRouter } from "./channel-router.js";
import { GuestHandler } from "./guest-handler.js";
import type { GuestMeta } from "./guest-handler.js";
import { Scheduler } from "./scheduler.js";
import { AgentMessenger } from "./agent-messenger.js";
import { DmRouter } from "./dm-router.js";

type HubRole = "owner" | "agent" | "guest" | string;

type HubMessageMeta = GuestMeta & {
  name?: string;
  avatarUrl?: string;
  userId?: string;
};

type HubPromptImage = unknown;

export interface HubSendOptions {
  sessionKey?: string;
  role?: HubRole;
  ephemeral?: boolean;
  meta?: HubMessageMeta;
  isGroup?: boolean;
  cwd?: string;
  model?: string;
  persist?: string;
  from?: string;
  to?: string;
  onDelta?: (delta: string) => void;
  images?: HubPromptImage[];
  sessionPath?: string;
  agentId?: string;
  streamToken?: string;
  systemAppend?: string;
  disableTools?: boolean;
  turnInstruction?: string;
  maxRounds?: number;
  signal?: AbortSignal;
}

interface HubAgent {
  agentDir?: string;
  config?: Record<string, unknown>;
  personality?: string;
  systemPrompt?: string;
  tools?: unknown[];
  agentName?: string;
  _dmSentHandler?: (fromId: string, toId: string) => void | Promise<void>;
  _notifyHandler?: (title: string, body: string) => void;
  _channelPostHandler?: (channelName: string, senderId: string) => void;
  [key: string]: unknown;
}

interface HubEngine {
  [key: string]: unknown;
  _hub?: Hub;
  agentsDir: string;
  channelsDir: string;
  productDir: string;
  userDir: string;
  homeCwd?: string;
  currentAgentId?: string | null;
  currentModel?: { id?: string; provider?: string; name?: string } | null;
  agent?: HubAgent;
  agents?: Map<string, HubAgent>;
  getAgent(id: string): HubAgent | null | undefined;
  ensureAgentLoaded?: (agentId: string) => Promise<HubAgent | null> | HubAgent | null;
  resolveUtilityConfig?: () => Record<string, unknown>;
  setEventBus(eventBus: EventBus): void;
  prompt(text: string, opts?: Record<string, unknown>): Promise<unknown>;
  promptSession(sessionPath: string, text: string, opts?: Record<string, unknown>): Promise<unknown>;
  executeExternalMessage(
    text: string,
    sessionKey: string,
    meta?: HubMessageMeta,
    opts?: Record<string, unknown>,
  ): Promise<string | null>;
  executeIsolated(text: string, opts?: Record<string, unknown>): Promise<unknown>;
  abort(): Promise<unknown>;
  abortSession(sessionPath: string): Promise<unknown>;
  dispose(): Promise<unknown>;
}

type HubRouteContext = Required<Pick<HubSendOptions, "role" | "ephemeral" | "isGroup" | "disableTools" | "turnInstruction">>
  & Omit<HubSendOptions, "role" | "ephemeral" | "isGroup" | "disableTools" | "turnInstruction">;

interface HubRoute {
  match: (opts: HubRouteContext) => unknown;
  handle: () => Promise<unknown> | unknown;
}

type ChannelRouterCtorOptions = ConstructorParameters<typeof ChannelRouter>[0];
type GuestHandlerCtorOptions = ConstructorParameters<typeof GuestHandler>[0];
type AgentMessengerCtorOptions = ConstructorParameters<typeof AgentMessenger>[0];
type DmRouterCtorOptions = ConstructorParameters<typeof DmRouter>[0];

export class Hub {
  private readonly _engine: HubEngine;
  private readonly _eventBus: EventBus;
  private readonly _channelRouter: ChannelRouter;
  private readonly _guestHandler: GuestHandler;
  private readonly _scheduler: Scheduler;
  private readonly _agentMessenger: AgentMessenger;
  private readonly _dmRouter: DmRouter;
  private _bridgeManager: unknown | null;

  constructor({ engine }: { engine: HubEngine }) {
    this._engine = engine;
    this._eventBus = new EventBus();
    this._channelRouter = new ChannelRouter({ hub: this } as unknown as ChannelRouterCtorOptions);
    this._guestHandler = new GuestHandler({ hub: this } as unknown as GuestHandlerCtorOptions);
    this._scheduler = new Scheduler({ hub: this });
    this._agentMessenger = new AgentMessenger({ hub: this } as unknown as AgentMessengerCtorOptions);
    this._dmRouter = new DmRouter({ hub: this } as unknown as DmRouterCtorOptions);

    // 双向引用：engine 也能拿到 hub
    engine._hub = this;

    // 注入 EventBus（替代旧的 proxy hack）
    engine.setEventBus(this._eventBus);

    this._setupNotifyHandler();
    this._setupDmHandler();
  }

  get engine(): HubEngine { return this._engine; }

  get eventBus(): EventBus { return this._eventBus; }

  get channelRouter(): ChannelRouter { return this._channelRouter; }

  get scheduler(): Scheduler { return this._scheduler; }

  get bridgeManager(): unknown | null { return this._bridgeManager || null; }
  set bridgeManager(bm: unknown | null) { this._bridgeManager = bm; }

  // ──────────── 订阅 ────────────

  subscribe(callback: EventCallback, filter?: EventFilter): () => boolean {
    return this._eventBus.subscribe(callback, filter);
  }

  // ──────────── 消息统一入口 ────────────

  async send(text: string, opts: HubSendOptions = {}): Promise<unknown> {
    const {
      sessionKey,
      role = "owner",
      ephemeral = false,
      meta,
      isGroup = false,
      cwd,
      model,
      persist,
      from,
      to,
      onDelta,
      images,
      sessionPath,
      agentId,
      streamToken,
      systemAppend,
      disableTools = false,
      turnInstruction = "",
    } = opts;
    const o: HubRouteContext = { sessionKey, role, ephemeral, meta, isGroup, cwd, model, persist, from, to, onDelta, images, sessionPath, agentId, systemAppend, disableTools, turnInstruction, maxRounds: opts.maxRounds, signal: opts.signal };

    // 路由表：按顺序匹配，第一条命中即执行。
    // 优先级通过位置保证，新增路由在此处显式插入，不依赖散落在各处的 if 顺序。
    const routes: HubRoute[] = [
      { // Agent → Agent 私聊（优先，防止被 owner 路由吞掉）
        match: o => o.from && o.to,
        handle: () => this._agentMessenger.send(text, o.from!, o.to!, opts),
      },
      { // 桌面端 owner
        match: o => !o.sessionKey && !o.ephemeral && o.role === "owner",
        handle: () => o.sessionPath
          ? this._engine.promptSession(o.sessionPath, text, { images: o.images, disableTools: o.disableTools, turnInstruction: o.turnInstruction })
          : this._engine.prompt(text, { images: o.images, disableTools: o.disableTools, turnInstruction: o.turnInstruction }),
      },
      { // Bridge guest
        match: o => o.sessionKey && o.role === "guest",
        handle: () => this._guestHandler.handle(text, o.sessionKey!, o.meta, { isGroup: o.isGroup, agentId: o.agentId, onDelta: o.onDelta, images: o.images, systemAppend: o.systemAppend }),
      },
      { // Bridge owner
        match: o => o.sessionKey && !o.ephemeral,
        handle: () => this._engine.executeExternalMessage(text, o.sessionKey!, o.meta, { guest: false, agentId: o.agentId, onDelta: o.onDelta, images: o.images, systemAppend: o.systemAppend }),
      },
      { // 隔离执行（cron/heartbeat/channel）
        match: o => o.ephemeral,
        handle: () => this._engine.executeIsolated(text, { cwd: o.cwd, model: o.model, persist: o.persist }),
      },
    ];

    for (const route of routes) {
      if (!route.match(o)) continue;
      if (streamToken) {
        return this._eventBus.runWithContext({ streamToken }, () => route.handle());
      }
      return route.handle();
    }
    throw new Error(`[Hub] unhandled route: role=${o.role}, sessionKey=${o.sessionKey}, ephemeral=${o.ephemeral}`);
  }

  async abort(sessionPath?: string): Promise<unknown> {
    return sessionPath
      ? this._engine.abortSession(sessionPath)
      : this._engine.abort();
  }

  // ──────────── 调度器管理 ────────────

  /**
   * 初始化所有调度器（Scheduler + ChannelRouter）
   * 在 engine.init() 完成后由 server/index.js 调用
   */
  initSchedulers(): void {
    // Scheduler（heartbeat + cron）
    this._scheduler.start();

    // ChannelRouter — 始终启动
    this._channelRouter.start();

    // 注入频道 post 回调
    this._channelRouter.setupPostHandler();
  }

  /**
   * Agent 切换前暂停：只停 heartbeat（cron 全 agent 并发，不中断），ChannelRouter 持续跑
   */
  async pauseForAgentSwitch(): Promise<void> {
    await this._scheduler.stopHeartbeat();
  }

  /**
   * Agent 切换完成后恢复：重启新 agent 的 heartbeat，重新注入 handler
   */
  resumeAfterAgentSwitch(): void {
    this._scheduler.startHeartbeat();
    this._setupNotifyHandler();
    this._setupDmHandler();
    this._channelRouter.setupPostHandler();
  }

  /**
   * 停止所有调度器（dispose 用）
   */
  async stopSchedulers(): Promise<void> {
    await this._scheduler.stop();
    await this._channelRouter.stop();
  }

  // ──────────── 频道代理方法 ────────────

  triggerChannelTriage(channelName: string, opts?: Record<string, unknown>): Promise<unknown> | unknown {
    return this._channelRouter.triggerImmediate(channelName, opts);
  }

  async triggerChannelConclusion(channelName: string, opts?: Record<string, unknown>): Promise<unknown> {
    return this._channelRouter.triggerConclusion(channelName, opts);
  }

  async toggleChannels(enabled: boolean): Promise<unknown> {
    return this._channelRouter.toggle(enabled);
  }

  // ──────────── 生命周期 ────────────

  async dispose(): Promise<void> {
    await this.stopSchedulers();
    await this._engine.dispose();
    this._eventBus.clear();
  }

  // ──────────── 内部 ────────────

  get dmRouter(): DmRouter { return this._dmRouter; }

  private _setupDmHandler(): void {
    const engine = this._engine;
    // 给所有 agent 注入 DM 回调
    for (const [, agent] of engine.agents || []) {
      agent._dmSentHandler = (fromId, toId) =>
        this._dmRouter.handleNewDm(fromId, toId);
    }
  }

  private _setupNotifyHandler(): void {
    const agent = this._engine.agent;
    if (!agent) return;
    agent._notifyHandler = (title: string, body: string) => {
      this._eventBus.emit({ type: "notification", title, body } satisfies HubEvent, null);
    };
  }

}
