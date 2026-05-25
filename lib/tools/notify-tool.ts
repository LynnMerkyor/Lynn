/**
 * notify-tool.js — 桌面通知工具
 *
 * 让 agent 能主动向用户发送系统通知（macOS 桌面弹窗）。
 * 仅在用户明确要求提醒/通知时使用，普通任务完成不调用。
 */

import { Type } from "@sinclair/typebox";
import { t } from "../../shared/i18n-runtime.js";

type NotifyToolOptions = {
  onNotify?: (title: string, body: string) => Promise<void> | void;
};

type NotifyToolParams = {
  title?: unknown;
  body?: unknown;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 */
export function createNotifyTool({ onNotify }: NotifyToolOptions) {
  return {
    name: "notify",
    label: t("toolDef.notify.label"),
    description: t("toolDef.notify.description"),
    parameters: Type.Object({
      title: Type.String({ description: t("toolDef.notify.titleDesc") }),
      body: Type.String({ description: t("toolDef.notify.bodyDesc") }),
    }),
    execute: async (_toolCallId: string, params: NotifyToolParams) => {
      const title = String(params?.title || "");
      const body = String(params?.body || "");
      try {
        await onNotify?.(title, body);
        return {
          content: [{ type: "text", text: t("error.notifySent", { title }) }],
          details: { title, body, sent: true },
        };
      } catch (err) {
        const msg = errorMessage(err);
        return {
          content: [{ type: "text", text: t("error.notifyFailed", { msg }) }],
          details: { title, body, sent: false, error: msg },
        };
      }
    },
  };
}
