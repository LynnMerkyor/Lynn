import fs from "fs";

type CounterMap = Record<string, number>;

export interface SessionStats {
  toolUsage: CounterMap;
  languages: CounterMap;
  hour: number | null;
  turnCount: number;
}

interface SessionJsonlEntry {
  type?: unknown;
  timestamp?: unknown;
  message?: SessionMessage;
}

interface SessionMessage {
  role?: unknown;
  content?: unknown;
}

interface MessageContentBlock {
  type?: unknown;
  text?: unknown;
  name?: unknown;
}

interface LanguagePattern {
  re: RegExp;
  lang: string;
}

const LANG_PATTERNS: LanguagePattern[] = [
  { re: /\b(?:typescript|\.tsx?)\b/i, lang: "TypeScript" },
  { re: /\b(?:javascript|\.jsx?)\b/i, lang: "JavaScript" },
  { re: /\b(?:python|\.py)\b/i, lang: "Python" },
  { re: /\b(?:rust|\.rs)\b/i, lang: "Rust" },
  { re: /\b(?:golang|\.go)\b/i, lang: "Go" },
  { re: /\bjava\b/i, lang: "Java" },
  { re: /\b(?:c\+\+|cpp|\.cpp)\b/i, lang: "C++" },
  { re: /\b(?:csharp|c#|\.cs)\b/i, lang: "C#" },
  { re: /\b(?:ruby|\.rb)\b/i, lang: "Ruby" },
  { re: /\b(?:php|\.php)\b/i, lang: "PHP" },
  { re: /\b(?:swift|\.swift)\b/i, lang: "Swift" },
  { re: /\b(?:kotlin|\.kt)\b/i, lang: "Kotlin" },
  { re: /\b(?:elixir|\.ex)\b/i, lang: "Elixir" },
  { re: /\b(?:dart|\.dart)\b/i, lang: "Dart" },
];

export function extractSessionStats(sessionPath: string): SessionStats | null {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionPath, "utf-8");
  } catch {
    return null;
  }

  const toolUsage: CounterMap = {};
  const languages: CounterMap = {};
  let turnCount = 0;
  let lastHour: number | null = null;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as SessionJsonlEntry;

      // 统计用户消息轮数
      if (entry.type === "message" && entry.message?.role === "user") {
        turnCount++;

        // 提取时间（取最后一条的小时）
        if (entry.timestamp) {
          try {
            lastHour = new Date(entry.timestamp as string | number | Date).getHours();
          } catch {}
        }

        // 从用户消息中检测语言提及
        const content = typeof entry.message.content === "string"
          ? entry.message.content
          : Array.isArray(entry.message.content)
            ? entry.message.content
                .filter((c) => (c as MessageContentBlock).type === "text")
                .map((c) => (c as MessageContentBlock).text)
                .join(" ")
            : "";

        for (const { re, lang } of LANG_PATTERNS) {
          if (re.test(content)) {
            languages[lang] = (languages[lang] || 0) + 1;
          }
        }
      }

      // 统计工具使用
      if (entry.type === "message" && entry.message?.role === "assistant") {
        const content = entry.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const contentBlock = block as MessageContentBlock;
            const toolName = contentBlock.name as string;
            if (contentBlock.type === "tool_use" && toolName) {
              toolUsage[toolName] = (toolUsage[toolName] || 0) + 1;
            }
          }
        }
      }
    } catch {
      // 跳过损坏行
    }
  }

  if (turnCount === 0) return null;

  return {
    toolUsage,
    languages,
    hour: lastHour,
    turnCount,
  };
}
