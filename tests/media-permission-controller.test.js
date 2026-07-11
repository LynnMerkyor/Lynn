import { describe, expect, it, vi } from "vitest";

import { installMediaPermissionHandlers } from "../desktop/media-permission-controller.cjs";

function fakeSession() {
  const handlers = {};
  return {
    handlers,
    setPermissionRequestHandler(handler) { handlers.request = handler; },
    setPermissionCheckHandler(handler) { handlers.check = handler; },
  };
}

describe("Electron permission boundaries", () => {
  it("allows microphone only for trusted app contents and denies camera", () => {
    const defaultSession = fakeSession();
    const browserSession = fakeSession();
    const trusted = { id: "trusted" };
    installMediaPermissionHandlers({
      session: {
        defaultSession,
        fromPartition: vi.fn(() => browserSession),
      },
      isTrustedAppWebContents: (webContents) => webContents === trusted,
    });

    const audioCallback = vi.fn();
    defaultSession.handlers.request(trusted, "media", audioCallback, { mediaTypes: ["audio"] });
    expect(audioCallback).toHaveBeenCalledWith(true);

    const cameraCallback = vi.fn();
    defaultSession.handlers.request(trusted, "media", cameraCallback, { mediaTypes: ["video"] });
    expect(cameraCallback).toHaveBeenCalledWith(false);
    const mixedCallback = vi.fn();
    defaultSession.handlers.request(trusted, "media", mixedCallback, { mediaTypes: ["audio", "video"] });
    expect(mixedCallback).toHaveBeenCalledWith(false);
    const unspecifiedCallback = vi.fn();
    defaultSession.handlers.request(trusted, "media", unspecifiedCallback, {});
    expect(unspecifiedCallback).toHaveBeenCalledWith(false);
    expect(defaultSession.handlers.check(trusted, "geolocation", "file://lynn", {})).toBe(false);
  });

  it("denies every permission in the model-driven browser partition", () => {
    const defaultSession = fakeSession();
    const browserSession = fakeSession();
    const fromPartition = vi.fn(() => browserSession);
    installMediaPermissionHandlers({
      session: { defaultSession, fromPartition },
      isTrustedAppWebContents: () => true,
    });

    expect(fromPartition).toHaveBeenCalledWith("persist:hana-browser");
    for (const permission of ["media", "geolocation", "notifications", "clipboard-read"]) {
      const callback = vi.fn();
      browserSession.handlers.request({ id: "remote" }, permission, callback, { mediaTypes: ["audio", "video"] });
      expect(callback).toHaveBeenCalledWith(false);
      expect(browserSession.handlers.check({ id: "remote" }, permission, "https://evil.example", {})).toBe(false);
    }
  });
});
