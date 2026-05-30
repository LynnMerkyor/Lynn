import { dim } from "./terminal-style.js";
import { visibleLength } from "./startup.js";

export interface InputBandOptions {
  prompt: string;
  value: string;
  placeholder?: string;
  width?: number;
  color?: boolean;
}

export function renderInputBand(options: InputBandOptions): string {
  const prompt = options.prompt;
  const value = options.value;
  const placeholder = options.placeholder || "";
  const width = Math.max(20, options.width || 80);
  const text = value || placeholder;
  const visual = value ? text : placeholder ? dim(text, !!options.color) : "";
  const rawVisible = `${prompt}${text}`;
  const rendered = `${prompt}${visual}`;
  const pad = Math.max(0, width - visibleLength(rawVisible));
  const line = `${rendered}${" ".repeat(pad)}`;
  return options.color ? `\x1b[48;5;236m${line}\x1b[0m` : line;
}
