const ERROR_MESSAGES: Array<[RegExp, string]> = [
  [/auth|unauthori[sz]ed|forbidden|invalid[_ -]?key|401|403/i, '认证失败，请检查登录状态或 API Key。'],
  [/timeout|timed out|aborterror|请求超时/i, '请求超时，请稍后重试。'],
  [/network|failed to fetch|econnreset|econnrefused|enotfound|socket hang up/i, '网络连接失败，请检查网络后重试。'],
  [/rate[_ -]?limit|too many requests|429/i, '请求过于频繁，请稍后再试。'],
  [/port[_ -]?in[_ -]?use|eaddrinuse/i, '本地服务端口已被占用，请停止冲突进程后重试。'],
  [/binary[_ -]?not[_ -]?found|enoent/i, '缺少所需的本地运行程序，请在设置中重新检查安装。'],
  [/model[_ -]?not[_ -]?found/i, '没有找到模型文件，请重新选择或下载。'],
  [/cancelled|canceled|aborted/i, '操作已取消。'],
];

export function humanizeUiError(input: unknown): string {
  const raw = String(input instanceof Error ? input.message : input || '').trim();
  if (!raw) return '操作失败，请重试。';
  for (const [pattern, message] of ERROR_MESSAGES) {
    if (pattern.test(raw)) return message;
  }
  if (/^[a-z0-9_.:-]+$/i.test(raw) || raw.startsWith('{') || raw.includes('\n    at ')) {
    return '操作失败，请重试；如问题持续，可在诊断中查看详情。';
  }
  return raw.length > 180 ? `${raw.slice(0, 177)}...` : raw;
}
