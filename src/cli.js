import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { AxiError, runAxiCli } from "axi-sdk-js";

import { defaultPort, ensureStateDir, stateFile } from "./paths.js";
import { serve } from "./server.js";
import { canonicalFile, sessionKey, SessionStore } from "./session-store.js";
import { initDefaultTelemetry } from "./telemetry.js";

const COMMANDS = new Set(["open", "poll", "end", "server"]);
const DESCRIPTION =
  "Lavish Editor helps agents turn rich HTML artifacts into collaborative human review surfaces. First generate an interactive HTML artifact for the user to inspect, then run `lavish-axi <html-file>` so the user can visually review it, annotate elements, queue prompts, and send feedback back through `lavish-axi poll`.";
const VERSION = "0.1.0";

export async function run(argv) {
  await ensureStateDir();
  const normalizedArgv = normalizeArgv(argv);
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
      argv: normalizedArgv,
      topLevelHelp: TOP_LEVEL_HELP,
      hooks: { binaryNames: ["lavish-axi"] },
      home: async () =>
        createHomeOutput({
          bin: process.argv[1] || "lavish-axi",
          sessions: await visibleSessions(),
        }),
      commands: {
        open: openCommand,
        poll: pollCommand,
        end: endCommand,
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

export function createHomeOutput({ bin, sessions }) {
  return {
    bin: collapseHomeDirectory(bin, os.homedir()),
    description: DESCRIPTION,
    sessions: sessions.map((session) => ({
      file: session.file,
      status: session.status,
      url: session.url,
      pending_prompts: session.pending_prompts || 0,
    })),
    example_use_cases: [
      "Technical plans with diagrams, mockups, data flow, and code snippets",
      "Brainstorming early ideas with recommendations, open questions, and visible tradeoffs",
      "Design explorations with multiple visual options side by side",
      "PR and code review explainers with annotated diffs and findings",
      "Interactive prototypes with sliders, knobs, forms, and animation tuning",
      "Reports, research summaries, incident writeups, and learning guides",
      "Custom editing interfaces for triage, config editing, prompt tuning, dataset curation, and structured config editing",
    ],
    artifact_guidance: [
      "Unless the user specifies another location, create HTML artifacts in the current working directory under `.lavish/`",
      "Use clear sections, headings, tabs, cards, tables, diagrams, and spatial layout instead of long prose",
      "Include concrete artifacts such as mockups, SVG diagrams, annotated code snippets, diffs, data-flow charts, and examples",
      "For exploration, show multiple options side by side and label the tradeoff each option makes",
      "For code review, render the relevant diff or snippets with inline annotations and severity-coded findings",
      "For custom editors, include controls that let the user adjust values, then call `window.lavish.queuePrompt(...)` with the requested change",
      "End interactive workflows with an obvious way for the user to queue prompts and send them back",
    ],
    visual_guidance: [
      "Choose a clear visual point of view that matches the artifact: editorial, technical dashboard, dense control room, refined memo, playful prototype, brutalist review board, etc.",
      "Use typography, spacing, color, and layout deliberately; avoid generic system-font cards on white unless that restraint is the actual design choice",
      "Use visual hierarchy to make the most important decisions, risks, tradeoffs, and next actions obvious at a glance",
      "Prefer diagrams, tables, annotated snippets, side-by-side comparisons, and spatial layouts over long prose",
      "For explorations, make options visually distinct and label the tradeoff each option makes",
      "For interactive artifacts, provide obvious controls and queue the user's chosen values with `window.lavish.queuePrompt(...)`",
      "Make the artifact responsive and readable; visual polish should improve comprehension, not distract from review",
    ],
    help: [
      "Run `lavish-axi <html-file>` to open or resume a Lavish Editor session",
      "Run `lavish-axi poll <html-file>` to wait for user feedback",
      "Run `lavish-axi end <html-file>` to end a session",
    ],
  };
}

export function createOpenOutput({ file, url, status }) {
  return {
    session: { file, url, status },
    next_step: `Tell the user to open ${url} to review the artifact in Lavish Editor, then run \`lavish-axi poll ${file}\`. This command long-polls until the user sends feedback or ends the session. Do not pass --timeout-ms during normal agent use. Do not set a short shell timeout; either run it without a timeout or set the shell timeout above 10 minutes. After applying feedback, run \`lavish-axi poll ${file} --agent-reply "<message for the user>"\` without --timeout-ms to show your response in Lavish Editor and wait for more feedback.`,
  };
}

async function openCommand(args) {
  const file = args.find((arg) => !arg.startsWith("-"));
  if (!file) {
    throw new AxiError("HTML file path is required", "VALIDATION_ERROR", ["Run `lavish-axi <html-file>`"]);
  }
  await assertHtmlFile(file);
  const absolute = await canonicalFile(file);
  const baseUrl = await ensureServer();
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
  const response = await fetchJson(`${baseUrl}/api/poll?file=${encodeURIComponent(absolute)}${timeoutQuery}`);
  return createPollOutput({ file: absolute, response });
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
      next_step: `Apply the requested changes to ${file}, then run \`lavish-axi poll ${file} --agent-reply "<message for the user>"\` without --timeout-ms unless the user ended the session. The poll command waits until the user sends more feedback or ends the session; do not set a short shell timeout, or set the shell timeout above 10 minutes.`,
    };
  }
  if (response.status === "ended") {
    return { session: { file, status: "ended" } };
  }
  return {
    session: { file, status: response.status || "waiting" },
    next_step: `No user feedback arrived before the optional timeout. Run \`lavish-axi poll ${file}\` without --timeout-ms to wait indefinitely.`,
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

async function serverCommand(args) {
  const port = Number(flagValue(args, "--port") || defaultPort());
  await serve({ port, stateFile: stateFile() });
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

async function ensureServer() {
  const port = defaultPort();
  const baseUrl = `http://localhost:${port}`;
  if (await isHealthy(baseUrl)) {
    return baseUrl;
  }
  await startServer(port);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await isHealthy(baseUrl)) {
      return baseUrl;
    }
    await delay(100);
  }
  throw new AxiError("Lavish Editor server did not start", "SERVER_ERROR", [
    `Run \`lavish-axi server --port ${port}\` to inspect server startup`,
  ]);
}

async function startServer(port) {
  await ensureStateDir();
  const bin = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));
  const child = spawn(process.execPath, [bin, "server", "--port", String(port)], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, LAVISH_AXI_NO_OPEN: "1" },
  });
  child.unref();
}

