import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { isVersionOnlyArgv, VERSION } from "../src/cli.js";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));

// This file deliberately carries NO wall-clock budget for the fast path. A regression to the
// pre-fast-path behavior costs the telemetry drain (up to 1000ms of pure waiting) plus state-dir
// init, and both of those are asserted DIRECTLY below - no request reached the black hole, and the
// state dir was never created - which catches the regression on any machine. An elapsed-time
// ceiling only proxied for those two facts, and it measured the machine instead of the code: it
// fails on a loaded runner where process startup alone exceeds it (measured: ~1223ms for one
// `--version` spawn while the rest of the suite ran, against a 500ms ceiling). Re-expressing it as
// a ratio against a same-run calibration does not rescue it either, because per-spawn startup
// variance under load swamps the fixed drain: measured over the same 16-way CPU saturation, a
// healthy build's best-of-three ran at 0.50-0.83 of its calibration while a build that DOES pay the
// init ran at 0.94-1.17 - overlapping ranges, so no threshold separates them. The property is not
// observable through wall clock on a contended box; it is observable through the two assertions
// that remain.

// Accepts the telemetry connection and never answers, so a regression pays the whole
// drain timeout instead of a fast connection refusal.
async function startBlackHoleTelemetry() {
  const sockets = new Set();
  const requests = [];
  const server = createServer((req) => {
    requests.push(req.url);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    requests,
    host: `http://127.0.0.1:${port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("isVersionOnlyArgv matches exactly the SDK's version-flag shapes", () => {
  for (const flag of ["--version", "-v", "-V"]) {
    assert.equal(isVersionOnlyArgv([flag]), true);
  }
  for (const argv of [[], ["--help"], ["open"], ["--version", "extra"], ["open", "--version"]]) {
    assert.equal(isVersionOnlyArgv(argv), false);
  }
});

test("--version prints the version and skips telemetry and state-dir init", async (t) => {
  const telemetry = await startBlackHoleTelemetry();
  const stateParent = await mkdtemp(path.join(tmpdir(), "lavish-version-"));
  const stateDir = path.join(stateParent, "state");
  t.after(async () => {
    await telemetry.close();
    await rm(stateParent, { recursive: true, force: true });
  });

  const env = {
    ...process.env,
    LAVISH_AXI_STATE_DIR: stateDir,
    LAVISH_AXI_TELEMETRY: "1",
    LAVISH_AXI_UMAMI_WEBSITE_ID: "version-fast-path-test",
    LAVISH_AXI_UMAMI_HOST: telemetry.host,
  };

  for (const flag of ["--version", "-v", "-V"]) {
    const { stdout } = await execFileAsync(process.execPath, [BIN, flag], { env });
    assert.equal(stdout, `${VERSION}\n`);
  }

  // The heavy init is provably skipped: no telemetry request was ever sent, and the
  // state directory was never created.
  assert.deepEqual(telemetry.requests, []);
  assert.equal(existsSync(stateDir), false);
});

test("a non-version invocation still runs the telemetry init the fast path skips", async (t) => {
  const telemetry = await startBlackHoleTelemetry();
  const stateParent = await mkdtemp(path.join(tmpdir(), "lavish-version-control-"));
  const stateDir = path.join(stateParent, "state");
  t.after(async () => {
    await telemetry.close();
    await rm(stateParent, { recursive: true, force: true });
  });

  await execFileAsync(process.execPath, [BIN, "design"], {
    env: {
      ...process.env,
      LAVISH_AXI_STATE_DIR: stateDir,
      LAVISH_AXI_TELEMETRY: "1",
      LAVISH_AXI_UMAMI_WEBSITE_ID: "version-fast-path-test",
      LAVISH_AXI_UMAMI_HOST: telemetry.host,
    },
  });

  assert.ok(telemetry.requests.length > 0, "expected the control command to send telemetry");
  assert.equal(existsSync(stateDir), true);
});
