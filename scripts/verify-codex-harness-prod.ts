import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodeHarnessSelection } from "../cli/src/codex-harness-selection.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brainUrl = process.env.LYNN_BRAIN_URL
  || process.env.BRAIN_V2_URL
  || "https://api.merkyorlynn.com/api/v2";

const result = await resolveCodeHarnessSelection({
  requested: "auto",
  cwd: repoRoot,
  brainUrl,
  provider: null,
  ultra: false,
  hasMedia: false,
  machineReadable: false,
  approval: "ask",
  reasoning: { effort: "auto", display: "auto" },
});

console.log(JSON.stringify(result));
if (result.selected !== "codex") {
  throw new Error(`production Codex harness preflight selected ${result.selected}: ${result.reason}`);
}
