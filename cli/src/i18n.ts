/**
 * i18n.ts — tiny, dependency-free localization for the Lynn CLI.
 *
 * Lynn is a Chinese-market product (GUI defaults to zh; README is 中文-first),
 * so the CLI defaults to Chinese. A user's POSIX `LANG` is intentionally NOT
 * consulted for the default — many Chinese users run an `en_US.UTF-8` locale and
 * would otherwise get an all-English CLI. English is an explicit opt-in via
 * `LYNN_LANG=en` (or `LYNN_LOCALE=en`).
 *
 * Scope note: this intentionally covers the first-impression / interactive
 * surfaces without pulling in a full i18n framework.
 */

export type Lang = "zh" | "en";

let cachedLang: Lang | null = null;

/** Resolve the active language from env. Pure — pass `env` in tests. */
export function detectLang(env: NodeJS.ProcessEnv = process.env): Lang {
  const explicit = (env.LYNN_LANG || env.LYNN_LOCALE || "").trim().toLowerCase();
  if (explicit.startsWith("en")) return "en";
  if (explicit.startsWith("zh")) return "zh";
  return "zh"; // Chinese-market default; English is opt-in via LYNN_LANG=en
}

export function currentLang(): Lang {
  if (cachedLang == null) cachedLang = detectLang();
  return cachedLang;
}

/** Override the cached language (tests / explicit runtime switch). */
export function setLang(lang: Lang | null): void {
  cachedLang = lang;
}

type Vars = Record<string, string | number>;

