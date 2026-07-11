function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const WORKER_GUARDRAIL = [
  "You are running as a Lynn Fleet worker.",
  "Follow the task brief exactly and keep all edits inside the assigned worktree and owned files.",
  "Some Fleet briefs are answer-only smoke or coordination tasks. If the brief explicitly says not to inspect files, not to run tools, or to reply/output exactly, answer directly and finish without repository exploration.",
  "Do not download model weights, BF16/GGUF files, datasets, training packages, or large binary artifacts to this Mac.",
  "Report progress concisely; Lynn will inspect git diff, tests, and scope after you finish.",
].join("\n");

export function buildWorkerPrompt(taskText: string): string {
  return `${WORKER_GUARDRAIL}\n\n${taskText}`;
}

export function buildDefaultAgentCommand(agent: string, briefPath: string, worktree: string, taskText: string): string | null {
  void briefPath;
  const prompt = buildWorkerPrompt(taskText);
  switch (agent) {
    case "claude-internal":
      return [
        "claude-internal",
        "-p",
        "--add-dir",
        shellQuote(worktree),
        "--output-format stream-json",
        "--include-partial-messages",
        "--permission-mode bypassPermissions",
        shellQuote(prompt),
      ].join(" ");
    case "claude-code":
      return [
        "claude",
        "-p",
        "--add-dir",
        shellQuote(worktree),
        "--output-format stream-json",
        "--verbose",
        "--include-partial-messages",
        "--dangerously-skip-permissions",
        shellQuote(prompt),
      ].join(" ");
    case "codex-cli":
      return [
        "codex exec",
        "--cd",
        shellQuote(worktree),
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        shellQuote(prompt),
      ].join(" ");
    case "opencode":
    case "opencode-cli":
    case "open-code":
      return `opencode run --format json --cwd ${shellQuote(worktree)} ${shellQuote(prompt)}`;
    case "qwen-cli":
      return [
        "qwen",
        "-p",
        shellQuote(prompt),
        "--add-dir",
        shellQuote(worktree),
        "--output-format stream-json",
        "--include-partial-messages",
        "--approval-mode yolo",
        "--yolo",
      ].join(" ");
    case "kimi-cli":
      return [
        "kimi",
        "--work-dir",
        shellQuote(worktree),
        "--print",
        "--output-format stream-json",
        "--yolo",
        "--afk",
        "-p",
        shellQuote(prompt),
      ].join(" ");
    case "codebuddy":
      return [
        "codebuddy",
        "-p",
        "--output-format stream-json",
        "--include-partial-messages",
        "--add-dir",
        shellQuote(worktree),
        "--permission-mode bypassPermissions",
        "-y",
        shellQuote(prompt),
      ].join(" ");
    default:
      return null;
  }
}

export interface ExternalAgentInvocation {
  command: string;
  args: string[];
  display: string;
}

export function buildDefaultAgentInvocation(agent: string, briefPath: string, worktree: string, taskText: string): ExternalAgentInvocation | null {
  void briefPath;
  const prompt = buildWorkerPrompt(taskText);
  let command = "";
  let args: string[] = [];
  switch (agent) {
    case "claude-internal":
      command = "claude-internal";
      args = ["-p", "--add-dir", worktree, "--output-format", "stream-json", "--include-partial-messages", "--permission-mode", "bypassPermissions", prompt];
      break;
    case "claude-code":
      command = "claude";
      args = ["-p", "--add-dir", worktree, "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--dangerously-skip-permissions", prompt];
      break;
    case "codex-cli":
      command = "codex";
      args = ["exec", "--cd", worktree, "--json", "--dangerously-bypass-approvals-and-sandbox", prompt];
      break;
    case "opencode":
    case "opencode-cli":
    case "open-code":
      command = "opencode";
      args = ["run", "--format", "json", "--cwd", worktree, prompt];
      break;
    case "qwen-cli":
      command = "qwen";
      args = ["-p", prompt, "--add-dir", worktree, "--output-format", "stream-json", "--include-partial-messages", "--approval-mode", "yolo", "--yolo"];
      break;
    case "kimi-cli":
      command = "kimi";
      args = ["--work-dir", worktree, "--print", "--output-format", "stream-json", "--yolo", "--afk", "-p", prompt];
      break;
    case "codebuddy":
      command = "codebuddy";
      args = ["-p", "--output-format", "stream-json", "--include-partial-messages", "--add-dir", worktree, "--permission-mode", "bypassPermissions", "-y", prompt];
      break;
    default:
      return null;
  }
  return { command, args, display: [command, ...args].map((value) => JSON.stringify(value)).join(" ") };
}
