import { t } from "./i18n.js";

const CHAT_PLACEHOLDER_KEYS = [
  "chat.placeholder.yolo",
  "chat.placeholder.route",
  "chat.placeholder.media",
];

const CODE_PLACEHOLDER_KEYS = [
  "code.placeholder.yolo",
  "code.placeholder.longrun",
  "code.placeholder.context",
];

export function rotatingPlaceholder(kind: "chat" | "code", frame: number): string {
  const keys = kind === "chat" ? CHAT_PLACEHOLDER_KEYS : CODE_PLACEHOLDER_KEYS;
  return t(keys[Math.abs(frame) % keys.length] || keys[0]!);
}
