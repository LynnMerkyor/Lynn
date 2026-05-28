import { useCallback, useEffect, useRef, useState } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';
import { playTtsSpeechStream } from '../../services/tts-stream-playback';
import { useStore } from '../../stores';
import styles from './Chat.module.css';

/* eslint-disable @typescript-eslint/no-explicit-any */

type TtsPlaybackController = {
  stop: () => void;
  finished: Promise<void>;
};

interface TtsControlButtonProps {
  plainText: string;
  messageId?: string | null;
  isStreamingMessage: boolean;
}

/**
 * 播放 TTS 生成的音频文件。走 IPC readFileBase64 + WebAudio 而非 HTTP — 因为:
 *  1) HTMLAudioElement 不会自动带 Bearer token,直接 audio.src = http://... 会被 server 403
 *  2) Hono c.body(fs.createReadStream) 对 Node Readable Stream 兼容性问题,Audio 解码失败
 *  3) WebAudio 直接解码 ArrayBuffer,绕开 <audio> 对 blob/data source 的兼容性差异
 */
async function playAudioHttpUrl(audioPath: string): Promise<TtsPlaybackController> {
  if (!audioPath) throw new Error('音频路径无效');
  const base64 = await window.hana?.readFileBase64?.(audioPath);
  if (!base64) throw new Error('读取音频文件失败（检查路径白名单）');

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
  if (AudioContextCtor) {
    const audioContext = new AudioContextCtor();
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
    const buffer = await audioContext.decodeAudioData(bytes.buffer.slice(0));
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    let stopped = false;
    const finished = new Promise<void>((resolve) => {
      source.onended = () => {
        void audioContext.close().catch(() => {});
        resolve();
      };
    });
    try {
      source.start(0);
    } catch (err) {
      void audioContext.close().catch(() => {});
      throw err;
    }
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try { source.stop(0); } catch { /* source may already be stopped */ }
    };
    return { stop, finished };
  }

  // Very old WebViews only: fallback to HTMLAudioElement.
  const ext = audioPath.toLowerCase().endsWith('.mp3') ? 'mpeg' : audioPath.toLowerCase().endsWith('.aiff') ? 'aiff' : 'wav';
  const blob = new Blob([bytes], { type: `audio/${ext}` });
  const objectUrl = URL.createObjectURL(blob);
  const audio = new Audio(objectUrl);
  let stopped = false;
  const cleanup = () => URL.revokeObjectURL(objectUrl);
  const finished = new Promise<void>((resolve, reject) => {
    audio.onended = () => { cleanup(); resolve(); };
    audio.onerror = () => {
      const code = audio.error?.code;
      const codeMap: Record<number, string> = { 1: 'aborted', 2: 'network', 3: 'decode', 4: 'src-not-supported' };
      cleanup();
      if (code === 1 || stopped) resolve();
      else reject(new Error(`audio error: ${codeMap[code || 0] || code}`));
    };
    audio.play().catch((err) => { cleanup(); reject(err); });
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { audio.pause(); audio.currentTime = 0; } catch { /* best-effort playback stop */ }
    cleanup();
  };
  return { stop, finished };
}

function speakViaBrowser(text: string): boolean {
  try {
    const u = new SpeechSynthesisUtterance(text);
    const isZh = /[一-鿿]/.test(text.slice(0, 100));
    u.lang = isZh ? 'zh-CN' : 'en-US';
    u.rate = 1.0;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
    return true;
  } catch (e) {
    console.warn('[tts] browser SpeechSynthesis failed:', e);
    return false;
  }
}

function messageAudioFilename(messageId?: string | null): string {
  return `msg_${messageId?.slice(-8) || Date.now()}`;
}

