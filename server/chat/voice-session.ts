import fs from "fs";
import { debugLog } from "../../lib/debug-log.js";
import { createASRFallbackProvider } from "../clients/asr/index.js";
import { createSERProvider } from "../clients/ser/index.js";
import { createTTSFallbackProvider } from "../clients/tts/index.js";
import { enrichHealthWithTier } from "./voice-fallback-orchestrator.js";
import { aecAvailable as defaultAecAvailable, createAecProcessor as defaultCreateAecProcessor, aecProcessRender as defaultAecRender, aecProcessCapture as defaultAecCapture } from "../clients/aec/index.js";
import {
  PCM_SAMPLE_RATE,
  chunkBuffer,
  makeFrame,
  makeJsonFrame,
  makeStateFrame,
  makeTranscriptFrame,
  normalizeTtsAudioToPcm16Mono16k,
  pcm16Rms,
  pcm16ToWav,
} from "./voice-audio-codec.js";
import { AEC_SAMPLES_PER_FRAME, TtsReferenceQueue, aecProcessFrame100ms } from "./voice-aec.js";
import {
  asEmotion,
  asRecord,
  asTtsPiece,
  defaultBrainRunner,
  errorMessage,
  errorName,
  extractEmotionSegment,
  isSemanticTranscript,
  normalizeVadConfig,
  normalizeVoiceTranscript,
  providerHealthStatus,
  resolveVoiceRuntimeAsrConfig,
  resolveVoiceRuntimeTtsConfig,
  splitTextForTts,
  TTS_RETRY_MIN_SEGMENT_CHARS,
  TTS_SEGMENT_TIMEOUT_MS,
  waitForCurrentTurnEmotion,
} from "./voice-session-utils.js";
import { FRAME, STATE } from "./voice-ws-types.js";
import type { VoiceHealthPayload, VoiceProviderHealth } from "./voice-fallback-orchestrator.js";
import type {
  AecCapture,
  AecProcessorHandle,
  AecRender,
  AsrProvider,
  BrainRunner,
  CurrentReplyPlayed,
  EmotionResult,
  ErleRecord,
  JsonRecord,
  PendingInterruptedReply,
  SaveInterruptedTurn,
  SerProvider,
  TtsProvider,
  TtsStreamError,
  VadConfig,
  VoiceEngine,
  VoiceFrame,
  VoiceSessionDeps,
  VoiceSocket,
  VoiceState,
} from "./voice-ws-types.js";

export class VoiceSession {
  ws: VoiceSocket;
  engine: VoiceEngine;
  hub: unknown;
  asrProvider: AsrProvider;
  serProvider: SerProvider;
  ttsProvider: TtsProvider;
  brainRunner: BrainRunner;
  saveInterruptedTurn: SaveInterruptedTurn | null;
  mode: "chat" | "direct";
  healthOnOpen: boolean;
  state: VoiceState;
  outSeq: number;
  lastInSeq: number;
  utteranceBuffer: Buffer[];
  totalBufferedSamples: number;
  maxBufferedSamples: number;
  transcriptPartial: string;
  startTs: number;
  pcmFramesIn: number;
  bytesIn: number;
  bytesOut: number;
  processingTurn: Promise<unknown> | null;
  turnAbort: AbortController | null;
  turnGeneration: number;
  pendingInterruptedReply: PendingInterruptedReply | null;
  currentReplyPlayed: CurrentReplyPlayed | null;
  activeSpeakingQueue: string[] | null;
  pendingAppendQueue: string[];
  aecProcessor: AecProcessorHandle | null;
  aecRender: AecRender;
  aecCapture: AecCapture;
  referenceQueue: TtsReferenceQueue;
  aecReferenceTrimSamples: number;
  vadConfig: VadConfig;
  vadSpeechFrames: number;
  vadSilenceFrames: number;
  vadArmed: boolean;
  erleRecord: ErleRecord | null;

