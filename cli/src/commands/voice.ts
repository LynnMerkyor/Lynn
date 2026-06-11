import { getStringFlag, hasFlag, type ParsedArgs } from "../args.js";
import { nowIso, writeJsonLine } from "../jsonl.js";
import { runPrompt } from "./prompt.js";
import { stripVoiceFlags, synthesizeVoiceOutput, transcribeVoiceInput, voiceTtsRequested } from "../voice-client.js";
import { runLiveVoiceLoop, speakAssistantReplySafely } from "../voice-live.js";
import { runRealtimeVoice } from "../voice-realtime.js";

export async function runVoice(args: ParsedArgs, options: {
  json?: boolean;
  liveRunner?: (args: ParsedArgs, options: { json?: boolean }) => Promise<number>;
  realtimeRunner?: (args: ParsedArgs, options: { json?: boolean }) => Promise<number>;
} = {}): Promise<number> {
  if (hasFlag(args.flags, "help", "h") || args.positionals[0] === "help") {
    process.stdout.write(`${voiceUsage()}\n`);
    return 0;
  }

  if (voiceTtsRequested(args)) {
    const result = await synthesizeVoiceOutput(args);
    if (!result) throw new Error("voice TTS requires --speak <text> or --tts <text>");
    if (options.json) {
      writeJsonLine({
        type: "voice.tts",
        ts: nowIso(),
        path: result.path,
        provider: result.provider,
        mimeType: result.mimeType,
      });
    } else {
      process.stdout.write(`语音已生成:${result.path}${result.provider ? ` (${result.provider})` : ""}\n`);
    }
    return 0;
  }

  if (!hasVoiceInputArgs(args)) {
    // `Lynn voice` → realtime full-duplex (StepFun Realtime + live waveform) by default.
    // `--classic` / `--loop` keeps the record→ASR→reply→TTS loop; --json forces classic (scriptable).
    if (!options.json && !hasFlag(args.flags, "classic", "loop")) {
      return (options.realtimeRunner || runRealtimeVoice)(args, options);
    }
    return (options.liveRunner || runLiveVoiceLoop)(args, options);
  }

  const transcript = await transcribeVoiceInput(args);
  if (!transcript) {
    throw new Error("voice input required: use Lynn voice, Lynn voice --file speech.wav, or Lynn voice --record 5");
  }
  if (options.json) {
    writeJsonLine({
      type: "voice.transcript",
      ts: nowIso(),
      text: transcript.text,
      provider: transcript.provider,
    });
  } else {
    process.stdout.write(`${transcript.text}\n`);
  }
  if (!hasFlag(args.flags, "send", "ask")) {
    if (options.json) writeJsonLine({ type: "voice.finished", ts: nowIso(), ok: true });
    return 0;
  }
  const prompt = getStringFlag(args.flags, "prompt", "p", "print") || args.positionals.join(" ").trim();
  const mergedPrompt = prompt ? `${prompt}\n\n--- voice transcript ---\n${transcript.text}` : transcript.text;
  const next = stripVoiceFlags(args);
  const speakReplies = !hasFlag(args.flags, "no-speak", "text-only");
  return runPrompt({
    ...next,
    command: "prompt",
    positionals: [mergedPrompt],
    flags: { ...next.flags, p: mergedPrompt },
  }, {
    ...options,
    onAssistantComplete: speakReplies
      ? (answer) => speakAssistantReplySafely(args, answer, options)
      : undefined,
  });
}

function voiceUsage(): string {
  return [
    "Lynn voice — StepFun Realtime 语音输入/输出",
    "",
    "用法:",
    "  Lynn voice                实时全双工对话(直接说话,带实时波形)",
    "  Lynn voice --ptt          按键说话(空格开始/结束一轮)",
    "  Lynn voice --classic      经典模式(录一句→识别→回答→朗读 循环)",
    "  Lynn voice --once",
    "  Lynn voice --no-speak",
    "  Lynn voice --file speech.wav [--json]",
    "  Lynn voice --record 5 [--json]",
    "  Lynn voice --file speech.wav --send -p \"按语音内容回答\" [--no-speak]",
    "  Lynn -p \"按语音内容回答\" --voice-file speech.wav [--json]",
    "  Lynn voice --speak \"你好,我是 Lynn\" --out reply.wav [--json]",
    "",
    "说明:",
    "  默认通过 Lynn Brain 托管 StepFun Realtime,无需在本地填写 StepFun Key。",
    "  在 `Lynn` chat 内输入 `/voice` 或 `lynn voice` 会就地进入同一条实时语音,Ctrl+C 返回聊天。",
    "  外层 `Lynn voice` 只复用同一条 StepFun Realtime 链路,用于从 shell 直接进入。",
    "  安静环境用连续实时对话;嘈杂环境用 `Lynn voice --once` 单轮按停顿结束本轮,或 `--no-speak` 只看文字。",
    "  GUI 的麦克风和消息朗读使用同一条主链;Spark/CosyVoice/SenseVoice/系统语音只作为 fallback。",
    "  `--file ... --send` 默认也会朗读模型回答;加 `--no-speak` 可只输出文字。",
  ].join("\n");
}

function hasVoiceInputArgs(args: ParsedArgs): boolean {
  return !!getStringFlag(args.flags, "voice-file", "file", "audio")
    || hasFlag(args.flags, "voice-stdin", "record");
}
