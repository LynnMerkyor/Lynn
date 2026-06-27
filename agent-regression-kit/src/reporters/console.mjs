export function printConsoleReport(report, { stream = process.stdout } = {}) {
  const status = report.ok ? "PASS" : "FAIL";
  write(stream, `Agent Regression Kit · ${status}`);
  write(stream, `Case bank: ${report.caseBank.name} · level=${report.level} · adapter=${report.adapter.name}`);
  write(stream, `Cases: ${report.passed}/${report.total} passed · ${report.durationMs}ms`);

  for (const result of report.results) {
    const mark = result.ok ? "✓" : "✗";
    write(stream, `${mark} ${result.id} (${result.durationMs}ms)`);
    if (result.ok) continue;
    if (result.error) {
      write(stream, `  error: ${result.error}`);
    }
    for (const assertion of result.assertions || []) {
      if (assertion.ok) continue;
      write(stream, `  assertion: ${assertion.message || `${assertion.path} ${assertion.operator}`}`);
      write(stream, `    expected: ${JSON.stringify(assertion.expected)}`);
      write(stream, `    actual: ${JSON.stringify(assertion.actual)}`);
    }
  }
}

function write(stream, line) {
  stream.write(`${line}\n`);
}
