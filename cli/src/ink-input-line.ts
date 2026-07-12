import React from "react";
import { Box, Text, useStdout } from "ink";
import { completeSlash, normalizeSlashInput } from "./completion.js";
import { t } from "./i18n.js";
import { visibleLength } from "./startup.js";

export interface InkInputLineProps {
  value: string;
  placeholder: string;
  cursorIndex?: number;
  focused?: boolean;
  danger?: boolean;
  commands?: string[];
  contextSummary?: string;
}

export function InkInputLine({ value, placeholder, cursorIndex, focused = true, danger, commands = [], contextSummary = "" }: InkInputLineProps): React.ReactElement {
  const { stdout } = useStdout();
  const prompt = "› ";
  const width = Math.max(20, (stdout.columns || 80) - 2);
  const hint = slashHint(value, commands, width - visibleLength(prompt));
  const paletteItems = slashPaletteItems(value, commands);
  const showUnknownSlash = !paletteItems.length && normalizeSlashInput(value).startsWith("/") && commands.length > 0;
  const visibleText = value || placeholder;
  const rows = inputDisplayRows(visibleText, hint, width, prompt);
  const cursor = Math.max(0, Math.min(cursorIndex ?? Array.from(value).length, Array.from(value).length));
  let rowOffset = 0;
  const borderColor = danger ? "red" : "gray";
  return React.createElement(Box, { marginTop: 1, flexDirection: "column" },
    paletteItems.length
      ? React.createElement(Text, null, ...paletteItems.flatMap((item, i) => [
          i ? React.createElement(Text, { key: `sep${i}`, color: "gray" }, "   ") : null,
          React.createElement(Text, { key: `cmd${i}`, color: "cyan" }, item.command),
          item.label ? React.createElement(Text, { key: `lbl${i}`, dimColor: true }, ` ${item.label}`) : null,
        ].filter(Boolean)))
      : showUnknownSlash ? React.createElement(Text, { color: "yellow" }, t("slash.unknown")) : null,
    contextSummary ? React.createElement(Text, { color: "cyan" }, `已加入本轮上下文: ${contextSummary}`) : null,
    React.createElement(Box, { borderStyle: "single", borderColor, paddingX: 1, flexDirection: "column" },
      ...rows.map((row, index) => {
        const rowLength = Array.from(row.text).length;
        const cursorColumn = value && focused && cursor >= rowOffset && cursor <= rowOffset + rowLength
          ? cursor - rowOffset
          : null;
        rowOffset += rowLength + (index < rows.length - 1 ? 1 : 0);
        return React.createElement(Box, { key: index },
        React.createElement(Text, { color: "white" }, row.prompt),
        value
          ? renderEditableText(row.text, cursorColumn)
          : React.createElement(React.Fragment, null,
            focused ? React.createElement(Text, { inverse: true }, " ") : null,
            React.createElement(Text, { color: "gray" }, row.text),
          ),
        row.hint ? React.createElement(Text, { color: "cyan", dimColor: true }, ` ${row.hint}`) : null,
        row.pad ? React.createElement(Text, null, " ".repeat(row.pad)) : null,
        );
      }),
    ),
  );
}

function renderEditableText(value: string, cursorColumn: number | null): React.ReactElement {
  if (cursorColumn === null) return React.createElement(Text, { color: "white" }, value);
  const chars = Array.from(value);
  const before = chars.slice(0, cursorColumn).join("");
  const cursorChar = chars[cursorColumn] || " ";
  const after = chars.slice(cursorColumn + (chars[cursorColumn] ? 1 : 0)).join("");
  return React.createElement(Text, { color: "white" },
    before,
    React.createElement(Text, { inverse: true }, cursorChar),
    after,
  );
}

export interface InputBufferState {
  value: string;
  cursor: number;
}

export type InputEditAction =
  | { type: "insert"; text: string }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" };

export function editInputBuffer(value: string, cursorIndex: number, action: InputEditAction): InputBufferState {
  const chars = Array.from(value);
  const cursor = Math.max(0, Math.min(cursorIndex, chars.length));
  if (action.type === "insert") {
    const inserted = Array.from(action.text);
    chars.splice(cursor, 0, ...inserted);
    return { value: chars.join(""), cursor: cursor + inserted.length };
  }
  if (action.type === "backspace") {
    if (cursor > 0) chars.splice(cursor - 1, 1);
    return { value: chars.join(""), cursor: Math.max(0, cursor - 1) };
  }
  if (action.type === "delete") {
    if (cursor < chars.length) chars.splice(cursor, 1);
    return { value: chars.join(""), cursor };
  }
  if (action.type === "left") return { value, cursor: Math.max(0, cursor - 1) };
  if (action.type === "right") return { value, cursor: Math.min(chars.length, cursor + 1) };
  if (action.type === "home") return { value, cursor: 0 };
  return { value, cursor: chars.length };
}

export function stripBracketedPasteMarkers(value: string): string {
  return value
    .replace(/\u001b\[(?:200|201)~/g, '')
    .replace(/^\[200~/, '')
    .replace(/\[201~$/, '');
}

export function inputDisplayRows(value: string, hint: string, width: number, prompt = "› "): Array<{ prompt: string; text: string; hint: string; pad: number }> {
  const lines = value.split(/\n/);
  const rows = lines.length ? lines : [""];
  const multiline = rows.length > 1;
  return rows.map((line, index) => {
    const rowPrompt = index === 0 ? prompt : "  ";
    const rowHint = !multiline && index === rows.length - 1 ? hint : "";
    const rawWidth = visibleLength(`${rowPrompt}${line}${rowHint ? ` ${rowHint}` : ""}`);
    return {
      prompt: rowPrompt,
      text: line,
      hint: rowHint,
      pad: multiline ? 0 : Math.max(0, width - rawWidth),
    };
  });
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

export function slashPalette(input: string, commands: string[], maxItems = 6): string {
  const normalized = normalizeSlashInput(input);
  if (!normalized.startsWith("/") || !commands.length) return "";
  const completion = completeSlash(normalized, commands);
  if (!completion.matches.length) return t("slash.unknown");
  return completion.matches
    .slice(0, maxItems)
    .map((command) => `${command} ${slashCommandLabel(command)}`.trim())
    .join("   ");
}

export function slashPaletteItems(input: string, commands: string[], maxItems = 6): { command: string; label: string }[] {
  const normalized = normalizeSlashInput(input);
  if (!normalized.startsWith("/") || !commands.length) return [];
  const completion = completeSlash(normalized, commands);
  if (!completion.matches.length) return [];
  return completion.matches.slice(0, maxItems).map((command) => ({ command, label: slashCommandLabel(command) }));
}

function slashCommandLabel(command: string): string {
  const key = command.split(/\s+/)[0];
  switch (key) {
    case "/model":
      return t("slash.label.model");
    case "/providers":
    case "/byok":
    case "/setup":
      return t("slash.label.providers");
    case "/mode":
      return t("slash.label.mode");
    case "/yolo":
      return t("slash.label.yolo");
    case "/ask":
      return t("slash.label.ask");
    case "/fast":
      return t("slash.label.fast");
    case "/think":
    case "/reasoning":
      return t("slash.label.think");
    case "/help":
      return t("slash.label.help");
    case "/exit":
    case "/quit":
      return t("slash.label.exit");
    case "/tools":
      return t("slash.label.tools");
    case "/clear":
      return t("slash.label.clear");
    case "/image":
    case "/images":
    case "/attach":
      return t("slash.label.image");
    default:
      return "";
  }
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
