import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clipboardImageDir, detectImageFormat } from "../src/clipboard-image.js";

afterEach(() => {
  delete process.env.LYNN_DATA_DIR;
});

describe("clipboard image helpers", () => {
  it("detects png, jpeg and gif magic bytes", () => {
    expect(detectImageFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
    expect(detectImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(detectImageFormat(Buffer.from("GIF89a"))).toBe("gif");
    expect(detectImageFormat(Buffer.from("not an image"))).toBeNull();
    expect(detectImageFormat(Buffer.alloc(2))).toBeNull();
  });

  it("writes into the configured data dir", () => {
    process.env.LYNN_DATA_DIR = "/tmp/lynn-data";
    expect(clipboardImageDir()).toBe(path.join("/tmp/lynn-data", "clipboard"));
    expect(clipboardImageDir("/custom")).toBe(path.join("/custom", "clipboard"));
  });
});
