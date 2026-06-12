import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AxiError, installSessionStartHooks, runAxiCli } from "axi-sdk-js";

import { createDesignOutput, DESIGN_SYSTEM_HINT } from "./design-reference.js";
import { clientHost, defaultPort, ensureStateDir, hostForUrl, serverLogFile, stateFile } from "./paths.js";
import { findPlaybook, listPlaybooks, playbookIds } from "./playbooks.js";
import { serve } from "./server.js";
import { canonicalFile, sessionKey, SessionStore } from "./session-store.js";
import { initDefaultTelemetry } from "./telemetry.js";

const COMMANDS = new Set(["open", "poll", "end", "stop", "server", "playbook", "design", "setup"]);
const DESCRIPTION =
  "Lavish Editor helps agents turn rich HTML artifacts into collaborative human review surfaces. Whenever you are about to give user a complex response that will be easier to understand via a rich / interactive page, consider using Lavish Editor. " +
  "First generate an interactive HTML artifact according to user request, then run `lavish-axi <html-file>` so the user can visually review it, annotate elements or selected text, queue prompts, and send feedback back through `lavish-axi poll`.";
// Inlined at build time from package.json; falls back to reading package.json so source-run tests work.
export const VERSION =
  process.env.LAVISH_AXI_BUILD_VERSION ||
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export async function run(argv) {
  await ensureStateDir();
  const normalizedArgv = normalizeArgv(argv);
  const isTopLevelHelp = argv.length === 1 && argv[0] === "--help";
  const command = telemetryCommandName(argv);
  const telemetry = initDefaultTelemetry({
    app: "lavish-axi",
    version: VERSION,
    platform: process.platform,
    arch: process.arch,
  });
  telemetry.pageview(`/${command}`, { command });
  try {
    await runAxiCli({
      description: DESCRIPTION,
      version: VERSION,
      argv: isTopLevelHelp ? [] : normalizedArgv,
      topLevelHelp: TOP_LEVEL_HELP,
      home: async () =>
        createHomeOutput({
          bin: process.argv[1] || "lavish-axi",
          sessions: isTopLevelHelp ? [] : await visibleSessions(),
          includeSessions: !isTopLevelHelp,
        }),
      commands: {
        open: openCommand,
        poll: pollCommand,
        end: endCommand,
        stop: stopCommand,
        playbook: playbookCommand,
        design: designCommand,
        setup: setupCommand,
        server: serverCommand,
      },
      getCommandHelp,
    });
    telemetry.track("command", { command, status: "success" });
  } catch (error) {
    telemetry.track("command", { command, status: "error" });
    throw error;
  } finally {
    await telemetry.close(1_000);
  }
}

export function collapseHomeDirectory(file, home) {
  const normalizedFile = file.replaceAll("\\", "/");
  const normalizedHome = home.replaceAll("\\", "/");

  if (normalizedFile === normalizedHome) {
    return "~";
  }
  if (normalizedFile.startsWith(`${normalizedHome}/`)) {
    return `~/${normalizedFile.slice(normalizedHome.length + 1)}`;
  }
  return file;
}

export function normalizeArgv(argv) {
  const first = argv[0];
  if (!first || COMMANDS.has(first)) {
    return argv;
  }
  if (first.startsWith("-")) {
    return argv.some((arg) => isHtmlPath(arg)) ? ["open", ...argv] : argv;
  }
  return ["open", ...argv];
}

export function telemetryCommandName(argv) {
  const normalized = normalizeArgv(argv);
  return normalized[0] && !normalized[0].startsWith("-") ? normalized[0] : "home";
}