  constructor(ws: VoiceSocket, {
    engine,
    hub,
    asrProvider,
    serProvider,
    ttsProvider,
    brainRunner,
    healthOnOpen = true,
    vadConfig = {},
    mode = "direct",
    saveInterruptedTurn = null,
    aec = null,
  }: VoiceSessionDeps) {
    this.ws = ws;
    this.engine = engine;
    this.hub = hub;
    const voiceConfig = engine?.config?.voice || {};
    this.asrProvider = (asrProvider || createASRFallbackProvider(resolveVoiceRuntimeAsrConfig(voiceConfig.asr || {}, voiceConfig as JsonRecord))) as AsrProvider;
    this.serProvider = (serProvider || createSERProvider(voiceConfig.ser || {})) as SerProvider;
    this.ttsProvider = (ttsProvider || createTTSFallbackProvider(resolveVoiceRuntimeTtsConfig(voiceConfig.tts || {}, voiceConfig as JsonRecord))) as TtsProvider;
    this.brainRunner = brainRunner || defaultBrainRunner;
    this.saveInterruptedTurn = saveInterruptedTurn; // DS 反馈 #3 T2 阶段的可注入钩子
    this.mode = mode === "chat" ? "chat" : "direct";
    this.healthOnOpen = healthOnOpen;
    this.state = STATE.IDLE;
    this.outSeq = 0;
    this.lastInSeq = -1;
    this.utteranceBuffer = []; // 累积当前 utterance 的 PCM (Int16Array[])
    this.totalBufferedSamples = 0;
    this.maxBufferedSamples = 16000 * 30; // 30s 上限
    this.transcriptPartial = "";
    this.startTs = Date.now();
    this.pcmFramesIn = 0;
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.processingTurn = null;
    this.turnAbort = null;
    this.turnGeneration = 0;
    // DS V4 Pro 反馈 #3 — 打断 T1/T2 状态机:
    //   T1 (onInterrupt):截断 TTS/Brain,把已播放 segments 暂存到 pendingInterruptedReply
    //   T2 (processTurn 内 ASR final 后):
    //     有意义 transcript  → 保存已播放部分到历史 interrupted: true
    //     咳嗽/拟声/笑声     → 回滚,pendingInterruptedReply 直接丢弃(不污染上下文)
    this.pendingInterruptedReply = null;
    this.currentReplyPlayed = null; // 当前 TTS 正在播放的已完成 segments 文本
    // 2026-05-01 P0-① 增量 TTS:speakText 进入循环时设此引用,SPEAK_TEXT_APPEND 帧
    // 直接 push 进同一个 queue,无需新建 turn / 不抢锁。退出 speakText 时清 null。
    this.activeSpeakingQueue = null;
    // 2026-05-01 P0-① B2 race fix:client 后续 SPEAK_TEXT_APPEND 在 server 刚消费
    // 完 activeSpeakingQueue 但还没退到 IDLE 的"间隙"窗口到达时,不被丢/不被锁吞。
    // appendSpeakText 在 SPEAKING 期间 activeSpeakingQueue=null/空 时改 push 到这里;
    // speakText 退出 while 前 grace period 检查这个 queue;若有则继续消费。
    this.pendingAppendQueue = [];

    // 2026-05-01 P1-① — 服务端 AEC pipeline:
    //   * aec.available + native processor 创建成功 → 启用,reference signal 在 send PCM_TTS
    //     时 push,onAudio 时取等长 reference 喂 processRender + processCapture
    //   * 不可用(平台无 prebuilt / 加载失败 / 创建抛错)→ 退化为 mic 直传(等同现状)
    //   * deps 注入:测试用 mock createProcessor / processRender / processCapture
    const aecDeps = aec || null;
    const aecCreate = aecDeps?.createProcessor || (defaultAecAvailable ? defaultCreateAecProcessor : null);
    if (aecCreate) {
      try {
        this.aecProcessor = aecCreate({ sampleRate: PCM_SAMPLE_RATE, enableNs: true }) || null;
      } catch (err) {
        this.aecProcessor = null;
        debugLog()?.warn("voice-ws", `aec processor init failed: ${errorMessage(err)}`);
      }
    } else {
      this.aecProcessor = null;
    }
    this.aecRender = aecDeps?.processRender || defaultAecRender as AecRender;
    this.aecCapture = aecDeps?.processCapture || defaultAecCapture as AecCapture;
    this.referenceQueue = new TtsReferenceQueue();
    // 2026-05-01 修 1 — reference vs mic 时序校准,默认 0(信 WebRTC estimator
    // 自学习 delay);环境抖动严重 ERLE < 15dB 时设 60-100 即可。负值 / NaN → 退 0。
    const trimMs = Number(process.env.LYNN_AEC_REFERENCE_TRIM_MS);
    this.aecReferenceTrimSamples = (Number.isFinite(trimMs) && trimMs > 0)
      ? Math.round(trimMs * PCM_SAMPLE_RATE / 1000)
      : 0;
    this.vadConfig = normalizeVadConfig(vadConfig);
    this.vadSpeechFrames = 0;
    this.vadSilenceFrames = 0;
    this.vadArmed = false;

    // ERLE debug 双轨录制(Phase 2 Spike 5 用):
    //   设 LYNN_ERLE_RECORD_DIR=/path/to/dir 即启用
    //   session 结束(或 onClose)时产出 <session-id>-mic.wav + <session-id>-tts.wav
    //   时间对齐:同一 AudioContext 时序,不需额外 sync
    const erleDir = process.env.LYNN_ERLE_RECORD_DIR;
    this.erleRecord = erleDir ? {
      dir: erleDir,
      sessionId: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      micChunks: [], // Buffer[]
      ttsChunks: [], // Buffer[]
      startTs: Date.now(),
    } : null;
  }

