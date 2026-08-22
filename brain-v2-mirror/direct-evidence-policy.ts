import {
  shouldPreferSportsScoreTool,
  shouldPreferStockMarketTool,
  shouldPreferWeatherTool,
  shouldPreferExchangeRateTool,
  shouldPreferCalendarTool,
} from './tool-exec/index.js';
import { providerId, type ChatMessage, type ProviderId } from './types.js';

export type DirectEvidenceKind = 'weather' | 'sports' | 'market' | 'exchange' | 'calendar';

export interface DirectEvidencePrefetchPlan {
  kind: DirectEvidenceKind;
  toolName: 'weather' | 'sports_score' | 'stock_market' | 'exchange_rate' | 'calendar';
  providerId: ProviderId;
  continuationRequirement: string;
}

const STEP_FLASH_PROVIDER_ID = providerId('step-3.7-flash');
const DIRECT_EVIDENCE_PLANNING_PROVIDER_IDS = [
  providerId('mimo-ultraspeed'),
  providerId('deepseek-chat'),
];

function hasEvidenceLedger(messages: ChatMessage[], toolName: string): boolean {
  const escapedToolName = toolName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`【Lynn 工具证据 #\\d+:\\s*${escapedToolName}】`, 'u');
  return messages.some((message) => pattern.test(
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content || ''),
  ));
}

export function skipDirectEvidencePlanningProviders(skippedProviders: Set<ProviderId>): void {
  for (const provider of DIRECT_EVIDENCE_PLANNING_PROVIDER_IDS) skippedProviders.add(provider);
}

export function buildDirectEvidencePrefetchPlans(
  intentMessages: ChatMessage[],
  evidenceMessages: ChatMessage[] = intentMessages,
): DirectEvidencePrefetchPlan[] {
  const plans: DirectEvidencePrefetchPlan[] = [];

  if (process.env.BRAIN_V2_DIRECT_WEATHER_PREFETCH !== '0' && shouldPreferWeatherTool(intentMessages)) {
    plans.push({
      kind: 'weather',
      toolName: 'weather',
      providerId: STEP_FLASH_PROVIDER_ID,
      continuationRequirement: '【接续要求】上方 weather 是本轮已经预取的天气证据。不要再调用工具,直接基于证据回答用户原问题；如果证据里没有目标日期、地点、温度或降雨字段,请明确说工具结果未返回该字段。',
    });
  }

  if (
    process.env.BRAIN_V2_DIRECT_SPORTS_PREFETCH !== '0'
    && shouldPreferSportsScoreTool(intentMessages)
    && !hasEvidenceLedger(evidenceMessages, 'sports_score')
  ) {
    plans.push({
      kind: 'sports',
      toolName: 'sports_score',
      providerId: STEP_FLASH_PROVIDER_ID,
      continuationRequirement: '【接续要求】上方 sports_score 是本轮已经预取的体育证据。不要再调用工具,直接基于证据回答用户原问题；如果证据里没有比分或赛果,请明确说工具结果未返回该字段。',
    });
  }

  if (
    process.env.BRAIN_V2_DIRECT_EXCHANGE_PREFETCH !== '0'
    && shouldPreferExchangeRateTool(intentMessages)
    && !hasEvidenceLedger(evidenceMessages, 'exchange_rate')
  ) {
    plans.push({
      kind: 'exchange',
      toolName: 'exchange_rate',
      providerId: STEP_FLASH_PROVIDER_ID,
      continuationRequirement: '【接续要求】上方 exchange_rate 是本轮已经预取的汇率证据。不要再调用工具，直接区分市场快照与官方日度参考汇率回答；不得把参考汇率冒充实时成交价。',
    });
  }

  if (
    process.env.BRAIN_V2_DIRECT_CALENDAR_PREFETCH !== '0'
    && shouldPreferCalendarTool(intentMessages)
    && !hasEvidenceLedger(evidenceMessages, 'calendar')
  ) {
    plans.push({
      kind: 'calendar',
      toolName: 'calendar',
      providerId: STEP_FLASH_PROVIDER_ID,
      continuationRequirement: '【接续要求】上方 calendar 是本轮已经预取的国务院节假日证据。不要再调用工具，直接回答放假和调休日期并保留官方来源。',
    });
  }

  if (
    process.env.BRAIN_V2_DIRECT_MARKET_PREFETCH !== '0'
    && shouldPreferStockMarketTool(intentMessages)
    && !hasEvidenceLedger(evidenceMessages, 'stock_market')
  ) {
    plans.push({
      kind: 'market',
      toolName: 'stock_market',
      providerId: STEP_FLASH_PROVIDER_ID,
      continuationRequirement: '【接续要求】上方 stock_market 是本轮已经预取的行情证据。不要再调用工具,直接基于证据回答用户原问题；如果证据里没有点位、价格或涨跌幅,请明确说工具结果未返回该字段。',
    });
  }

  return plans;
}
