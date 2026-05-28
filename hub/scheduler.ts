/**
 * Scheduler — Heartbeat + Cron 调度（v2）
 *
 * Heartbeat：只跑当前 active agent（有书桌才有心跳）
 * Cron：所有 agent 独立并发，不随 active agent 切换而中断
 *
 * Agent 切换时只 reload heartbeat，cron 持续跑。
 *
 * 通知策略：后台自动任务和笺巡检完成后，scheduler 会发出轻量系统通知。
 */

import fs from "fs";
import path from "path";
import { createHeartbeat } from "../lib/desk/heartbeat.js";
import { createCronScheduler, type CronScheduler } from "../lib/desk/cron-scheduler.js";
import { CronStore, type Job } from "../lib/desk/cron-store.js";
import { appendRecentExecutionToJian } from "../lib/desk/jian-runtime.js";
import { getLocale } from "../server/i18n.js";
import type { Hub } from "./index.js";

type HeartbeatController = ReturnType<typeof createHeartbeat>;
type CronSchedulerOptions = Parameters<typeof createCronScheduler>[0];

interface DeskFile {
  name: string;
  isDir?: boolean;
  mtime?: string | number;
}

type SchedulerJob = Job & {
  skipped?: boolean;
};

interface SkippedCronError extends Error {
  skipped?: boolean;
}

interface ActivityResult {
  sessionPath?: string | null;
  error?: string | null;
  replyText?: string | null;
}

interface ActivityEntry {
  id: string;
  type: string;
  jobId: string | null;
  label: string | null;
  agentId: string;
  agentName: string;
  workspace: string | null;
  startedAt: number;
  finishedAt: number;
  outputFile: string | null;
  summary: string;
  sessionFile: string | null;
  status: "done" | "error";
  error: string | null;
}

interface SchedulerAgent {
  agentName?: string;
  deskDir: string;
  deskManager?: unknown;
  cronStore?: CronStore;
  config?: {
    desk?: {
      heartbeat_interval?: number;
      heartbeat_enabled?: boolean;
    };
    locale?: string;
  };
}

interface ActivityStore {
  add(entry: ActivityEntry): void;
}

type SchedulerEngine = {
  agentsDir: string;
  currentAgentId: string;
  homeCwd: string;
  agent: SchedulerAgent;
  getAgent(agentId: string): SchedulerAgent | null | undefined;
  listDeskFiles(): DeskFile[];
  emitDevLog(text: string, level?: string): void;
  executeIsolated(prompt: string, opts: Record<string, unknown>): Promise<ActivityResult>;
  summarizeActivity(sessionPath: string): Promise<string | null | undefined>;
  getActivityStore(agentId: string): ActivityStore;
};

interface ActivityOptions {
  jobId?: string | null;
  model?: string;
  cwd?: string;
  signal?: AbortSignal;
  quiet?: boolean;
  [key: string]: unknown;
}

interface ActivityNotification {
  title: string;
  body: string;
}

interface BuildActivityNotificationOptions {
  entry: ActivityEntry;
  failed: boolean;
  error?: string | null;
  locale: string;
}

interface QuietPatrolNoopOptions {
  assistantText: string;
  toolCalls: string[];
}

interface QuietActivitySummaryOptions extends QuietPatrolNoopOptions {
  label?: string | null;
  locale: string;
}

interface CronResultDocumentOptions {
  isZh: boolean;
  label?: string | null;
  startedAt: number;
  finishedAt: number;
  cwd: string;
  body: string;
  error?: string | null;
}