  setState(state: VoiceState): void {
    if (this.state === state) return;
    this.state = state;
    this.send(makeStateFrame(this.outSeq++, state));
    debugLog()?.log("voice-ws", `state → ${state}`);
  }

  send(buf: Buffer): void {
    if (this.ws.readyState !== 1) return;
    this.ws.send(buf);
    this.bytesOut += buf.length;
  }

  async checkHealth(): Promise<boolean> {
    const [asr, ser, tts] = await Promise.all([
      providerHealthStatus(this.asrProvider),
      providerHealthStatus(this.serProvider),
      providerHealthStatus(this.ttsProvider),
    ]);
    // SER is an optional side chain: emotion failure must not block the voice
    // turn or make Lynn look degraded when ASR/TTS are healthy.
    const ok = asr.ok && tts.ok;
    const rawHealth: VoiceHealthPayload = {
      ok,
      degraded: !ok || asr.degraded || tts.degraded,
      providers: {
        asr: asr as unknown as VoiceProviderHealth,
        ser: ser as unknown as VoiceProviderHealth,
        tts: tts as unknown as VoiceProviderHealth,
      },
    };
    // DS V4 Pro 反馈 #5 · Phase 2.5 降级编排:附加 tier + Orb 颜色 + 文案
    const health = enrichHealthWithTier(rawHealth);
    this.send(makeJsonFrame(FRAME.HEALTH_STATUS, this.outSeq++, health));
    if (!ok) {
      // Health probes can race with an active turn. In particular, CosyVoice
      // may be busy synthesizing while the on-open health check is still
      // pending; don't let that late probe visually interrupt a valid
      // speaking/thinking state. The explicit HEALTH_STATUS frame still carries
      // the degraded detail for diagnostics.
      if (this.state !== STATE.SPEAKING && this.state !== STATE.THINKING) {
        this.setState(STATE.DEGRADED);
      }
      debugLog()?.warn("voice-ws", `provider health degraded · tier=${health?.tier ?? "?"} asr=${asr.ok}/${asr.fallbackOk} ser=${ser.ok}/${ser.fallbackOk} tts=${tts.ok}/${tts.fallbackOk}`);
    }
    return ok;
  }

  onOpen(): void {
    if (this.healthOnOpen) {
      void this.checkHealth();
      void this.serProvider?.warmup?.();
    }
  }

  async onAudio(frame: VoiceFrame): Promise<void> {
    // 计 seq 顺序
    const expectedSeq = (this.lastInSeq + 1) & 0xffff;
    if (this.lastInSeq !== -1 && frame.seq !== expectedSeq) {
      debugLog()?.log("voice-ws", `seq out of order: expected ${expectedSeq}, got ${frame.seq}`);
    }
    this.lastInSeq = frame.seq;
    this.pcmFramesIn++;
    this.bytesIn += frame.payload.length;

    // Phase 2B:client-side Silero/TEN 未接入前,server 侧先做保守 energy VAD 兜底。
    if (this.state === STATE.IDLE || this.state === STATE.DEGRADED) {
      this.setState(STATE.LISTENING);
    }

    // 2026-05-01 P1-① — server 侧 AEC:取等长 reference(PCM_TTS 已 push),
    // 跑 processRender + processCapture 清 echo,再走后续 buffer / VAD / ERLE。
    let micPayload = frame.payload;
    if (this.aecProcessor && frame.payload.length > 0 && frame.payload.length % (AEC_SAMPLES_PER_FRAME * 2) === 0) {
      const sampleCount = frame.payload.length / 2;
      const referenceBuf = this.referenceQueue.take(sampleCount, this.aecReferenceTrimSamples);
      micPayload = aecProcessFrame100ms(this.aecProcessor, frame.payload, referenceBuf, {
        processRender: this.aecRender,
        processCapture: this.aecCapture,
      });
    }

    // Buffer 累积
    if (this.totalBufferedSamples < this.maxBufferedSamples) {
      this.utteranceBuffer.push(micPayload);
      this.totalBufferedSamples += micPayload.length / 2; // Int16 = 2 bytes/sample
    } else {
      // 30s 上限,强制 EOT
      void this.endOfTurn();
      return;
    }

    // ERLE 双轨:mic 入侧即录(AEC 后的 cleaned PCM,合 doc spike/05 README 期望)
    if (this.erleRecord) {
      this.erleRecord.micChunks.push(Buffer.from(micPayload));
    }

    this.updateEnergyVad(micPayload);
  }

