import { describe, expect, it } from "vitest";
import {
  selfVerifyEnabled,
  buildSelfVerifyPrompt,
  parseSelfVerifyVerdict,
  formatSelfVerifyCritique,
} from "../src/code-self-verify.js";

describe("#4 selfVerifyEnabled (opt-in)", () => {
  it("defaults off and turns on with LYNN_CLI_SELF_VERIFY=1", () => {
    expect(selfVerifyEnabled({})).toBe(false);
    expect(selfVerifyEnabled({ LYNN_CLI_SELF_VERIFY: "1" })).toBe(true);
  });
});

describe("buildSelfVerifyPrompt", () => {
  it("frames the model as a strict skeptic with the task + proposed answer + verdict format", () => {
    const prompt = buildSelfVerifyPrompt("add retry to fetch", "Added a 3x retry loop.");
    expect(prompt).toContain("STRICT adversarial reviewer");
    expect(prompt).toContain("add retry to fetch");
    expect(prompt).toContain("Added a 3x retry loop.");
    expect(prompt).toContain("VERDICT: PASS");
    expect(prompt).toContain("VERDICT: ISSUES");
  });
});

describe("parseSelfVerifyVerdict", () => {
  it("passes only on an explicit VERDICT: PASS", () => {
    expect(parseSelfVerifyVerdict("Looks complete.\nVERDICT: PASS").pass).toBe(true);
  });

  it("treats VERDICT: ISSUES as a block and extracts the issue list", () => {
    const v = parseSelfVerifyVerdict("VERDICT: ISSUES\n1. retry count is off by one\n2. no backoff");
    expect(v.pass).toBe(false);
    expect(v.issues).toContain("off by one");
    expect(v.issues).toContain("no backoff");
  });

  it("does NOT pass on an inconclusive review (skeptic ignored the format)", () => {
    const v = parseSelfVerifyVerdict("I think it is probably fine but I am not sure about edge cases.");
    expect(v.pass).toBe(false);
    expect(v.issues).toBeTruthy();
  });

  it("honors the last verdict if the model flip-flops", () => {
    expect(parseSelfVerifyVerdict("VERDICT: ISSUES\nx\n...actually VERDICT: PASS").pass).toBe(true);
    expect(parseSelfVerifyVerdict("VERDICT: PASS\n...wait VERDICT: ISSUES\nbug").pass).toBe(false);
  });
});

describe("formatSelfVerifyCritique", () => {
  it("turns issues into an observation block", () => {
    const msg = formatSelfVerifyCritique("1. missing null check");
    expect(msg).toContain("Adversarial self-review reported issues");
    expect(msg).toContain("missing null check");
    expect(msg).not.toContain("then give the final answer");
  });
});
