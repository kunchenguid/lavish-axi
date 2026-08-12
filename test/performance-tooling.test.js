import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const scenario = path.join(root, "scripts/performance/scenario.js");
const fixture = path.join(root, "test/fixtures/performance/minimal.html");

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

function runScenario(command, env) {
  return spawnSync(process.execPath, [scenario, command], {
    cwd: root,
    encoding: "utf8",
    env,
    timeout: 15_000,
  });
}

test("the process scenarios start, exercise, and stop their exact benchmark server", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "lavish-performance-test-"));
  const runtimeDir = path.join(tempDir, "runtime");
  const stateDir = path.join(tempDir, "state");
  const port = await unusedPort();
  const env = {
    ...process.env,
    LAVISH_AXI_BENCH_PORT: String(port),
    LAVISH_AXI_BENCH_RUNTIME_DIR: runtimeDir,
    LAVISH_AXI_BENCH_STATE_DIR: stateDir,
    LAVISH_AXI_BENCH_FIXTURE: fixture,
    LAVISH_AXI_BENCH_SESSION_ITERATIONS: "3",
  };

  t.after(() => {
    runScenario("stop-server", env);
  });

  const started = runScenario("start-server", env);
  assert.equal(started.status, 0, started.stderr);

  const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
  assert.deepEqual({ ok: health.ok, app: health.app }, { ok: true, app: "lavish-axi" });

  const pidRecord = JSON.parse(await readFile(path.join(runtimeDir, "server.json"), "utf8"));
  assert.equal(pidRecord.port, port);
  assert.equal(pidRecord.stateDir, stateDir);
  assert.ok(Number.isInteger(pidRecord.pid));

  const warmed = runScenario("warm-session", env);
  assert.equal(warmed.status, 0, warmed.stderr);

  const stopped = runScenario("stop-server", env);
  assert.equal(stopped.status, 0, stopped.stderr);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
});