  updateEnergyVad(pcmPayload: Buffer): void {
    const cfg = this.vadConfig;
    if (!cfg.enabled || this.processingTurn || this.state !== STATE.LISTENING) return;

    const rms = pcm16Rms(pcmPayload);
    if (rms >= cfg.speechRms) {
      this.vadSpeechFrames += 1;
      this.vadSilenceFrames = 0;
      if (this.vadSpeechFrames >= cfg.minSpeechFrames) {
        this.vadArmed = true;
      }
      return;
    }

    if (!this.vadArmed) return;
    if (rms <= cfg.silenceRms) {
      this.vadSilenceFrames += 1;
    } else {
      this.vadSilenceFrames = 0;
    }

    if (this.vadSilenceFrames >= cfg.endSilenceFrames) {
      debugLog()?.log("voice-ws", `energy VAD auto end-of-turn rms=${rms.toFixed(4)}`);
      void this.endOfTurn();
    }
  }

  async endOfTurn(): Promise<unknown> {
    if (this.processingTurn) return this.processingTurn;
    if (this.state === STATE.IDLE) return;
    if (this.utteranceBuffer.length === 0) {
      this.setState(STATE.IDLE);
      return;
    }

    const combinedPcm = Buffer.concat(this.utteranceBuffer);
    const wavAudio = pcm16ToWav(combinedPcm);
    this.utteranceBuffer = [];
    this.totalBufferedSamples = 0;
    this.resetVad();

    const generation = ++this.turnGeneration;
    this.processingTurn = this.processTurn(wavAudio)
      .catch((err) => {
        if (this.isStaleTurn(generation) || this.isIntentionalAbort(err)) {
          debugLog()?.log("voice-ws", `turn aborted: ${errorMessage(err, "stale turn")}`);
          return;
        }
        debugLog()?.error("voice-ws", `turn failed: ${errorMessage(err)}`);
        this.send(makeTranscriptFrame(FRAME.TRANSCRIPT_FINAL, this.outSeq++, ""));
        this.setState(STATE.DEGRADED);
      })
      .finally(() => {
        if (!this.isStaleTurn(generation)) {
          this.turnAbort = null;
          this.processingTurn = null;
        }
      });
    return this.processingTurn;
  }

  async processTurn(wavAudio: Buffer): Promise<void> {
    this.turnAbort = new AbortController();
    const signal = this.turnAbort.signal;

    await this.checkHealth();
    if (signal?.aborted) return;

    this.setState(STATE.THINKING);

    // 方案 C 微交互(2026-05-01 决策):因为 final ASR 需要整段等收敛(~0.8-1.2s),
    // 用户会感到"说完一拍停顿"。立刻推一个 PARTIAL "理解中…" 让 Overlay 能显,
    // 这是零成本心理补偿。Overlay 看到 partial 会显示为灰色占位,收到 final 时替换。
    this.send(makeTranscriptFrame(FRAME.TRANSCRIPT_PARTIAL, this.outSeq++, "理解中…"));

    const emotionPromise = this.serProvider?.classify
      ? Promise.resolve(this.serProvider.classify(extractEmotionSegment(wavAudio), { filename: "voice.wav" }))
        .then((emotion: unknown) => {
          const normalizedEmotion = asEmotion(emotion);
          if (!signal.aborted) this.send(makeJsonFrame(FRAME.EMOTION, this.outSeq++, normalizedEmotion));
          return normalizedEmotion;
        })
        .catch((err: unknown) => {
          debugLog()?.warn("voice-ws", `emotion classify failed: ${errorMessage(err)}`);
          return null;
        })
      : Promise.resolve(null);

    const asrResult = await this.asrProvider.transcribe(wavAudio, { language: "zh", filename: "voice.wav" });
    if (signal?.aborted) return;
    if (asrResult?.fallbackUsed) {
      this.setState(STATE.DEGRADED);
      debugLog()?.warn("voice-ws", `asr fallback used: ${asrResult.primaryError || "primary failed"}`);
    }
    const transcript = normalizeVoiceTranscript(asrResult?.text);
    this.send(makeTranscriptFrame(FRAME.TRANSCRIPT_FINAL, this.outSeq++, transcript));

    // DS V4 Pro 反馈 #3 · T2 阶段:根据 transcript 语义决定被打断 AI 回复的归宿
    await this.resolveInterruptedReply(transcript);

    if (this.mode === "chat") {
      this.setState(STATE.IDLE);
      return;
    }
    const currentTurnEmotion = await waitForCurrentTurnEmotion(emotionPromise);

    await this.respondToTranscript(transcript, { emotion: currentTurnEmotion, signal });
  }