export function createHomeOutput({ bin, sessions, includeSessions = true }) {
  return {
    bin: collapseHomeDirectory(bin, os.homedir()),
    description: DESCRIPTION,
    ...(includeSessions
      ? {
          sessions: sessions.map((session) => ({
            file: session.file,
            status: session.status,
            url: session.url,
            pending_prompts: session.pending_prompts || 0,
          })),
        }
      : {}),
    visual_guidance: [
      "Use visual hierarchy to make the most important decisions, risks, tradeoffs, and next actions obvious at a glance",
      "Use visual structure such as sections, cards, tables, diagrams, annotated snippets, and side-by-side comparisons instead of long prose",
      "Choose typography, spacing, color, and layout deliberately so the artifact has a clear point of view",
      "Prevent horizontal overflow: design narrow layouts intentionally, use minmax(0, 1fr) and min-width: 0 for grid/flex children, and deliberately wrap or truncate long labels/status text",
    ],
    playbooks: listPlaybooks(),
    help: [
      "Run `lavish-axi <html-file>` to open or resume a Lavish Editor session",
      "Unless the user specifies another location, create HTML artifacts in the current working directory under `.lavish/`",
      "Lavish serves the html file through a local express.js server. If your html needs to reference other filesystem assets such as images, CSS, fonts, and local scripts, copy them into the same directory as the HTML file, then reference them with relative paths from that directory. Never prepend `/` to those asset paths - root paths won't work",
      "Run `lavish-axi poll <html-file>` to wait for user feedback. It long-polls and stays silent until the user sends feedback or ends the session, so leave it running - never kill it. If your harness limits how long a foreground command may run, run the poll as a background task; if it gets killed or times out anyway, just re-run it - queued feedback is never lost",
      "Run `lavish-axi end <html-file>` to end a session",
      "Run `lavish-axi stop` to shut down the background server (it also self-stops when idle or after the last session ends with nothing connected)",
      "Run `lavish-axi playbook <playbook_id>` for focused artifact guidance. One artifact often combines several playbooks (for example a plan that includes a comparison and a diagram), so read every playbook relevant to the artifact, not just one, for the best quality",
      DESIGN_SYSTEM_HINT,
      "Use lavish-axi when the user asks for a visual artifact, HTML explainer, interactive prototype, review surface, product or technical plan, comparison, report, or browser-based feedback loop",
    ],
  };
}

export function createPlaybookOutput(args) {
  const id = args[0];
  if (!id) {
    return {
      playbooks: listPlaybooks(),
      help: [
        "Run `lavish-axi playbook <playbook_id>` for focused artifact guidance",
        "One artifact often combines several playbooks (for example a plan that includes a comparison and a diagram), so read every playbook relevant to the artifact, not just one, for the best quality",
      ],
    };
  }

  const playbook = findPlaybook(id);
  if (!playbook) {
    throw new AxiError(`Unknown playbook: ${id}`, "VALIDATION_ERROR", [
      `Run \`lavish-axi playbook\` to list known IDs: ${playbookIds().join(", ")}`,
    ]);
  }

  return { playbook };
}

export function createOpenOutput({ file, url, status }) {
  return {
    session: { file, url, status },
    next_step: `Do not respond to the user just yet. Now you must run \`lavish-axi poll ${file}\`. This command long-polls until the user sends feedback or ends the session, and it stays silent the whole time - that is normal, never kill it. Do not pass --timeout-ms during normal agent use. If your harness limits how long a foreground command may run, run the poll as a background task and wait for it to finish; if the poll still gets killed or times out, just re-run it - queued feedback is never lost. After applying feedback, run \`lavish-axi poll ${file} --agent-reply "<message for the user>"\` without --timeout-ms to show your response in Lavish Editor and wait for more feedback.`,
  };
}

async function openCommand(args) {
  const file = args.find((arg) => !arg.startsWith("-"));
  if (!file) {
    throw new AxiError("HTML file path is required", "VALIDATION_ERROR", ["Run `lavish-axi <html-file>`"]);
  }
  await assertHtmlFile(file);
  const absolute = await canonicalFile(file);
  const baseUrl = await ensureServer({ forceRestart: shouldForceRestartForLocalBuild(process.argv[1] || "") });
  const response = await postJson(`${baseUrl}/api/sessions`, { file: absolute });
  if (shouldOpenBrowser(args, process.env)) {
    try {
      const open = (await import("open")).default;
      await open(response.url);
    } catch {
      response.status = "ready";
    }
  }
  return createOpenOutput({ file: absolute, url: response.url, status: response.status || "opened" });
}

