import { readVersionInfo } from "./version.js";
import { displayCwd } from "./startup.js";

export interface RuntimeAnswerContext {
  routeLabel: string;
  brainUrl: string;
  cwd: string;
  mode?: string;
  reasoning?: string;
  question?: string;
}

const VERSION_PATTERNS = [
  /(^|\s)\/(?:version|about)(\s|$)/i,
  /(?:lynn\s*)?(?:cli\s*)?(?:版本号|about)/i,
  /(?:lynn|cli|命令行|本地).{0,8}版本/i,
  /(?:你|当前|现在|本地|运行时|命令行|cli).{0,12}(?:版本|版本号|version)/i,
  /\b(?:what|which|show|tell|current|your|runtime|cli|lynn)\b.{0,28}\b(?:version|about)\b/i,
];

const MODEL_ROUTE_PATTERNS = [
  /(^|\s)\/model(\s|$)/i,
  /(?:你|当前|现在|本地|运行时|命令行|cli|lynn).{0,16}(?:模型|model|路由|route)/i,
  /(?:工作|使用|正在用|当前).{0,12}(?:模型|model)/i,
  /(?:模型|model).{0,12}(?:是什么|是哪|哪个|\broute\b|using|running)/i,
  /\b(?:what|which|show|tell|current|your|runtime|cli|lynn)\b.{0,32}\b(?:model|route)\b/i,
  /\b(?:model|route)\b.{0,24}\b(?:using|running|current|active)\b/i,
];

const MEMORY_PATTERNS = [
  /(?:lynn\s*)?(?:cli\s*)?.{0,12}(?:记忆|memory).{0,16}(?:多久|保持|保存|持久|长期|清空|记得|remember|persist)/i,
  /(?:你|当前|现在|本地|运行时|命令行|cli|lynn).{0,16}(?:记忆|memory).{0,18}(?:多久|保持|保存|持久|长期|清空|记得|remember|persist)/i,
  /\b(?:how long|where|does|can)\b.{0,40}\b(?:memory|remember|persist)\b/i,
];

const RUNTIME_OPTIMIZATION_PATTERNS = [
  /(?:lynn\s*)?(?:cli\s*)?.{0,16}(?:本地优化|运行时优化|长任务优化|前置缓存|decode\s*tps|prefix-cache|端侧模型|本地模型|9B|35B|KV\s*cache)/i,
  /(?:你|当前|现在|本地|运行时|命令行|cli|lynn).{0,24}(?:做了什么优化|有什么优化|本地优化|运行时优化|本地模型|端侧|9B|35B|KV\s*cache|前置缓存|decode\s*tps)/i,
  /\b(?:local|runtime|prefix|cache|decode|tps|9b|35b)\b.{0,36}\b(?:optimization|policy|fallback|route|model)\b/i,
];

const VOICE_PATTERNS = [
  /(?:lynn\s*)?(?:cli\s*)?.{0,16}(?:语音|朗读|转写|听写|录音|ASR|TTS|voice|speech|audio).{0,24}(?:模式|能力|怎么用|可用|支持|输入|输出|朗读|转写|录音|speak|listen|transcribe)/i,
  /(?:你|当前|现在|本地|运行时|命令行|cli|lynn).{0,20}(?:语音|朗读|转写|听写|录音|ASR|TTS|voice|speech|audio)/i,
  /\b(?:voice|speech|audio|asr|tts|transcribe|record)\b.{0,36}\b(?:mode|support|input|output|cli|lynn|use|command)\b/i,
];

export function isLocalRuntimeQuestion(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (/^(?:version|about)$/i.test(value)) return true;
  return VERSION_PATTERNS.some((pattern) => pattern.test(value))
    || MODEL_ROUTE_PATTERNS.some((pattern) => pattern.test(value))
    || MEMORY_PATTERNS.some((pattern) => pattern.test(value))
    || RUNTIME_OPTIMIZATION_PATTERNS.some((pattern) => pattern.test(value))
    || VOICE_PATTERNS.some((pattern) => pattern.test(value));
}

function isVoiceRuntimeQuestion(text: string | undefined): boolean {
  const value = String(text || "").trim();
  if (!value) return false;
  return VOICE_PATTERNS.some((pattern) => pattern.test(value));
}