interface PersistCronResultFileOptions {
  cwd: string;
  label?: string | null;
  locale: string;
  startedAt: number;
  finishedAt: number;
  sessionPath?: string | null;
  summary?: string | null;
  error?: string | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Scheduler {
  private readonly _hub: Hub;
  private _heartbeat: HeartbeatController | null;
  private readonly _agentCrons: Map<string, CronScheduler>;
  private readonly _executingJobs: Map<string, AbortController>;

  constructor({ hub }: { hub: Hub }) {
    this._hub = hub;
    this._heartbeat = null;
    this._agentCrons = new Map(); // agentId → CronScheduler
    this._executingJobs = new Map(); // jobId → AbortController（per-job 锁 + abort 控制）
  }

  get _engine(): SchedulerEngine { return this._hub.engine as unknown as SchedulerEngine; }

  /** 暴露 heartbeat（给 desk route 的 triggerNow 用） */
  get heartbeat(): HeartbeatController | null { return this._heartbeat; }

  /** 暴露某个 agent 的 cronScheduler */
  getCronScheduler(agentId?: string | null): CronScheduler | null {
    return this._agentCrons.get(agentId ?? this._engine.currentAgentId) ?? null;
  }

  /** @deprecated 兼容旧访问 */
  get cronScheduler(): CronScheduler | null { return this.getCronScheduler(); }

  // ──────────── 生命周期 ────────────

  start(): void {
    this.startHeartbeat();
    this._startAllCrons();
  }

  async stop(): Promise<void> {
    await this.stopHeartbeat();
    for (const sched of this._agentCrons.values()) {
      await sched.stop();
    }
    this._agentCrons.clear();
  }

  /** 启动某个 agent 的 cron（幂等，已有则跳过） */
  startAgentCron(agentId: string): void { this._startAgentCron(agentId); }

  /** 立即执行一次指定 cron 任务（不改调度，仅手动触发） */
  triggerCronJob(agentId: string, jobId: string): SchedulerJob {
    const agent = this._engine.getAgent(agentId);
    const job = agent?.cronStore?.getJob?.(jobId) as SchedulerJob | undefined;
    if (!job) throw new Error(`cron job not found: ${jobId}`);
    if (!job.enabled) throw new Error(`cron job disabled: ${jobId}`);
    if (this._executingJobs.has(job.id)) throw new Error(`cron job already running: ${jobId}`);
    void this._executeCronJobForAgent(agentId, job).catch((err) => {
      console.error(`\x1b[90m[scheduler] 手动执行 cron 失败 ${job.id}: ${errorMessage(err)}\x1b[0m`);
    });
    return job;
  }

  /** 停止并移除某个 agent 的 cron */
  async removeAgentCron(agentId: string): Promise<void> {
    const sched = this._agentCrons.get(agentId);
    if (sched) {
      await sched.stop();
      this._agentCrons.delete(agentId);
    }
  }

  /** Agent 切换：只重建 heartbeat，cron 不中断 */
  async reloadHeartbeat(): Promise<void> {
    await this.stopHeartbeat();
    this.startHeartbeat();
  }

  startHeartbeat(): void {
    const engine = this._engine;
    const agent = engine.agent;
    if (!agent.deskManager || !agent.cronStore) return;

    const hbInterval = agent.config?.desk?.heartbeat_interval;
    const hbEnabled = agent.config?.desk?.heartbeat_enabled !== false;
    this._heartbeat = createHeartbeat({
      getDeskFiles: (): DeskFile[] => engine.listDeskFiles(),
      getWorkspacePath: () => engine.homeCwd,
      registryPath: path.join(agent.deskDir, "jian-registry.json"),
      overwatchPath: path.join(agent.deskDir, "overwatch.md"),
      onBeat: (prompt) => this._executeActivity(prompt, "heartbeat", getLocale().startsWith("zh") ? "日常巡检" : "routine patrol", { quiet: true }),
      onJianBeat: (prompt, cwd) => {
        const isZh = getLocale().startsWith("zh");
        this._executeActivity(prompt, "heartbeat", `${isZh ? "笺" : "jian"}:${path.basename(cwd)}`, { cwd, quiet: true });
      },
      onJianSchedule: ({ dirPath, schedule, taskText, rawTask, label }) => {
        const store = agent.cronStore;
        if (!store || !schedule || !taskText) return null;
        const existing = store.listJobs().find((job) => (
          job.workspace === dirPath
          && String(job.schedule) === String(schedule)
          && normalizeJobPrompt(job.prompt) === normalizeJobPrompt(taskText)
        ));
        if (existing) return existing;
        return store.addJob({
          type: "cron",
          schedule,
          workspace: dirPath,
          label: label || taskText.slice(0, 32),
          prompt: isZhTask(taskText)
            ? `根据笺里的定时待办执行：${rawTask || taskText}`
            : `Execute this scheduled jian task: ${rawTask || taskText}`,
        });
      },
      intervalMinutes: hbInterval,
      emitDevLog: (text, level) => engine.emitDevLog(text, level),
      locale: agent.config?.locale,
    });
    if (hbEnabled) this._heartbeat.start();
  }

  async stopHeartbeat(): Promise<void> {
    if (this._heartbeat) {
      await this._heartbeat.stop();
      this._heartbeat = null;
    }
  }

  // ──────────── Per-agent Cron ────────────

  private _startAllCrons(): void {
    const engine = this._engine;
    let entries;
    try {
      entries = fs.readdirSync(engine.agentsDir, { withFileTypes: true });
    } catch { return; }

    for (const e of entries) {
      if (e.isDirectory()) this._startAgentCron(e.name);
    }
  }

  private _startAgentCron(agentId: string): void {
    if (this._agentCrons.has(agentId)) return;
    const engine = this._engine;
    const agentDir = path.join(engine.agentsDir, agentId);
    const deskDir = path.join(agentDir, "desk");

    let cronStore: CronStore;
    try {
      cronStore = new CronStore(
        path.join(deskDir, "cron-jobs.json"),
        path.join(deskDir, "cron-runs"),
      );
    } catch { return; }

    const sched = createCronScheduler({
      cronStore: cronStore as unknown as CronSchedulerOptions["cronStore"],
      executeJob: (job) => this._executeCronJobForAgent(agentId, job as SchedulerJob),
      abortJob: (jobId) => {
        const ac = this._executingJobs.get(jobId);
        if (ac) { ac.abort(); console.log(`\x1b[90m[scheduler] cron abort ${jobId} (timeout)\x1b[0m`); }
      },
      onJobDone: (job, result) => {
        this._hub.eventBus.emit(
          { type: "cron_job_done", jobId: job.id, label: job.label, agentId, result },
          null,
        );
      },
    });
    this._agentCrons.set(agentId, sched);
    sched.start();
    console.log(`\x1b[90m[scheduler] cron 已启动: ${agentId}\x1b[0m`);
  }

  // ──────────── 执行 ────────────

  /**
   * 执行某个 agent 的 cron 任务（active 或非 active 均可）
   * 同一 agent 同时只运行一个 cron，防止并发写冲突
   */
  async _executeCronJobForAgent(agentId: string, job: SchedulerJob): Promise<void> {
    // per-job 锁：同一 job 不并发，但同一 agent 的不同 job 可以并行
    if (this._executingJobs.has(job.id)) {
      console.log(`\x1b[90m[scheduler] cron 跳过 ${job.id}：上一次仍在执行\x1b[0m`);
      const err = new Error(`cron job ${job.id} 仍在执行，跳过`) as SkippedCronError;
      err.skipped = true;
      throw err;
    }
    const ac = new AbortController();
    this._executingJobs.set(job.id, ac);
    try {
      const isZh = getLocale().startsWith("zh");
      const prompt = isZh
        ? [
            `[定时任务 ${job.id}: ${job.label}]`,
            "",
            "**注意：这是系统自动触发的定时任务，不是用户发来的。**",
            "**不要在执行过程中创建新的定时任务。**",
            ...(job.workspace ? ["", `[工作目录] ${job.workspace}`] : []),
            "",
            job.prompt,
          ].join("\n")
        : [
            `[Cron job ${job.id}: ${job.label}]`,
            "",
            "**Note: This is an automated cron job, NOT a user message.**",
            "**Do not create new cron jobs during execution.**",
            ...(job.workspace ? ["", `[Workspace] ${job.workspace}`] : []),
            "",
            job.prompt,
          ].join("\n");
      await this._executeActivityForAgent(agentId, prompt, "cron", job.label, {
        jobId: job.id,
        model: job.model || undefined,
        cwd: job.workspace || undefined,
        signal: ac.signal,
      });
    } finally {
      this._executingJobs.delete(job.id);
    }
  }

  /**
   * 执行活动（任意 agent，统一走 executeIsolated）
   */
  async _executeActivityForAgent(
    agentId: string,
    prompt: string,
    type: "cron" | "heartbeat",
    label?: string | null,
    opts: ActivityOptions = {},
  ): Promise<void> {
    const engine = this._engine;
    const agentDir = path.join(engine.agentsDir, agentId);
    const activityDir = path.join(agentDir, "activity");
    const startedAt = Date.now();
    const id = `${type === "heartbeat" ? "hb" : "cron"}_${startedAt}`;

    // 所有 agent 统一走 executeIsolated（支持 agentId + signal 参数）
    const { signal, ...restOpts } = opts;
    const quiet = restOpts.quiet === true || (type === "heartbeat" && restOpts.quiet !== false);
    const result = await engine.executeIsolated(prompt, {
      agentId,
      persist: activityDir,
      signal,
      ...restOpts,
    });
    const { sessionPath, error } = result;

    const finishedAt = Date.now();
    const failed = !!error;

    // 取 agentName（从长驻实例获取，fallback agentId）
    const ag = engine.getAgent(agentId);
    const agentName = ag?.agentName || agentId;

    const assistantText = String(result.replyText || extractAssistantResultText(sessionPath) || "").trim();
    const toolCalls = extractActivityToolCalls(sessionPath);
    if (quiet && !failed && isQuietPatrolNoop({ assistantText, toolCalls })) {
      cleanupActivitySession(sessionPath);
      engine.emitDevLog(`[${type}] ${label || "后台巡检"} 无需用户可见记录`, "heartbeat");
      return;
    }

    // 生成摘要。安静巡检只用本地摘要，避免为“后台无声任务”再烧一次摘要模型。
    let summary: string | null = null;
    if (quiet) {
      summary = buildQuietActivitySummary({ assistantText, toolCalls, label, locale: getLocale() });
    } else if (typeof sessionPath === "string" && sessionPath) {
      try {
        summary = await engine.summarizeActivity(sessionPath) || null;
      } catch {}
    }

    let outputFile: string | null = null;
    const jianDir = typeof restOpts.cwd === "string" && restOpts.cwd.trim()
      ? restOpts.cwd.trim()
      : null;
    if (type === "cron" && jianDir) {
      try {
        outputFile = persistCronResultFile({
          cwd: jianDir,
          label,
          locale: getLocale(),
          startedAt,
          finishedAt,
          sessionPath,
          summary,
          error,
        });
      } catch (err) {
        engine.emitDevLog(`[${type}] 写入任务结果文件失败: ${errorMessage(err)}`, "error");
      }
    }

    const entry: ActivityEntry = {
      id,
      type,
      jobId: typeof restOpts.jobId === "string" ? restOpts.jobId : null,
      label: label || null,
      agentId,
      agentName,
      workspace: jianDir,
      startedAt,
      finishedAt,
      outputFile,
      summary: (() => {
        const isZhS = getLocale().startsWith("zh");
        const hbLabel = isZhS ? "日常巡检" : "routine patrol";
        const cronLabel = isZhS ? "定时任务" : "cron job";
        const failSuffix = isZhS ? "执行失败" : "execution failed";
        const workspaceName = jianDir ? path.basename(jianDir) : "";
        if (failed) return `${label || (type === "heartbeat" ? hbLabel : cronLabel)} ${failSuffix}`;
        if (summary) {
          return workspaceName
            ? `${summary} · ${isZhS ? "工作区" : "Workspace"} ${workspaceName}`
            : summary;
        }
        if (type === "heartbeat") {
          return workspaceName
            ? `${isZhS ? "已巡检" : "Patrolled"} ${workspaceName}`
            : hbLabel;
        }
        return workspaceName
          ? `${label || cronLabel} · ${workspaceName}`
          : (label || cronLabel);
      })(),
      sessionFile: typeof sessionPath === "string" ? path.basename(sessionPath) : null,
      status: failed ? "error" : "done",
      error: error || null,
    };
    if (!failed && jianDir && !(quiet && type === "heartbeat")) {
      try {
        appendRecentExecutionToJian(jianDir, {
          summary: entry.summary,
          type,
          label,
          at: finishedAt,
          locale: getLocale(),
        });
      } catch (err) {
        engine.emitDevLog(`[${type}] 写回笺失败: ${errorMessage(err)}`, "error");
      }
    }

    // 写入对应 agent 的 ActivityStore
    engine.getActivityStore(agentId).add(entry);

    // WS 广播
    this._hub.eventBus.emit({ type: "activity_update", activity: entry }, null);

    const notification = buildActivityNotification({
      entry,
      failed,
      error,
      locale: getLocale(),
    });
    if (notification) {
      this._hub.eventBus.emit({
        type: "notification",
        title: notification.title,
        body: notification.body,
      }, null);
    }

    if (failed) {
      const isZhR = getLocale().startsWith("zh");
      const reason = error || (isZhR ? "后台任务未生成 session" : "background task produced no session");
      engine.emitDevLog(`[${type}] ${label || "后台任务"} 失败: ${reason}`, "error");
      throw new Error(reason);
    }

    engine.emitDevLog(`活动记录: ${entry.summary}`, "heartbeat");
  }

  /**
   * active agent 的心跳活动（保留向后兼容）
   */
  _executeActivity(prompt: string, type: "cron" | "heartbeat", label?: string | null, opts: ActivityOptions = {}): Promise<void> {
    return this._executeActivityForAgent(this._engine.currentAgentId, prompt, type, label, opts);
  }
}

function normalizeJobPrompt(prompt: unknown): string {
  return String(prompt || "")
    .replace(/^根据笺里的定时待办执行：/u, "")
    .replace(/^Execute this scheduled jian task:\s*/u, "")
    .trim();
}

function isZhTask(text: unknown): boolean {
  return /[\u3400-\u9fff]/u.test(String(text || ""));
}

function buildActivityNotification({
  entry,
  failed,
  error,
  locale,
}: BuildActivityNotificationOptions): ActivityNotification | null {
  const isZh = String(locale || "").startsWith("zh");
  const genericHeartbeat = isZh ? "日常巡检" : "routine patrol";
  const genericCron = isZh ? "定时任务" : "cron job";
  const summary = compactNotificationBody(entry.summary, isZh);
  const label = String(entry.label || "").trim();

  if (failed) {
    const fallback = isZh ? "这次没有顺利完成，稍后会再试一次。" : "This run did not finish successfully and will retry later.";
    return {
      title: isZh
        ? `${label || (entry.type === "cron" ? "自动任务" : "巡检")}未完成`
        : `${label || (entry.type === "cron" ? "Automation" : "Patrol")} did not finish`,
      body: compactNotificationBody(error || summary || fallback, isZh),
    };
  }

  if (entry.type === "cron") {
    return {
      title: isZh ? "自动任务已完成" : "Automation finished",
      body: summary || label || genericCron,
    };
  }

  if (label && label !== genericHeartbeat) {
    return {
      title: isZh ? "笺里的安排已更新" : "Jian task updated",
      body: summary || label,
    };
  }

  return null;
}

function compactNotificationBody(text: unknown, isZh: boolean): string {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const max = isZh ? 44 : 72;
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

function sanitizeResultFilePart(value: unknown, fallback = "task-result"): string {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
  return cleaned || fallback;
}

function formatResultTimestamp(ts: unknown): string {
  const input = typeof ts === "string" || typeof ts === "number" || ts instanceof Date
    ? ts
    : Date.now();
  const date = new Date(input);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function extractAssistantResultText(sessionPath: unknown): string {
  const filePath = typeof sessionPath === "string" ? sessionPath : "";
  if (!filePath || !fs.existsSync(filePath)) return "";
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    let lastAssistantText = "";
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isSessionAssistantMessage(parsed)) continue;
      const msg = parsed.message;
      const content = Array.isArray(msg.content)
        ? msg.content.filter(isTextBlock).map((block) => block.text).join("")
        : (typeof msg.content === "string" ? msg.content : "");
      const normalized = String(content || "").trim();
      if (normalized) lastAssistantText = normalized;
    }
    return lastAssistantText;
  } catch {
    return "";
  }
}

