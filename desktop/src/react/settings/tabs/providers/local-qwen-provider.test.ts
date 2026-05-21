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
    expect(source).toContain('本地模型库');
    expect(source).toContain('自选 GGUF 模型');
    expect(source).toContain('27B/35B');
    expect(source).toContain('selectGgufModel');
  });

  it('advertises 27B and 35B Q4_K_M upgrade options', () => {
    const source = read('server/routes/local-qwen35.js');
    expect(source).toContain('qwen36-27b-q4km-imatrix');
    expect(source).toContain('qwen36-35b-a3b-q4km-imatrix');
    expect(source).toContain('MMLU100 93.0%');
    expect(source).toContain('R6000 66 tok/s');
    expect(source).toContain('GPQA50 78% / 81.25% excl_pf');
    expect(source).toContain('工具调用待测');
    expect(source).toContain('https://modelscope.cn/models/Merkyor/Qwen3.6-27B-GGUF-imatrix');
    expect(source).toContain('https://modelscope.cn/models/Merkyor/Qwen3.6-35B-A3B-GGUF-imatrix');
  });

  it('makes advanced local models actionable instead of passive cards', () => {
    const source = read('desktop/src/react/settings/tabs/providers/ProviderDetail.tsx');
    expect(source).toContain('选择本机 GGUF');
    expect(source).toContain('下载/查看');
    expect(source).toContain('chooseGgufModel');
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
});
