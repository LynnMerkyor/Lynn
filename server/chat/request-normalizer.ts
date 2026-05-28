import { normalizeVisionPromptText } from "../../shared/vision-prompt.js";
import { ensureSessionFileOnDisk } from "./session-persistence.js";

export interface PromptImageLike {
  mimeType?: string;
  data?: string;
}

export interface PromptMessageLike {
  text?: unknown;
  images?: PromptImageLike[];
  sessionPath?: string;
}

export interface PromptImageValidationResult {
  ok: boolean;
  message?: string;
}

export interface NormalizePromptRequestOptions {
  locale?: string;
}

export interface NormalizedPromptRequest {
  promptText: string;
  promptSessionPath: string;
  imagesCount: number;
}

const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_PROMPT_IMAGES = 10;
const MAX_PROMPT_IMAGE_BYTES = 20 * 1024 * 1024;

export function validatePromptImages(
  images: PromptImageLike[] | null | undefined,
  translate: (key: string, params?: Record<string, unknown>) => string,
): PromptImageValidationResult {
  if (!images?.length) return { ok: true };
  if (images.length > MAX_PROMPT_IMAGES) {
    return { ok: false, message: translate("error.maxImages", { max: MAX_PROMPT_IMAGES }) };
  }
  for (const img of images) {
    if (!img?.mimeType || !ALLOWED_IMAGE_MIME_TYPES.has(img.mimeType)) {
      return {
        ok: false,
        message: translate("error.unsupportedImageFormat", { mime: img?.mimeType || "unknown" }),
      };
    }
    if (img.data && img.data.length > MAX_PROMPT_IMAGE_BYTES) {
      return { ok: false, message: translate("error.imageTooLarge") };
    }
  }
  return { ok: true };
}

function buildNormalizedPromptRequest(
  promptText: string,
  promptSessionPath: string,
  imagesCount: number,
): NormalizedPromptRequest {
  ensureSessionFileOnDisk(promptSessionPath);
  return {
    promptText,
    promptSessionPath,
    imagesCount,
  };
}

export function createPromptSession(engine: any): Promise<any> {
  return engine.createSession(null, engine.homeCwd || process.cwd());
}

export function resolveCreatedPromptSessionPath(createdSession: any, engine: any): string {
  return createdSession?.sessionManager?.getSessionFile?.() || engine.currentSessionPath || "";
}

export function normalizePromptRequest(
  msg: PromptMessageLike,
  promptSessionPath: string,
  opts: NormalizePromptRequestOptions = {},
): NormalizedPromptRequest {
  const images = Array.isArray(msg.images) ? msg.images : [];
  const promptText = normalizeVisionPromptText(msg.text || "", images, { locale: opts.locale });
  return buildNormalizedPromptRequest(promptText, promptSessionPath, images.length);
}
