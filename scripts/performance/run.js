// @ts-check
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const HYPERFINE_VERSION = "1.20.0";
const smoke = process.argv.includes("--smoke");
const root = path.resolve(import.meta.dirname, "../..");
const outputRoot = path.resolve(process.env.LAVISH_AXI_BENCH_OUTPUT_DIR || ".lavish-performance/runs");
const runName = new Date().toISOString().replaceAll(":", "-");
const outputDir = path.join(outputRoot, runName);
const runtimeDir = path.join(outputDir, "runtime");
const stateDir = await mkdtemp(path.join(os.tmpdir(), "lavish-performance-"));
const fixture = path.join(root, "test/fixtures/performance/minimal.html");
const port = await unusedPort();
const sessionIterations = smoke ? 3 : 25;
const env = {
  ...process.env,
  LAVISH_AXI_BENCH_FIXTURE: fixture,
  LAVISH_AXI_BENCH_PORT: String(port),
  LAVISH_AXI_BENCH_RUNTIME_DIR: runtimeDir,
  LAVISH_AXI_BENCH_SESSION_ITERATIONS: String(sessionIterations),
  LAVISH_AXI_BENCH_STATE_DIR: stateDir,
};

await mkdir(outputDir, { recursive: true });
const hyperfineVersion = commandOutput("hyperfine", ["--version"]);
if (hyperfineVersion !== `hyperfine ${HYPERFINE_VERSION}`) {
  throw new Error(`bench:process requires hyperfine ${HYPERFINE_VERSION}; found ${hyperfineVersion || "nothing"}`);
}

const common = smoke ? ["--runs", "2"] : ["--warmup", "3", "--min-runs", "10"];
let runError;
try {
  runHyperfine([...common, "--export-json", path.join(outputDir, "cli-version.json"), "node dist/cli.mjs --version"]);

  runHyperfine([
    ...common,
    "--prepare",
    "node scripts/performance/scenario.js stop-server",
    "--cleanup",
    "node scripts/performance/scenario.js stop-server",
    "--export-json",
    path.join(outputDir, "cold-server.json"),
    "node scripts/performance/scenario.js start-server",
  ]);

  runScenario("start-server");
  runHyperfine([
    ...common,
    "--export-json",
    path.join(outputDir, "warm-session.json"),
    "node scripts/performance/scenario.js warm-session",
  ]);
} catch (error) {
  runError = error;
}

try {
  runScenario("stop-server");
} catch (cleanupError) {
  if (!runError) throw cleanupError;
  if (runError instanceof Error) {
    runError.message = `${runError.message}; cleanup also failed: ${errorMessage(cleanupError)}`;
  }
}
if (runError) throw runError;

const metadata = {
  schemaVersion: 1,
  commit: commandOutput("git", ["rev-parse", "HEAD"]),
  recordedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  hyperfine: HYPERFINE_VERSION,
  smoke,
  sessionIterations,
  scenarios: ["cli-version", "cold-server", "warm-session"],
};
await writeFile(path.join(outputDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
console.log(`Performance evidence: ${outputDir}`);

function runHyperfine(args) {
  const result = spawnSync("hyperfine", args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`hyperfine exited with status ${String(result.status)}`);
}

function runScenario(command) {
  const result = spawnSync(process.execPath, ["scripts/performance/scenario.js", command], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${command} failed`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.error) return "";
  return result.stdout.trim();
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a benchmark port");
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}
