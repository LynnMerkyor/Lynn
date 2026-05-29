import { cyan, supportsColor } from "./terminal-style.js";

export class TerminalSpinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private active = false;

  constructor(
    private readonly stream: NodeJS.WriteStream,
    private readonly label = "Lynn is thinking",
  ) {}

  start(): void {
    if (this.active || !this.stream.isTTY) return;
    this.active = true;
    this.render();
    this.timer = setInterval(() => this.render(), 90);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.stream.isTTY) this.stream.write(`\r${" ".repeat(80)}\r`);
  }

  private render(): void {
    const width = 28;
    const pos = this.frame % (width + 5);
    const color = supportsColor(this.stream);
    const bar = Array.from({ length: width }, (_, i) => {
      const distance = Math.abs(i - pos);
      if (distance === 0) return "█";
      if (distance === 1) return "▓";
      if (distance === 2) return "▒";
      return "·";
    }).join("");
    this.stream.write(`\r${this.label} ${cyan(bar, color)}`);
    this.frame += 1;
  }
}
