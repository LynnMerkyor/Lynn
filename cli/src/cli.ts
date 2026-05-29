import { parseArgs, hasFlag } from "./args.js";
import { runCode } from "./commands/code.js";
import { renderDoctor, runDoctor } from "./commands/doctor.js";
import { runPrompt } from "./commands/prompt.js";
import { runWorker } from "./commands/worker-run.js";
import { usage } from "./help.js";
import { writeJsonLine } from "./jsonl.js";
import { readVersionInfo } from "./version.js";

async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const json = hasFlag(args.flags, "json", "jsonl");

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
      throw new Error(`unknown command: ${args.command}\n\n${usage()}`);
    }
  }
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`lynn: ${message}\n`);
  process.exitCode = 1;
});