function extractActivityToolCalls(sessionPath: unknown): string[] {
  const filePath = typeof sessionPath === "string" ? sessionPath : "";
  if (!filePath || !fs.existsSync(filePath)) return [];
  const names: string[] = [];
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isSessionAssistantMessage(parsed)) continue;
      const content = Array.isArray(parsed.message.content) ? parsed.message.content : [];
      for (const block of content) {
        if (isToolCallBlock(block)) {
          names.push(block.name);
        }
      }
    }
  } catch {}
  return [...new Set(names)];
}

function cleanupActivitySession(sessionPath: unknown): void {
  const filePath = typeof sessionPath === "string" ? sessionPath : "";
  if (!filePath || !fs.existsSync(filePath)) return;
  try { fs.unlinkSync(filePath); } catch {}
}

function isQuietPatrolNoop({ assistantText, toolCalls }: QuietPatrolNoopOptions): boolean {
  if (toolCalls.length > 0) return false;
  const text = String(assistantText || "").replace(/\s+/g, " ").trim();
  if (!text) return true;

  const positiveSignal = /(?:已(?:完成|更新|创建|整理|写入|设定|修复|同步|发布|备份|移动|合并|读取|分析)|发现|异常|错误|失败|风险|提醒|需要(?:关注|处理|确认|你)|建议(?:关注|处理)|notified|updated|created|wrote|fixed|synced|published|backed up|merged|found|alert|warning|error|failed|risk|needs attention)/i;
  if (positiveSignal.test(text)) return false;

  const noopSignal = /(?:一切正常|无(?:特定)?(?:待办|事项|异常|警报|需要处理)|无需(?:行动|处理|关注)|没有(?:需要|发现).{0,20}(?:处理|关注|异常|待办)|巡检(?:完成|完毕)|系统运行正常|all clear|nothing to do|no action needed|no pending|no issues|patrol complete)/i;
  return noopSignal.test(text) || text.length <= 80;
}

