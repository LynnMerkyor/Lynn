import path from "path";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const BRIDGE_IDENTITY_GUARD = [
  "## 外部平台身份与部署信息硬规则",
  "- 你是 Lynn，由 Lynn 团队提供的 AI 助手；不要自称 Claude、ChatGPT、GPT、Gemini 或任何第三方模型。",
  "- 不要主动披露、猜测或罗列底层模型、GPU、备援机器、推理后端、部署线路、模型尺寸、量化格式等内部实现。",
  "- 如果用户追问模型或部署，只能简短回答：\"我是 Lynn，由 Lynn 团队提供；具体运行线路会动态调整。\"",
  "- 禁止提及 RTX 4090、5090、27B 备援、Claude、Anthropic 等历史或内部实现细节。",
].join("\n");

const BRIDGE_IDENTITY_LEAK_PATTERNS = [
  /我是基于\s*Claude\s*模型/iu,
  /(?:Claude|Anthropic).{0,24}(?:模型|平台|助手|运行)/iu,
  /(?:RTX\s*)?(?:4090|5090).{0,32}(?:备援|备用|fallback|vLLM|Dense|线路|模型)/iu,
  /(?:27B[-\s]*FP8|27B.{0,12}Dense).{0,32}(?:备援|备用|fallback|vLLM|线路|模型)/iu,
  /(?:主路|备援|底层模型).{0,120}(?:4090|5090|27B[-\s]*FP8|Claude|Anthropic)/isu,
];

export function containsBridgeIdentityLeak(text: string): boolean {
  return BRIDGE_IDENTITY_LEAK_PATTERNS.some((pattern) => pattern.test(text));
}

export function bridgeIdentityFallback(): string {
  return "我是 Lynn，由 Lynn 团队提供的 AI 助手；具体运行线路会动态调整。";
}

/* ── StreamCleaner ─────────────────────────────────────────
 * 增量剥离 <mood>, <pulse>, <reflect>, <tool_code> 标签。
 * 两态状态机（NORMAL / IN_TAG），支持标签跨 delta。
 */
const STRIP_TAGS = ["mood", "pulse", "reflect", "tool_code"] as const;
type StripTag = typeof STRIP_TAGS[number];

export class StreamCleaner {
  private _buf = "";
  private _inTag = false;
  private _tagName: StripTag | null = null;
  cleaned = "";
  /** 流式过程中提取到的媒体 URL */
  extractedMedia: string[] = [];
  private _inCodeFence = false;
  /** 媒体拦截的行缓冲（处理 delta 分片边界） */
  private _lineBuf = "";

