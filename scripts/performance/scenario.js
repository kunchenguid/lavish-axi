// @ts-check
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "../..");
const command = process.argv[2];
const port = requiredPort("LAVISH_AXI_BENCH_PORT");
const runtimeDir = requiredAbsolutePath("LAVISH_AXI_BENCH_RUNTIME_DIR");
const stateDir = requiredAbsolutePath("LAVISH_AXI_BENCH_STATE_DIR");
const fixture = requiredAbsolutePath("LAVISH_AXI_BENCH_FIXTURE");
const pidFile = path.join(runtimeDir, "server.json");
const baseUrl = `http://127.0.0.1:${port}`;

if (command === "start-server") {
  await startServer();
} else if (command === "stop-server") {
  await stopServer();
} else if (command === "warm-session") {
  await runWarmSessionBatch();
} else {
  throw new Error("Usage: node scripts/performance/scenario.js <start-server|stop-server|warm-session>");
}

async function startServer() {
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  const existing = await readPidRecord();
  if (existing && processExists(existing.pid)) {
    throw new Error(`Benchmark server PID ${existing.pid} is already running`);
  }
  await rm(pidFile, { force: true });

  const child = spawn(process.execPath, ["dist/cli.mjs", "server", "--port", String(port)], {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_NO_OPEN: "1",
      LAVISH_AXI_STATE_DIR: stateDir,
      LAVISH_AXI_TELEMETRY: "0",
    },
    stdio: "ignore",
  });
  child.unref();

  if (!child.pid) {
    throw new Error("The benchmark server did not return a process ID");
  }

  const record = { pid: child.pid, port, stateDir, startedAt: new Date().toISOString() };
  await writeFile(pidFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  try {
    await waitForHealth(child.pid, 10_000);
  } catch (error) {
    await terminateProcess(child.pid);
    await rm(pidFile, { force: true });
    throw error;
  }
}

async function stopServer() {
  const record = await readPidRecord();
  if (!record) return;
  if (record.port !== port || record.stateDir !== stateDir) {
    throw new Error("The benchmark server record does not match this benchmark run");
  }

  try {
    const health = await fetchJson(`${baseUrl}/health`);
    if (health?.app === "lavish-axi") {
      await fetch(`${baseUrl}/shutdown`, { method: "POST" });
    }
  } catch {
    // The exact recorded process remains the cleanup authority when HTTP is unavailable.
  }

  await waitForExit(record.pid, 2_000);
  if (processExists(record.pid)) await terminateProcess(record.pid);
  await rm(pidFile, { force: true });
  await rm(stateDir, { force: true, recursive: true });
}

async function runWarmSessionBatch() {
  const iterations = positiveInteger(process.env.LAVISH_AXI_BENCH_SESSION_ITERATIONS || "25", "iterations");
  const health = await fetchJson(`${baseUrl}/health`);
  if (health?.ok !== true || health?.app !== "lavish-axi") {
    throw new Error("The warm benchmark server is not ready");
  }

  for (let index = 0; index < iterations; index += 1) {
    const response = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: fixture }),
    });
    if (!response.ok) {
      throw new Error(`Warm session request failed with HTTP ${response.status}`);
    }
    const result = await response.json();
    if (result.status !== "opened") {
      throw new Error(`Warm session request returned status ${String(result.status)}`);
    }
  }
}

async function waitForHealth(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) throw new Error("The benchmark server exited before it became ready");
    try {
      const health = await fetchJson(`${baseUrl}/health`);
      if (health?.ok === true && health?.app === "lavish-axi") return;
    } catch {
      // Startup is still in progress.
    }
    await delay(25);
  }
  throw new Error(`The benchmark server did not become ready within ${timeoutMs} ms`);
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function readPidRecord() {
  try {
    const value = JSON.parse(await readFile(pidFile, "utf8"));
    if (!Number.isInteger(value.pid) || !Number.isInteger(value.port) || typeof value.stateDir !== "string") {
      throw new Error("The benchmark server record is invalid");
    }
    return value;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

async function terminateProcess(pid) {
  if (!processExists(pid)) return;
  process.kill(pid, "SIGTERM");
  await waitForExit(pid, 2_000);
  if (processExists(pid)) process.kill(pid, "SIGKILL");
  await waitForExit(pid, 2_000);
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid) && Date.now() < deadline) await delay(25);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requiredPort(name) {
  const value = positiveInteger(process.env[name] || "", name);
  if (value > 65_535) throw new Error(`${name} must be less than 65536`);
  return value;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function requiredAbsolutePath(name) {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}
