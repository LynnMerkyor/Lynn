function installMediaPermissionHandlers({ session, isTrustedAppWebContents }) {
  try {
    const defaultSession = session.defaultSession;
    defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      if (permission === "media") {
        const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
        const audioOnly = mediaTypes.length > 0 && mediaTypes.every((type) => type === "audio");
        callback(Boolean(audioOnly && isTrustedAppWebContents(webContents)));
        return;
      }
      callback(false);
    });

    defaultSession.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details) => {
      if (permission !== "media") return false;
      const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
      const audioOnly = mediaTypes.length > 0 && mediaTypes.every((type) => type === "audio");
      return Boolean(audioOnly && isTrustedAppWebContents(webContents));
    });

    const browserSession = session.fromPartition("persist:hana-browser");
    browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
  } catch (err) {
    console.warn("[desktop] install media permission handler failed:", err?.message || err);
  }
}

module.exports = { installMediaPermissionHandlers };
