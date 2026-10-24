import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { localListenerPids, localLlamaProcesses, localQwenProcessListInvocation } from "../server/local-model-processes.ts";

assert.equal(process.platform, "win32", "This gate requires native Windows");
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-probe-"));
const originalPath = process.env.PATH;
const marker = `lynn-probe-${process.pid}`;
const server = http.createServer((_request, response) => response.end("probe"));
let child;
try {
  await fs.writeFile(path.join(workspace, "ps.cmd"), "@echo unsafe PATH ps invoked\r\n@exit /b 42\r\n");
  await fs.writeFile(path.join(workspace, "lsof.cmd"), "@echo unsafe PATH lsof invoked\r\n@exit /b 42\r\n");
  process.env.PATH = `${workspace}${path.delimiter}${originalPath || ""}`;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const executable = path.join(workspace, "llama-server.exe");
  await fs.copyFile(process.execPath, executable);
  child = spawn(executable, ["-e", "setInterval(() => {}, 1000)", "--", marker], { windowsHide: true, stdio: "ignore" });
  await once(child, "spawn");
  const port = String(server.address().port);
  for (let index = 0; index < 13; index++) {
    assert.ok((await localListenerPids(port)).includes(process.pid), "native listener lookup missed current process");
    const started = Date.now();
    const rows = await localLlamaProcesses();
    const found = rows.some(row => row.pid === child.pid && row.command.includes(marker));
    if (!found) {
      const query = localQwenProcessListInvocation();
      const diagnostic = await promisify(execFile)(query.file, query.args, { ...query.options, timeout: 10000 })
        .then(({ stdout }) => ({ outputBytes: Buffer.byteLength(stdout), containsMarker: stdout.includes(marker) }))
        .catch(error => ({ code: error.code, killed: error.killed, stderr: String(error.stderr || "").slice(0,1000) }));
      console.error(JSON.stringify({ iteration: index, elapsedMs: Date.now() - started, childPid: child.pid, childExit: child.exitCode, returnedPids: rows.map(row => row.pid), diagnostic }));
    }
    assert.ok(found, "native process lookup missed the marked process");
  }
  console.log("PASS: 13 native Windows listener/process polls with hostile PATH entries");
} finally {
  process.env.PATH = originalPath;
  if (child?.exitCode === null) {
    const closed = once(child, "close");
    child.kill();
    await closed;
  }
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await fs.rm(workspace, { recursive: true, force: true });
}
