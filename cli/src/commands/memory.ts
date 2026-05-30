import { getStringFlag, type ParsedArgs } from "../args.js";
import { writeJsonLine } from "../jsonl.js";
import {
  appendMemoryEntry,
  forgetMemoryEntry,
  formatMemoryList,
  readMemoryEntries,
} from "../session/memory.js";
import { resolveDataDir } from "../session/store.js";

export async function runMemory(args: ParsedArgs, json: boolean): Promise<number> {
  const dataDir = resolveDataDir(getStringFlag(args.flags, "data-dir"));
  const subcommand = (args.positionals[0] || "list").toLowerCase();
  if (subcommand === "add") {
    const text = args.positionals.slice(1).join(" ").trim();
    if (!text) throw new Error("memory add requires text");
    const entry = await appendMemoryEntry({ dataDir, text, source: "cli" });
    if (json) writeJsonLine({ type: "memory.added", entry });
    else process.stdout.write(`已保存记忆 ${entry.id.slice(0, 8)} · ${entry.kind}\n`);
    return 0;
  }
  if (subcommand === "forget" || subcommand === "remove" || subcommand === "delete") {
    const id = args.positionals[1] || "";
    if (!id) throw new Error("memory forget requires an id prefix");
    const removed = await forgetMemoryEntry(dataDir, id);
    if (json) writeJsonLine({ type: "memory.forgotten", removed });
    else process.stdout.write(removed ? `已删除记忆 ${removed.id.slice(0, 8)}\n` : "没有找到匹配的记忆。\n");
    return removed ? 0 : 2;
  }
  if (subcommand !== "list" && subcommand !== "show") {
    process.stdout.write(memoryUsage());
    return 2;
  }
  const entries = await readMemoryEntries(dataDir);
  if (json) writeJsonLine({ type: "memory.list", entries });
  else process.stdout.write(`${formatMemoryList(entries, 30)}\n`);
  return 0;
}

function memoryUsage(): string {
  return [
    "用法:",
    "  Lynn memory",
    "  Lynn memory add <长期事实/偏好/决策>",
    "  Lynn memory forget <id-prefix>",
    "",
  ].join("\n");
}
