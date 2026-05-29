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
    const width = 18;
    const pos = this.frame % (width + 1);
    const bar = Array.from({ length: width }, (_, i) => (i === pos ? "█" : i === pos - 1 || i === pos + 1 ? "▓" : "░")).join("");
    this.stream.write(`\r${this.label} ${bar}`);
    this.frame += 1;
  }
}
