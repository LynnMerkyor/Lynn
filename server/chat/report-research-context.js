import {
  buildAnswer,
  buildDirectResearchAnswer,
} from "./report-research-answer.js";
import { fetchForKind } from "./report-research-fetch.js";
import {
  extractStockTargetForResearch,
  inferKind,
  inferReportResearchKind,
} from "./report-research-intent.js";

export {
  buildAnswer,
  buildDirectResearchAnswer,
  extractStockTargetForResearch,
  fetchForKind,
  inferKind,
  inferReportResearchKind,
};

export async function buildReportResearchContext(text, opts = {}) {
  const intent = inferKind(text);
  if (!intent.kind) return "";
  return fetchForKind(intent.kind, intent.target, {
    ...opts,
    intent,
    text,
    userPrompt: opts.userPrompt || text,
  });
}