  /** 喂入 delta，返回可发送的干净文本增量（可能为空） */
  feed(delta: string): string {
    this._buf += delta;
    let out = "";

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this._inTag) {
        const close = `</${this._tagName}>`;
        const ci = this._buf.indexOf(close);
        if (ci === -1) break; // 等待更多数据
        this._buf = this._buf.slice(ci + close.length).replace(/^\s*/, "");
        this._inTag = false;
        this._tagName = null;
      } else {
        // 寻找最近的开标签
        let best: StripTag | null = null;
        let bestIdx = Infinity;
        for (const tag of STRIP_TAGS) {
          const open = `<${tag}>`;
          const idx = this._buf.indexOf(open);
          if (idx !== -1 && idx < bestIdx) { bestIdx = idx; best = tag; }
        }

        if (best) {
          out += this._buf.slice(0, bestIdx);
          this._buf = this._buf.slice(bestIdx + `<${best}>`.length);
          this._inTag = true;
          this._tagName = best;
        } else {
          // 保留可能的不完整开标签（如 "<moo"）
          let hold = 0;
          for (const tag of STRIP_TAGS) {
            const open = `<${tag}>`;
            for (let len = 1; len < open.length; len++) {
              if (this._buf.endsWith(open.slice(0, len)) && len > hold) hold = len;
            }
          }
          out += this._buf.slice(0, this._buf.length - hold);
          this._buf = this._buf.slice(this._buf.length - hold);
          break;
        }
      }
    }

    // ── 媒体拦截：从 out 中剥离 MEDIA: 和 ![](url) ──
    out = this._interceptMedia(out);

    this.cleaned += out;
    return out;
  }

  /**
   * 从文本增量中拦截媒体标记，返回剥离后的干净文本。
   * 使用行缓冲处理 delta 分片边界（如 "MED" + "IA:https://..."）。
   * 只有遇到换行时才处理完整行，未完成的行 hold 在 _lineBuf 中。
   */
  private _interceptMedia(text: string): string {
    if (!text) return text;

    // 把新文本追加到行缓冲
    this._lineBuf += text;

    // 按换行拆分：最后一段如果没有换行，留在 _lineBuf 等下一个 delta
    const parts = this._lineBuf.split("\n");
    this._lineBuf = parts.pop() ?? ""; // 最后一段（可能不完整）留着

    const cleaned: string[] = [];
    for (const line of parts) {
      const processed = this._processLine(line);
      if (processed !== null) cleaned.push(processed);
    }

    return cleaned.length ? cleaned.join("\n") + "\n" : "";
  }

  /** 处理一行完整文本，返回 null 表示该行被媒体拦截移除 */
  private _processLine(line: string): string | null {
    const trimmed = line.trim();
    // 追踪 code fence 状态
    if (trimmed.startsWith("```")) {
      this._inCodeFence = !this._inCodeFence;
      return line;
    }
    if (this._inCodeFence) return line;

    // MEDIA:<source> 指令行（支持 URL 和本地路径，路径可含空格）
    const mediaMatch = /^MEDIA:\s*<?(.+?)>?\s*$/.exec(trimmed);
    if (mediaMatch) {
      const source = mediaMatch[1].trim();
      // 接受 http(s) URL、file:// URI、绝对路径
      const isHttp = source.startsWith("http://") || source.startsWith("https://");
      const isFile = source.startsWith("file://") || path.isAbsolute(source);
      if (isHttp || isFile) {
        this.extractedMedia.push(source);
      }
      return null; // 无论是否有效都从输出中移除（不泄漏路径）
    }

    // ![alt](url) — 整行是图片标记时拦截
    const imgMatch = /^!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)\s*$/.exec(trimmed);
    if (imgMatch) {
      this.extractedMedia.push(imgMatch[1]);
      return null;
    }

    return line;
  }

  /** 流结束时 flush 行缓冲中剩余的不完整行 */
  flushLineBuf(): string {
    if (!this._lineBuf) return "";
    const line = this._lineBuf;
    this._lineBuf = "";
    const processed = this._processLine(line);
    return processed !== null ? processed : "";
  }
}

/* ── BlockChunker ─────────────────────────────────────────
 * 将流式文本按行拆成多条消息（block streaming）。
 *
 * 规则：换行即分块，但 markdown 结构内不拆。
 *   普通行 + \n → flush 为一条气泡
 *   列表 / 代码围栏 / 表格 / 引用 → 积累为一整块
 *   标题（# ）→ 开启「节模式」，节内所有内容攒成一个气泡，
 *              下一个标题触发 flush 并开启新节
 *   结构块结束后恢复逐行发送
 */
export class BlockChunker {
  private readonly _onFlush: (text: string) => Promise<void>;
  private readonly _maxChars: number;
  private _buf = "";
  private _flushing: Promise<void> = Promise.resolve();
  private _inCodeFence = false;
  private _structured = false;
  private _inSection = false;
  private _sectionHasContent = false;
  private _currentLine = "";

  constructor({ onFlush, maxChars = 2000 }: { onFlush: (text: string) => Promise<void>; maxChars?: number }) {
    this._onFlush = onFlush;
    this._maxChars = maxChars;
  }

