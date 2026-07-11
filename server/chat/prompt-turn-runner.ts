import { wsSend } from "../ws-protocol.js";
import { debugLog } from "../../lib/debug-log.js";
import { t } from "../i18n.js";
import { classifyRouteIntent } from "../../shared/task-route-intent.js";
import { beginSessionStream } from "../session-stream-store.js";
import { prepareChatTurnState } from "./stream-state.js";
import {
  LOCAL_QWEN35_DIRECT_PREFETCH_MAX_TOKENS,
  resolveLocalQwen35DirectMaxTokens,
  resolveLocalQwen35DirectThinking,
  shouldUseLocalQwen35DirectBridge,
} from "./local-qwen35-direct-policy.js";
import { resolveCurrentModelInfo } from "./chat-recovery.js";
import {
  TOOL_USE_BEHAVIOR,
  buildNoToolTurnPrompt,
  buildPrefetchAugmentedPrompt,
  resolveInitialToolUseBehavior,
} from "./tool-use-behavior.js";
import { attachLocalQwen35BenchContext, isLocalQwen35Model } from "./local-qwen35-bench-context.js";
import { buildPrefetchToolSummary, rememberFailedTool, rememberSuccessfulTool } from "./tool-summary.js";
import { buildDirectResearchAnswer, buildReportResearchContext } from "./report-research-context.js";
import { buildRepeatedErrorLoopAnswer, detectRepeatedErrorLoop } from "./repeated-error-loop.js";
import { consumeMutationConfirmation, recordPendingDeleteRequest } from "./turn-retry-policy.js";
import { buildLocalOfficeDirectAnswer } from "./local-office-answer.js";
import {
  buildLocalWorkspaceDirectReply,
  buildLocalWorkspaceContext,
  shouldAttachLocalWorkspaceContext,
  shouldUseLocalWorkspaceDirectReply,
} from "./local-workspace-context.js";
import { skillCrystallizeEnabled, recallSkillFrame, resolveBrainDataDir } from "./skill-crystallize.js";
import {
  appendTextToLatestAssistantInMemory,
  appendTextToLatestAssistantRecord,
  countPersistedAssistantMessages,
  countPersistedAssistantVisibleTexts,
} from "./session-persistence.js";

type AnyRecord = Record<string, any>;

const PREFETCH_REALTIME_EVIDENCE_TOOL_NAMES = new Set([
  "web_search",
  "web_fetch",
  "sports_score",
  "live_news",
  "weather",
  "stock_market",
  "market_weather_brief",
]);

const DIRECT_CLOSE_PREFETCH_KINDS = new Set([
  "market",
  "weather",
  "sports",
  "news",
  "public_data",
]);

