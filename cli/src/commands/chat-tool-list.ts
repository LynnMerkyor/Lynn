import { t } from "../i18n.js";
import { dim } from "../terminal-style.js";
import { CLIENT_TOOL_DEFINITIONS } from "../tools/registry.js";

export function renderLocalToolList(color: boolean): string {
  return CLIENT_TOOL_DEFINITIONS
    .map((tool) => {
      const suffix = tool.dangerous ? t("tool.approval.suffix") : "";
      return `${tool.name}${suffix}: ${dim(tool.description, color)}`;
    })
    .join("\n");
}
