import { describe, expect, it, vi } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { installMediaPermissionHandlers } = require("../media-permission-controller.cjs");

/* eslint-disable @typescript-eslint/no-explicit-any */

function install(isTrusted: (wc: any) => boolean) {
  let requestHandler: any, checkHandler: any;
  const session = {
    defaultSession: {
      setPermissionRequestHandler: (h: any) => { requestHandler = h; },
      setPermissionCheckHandler: (h: any) => { checkHandler = h; },
    },
  };
  installMediaPermissionHandlers({ session, isTrustedAppWebContents: isTrusted });
  return { requestHandler, checkHandler };
}

describe("media permission request handler", () => {
  it("grants audio media only for trusted webContents", () => {
    const { requestHandler } = install((wc: any) => wc.trusted);
    const cb = vi.fn();
    requestHandler({ trusted: true }, "media", cb, { mediaTypes: ["audio"] });
    expect(cb).toHaveBeenLastCalledWith(true);
    requestHandler({ trusted: false }, "media", cb, { mediaTypes: ["audio"] });
    expect(cb).toHaveBeenLastCalledWith(false);
  });
  it("denies non-media permissions outright", () => {
    const { requestHandler } = install(() => true);
    const cb = vi.fn();
    requestHandler({ trusted: true }, "geolocation", cb, {});
    expect(cb).toHaveBeenLastCalledWith(false);
  });
  it("treats an empty mediaTypes as audio (grant for trusted)", () => {
    const { requestHandler } = install(() => true);
    const cb = vi.fn();
    requestHandler({ trusted: true }, "media", cb, {});
    expect(cb).toHaveBeenLastCalledWith(true);
  });
});

describe("media permission check handler", () => {
  it("returns true only for trusted audio media, false otherwise", () => {
    const { checkHandler } = install((wc: any) => wc.trusted);
    expect(checkHandler({ trusted: true }, "media", "o", { mediaTypes: ["audio"] })).toBe(true);
    expect(checkHandler({ trusted: false }, "media", "o", { mediaTypes: ["audio"] })).toBe(false);
    expect(checkHandler({ trusted: true }, "media", "o", { mediaTypes: ["video"] })).toBe(false); // video-only denied
    expect(checkHandler({ trusted: true }, "notifications", "o", {})).toBe(false);
  });
});
