import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLynnHome } from "../core/client-agent-identity.js";

const OLD_ENV = {
  LYNN_HOME: process.env.LYNN_HOME,
  HANA_HOME: process.env.HANA_HOME,
};

afterEach(() => {
  if (OLD_ENV.LYNN_HOME === undefined) delete process.env.LYNN_HOME;
  else process.env.LYNN_HOME = OLD_ENV.LYNN_HOME;
  if (OLD_ENV.HANA_HOME === undefined) delete process.env.HANA_HOME;
  else process.env.HANA_HOME = OLD_ENV.HANA_HOME;
});

describe("resolveLynnHome", () => {
  it("ignores HANA_HOME so OpenHanako state cannot become Lynn state", () => {
    delete process.env.LYNN_HOME;
    process.env.HANA_HOME = "/tmp/openhanako-home";

    expect(resolveLynnHome()).toBe(path.join(os.homedir(), ".lynn"));
  });

  it("honors LYNN_HOME when explicitly set", () => {
    process.env.LYNN_HOME = "/tmp/lynn-home";
    process.env.HANA_HOME = "/tmp/openhanako-home";

    expect(resolveLynnHome()).toBe(path.resolve("/tmp/lynn-home"));
  });
});
