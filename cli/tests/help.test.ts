import { describe, expect, it } from "vitest";
import { setLang } from "../src/i18n.js";
import { usage } from "../src/help.js";

describe("CLI help", () => {
  it("documents multi-image vision input", () => {
    setLang("en");
    try {
      expect(usage()).toContain("--images a.png,b.png");
      setLang("zh");
      expect(usage()).toContain("--images a.png,b.png");
    } finally {
      setLang(null);
    }
  });
});
