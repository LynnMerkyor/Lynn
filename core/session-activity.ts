import fs from "fs";
import path from "path";

type AnyRecord = Record<string, any>;
type AgentLike = AnyRecord;

export function promoteActivitySessionFile(activitySessionFile: string, agent: AgentLike, opts: {
  onPromoted?: (activitySessionFile: string, newPath: string) => void;
  onError?: (err: unknown) => void;
} = {}) {
  const oldPath = path.join(agent.agentDir, "activity", activitySessionFile);
  if (!fs.existsSync(oldPath)) return null;

  const newPath = path.join(agent.sessionDir, activitySessionFile);
  try {
    fs.renameSync(oldPath, newPath);
    agent._memoryTicker?.notifyPromoted(newPath);
    opts.onPromoted?.(activitySessionFile, newPath);
    return newPath;
  } catch (err) {
    opts.onError?.(err);
    return null;
  }
}
