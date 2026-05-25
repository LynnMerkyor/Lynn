import {
  buildAnswer,
  buildDirectResearchAnswer,
} from "./report-research-answer.js";
import { fetchForKind } from "./report-research-fetch.js";
import type { ReportResearchFetchOptions } from "./report-research-fetch.js";
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

export async function buildReportResearchContext(
  text: string,
  opts: ReportResearchFetchOptions = {},
): Promise<string> {
  const intent = inferKind(text);
  if (!intent.kind) return "";
  return fetchForKind(intent.kind, intent.target, {
    ...opts,
    text,
    userPrompt: opts.userPrompt || text,
  });
}