  /**
   * T2 阶段核心:
   *   pendingInterruptedReply 存在 →
   *     transcript 有意义       → 保存(interrupted: true)到对话历史
   *     transcript 咳嗽/无意义  → 回滚丢弃,不污染上下文
   *   pendingInterruptedReply 不存在 → no-op
   */
  async resolveInterruptedReply(transcript: string): Promise<void> {
    const pending = this.pendingInterruptedReply;
    if (!pending) return;
    this.pendingInterruptedReply = null;
    if (!isSemanticTranscript(transcript)) {
      debugLog()?.log("voice-ws", `T2 rollback: interrupted reply discarded (non-semantic transcript: ${JSON.stringify(transcript)})`);
      return;
    }
    if (typeof this.saveInterruptedTurn !== "function") {
      // engine 未注入钩子不是致命错误,只记日志
      debugLog()?.log("voice-ws", `T2 pending: saveInterruptedTurn hook absent, reply not persisted (text len=${pending.text.length})`);
      return;
    }
    try {
      await this.saveInterruptedTurn({
        text: pending.text,
        interrupted: true,
        segmentsPlayed: pending.segmentsPlayed,
        totalSegments: pending.totalSegments,
        startedAt: pending.startedAt,
        interruptedAt: pending.interruptedAt,
        engine: this.engine,
      });
      debugLog()?.log("voice-ws", `T2 saved: interrupted reply persisted (played ${pending.segmentsPlayed}/${pending.totalSegments})`);
    } catch (err) {
      debugLog()?.warn("voice-ws", `T2 save failed: ${errorMessage(err)}`);
    }
  }

  async processTextTurn(text: unknown): Promise<unknown> {
    if (this.processingTurn) return this.processingTurn;
    const transcript = normalizeVoiceTranscript(text);
    if (!transcript) {
      this.setState(STATE.IDLE);
      return;
    }
    const generation = ++this.turnGeneration;
    this.processingTurn = this.processDirectTranscript(transcript)
      .catch((err) => {
        if (this.isStaleTurn(generation) || this.isIntentionalAbort(err)) {
          debugLog()?.log("voice-ws", `text turn aborted: ${errorMessage(err, "stale turn")}`);
          return;
        }
        debugLog()?.error("voice-ws", `text turn failed: ${errorMessage(err)}`);
        this.setState(STATE.DEGRADED);
      })
      .finally(() => {
        if (!this.isStaleTurn(generation)) {
          this.turnAbort = null;
          this.processingTurn = null;
        }
      });
    return this.processingTurn;
  }

  async processDirectTranscript(transcript: string): Promise<void> {
    this.turnAbort = new AbortController();
    const signal = this.turnAbort.signal;
    await this.checkHealth();
    if (signal?.aborted) return;
    this.setState(STATE.THINKING);
    this.send(makeTranscriptFrame(FRAME.TRANSCRIPT_FINAL, this.outSeq++, transcript));
    if (this.mode === "chat") {
      this.setState(STATE.IDLE);
      return;
    }
    await this.respondToTranscript(transcript, { emotion: null, signal });
  }

  async processSpeakTextTurn(text: unknown): Promise<unknown> {
    if (this.processingTurn) return this.processingTurn;
    const value = String(text || "").trim();
    if (!value) {
      this.setState(STATE.IDLE);
      return;
    }
    const generation = ++this.turnGeneration;
    this.turnAbort = new AbortController();
    const signal = this.turnAbort.signal;
    this.processingTurn = this.speakText(value, { signal, emitAssistantReply: true })
      .catch((err) => {
        if (this.isStaleTurn(generation) || this.isIntentionalAbort(err)) {
          debugLog()?.log("voice-ws", `speak text aborted: ${errorMessage(err, "stale turn")}`);
          return;
        }
        debugLog()?.error("voice-ws", `speak text failed: ${errorMessage(err)}`);
        this.setState(STATE.DEGRADED);
      })
      .finally(() => {
        if (!this.isStaleTurn(generation)) {
          this.turnAbort = null;
          this.processingTurn = null;
        }
      });
    return this.processingTurn;
  }

  async respondToTranscript(
    transcript: string,
    { emotion = null, signal }: { emotion?: EmotionResult | null; signal?: AbortSignal } = {},
  ): Promise<void> {
    if (!transcript) {
      this.setState(STATE.IDLE);
      return;
    }
    const replyText = String(await this.brainRunner({
      transcript,
      emotion,
      engine: this.engine,
      hub: this.hub,
      signal,
    }) || "").trim();
    if (signal?.aborted) return;
    const segments = splitTextForTts(replyText);
    if (segments.length === 0) {
      this.setState(STATE.IDLE);
      return;
    }
    await this.speakText(replyText, { signal, emitAssistantReply: true });
  }

