import fs from "node:fs/promises";
import path from "node:path";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export function parseImageList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export async function buildImagesContentParts(imagePaths: readonly string[], text: string): Promise<ChatContentPart[]> {
  if (!imagePaths.length) return [{ type: "text", text }];
  const parts: ChatContentPart[] = [{ type: "text", text }];
  for (const imagePath of imagePaths) {
    parts.push(await buildSingleImagePart(imagePath));
  }
  return parts;
}

export async function buildImageContentParts(imagePath: string, text: string): Promise<ChatContentPart[]> {
  return buildImagesContentParts([imagePath], text);
}

async function buildSingleImagePart(imagePath: string): Promise<ChatContentPart> {
  const resolved = path.resolve(imagePath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error(`image is not a file: ${imagePath}`);
  if (stat.size > MAX_IMAGE_BYTES) throw new Error(`image is too large (${Math.ceil(stat.size / 1024 / 1024)}MB > 20MB)`);
  const mime = inferImageMime(resolved);
  const bytes = await fs.readFile(resolved);
  return { type: "image_url", image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` } };
}

export function inferImageMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".png") return "image/png";
  throw new Error(`unsupported image type: ${ext || "(none)"}. Use png, jpg, webp, or gif.`);
}
