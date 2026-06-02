import { readVersionInfo } from "./version.js";

export function renderCodeHeadlessHelp(): string {
  const version = readVersionInfo().version || "0.80.0";
  return [
    "Lynn code headless / CLI Fleet",
    "",
    "用途:",
    "  - 给人用: Lynn code",
    "  - 给其他智能体 / CI / GUI Fleet 用: Lynn code -p \"任务\" --json --cwd /repo",
    "",
    "安装(Node.js 20 LTS 或 22 LTS + npm):",
    `  npm install -g --force https://download.merkyorlynn.com/downloads/cli/lynn-cli-${version}.tgz`,
    "",
    "静默调用(处理完直接退出,不进入 TUI):",
    "  Lynn code -p \"review the current diff\" --json --cwd /repo",
    "  Lynn code -p \"fix tests, run the suite, summarize the diff\" \\",
    "    --json --cwd /worktree --approval yolo --sandbox workspace-write --save-session",
    "",
    "长任务/断点续跑:",
    "  Lynn code -p \"complete the migration until tests pass\" \\",
    "    --json --cwd /worktree --approval yolo --sandbox workspace-write \\",
    "    --long --max-steps 1000 --save-session",
    "  Lynn code --resume <session.jsonl> -p \"continue\" --json --long",
    "",
    "GUI Fleet worker(JSONL 事件流):",
    "  Lynn worker run --brief task.md --worktree /worktree \\",
    "    --jsonl --approval yolo --sandbox workspace-write",
    "  Lynn worker run --brief task.md --worktree /worktree \\",
    "    --agent custom --agent-command \"your-cli --json\" --jsonl",
    "",
    "规则:",
    "  - 自动化调用只解析 --json / --jsonl,不要解析人类 TUI。",
    "  - 总是传 --cwd 或 --worktree。",
    "  - 交互式 ask 模式会逐次弹出授权;--approval yolo 只用于隔离 git worktree 的零逐条审批。",
    "  - code.tool.ledger 记录每步工具观察,供上层调度和审计。",
    "  - code.task.finished.resumeCommand 存在时,按它继续。",
  ].join("\n");
}
