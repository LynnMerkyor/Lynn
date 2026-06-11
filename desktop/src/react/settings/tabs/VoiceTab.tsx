import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../store';
import { useStore } from '../../stores';
import { autoSaveConfig } from '../helpers';
import { SelectWidget } from '../widgets/SelectWidget';
import { KeyInput } from '../widgets/KeyInput';
import styles from '../Settings.module.css';

const ASR_PROVIDERS = [
  { value: 'spark', label: '语音输入转写 (本地 ASR · 默认)' },
  { value: 'openai', label: 'OpenAI Whisper API (BYOK)' },
  { value: 'azure', label: 'Azure Speech-to-Text (BYOK)' },
];

const TTS_PROVIDERS = [
  { value: 'stepfun-realtime', label: 'StepFun Realtime TTS (Lynn 云端 · 无需 Key)' },
  { value: 'openai', label: 'OpenAI TTS API (BYOK)' },
];

const LANGUAGES = [
  { value: 'auto', label: '自动检测' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
];

function defaultTtsVoice(provider: string): string {
  if (provider === 'stepfun-realtime') return 'jingdiannvsheng';
  return 'zh-CN-XiaoxiaoNeural';
}

const LEGACY_ASR_FALLBACKS = new Set(['stepfun-realtime', 'stepfun', 'brain-realtime', 'brain-stepfun-realtime', 'sensevoice', 'faster-whisper']);
const LEGACY_TTS_FALLBACKS = new Set(['spark', 'cosyvoice', 'edge', 'say']);

export function normalizeAsrProvider(provider?: string | null): string {
  const value = String(provider || '').trim();
  if (!value || LEGACY_ASR_FALLBACKS.has(value)) return 'spark';
  return value;
}

export function normalizeTtsProvider(provider?: string | null): string {
  const value = String(provider || '').trim();
  if (!value || LEGACY_TTS_FALLBACKS.has(value)) return 'stepfun-realtime';
  return value;
}

type ShortcutStatus = {
  ok: boolean;
  accelerator: string | null;
  fallbackUsed: boolean;
  attempted: string[];
  configured?: string | null;
  defaultAccelerator?: string | null;
  layer?: string | null;
  errors?: Record<string, string>;
};

function formatShortcutStatus(status: ShortcutStatus | null): string {
  if (!status) return '正在读取快捷键状态...';
  const attempted = status.attempted?.join(' / ') || 'Cmd+Shift+L / Ctrl+Shift+L';
  if (!status.ok) return `快捷键被占用或不可用。已尝试: ${attempted}`;
  if (status.configured && status.accelerator === status.configured) {
    return `${status.accelerator} 已注册为自定义快捷键。`;
  }
  if (status.configured && status.accelerator !== status.configured) {
    return `自定义快捷键 ${status.configured} 不可用,已自动改用 ${status.accelerator}。`;
  }
  if (status.fallbackUsed) return `默认快捷键被占用,已自动改用 ${status.accelerator}。`;
  return `${status.accelerator} 已注册。`;
}

export function VoiceTab() {
  const { settingsConfig } = useSettingsStore();
  const voice = settingsConfig?.voice || {};

  const [asrProvider, setAsrProvider] = useState(normalizeAsrProvider(voice.asr?.provider));
  const [asrKey, setAsrKey] = useState(voice.asr?.api_key || '');
  const [asrBaseUrl, setAsrBaseUrl] = useState(voice.asr?.base_url || '');

  const [ttsProvider, setTtsProvider] = useState(normalizeTtsProvider(voice.tts?.provider));
  const [ttsKey, setTtsKey] = useState(voice.tts?.api_key || '');
  const [ttsBaseUrl, setTtsBaseUrl] = useState(voice.tts?.base_url || '');
  const [ttsVoice, setTtsVoice] = useState(voice.tts?.default_voice || defaultTtsVoice(normalizeTtsProvider(voice.tts?.provider)));
  const ttsAutoPrefetch = useStore((s) => s.ttsAutoPrefetch);
  const ttsStreamingEnabled = useStore((s) => s.ttsStreamingEnabled);
  const ttsBrowserFallbackEnabled = useStore((s) => s.ttsBrowserFallbackEnabled);
  const setTtsAutoPrefetch = useStore((s) => s.setTtsAutoPrefetch);
  const setTtsStreamingEnabled = useStore((s) => s.setTtsStreamingEnabled);
  const setTtsBrowserFallbackEnabled = useStore((s) => s.setTtsBrowserFallbackEnabled);
  const setTtsProviderPreference = useStore((s) => s.setTtsProviderPreference);

  const [language, setLanguage] = useState(voice.language || 'auto');
  const [shortcutStatus, setShortcutStatus] = useState<ShortcutStatus | null>(null);
  const [shortcutDraft, setShortcutDraft] = useState('');
  const [shortcutSaving, setShortcutSaving] = useState(false);

  // 当 settingsConfig 从服务端刷新后，同步本地状态
  useEffect(() => {
    const v = settingsConfig?.voice || {};
    const nextAsrProvider = normalizeAsrProvider(v.asr?.provider);
    setAsrProvider(nextAsrProvider);
    setAsrKey(v.asr?.api_key || '');
    setAsrBaseUrl(v.asr?.base_url || '');
    const nextTtsProvider = normalizeTtsProvider(v.tts?.provider);
    setTtsProvider(nextTtsProvider);
    setTtsProviderPreference(nextTtsProvider);
    setTtsKey(v.tts?.api_key || '');
    setTtsBaseUrl(v.tts?.base_url || '');
    setTtsVoice(v.tts?.default_voice || defaultTtsVoice(nextTtsProvider));
    setLanguage(v.language || 'auto');
  }, [settingsConfig?.voice, setTtsProviderPreference]);

  useEffect(() => {
    let cancelled = false;
    window.platform?.getGlobalSummonShortcutStatus?.()
      .then((status) => {
        if (!cancelled) {
          setShortcutStatus(status || null);
          setShortcutDraft(status?.configured || status?.accelerator || '');
        }
      })
      .catch(() => {
        if (!cancelled) setShortcutStatus(null);
      });
    return () => { cancelled = true; };
  }, []);

  const needsAsrKey = asrProvider === 'openai' || asrProvider === 'azure';
  const needsTtsKey = ttsProvider === 'openai';

  const handleSave = async () => {
    const payload: {
      voice: {
        language: string;
        asr: { provider: string; api_key?: string; base_url?: string };
        tts: {
          provider: string;
          default_voice: string;
          api_key?: string;
          base_url?: string;
        };
      };
    } = {
      voice: {
        language,
        asr: {
          provider: asrProvider,
          ...(needsAsrKey ? { api_key: asrKey || undefined } : {}),
          ...(needsAsrKey && asrBaseUrl ? { base_url: asrBaseUrl } : {}),
        },
        tts: {
          provider: ttsProvider,
          default_voice: ttsVoice,
          ...(needsTtsKey ? { api_key: ttsKey || undefined } : {}),
          ...(needsTtsKey && ttsBaseUrl ? { base_url: ttsBaseUrl } : {}),
        },
      },
    };
    // 清理空值
    if (!payload.voice.asr.api_key) delete payload.voice.asr.api_key;
    if (!payload.voice.asr.base_url) delete payload.voice.asr.base_url;
    if (!payload.voice.tts.api_key) delete payload.voice.tts.api_key;
    if (!payload.voice.tts.base_url) delete payload.voice.tts.base_url;
    await autoSaveConfig(payload);
  };

  const applyShortcut = async () => {
    if (!window.platform?.setGlobalSummonShortcut) return;
    setShortcutSaving(true);
    try {
      const status = await window.platform.setGlobalSummonShortcut(shortcutDraft.trim() || null);
      setShortcutStatus(status || null);
      setShortcutDraft(status?.configured || status?.accelerator || shortcutDraft.trim());
    } catch (err) {
      setShortcutStatus({
        ok: false,
        accelerator: null,
        fallbackUsed: false,
        attempted: [shortcutDraft.trim()].filter(Boolean),
        errors: { [shortcutDraft.trim() || 'shortcut']: err instanceof Error ? err.message : String(err) },
      });
    } finally {
      setShortcutSaving(false);
    }
  };

  const resetShortcut = async () => {
    if (!window.platform?.setGlobalSummonShortcut) return;
    setShortcutSaving(true);
    try {
      const status = await window.platform.setGlobalSummonShortcut(null);
      setShortcutStatus(status || null);
      setShortcutDraft(status?.accelerator || '');
    } catch (err) {
      setShortcutStatus({
        ok: false,
        accelerator: null,
        fallbackUsed: false,
        attempted: [],
        errors: { shortcut: err instanceof Error ? err.message : String(err) },
      });
    } finally {
      setShortcutSaving(false);
    }
  };

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="voice">
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>语音输入 (ASR)</h2>

        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>识别引擎</label>
          <SelectWidget
            options={ASR_PROVIDERS}
            value={asrProvider}
            onChange={(v) => setAsrProvider(v)}
          />
          <span className={styles['settings-field-hint']}>
            {asrProvider === 'spark'
              ? '实时语音会话和朗读优先走 StepFun Realtime;用户语音转写使用本地 ASR,避免把助手语音误识别成你的输入。'
              : '使用第三方 API,需填写对应的密钥。'}
          </span>
        </div>

        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>备用顺序</label>
          <span className={styles['settings-field-hint']}>
            转写顺序:Qwen3-ASR → SenseVoice → Faster Whisper。StepFun Realtime 不再作为独立 ASR 使用。
          </span>
        </div>

        {needsAsrKey && (
          <>
            <div className={styles['settings-field']}>
              <label className={styles['settings-field-label']}>API Key</label>
              <KeyInput
                value={asrKey}
                onChange={setAsrKey}
                placeholder="sk-..."
              />
            </div>
            <div className={styles['settings-field']}>
              <label className={styles['settings-field-label']}>Base URL（可选）</label>
              <input
                className={styles['settings-input']}
                type="text"
                value={asrBaseUrl}
                onChange={(e) => setAsrBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
              />
            </div>
          </>
        )}
      </section>

      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>语音合成 (TTS)</h2>

        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>合成引擎</label>
          <SelectWidget
            options={TTS_PROVIDERS}
            value={ttsProvider}
            onChange={(v) => {
              setTtsProvider(v);
              setTtsProviderPreference(v);
              setTtsVoice(defaultTtsVoice(v));
            }}
          />
        </div>

        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>默认音色</label>
          <input
            className={styles['settings-input']}
            type="text"
            value={ttsVoice}
            onChange={(e) => setTtsVoice(e.target.value)}
            placeholder={ttsProvider === 'stepfun-realtime' ? 'jingdiannvsheng' : 'zh-CN-XiaoxiaoNeural'}
          />
          <span className={styles['settings-field-hint']}>
            {ttsProvider === 'stepfun-realtime'
              ? '主链:GUI/CLI 语音输出经 Lynn Brain 托管 StepFun Realtime,无需填写 Key;失败时才依序退回 Spark/CosyVoice/系统语音。'
              : ttsProvider === 'openai'
              ? 'OpenAI TTS 使用内置音色 alloy / echo / onyx / nova'
              : '第三方 TTS 需要你自己的配置。'}
          </span>
        </div>

        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>备用顺序</label>
          <span className={styles['settings-field-hint']}>
            StepFun Realtime 不可用时才自动降级:Spark local TTS Router → CosyVoice → Edge/macOS say。备用链不再作为默认合成引擎选择。
          </span>
        </div>

        {/* P0: 自动预合成 toggle */}
        <div className={styles['settings-field']}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={ttsAutoPrefetch}
              onChange={(e) => setTtsAutoPrefetch(e.target.checked)}
            />
            <span>消息流结束后自动预合成语音(点喇叭即时播放)</span>
          </label>
          <span className={styles['settings-field-hint']}>
            开启后:每条 ≥50 字回复在 streaming 结束时后台 TTS 一次,缓存到磁盘。点喇叭命中缓存 0 等待。
            默认走 StepFun Realtime 主链;服务端 TTS 不可用时会自动退回本地/浏览器朗读。Shift+点击仍可强制即时浏览器朗读。
          </span>
        </div>

        <div className={styles['settings-field']}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={ttsStreamingEnabled}
              onChange={(e) => setTtsStreamingEnabled(e.target.checked)}
            />
            <span>优先使用流式播放(可用时更快开声)</span>
          </label>
          <span className={styles['settings-field-hint']}>
            StepFun Realtime 可用时优先边合成边播放;失败会自动回退到本地 fallback 或普通文件合成。
          </span>
        </div>

        <div className={styles['settings-field']}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={ttsBrowserFallbackEnabled}
              onChange={(e) => setTtsBrowserFallbackEnabled(e.target.checked)}
            />
            <span>允许浏览器即时朗读 fallback</span>
          </label>
          <span className={styles['settings-field-hint']}>
            完全本地、无 quota。开启后服务端 TTS 不可用会自动接管;Shift+点击可强制使用浏览器朗读。
          </span>
        </div>

        {needsTtsKey && (
          <>
            <div className={styles['settings-field']}>
              <label className={styles['settings-field-label']}>API Key</label>
              <KeyInput
                value={ttsKey}
                onChange={setTtsKey}
                placeholder="sk-..."
              />
            </div>
            <div className={styles['settings-field']}>
              <label className={styles['settings-field-label']}>Base URL（可选）</label>
              <input
                className={styles['settings-input']}
                type="text"
                value={ttsBaseUrl}
                onChange={(e) => setTtsBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
              />
            </div>
          </>
        )}
      </section>

      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>通用</h2>
        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>默认语言</label>
          <SelectWidget
            options={LANGUAGES}
            value={language}
            onChange={(v) => setLanguage(v)}
          />
        </div>
        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>Lynn 语音快捷键</label>
          <div className={styles['settings-input-group']}>
            <input
              className={styles['settings-input']}
              type="text"
              value={shortcutDraft}
              onChange={(e) => setShortcutDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void applyShortcut();
              }}
              placeholder="Command+Shift+L"
            />
            <button
              type="button"
              className={styles['settings-btn-primary']}
              onClick={applyShortcut}
              disabled={shortcutSaving}
            >
              应用
            </button>
            <button
              type="button"
              className={styles['settings-btn-primary']}
              onClick={resetShortcut}
              disabled={shortcutSaving}
            >
              默认
            </button>
          </div>
          <span className={styles['settings-field-hint']}>
            {formatShortcutStatus(shortcutStatus)}
          </span>
        </div>
      </section>

      <div className={styles['settings-actions']}>
        <button
          type="button"
          className={styles['settings-btn-primary']}
          onClick={handleSave}
        >
          保存语音设置
        </button>
      </div>
    </div>
  );
}
