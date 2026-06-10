import { bold, brightCyan, cyan, dim, green, orange, red, supportsColor, yellow } from "./terminal-style.js";
import { t } from "./i18n.js";
import { visibleLength } from "./startup.js";
import { terminalTuiProfile } from "./terminal-safety.js";

export function renderSweepFrame(width: number, frame: number, color: boolean, lowFrequency = false, danger = false): string {
  const safeWidth = Math.max(8, width);
  const effectiveFrame = lowFrequency ? Math.floor(frame / 3) : frame;
  const head = (effectiveFrame % (safeWidth + 8)) - 4;
  return Array.from({ length: safeWidth }, (_, i) => {
    const distance = Math.abs(i - head);
    if (distance === 0) return danger ? orange("━", color) : brightCyan("━", color);
    if (distance <= 1) return danger ? yellow("━", color) : cyan("━", color);
    if (distance <= 3) return dim("─", color);
    return " ";
  }).join("");
}

export function renderShimmerText(text: string, frame: number, color: boolean, lowFrequency = false, danger = false): string {
  if (!color) return text;
  const chars = Array.from(text);
  if (!chars.length) return text;
  const effectiveFrame = lowFrequency ? Math.floor(frame / 3) : frame;
  const head = effectiveFrame % (chars.length + 6);
  return chars.map((char, i) => {
    const distance = Math.abs(i - head);
    if (distance === 0) return danger ? orange(char, color) : brightCyan(char, color);
    if (distance <= 1) return danger ? yellow(char, color) : cyan(char, color);
    if (distance <= 3) return dim(char, color);
    return char;
  }).join("");
}

export function renderSoftShimmer(text: string, frame: number, color: boolean, lowFrequency = false, danger = false): string {
  if (!color) return text;
  const chars = Array.from(text);
  if (!chars.length) return text;
  const effectiveFrame = lowFrequency ? Math.floor(frame / 3) : frame;
  const head = effectiveFrame % (chars.length + 4);
  return chars.map((char, i) => {
    const distance = Math.abs(i - head);
    if (distance === 0) return danger ? orange(char, color) : brightCyan(char, color);
    if (distance <= 1) return danger ? yellow(char, color) : cyan(char, color);
    return dim(char, color);
  }).join("");
}

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function brailleGlyph(frame: number, lowFrequency = false): string {
  const effectiveFrame = lowFrequency ? Math.floor(frame / 2) : frame;
  return BRAILLE_FRAMES[((effectiveFrame % BRAILLE_FRAMES.length) + BRAILLE_FRAMES.length) % BRAILLE_FRAMES.length];
}

export function renderQuietShimmer(label: string, frame: number, color: boolean, lowFrequency = false, danger = false): string {
  const glyph = color ? (danger ? yellow(brailleGlyph(frame, lowFrequency), color) : cyan(brailleGlyph(frame, lowFrequency), color)) : brailleGlyph(frame, lowFrequency);
  return `${glyph} ${renderSoftShimmer(label, frame, color, lowFrequency, danger)}`;
}

export type CardKind = "tool" | "run" | "ok" | "error" | "plan" | "info";

function cardGutter(kind: CardKind, color: boolean): string {
  const bar = "│";
  switch (kind) {
    case "tool":
    case "run":
      return cyan(bar, color);
    case "ok":
      return green(bar, color);
    case "error":
      return red(bar, color);
    case "plan":
      return yellow(bar, color);
    default:
      return dim(bar, color);
  }
}

function cardGlyph(kind: CardKind): string {
  switch (kind) {
    case "tool":
      return "🔧";
    case "run":
      return "⏳";
    case "ok":
      return "✓";
    case "error":
      return "✗";
    case "plan":
      return "◷";
    default:
      return "•";
  }
}

export interface CardInput {
  kind: CardKind;
  title: string;
  body?: string[];
}

export function renderCard(card: CardInput, color: boolean): string {
  const gutter = cardGutter(card.kind, color);
  const head = `${gutter} ${cardGlyph(card.kind)} ${bold(card.title, color)}`;
  const body = (card.body || []).map((line) => `${gutter}   ${dim(line, color)}`);
  return [head, ...body].join("\n");
}

export interface PlanStep {
  status: "pending" | "in_progress" | "completed";
  text: string;
}

function planGlyph(status: PlanStep["status"], color: boolean): string {
  if (status === "completed") return green("✓", color);
  if (status === "in_progress") return cyan("●", color);
  return dim("○", color);
}

export function renderPlanCard(steps: PlanStep[], color: boolean, title = "Plan"): string {
  const gutter = yellow("│", color);
  const head = `${gutter} ${cardGlyph("plan")} ${bold(title, color)}`;
  const lines = steps.map((step) => {
    const text = step.status === "completed" ? dim(step.text, color) : step.text;
    return `${gutter}   ${planGlyph(step.status, color)} ${text}`;
  });
  return [head, ...lines].join("\n");
}