export function renderLocalRuntimeAnswer(input: RuntimeAnswerContext, locale: "zh" | "en" = "zh"): string {
  const version = readVersionInfo();
  const build = version.build ? ` (${version.build})` : "";
  if (isVoiceRuntimeQuestion(input.question)) {
    if (locale === "en") {
      return [
        "Yes. Lynn voice is StepFun Realtime first, hosted by Brain; local Spark/SenseVoice/CosyVoice/system voice is fallback only.",
        "- Current chat: type `/voice` or `lynn voice` to enter realtime voice in place; Ctrl+C returns to chat.",
        "- Shell direct entry: `Lynn voice` uses the same StepFun Realtime path.",
        "- Audio file/transcription: `Lynn voice --file speech.wav --send`",
        "- Speak to file: `Lynn voice --speak \"hello\" --out reply.wav`",
        "- GUI: click the microphone button; it uses the same StepFun Realtime path.",
      ].join("\n");
    }
    return [
      "有。Lynn 语音主链是 Brain 托管的 StepFun Realtime,本地 Spark/SenseVoice/CosyVoice/系统语音只做 fallback。",
      "- 当前 chat:输入 `/voice` 或 `lynn voice` 就地进入实时语音;Ctrl+C 返回聊天。",
      "- 外层直进:`Lynn voice` 复用同一条 StepFun Realtime 链路。",
      "- 音频文件/转写:`Lynn voice --file speech.wav --send`",
      "- 朗读保存:`Lynn voice --speak \"你好\" --out reply.wav`",
      "- GUI:点麦克风按钮,走同一条 StepFun Realtime 链路。",
    ].join("\n");
  }
  if (locale === "en") {
    return [
      `Lynn CLI version: ${version.version}${build}`,
      `Runtime route: ${input.routeLabel}`,
      `Brain: ${input.brainUrl}`,
      `Directory: ${displayCwd(input.cwd)}`,
      input.mode ? `Permissions: ${input.mode}` : "",
      input.reasoning ? `Reasoning: ${input.reasoning}` : "",
      "",
      "Runtime optimizations:",
      "- Stable-prefix layers for prefix-cache hits.",
      "- Rolling decode TPS and prefix-cache telemetry in the footer.",
      "- Automatic context compaction for long chat/code sessions.",
      "- Tool ledger, checkpoint/resume, finish gates, and Fleet JSONL workers.",
      "- Local 9B is explicit opt-in: warm pool off by default, idle unload, small-context prompts, limited tool schemas, visible local TPS, and cloud fallback to StepFun when local inference fails.",
      "- The local manager is an explicit experimental route and never takes over normal GUI/CLI answers by default.",
      "",
      "Memory and continuity:",
      "- Live chat/code context stays in the current context window and is auto-compacted for long runs.",
      "- Saved sessions and checkpoints can be resumed with --save-session, /resume, and /rewind.",
      "- Durable CLI memory is stored under ~/.lynn with /memory add and survives new terminal sessions until /memory forget removes it.",
      "",
      "Voice:",
      "- In the current chat, type `/voice` or `lynn voice` to enter Brain-hosted StepFun Realtime in place; Ctrl+C returns to chat.",
      "- Shell direct entry: `Lynn voice` uses the same realtime path when you want to start directly from a terminal.",
      "- File/one-shot: `Lynn voice --file speech.wav --send` or `Lynn -p \"answer this\" --voice-file speech.wav`.",
      "- TTS: `Lynn voice --speak \"hello\" --out reply.wav`.",
      "",
      "Docs: docs/ops/lynn-cli-runtime-knowledge.md and cli/README.md.",
      "Use `Lynn version` for the local CLI version, `/model` for the Brain model route, and `Lynn providers` for BYOK settings.",
    ].filter(Boolean).join("\n");
  }
  return [
    `Lynn CLI 版本:${version.version}${build}`,
    `模型路由:${input.routeLabel}`,
    `Brain:${input.brainUrl}`,
    `目录:${displayCwd(input.cwd)}`,
    input.mode ? `权限:${input.mode}` : "",
    input.reasoning ? `思考:${input.reasoning}` : "",
    "",
    "运行时优化:",
    "- stable-prefix 分层,提高前置缓存命中。",
    "- 底栏长期显示 decode TPS 和 prefix-cache 最近状态。",
    "- 长聊天 / 长代码任务自动上下文压缩。",
    "- tool ledger、checkpoint/resume、收尾门禁和 Fleet JSONL worker。",
    "- 本地 9B 只在用户显式启用时使用:默认不开 warm pool,空闲可卸载,小上下文/少工具 schema,底栏显示本地 TPS,失败时升云到 StepFun。",
    "- 本地 manager 是显式实验路径,不会默认抢占普通 GUI/CLI 回答链路。",
    "",
    "记忆和连续性:",
    "- 当前聊天 / 代码上下文会保留在本轮上下文窗口里,长对话和长任务会自动压缩。",
    "- 保存的会话和检查点可通过 --save-session、/resume、/rewind 继续或回退。",
    "- 持久 CLI 记忆通过 /memory add 写入 ~/.lynn,跨终端会话保留,直到 /memory forget 删除。",
    "",
    "语音能力:",
    "- 当前 chat 内输入 `/voice` 或 `lynn voice` 就地进入 Brain 托管 StepFun Realtime;Ctrl+C 返回聊天。",
    "- 外层 `Lynn voice` 只是从终端直进同一条实时链路。",
    "- 文件/一次性:`Lynn voice --file speech.wav --send` 或 `Lynn -p \"按语音内容回答\" --voice-file speech.wav`。",
    "- 朗读:`Lynn voice --speak \"你好\" --out reply.wav`。",
    "",
    "说明文档:docs/ops/lynn-cli-runtime-knowledge.md 和 cli/README.md。",
    "提示:`Lynn version` 查看本地 CLI 版本,`/model` 查看 Brain 模型路由,`Lynn providers` 查看 BYOK 设置。",
  ].filter(Boolean).join("\n");
}

export function localeForText(text: string): "zh" | "en" {
  return /[\u3400-\u9fff]/.test(text) ? "zh" : "en";
}