const STRINGS: Record<Lang, Record<string, string>> = {
  zh: {
    "tips.banner":
      '提示:lynn -p "问题" 走本地 Brain 路由(默认 MiMo,在 Lynn 客户端配置)。\n' +
      "     聊天 / 代码里用 /fast 低延迟,/think 深度推理。\n" +
      "     lynn providers 配置 CLI 专用 BYOK,lynn help 查看全部命令。",
    "startup.label.model": "模型",
    "startup.label.mode": "权限",
    "startup.label.byok": "BYOK",
    "startup.label.brain": "Brain",
    "startup.label.directory": "目录",
    "startup.hint.model": "/model 切换",
    "startup.hint.mode": "Shift+Tab 切换",
    "startup.byok.default": "Lynn 客户端设置 > Providers",
    "status.chat.prefix": "MiMo/Brain",
    "offline.body":
      "默认 MiMo 路由暂不可用(本地 Brain 离线)。你仍然可以配置 CLI-only BYOK 使用任意 OpenAI 兼容模型:\n" +
      "  lynn doctor --offline       自检环境\n" +
      "  lynn providers              查看 / 配置 BYOK\n" +
      '  lynn -p "你好" --mock-brain   离线试用',
    "offline.body.byok": "本地 Brain 离线;将直接使用 CLI BYOK provider:{provider} / {model}。",
    "chat.error.brainOffline": "默认 MiMo 路由不可用:本地 Brain 离线。打开 Lynn 客户端即可使用默认 MiMo,或运行 /providers 配置 CLI-only BYOK。({brainUrl})",
    "brain.recovery.offline": "Brain 离线。打开 Lynn 客户端使用默认 MiMo,运行 Lynn providers set 配置 CLI-only BYOK,或用 --mock-brain 做离线试用。",
    "brain.connection.error": "无法连接 Lynn Brain:{brainUrl}{detail}。",
    "brain.connection.recovery": "打开 Lynn 客户端以启动本地 Brain/router,或用 --brain-url 指向其他兼容端点。",
    "brain.connection.byok": "CLI-only 使用方式:运行 Lynn providers set 配置 BYOK 端点;冒烟测试用 --mock-brain。",
    "code.placeholder": "描述一个编码任务,或输入 /help",
    "code.tip": "提示:/fast 快速编辑,/think 深度推理,/mode yolo 允许本地改动。",
    "code.route.mock": "模拟 Brain",
    "code.route.brain": "经本地 Brain 路由的 MiMo",
    "code.label.think": "思考",
    "code.maxsteps": "最多 {n} 步",
    "chat.fast": "✓ 快速模式 · 思考关闭(低延迟短回复)",
    "chat.think": "✓ 思考模式 · 推理强度高",
    "chat.cleared": "✓ 上下文已清空",
    "chat.help":
      "/exit 退出聊天\n" +
      "/clear 清空上下文\n" +
      "/model 查看当前模型 / BYOK 路由\n" +
      "/providers 查看提供方和 BYOK 设置\n" +
      "/fast 低延迟回复\n" +
      "/think 深度推理\n" +
      "/reasoning 查看或设置推理模式\n" +
      "/mode 查看权限模式\n" +
      "/mode ask|yolo|read-only|workspace|danger 切换权限\n" +
      "/help 显示命令",
    "chat.reasoning.show": "reasoning:{effort} · display {display}\n用 /fast、/think 或 /reasoning off|auto|low|medium|high|xhigh 切换。",
    "chat.mode.show": "mode:{mode}\n用 /mode yolo 开启本地写入/命令权限,/mode ask 回到守护模式,或 Shift+Tab 切换。",
    "code.fast": "✓ 快速模式 · 思考关闭",
    "code.think": "✓ 思考模式 · 高",
    "code.help":
      "/exit 退出 code 模式\n" +
      "/tools 查看本地编码工具\n" +
      "/fast 低延迟 MiMo/Brain 回复\n" +
      "/think 深度 MiMo/Brain 推理\n" +
      "/reasoning 查看或设置推理模式\n" +
      "/model 查看当前 Brain/BYOK 路由\n" +
      "/providers 查看提供方和 BYOK 设置\n" +
      "/mode 查看权限模式\n" +
      "/mode ask 守护模式(workspace-write)\n" +
      "/mode yolo 允许本地写入和 shell 命令",
    "code.reasoning.show": "think:{effort} / display {display}\n用 /fast、/think 或 /reasoning off|auto|low|medium|high|xhigh 切换。",
    "code.mode.show": "mode:{mode}\n用 /mode yolo 开启本地工具权限,/mode ask 回到守护模式。",
    "tool.approval.suffix": " (需要确认)",
    "reasoning.effortSet": "推理强度已设为 {value}。",
    "reasoning.displayAlways": "推理显示已设为:始终。",
    "reasoning.displayNever": "推理显示已设为:从不。",
    "reasoning.unknown": "未知的推理模式:{raw}。",
    "reasoning.state": "推理:{effort} · 显示 {display}",
    "code.reasoning.state": "思考:{effort} / 显示 {display}",
    "approval.prompt": "允许 {tool} 在 {cwd} 执行?[y/n/a](a = 本次会话全部允许) ",
    "mock.response": "模拟回复:{text}",
    "mock.code": "模拟编码任务:{task}",
    "mock.code.cwd": "目录:{cwd}",
    "mock.code.git": "Git:{status}",
    "mock.vision": "模拟 {command}:{path}",
    "git.clean": "干净",
    "git.dirty": "有改动",
    "spinner.thinking": "Lynn 思考中",
    "spinner.coding": "Lynn 编码中",
    "spinner.reviewing": "Lynn 正在查看工具输出",
    "providers.title": "Lynn Providers / BYOK",
    "providers.currentRoute": "当前路由",
    "providers.defaultRoute": "默认路由",
    "providers.brainUrl": "Brain URL",
    "providers.localServer": "客户端服务",
    "providers.byokEntry": "BYOK 入口",
    "providers.cliByok": "CLI BYOK",
    "providers.configured": "已配置",
    "providers.none": "暂未检测到",
    "providers.byok.default": "打开 Lynn 客户端 > 设置 > Providers",
    "providers.byok.missing": "安装/打开 Lynn 客户端 > 设置 > Providers 配置默认路由;或运行 Lynn providers set 配置 CLI-only BYOK",
    "providers.byok.configured": "已配置 CLI BYOK fallback;默认 Brain 路由仍由 Lynn 客户端设置 > Providers 控制",
    "providers.keyPolicy": "Provider key 保存在 Lynn 设置/服务端存储中;CLI 不会打印或暴露它们。",
    "providers.defaultNote": "默认模型: CLI 通过本地 Brain/router 使用 MiMo,需安装并打开 Lynn 客户端。",
    "providers.clientNote": "没有客户端时,CLI-only 模式不能修改默认模型设置。",
    "providers.cliNote": "CLI-only: 可用 OpenAI 兼容三步配置 BYOK:",
    "providers.routeHint": "用 Lynn model 或聊天里的 /model 查看路由;用 --brain-url 指向其他本地端点。",
    "providers.saved": "已保存 CLI BYOK provider。",
    "providers.savedHint": "当 Lynn 客户端/Brain 离线时,Lynn CLI 会用这个 provider 作为直接 fallback。",
    "providers.presets.title": "Lynn CLI BYOK Presets",
    "providers.presets.model": "模型",
    "providers.presets.url": "URL",
    "providers.presets.about": "说明",
    "providers.presets.use": "使用",
    "providers.presets.note": "Preset 只填 API URL 和模型名;API key 仍需用户自己提供,不会内置。",
    "providers.test.ok": "Provider 测试通过",
    "providers.test.fail": "Provider 测试失败",
    "providers.test.latency": "延迟",
    "providers.test.preview": "预览",
    "providers.test.error": "错误",
    "providers.test.noProfile": "还没有 CLI BYOK provider 配置。",
    "providers.test.hint": "先运行: Lynn providers set --base-url https://api.example.com/v1 --api-key <api-key> --model model-id",
    "providers.wizard.title": "Lynn CLI BYOK 设置(OpenAI 兼容)",
    "providers.wizard.step1": "第 1/3 步:API URL",
    "providers.wizard.step1.help": "从提供商文档复制 OpenAI 兼容 base URL,通常以 /v1 结尾。",
    "providers.wizard.step1.examples": "示例:https://api.openai.com/v1,https://api.deepseek.com/v1,https://dashscope.aliyuncs.com/compatible-mode/v1",
    "providers.wizard.baseUrl": "API URL",
    "providers.wizard.step2": "第 2/3 步:API Key",
    "providers.wizard.step2.help": "在提供商控制台创建或复制 API key。Lynn 会本地保存,终端输出会脱敏。",
    "providers.wizard.apiKey": "API Key",
    "providers.wizard.apiKey.keep": "API Key [保留 {key}] ",
    "providers.wizard.step3": "第 3/3 步:Model name",
    "providers.wizard.step3.help": "从提供商模型列表复制精确 model id,例如 gpt-4o、deepseek-chat、qwen-plus 或你的自定义模型名。",
    "providers.wizard.model": "Model name",
  },
  en: {
    "tips.banner":
      'Tip: lynn -p "prompt" uses the local Brain router (MiMo by default, configured in the Lynn client).\n' +
      "     In chat / code, use /fast for low latency or /think for deeper reasoning.\n" +
      "     Run lynn providers for CLI-only BYOK, or lynn help to see every command.",
    "startup.label.model": "model",
    "startup.label.mode": "mode",
    "startup.label.byok": "BYOK",
    "startup.label.brain": "brain",
    "startup.label.directory": "directory",
    "startup.hint.model": "/model to change",
    "startup.hint.mode": "Shift+Tab to toggle",
    "startup.byok.default": "client GUI Settings > Providers",
    "status.chat.prefix": "MiMo/Brain",
    "offline.body":
      "Default MiMo route unavailable (local Brain offline). You can still configure CLI-only BYOK for any OpenAI-compatible model:\n" +
      "  lynn doctor --offline       check setup\n" +
      "  lynn providers              view / configure BYOK\n" +
      '  lynn -p "hello" --mock-brain   try it offline',
    "offline.body.byok": "Local Brain is offline; using CLI BYOK provider directly: {provider} / {model}.",
    "chat.error.brainOffline": "Default MiMo route unavailable: local Brain is offline. Open the Lynn client for default MiMo, or run /providers to configure CLI-only BYOK. ({brainUrl})",
    "brain.recovery.offline": "Brain offline. Start the Lynn client GUI for MiMo, configure CLI BYOK with Lynn providers set, or run with --mock-brain.",
    "brain.connection.error": "Could not reach Lynn Brain at {brainUrl}{detail}.",
    "brain.connection.recovery": "Start the Lynn client GUI so the local Brain/router is running, or pass --brain-url to another compatible endpoint.",
    "brain.connection.byok": "For CLI-only use, run Lynn providers set with your BYOK endpoint; for smoke tests, use --mock-brain.",
    "code.placeholder": "Describe a coding task, or type /help",
    "code.tip": "Tip: /fast for quick edits, /think for deeper reasoning, /mode yolo to allow local edits.",
    "code.route.mock": "mock Brain",
    "code.route.brain": "MiMo via local Brain router",
    "code.label.think": "think",
    "code.maxsteps": "max steps {n}",
    "chat.fast": "✓ fast mode · thinking off (short, low-latency replies)",
    "chat.think": "✓ thinking mode · reasoning high",
    "chat.cleared": "✓ context cleared",
    "chat.help":
      "/exit leave chat\n" +
      "/clear reset context\n" +
      "/model show model/BYOK route\n" +
      "/providers show BYOK setup\n" +
      "/fast low-latency replies\n" +
      "/think deeper reasoning\n" +
      "/reasoning show or set reasoning mode\n" +
      "/mode show permission mode\n" +
      "/mode ask|yolo|read-only|workspace|danger change permission mode\n" +
      "/help show commands",
    "chat.reasoning.show": "reasoning: {effort} · display {display}\nUse /fast, /think, or /reasoning off|auto|low|medium|high|xhigh.",
    "chat.mode.show": "mode: {mode}\nUse /mode yolo for full local tool permission, /mode ask for guarded mode, or Shift+Tab to toggle.",
    "code.fast": "✓ fast mode · thinking off",
    "code.think": "✓ thinking mode · high",
    "code.help":
      "/exit leave code mode\n" +
      "/tools list local coding tools\n" +
      "/fast low-latency MiMo/Brain replies\n" +
      "/think deeper MiMo/Brain reasoning\n" +
      "/reasoning show or set reasoning mode\n" +
      "/model show current Brain/BYOK route\n" +
      "/providers show provider and BYOK setup\n" +
      "/mode show permission mode\n" +
      "/mode ask guarded workspace-write mode\n" +
      "/mode yolo allow local writes and shell commands",
    "code.reasoning.show": "think: {effort} / display {display}\nUse /fast, /think, or /reasoning off|auto|low|medium|high|xhigh.",
    "code.mode.show": "mode: {mode}\nUse /mode yolo for full local tool permission or /mode ask for guarded mode.",
    "tool.approval.suffix": " (approval required)",
    "reasoning.effortSet": "Reasoning effort set to {value}.",
    "reasoning.displayAlways": "Reasoning display set to always.",
    "reasoning.displayNever": "Reasoning display set to never.",
    "reasoning.unknown": "Unknown reasoning mode: {raw}.",
    "reasoning.state": "reasoning: {effort} · display {display}",
    "code.reasoning.state": "think: {effort} / display {display}",
    "approval.prompt": "Allow {tool} in {cwd}? [y/n/a] (a = allow all this session) ",
    "mock.response": "Mock reply: {text}",
    "mock.code": "Mock code task: {task}",
    "mock.code.cwd": "Directory: {cwd}",
    "mock.code.git": "Git: {status}",
    "mock.vision": "Mock {command}: {path}",
    "git.clean": "clean",
    "git.dirty": "dirty",
    "spinner.thinking": "Lynn is thinking",
    "spinner.coding": "Lynn is coding",
    "spinner.reviewing": "Lynn is reviewing tool output",
    "providers.title": "Lynn Providers / BYOK",
    "providers.currentRoute": "Current route",
    "providers.defaultRoute": "Default route",
    "providers.brainUrl": "Brain URL",
    "providers.localServer": "Local server",
    "providers.byokEntry": "BYOK entry",
    "providers.cliByok": "CLI BYOK",
    "providers.configured": "Configured",
    "providers.none": "none detected yet",
    "providers.byok.default": "Open Lynn client GUI > Settings > Providers",
    "providers.byok.missing": "Install/open Lynn client GUI > Settings > Providers for default route, or run Lynn providers set for CLI-only BYOK",
    "providers.byok.configured": "CLI BYOK fallback configured; client GUI Settings > Providers controls the default Brain route",
    "providers.keyPolicy": "Provider keys stay in Lynn settings/server storage; the CLI does not print or store them.",
    "providers.defaultNote": "Default model: CLI uses MiMo through the local Brain/router when the Lynn client GUI is installed, running, and configured.",
    "providers.clientNote": "Without the client GUI, default model settings cannot be changed from CLI-only mode.",
    "providers.cliNote": "CLI-only: set a BYOK OpenAI-compatible endpoint with:",
    "providers.routeHint": "Use Lynn model or /model in chat to review this route. Use --brain-url to point at another local endpoint.",
    "providers.saved": "Saved CLI BYOK provider.",
    "providers.savedHint": "When Lynn client GUI/Brain is offline, Lynn CLI will use this provider as a direct fallback.",
    "providers.presets.title": "Lynn CLI BYOK Presets",
    "providers.presets.model": "model",
    "providers.presets.url": "URL",
    "providers.presets.about": "about",
    "providers.presets.use": "use",
    "providers.presets.note": "Presets fill only API URL and model name; users still provide their own API key.",
    "providers.test.ok": "Provider test OK",
    "providers.test.fail": "Provider test failed",
    "providers.test.latency": "latency",
    "providers.test.preview": "preview",
    "providers.test.error": "error",
    "providers.test.noProfile": "No CLI BYOK provider is configured yet.",
    "providers.test.hint": "Run: Lynn providers set --base-url https://api.example.com/v1 --api-key <api-key> --model model-id",
    "providers.wizard.title": "Lynn CLI BYOK setup (OpenAI-compatible)",
    "providers.wizard.step1": "Step 1/3: API URL",
    "providers.wizard.step1.help": "Paste the OpenAI-compatible base URL from your provider docs. It usually ends with /v1.",
    "providers.wizard.step1.examples": "Examples: https://api.openai.com/v1, https://api.deepseek.com/v1, https://dashscope.aliyuncs.com/compatible-mode/v1",
    "providers.wizard.baseUrl": "API URL",
    "providers.wizard.step2": "Step 2/3: API Key",
    "providers.wizard.step2.help": "Create or copy an API key from your provider console. Lynn stores it locally and redacts it in terminal output.",
    "providers.wizard.apiKey": "API Key",
    "providers.wizard.apiKey.keep": "API Key [keep {key}] ",
    "providers.wizard.step3": "Step 3/3: Model name",
    "providers.wizard.step3.help": "Copy the exact model id from your provider's model list, for example gpt-4o, deepseek-chat, qwen-plus, or your custom model id.",
    "providers.wizard.model": "Model name",
  },
};

/** Translate `key` for the active language, interpolating `{var}` placeholders. */
export function t(key: string, vars?: Vars): string {
  const lang = currentLang();
  let value = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  if (vars) {
    for (const [name, replacement] of Object.entries(vars)) {
      value = value.split(`{${name}}`).join(String(replacement));
    }
  }
  return value;
}