  async speakText(
    text: unknown,
    { signal, emitAssistantReply = true }: { signal?: AbortSignal; emitAssistantReply?: boolean } = {},
  ): Promise<void> {
    const replyText = String(text || "").trim();
    if (!replyText) {
      this.setState(STATE.IDLE);
      return;
    }
    const segments = splitTextForTts(replyText);
    if (segments.length === 0) {
      this.setState(STATE.IDLE);
      return;
    }
    if (emitAssistantReply) this.send(makeTranscriptFrame(FRAME.ASSISTANT_REPLY, this.outSeq++, replyText));
    this.setState(STATE.SPEAKING);
    // DS 反馈 #3 · 追踪已播放进度,onInterrupt T1 时快照
    this.currentReplyPlayed = {
      fullText: replyText,
      segments: [...segments],
      playedSegments: [],
      startedAt: Date.now(),
    };
    // 2026-05-01 P0-① queue 化:while 循环消费 this.activeSpeakingQueue,
    // SPEAK_TEXT_APPEND 帧可在循环执行中往 queue 末尾 push 新 segment。
    // B2 race fix(2026-05-01):若 pendingAppendQueue 有早到的 segments(本来就为
    // SPEAKING 中"queue 刚空但 finally 还没跑"窗口设),merge 进 active。
    this.activeSpeakingQueue = [...segments];
    if (this.pendingAppendQueue.length > 0) {
      this.activeSpeakingQueue.push(...this.pendingAppendQueue);
      this.pendingAppendQueue = [];
    }
    // 2026-05-01 P0-② TTS 流式:provider 暴露 synthesizeStream 时优先用,首 PCM
    // 不等整段 WAV 渲染完,首音节延迟 ~400-1200ms → ~200-300ms。
    const supportsStream = typeof this.ttsProvider.synthesizeStream === "function";
    try {
      while (true) {
        if (signal?.aborted) break;
        // 优先消费 active queue
        if (this.activeSpeakingQueue.length > 0) {
          const segment = this.activeSpeakingQueue.shift();
          if (!segment) continue;
          await this.processSpeakingSegment(segment, signal, supportsStream);
          continue;
        }
        // active 空 → grace period 等 client SPEAK_TEXT_APPEND(B2 race fix)。
        // appendSpeakText 在 SPEAKING + queue truthy 时 push 进 active;
        // 在 processingTurn 仍非 null 但 queue 空/null 时 push 进 pendingAppendQueue。
        // grace 后两条都要检查。
        const graceMs = Number(process.env.LYNN_VOICE_APPEND_GRACE_MS) || 150;
        await new Promise((r) => setTimeout(r, graceMs));
        if (signal?.aborted) break;
        if (this.pendingAppendQueue.length > 0) {
          this.activeSpeakingQueue.push(...this.pendingAppendQueue);
          this.pendingAppendQueue = [];
          continue;
        }
        if (this.activeSpeakingQueue.length > 0) continue; // grace 期间有人 push 进了 active
        break; // 真空了
      }
    } finally {
      this.activeSpeakingQueue = null;
    }
    if (!signal?.aborted) {
      // 正常播完 → 清空跟踪,不触发 T2
      this.currentReplyPlayed = null;
      this.setState(STATE.IDLE);
    }
  }

  async processSpeakingSegment(segment: string, signal: AbortSignal | undefined, supportsStream: boolean): Promise<void> {
    try {
      if (supportsStream) {
        await this.streamSegmentToPcm(segment, signal);
      } else {
        await this.batchSegmentToPcm(segment, signal);
      }
    } catch (err) {
      // 2026-05-01 修 3:stream 路径已 yield 部分 PCM 后失败 → 不切小重试
      if (asRecord(err)?.yieldedAny) {
        this.setState(STATE.DEGRADED);
        debugLog()?.warn("voice-ws", `tts stream failed mid-segment after yielding PCM, no retry: ${errorMessage(err)}`);
        throw err;
      }
      const smallerMax = Math.max(TTS_RETRY_MIN_SEGMENT_CHARS, Math.ceil(segment.length / 2));
      const smaller = segment.length > TTS_RETRY_MIN_SEGMENT_CHARS
        ? splitTextForTts(segment, { maxChars: smallerMax }).filter((s) => s && s !== segment)
        : [];
      if (smaller.length > 1) {
        debugLog()?.warn("voice-ws", `tts segment failed, retrying as ${smaller.length} smaller chunks: ${errorMessage(err)}`);
        this.activeSpeakingQueue?.unshift(...smaller);
        return;
      }
      throw err;
    }
    if (!signal?.aborted && this.currentReplyPlayed) {
      this.currentReplyPlayed.playedSegments.push(segment);
    }
  }

  /**
   * 2026-05-01 — 推一个 100ms TTS PCM chunk 到客户端,同时:
   *   ① ERLE 双轨录 ttsChunks
   *   ② P1-① reference queue push(供 onAudio 时 AEC processRender 用)
   */
  emitTtsPcmChunk(chunk: Buffer): void {
    this.send(makeFrame(FRAME.PCM_TTS, 0, this.outSeq++, chunk));
    if (this.erleRecord) {
      this.erleRecord.ttsChunks.push(Buffer.from(chunk));
    }
    if (this.aecProcessor && this.referenceQueue) {
      this.referenceQueue.push(chunk);
    }
  }

