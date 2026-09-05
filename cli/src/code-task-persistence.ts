import { appendSessionLine, appendSessionMetadata, appendSessionTurn, readSessionLines } from './session/store.js';

/** Persistence only: no model calls, terminal rendering, or harness selection. */
export async function persistCodeTask(input: {
  dataDir: string; liveSessionPath: string | null; sessionPath?: string | null;
  cwd: string; title: string; task: string; text: string;
  modelProvider: string; modelId: string; rewindBeforeLine: number | null;
  snapshots: Array<{ ref: string; restoreCommand: string }>;
  metadata: Record<string, unknown>; onAssistantCheckpoint?: (path: string) => void;
}): Promise<string> {
  let livePath = input.liveSessionPath;
  const base = { dataDir: input.dataDir, cwd: input.cwd, title: input.title, modelProvider: input.modelProvider, modelId: input.modelId };
  if (livePath && input.text.trim()) {
    const lines = await readSessionLines(livePath).catch(() => []);
    const last = [...lines].reverse().find(line => line.type === 'assistant' || line.type === 'user');
    if (!(last?.type === 'assistant' && last.content === input.text)) {
      livePath = await appendSessionLine({ ...base, sessionPath: livePath, line: { type: 'assistant', content: input.text } });
      input.onAssistantCheckpoint?.(livePath);
    }
  }
  const savedPath = livePath || await appendSessionTurn({ ...base, sessionPath: input.sessionPath, prompt: input.task, assistant: input.text });
  if (input.rewindBeforeLine !== null) {
    for (const snapshot of new Map(input.snapshots.map(value => [value.ref, value])).values()) {
      await appendSessionMetadata({ dataDir: input.dataDir, sessionPath: savedPath, data: {
        kind: 'code_rewind_checkpoint', snapshotRef: snapshot.ref, restoreCommand: snapshot.restoreCommand,
        cwd: input.cwd, task: input.task, beforeLine: input.rewindBeforeLine, createdAt: new Date().toISOString(),
      } });
    }
  }
  await appendSessionMetadata({ dataDir: input.dataDir, sessionPath: savedPath, data: input.metadata });
  return savedPath;
}
