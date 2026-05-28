import { BrowserManager } from "../../lib/browser/browser-manager.js";

type IntervalHandle = ReturnType<typeof setInterval>;

export function createBrowserThumbnailPoller(broadcast: (msg: any) => void) {
  let browserThumbTimer: IntervalHandle | null = null;

  function stop() {
    if (browserThumbTimer) {
      clearInterval(browserThumbTimer);
      browserThumbTimer = null;
    }
  }

  function start() {
    if (browserThumbTimer) return;
    browserThumbTimer = setInterval(async () => {
      const browser = BrowserManager.instance();
      if (!browser.isRunning) { stop(); return; }
      const thumbnail = await browser.thumbnail();
      if (thumbnail) {
        broadcast({ type: "browser_status", running: true, url: browser.currentUrl, thumbnail });
      }
    }, 30_000);
  }

  return { start, stop };
}
