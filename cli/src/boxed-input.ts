import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { brightCyan, bold, dim, supportsColor } from "./terminal-style.js";
import { visibleLength } from "./startup.js";
import { completeSlash } from "./completion.js";
import { HistoryNavigator } from "./history.js";

const ESC = "\x1b";

export interface BoxedInputOptions {
  status?: string;
  placeholder?: string;
  history?: HistoryNavigator;
  completions?: string[];
  onShiftTab?: () => string | void;
}

export interface BoxRender {
  top: string;
  inputLine: string;
  bottom: string;
  cursorCol: number;
}

function charWidth(ch: string): number {
  return Math.max(1, visibleLength(ch));
}

function clampWidth(width: number): number {
  return Math.max(28, Math.min(width || 80, 110));
}

function truncateToWidth(text: string, max: number): string {
  if (visibleLength(text) <= max) return text;
  let out = "";
  let used = 0;
  for (const ch of Array.from(text)) {
    const cw = charWidth(ch);
    if (used + cw > max - 1) break;
    out += ch;
    used += cw;
  }
  return `${out}…`;
}

export function renderInputBox(opts: {
  status: string;
  buffer: string;
  cursor: number;
  width: number;
  color: boolean;
  placeholder?: string;
}): BoxRender {
  const { status, buffer, cursor, color } = opts;
  const w = clampWidth(opts.width);
  const textArea = w - 6;
  const chars = Array.from(buffer);

  const starts: number[] = [];
  let acc = 0;
  for (const ch of chars) {
    starts.push(acc);
    acc += charWidth(ch);
  }
  const totalCols = acc;
  let beforeCursor = 0;
  for (let i = 0; i < cursor && i < chars.length; i += 1) beforeCursor += charWidth(chars[i]);

  let winStart = 0;
  if (totalCols > textArea) winStart = Math.max(0, beforeCursor - textArea + 1);

  const empty = chars.length === 0;
  let visibleText = "";
  let used = 0;
  if (empty && opts.placeholder) {
    for (const ch of Array.from(opts.placeholder)) {
      const cw = charWidth(ch);
      if (used + cw > textArea) break;
      visibleText += ch;
      used += cw;
    }
    visibleText = dim(visibleText, color);
  } else {
    for (let i = 0; i < chars.length; i += 1) {
      const c0 = starts[i];
      const cw = charWidth(chars[i]);
      if (c0 < winStart) continue;
      if (c0 - winStart + cw > textArea) break;
      visibleText += chars[i];
      used += cw;
    }
  }
  const pad = " ".repeat(Math.max(0, textArea - used));

  const left = `${dim("│", color)} ${brightCyan("›", color)} `;
  const right = ` ${dim("│", color)}`;
  const inputLine = `${left}${visibleText}${pad}${right}`;
  const cursorCol = 4 + (empty ? 0 : beforeCursor - winStart);

  const rawLabel = ` ${truncateToWidth(status, w - 7)} `;
  const fill = Math.max(2, w - 3 - visibleLength(rawLabel));
  const top = `${dim("╭─", color)}${bold(rawLabel, color)}${dim("─".repeat(fill) + "╮", color)}`;
  const bottom = dim(`╰${"─".repeat(w - 2)}╯`, color);

  return { top, inputLine, bottom, cursorCol };
}

export async function readBoxedInputLine(options: BoxedInputOptions = {}): Promise<string | null> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    const rl = readline.createInterface({ input, output, terminal: false });
    try {
      return await rl.question("› ");
    } finally {
      rl.close();
    }
  }

  const color = supportsColor(output);
  const status = options.status || "";
  const placeholder = options.placeholder || "";
  let buf: string[] = [];
  let cur = 0;
  const value = () => buf.join("");
  const width = () => Math.max(28, Math.min((typeof output.columns === "number" ? output.columns : 80) - 1, 110));

  const rawBefore = input.isRaw;
  input.setRawMode(true);
  input.resume();

  const render = () => renderInputBox({ status, buffer: value(), cursor: cur, width: width(), color, placeholder });
  const toCol = (col: number) => (col > 0 ? `${ESC}[${col}C` : "");

  const paint = () => {
    const r = render();
    output.write(`\r${r.top}\r\n${r.inputLine}\r\n${r.bottom}`);
    output.write(`${ESC}[1A\r${toCol(r.cursorCol)}`);
  };
  const redrawInput = () => {
    const r = render();
    output.write(`\r${ESC}[K${r.inputLine}\r${toCol(r.cursorCol)}`);
  };
  const printAbove = (message: string) => {
    output.write(`${ESC}[1A\r${ESC}[J${message}\n`);
    paint();
  };
  const leaveBelow = (tail = "") => {
    output.write(`${ESC}[1B\r\n${tail}`);
  };

  return await new Promise<string | null>((resolve) => {
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(rawBefore);
      input.pause();
    };
    const insert = (text: string) => {
      const printable = Array.from(text).filter((ch) => ch >= " " && ch !== "\x7f");
      if (!printable.length) return;
      buf.splice(cur, 0, ...printable);
      cur += printable.length;
      redrawInput();
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");

      const nl = text.search(/[\r\n]/);
      if (nl >= 0) {
        const before = Array.from(text.slice(0, nl)).filter((ch) => ch >= " " && ch !== "\x7f");
        if (before.length) { buf.splice(cur, 0, ...before); cur += before.length; }
        leaveBelow();
        cleanup();
        resolve(value());
        return;
      }
      if (text === "\x03") { leaveBelow(color ? `${dim("^C", color)}\n` : "^C\n"); cleanup(); resolve(null); return; }
      if (text === "\x04") { if (!buf.length) { leaveBelow(); cleanup(); resolve(null); } return; }
      if (text === `${ESC}[Z`) {
        const message = options.onShiftTab?.();
        if (message) printAbove(message.replace(/\n+$/, ""));
        else redrawInput();
        return;
      }
      if (text === "\x7f" || text === "\b") {
        if (cur > 0) { buf.splice(cur - 1, 1); cur -= 1; redrawInput(); }
        return;
      }
      if (text === `${ESC}[D`) { cur = Math.max(0, cur - 1); redrawInput(); return; }
      if (text === `${ESC}[C`) { cur = Math.min(buf.length, cur + 1); redrawInput(); return; }
      if (text === `${ESC}[H` || text === "\x01") { cur = 0; redrawInput(); return; }
      if (text === `${ESC}[F` || text === "\x05") { cur = buf.length; redrawInput(); return; }
      if (text === `${ESC}[A` && options.history) { buf = Array.from(options.history.prev(value())); cur = buf.length; redrawInput(); return; }
      if (text === `${ESC}[B` && options.history) { buf = Array.from(options.history.next()); cur = buf.length; redrawInput(); return; }
      if (text === "\t" && options.completions) {
        const completion = completeSlash(value(), options.completions);
        if (completion.matches.length > 1) printAbove(completion.matches.join("  "));
        buf = Array.from(completion.completed);
        cur = buf.length;
        if (completion.matches.length <= 1) redrawInput();
        return;
      }
      if (text.startsWith(ESC)) return;
      insert(text);
    };

    input.on("data", onData);
    paint();
  });
}