export function TtsControlButton({ plainText, messageId, isStreamingMessage }: TtsControlButtonProps) {
  const { t } = useI18n();
  const addToast = useStore(s => s.addToast);
  const ttsAutoPrefetch = useStore(s => s.ttsAutoPrefetch);
  const ttsStreamingEnabled = useStore(s => s.ttsStreamingEnabled);
  const ttsBrowserFallbackEnabled = useStore(s => s.ttsBrowserFallbackEnabled);
  const [ttsAudioPath, setTtsAudioPath] = useState<string | null>(null);
  const [ttsPlaying, setTtsPlaying] = useState(false);
  const ttsControllerRef = useRef<TtsPlaybackController | null>(null);
  const prefetchFiredRef = useRef(false);

  const stopTtsPlayback = useCallback(() => {
    const ctrl = ttsControllerRef.current;
    ttsControllerRef.current = null;
    setTtsPlaying(false);
    try { ctrl?.stop(); } catch { /* best-effort playback stop */ }
  }, []);

  useEffect(() => () => stopTtsPlayback(), [stopTtsPlayback]);

  useEffect(() => {
    if (isStreamingMessage) return;
    if (prefetchFiredRef.current) return;
    if (!plainText || plainText.length < 50) return;
    if (!ttsAutoPrefetch) return;
    prefetchFiredRef.current = true;
    hanaFetch('/api/tools/tts-bridge.tts_speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: plainText.slice(0, 3000),
        filename: messageAudioFilename(messageId),
      }),
      timeout: 60_000,
    })
      .then(res => res.json())
      .then(data => {
        const audioPath = data?.details?.path || data?.result?.details?.path;
        if (audioPath) setTtsAudioPath(audioPath);
      })
      .catch(() => { /* silent */ });
  }, [isStreamingMessage, plainText, messageId, ttsAutoPrefetch]);

  const handleClick = useCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    if (e.shiftKey && ttsBrowserFallbackEnabled) {
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
        addToast('已停止浏览器朗读', 'info');
        return;
      }
      const ok = speakViaBrowser(plainText.slice(0, 3000));
      if (ok) addToast('浏览器朗读中(Shift+点击停止)', 'info');
      else addToast('浏览器 TTS 不可用', 'error');
      return;
    }

    if (ttsPlaying) {
      stopTtsPlayback();
      addToast('已停止朗读', 'info');
      return;
    }

    const startPlayback = async (audioPath: string, toastText: string) => {
      const controller = await playAudioHttpUrl(audioPath);
      ttsControllerRef.current = controller;
      setTtsPlaying(true);
      addToast(toastText, 'success');
      controller.finished.finally(() => {
        if (ttsControllerRef.current === controller) {
          ttsControllerRef.current = null;
          setTtsPlaying(false);
        }
      });
    };

    const startStreamPlayback = async () => {
      const controller = await playTtsSpeechStream({
        text: plainText.slice(0, 3000),
        filename: messageAudioFilename(messageId),
      });
      ttsControllerRef.current = controller;
      setTtsPlaying(true);
      addToast('正在流式朗读 · 再按一次停止', 'success');
      controller.finished.finally(() => {
        if (ttsControllerRef.current === controller) {
          ttsControllerRef.current = null;
          setTtsPlaying(false);
        }
      });
    };

    try {
      if (ttsAudioPath) {
        try {
          await startPlayback(ttsAudioPath, '正在朗读 · 再按一次停止');
          return;
        } catch {
          setTtsAudioPath(null);
        }
      }
      if (ttsStreamingEnabled) {
        try {
          await startStreamPlayback();
          return;
        } catch (streamErr) {
          console.warn('[tts] stream playback unavailable, falling back to file TTS:', streamErr);
        }
      }
      addToast('准备朗读...', 'info');
      const res = await hanaFetch('/api/tools/tts-bridge.tts_speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: plainText.slice(0, 3000),
          filename: messageAudioFilename(messageId),
        }),
        timeout: 60_000,
      });
      const data = await res.json();
      const audioPath = data?.details?.path || data?.result?.details?.path;
      if (!audioPath) {
        addToast('TTS 返回缺失 path', 'error');
        return;
      }
      setTtsAudioPath(audioPath);
      try {
        const cached = data?.details?.cached || data?.result?.details?.cached;
        await startPlayback(audioPath, cached ? '正在朗读（已缓存）· 再按一次停止' : '正在朗读 · 再按一次停止 · 右键换音色');
      } catch (err: any) {
        addToast(`播放失败：${err?.message || err}。音频已保存，可在 Voice 设置里检查服务状态。`, 'error');
      }
    } catch (err) {
      addToast(String(err), 'error');
    }
  }, [
    addToast,
    messageId,
    plainText,
    stopTtsPlayback,
    ttsAudioPath,
    ttsBrowserFallbackEnabled,
    ttsPlaying,
    ttsStreamingEnabled,
  ]);

  return (
    <button
      className={styles.msgCopyBtn}
      onClick={handleClick}
      title={ttsPlaying ? '停止朗读' : (t('chat.speak') || '朗读 · Shift+点击=即时浏览器朗读 · 右键音色设置')}
      aria-label={ttsPlaying ? '停止朗读' : (t('chat.speak') || '朗读')}
      aria-pressed={ttsPlaying}
      onContextMenu={(e) => {
        e.preventDefault();
        window.hana?.openSettings?.('voice');
      }}
    >
      {ttsPlaying ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <rect x="6" y="6" width="12" height="12" rx="1.5" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          <path d="M19 5a9 9 0 0 1 0 14" />
        </svg>
      )}
    </button>
  );
}
