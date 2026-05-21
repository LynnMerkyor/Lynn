import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function read(path: string) {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('Local Qwen provider UX guards', () => {
  it('shows inline feedback for endpoint and registration actions', () => {
    const source = read('desktop/src/react/settings/tabs/providers/ProviderDetail.tsx');
    expect(source).toContain('setActionStatus');
    expect(source).toContain('已打开 llama.cpp 端点');
    expect(source).toContain('正在重新注册本地 OpenAI 端点');
    expect(source).toContain('platform?.openExternal');
  });

  it('keeps the advanced GGUF launcher discoverable but folded', () => {
    const source = read('desktop/src/react/settings/tabs/providers/ProviderDetail.tsx');
    expect(source).toContain('推荐下载');
    expect(source).toContain('已有 GGUF / 模型目录');
    expect(source).toContain('管理本地模型');
    expect(source).toContain('定位默认 9B 文件');
    expect(source).toContain('selectGgufModel');
  });

  it('advertises the high-memory 35B Q4_K_M upgrade option with objective metrics', () => {
    const source = read('server/routes/local-qwen35.js');
    expect(source).not.toContain('qwen36-27b-q4km-imatrix');
    expect(source).toContain('qwen36-35b-a3b-q4km-imatrix');
    expect(source).toContain('24GB 显存+ 推荐');
    expect(source).toContain('thinking-on 32K');
    expect(source).toContain('MMLU 90.40%');
    expect(source).toContain('GPQA Diamond 80.70%');
    expect(source).toContain('R6000 207 tok/s');
    expect(source).not.toContain('Spark/远端兜底');
    expect(source).toContain('https://modelscope.cn/models/Merkyor/Qwen3.6-35B-A3B-GGUF-imatrix');
    expect(source).toContain('下载到本机');
    expect(source).toContain('Qwen3.6-35B-A3B-Q4_K_M-imatrix.gguf');
  });

  it('makes advanced local models actionable instead of passive cards', () => {
    const source = read('desktop/src/react/settings/tabs/providers/ProviderDetail.tsx');
    expect(source).toContain('startRecommendedDownload');
    expect(source).toContain('llamacppStartDownload');
    expect(source).toContain('下载到本机');
    expect(source).toContain('启动此模型');
    expect(source).toContain('导入本机 GGUF');
    expect(source).toContain('取消下载');
    expect(source).toContain('cancelRecommendedDownload');
    expect(source).toContain('定位默认 9B 文件');
    expect(source).not.toContain('下载/查看');
    expect(source).toContain('chooseGgufModel');
  });

  it('downloads the recommended 35B model through Lynn with checksum and parallel ranges', () => {
    const main = read('desktop/main.cjs');
    const downloader = read('desktop/model-downloader.cjs');
    const preload = read('desktop/preload.cjs');
    expect(main).toContain('qwen36-35b-a3b-q4km-imatrix');
    expect(main).toContain('21_166_758_272');
    expect(main).toContain('3e398e6c53398de229ade3a38b04e0d626289651d6d8b49ecfccc2165816efa1');
    expect(main).toContain('parallelSegments: 4');
    expect(main).toContain('Qwen3.6-35B-A3B-Q4_K_M-imatrix.gguf');
    expect(preload).toContain('llamacppStartDownload: (payload)');
    expect(downloader).toContain('_downloadFromSourceParallel');
    expect(downloader).toContain('"Range"');
  });

  it('keeps onboarding, status badge, and chat routing on the server-side local provider id', () => {
    const constants = read('desktop/src/react/onboarding/constants.ts');
    const onboardingStep = read('desktop/src/react/onboarding/steps/LocalModelDownloadStep.tsx');
    const badge = read('desktop/src/react/components/ProviderStatusBadge.tsx');
    expect(constants).toContain("providerName: 'local-qwen35-9b-q4km-imatrix'");
    expect(constants).toContain("defaultModelId: 'qwen35-9b-q4km-imatrix'");
    expect(onboardingStep).toContain('/api/local-qwen35-9b/status');
    expect(onboardingStep).toContain('/api/local-qwen35-9b/setup');
    expect(badge).toContain('/api/local-qwen35-9b/status');
    expect(badge).toContain('/api/local-qwen35-9b/setup');
    expect(badge).not.toContain("LLAMACPP_PROVIDER_ID = 'llamacpp'");
    expect(onboardingStep).not.toContain('useLlamacppState');
  });

  it('keeps external bridge owner replies on Brain when foreground chat uses local 9B', () => {
    const bridge = read('core/bridge-session-manager.js');
    expect(bridge).toContain('BRAIN_DEFAULT_MODEL_ID');
    expect(bridge).toContain('LOCAL_QWEN35_PROVIDER_ID');
    expect(bridge).toContain('resolveBridgeOwnerModel');
    expect(bridge).toContain('brain_default_for_bridge');
    expect(bridge).toContain('owner bridge model pinned to Brain default');
    expect(bridge).toContain('"weather"');
    expect(bridge).toContain('"stock_market"');
    expect(bridge).toContain('"live_news"');
    expect(bridge).toContain('"sports_score"');
  });

  it('uses platform-stable status dots instead of emoji status icons', () => {
    const badge = read('desktop/src/react/components/ProviderStatusBadge.tsx');
    const styles = read('desktop/src/styles.css');
    const emojiStatusIcons = ['🟢', '📥', '⏸', '🔴', '🟡', '☁️'];
    expect(badge).toContain('provider-status-dot');
    expect(badge).toContain('provider-status-menu-dot');
    expect(styles).toContain('.provider-status-dot');
    expect(emojiStatusIcons.some(icon => badge.includes(icon))).toBe(false);
  });

  it('keeps the daily local model in thinking-on auto mode by default', () => {
    const manager = read('desktop/llamacpp-manager.cjs');
    const launcher = read('scripts/local_qwen35_9b_q4km_llamacpp_server.sh');
    expect(manager).toContain('"--reasoning", "auto"');
    expect(launcher).toContain('--jinja --reasoning auto');
  });

  it('streams local 9B warmup feedback before the first model token', () => {
    const route = read('server/routes/chat.js');
    const thinkingBlock = read('desktop/src/react/components/chat/ThinkingBlock.tsx');
    const assistantMessage = read('desktop/src/react/components/chat/AssistantMessage.tsx');
    const inputArea = read('desktop/src/react/components/InputArea.tsx');
    expect(route).toContain('startLocalQwen35WarmupFeedback');
    expect(route).toContain('startLocalQwen35PrefetchFeedback');
    expect(route).toContain('本地 9B 已接到任务，正在连接本机 llama.cpp。');
    expect(route).toContain('正在查询实时天气数据');
    expect(route).toContain('首次启动会加载 9B 权重');
    expect(route).toContain('这不是常态，后续回答通常会明显更快');
    expect(route).toContain('刚启动后的第一问，本地 9B 正在暖机');
    expect(route).toContain('正在预热本地 32K 上下文');
    expect(route).toContain('还在等待首字');
    expect(route).toContain('这次工具耗时偏长');
    expect(assistantMessage).toContain('modelLabel={agentModelLabel}');
    expect(thinkingBlock).toContain('isLocalModelThinking');
    expect(thinkingBlock).toContain('本地 9B 正在本机生成答案');
    expect(thinkingBlock).toContain('首次启动后的第一问可能较慢');
    expect(thinkingBlock).not.toContain('马上给出结果');
    expect(inputArea).toContain('首问暖机中，后续同一会话会明显更快');
    expect(inputArea).toContain('首次暖机提示');
    expect(inputArea).toContain('第一问可能 30-60 秒');
    expect(inputArea).not.toContain('首次启动后的第一问正在暖机，可能 30-60 秒；后续会明显更快。');
    expect(inputArea).not.toContain('可接收');
  });
});