function buildQuietActivitySummary({
  assistantText,
  toolCalls,
  label,
  locale,
}: QuietActivitySummaryOptions): string {
  const isZh = String(locale || "").startsWith("zh");
  if (toolCalls.length > 0) {
    const tools = toolCalls.slice(0, 3).join(isZh ? "、" : ", ");
    return isZh
      ? `${label || "巡检"}执行了 ${tools}${toolCalls.length > 3 ? " 等工具" : ""}`
      : `${label || "Patrol"} ran ${tools}${toolCalls.length > 3 ? ", etc." : ""}`;
  }
  const clean = String(assistantText || "")
    .replace(/[#*_`>\-[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return label || (isZh ? "巡检有更新" : "Patrol updated");
  const max = isZh ? 44 : 72;
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function buildCronResultDocument({
  isZh,
  label,
  startedAt,
  finishedAt,
  cwd,
  body,
  error,
}: CronResultDocumentOptions): string {
  const lines = [
    `# ${isZh ? "自动任务结果" : "Automation Result"}`,
    "",
    `- ${isZh ? "任务" : "Task"}: ${label || (isZh ? "未命名任务" : "Untitled task")}`,
    `- ${isZh ? "开始" : "Started"}: ${new Date(startedAt).toLocaleString(isZh ? "zh-CN" : "en-US")}`,
    `- ${isZh ? "结束" : "Finished"}: ${new Date(finishedAt).toLocaleString(isZh ? "zh-CN" : "en-US")}`,
    `- ${isZh ? "工作区" : "Workspace"}: ${cwd}`,
    `- ${isZh ? "状态" : "Status"}: ${error ? (isZh ? "失败" : "Failed") : (isZh ? "完成" : "Completed")}`,
    "",
    body || (error ? String(error) : (isZh ? "这次没有产出可展示文本。" : "This run did not produce displayable text.")),
    "",
  ];
  return `${lines.join("\n")}`.replace(/\n{3,}/g, "\n\n");
}

function persistCronResultFile({
  cwd,
  label,
  locale,
  startedAt,
  finishedAt,
  sessionPath,
  summary,
  error,
}: PersistCronResultFileOptions): string | null {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const isZh = String(locale || "").startsWith("zh");
  const folderName = isZh ? "Lynn-自动任务结果" : "Lynn-Automation-Results";
  const resultDir = path.join(cwd, folderName);
  fs.mkdirSync(resultDir, { recursive: true });
  const body = extractAssistantResultText(sessionPath) || String(summary || "").trim() || String(error || "").trim();
  const fileName = `${formatResultTimestamp(finishedAt || startedAt)}-${sanitizeResultFilePart(label, isZh ? "自动任务" : "automation-task")}.md`;
  const filePath = path.join(resultDir, fileName);
  const doc = buildCronResultDocument({
    isZh,
    label,
    startedAt,
    finishedAt,
    cwd,
    body,
    error,
  });
  fs.writeFileSync(filePath, doc, "utf-8");
  return filePath;
}

interface SessionAssistantMessage {
  type: "message";
  message: {
    role: "assistant";
    content?: unknown;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object";
}

function isSessionAssistantMessage(value: unknown): value is SessionAssistantMessage {
  if (!isRecord(value) || value.type !== "message" || !isRecord(value.message)) return false;
  return value.message.role === "assistant";
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isToolCallBlock(value: unknown): value is { type: "tool_use" | "toolCall"; name: string } {
  return isRecord(value)
    && (value.type === "tool_use" || value.type === "toolCall")
    && typeof value.name === "string";
}