  /** 喂入清理后的文本增量 */
  feed(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      this._buf += ch;
      this._currentLine += ch;
      if (ch === '\n') {
        this._onLineEnd(this._currentLine);
        this._currentLine = "";
      }
    }
    // 安全：无换行的超长文本强制 flush
    if (this._buf.length >= this._maxChars && !this._inCodeFence) {
      this._flushBuf();
    }
  }

  /** 流结束：flush 剩余 buffer */
  async finish(): Promise<void> {
    await this._flushing;
    const rest = this._buf.trim();
    if (rest) {
      await this._onFlush(rest);
      this._buf = "";
    }
    this._currentLine = "";
  }

  private _onLineEnd(line: string): void {
    const stripped = line.replace(/\n$/, '');
    const trimmed = stripped.trim();
    const isEmpty = trimmed === '';

    // ── 代码围栏 ──
    if (trimmed.startsWith('```')) {
      if (this._inCodeFence) {
        // 关闭围栏：flush 整个代码块（含 ``` 行）
        this._inCodeFence = false;
        this._flushBuf();
      } else {
        // 打开围栏：先 flush 围栏前的内容
        this._inCodeFence = true;
        const cutAt = this._buf.length - line.length;
        if (cutAt > 0) this._flushAt(cutAt);
      }
      return;
    }
    if (this._inCodeFence) return;

    // ── 标题：开启/切换节 ──
    const isHeading = /^#{1,6} /.test(trimmed);
    if (isHeading) {
      // flush 标题前的内容（上一节 / 普通行 / 结构块）
      const cutAt = this._buf.length - line.length;
      if (cutAt > 0) this._flushAt(cutAt);
      this._inSection = true;
      this._sectionHasContent = false;
      this._structured = false;
      return;
    }

    // ── 节内：积累，有内容后遇段落空行才 flush ──
    if (this._inSection) {
      if (!isEmpty) this._sectionHasContent = true;
      if (isEmpty && this._sectionHasContent && this._buf.slice(0, -1).endsWith('\n')) {
        this._flushBuf();
        this._inSection = false;
      }
      return;
    }

    // ── 结构化内容（列表 / 表格 / 引用）──
    const isList = /^[ \t]*[-*+] /.test(stripped) || /^[ \t]*\d+[.)]\s/.test(stripped);
    const isTable = /^[ \t]*\|.*\|/.test(stripped);
    const isBlockquote = /^[ \t]*>/.test(stripped);
    const isStructured = isList || isTable || isBlockquote;

    if (isStructured) {
      this._structured = true;
      return;
    }
    if (this._structured && isEmpty) return; // 结构块内空行

    if (this._structured) {
      // 结构块结束：flush 结构内容，当前行留在 buf
      this._structured = false;
      const cutAt = this._buf.length - line.length;
      if (cutAt > 0) this._flushAt(cutAt);
      // fall through：当前行按普通行处理
    }

    // ── 普通行：非空则 flush ──
    if (!isEmpty && this._buf.trim()) {
      this._flushBuf();
    }
  }

  /** flush 整个 buf */
  private _flushBuf(): void {
    const content = this._buf.trim();
    this._buf = "";
    if (content) {
      this._flushing = this._flushing.then(() => this._onFlush(content)).catch((err: unknown) => {
        console.error("[BlockChunker] flush error:", errorMessage(err));
      });
    }
  }

  /** flush buf 前 cutAt 个字符，保留剩余 */
  private _flushAt(cutAt: number): void {
    const content = this._buf.slice(0, cutAt).trim();
    this._buf = this._buf.slice(cutAt);
    if (content) {
      this._flushing = this._flushing.then(() => this._onFlush(content)).catch((err: unknown) => {
        console.error("[BlockChunker] flush error:", errorMessage(err));
      });
    }
  }
}

/** 生成紧凑时间标记：<t>MM-DD HH:mm</t> */
export function timeTag(ts = Date.now()): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `<t>${mm}-${dd} ${hh}:${mi}</t>`;
}