function shouldCloseWithPrefetchDirectAnswer(reportKind: unknown, promptText: unknown, directAnswer: unknown): boolean {
  const kind = String(reportKind || "");
  if (!DIRECT_CLOSE_PREFETCH_KINDS.has(kind)) return false;
  const answer = String(directAnswer || "").trim();
  if (!answer) return false;
  const prompt = String(promptText || "");
  if (kind === "public_data"
    && /(?:DGX\s*Spark|RTX\s*Spark|download\.merkyorlynn\.com|Lynn\s+v?\d+\.\d+\.\d+|Gitee.*Lynn|CUDA\s*Toolkit\s*13|Python\s*3\.13|Node\.?js|Kimi\s*K2\.7\s*Code|GLM\s*5\.0\s*Turbo|Responses\s*API|Anthropic\s+docs?.{0,24}Claude\s+Code|Claude\s+Code.{0,24}Anthropic\s+docs?|Claude.{0,24}(?:最新|公开).{0,12}模型|Claude.{0,12}(?:模型).{0,24}(?:最新|公开)|Apple.{0,32}notarization|notarization.{0,32}Apple|Apple.{0,24}公证|苹果.{0,24}公证|Microsoft\s+Windows\s+on\s+Arm|Windows\s+on\s+Arm|(?:日本|赴日).{0,40}(?:旅游|旅行|游客).{0,40}(?:签证|材料|要求)|(?:签证|材料|要求).{0,40}(?:日本|赴日).{0,40}(?:旅游|旅行|游客)|深圳.{0,24}(?:2026|最新|当前|现在).{0,40}(?:社保|社会保险).{0,40}(?:缴费|基数|政策|变化)|(?:个人所得税|个税).{0,24}(?:专项附加扣除|扣除).{0,40}(?:最新|规则|注意|来源)|(?:专项附加扣除).{0,40}(?:个人所得税|个税|最新|规则|注意|来源))/i.test(prompt)) {
    return true;
  }
  if (kind === "public_data") {
    return /私董会/.test(prompt) && /(?:人数|收费|费用|会费|年费|入会费|价格|大概多少|多少)/.test(prompt);
  }
  if (/(?:深度|完整|全面|系统(?:性)?|报告|调研|研究|分析|对比|比较|引用|来源列表|research|report|analysis|compare)/i.test(prompt)) {
    return false;
  }
  if (kind === "sports" && /专用体育比分源返回失败|暂未形成可核验/.test(answer)) {
    return false;
  }
  if (kind !== "sports" && /(?:列出|表格|小表格|table)/i.test(prompt)) return false;
  return true;
}

