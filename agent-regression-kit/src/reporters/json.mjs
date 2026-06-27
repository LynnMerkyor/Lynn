import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function writeJsonReport(report, opts = {}) {
  if (opts.noReport) return "(disabled)";
  const reportDir = path.resolve(opts.reportDir || path.join(os.tmpdir(), "agent-regression-kit"));
  await fs.mkdir(reportDir, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, "-");
  const reportPath = path.join(reportDir, `${report.caseBank.name}-${report.level}-${stamp}.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const latestPath = path.join(reportDir, `${report.caseBank.name}-${report.level}-latest.json`);
  await fs.writeFile(latestPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
}
