import { getLocale } from "../server/i18n.js";
import {
  classifyRouteIntent,
  ROUTE_INTENTS,
} from "../shared/task-route-intent.js";
import {
  buildAtInjectionPromptHint,
  buildRouteAndScenarioHint,
  buildScenarioHintContext,
  buildSkillHintContext,
  shouldAttachSkillHint,
} from "./session-context-hints.js";

type AnyRecord = Record<string, any>;

type RecallForMessageResult = string | {
  text?: string | null;
  injectedFactIds?: Array<string | number> | null;
} | null | undefined;

type AgentLike = AnyRecord & {
  recallForMessage?: (text: string, cwd: string) => Promise<RecallForMessageResult> | RecallForMessageResult;
};

type SessionEntryLike = AnyRecord & {
  session?: AnyRecord;
};

type SkillsLike = {
  suggestSkillsForText?: (agent: AgentLike, text: string, limit: number) => AnyRecord[];
};

export async function prepareSessionTurnContext(opts: {
  entry: SessionEntryLike;
  text: string;
  agent: AgentLike;
  imagesCount?: number;
  turnInstruction?: unknown;
  locale?: string;
  getSkills?: () => SkillsLike | null | undefined;
  routeAroundBrokenToolModel?: (routeIntent: string) => Promise<unknown> | unknown;
}) {
  const imagesCount = Number(opts.imagesCount || 0);
  const locale = opts.locale || getLocale();

  try {
    const cwd = opts.entry.session?.sessionManager?.getCwd?.() || "";
    opts.entry._memoryOutcomeToolFailureRecorded = false;
    const recallCtx = await opts.agent.recallForMessage?.(opts.text, cwd);
    if (recallCtx && typeof recallCtx === "object") {
      opts.entry._lastRecallContext = recallCtx.text || "";
      opts.entry._lastRecallFactIds = Array.isArray(recallCtx.injectedFactIds)
        ? [...new Set(recallCtx.injectedFactIds.map((id) => String(id)).filter(Boolean))]
        : [];
    } else {
      opts.entry._lastRecallContext = recallCtx || "";
      opts.entry._lastRecallFactIds = [];
    }
  } catch {
    opts.entry._lastRecallContext = "";
    opts.entry._lastRecallFactIds = [];
  }

  const routeIntent = classifyRouteIntent(opts.text, { imagesCount });
  opts.entry._routeIntentValue = routeIntent;
  opts.entry._routeIntentHintContext = buildRouteAndScenarioHint(
    opts.text,
    routeIntent,
    { locale, imagesCount },
  );
  opts.entry._scenarioContractHintContext = buildScenarioHintContext(
    opts.text,
    { locale, imagesCount },
  );

  try {
    const suggestions = opts.getSkills?.()?.suggestSkillsForText?.(opts.agent, opts.text, 3) || [];
    opts.entry._lastSkillHintContext = shouldAttachSkillHint(routeIntent)
      ? buildSkillHintContext(suggestions)
      : "";
  } catch {
    opts.entry._lastSkillHintContext = "";
  }

  opts.entry._atInjectionHintContext = buildAtInjectionPromptHint(opts.text);
  opts.entry._turnInstructionHintContext = String(opts.turnInstruction || "").trim();
  await opts.routeAroundBrokenToolModel?.(routeIntent);
}

export function clearSessionTurnContext(entry: SessionEntryLike) {
  entry._lastRecallContext = "";
  entry._lastRecallFactIds = [];
  entry._memoryOutcomeToolFailureRecorded = false;
  entry._lastSkillHintContext = "";
  entry._atInjectionHintContext = "";
  entry._turnInstructionHintContext = "";
  entry._routeIntentHintContext = "";
  entry._scenarioContractHintContext = "";
  entry._routeIntentValue = ROUTE_INTENTS.CHAT;
}
