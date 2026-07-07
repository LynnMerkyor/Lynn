/**
 * ProviderDetail pure helpers — local-Qwen provider id/filename checks, TPS &
 * byte formatters, memory-adaptive local upgrade-option normalization, local
 * endpoint root, and local-model action error text. Extracted from
 * ProviderDetail.tsx (GUI monolith decomposition). No React/hooks/JSX/CSS —
 * pure, unit-testable. (window.platform stays in the component.)
 */

export const LOCAL_QWEN_PROVIDER_ID = 'local-qwen35-9b-q4km-imatrix';
export const LOCAL_QWEN_PROVIDER_LABEL = '本地 Qwen3.6-27B Coding';
export const LOCAL_QWEN_DEFAULT_MODEL_ID = 'qwen36-27b-dsv4pro-coding-q4-mtp';
export const LOCAL_QWEN_DEFAULT_MODEL_FILE = 'Q4-imatrix-MTP-00001-of-00004.gguf';
export const LOCAL_QWEN_DEFAULT_EXPECTED_SIZE = 19_575_379_360;
export const LOCAL_QWEN_COMPAT_PROVIDER_IDS = new Set([
  LOCAL_QWEN_PROVIDER_ID,
  'local-qwen35-4b-q4km',
  'local-qwen3-4b-thinking-2507-q4km-imatrix',
]);

export function isLocalQwenProviderId(id?: string | null) {
  return !!id && (LOCAL_QWEN_COMPAT_PROVIDER_IDS.has(id) || /^local-qwen/i.test(id));
}

export function isDefaultQwen35MtpFileName(fileName: string) {
  return /^Q4-imatrix-MTP-0000[1-4]-of-00004\.gguf$/i.test(fileName)
    || /qwen3\.?6-?27b.*dsv4pro.*coding.*q4.*mtp.*\.gguf$/i.test(fileName);
}

export function formatLocalTps(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return `${value.toFixed(value >= 10 ? 0 : 1)} tok/s`;
}

export type LocalActionStatus = {
  kind: 'info' | 'success' | 'error';
  text: string;
};

export type LocalUpgradeOption = {
  id?: string;
  label?: string;
  profile?: string;
  metrics?: string[];
  reason?: string;
  modelscope_url?: string;
  download_label?: string;
  file_name?: string;
};

export const LOCAL_QWEN35_4B_DOWNGRADE: LocalUpgradeOption = {
  id: 'qwen35-4b-q4km',
  label: 'Qwen3.5-4B Q4_K_M imatrix (低配降级)',
  profile: '8~16GB 显存/统一内存可选 · 建议 thinking-off',
  metrics: ['2.6 GB', 'MMLU thinking-off 73.00%', 'GPQA thinking-off 16.67%', 'thinking-on 可能长思考后无正文'],
  reason: '仅推荐给跑不动 27B / 9B 的低配设备。4B 只作为降级档；thinking-on 可能长思考后无正文，默认不要作为引导模型。',
  modelscope_url: 'https://modelscope.cn/models/Merkyor/Qwen3.5-4B-GGUF-imatrix',
  download_label: '下载到本机',
  file_name: 'Qwen3.5-4B-Q4_K_M-imatrix.gguf',
};

export const LOCAL_QWEN35_9B_DOWNGRADE: LocalUpgradeOption = {
  id: 'qwen35-9b-q4km-imatrix',
  label: 'Qwen3.5-9B Q4_K_M imatrix MTP (低配降级)',
  profile: '16~24GB 显存/统一内存可选 · 比 27B 更轻',
  metrics: ['5.78GB / 5.38GiB', '32K 上下文', 'MTP 加速', '低配降级'],
  reason: '给跑不动 27B Q4 的设备保留；质量不再作为 Lynn 本地首推。',
  modelscope_url: 'https://modelscope.cn/models/Merkyor/Qwen3.5-9B-GGUF-imatrix-MTP',
  download_label: '下载到本机',
  file_name: 'Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf',
};