export function createServerSpawnOptions() {
  return {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, LAVISH_AXI_NO_OPEN: "1" },
  };
}

async function isHealthy(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new AxiError(`Lavish Editor request failed: ${response.status}`, "SERVER_ERROR");
  }
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new AxiError(`Lavish Editor request failed: ${response.status}`, "SERVER_ERROR");
  }
  return response.json();
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

const TOP_LEVEL_HELP = `lavish-axi - Lavish Editor AXI\n\nUsage:\n  lavish-axi\n  lavish-axi <html-file>\n  lavish-axi poll <html-file> [--agent-reply "..."]\n  lavish-axi end <html-file>\n\nNote: poll long-polls indefinitely by default until the user sends feedback or ends the session. Do not pass --timeout-ms during normal agent use; it is for tests and debugging only. do not set a short shell timeout; either run it without a timeout or use a very high threshold above 10 minutes.\n\n`;

const COMMAND_HELP = {
  open: `Usage: lavish-axi <html-file> [--no-open]\n\nOpen or resume a Lavish Editor review session for an HTML artifact. Use --no-open when you need to ensure the server/session exists without opening another browser window.\n`,
  poll: `Usage: lavish-axi poll <html-file> [--agent-reply "..."]\n\nThis command long-polls indefinitely for queued user prompts, then returns them to the agent. Do not pass --timeout-ms during normal agent use; it is for tests and debugging only. do not set a short shell timeout; either run it without a timeout or use a very high threshold above 10 minutes so the user has time to review and send feedback. Use --agent-reply after applying prior feedback to display your response in Lavish Editor before waiting again.\n`,
  end: `Usage: lavish-axi end <html-file>\n\nEnd a Lavish Editor session.\n`,
  server: `Usage: lavish-axi server [--port 4387]\n\nRun the local Lavish Editor server.\n`,
};
