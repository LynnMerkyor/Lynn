import { describe, expect, it } from "vitest";
import { renderToolLedger, toolLedgerEntry } from "../src/tool-ledger.js";

describe("tool ledger", () => {
  it("summarizes exact read_file values for chained follow-up steps", () => {
    const entry = toolLedgerEntry({
      ok: true,
      tool: "read_file",
      output: {
        path: "src/value.txt",
        offset: 0,
        nextOffset: 12,
        truncated: false,
        bytes: 12,
        text: "price=195.30\n",
      },
    });

    const ledger = renderToolLedger([entry], 0);

    expect(ledger).toContain("<lynn_tool_ledger");
    expect(ledger).toContain("Tool observations recorded during this step");
    expect(ledger).toContain("read_file ok");
    expect(ledger).toContain("path=src/value.txt");
    expect(ledger).toContain("price=195.30");
  });

  it("summarizes bash exit code, stdout, and stderr without losing exact values", () => {
    const entry = toolLedgerEntry({
      ok: true,
      tool: "bash",
      output: {
        command: "node calc.js",
        exitCode: 0,
        timedOut: false,
        stdout: "market_value=19530\n",
        stderr: "",
      },
    });

    expect(renderToolLedger([entry], 2)).toContain("market_value=19530");
  });
});
