import { describe, expect, it } from "vitest";
import { setLang } from "../src/i18n.js";
import { usage } from "../src/help.js";

describe("CLI help", () => {
  it("documents multi-image vision input", () => {
    setLang("en");
    try {
      expect(usage()).toContain("--images a.png,b.png");
      expect(usage()).toContain("Lynn --continue");
      expect(usage()).toContain("Lynn --resume <session.jsonl>");
      setLang("zh");
      expect(usage()).toContain("--images a.png,b.png");
      expect(usage()).toContain("Lynn --continue");
      expect(usage()).toContain("Lynn --resume <session.jsonl>");
    } finally {
      setLang(null);
    }
  });
});
