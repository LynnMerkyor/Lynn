import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createSettingsOnboardingController, normalizeSettingsNavigationTarget } = require("../settings-onboarding-controller.cjs");

/* eslint-disable @typescript-eslint/no-explicit-any */

describe("normalizeSettingsNavigationTarget", () => {
  it("returns null for empty / non-object / no-valid-keys input", () => {
    expect(normalizeSettingsNavigationTarget(null)).toBeNull();
    expect(normalizeSettingsNavigationTarget(undefined)).toBeNull();
    expect(normalizeSettingsNavigationTarget(123)).toBeNull();
    expect(normalizeSettingsNavigationTarget({})).toBeNull();
    expect(normalizeSettingsNavigationTarget({ unknownKey: "x" })).toBeNull();
  });
  it("wraps a bare string as { tab }", () => {
    expect(normalizeSettingsNavigationTarget("providers")).toEqual({ tab: "providers" });
  });
  it("whitelists known fields and drops the rest", () => {
    expect(normalizeSettingsNavigationTarget({
      tab: "models", providerId: "openai", resetProviderSelection: true,
      reviewerKind: "butter", junk: "dropme",
    })).toEqual({ tab: "models", providerId: "openai", resetProviderSelection: true, reviewerKind: "butter" });
  });
  it("preserves explicit null providerId/agentId (a reset signal)", () => {
    expect(normalizeSettingsNavigationTarget({ providerId: null })).toEqual({ providerId: null });
    expect(normalizeSettingsNavigationTarget({ agentId: null, resetAgentSelection: true })).toEqual({ agentId: null, resetAgentSelection: true });
  });
  it("rejects an invalid reviewerKind", () => {
    expect(normalizeSettingsNavigationTarget({ reviewerKind: "evil" })).toBeNull();
  });
});

describe("createSettingsOnboardingController: state accessors", () => {
  function ctl() {
    const noop = () => {};
    return createSettingsOnboardingController({
      BrowserWindow: class {}, fs: {}, lynnHome: "/h",
      loadWindowErrorPage: noop, loadWindowURL: noop, getWindowEntryStamp: () => 0,
      titleBarOpts: {}, themeBg: {}, shell: {},
      getBrowserTheme: () => "warm-paper", getForceQuitApp: () => false,
      getMainWindow: () => null, getSplashWindow: () => null, closeSplashWindow: noop,
      createMainWindow: noop, waitForMainWindowReady: async () => {},
      markPreferredPrimaryWindow: noop, getPreferredPrimaryWindowKind: () => null, setPreferredPrimaryWindowKind: noop,
    });
  }

  it("starts with no settings/onboarding window", () => {
    const c = ctl();
    expect(c.getSettingsWindow()).toBeNull();
    expect(c.getOnboardingWindow()).toBeNull();
  });

  it("getInitialSettingsNavigationTarget returns null when no settings window is open", () => {
    expect(ctl().getInitialSettingsNavigationTarget({ sender: {} })).toBeNull();
  });
});
