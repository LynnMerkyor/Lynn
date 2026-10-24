/**
 * clipboard-image.ts — turn a clipboard image into a file the model can read.
 *
 * Terminals do not deliver image bytes to the application, so Cmd+V on a
 * screenshot is a no-op unless the CLI asks the OS clipboard itself. This module
 * does that per platform, normalizes the result to PNG, and caps the dimensions
 * so a retina screenshot does not become a multi-megabyte base64 payload.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ClipboardImage {
  path: string;
  format: "png" | "jpeg" | "gif";
  bytes: number;
  platform: string;
}

export interface ClipboardImageOptions {
  /** Where the normalized file is written. Defaults to <dataDir>/clipboard. */
  dataDir?: string;
  /** Longest edge after downscaling. Defaults to 1568 (a common vision budget). */
  maxEdge?: number;
}

export function clipboardImageDir(explicitDataDir?: string): string {
  const dataDir = explicitDataDir?.trim()
    || process.env.LYNN_DATA_DIR?.trim()
    || path.join(os.homedir(), ".lynn");
  return path.join(dataDir, "clipboard");
}

/** Detect a supported image by magic bytes (terminals/OS give us no filename). */
export function detectImageFormat(bytes: Uint8Array): "png" | "jpeg" | "gif" | null {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "gif";
  return null;
}

export async function readClipboardImage(options: ClipboardImageOptions = {}): Promise<ClipboardImage | null> {
  const dir = clipboardImageDir(options.dataDir);
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let platform: string;
  if (process.platform === "darwin") {
    platform = "macos";
    const png = await readMacClipboard(dir, stamp);
    if (png) return finalize(png, options.maxEdge);
    return null;
  }
  if (process.platform === "linux") {
    platform = "linux";
    const bytes = await readLinuxClipboard();
    if (!bytes) return null;
    const format = detectImageFormat(bytes);
    if (!format) return null;
    const file = path.join(dir, `${stamp}.${format === "jpeg" ? "jpg" : format}`);
    await fs.writeFile(file, bytes);
    return finalize({ path: file, format, bytes: bytes.length, platform }, options.maxEdge);
  }
  return null;
}

async function readMacClipboard(dir: string, stamp: string): Promise<ClipboardImage | null> {
  // 1) PNG directly from the pasteboard.
  const pngPath = path.join(dir, `${stamp}.png`);
  if (await osascriptClipboardToFile("«class PNGf»", pngPath)) {
    const format = await formatOf(pngPath);
    if (format === "png") return { path: pngPath, format, bytes: await sizeOf(pngPath), platform: "macos" };
  }
  // 2) TIFF is what many macOS apps put on the pasteboard; convert with sips.
  const tiffPath = path.join(dir, `${stamp}.tiff`);
  if (await osascriptClipboardToFile("«class TIFF»", tiffPath)) {
    const converted = path.join(dir, `${stamp}-from-tiff.png`);
    try {
      await execFileAsync("sips", ["-s", "format", "png", tiffPath, "--out", converted], { timeout: 10_000 });
      await fs.rm(tiffPath, { force: true });
      const format = await formatOf(converted);
      if (format === "png") return { path: converted, format, bytes: await sizeOf(converted), platform: "macos" };
    } catch {
      // fall through to "no image"
    }
    await fs.rm(tiffPath, { force: true });
  }
  return null;
}

async function osascriptClipboardToFile(classSpec: string, destination: string): Promise<boolean> {
  const script = [
    "try",
    `set d to the clipboard as ${classSpec}`,
    `set f to open for access POSIX file ${JSON.stringify(destination)} with write permission`,
    "write d to f",
    "close access f",
    'return "ok"',
    "on error",
    'return "no"',
    "end try",
  ];
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script.join("\n")], { timeout: 5_000 });
    if (!String(stdout).includes("ok")) return false;
    const stat = await fs.stat(destination);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function readLinuxClipboard(): Promise<Buffer | null> {
  const candidates: Array<[string, string[]]> = [
    ["wl-paste", ["--type", "image/png", "--no-newline"]],
    ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
  ];
  for (const [command, args] of candidates) {
    try {
      const { stdout } = await execFileAsync(command, args, { timeout: 5_000, maxBuffer: 30 * 1024 * 1024, encoding: "buffer" });
      const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout));
      if (buffer.length) return buffer;
    } catch {
      continue;
    }
  }
  return null;
}

async function finalize(image: ClipboardImage, maxEdge = 1568): Promise<ClipboardImage> {
  if (process.platform !== "darwin") return image;
  try {
    await execFileAsync("sips", ["-Z", String(maxEdge), image.path], { timeout: 10_000 });
    const bytes = await sizeOf(image.path);
    return { ...image, bytes };
  } catch {
    return image;
  }
}

async function formatOf(filePath: string): Promise<"png" | "jpeg" | "gif" | null> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(8);
      await handle.read(buffer, 0, 8, 0);
      return detectImageFormat(buffer);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function sizeOf(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch {
    return 0;
  }
}