export function renderPromptFrame(status: string, width: number, color: boolean): string {
  const w = Math.max(28, Math.min(width || 80, 110));
  const inner = w - 4;
  const shown = visibleLength(status) > inner ? `${status.slice(0, Math.max(1, inner - 1))}…` : status;
  const pad = " ".repeat(Math.max(0, inner - visibleLength(shown)));
  const top = dim(`╭${"─".repeat(w - 2)}╮`, color);
  const mid = `${dim("│", color)} ${bold(shown, color)}${pad} ${dim("│", color)}`;
  const bot = dim(`╰${"─".repeat(w - 2)}╯`, color);
  return `${top}\n${mid}\n${bot}\n${brightCyan("›", color)} `;
}

export interface TerminalSpinnerOptions {
  quiet?: boolean;
  danger?: boolean;
}

export class TerminalSpinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private active = false;

  constructor(
    private readonly stream: NodeJS.WriteStream,
    private label = t("spinner.thinking"),
    private readonly options: TerminalSpinnerOptions = {},
  ) {}

  /** Live-update the waiting label (e.g. thinking progress: tokens + elapsed) without restarting. */
  setLabel(label: string): void {
    if (label) this.label = label;
  }

  start(): void {
    if (this.active || !this.stream.isTTY) return;
    this.active = true;
    const profile = terminalTuiProfile();
    if (!profile.waitAnimation) {
      this.stream.write(`\r${this.label}`);
      return;
    }
    this.render();
    const interval = profile.appleTerminal ? 110 : 90;
    this.timer = setInterval(() => this.render(), interval);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.stream.isTTY) {
      const clearWidth = this.clearWidth();
      this.stream.write(`\r${" ".repeat(Math.max(clearWidth, 80))}\r`);
    }
  }

  render(): void {
    const color = supportsColor(this.stream);
    const availableWidth = this.clearWidth() - visibleLength(this.label) - 5;

    if (availableWidth < 12) {
      this.stream.write(`\r${this.label}`);
      this.frame += 1;
      return;
    }

    if (this.options.quiet) {
      this.stream.write(`\r${renderQuietShimmer(this.label, this.frame, color, false, this.options.danger)}`);
    } else {
      const width = Math.min(42, Math.max(18, availableWidth));
      this.stream.write(`\r${renderSoftShimmer(this.label, this.frame, color, false, this.options.danger)} ${renderSweepFrame(width, this.frame, color, false, this.options.danger)}`);
    }
    this.frame += 1;
  }

  private clearWidth(): number {
    return Math.max(80, typeof this.stream.columns === "number" ? this.stream.columns : 0);
  }
}

export function runShimmerDemo(stream: NodeJS.WriteStream = process.stdout): void {
  const color = supportsColor(stream);
  const line = (s = "") => stream.write(`${s}\n`);
  const thinking = t("spinner.thinking");

  line();
  line(bold("  Lynn · 流光扫描 + 彩色卡片 DEMO", color));
  line(dim("  terminal renderer sample", color));
  line();

  line(dim("  ① 低噪音流光:", color));
  for (let frame = 0; frame < 10; frame += 1) {
    line(`  ${renderQuietShimmer(thinking, frame, color)}`);
  }
  line();

  line(dim("  ② 扫描条变体:", color));
  for (let frame = 0; frame < 6; frame += 1) {
    line(`  ${renderShimmerText("Working", frame, color)} ${renderSweepFrame(28, frame, color)}`);
  }
  line();

  line(dim("  ③ 工具卡片:", color));
  line(renderCard({ kind: "tool", title: "web_search · running", body: ["query: StepFun 3.7 Flash TPS"] }, color));
  line(renderCard({ kind: "ok", title: "web_search · done · 1.2s", body: ["3 results · top: artificialanalysis.ai"] }, color));
  line(renderCard({ kind: "error", title: "bash · failed · exit 1", body: ["npm test: 2 failing"] }, color));
  line(renderCard({ kind: "info", title: "route: StepFun 3.7 Flash", body: ["256K ctx · think auto"] }, color));
  line();

  line(dim("  ④ 计划卡片:", color));
  line(renderPlanCard([
    { status: "completed", text: "读取 v0803 渲染层" },
    { status: "completed", text: "整理终端渲染状态" },
    { status: "in_progress", text: "实现低噪音流光扫描" },
    { status: "pending", text: "接入 readline 聊天流「思考中」" },
  ], color));
  line();

  line(dim("  ⑤ footer:", color));
  line(`  ${dim("StepFun 3.7 Flash · ~ · ask / workspace-write · think auto · decode 211 TPS", color)}`);
  line();
}
