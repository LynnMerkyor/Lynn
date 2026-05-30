import path from "node:path";
import { getStringFlag, type ParsedArgs } from "../args.js";
import { resumeCommandForSession } from "./code.js";
import { writeJsonLine } from "../jsonl.js";
import { listSessions, readSessionLines, resolveDataDir } from "../session/store.js";
import { buildSessionReplayEvents, renderSessionReplay } from "../session/replay.js";
import { computeSessionStats, renderSessionStats } from "../session/stats.js";

export async function runSessions(args: ParsedArgs, json: boolean): Promise<number> {
  const subcommand = args.positionals[0] || "list";
  const dataDir = resolveDataDir(getStringFlag(args.flags, "data-dir"));
  if (subcommand === "list") {
    const sessions = await listSessions(dataDir);
    if (json) writeJsonLine({ type: "sessions.list", dataDir, sessions });
    else {
      if (!sessions.length) process.stdout.write(`No Lynn CLI sessions in ${dataDir}\n`);
      for (const session of sessions) {
        process.stdout.write(`${path.basename(session.path)}  ${session.modified || ""}  ${session.title || "(untitled)"}\n`);
      }
    }
    return 0;
  }

  if (subcommand === "show") {
    const sessionPath = args.positionals[1] || getStringFlag(args.flags, "session");
    if (!sessionPath) throw new Error(`sessions ${subcommand} requires a session path`);
    const lines = await readSessionLines(sessionPath);
    if (json) writeJsonLine({ type: "sessions.show", sessionPath, lines });
    else {
      for (const line of lines) {
        process.stdout.write(`[${line.type}] ${line.content || JSON.stringify(line.data || {})}\n`);
      }
    }
    return 0;
  }

  if (subcommand === "resume") {
    const sessionPath = args.positionals[1] || getStringFlag(args.flags, "session");
    if (!sessionPath) throw new Error("sessions resume requires a session path");
    const command = resumeCommandForSession(sessionPath);
    if (json) writeJsonLine({ type: "sessions.resume_command", sessionPath, command });
    else process.stdout.write(`继续这个代码会话:\n  ${command}\n`);
    return 0;
  }

  if (subcommand === "stats") {
    const sessionPath = args.positionals[1] || getStringFlag(args.flags, "session");
    if (!sessionPath) throw new Error("sessions stats requires a session path");
    const lines = await readSessionLines(sessionPath);
    const stats = computeSessionStats(lines);
    if (json) writeJsonLine({ type: "sessions.stats", sessionPath, stats });
    else process.stdout.write(renderSessionStats(sessionPath, stats));
    return 0;
  }

  if (subcommand === "replay") {
    const sessionPath = args.positionals[1] || getStringFlag(args.flags, "session");
    if (!sessionPath) throw new Error("sessions replay requires a session path");
    const lines = await readSessionLines(sessionPath);
    const events = buildSessionReplayEvents(lines);
    if (json) writeJsonLine({ type: "sessions.replay", sessionPath, events });
    else process.stdout.write(renderSessionReplay(sessionPath, lines));
    return 0;
  }

  throw new Error(`unknown sessions command: ${subcommand}`);
}
