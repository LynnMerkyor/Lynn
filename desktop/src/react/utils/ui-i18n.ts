function normalizeLocale(locale?: string): 'zh' | 'zh-TW' | 'ja' | 'ko' | 'en' {
  const value = String(locale || '').trim();
  if (value === 'zh-TW' || value === 'zh-Hant') return 'zh-TW';
  if (value.startsWith('zh')) return 'zh';
  if (value.startsWith('ja')) return 'ja';
  if (value.startsWith('ko')) return 'ko';
  return 'en';
}

function applyVars(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  let text = template;
  for (const [key, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${key}}`, String(value));
  }
  return text;
}

const UI_FALLBACKS: Record<string, Record<string, string>> = {
  zh: {
    'status.reconnecting': '正在重连…',
    'status.disconnected': '连接已断开',
    'status.reconnect': '重新连接',
    'status.llmSlowResponse': '模型仍在处理中，请稍等片刻。',
    'status.llmStillWorking': '模型仍在处理中，已等待约 {minutes} 分钟。',
    'status.recoveringToolExecution': '工具调用仍在处理，请稍等。',
    'status.tasksRecovered': '已恢复 {count} 个后台任务',
    'status.tasksRecoveredRunning': '{count} 个后台任务仍在运行',
    'status.tasksRecoveredWaiting': '{count} 个后台任务仍在运行，其中 {waiting} 个仍在等待确认',
    'status.routeReasoningPlanned': '已识别为分析型任务。',
    'status.routeExecutionPlanned': '已识别为执行型任务。',
    'status.routeCodingPlanned': '已识别为编码型任务。',
    'status.routeVisionPlanned': '已识别为图像或附件分析任务。',
    'status.defaultModelSlowResponse': '默认工作模型仍在处理，请稍等。',
    'status.defaultModelRecoveringToolExecution': '默认工作模型的工具调用仍在处理，请稍等。',
    'status.defaultModelStillWorking': '默认工作模型仍在处理中，已等待约 {minutes} 分钟。',
    'status.defaultReasoningSlowResponse': '模型仍在推理，请稍等。',
    'status.defaultReasoningStillWorking': '模型仍在推理，已等待约 {minutes} 分钟。',
    'status.defaultExecutionSlowResponse': '执行任务仍在处理，请稍等。',
    'status.defaultExecutionStillWorking': '执行任务仍在处理，已等待约 {minutes} 分钟。',
    'status.defaultCodingSlowResponse': '编码任务仍在处理，请稍等。',
    'status.defaultCodingStillWorking': '编码任务仍在处理，已等待约 {minutes} 分钟。',
    'status.defaultCodingRecoveringToolExecution': '编码任务的工具调用仍在处理，请稍等。',
  },
  'zh-TW': {
    'status.reconnecting': '正在重新連線…',
    'status.disconnected': '連線已中斷',
    'status.reconnect': '重新連線',
    'status.llmSlowResponse': '模型仍在處理中，請稍候。',
    'status.llmStillWorking': '模型仍在處理中，已等待約 {minutes} 分鐘。',
    'status.recoveringToolExecution': '工具呼叫仍在處理中，請稍候。',
    'status.tasksRecovered': '已恢復 {count} 個背景任務',
    'status.tasksRecoveredRunning': '{count} 個背景任務仍在執行',
    'status.tasksRecoveredWaiting': '{count} 個背景任務仍在執行，其中 {waiting} 個仍在等待確認',
    'status.routeReasoningPlanned': '已識別為分析型任務。',
    'status.routeExecutionPlanned': '已識別為執行型任務。',
    'status.routeCodingPlanned': '已識別為編碼型任務。',
    'status.routeVisionPlanned': '已識別為圖像或附件分析任務。',
    'status.defaultModelSlowResponse': '預設工作模型仍在處理中，請稍候。',
    'status.defaultModelRecoveringToolExecution': '預設工作模型的工具呼叫仍在處理中，請稍候。',
    'status.defaultModelStillWorking': '預設工作模型仍在處理中，已等待約 {minutes} 分鐘。',
    'status.defaultReasoningSlowResponse': '模型仍在推理中，請稍候。',
    'status.defaultReasoningStillWorking': '模型仍在推理中，已等待約 {minutes} 分鐘。',
    'status.defaultExecutionSlowResponse': '執行任務仍在處理中，請稍候。',
    'status.defaultExecutionStillWorking': '執行任務仍在處理中，已等待約 {minutes} 分鐘。',
    'status.defaultCodingSlowResponse': '編碼任務仍在處理中，請稍候。',
    'status.defaultCodingStillWorking': '編碼任務仍在處理中，已等待約 {minutes} 分鐘。',
    'status.defaultCodingRecoveringToolExecution': '編碼任務的工具呼叫仍在處理中，請稍候。',
  },
  ja: {
    'status.reconnecting': '再接続しています…',
    'status.disconnected': '接続が切断されました',
    'status.reconnect': '再接続',
    'status.llmSlowResponse': 'モデルはまだ処理中です。もう少しお待ちください。',
    'status.llmStillWorking': 'モデルはまだ処理中です。約 {minutes} 分待っています。',
    'status.recoveringToolExecution': 'ツール呼び出しはまだ処理中です。もう少しお待ちください。',
    'status.tasksRecovered': 'バックグラウンドタスクを {count} 件復元しました',
    'status.tasksRecoveredRunning': 'バックグラウンドタスクが {count} 件まだ実行中です',
    'status.tasksRecoveredWaiting': 'バックグラウンドタスクが {count} 件まだ実行中で、そのうち {waiting} 件は承認待ちです',
    'status.routeReasoningPlanned': '分析タスクとして識別しました。',
    'status.routeExecutionPlanned': '実行タスクとして識別しました。',
    'status.routeCodingPlanned': 'コーディングタスクとして識別しました。',
    'status.routeVisionPlanned': '画像または添付ファイルの分析タスクとして識別しました。',
    'status.defaultModelSlowResponse': '既定の作業モデルはまだ処理中です。もう少しお待ちください。',
    'status.defaultModelRecoveringToolExecution': '既定の作業モデルのツール呼び出しはまだ処理中です。もう少しお待ちください。',
    'status.defaultModelStillWorking': '既定の作業モデルはまだ処理中です。約 {minutes} 分待っています。',
    'status.defaultReasoningSlowResponse': 'モデルはまだ推論中です。もう少しお待ちください。',
    'status.defaultReasoningStillWorking': 'モデルはまだ推論中です。約 {minutes} 分待っています。',
    'status.defaultExecutionSlowResponse': '実行タスクはまだ処理中です。もう少しお待ちください。',
    'status.defaultExecutionStillWorking': '実行タスクはまだ処理中です。約 {minutes} 分待っています。',
    'status.defaultCodingSlowResponse': 'コーディングタスクはまだ処理中です。もう少しお待ちください。',
    'status.defaultCodingStillWorking': 'コーディングタスクはまだ処理中です。約 {minutes} 分待っています。',
    'status.defaultCodingRecoveringToolExecution': 'コーディングタスクのツール呼び出しはまだ処理中です。もう少しお待ちください。',
  },
  ko: {
    'status.reconnecting': '다시 연결하는 중…',
    'status.disconnected': '연결이 끊겼어요',
    'status.reconnect': '다시 연결',
    'status.llmSlowResponse': '모델이 아직 처리 중입니다. 잠시만 기다려 주세요.',
    'status.llmStillWorking': '모델이 아직 처리 중입니다. 약 {minutes}분째 기다리고 있어요.',
    'status.recoveringToolExecution': '도구 호출이 아직 처리 중입니다. 잠시만 기다려 주세요.',
    'status.tasksRecovered': '백그라운드 작업 {count}개를 복구했어요',
    'status.tasksRecoveredRunning': '백그라운드 작업 {count}개가 아직 실행 중이에요',
    'status.tasksRecoveredWaiting': '백그라운드 작업 {count}개가 아직 실행 중이며, 그중 {waiting}개는 승인을 기다리고 있어요',
    'status.routeReasoningPlanned': '분석형 작업으로 식별했어요.',
    'status.routeExecutionPlanned': '실행형 작업으로 식별했어요.',
    'status.routeCodingPlanned': '코딩 작업으로 식별했어요.',
    'status.routeVisionPlanned': '이미지 또는 첨부 분석 작업으로 식별했어요.',
    'status.defaultModelSlowResponse': '기본 작업 모델이 아직 처리 중입니다. 잠시만 기다려 주세요.',
    'status.defaultModelRecoveringToolExecution': '기본 작업 모델의 도구 호출이 아직 처리 중입니다. 잠시만 기다려 주세요.',
    'status.defaultModelStillWorking': '기본 작업 모델이 아직 처리 중입니다. 약 {minutes}분째 기다리고 있어요.',
    'status.defaultReasoningSlowResponse': '모델이 아직 추론 중입니다. 잠시만 기다려 주세요.',
    'status.defaultReasoningStillWorking': '모델이 아직 추론 중입니다. 약 {minutes}분째 기다리고 있어요.',
    'status.defaultExecutionSlowResponse': '실행 작업이 아직 처리 중입니다. 잠시만 기다려 주세요.',
    'status.defaultExecutionStillWorking': '실행 작업이 아직 처리 중입니다. 약 {minutes}분째 기다리고 있어요.',
    'status.defaultCodingSlowResponse': '코딩 작업이 아직 처리 중입니다. 잠시만 기다려 주세요.',
    'status.defaultCodingStillWorking': '코딩 작업이 아직 처리 중입니다. 약 {minutes}분째 기다리고 있어요.',
    'status.defaultCodingRecoveringToolExecution': '코딩 작업의 도구 호출이 아직 처리 중입니다. 잠시만 기다려 주세요.',
  },
  en: {
    'status.reconnecting': 'Reconnecting…',
    'status.disconnected': 'Connection lost',
    'status.reconnect': 'Reconnect',
    'status.llmSlowResponse': 'The model is still working. Please wait a moment.',
    'status.llmStillWorking': 'The model is still working. Waited about {minutes} minute(s).',
    'status.recoveringToolExecution': 'The tool call is still running. Please wait a moment.',
    'status.tasksRecovered': 'Recovered {count} background task(s)',
    'status.tasksRecoveredRunning': '{count} background task(s) are still running',
    'status.tasksRecoveredWaiting': '{count} background task(s) are still running, with {waiting} waiting for approval',
    'status.routeReasoningPlanned': 'Analysis task detected.',
    'status.routeExecutionPlanned': 'Execution task detected.',
    'status.routeCodingPlanned': 'Coding task detected.',
    'status.routeVisionPlanned': 'Image or attachment analysis task detected.',
    'status.defaultModelSlowResponse': 'The default work model is still working. Please wait a moment.',
    'status.defaultModelRecoveringToolExecution': 'The default work model tool call is still running. Please wait a moment.',
    'status.defaultModelStillWorking': 'The default work model is still working. Waited about {minutes} minute(s).',
    'status.defaultReasoningSlowResponse': 'The model is still reasoning. Please wait a moment.',
    'status.defaultReasoningStillWorking': 'The model is still reasoning. Waited about {minutes} minute(s).',
    'status.defaultExecutionSlowResponse': 'The execution task is still running. Please wait a moment.',
    'status.defaultExecutionStillWorking': 'The execution task is still running. Waited about {minutes} minute(s).',
    'status.defaultCodingSlowResponse': 'The coding task is still running. Please wait a moment.',
    'status.defaultCodingStillWorking': 'The coding task is still running. Waited about {minutes} minute(s).',
    'status.defaultCodingRecoveringToolExecution': 'The coding task tool call is still running. Please wait a moment.',
  },
};

export function looksLikeI18nKey(value: string): boolean {
  return /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/i.test(String(value || '').trim());
}

export function resolveUiI18nText(raw: unknown, vars?: Record<string, string | number>): string {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (!looksLikeI18nKey(text)) return text;

  const translated = typeof window !== 'undefined' && typeof window.t === 'function'
    ? window.t(text, vars)
    : text;
  if (translated && translated !== text) return String(translated);

  const locale = normalizeLocale(typeof window !== 'undefined' ? window.i18n?.locale : 'zh');
  const fallback = UI_FALLBACKS[locale]?.[text];
  return fallback ? applyVars(fallback, vars) : text;
}