export function shouldOpenBrowser(args, env) {
  return !args.includes("--no-open") && env.LAVISH_AXI_NO_OPEN !== "1";
}

async function pollCommand(args) {
  const file = args[0];
  if (!file) {
    throw new AxiError("HTML file path is required", "VALIDATION_ERROR", ["Run `lavish-axi poll <html-file>`"]);
  }
  const absolute = await canonicalFile(file);
  const baseUrl = await ensureServer();
  const agentReply = flagValue(args, "--agent-reply");
  if (agentReply) {
    await postJson(`${baseUrl}/api/${sessionKey(absolute)}/agent-reply`, { text: agentReply });
  }
  const timeoutMs = flagValue(args, "--timeout-ms");
  const timeoutQuery = timeoutMs ? `&timeoutMs=${encodeURIComponent(timeoutMs)}` : "";
  // The indefinite poll looks hung from the agent's side (stdout stays empty until the user
  // acts), so narrate the wait on stderr and leave re-run guidance behind if the agent's
  // harness kills the process anyway. stderr keeps the stdout JSON contract intact.
  const onPollSignal = (signal) => {
    process.stderr.write(`\n${pollInterruptedText(absolute)}\n`);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  if (!timeoutMs) {
    // Register before the banner write below: a harness that kills the poll as soon as the
    // banner appears can deliver the signal before the next statement runs, and without a
    // handler the default disposition exits silently with no re-run guidance.
    process.on("SIGINT", onPollSignal);
    process.on("SIGTERM", onPollSignal);
  }
  const waitReporter = timeoutMs ? null : startPollWaitReporter({ file: absolute });
  try {
    const response = await fetchJson(`${baseUrl}/api/poll?file=${encodeURIComponent(absolute)}${timeoutQuery}`, {
      retries: 3,
      retryDelayMs: 500,
    });
    return createPollOutput({ file: absolute, response });
  } finally {
    waitReporter?.stop();
    if (!timeoutMs) {
      process.off("SIGINT", onPollSignal);
      process.off("SIGTERM", onPollSignal);
    }
  }
}

export function pollWaitBannerText(file) {
  return (
    `[lavish-axi] Long-polling for user feedback on ${file}. This stays silent until the user sends feedback or ends the session - leave it running. ` +
    `If it gets killed or times out, re-run \`lavish-axi poll ${file}\` - queued feedback is never lost.`
  );
}

export function pollWaitTickText(elapsedMs) {
  const minutes = Math.round(elapsedMs / 60_000);
  return `[lavish-axi] Still waiting for user feedback (${minutes}m). Leave this running until the user acts.`;
}

export function pollInterruptedText(file) {
  return (
    `[lavish-axi] Poll interrupted before user feedback arrived. The user may still be reviewing - ` +
    `re-run \`lavish-axi poll ${file}\` to keep waiting; queued feedback is never lost.`
  );
}

export function startPollWaitReporter({
  file,
  write = (line) => {
    process.stderr.write(line);
  },
  intervalMs = 60_000,
}) {
  write(`${pollWaitBannerText(file)}\n`);
  let elapsedMs = 0;
  const timer = setInterval(() => {
    elapsedMs += intervalMs;
    write(`${pollWaitTickText(elapsedMs)}\n`);
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

export function createPollOutput({ file, response }) {
  if (response.status === "missing") {
    throw new AxiError("No active Lavish Editor session for this file", "NOT_FOUND", [
      `Run \`lavish-axi ${file}\` first`,
    ]);
  }
  if (response.status === "feedback") {
    return {
      session: { file, status: "feedback" },
      dom_snapshot: response.dom_snapshot || "",
      prompts: response.prompts || [],
      next_step: `Apply the requested changes to ${file}. Do not respond to the user just yet. Now you must run \`lavish-axi poll ${file} --agent-reply "<message for the user>"\` without --timeout-ms unless the user ended the session. The poll waits silently until the user sends more feedback or ends the session - never kill it. If your harness limits how long a foreground command may run, run the poll as a background task; if it still gets killed or times out, just re-run it - queued feedback is never lost.`,
    };
  }
  if (response.status === "ended") {
    return { session: { file, status: "ended" } };
  }
  return {
    session: { file, status: response.status || "waiting" },
    next_step: `No user feedback arrived before the optional timeout. Run \`lavish-axi poll ${file}\` without --timeout-ms to wait indefinitely - queued feedback is never lost, so re-running the poll is always safe.`,
  };
}

async function endCommand(args) {
  const file = args[0];
  if (!file) {
    throw new AxiError("HTML file path is required", "VALIDATION_ERROR", ["Run `lavish-axi end <html-file>`"]);
  }
  const absolute = await canonicalFile(file);
  const baseUrl = await ensureServer();
  const response = await postJson(`${baseUrl}/api/end`, { file: absolute });
  return { session: { file: absolute, status: response.status || "ended" } };
}

// Explicitly shut down the running Lavish Editor server. Unlike `end` (which closes a single
// session), this stops the background process so it stops dangling between sessions.
export async function stopCommand(args) {
  const port = Number(flagValue(args, "--port") || defaultPort());
  const baseUrl = `http://${hostForUrl(clientHost())}:${port}`;
  return shutdownServerOnPort(port, { baseUrl, currentVersion: VERSION });
}

export async function shutdownServerOnPort(
  port,
  {
    baseUrl = `http://${hostForUrl(clientHost())}:${port}`,
    currentVersion = VERSION,
    fetchHealth: healthFetcher = fetchHealth,
    requestShutdown: shutdownRequester = requestShutdown,
    waitForPortFree: portFreeWaiter = waitForPortFree,
    killProcessOnPort: portKiller = killProcessOnPort,
    processMatchesLavish = processOnPortMatchesLavish,
  } = {},
) {
  const health = await healthFetcher(baseUrl);
  if (!health) {
    return { server: { status: "not-running", port } };
  }
  if (!(await canControlServerOnPort(port, health, processMatchesLavish))) {
    return { server: { status: "not-lavish", port } };
  }
  await shutdownRequester(baseUrl);
  let freed = await portFreeWaiter(baseUrl, 3000);
  if (!freed && shouldKillProcessOnPort(currentVersion, health)) {
    portKiller(port);
    freed = await portFreeWaiter(baseUrl, 3000);
  }
  return { server: { status: freed ? "stopped" : "stopping", port } };
}

async function playbookCommand(args) {
  return createPlaybookOutput(args);
}

async function designCommand() {
  return createDesignOutput();
}

async function setupCommand(args) {
  if (args.length !== 1 || args[0] !== "hooks") {
    throw new AxiError("Unknown setup action", "VALIDATION_ERROR", ["Run `lavish-axi setup hooks`"]);
  }

  const errors = [];
  installSessionStartHooks({
    marker: "lavish-axi",
    binaryNames: ["lavish-axi"],
    distEntrypoints: ["dist/cli.mjs", "bin/lavish-axi.js"],
    homeDir: resolveHookHomeDir(),
    onError: (message) => errors.push(message),
  });

  if (errors.length > 0) {
    throw new AxiError("Failed to install lavish-axi agent hooks", "SERVER_ERROR", errors);
  }

  return {
    hooks: { status: "installed", integrations: "Claude Code, Codex, OpenCode" },
    help: ["Restart your agent session to receive lavish-axi ambient context"],
  };
}

export function resolveHookHomeDir(env = process.env, fallback = os.homedir()) {
  return env.HOME || fallback;
}

async function serverCommand(args) {
  const port = Number(flagValue(args, "--port") || defaultPort());
  const debug = args.includes("--verbose") || process.env.LAVISH_AXI_DEBUG === "1";
  const server = await serve({ port, stateFile: stateFile(), version: VERSION, debug });
  await server.done;
  return "";
}

async function visibleSessions() {
  const store = new SessionStore(stateFile());
  return (await store.listSessions()).filter((session) => session.status !== "ended");
}

async function assertHtmlFile(file) {
  if (!isHtmlPath(file)) {
    throw new AxiError("Lavish Editor expects an HTML file", "VALIDATION_ERROR", ["Run `lavish-axi <html-file>`"]);
  }
  try {
    await access(file);
  } catch {
    throw new AxiError(`File not found: ${file}`, "NOT_FOUND", [
      "Create the HTML artifact first, then run `lavish-axi <html-file>`",
    ]);
  }
}

function isHtmlPath(file) {
  return file.toLowerCase().endsWith(".html") || file.toLowerCase().endsWith(".htm");
}

async function ensureServer({ forceRestart = false } = {}) {
  const port = defaultPort();
  const baseUrl = `http://${hostForUrl(clientHost())}:${port}`;
  const existing = await fetchHealth(baseUrl);
  if (existing && !shouldRestartServer(VERSION, existing, forceRestart)) {
    return baseUrl;
  }
  if (existing) {
    if (!(await canControlServerOnPort(port, existing, processOnPortMatchesLavish))) {
      throw new AxiError(`Port ${port} is occupied by a non-Lavish server`, "SERVER_ERROR", [
        `Stop the process using port ${port}, or set LAVISH_AXI_PORT to another port`,
      ]);
    }
    // Stale server from an older release is squatting on the port. Ask it to shut down
    // gracefully so the upgraded client doesn't keep handing users an old chrome.
    await requestShutdown(baseUrl);
    const freed = await waitForPortFree(baseUrl, 2000);
    if (!freed) {
      // Pre-handshake servers (any release older than this change) don't expose /shutdown
      // so the POST 404'd. Fall back to SIGTERM by PID so the very first upgrade still
      // works, then keep waiting.
      if (shouldKillProcessOnPort(VERSION, existing)) {
        killProcessOnPort(port);
        await waitForPortFree(baseUrl, 3000);
      }
    }
  }
  await startServer(port);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const health = await fetchHealth(baseUrl);
    if (health && !shouldRestartServer(VERSION, health)) {
      return baseUrl;
    }
    await delay(100);
  }
  throw new AxiError("Lavish Editor server did not start", "SERVER_ERROR", [
    `Run \`lavish-axi server --port ${port}\` to inspect server startup`,
  ]);
}

// Pure helper so the upgrade-detection logic is unit-testable without spinning up HTTP.
// Returns true when the running server is a different (or pre-handshake) version than
// what this CLI was built with - i.e. the user just upgraded and the stale server needs
// to step aside.
export function shouldRestartServer(currentVersion, healthBody, forceRestart = false) {
  if (!healthBody || typeof healthBody !== "object") return false;
  if (forceRestart && healthBody.app === "lavish-axi") return true;
  if (typeof healthBody.version !== "string" || healthBody.version === "") return true;
  return healthBody.version !== currentVersion;
}

export function shouldForceRestartForLocalBuild(executablePath, sourceServerExists = localSourceServerExists()) {
  const localBuildEntry = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
  return sourceServerExists && path.resolve(executablePath) === path.resolve(localBuildEntry);
}

function localSourceServerExists() {
  return existsSync(fileURLToPath(new URL("../src/server.js", import.meta.url)));
}

export function shouldKillProcessOnPort(currentVersion, healthBody) {
  if (!healthBody || typeof healthBody !== "object") return false;
  if (typeof healthBody.version !== "string" || healthBody.version === "") return true;
  if (healthBody.app !== "lavish-axi") return false;
  return healthBody.version !== currentVersion;
}

async function canControlServerOnPort(port, healthBody, processMatchesLavish) {
  if (!healthBody || typeof healthBody !== "object") return false;
  if (healthBody.app === "lavish-axi") return true;
  if (typeof healthBody.version === "string" && healthBody.version !== "") return false;
  return processMatchesLavish(port);
}

async function fetchHealth(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/health`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function requestShutdown(baseUrl) {
  try {
    await fetch(`${baseUrl}/shutdown`, { method: "POST" });
  } catch {
    // Best effort. If the server died before answering, the port will free up on its own.
  }
}

async function waitForPortFree(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await fetchHealth(baseUrl))) return true;
    await delay(100);
  }
  return false;
}

// Last-resort fallback for the bootstrap upgrade case: a pre-handshake server is squatting
// on the port and doesn't expose /shutdown, so we resolve its PID via lsof and SIGTERM it.
// macOS/Linux only - Windows users would need to kill manually, but lavish-axi isn't
// shipped for Windows today.
function killProcessOnPort(port) {
  try {
    const result = spawnSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    if (result.status !== 0) return;
    for (const line of result.stdout.split("\n")) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Process already gone or permission denied - either way nothing we can do.
        }
      }
    }
  } catch {
    // lsof missing or unsupported platform - the outer caller will surface SERVER_ERROR.
  }
}

function processOnPortMatchesLavish(port) {
  try {
    const pids = spawnSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    if (pids.status !== 0) return false;
    for (const line of pids.stdout.split("\n")) {
      const pid = Number(line.trim());
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      const command = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
      if (command.status === 0 && /lavish-axi/.test(command.stdout)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function startServer(port) {
  await ensureStateDir();
  const entry = resolveServerEntry();
  let logFd = null;
  try {
    logFd = openSync(serverLogFile(), "a");
  } catch {
    // If logging cannot be initialized, keep the server behavior unchanged.
  }
  try {
    const child = spawn(process.execPath, [entry, "server", "--port", String(port)], createServerSpawnOptions(logFd));
    child.unref();
  } finally {
    if (logFd !== null) closeSync(logFd);
  }
}

// The detached server child must point at a node-executable entry that actually invokes
// run(). In source layout that's `../bin/lavish-axi.js` (which calls run on import). In the
// published bundle, only `dist/cli.mjs` ships and it self-invokes via the bundled bin
// wrapper. Pick whichever exists.
export function resolveServerEntry() {
  const binEntry = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));
  if (existsSync(binEntry)) return binEntry;
  return fileURLToPath(import.meta.url);
}

/**
 * @param {number | null} logFd
 * @returns {import("node:child_process").SpawnOptions}
 */
export function createServerSpawnOptions(logFd = null) {
  const stdio = /** @type {import("node:child_process").StdioOptions} */ (
    logFd === null ? "ignore" : ["ignore", logFd, logFd]
  );
  return {
    detached: true,
    stdio,
    env: { ...process.env, LAVISH_AXI_NO_OPEN: "1" },
  };
}

export async function fetchJson(url, { retries = 0, retryDelayMs = 250 } = {}) {
  let response;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      response = await fetch(url);
      break;
    } catch (error) {
      if (error instanceof AxiError) throw error;
      if (attempt >= retries) throw serverConnectionError();
      await delay(retryDelayMs);
    }
  }

  if (!response) throw serverConnectionError();
  if (!response.ok) {
    throw new AxiError(`Lavish Editor request failed: ${response.status}`, "SERVER_ERROR");
  }
  try {
    return await response.json();
  } catch {
    throw pollResponseInterruptedError();
  }
}

async function postJson(url, body) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw serverConnectionError();
  }
  if (!response.ok) {
    throw new AxiError(`Lavish Editor request failed: ${response.status}`, "SERVER_ERROR");
  }
  return response.json();
}

function serverConnectionError() {
  return new AxiError("Lavish Editor server connection failed", "SERVER_ERROR", [
    "Run `lavish-axi server --verbose` or inspect `~/.lavish-axi/server.log` (`LAVISH_AXI_STATE_DIR/server.log` when set) for server startup or crash diagnostics",
    "Re-run the last `lavish-axi poll <html-file>` command after the server is healthy",
  ]);
}

function pollResponseInterruptedError() {
  return new AxiError("Lavish Editor poll response was interrupted", "SERVER_ERROR", [
    "Run `lavish-axi server --verbose` or inspect `~/.lavish-axi/server.log` (`LAVISH_AXI_STATE_DIR/server.log` when set) for server startup or crash diagnostics",
    "Re-run the last `lavish-axi poll <html-file>` command after the server is healthy",
  ]);
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return args[index + 1] || null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getCommandHelp(command) {
  return COMMAND_HELP[command] || null;
}

const TOP_LEVEL_HELP = `lavish-axi - Lavish Editor AXI\n\nUsage:\n  lavish-axi\n  lavish-axi <html-file>\n  lavish-axi poll <html-file> [--agent-reply "..."]\n  lavish-axi end <html-file>\n  lavish-axi stop\n  lavish-axi playbook [playbook_id]\n  lavish-axi design\n  lavish-axi setup hooks\n\n${DESIGN_SYSTEM_HINT}\n\nNote: poll long-polls indefinitely by default until the user sends feedback or ends the session, staying silent while it waits - never kill it. Do not pass --timeout-ms during normal agent use; it is for tests and debugging only. If your harness limits how long a foreground command may run, run the poll as a background task; if it gets killed or times out anyway, just re-run it - queued feedback is never lost.\n\n`;

const COMMAND_HELP = {
  open: `Usage: lavish-axi <html-file> [--no-open]\n\nOpen or resume a Lavish Editor review session for an HTML artifact. Use --no-open when you need to ensure the server/session exists without opening another browser window.\n`,
  poll: `Usage: lavish-axi poll <html-file> [--agent-reply "..."]\n\nThis command long-polls indefinitely for queued user prompts, then returns them to the agent. It stays silent while it waits - that is normal, never kill it. Do not pass --timeout-ms during normal agent use; it is for tests and debugging only. If your harness limits how long a foreground command may run, run the poll as a background task and wait for it to finish; if it still gets killed or times out, just re-run it - queued feedback is never lost. Use --agent-reply after applying prior feedback to display your response in Lavish Editor before waiting again.\n`,
  end: `Usage: lavish-axi end <html-file>\n\nEnd a Lavish Editor session.\n`,
  stop: `Usage: lavish-axi stop [--port <port>]\n\nShut down the background Lavish Editor server. The server also stops itself when no browser or poll has been connected for a while (LAVISH_AXI_IDLE_TIMEOUT_MS, default 30m) and immediately when the last session ends with nothing connected.\n`,
  playbook: `Usage: lavish-axi playbook [playbook_id]\n\nList focused artifact guidance playbooks, or show one playbook by ID. Known IDs: diagram, table, comparison, plan, code, input, slides.\n\nOne artifact often combines several playbooks (for example a plan that includes a comparison and a diagram), so read every playbook relevant to the artifact, not just one, for the best quality.\n\nExamples:\n  lavish-axi playbook\n  lavish-axi playbook diagram\n  lavish-axi playbook input\n`,
  design: `Usage: lavish-axi design\n\nShow a copy-pasteable CDN snippet for Tailwind CSS browser runtime v4 + DaisyUI v5 + themes, plus technical reference for DaisyUI components. Lavish artifacts stay portable HTML. This CDN snippet is the design fallback, not the default: inspect the project before falling back. The strict priority order is: (1) if the user asked for a specific look or named design system, follow that; (2) otherwise, if the current project already has a design system or style conventions, match those; (3) only when both come up empty, prefer the Lavish-recommended Tailwind + DaisyUI CDN snippet over hand-writing styles unless explicitly instructed otherwise by the user.\n`,
  setup: `Usage: lavish-axi setup hooks\n\nInstall or repair agent SessionStart hooks for lavish-axi ambient context in Claude Code, Codex, and OpenCode. Restart your agent session afterward to receive the context.\n`,
  server: `Usage: lavish-axi server [--port 4387] [--verbose]\n\nRun the local Lavish Editor server. Pass --verbose (or set LAVISH_AXI_DEBUG=1) to log session and watcher events to stderr. Detached server output is appended to ~/.lavish-axi/server.log, or LAVISH_AXI_STATE_DIR/server.log when set, for startup and crash diagnostics.\n\nLAVISH_AXI_HOST sets the bind address (default 127.0.0.1; a wildcard 0.0.0.0 or :: binds every interface). Binding beyond loopback exposes an unauthenticated server that can read and serve arbitrary local files to anything that can reach it, so only do so on a trusted network. LAVISH_AXI_LINK_HOST sets the hostname written into generated session links (default: the bind address, or loopback when bound to a wildcard). LAVISH_AXI_NO_OPEN=1 (or --no-open) suppresses the local browser launch.\n`,
};

export { createDesignOutput };