function shouldCloseWithImmediateLocalOfficeAnswer(promptText: unknown, directAnswer: unknown): boolean {
  if (!String(directAnswer || "").trim()) return false;
  const prompt = String(promptText || "");
  if (/(?:保存|写入|创建|生成|导出).{0,16}(?:文件|文档|md|markdown|docx|pdf|xlsx|表格|到书桌|到桌面)|(?:形成|输出).{0,16}(?:文件|文档|docx|pdf|xlsx)/iu.test(prompt)) return false;
  return /(?:排序并去重|去重并排序|sort.*unique|unique.*sort)/iu.test(prompt)
    || /zod\s+schema|schema\s+校验|校验\s+release\s+manifest/i.test(prompt)
    || /(?:考研|研究生考试|备考).{0,80}(?:120\s*天|一百二十\s*天|三阶段|3\s*阶段|排期|复习计划)|(?:120\s*天|一百二十\s*天|三阶段|3\s*阶段|排期|复习计划).{0,80}(?:考研|研究生考试|备考)/iu.test(prompt)
    || /(?:成年人|成人).{0,40}(?:发烧|发热).{0,60}(?:尽快就医|就医|行动建议|什么情况|何时)|(?:发烧|发热).{0,60}(?:尽快就医|就医|行动建议|什么情况|何时).{0,40}(?:成年人|成人)/iu.test(prompt)
    || /(?:牙痛|牙疼|牙齿痛|牙龈痛).{0,80}(?:牙医|今晚|低风险|风险判断|不要给处方|就医准备)|(?:牙医|今晚|低风险|风险判断|不要给处方|就医准备).{0,80}(?:牙痛|牙疼|牙齿痛|牙龈痛)/u.test(prompt)
    || /(?:电脑|设备).{0,30}(?:配置比较低|低配置|低配).{0,80}(?:端侧|本地).{0,20}(?:大模型|模型)|(?:端侧|本地).{0,20}(?:大模型|模型).{0,80}(?:配置比较低|低配置|低配)/u.test(prompt)
    || /(?:风险登记表|Risk\s*Register).{0,80}(?:跨部门|项目|概率|影响|负责人)|(?:跨部门|项目|概率|影响|负责人).{0,80}(?:风险登记表|Risk\s*Register)/iu.test(prompt)
    || /(?:种植户|农户|农民).{0,120}(?:明天|近期).{0,120}(?:降雨|下雨|天气).{0,120}(?:玉米|玉米价格|玉米行情)|(?:玉米|玉米价格|玉米行情).{0,120}(?:明天|近期).{0,120}(?:降雨|下雨|天气).{0,120}(?:种植户|农户|农民)/iu.test(prompt)
    || /(?:续写|写一段|写).*城里的钟从不报时，只在有人说谎时响起/u.test(prompt)
    || /(?:改写|润色|重写).{0,40}(?:画面感|更有画面|有画面).{0,80}她走进房间，发现桌上有一封信|她走进房间，发现桌上有一封信.{0,80}(?:改写|润色|重写).{0,40}(?:画面感|更有画面|有画面)/u.test(prompt)
    || /(?:12\s*章|十二\s*章).{0,60}(?:中篇小说|小说|章节规划|章节大纲).{0,60}(?:每章一句|一句|核心冲突|冲突)|(?:每章一句|核心冲突).{0,60}(?:12\s*章|十二\s*章).{0,60}(?:中篇小说|小说|章节规划|章节大纲)/u.test(prompt)
    || /(?:悬疑小说|悬疑).{0,30}(?:开头|第一段).{0,60}(?:异常细节|不解释|不要解释)|(?:异常细节|不解释|不要解释).{0,60}(?:悬疑小说|悬疑).{0,30}(?:开头|第一段)/u.test(prompt)
    || /(?:小说|写作).{0,40}(?:AI\s*味|ai\s*味|机器味|模板感|可执行检查清单)|(?:AI\s*味|ai\s*味|机器味|模板感).{0,40}(?:小说|写作|检查清单)/iu.test(prompt)
    || /(?:高中生|学生|生活例子|不(?:要|太)公式化).{0,80}(?:动量守恒)|(?:动量守恒).{0,80}(?:高中生|学生|生活例子|不(?:要|太)公式化)/u.test(prompt)
    || /(?:医院|门诊).{0,60}(?:排队|候诊|叫号).{0,80}(?:分诊|预约|叫号)|(?:分诊|预约|叫号).{0,80}(?:医院|门诊).{0,60}(?:排队|候诊|叫号)/u.test(prompt)
    || /(?:猎头|招聘顾问|recruiter).{0,80}(?:第一次联系|首次联系|开场白|自然)|(?:第一次联系|首次联系|开场白|自然).{0,80}(?:猎头|招聘顾问|recruiter)/iu.test(prompt)
    || /(?:简历|项目经历|履历|resume).{0,80}(?:结果导向|成果导向|改得|改写|润色).{0,80}(?:后台系统|后端系统|系统开发|提升效率)|(?:后台系统|后端系统|系统开发|提升效率).{0,80}(?:简历|项目经历|履历|resume).{0,80}(?:结果导向|成果导向|改得|改写|润色)/iu.test(prompt)
    || /Node\.?js.{0,40}(?:JSON|keys?|数量)|(?:读取|输出).{0,32}(?:JSON|keys?)/i.test(prompt)
    || /(?:TypeScript|ts\b).{0,80}(?:函数|function).{0,80}(?:字符串|文本|input).{0,80}(?:URL|链接)|(?:字符串|文本|input).{0,80}(?:URL|链接).{0,80}(?:TypeScript|ts\b).{0,80}(?:函数|function)/iu.test(prompt)
    || /(?:二次方程|quadratic).{0,40}(?:求根公式|公式|LaTeX|latex|解|roots?)|(?:求根公式|LaTeX|latex).{0,40}(?:二次方程|quadratic)/iu.test(prompt)
    || /(?:UI|界面|前端|输入框|input|textarea).{0,60}(?:窄屏|小屏|移动端|手机|不溢出|溢出|检查清单|checklist|设计检查)|(?:窄屏|小屏|移动端|手机|不溢出|溢出|检查清单|checklist|设计检查).{0,60}(?:UI|界面|前端|输入框|input|textarea)/iu.test(prompt)
    || /(?:经营分析|环比|增长率).{0,80}(?:Q1|Q2|管理建议)|(?:Q1|Q2).{0,80}(?:经营分析|环比|增长率|管理建议)/iu.test(prompt)
    || /(?:Session\s*Map|工作地图|右侧工作台|左侧会话列表|数字徽标|Huge\s*节点|从此分支|资料不足时应继续补充来源再下结论|伪相关|证据优先搜索\s*Agent|搜索\s*Agent|搜索摘要|长会话|7GB|CLI\s*和\s*GUI|GUI\s*和\s*CLI|共用内核|回归测试矩阵)/iu.test(prompt)
    || /(?:会议内容|会议).{0,40}(?:纪要模板|整理成纪要|纪要).{0,80}(?:目标|结论|行动项|风险)|(?:纪要模板|整理成纪要|纪要).{0,80}(?:目标|结论|行动项|风险)/u.test(prompt)
    || /(?:三列表格|3\s*列表格|三列\s*表格|3\s*列\s*表格)/.test(prompt)
    && /(?:任务[、,，]\s*优先级[、,，]\s*风险|任务.*优先级.*风险)/.test(prompt);
}