  async streamSegmentToPcm(segment: string, signal?: AbortSignal): Promise<void> {
    let yieldedAny = false;
    let degradedFlagged = false;
    try {
      const stream = this.ttsProvider.synthesizeStream;
      if (!stream) return;
      for await (const piece of stream.call(this.ttsProvider, segment, {
        speed: 1.0,
        signal,
        timeoutMs: TTS_SEGMENT_TIMEOUT_MS,
      })) {
        if (signal?.aborted) break;
        // 2026-05-01 修 2:fallback wrapper 在 primary 流式 yield 几段后才挂 → fallback
        // synthesize 整段当第 N+1 个 chunk yield(`fallbackUsed: true`)。旧逻辑只在 firstChunk
        // 检测,会漏触发 DEGRADED。改成"任意 chunk 出现 fallbackUsed 就触发,只一次"。
        if (!degradedFlagged && piece?.fallbackUsed) {
          this.setState(STATE.DEGRADED);
          degradedFlagged = true;
          debugLog()?.warn("voice-ws", `tts stream fallback used: ${piece.primaryError || "primary failed"}`);
        }
        const audio = piece?.audio || piece?.audioBuffer || piece?.buffer
          || (piece?.path ? fs.readFileSync(piece.path) : null);
        if (!audio) continue;
        const pcm = normalizeTtsAudioToPcm16Mono16k(audio);
        for (const chunk of chunkBuffer(pcm)) {
          if (signal?.aborted) break;
          this.emitTtsPcmChunk(chunk);
          yieldedAny = true;
        }
      }
    } catch (err) {
      // 2026-05-01 修 3:stream 中途失败时已 yield PCM 不能撤回,切小重试会让用户
      // 重听段落;打 yieldedAny 标记给 caller,caller 决定是否切小重试。
      const wrapped: TtsStreamError = err instanceof Error ? err : new Error(String(err));
      wrapped.yieldedAny = yieldedAny;
      throw wrapped;
    }
  }

  /**
   * 旧 batch 路径(provider 不支持 stream 时):整段 synthesize → 切 PCM 一次性推
   */
  async batchSegmentToPcm(segment: string, signal?: AbortSignal): Promise<void> {
    const speech = asTtsPiece(await this.ttsProvider.synthesize(segment, {
      speed: 1.0,
      signal,
      timeoutMs: TTS_SEGMENT_TIMEOUT_MS,
    }));
    if (speech?.fallbackUsed) {
      this.setState(STATE.DEGRADED);
      debugLog()?.warn("voice-ws", `tts fallback used: ${speech.primaryError || "primary failed"}`);
    }
    const audio = speech?.audio || speech?.audioBuffer || speech?.buffer
      || (speech?.path ? fs.readFileSync(speech.path) : null);
    const pcm = normalizeTtsAudioToPcm16Mono16k(audio);
    for (const chunk of chunkBuffer(pcm)) {
      if (signal?.aborted) break;
      this.emitTtsPcmChunk(chunk);
    }
  }

  /**
   * 2026-05-01 P0-① — 增量 TTS append
   *
   * 状态机决策(B2 race fix 2026-05-01):
   *   SPEAKING + activeSpeakingQueue 存在 → push 进 active(主路径)
   *   SPEAKING + 处理中(processingTurn 非空)即使 activeSpeakingQueue 还没创建
   *     /已被 finally 清 null → push 到 pendingAppendQueue,speakText 的 grace
   *     period 会取走;避免被 fresh processSpeakTextTurn 锁吞。
   *   LISTENING / DEGRADED → drop。LISTENING 表示用户已开口(onInterrupt 后),
   *     残段不该让 server 重新发声压过用户输入。
   *   IDLE 且无 processingTurn → fresh speakText(兼容旧路径)。
   */
  appendSpeakText(text: unknown): void {
    const value = String(text || "").trim();
    if (!value) return;
    const segments = splitTextForTts(value);
    if (segments.length === 0) return;
    // 主路径:active queue 存在
    if (this.activeSpeakingQueue && this.state === STATE.SPEAKING) {
      this.activeSpeakingQueue.push(...segments);
      if (this.currentReplyPlayed) {
        this.currentReplyPlayed.segments.push(...segments);
        this.currentReplyPlayed.fullText = `${this.currentReplyPlayed.fullText || ""}${value}`;
      }
      debugLog()?.log("voice-ws", `append speak text: +${segments.length} segments (queue=${this.activeSpeakingQueue.length})`);
      return;
    }
    // 用户已开口 / 主链异常,残段不该播
    if (this.state === STATE.LISTENING || this.state === STATE.DEGRADED) {
      debugLog()?.log("voice-ws", `append speak text dropped (state=${this.state}): residual after interrupt/degraded`);
      return;
    }
    // B2 race window:processingTurn 仍在(可能 SPEAKING 间隙 / IDLE 但 finally 还没跑完)
    // → push 到 pendingAppendQueue,speakText grace period 接收。
    if (this.processingTurn) {
      this.pendingAppendQueue.push(...segments);
      if (this.currentReplyPlayed) {
        this.currentReplyPlayed.segments.push(...segments);
        this.currentReplyPlayed.fullText = `${this.currentReplyPlayed.fullText || ""}${value}`;
      }
      debugLog()?.log("voice-ws", `append speak text → pending (race window, +${segments.length}, pending=${this.pendingAppendQueue.length})`);
      return;
    }
    // 真正 IDLE → fresh speakText
    void this.processSpeakTextTurn(value);
  }

