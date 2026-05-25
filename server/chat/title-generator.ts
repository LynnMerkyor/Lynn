import { extractText } from "./content-utils.js";

type MessageContent = Parameters<typeof extractText>[0];

interface ChatMessage {
  role?: string;
  content?: MessageContent;
}

interface ChatSession {
  messages?: ChatMessage[];
}

interface SessionIndexEntry {
  path?: string;
  title?: unknown;
}

interface TitleEngine {
  currentSessionPath?: string;
  listSessions(): Promise<SessionIndexEntry[]>;
  getSessionByPath(sessionPath: string): ChatSession | null | undefined;
  summarizeTitle(userText: string, assistantText: string, opts: { timeoutMs: number }): Promise<string | null | undefined>;
  saveSessionTitle(sessionPath: string, title: string): Promise<unknown>;
}

type NotifySessionTitle = (event: { type: "session_title"; title: string; path: string }) => void;

export interface GenerateSessionTitleOptions {
  sessionPath?: string;
  userTextHint?: string;
  assistantTextHint?: string;
}

function errorMessage(err: unknown): unknown {
  return (err as { message?: unknown } | null | undefined)?.message;
}

/**
 * 后台生成 session 标题：从第一轮对话提取摘要
 */
export async function generateSessionTitle(
  engine: TitleEngine,
  notify: NotifySessionTitle,
  opts: GenerateSessionTitleOptions = {},
): Promise<boolean | undefined> {
  try {
    const sessionPath = opts.sessionPath || engine.currentSessionPath;
    if (!sessionPath) return false;

    const sessions = await engine.listSessions();
    const current = sessions.find((s) => s.path === sessionPath);
    if (current?.title) return true;

    const session = engine.getSessionByPath(sessionPath);
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const userMsg = messages.find((m) => m.role === "user");
    const assistantMsg = messages.find((m) => m.role === "assistant");
    if (!userMsg && !opts.userTextHint) return false;

    const userText = (opts.userTextHint || extractText(userMsg?.content)).trim();
    const assistantText = (opts.assistantTextHint || extractText(assistantMsg?.content)).trim();
    if (!userText || !assistantText) return false;

    let title = await engine.summarizeTitle(userText, assistantText, { timeoutMs: 15_000 });

    if (!title) {
      const fallback = userText.replace(/\n/g, " ").trim().slice(0, 30);
      if (!fallback) return;
      title = fallback;
      console.log("[chat] session 标题 API 失败，使用 fallback:", title);
    }

    await engine.saveSessionTitle(sessionPath, title);

    notify({ type: "session_title", title, path: sessionPath });
    return true;
  } catch (err) {
    console.error("[chat] 生成 session 标题失败:", errorMessage(err));
    return false;
  }
}
