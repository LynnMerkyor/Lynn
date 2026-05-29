import { parseArgs, hasFlag } from "./args.js";
import { checkBrainReachable } from "./brain-client.js";
import { runAgents } from "./commands/agents.js";
import { runChat } from "./commands/chat.js";
import { runCode } from "./commands/code.js";
import { renderDoctor, runDoctor } from "./commands/doctor.js";
import { runPermissions } from "./commands/permissions.js";
import { runPrompt } from "./commands/prompt.js";
import { activeRouteLabel, resolveProvidersInfo, runProviders } from "./commands/providers.js";
import { runSessions } from "./commands/sessions.js";
import { runVisionCommand } from "./commands/vision.js";
import { runWorker } from "./commands/worker-run.js";
import { usage } from "./help.js";
import { writeJsonLine } from "./jsonl.js";
import { renderStartupBanner } from "./startup.js";
import { readVersionInfo } from "./version.js";
import type { ProvidersInfo } from "./commands/providers.js";
import { t } from "./i18n.js";

async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0) {
    const providerInfo = await resolveProvidersInfo({ command: "providers", positionals: [], flags: {} }, 500);
    const brainReachable = await checkBrainReachable(providerInfo.brainUrl, 300);
      process.stdout.write(`${renderStartupBanner({
        brainUrl: providerInfo.brainUrl,
        brainStatus: brainReachable ? "online" : "offline",
        modelLabel: startupModelLabel(providerInfo, brainReachable),
        byokLabel: providerInfo.cliProvider?.configured ? t("startup.byok.cliFallback") : undefined,
        showTips: brainReachable,
      })}\n`);
    if (process.stdin.isTTY && process.stdout.isTTY) {
      // Always enter the REPL. If Brain is offline, runChat prints recovery
      // guidance per turn instead of dropping the next user input into zsh.
      return runChat({ command: "chat", positionals: [], flags: {} }, { intro: false, brainReachable });
    }
    return 0;
  }
  const args = parseArgs(argv);
  const json = hasFlag(args.flags, "json", "jsonl");

  if (isImplicitChatInvocation(args)) {
    return runChat({ ...args, command: "chat" });
  }

  switch (args.command) {
    case "version": {
      const info = readVersionInfo();
      if (json) writeJsonLine({ type: "version", ...info });
      else process.stdout.write(`${info.name} ${info.version}\n`);
      return 0;
    }
    case "doctor": {
      const result = await runDoctor(args);
      if (json) writeJsonLine({ type: "doctor", ...result });
      else process.stdout.write(`${renderDoctor(result)}\n`);
      return result.ok ? 0 : 2;
    }
    case "chat": {
      return runChat(args);
    }
    case "agents": {
      return runAgents(args, json);
    }
    case "providers": {
      return runProviders(args, json);
    }
    case "permissions": {
      return runPermissions(args, json);
    }
    case "model": {
      return runProviders(args, json);
    }
    case "prompt":
    case "exec": {
      return runPrompt(args, {
        json,
        mockBrain: hasFlag(args.flags, "mock-brain", "mock"),
      });
    }
    case "worker": {
      return runWorker(args);
    }
    case "code": {
      return runCode(args);
    }
    case "see":
    case "ground":
    case "ui2code": {
      return runVisionCommand(args, args.command, json);
    }
    case "sessions": {
      return runSessions(args, json);
    }
    case "help":
    case "--help":
    case "-h": {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    default: {
      if (args.command === "-p" || args.command === "--print") {
        return runPrompt(args, { json, mockBrain: hasFlag(args.flags, "mock-brain", "mock") });
      }
      return runPrompt({ ...args, command: "prompt", positionals: [args.command, ...args.positionals] }, {
        json,
        mockBrain: hasFlag(args.flags, "mock-brain", "mock"),
      });
    }
  }
}

function isImplicitChatInvocation(args: ReturnType<typeof parseArgs>): boolean {
  if (args.command !== "help") return false;
  if (hasFlag(args.flags, "help", "h", "version", "v")) return false;
  return hasFlag(
    args.flags,
    "mock-brain",
    "mock",
    "brain-url",
    "reasoning",
    "show-reasoning",
    "approval",
    "sandbox",
    "base-url",
    "api-base",
    "api-key",
    "model",
    "preset",
    "data-dir",
  );
}

function startupModelLabel(info: ProvidersInfo, brainReachable: boolean): string {
  if (!brainReachable && info.cliProvider?.configured && info.cliProvider.profile) {
    return `CLI BYOK: ${info.cliProvider.profile.model}`;
  }
  const label = activeRouteLabel(info);
  if (/^MiMo via .*Brain router/i.test(label)) return "MiMo";
  return label;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`lynn: ${message}\n`);
  process.exitCode = 1;
});
