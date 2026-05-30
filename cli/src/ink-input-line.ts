import React from "react";
import { Box, Text, useCursor, useStdout } from "ink";
import { completeSlash } from "./completion.js";
import { visibleLength } from "./startup.js";

export interface InkInputLineProps {
  value: string;
  placeholder: string;
  danger?: boolean;
  commands?: string[];
}

export function InkInputLine({ value, placeholder, danger, commands = [] }: InkInputLineProps): React.ReactElement {
  const { stdout } = useStdout();
  const { setCursorPosition } = useCursor();
  const prompt = "› ";
  const width = Math.max(20, (stdout.columns || 80) - 2);
  const hint = slashHint(value, commands, width - visibleLength(prompt));
  const visibleText = value || placeholder;
  const cursorX = Math.min(width - 1, visibleLength(`${prompt}${value}`));
  const rawWidth = visibleLength(`${prompt}${visibleText}${hint ? ` ${hint}` : ""}`);
  const pad = Math.max(0, width - rawWidth);
  setCursorPosition({ x: cursorX, y: Number.MAX_SAFE_INTEGER });
  const backgroundColor = danger ? "red" : "gray";
  return React.createElement(Box, { marginTop: 1 },
    React.createElement(Text, { backgroundColor, color: "white" }, prompt),
    React.createElement(Text, { backgroundColor, color: value ? "white" : "black" }, visibleText),
    hint ? React.createElement(Text, { backgroundColor, color: "black" }, ` ${hint}`) : null,
    pad ? React.createElement(Text, { backgroundColor }, " ".repeat(pad)) : null,
  );
}

export function slashHint(input: string, commands: string[], maxWidth = 72): string {
  if (!input.startsWith("/") || !commands.length) return "";
  const completion = completeSlash(input, commands);
  if (!completion.matches.length) return "";
  const suffix = completion.completed.length > input.length ? completion.completed.slice(input.length) : "";
  const candidates = completion.matches.slice(0, suffix ? 4 : 5).join("  ");
  const hint = suffix ? `${suffix}    ${candidates}` : candidates;
  return truncateMiddle(hint, Math.max(8, maxWidth - visibleLength(input) - 4));
}

function truncateMiddle(value: string, maxWidth: number): string {
  if (visibleLength(value) <= maxWidth) return value;
  if (maxWidth <= 3) return "...".slice(0, maxWidth);
  const headWidth = Math.max(1, Math.floor((maxWidth - 3) / 2));
  const tailWidth = Math.max(1, maxWidth - 3 - headWidth);
  return `${takeVisible(value, headWidth)}...${takeVisibleFromEnd(value, tailWidth)}`;
}

function takeVisible(value: string, maxWidth: number): string {
  let out = "";
  let used = 0;
  for (const char of Array.from(value)) {
    const next = visibleLength(char);
    if (used + next > maxWidth) break;
    out += char;
    used += next;
  }
  return out;
}

function takeVisibleFromEnd(value: string, maxWidth: number): string {
  let out = "";
  let used = 0;
  for (const char of Array.from(value).reverse()) {
    const next = visibleLength(char);
    if (used + next > maxWidth) break;
    out = `${char}${out}`;
    used += next;
  }
  return out;
}