  onPing(frame: VoiceFrame): void {
    // 原 payload 直接回(含 client_send_ts,client 计算 RTT)
    this.send(makeFrame(FRAME.PONG, 0, frame.seq, frame.payload));
  }

  /**
   * DS V4 Pro 反馈 #3 · T1 阶段(VAD 检测到用户开口):
   *   仅执行截断 + 快照已播放部分到 pendingInterruptedReply
   *   不写对话历史 — 等 ASR final 后由 resolveInterruptedReply 决策
   */
  onInterrupt(): void {
    if (this.state === STATE.SPEAKING || this.state === STATE.THINKING) {
      // 快照已播放 segments(仅 SPEAKING 态有意义;THINKING 态 currentReplyPlayed=null)
      if (this.currentReplyPlayed && Array.isArray(this.currentReplyPlayed.playedSegments) && this.currentReplyPlayed.playedSegments.length > 0) {
        const played = this.currentReplyPlayed;
        this.pendingInterruptedReply = {
          text: played.playedSegments.join(""),
          segmentsPlayed: played.playedSegments.length,
          totalSegments: Array.isArray(played.segments) ? played.segments.length : played.playedSegments.length,
          startedAt: played.startedAt,
          interruptedAt: Date.now(),
        };
        debugLog()?.log("voice-ws", `T1 snapshot: interrupted at ${played.playedSegments.length}/${Array.isArray(played.segments) ? played.segments.length : "?"} segments`);
      }
      this.currentReplyPlayed = null;
      this.turnGeneration += 1;
      this.turnAbort?.abort();
      this.turnAbort = null;
      this.processingTurn = null;
      this.utteranceBuffer = [];
      this.totalBufferedSamples = 0;
      this.resetVad();
      debugLog()?.log("voice-ws", "interrupt received");
      this.setState(STATE.LISTENING);
    }
  }

  isStaleTurn(generation: number): boolean {
    return generation !== this.turnGeneration;
  }

  isIntentionalAbort(err: unknown): boolean {
    return errorName(err) === "AbortError";
  }

  resetVad(): void {
    this.vadSpeechFrames = 0;
    this.vadSilenceFrames = 0;
    this.vadArmed = false;
  }

  onClose(): void {
    const elapsed = (Date.now() - this.startTs) / 1000;
    debugLog()?.log("voice-ws",
      `session closed after ${elapsed.toFixed(1)}s, ` +
      `pcm_frames_in=${this.pcmFramesIn} bytes_in/out=${this.bytesIn}/${this.bytesOut}`,
    );
    // ERLE 双轨:session 结束落盘 mic.wav + tts.wav
    if (this.erleRecord) {
      try {
        if (!fs.existsSync(this.erleRecord.dir)) {
          fs.mkdirSync(this.erleRecord.dir, { recursive: true });
        }
        const micPath = `${this.erleRecord.dir}/${this.erleRecord.sessionId}-mic.wav`;
        const ttsPath = `${this.erleRecord.dir}/${this.erleRecord.sessionId}-tts.wav`;
        const micPcm = Buffer.concat(this.erleRecord.micChunks);
        const ttsPcm = Buffer.concat(this.erleRecord.ttsChunks);
        if (micPcm.length) fs.writeFileSync(micPath, pcm16ToWav(micPcm));
        if (ttsPcm.length) fs.writeFileSync(ttsPath, pcm16ToWav(ttsPcm));
        debugLog()?.log("voice-ws",
          `ERLE recorded: mic ${(micPcm.length / 32000).toFixed(1)}s → ${micPath}, ` +
          `tts ${(ttsPcm.length / 32000).toFixed(1)}s → ${ttsPath}`,
        );
      } catch (err) {
        debugLog()?.warn("voice-ws", `ERLE record write failed: ${errorMessage(err)}`);
      }
    }
  }
}