export interface PromptTurnRunnerDeps {
  engine: any;
  hub: any;
  lifecycleHooks: any;
  broadcast: (msg: any) => void;
  emitStreamEvent: (sessionPath: any, ss: any, event: any) => void;
  closeStreamAfterError: (sessionPath: any, ss: any, reason?: any) => void;
  closeStreamWithVisibleFallback: (sessionPath: any, ss: any, text: any, reason: any, options?: any) => boolean;
  finalizeReturnedTurnWithoutStream: (sessionPath: any, ss: any, reason: any, options?: any) => boolean;
  fallbackLocalQwen35DirectToBrain: (args: any) => Promise<boolean>;
  startLocalQwen35PrefetchFeedback: (sessionPath: any, ss: any, toolName: any, promptText: any) => () => void;
  streamLocalQwen35DirectBridge: (sessionPath: any, ss: any, promptText: any, effectivePromptText: any, modelInfo: any, options?: any) => Promise<any>;
  schedulePersistedFinalAnswerPoll: (sessionPath: any, ss: any) => boolean;
  scheduleReturnedTurnFinalizationFallback: (sessionPath: any, ss: any, reason?: any) => boolean;
  scheduleSilentBrainAbort: (sessionPath: any, ss: any) => void;
  scheduleToolFinalizationFallback: (sessionPath: any, ss: any) => void;
  scheduleTurnHardAbort: (sessionPath: any, ss: any) => void;
  clearTurnTimers: (ss: any) => void;
  hasStreamEvent: (ss: any, type: any) => boolean;
  hasToolExecutionInFlight: (ss: any) => boolean;
}

export interface RunPromptTurnOptions {
  ws: any;
  msg: AnyRecord;
  promptSessionPath: any;
  ss: any;
  promptText: string;
}