export const LOCAL_QWEN36_35B_UPGRADE: LocalUpgradeOption = {
  id: 'qwen36-35b-a3b-dsv4pro-distill-q5km-imatrix',
  label: 'Qwen3.6-35B-A3B DSV4Pro Thinking Distill MTP Q5_K_M imatrix',
  profile: '32GB 显存/统一内存+ 可选 · 更高配本地编排器',
  metrics: ['25.3 GB Q5_K_M imatrix', 'MTP 原生头', 'GPQA-Diamond 80.3%', '端到端编排 26.6s'],
  reason: '32GB+ 机器可选 35B-A3B Q5_K_M；MoE + MTP 单流速度更好，但文件和 KV cache 都更重。默认仍首推 27B Q4。',
  modelscope_url: 'https://modelscope.cn/models/Merkyor/Qwen3.6-35B-A3B-DSV4Pro-Thinking-Distill-GGUF',
  download_label: '下载到本机',
  file_name: 'Qwen3.6-35B-A3B-DSV4Pro-Distill-MTP-Q5_K_M-imatrix.gguf',
};

export function normalizeLocalUpgradeOptions(options: LocalUpgradeOption[] = [], memoryGib?: number | null) {
  // 默认卡即 27B Q4;可选区按硬件分级展示 9B/4B 降级 / 35B 高端档。
  // 2026-06-27: 接 hardware.total_memory_gib 做 memory-adaptive 显示 —
  //   - memoryGib > 32:藏 4B 降级,保留 9B 与 35B
  //   - memoryGib < 24:藏 35B 高端,展示 9B/4B
  //   - 中间(24~32GB):9B + 4B 都显示,35B 隐藏
  //   - memoryGib 未知(null/undefined):全显示(保留 v0.79.1 之前行为)
  let server4b: LocalUpgradeOption | null = null;
  let server9b: LocalUpgradeOption | null = null;
  let server35b: LocalUpgradeOption | null = null;
  const others: LocalUpgradeOption[] = [];
  for (const option of options) {
    const haystack = `${option.id || ''} ${option.label || ''}`.toLowerCase();
    if (haystack.includes('27b')) continue;
    if (haystack.includes('4b')) { server4b = option; continue; }
    if (haystack.includes('9b')) { server9b = option; continue; }
    if (haystack.includes('35b')) { server35b = option; continue; }
    others.push(option);
  }
  const mem = typeof memoryGib === 'number' && Number.isFinite(memoryGib) ? memoryGib : null;
  const show4b = mem === null || mem <= 32;
  const show9b = true;
  const show35b = mem === null || mem >= 32;
  const normalized: LocalUpgradeOption[] = [];
  if (show9b) {
    normalized.push({ ...LOCAL_QWEN35_9B_DOWNGRADE, ...(server9b || {}), ...LOCAL_QWEN35_9B_DOWNGRADE });
  }
  if (show4b) {
    normalized.push({ ...LOCAL_QWEN35_4B_DOWNGRADE, ...(server4b || {}), ...LOCAL_QWEN35_4B_DOWNGRADE });
  }
  normalized.push(...others);
  if (show35b) {
    normalized.push({ ...LOCAL_QWEN36_35B_UPGRADE, ...(server35b || {}), ...LOCAL_QWEN36_35B_UPGRADE });
  }
  return normalized;
}

export function localEndpointRoot(baseUrl?: string | null) {
  return String(baseUrl || 'http://127.0.0.1:18099/v1').replace(/\/v1\/?$/, '');
}

export function formatBytes(bytes?: number | null) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

export function localModelActionErrorText(reason?: string, detail?: string) {
  const value = String(detail || reason || 'unknown-error');
  if (reason === 'insufficient-disk-space') return detail || '磁盘空间不足。请清理模型目录所在磁盘后重试。';
  if (reason === 'another-download-running') return '已有其他本地模型正在下载或校验。请等待完成，或先取消当前下载。';
  if (reason === 'unknown-model-id' || reason === 'invalid-model-id') return '本地模型请求无效。请刷新设置页后重试。';
  if (reason === 'download-boundary-invalid') return detail || '下载源未通过安全校验。Lynn 只允许公开 http/https GGUF 源。';
  if (reason === 'model-path-not-allowed') return '请通过“选择本机 GGUF 启动”重新选择该文件，或把 GGUF 放到本地模型目录后再启动。';
  if (reason === 'not-gguf') return '只能导入 .gguf 模型文件。';
  if (reason === 'model-not-found') return '模型文件不存在或已移动。请重新选择 GGUF。';
  return value;
}