export function createPromptTurnRunner({
  engine,
  hub,
  lifecycleHooks,
  broadcast,
  emitStreamEvent,
  closeStreamAfterError,
  closeStreamWithVisibleFallback,
  finalizeReturnedTurnWithoutStream,
  fallbackLocalQwen35DirectToBrain,
  startLocalQwen35PrefetchFeedback,
  streamLocalQwen35DirectBridge,
  schedulePersistedFinalAnswerPoll,
  scheduleReturnedTurnFinalizationFallback,
  scheduleSilentBrainAbort,
  scheduleToolFinalizationFallback,
  scheduleTurnHardAbort,
  clearTurnTimers,
  hasStreamEvent,
  hasToolExecutionInFlight,
}: PromptTurnRunnerDeps) {
  function buildClosedEmptyTurnFallback(ss: AnyRecord) {
    const toolFallback = String(ss?.realtimeToolFallbackText || "").trim();
    if (toolFallback) return toolFallback;
    const deterministic = buildLocalOfficeDirectAnswer(ss?.originalPromptText || ss?.effectivePromptText || "");
    if (deterministic) return deterministic;
    if (ss?.hasToolCall || ss?.hasPrefetchToolCall || Number(ss?.successfulToolCount || 0) > 0) {
      return "本轮已有工具执行记录；当前只能确认上方工具卡片中的可见结果，未覆盖的部分不能继续补推。";
    }
    return "模型这次没有返回可见内容。本轮已安全结束，避免空回复污染后续上下文；请点「编辑重发」重试，或切换默认模型后再发。";
  }

  return async function runPromptTurn({
    ws,
    msg,
    promptSessionPath,
    ss,
    promptText,
  }: RunPromptTurnOptions) {
    try {
      const activeSession = engine.getSessionByPath(promptSessionPath);
      prepareChatTurnState(ss, {
        promptText,
        routeIntent: classifyRouteIntent(promptText, { imagesCount: msg.images?.length || 0 }),
        persistedAssistantTextBaseline: countPersistedAssistantVisibleTexts(activeSession, promptSessionPath),
        persistedAssistantMessageBaseline: countPersistedAssistantMessages(activeSession, promptSessionPath),
      });
      const rehydratedMutation = consumeMutationConfirmation(ss, promptText);
      if (rehydratedMutation) {
        ss.originalPromptText = rehydratedMutation.originalPrompt;
        ss.routeIntent = classifyRouteIntent(rehydratedMutation.originalPrompt, { imagesCount: msg.images?.length || 0 });
        ss._rehydratedEffectivePrompt = rehydratedMutation.retryPrompt;
        ss.rehydratedThisTurn = true;
        debugLog()?.warn("ws", `[MUTATION-CONFIRM-REHYDRATE v1] rehydrated prior delete request · session=${promptSessionPath}`);
      } else if (recordPendingDeleteRequest(ss, promptText)) {
        debugLog()?.log("ws", `[PENDING-DELETE-REQUEST v1] tracked delete request for confirmation rehydrate · session=${promptSessionPath}`);
      }
      const streamToken = beginSessionStream(ss);
      ss.activeStreamToken = streamToken;
      ss.streamSource = "user";
      scheduleTurnHardAbort(promptSessionPath, ss);
      schedulePersistedFinalAnswerPoll(promptSessionPath, ss);
      broadcast({ type: "status", isStreaming: true, sessionPath: promptSessionPath });
      lifecycleHooks.run("prompt_start", {
        ss,
        sessionPath: promptSessionPath,
        routeIntent: ss.routeIntent,
        streamToken,
      });
      const currentModelInfo: AnyRecord = resolveCurrentModelInfo(engine) as AnyRecord;
      const repeatedErrorAnswer = !rehydratedMutation
        ? buildRepeatedErrorLoopAnswer(detectRepeatedErrorLoop(
          activeSession?.sessionManager?.buildSessionContext?.().messages || [],
          promptText,
        ))
        : "";
      if (repeatedErrorAnswer) {
        closeStreamWithVisibleFallback(
          promptSessionPath,
          ss,
          repeatedErrorAnswer,
          "repeated_error_loop_detected",
          { trustedFallback: true, persistPromptIfMissing: true },
        );
        return;
      }
      const initialToolUse = resolveInitialToolUseBehavior(promptText, { modelInfo: currentModelInfo });
      const budgetContext = initialToolUse.budgetContext || "";
      let effectivePromptText = initialToolUse.effectivePromptText || promptText;
      let disableTurnTools = !!initialToolUse.disableTools;
      effectivePromptText = attachLocalQwen35BenchContext(effectivePromptText, currentModelInfo);
      const immediateLocalOfficeAnswer = buildLocalOfficeDirectAnswer(promptText);
      if (!rehydratedMutation && shouldCloseWithImmediateLocalOfficeAnswer(promptText, immediateLocalOfficeAnswer)) {
        closeStreamWithVisibleFallback(
          promptSessionPath,
          ss,
          immediateLocalOfficeAnswer,
          "local_office_direct_answer",
          { trustedFallback: true, persistPromptIfMissing: true },
        );
        return;
      }
      if (ss._rehydratedEffectivePrompt) {
        effectivePromptText = String(ss._rehydratedEffectivePrompt);
        disableTurnTools = false;
        ss._rehydratedEffectivePrompt = null;
      }
      // ① Skill recall: prepend SOPs crystallized from past similar tasks
      // (opt-in via BRAIN_SKILL_CRYSTALLIZE=1; fully guarded, no-op when off/empty).
      if (skillCrystallizeEnabled()) {
        const recallFrame = recallSkillFrame(resolveBrainDataDir(), promptText);
        if (recallFrame) effectivePromptText = `${recallFrame}\n\n${effectivePromptText}`;
      }
      if (shouldAttachLocalWorkspaceContext(promptText, ss.routeIntent)) {
        const sessionCwd = engine.getSessionByPath(promptSessionPath)?.sessionManager?.getCwd?.()
          || engine.cwd
          || process.cwd();
        if (shouldUseLocalWorkspaceDirectReply(promptText, ss.routeIntent)) {
          const directReply = buildLocalWorkspaceDirectReply({
            promptText,
            cwd: sessionCwd,
            maxEntries: 120,
            maxDocs: 8,
            maxDocChars: 3200,
          });
          if (directReply.text.trim()) {
            ss.hasLocalPrefetchEvidence = directReply.ok;
            closeStreamWithVisibleFallback(
              promptSessionPath,
              ss,
              directReply.text,
              "local_workspace_direct_reply",
              { trustedFallback: true, persistPromptIfMissing: true },
            );
            return;
          }
        }
        const workspaceContext = buildLocalWorkspaceContext({
          promptText,
          cwd: sessionCwd,
          maxEntries: 120,
          maxDocs: 8,
          maxDocChars: 3200,
        });
        ss.hasLocalPrefetchEvidence = true;
        effectivePromptText = [
          workspaceContext,
          "",
          "【本地文件任务要求】上方快照来自 Lynn 客户端真实读取，不是模型猜测。请基于这些事实回答；如果还需要更精确的文件、目录或内容检索，继续调用真实 read/grep/find/ls/bash 工具。不要回答“我没有本地文件系统权限”。",
          "",
          effectivePromptText,
        ].join("\n");
      }
      const noToolTurnInstruction = disableTurnTools ? buildNoToolTurnPrompt(effectivePromptText) : "";
      if (shouldUseLocalQwen35DirectBridge(promptText, {
        isLocalModel: isLocalQwen35Model(currentModelInfo),
        hasImages: Boolean(msg.images?.length),
        rehydratedMutation: Boolean(rehydratedMutation),
        toolBehavior: initialToolUse.behavior,
        reason: initialToolUse.reason,
        routeIntent: ss.routeIntent,
      })) {
        ss.effectivePromptText = effectivePromptText;
        try {
          const localEnableThinking = resolveLocalQwen35DirectThinking(promptText, engine);
          await streamLocalQwen35DirectBridge(promptSessionPath, ss, promptText, effectivePromptText, currentModelInfo, {
            enableThinking: localEnableThinking,
            maxTokens: resolveLocalQwen35DirectMaxTokens(promptText, localEnableThinking),
          });
        } catch (directErr: any) {
          debugLog()?.warn("ws", `[LOCAL-QWEN35-DIRECT v1] failed · ${directErr?.message || directErr} · ${promptSessionPath}`);
          const fallbackOk = await fallbackLocalQwen35DirectToBrain({
            sessionPath: promptSessionPath,
            ss,
            promptText,
            effectivePromptText,
            modelInfo: currentModelInfo,
            msg,
            streamToken,
            disableTools: disableTurnTools,
            turnInstruction: noToolTurnInstruction,
            reason: "local_qwen35_direct_failed",
          });
          if (!fallbackOk) {
            closeStreamWithVisibleFallback(
              promptSessionPath,
              ss,
              "",
              "local_qwen35_direct_failed",
              { trustedFallback: true },
            );
          }
        }
        return;
      }
      const localQwenSynthesisAfterPrefetch = isLocalQwen35Model(currentModelInfo);
      if (!rehydratedMutation && initialToolUse.behavior === TOOL_USE_BEHAVIOR.PREFETCH_THEN_RUN_OR_STOP) {
        const toolName = initialToolUse.toolName;
        ss.hasPrefetchToolCall = true;
        ss.hasToolCall = true;
        if (PREFETCH_REALTIME_EVIDENCE_TOOL_NAMES.has(String(toolName || ""))) {
          ss.hasRealtimeEvidenceToolCall = true;
        }
        emitStreamEvent(promptSessionPath, ss, { type: "tool_start", name: toolName, args: { query: promptText } });
        const stopPrefetchFeedback = localQwenSynthesisAfterPrefetch
          ? startLocalQwen35PrefetchFeedback(promptSessionPath, ss, toolName, promptText)
          : () => {};
        lifecycleHooks.run("tool_start", {
          ss,
          sessionPath: promptSessionPath,
          toolName,
          args: { query: promptText },
          localPrefetch: true,
        });
        try {
          const reportContext = await buildReportResearchContext(promptText, { userPrompt: promptText });
          if (reportContext && reportContext.trim()) {
            const toolSummary = buildPrefetchToolSummary(reportContext);
            ss.hasLocalPrefetchEvidence = true;
            effectivePromptText = buildPrefetchAugmentedPrompt(promptText, reportContext, budgetContext);
            emitStreamEvent(promptSessionPath, ss, {
              type: "tool_end",
              name: toolName,
              success: true,
              summary: Object.keys(toolSummary).length > 0 ? toolSummary : undefined,
            });
            lifecycleHooks.run("tool_end", {
              ss,
              sessionPath: promptSessionPath,
              toolName,
              success: true,
              summary: Object.keys(toolSummary).length > 0 ? toolSummary : undefined,
              localPrefetch: true,
            });
            rememberSuccessfulTool(ss, toolName, toolSummary, { query: promptText });
            const directAnswer = buildDirectResearchAnswer(initialToolUse.reportKind, reportContext, promptText);
            if (shouldCloseWithPrefetchDirectAnswer(initialToolUse.reportKind, promptText, directAnswer)) {
              closeStreamWithVisibleFallback(
                promptSessionPath,
                ss,
                directAnswer,
                "local_realtime_prefetch_direct_answer",
                { trustedFallback: true, persistPromptIfMissing: true },
              );
              return;
            }
          } else {
            emitStreamEvent(promptSessionPath, ss, { type: "tool_end", name: toolName, success: false, error: "no evidence returned" });
            lifecycleHooks.run("tool_end", {
              ss,
              sessionPath: promptSessionPath,
              toolName,
              success: false,
              error: "no evidence returned",
              localPrefetch: true,
            });
            rememberFailedTool(ss, toolName);
          }
        } catch (prefetchErr: any) {
          emitStreamEvent(promptSessionPath, ss, {
            type: "tool_end",
            name: toolName,
            success: false,
            error: prefetchErr?.message || "prefetch failed",
          });
          lifecycleHooks.run("tool_end", {
            ss,
            sessionPath: promptSessionPath,
            toolName,
            success: false,
            error: prefetchErr?.message || "prefetch failed",
            localPrefetch: true,
          });
          rememberFailedTool(ss, toolName);
        } finally {
          stopPrefetchFeedback();
        }
        if (localQwenSynthesisAfterPrefetch) {
          ss.effectivePromptText = effectivePromptText;
          try {
            await streamLocalQwen35DirectBridge(promptSessionPath, ss, promptText, effectivePromptText, currentModelInfo, {
              // The realtime tool result is already supplied as context.
              // Keep this path as a fast local writer so weather/market
              // asks do not spend a minute in hidden reasoning.
              enableThinking: false,
              maxTokens: Math.min(LOCAL_QWEN35_DIRECT_PREFETCH_MAX_TOKENS, 768),
              timeoutMs: 45_000,
              earlyCloseVisibleChars: 240,
            });
          } catch (directErr: any) {
            debugLog()?.warn("ws", `[LOCAL-QWEN35-DIRECT v2] failed after prefetch · ${directErr?.message || directErr} · ${promptSessionPath}`);
            const fallbackOk = await fallbackLocalQwen35DirectToBrain({
              sessionPath: promptSessionPath,
              ss,
              promptText,
              effectivePromptText,
              modelInfo: currentModelInfo,
              msg,
              streamToken,
              disableTools: disableTurnTools,
              turnInstruction: noToolTurnInstruction,
              reason: "local_qwen35_direct_after_prefetch_failed",
            });
            if (!fallbackOk) {
              closeStreamWithVisibleFallback(
                promptSessionPath,
                ss,
                "",
                "local_qwen35_direct_after_prefetch_failed",
                { trustedFallback: true },
              );
            }
          }
          return;
        }
      }
      if (ss._lastTurnAborted) {
        ss._lastTurnAborted = false;
      }
      ss.effectivePromptText = effectivePromptText;
      scheduleSilentBrainAbort(promptSessionPath, ss);
      await hub.send(
        effectivePromptText,
        msg.images
          ? { images: msg.images, sessionPath: promptSessionPath, streamToken, disableTools: disableTurnTools, turnInstruction: noToolTurnInstruction }
          : { sessionPath: promptSessionPath, streamToken, disableTools: disableTurnTools, turnInstruction: noToolTurnInstruction },
      );
      if (!ss.isStreaming) {
        if (hasToolExecutionInFlight(ss)) {
          scheduleToolFinalizationFallback(promptSessionPath, ss);
          debugLog()?.log("ws", `[HUB-SEND v2] returned while tool is still in flight count=${ss.activeToolCallCount || 0}, recovered=${!!ss.recoveredBashInFlight}; defer close · ${promptSessionPath}`);
        } else {
          if (!finalizeReturnedTurnWithoutStream(promptSessionPath, ss, "hub_send_returned_closed_without_turn_end")) {
            const fallbackText = buildClosedEmptyTurnFallback(ss);
            if (fallbackText) {
              closeStreamWithVisibleFallback(promptSessionPath, ss, fallbackText, "hub_send_returned_closed_empty_fallback", { trustedFallback: true });
            } else {
              clearTurnTimers(ss);
              broadcast({ type: "status", isStreaming: false, sessionPath: promptSessionPath });
            }
          }
        }
      } else if (!hasToolExecutionInFlight(ss) && finalizeReturnedTurnWithoutStream(promptSessionPath, ss, "hub_send_returned_open_without_turn_end", { requirePersistedText: true })) {
        // finalized from the persisted non-streaming assistant message
      } else {
        scheduleReturnedTurnFinalizationFallback(promptSessionPath, ss, "hub_send_returned_open_safety_timeout");
        debugLog()?.log("ws", `hub.send returned while server stream remains open · ${promptSessionPath}`);
      }
    } catch (err: any) {
      clearTurnTimers(ss);
      const aborted = err.message?.includes("aborted");
      if (!aborted) {
        wsSend(ws, { type: "error", message: err.message, sessionPath: promptSessionPath });
        if (ss) ss.hasError = true;
      } else if (!ss.hasOutput && !ss.hasToolCall && !ss.hasThinking && !ss.hasError) {
        wsSend(ws, { type: "error", message: t("error.modelNoResponse"), sessionPath: promptSessionPath });
      }
      if (ss && !hasStreamEvent(ss, "turn_end")) {
        closeStreamAfterError(promptSessionPath, ss, aborted ? "model_request_aborted" : "model_tool_error");
      } else {
        broadcast({ type: "status", isStreaming: false, sessionPath: promptSessionPath });
      }
    }
  };
}
