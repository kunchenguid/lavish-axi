import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AxiError } from "axi-sdk-js";

import {
  collapseHomeDirectory,
  createDesignOutput,
  createHomeOutput,
  createOpenOutput,
  createPollOutput,
  createPlaybookOutput,
  createServerSpawnOptions,
  fetchJson,
  getCommandHelp,
  normalizeArgv,
  pollInterruptedText,
  pollWaitBannerText,
  pollWaitTickText,
  resolveHookHomeDir,
  resolveServerEntry,
  shutdownServerOnPort,
  shouldForceRestartForLocalBuild,
  shouldKillProcessOnPort,
  shouldOpenBrowser,
  shouldRestartServer,
  startPollWaitReporter,
  stopCommand,
  telemetryCommandName,
  VERSION,
} from "../src/cli.js";
import { serve } from "../src/server.js";

test("CLI version tracks package.json so release-please bumps reach the published binary", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, packageJson.version);
});

test("home output teaches agents when and how to use Lavish Editor", () => {
  const output = createHomeOutput({ bin: `${os.homedir()}/.local/bin/lavish-axi`, sessions: [] });

  assert.equal(output.bin, "~/.local/bin/lavish-axi");
  assert.match(output.description, /Lavish Editor/);
  assert.match(output.description, /complex response/);
  assert.match(output.description, /consider using Lavish Editor/);
  assert.match(output.description, /First generate an interactive HTML artifact/);
  assert.deepEqual(output.sessions, []);
  assert.equal("use_cases" in output, false);
  assert.equal("example_use_cases" in output, false);
  assert.equal("artifact_guidance" in output, false);
  assert.ok(output.visual_guidance.length <= 4);
  assert.ok(output.visual_guidance.some((item) => item.includes("visual hierarchy")));
  assert.ok(output.visual_guidance.some((item) => item.includes("sections, cards, tables")));
  assert.ok(output.visual_guidance.some((item) => item.includes("horizontal overflow")));
  assert.ok(output.visual_guidance.some((item) => item.includes("minmax(0, 1fr)")));
  assert.ok(!output.visual_guidance.some((item) => item.includes("test narrow viewports")));
  assert.ok(output.playbooks.some((item) => item.id === "diagram"));
  assert.equal(
    output.playbooks.find((item) => item.id === "input")?.use_when,
    "Must be used when the agent needs to collect user input on decisions, choices, preferences, triage, scope, or other structured feedback from within the artifact",
  );
  assert.ok(output.help.some((item) => item.includes("lavish-axi <html-file>")));
  assert.ok(output.help.some((item) => item.includes("`.lavish/`")));
  assert.ok(output.help.some((item) => item.includes("lavish-axi playbook <playbook_id>")));
  assert.ok(output.help.some((item) => item.includes("combines several playbooks")));
  assert.ok(output.help.some((item) => item.includes("read every playbook relevant")));
  assert.ok(output.help.some((item) => item.includes("reference other filesystem assets")));
  assert.ok(output.help.some((item) => item.includes("same directory as the HTML file")));
  assert.ok(output.help.some((item) => item.includes("does not auto-inject")));
  assert.ok(output.help.some((item) => item.includes("portable")));
  assert.ok(output.help.some((item) => item.includes("Tailwind CSS browser runtime v4")));
  assert.ok(output.help.some((item) => item.includes("lavish-axi design")));
  assert.ok(output.help.some((item) => /prefer.*CDN snippet.*hand-writing styles/i.test(item)));
  assert.ok(output.help.some((item) => /unless.*explicitly instructed/i.test(item)));
  assert.ok(output.help.some((item) => /priority order/i.test(item)));
  assert.ok(output.help.some((item) => /current project/i.test(item)));
  assert.ok(output.help.some((item) => /before writing any html/i.test(item)));
  assert.ok(output.help.some((item) => /inspect the current project/i.test(item)));
  assert.ok(output.help.some((item) => /css variables|design tokens/i.test(item)));
  assert.ok(output.help.some((item) => /component library/i.test(item)));
  assert.ok(output.help.some((item) => /only when both steps come up empty/i.test(item)));
  assert.ok(output.help.some((item) => /state which of the three design sources/i.test(item)));
  assert.ok(!output.help.some((item) => item.includes('<meta name="lavish-design" content="off">')));
  assert.ok(!output.help.some((item) => item.includes("Known IDs")));
  assert.ok(output.help.some((item) => item.includes("technical plan")));
});

test("home output warns agents that poll is a long poll they must not kill", () => {
  const output = createHomeOutput({ bin: "lavish-axi", sessions: [] });
  const pollHelp = output.help.find((item) => item.includes("lavish-axi poll <html-file>"));

  assert.ok(pollHelp, "home help mentions the poll command");
  assert.match(pollHelp, /long-poll/);
  assert.match(pollHelp, /stays silent/);
  assert.match(pollHelp, /never kill it/);
  assert.match(pollHelp, /background task/);
  assert.match(pollHelp, /re-run/);
  assert.match(pollHelp, /queued feedback is never lost/);
  assert.doesNotMatch(pollHelp, /above 10 minutes/);
});

test("top-level help renders static home output without dynamic sessions", async () => {
  const stateDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-help-test-`);
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)), "--help"],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        env: { ...process.env, LAVISH_AXI_STATE_DIR: stateDir },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /playbooks\[7\]/);
    assert.match(result.stdout, /lavish-axi playbook <playbook_id>/);
    assert.match(result.stdout, /reference other filesystem assets/);
    assert.match(result.stdout, /same directory as the HTML file/);
    assert.match(result.stdout, /Tailwind CSS browser runtime v4/);
    assert.match(result.stdout, /lavish-axi design/);
    assert.match(result.stdout, /does not auto-inject/);
    assert.match(result.stdout, /prefer.*CDN snippet.*hand-writing styles/i);
    assert.match(result.stdout, /unless.*explicitly instructed/i);
    assert.match(result.stdout, /priority order/i);
    assert.match(result.stdout, /current project/i);
    assert.match(result.stdout, /inspect the current project/i);
    assert.match(result.stdout, /never kill it/);
    assert.match(result.stdout, /queued feedback is never lost/);
    assert.doesNotMatch(result.stdout, /above 10 minutes/);
    assert.doesNotMatch(result.stdout, /lavish-design/);
    assert.doesNotMatch(result.stdout, /sessions\[/);
    assert.doesNotMatch(result.stdout, /Known IDs/);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test("design output prints copy-pasteable CDN URLs so agents can opt in to DaisyUI", () => {
  const output = createDesignOutput();

  assert.match(output.design.summary, /does not auto-inject/);
  assert.match(output.design.summary, /Tailwind CSS browser runtime v4/);
  assert.match(output.design.summary, /DaisyUI v5/);
  assert.match(output.design.summary, /prefer.*CDN snippet.*hand-writing styles/i);
  assert.match(output.design.summary, /unless.*explicitly instructed/i);
  assert.match(output.design.summary, /priority order/i);
  assert.match(output.design.summary, /current project/i);
  assert.match(output.design.summary, /^Use this .*fallback only if/i);
  assert.match(output.design.summary, /no design direction/i);
  assert.match(output.design.summary, /inspect/i);
  assert.match(output.design.summary, /check first/i);
  assert.match(output.design.cdn_snippet, /cdn\.jsdelivr\.net\/npm\/daisyui@/);
  assert.match(output.design.cdn_snippet, /cdn\.jsdelivr\.net\/npm\/daisyui@.*\/themes\.css/);
  assert.match(output.design.cdn_snippet, /cdn\.jsdelivr\.net\/npm\/@tailwindcss\/browser@/);
  assert.match(
    output.design.cdn_urls.daisyui,
    /^https:\/\/cdn\.jsdelivr\.net\/npm\/daisyui@\d+\.\d+\.\d+\/daisyui\.css$/,
  );
  assert.match(
    output.design.cdn_urls.daisyuiThemes,
    /^https:\/\/cdn\.jsdelivr\.net\/npm\/daisyui@\d+\.\d+\.\d+\/themes\.css$/,
  );
  assert.match(
    output.design.cdn_urls.tailwind,
    /^https:\/\/cdn\.jsdelivr\.net\/npm\/@tailwindcss\/browser@\d+\.\d+\.\d+\/dist\/index\.global\.js$/,
  );
  assert.match(output.design.other_design_systems, /different design system|other design system/i);
  assert.equal("opt_out" in output.design, false);
  assert.equal("rule" in output.design, false);
  assert.equal(output.design.latest_docs, "https://daisyui.com/components/");
  assert.equal(output.themes.length, 35);
  assert.ok(output.themes.includes("luxury"));
  assert.ok(output.themes.includes("silk"));
  assert.ok(output.components.actions.includes("button"));
  assert.ok(output.components.data_display.includes("card"));
  assert.ok(output.components.feedback.includes("alert"));
  assert.ok(output.reference.button.classes.includes("btn-primary"));
  assert.match(output.reference.modal.syntax, /<dialog/);
  assert.ok(output.reference.table.notes.some((item) => item.includes("overflow-x-auto")));
  assert.ok(output.reference.drawer.notes.some((item) => item.includes("drawer-toggle")));
  assert.ok(output.reference.mockup.notes.some((item) => item.includes("Keep `data-prefix` short")));
  assert.ok(output.reference.mockup.notes.some((item) => item.includes("line numbers")));
});

test("design output recommends luxury as the default theme and warns against @apply on DaisyUI classes", () => {
  const output = createDesignOutput();

  assert.ok(output.theme_usage.some((item) => /default.*luxury|luxury.*default/i.test(item)));
  assert.ok(output.theme_usage.some((item) => item.includes("@apply") && /daisyui/i.test(item)));
  assert.ok(output.theme_usage.some((item) => /aborts the entire|no Tailwind styles/i.test(item)));
});

test("playbook index output lists known playbooks with concise descriptions", () => {
  const output = createPlaybookOutput([]);

  assert.equal(output.playbooks.length, 7);
  assert.deepEqual(
    output.playbooks.map((playbook) => playbook.id),
    ["diagram", "table", "comparison", "plan", "code", "input", "slides"],
  );
  assert.equal(
    output.playbooks.find((playbook) => playbook.id === "plan")?.use_when,
    "Explain a product or technical plan before implementation",
  );
  assert.equal(
    output.playbooks.find((playbook) => playbook.id === "input")?.use_when,
    "Must be used when the agent needs to collect user input on decisions, choices, preferences, triage, scope, or other structured feedback from within the artifact",
  );
  assert.ok(output.playbooks.every((playbook) => playbook.use_when.length > 20));
  assert.ok(output.help.some((item) => item.includes("lavish-axi playbook <playbook_id>")));
  assert.ok(output.help.some((item) => item.includes("combines several playbooks")));
  assert.ok(output.help.some((item) => item.includes("read every playbook relevant")));
});

test("playbook detail output returns focused Lavish-native guidance", () => {
  const output = createPlaybookOutput(["input"]);

  assert.equal(output.playbook.id, "input");
  assert.match(output.playbook.use_when, /Must be used/);
  assert.match(output.playbook.use_when, /collect user input/);
  assert.ok(output.playbook.choose.some((item) => item.includes("control")));
  assert.ok(output.playbook.structure.some((item) => item.includes("decision")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("queuePrompt")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("data-lavish-action")));
  assert.ok(output.playbook.lavish_notes.some((item) => item.includes("window.lavish.queuePrompt")));
  assert.ok(output.playbook.pitfalls.some((item) => item.includes("unclear")));
  assert.ok(output.playbook.lavish_notes.some((item) => item.includes("Lavish")));
});

test("code playbook detail output requires verified @pierre/diffs rendering", () => {
  const output = createPlaybookOutput(["code"]);

  assert.equal(output.playbook.id, "code");
  assert.match(output.playbook.use_when, /source code/);
  assert.ok(output.playbook.choose.some((item) => item.includes("FileDiff")));
  assert.ok(output.playbook.choose.some((item) => item.includes("split") && item.includes("unified")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("@pierre/diffs")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("https://esm.sh/@pierre/diffs@1.2.10?bundle")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("new FileDiff")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("Shiki theme")));
  assert.ok(output.playbook.pitfalls.some((item) => item.includes("<pre>")));
});

test("plan playbook detail output has polished guidance copy", () => {
  const output = createPlaybookOutput(["plan"]);

  assert.ok(output.playbook.structure.some((item) => item.includes("Then describe a proposed approach")));
  assert.ok(output.playbook.structure.every((item) => !item.includes("Then describe the a proposed approach")));
});

test("unknown playbook ids produce an actionable validation error", () => {
  assert.throws(
    () => createPlaybookOutput(["unknown"]),
    (error) => {
      assert.ok(error instanceof AxiError);
      assert.equal(error.code, "VALIDATION_ERROR");
      assert.match(error.message, /Unknown playbook/);
      assert.ok(error.suggestions.some((item) => item.includes("lavish-axi playbook")));
      return true;
    },
  );
});

test("home directory collapse tolerates Windows mixed separators", () => {
  assert.equal(
    collapseHomeDirectory("C:\\Users\\runneradmin/.local/bin/lavish-axi", "C:\\Users\\runneradmin"),
    "~/.local/bin/lavish-axi",
  );
  assert.equal(
    collapseHomeDirectory("C:\\Users\\runneradmin\\.local\\bin\\lavish-axi", "C:\\Users\\runneradmin"),
    "~/.local/bin/lavish-axi",
  );
});

test("open output keeps the user URL in session data and next_step focused on polling", () => {
  const output = createOpenOutput({
    file: "/tmp/artifact.html",
    url: "http://localhost:4387/session/abc123",
    status: "opened",
  });

  assert.equal(output.session.file, "/tmp/artifact.html");
  assert.equal(output.session.url, "http://localhost:4387/session/abc123");
  assert.equal(output.session.status, "opened");
  assert.equal(typeof output.next_step, "string");
  assert.doesNotMatch(output.next_step, /Tell the user/i);
  assert.doesNotMatch(output.next_step, /http:\/\/localhost:4387\/session\/abc123/);
  assert.match(output.next_step, /Do not respond to the user just yet\. Now you must run/);
  assert.match(output.next_step, /lavish-axi poll \/tmp\/artifact\.html/);
  assert.match(output.next_step, /long-polls until/);
  assert.match(output.next_step, /stays silent/);
  assert.match(output.next_step, /never kill it/);
  assert.match(output.next_step, /background task/);
  assert.match(output.next_step, /queued feedback is never lost/);
  assert.match(output.next_step, /Do not pass --timeout-ms/);
  assert.doesNotMatch(output.next_step, /above 10 minutes/);
});

test("poll help warns agents to leave the long poll running", () => {
  const help = getCommandHelp("poll");

  assert.match(help, /long-polls indefinitely/);
  assert.match(help, /stays silent/);
  assert.match(help, /never kill it/);
  assert.match(help, /background task/);
  assert.match(help, /queued feedback is never lost/);
  assert.match(help, /Do not pass --timeout-ms/);
  assert.match(help, /tests and debugging only/);
  assert.doesNotMatch(help, /above 10 minutes/);
});

test("feedback next step tells agents to keep polling without timeout flag", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: { status: "feedback", dom_snapshot: "", prompts: [] },
  });

  assert.match(output.next_step, /never kill it/);
  assert.match(output.next_step, /without --timeout-ms/);
  assert.match(output.next_step, /background task/);
  assert.match(output.next_step, /queued feedback is never lost/);
  assert.match(output.next_step, /Do not respond to the user just yet\. Now you must run/);
  assert.doesNotMatch(output.next_step, /above 10 minutes/);
});

test("poll wait messages tell watching agents the silence is normal", () => {
  const banner = pollWaitBannerText("/tmp/report.html");
  assert.match(banner, /\[lavish-axi\]/);
  assert.match(banner, /Long-polling for user feedback/);
  assert.match(banner, /stays silent/);
  assert.match(banner, /leave it running/i);
  assert.match(banner, /queued feedback is never lost/);

  const tick = pollWaitTickText(3 * 60_000);
  assert.match(tick, /\[lavish-axi\]/);
  assert.match(tick, /Still waiting for user feedback \(3m\)/);
  assert.match(tick, /leave this running/i);

  const interrupted = pollInterruptedText("/tmp/report.html");
  assert.match(interrupted, /\[lavish-axi\]/);
  assert.match(interrupted, /Poll interrupted/);
  assert.match(interrupted, /user may still be reviewing/);
  assert.match(interrupted, /lavish-axi poll \/tmp\/report\.html/);
  assert.match(interrupted, /queued feedback is never lost/);
});

test("poll wait reporter writes a banner immediately and heartbeats on an interval", async () => {
  const lines = [];
  const reporter = startPollWaitReporter({
    file: "/tmp/report.html",
    write: (line) => {
      lines.push(line);
    },
    intervalMs: 5,
  });

  try {
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Long-polling for user feedback/);

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(lines.length >= 2, "emits heartbeat lines while waiting");
    assert.match(lines[1], /Still waiting for user feedback/);
  } finally {
    reporter.stop();
  }

  const countAfterStop = lines.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(lines.length, countAfterStop, "stops heartbeating after stop()");
});

test("spawned poll announces the wait on stderr and leaves re-run guidance when killed", async () => {
  const stateDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-poll-wait-test-`);
  const artifact = `${stateDir}/artifact.html`;
  await writeFile(artifact, "<html><body>hello</body></html>", "utf8");
  const server = await serve({ port: 0, stateFile: `${stateDir}/state.json`, version: VERSION });
  try {
    const sessionResponse = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    assert.ok(sessionResponse.ok, "session opens");

    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)), "poll", artifact],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, LAVISH_AXI_STATE_DIR: stateDir, LAVISH_AXI_PORT: String(server.port) },
      },
    );

    let stderr = "";
    const sawBanner = new Promise((resolve, reject) => {
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (stderr.includes("Long-polling for user feedback")) resolve();
      });
      child.on("error", reject);
      setTimeout(() => reject(new Error(`no banner on stderr, got: ${stderr}`)), 15_000).unref();
    });
    await sawBanner;

    // Wait for "close" rather than "exit": "exit" can fire while the final stderr chunk is
    // still in flight, so asserting on stderr at "exit" races the guidance message.
    const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
    child.kill("SIGTERM");
    await closed;

    // Windows terminates Node child processes directly instead of delivering SIGTERM
    // to the child process's JavaScript signal handler.
    if (process.platform !== "win32") {
      assert.match(stderr, /Poll interrupted/);
      assert.match(stderr, /queued feedback is never lost/);
    }
  } finally {
    await server.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test("waiting next step reassures agents that re-running poll loses nothing", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: { status: "waiting" },
  });

  assert.match(output.next_step, /lavish-axi poll \/tmp\/report\.html/);
  assert.match(output.next_step, /without --timeout-ms/);
  assert.match(output.next_step, /queued feedback is never lost/);
});

test("html file arguments normalize to the hidden open command", () => {
  assert.deepEqual(normalizeArgv(["report.html"]), ["open", "report.html"]);
  assert.deepEqual(normalizeArgv(["--no-open", "report.html"]), ["open", "--no-open", "report.html"]);
  assert.deepEqual(normalizeArgv(["poll", "report.html"]), ["poll", "report.html"]);
  assert.deepEqual(normalizeArgv(["setup", "hooks"]), ["setup", "hooks"]);
  assert.deepEqual(normalizeArgv(["playbook", "diagram"]), ["playbook", "diagram"]);
  assert.deepEqual(normalizeArgv(["design"]), ["design"]);
  assert.deepEqual(normalizeArgv(["--help"]), ["--help"]);
});

test("setup hooks resolves HOME before platform-specific user profile variables", () => {
  assert.equal(
    resolveHookHomeDir({ HOME: "/tmp/lavish-home", USERPROFILE: "C:\\Users\\runneradmin" }, "/fallback"),
    "/tmp/lavish-home",
  );
});

test("setup hooks installs agent session hooks explicitly", async () => {
  const stateDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-setup-state-`);
  const homeDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-setup-home-`);
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)), "setup", "hooks"],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        env: { ...process.env, HOME: homeDir, LAVISH_AXI_STATE_DIR: stateDir },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /hooks:/);
    assert.match(result.stdout, /status: installed/);
    assert.match(result.stdout, /Restart your agent session/);
    assert.ok(existsSync(`${homeDir}/.claude/settings.json`));
  } finally {
    await rm(stateDir, { force: true, recursive: true });
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("setup hooks exits with an error when hook installation fails", async () => {
  const stateDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-setup-fail-state-`);
  const homeDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-setup-fail-home-`);
  try {
    await mkdir(`${homeDir}/.claude`, { recursive: true });
    await writeFile(`${homeDir}/.claude/settings.json`, "{ invalid json", "utf8");

    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)), "setup", "hooks"],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        env: { ...process.env, HOME: homeDir, LAVISH_AXI_STATE_DIR: stateDir },
      },
    );

    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(output, /hook/i);
    assert.doesNotMatch(result.stdout, /status: installed/);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("telemetry command names are anonymous and do not include file paths", () => {
  assert.equal(telemetryCommandName(["report.html"]), "open");
  assert.equal(telemetryCommandName(["poll", "/tmp/secret/report.html"]), "poll");
  assert.equal(telemetryCommandName(["end", "/tmp/secret/report.html"]), "end");
  assert.equal(telemetryCommandName(["playbook", "diagram"]), "playbook");
  assert.equal(telemetryCommandName(["design"]), "design");
  assert.equal(telemetryCommandName([]), "home");
});

test("server spawn options detach without inheriting invalid streams", () => {
  const options = createServerSpawnOptions();

  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
});

test("server spawn options can persist detached server output to a log fd", () => {
  const options = createServerSpawnOptions(17);

  assert.equal(options.detached, true);
  assert.deepEqual(options.stdio, ["ignore", 17, 17]);
});

test("server entry resolves to a node-executable script that actually invokes run()", () => {
  // Running from source, the entry must be `bin/lavish-axi.js` (the only file in the
  // source tree that calls run() on import). In the published bundle only `dist/cli.mjs`
  // ships - it embeds the bin wrapper so it self-invokes. Either way, spawning the entry
  // with `node <entry> server` must boot the server, not silently load the module and exit.
  const entry = resolveServerEntry();
  assert.ok(existsSync(entry), `server entry must exist on disk, got: ${entry}`);
  // From source: bin/lavish-axi.js is present and preferred.
  assert.equal(entry, fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)));
});

test("local built CLI opens force a server restart while source and installed runs do not", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));

  assert.equal(shouldForceRestartForLocalBuild(`${root}/dist/cli.mjs`, true), true);
  assert.equal(shouldForceRestartForLocalBuild(`${root}/bin/lavish-axi.js`, true), false);
  assert.equal(shouldForceRestartForLocalBuild("/usr/local/lib/node_modules/lavish-axi/dist/cli.mjs", false), false);
});

test("shouldRestartServer reuses a server running the same version", () => {
  assert.equal(shouldRestartServer("0.1.4", { ok: true, version: "0.1.4" }), false);
});

test("shouldRestartServer restarts same-version Lavish servers when forced", () => {
  assert.equal(shouldRestartServer("0.1.4", { ok: true, app: "lavish-axi", version: "0.1.4" }, true), true);
  assert.equal(shouldRestartServer("0.1.4", { ok: true, app: "other", version: "0.1.4" }, true), false);
});

test("shouldRestartServer restarts when the running server reports a different version", () => {
  // Catches the upgrade scenario: client got bumped to 0.1.4 but a 0.1.3 server is still
  // holding the port from a previous invocation.
  assert.equal(shouldRestartServer("0.1.4", { ok: true, version: "0.1.3" }), true);
});

test("shouldRestartServer restarts when the running server predates the version handshake", () => {
  // Pre-handshake servers (any release older than this change) return `{ ok: true }` with
  // no version field. Treat that as "older than me" and restart so users actually get the
  // version they just installed.
  assert.equal(shouldRestartServer("0.1.4", { ok: true }), true);
});

test("shouldRestartServer does not restart when /health was unreachable", () => {
  // null = fetch failed; the caller should fall through to startServer instead of trying
  // to POST /shutdown against nothing.
  assert.equal(shouldRestartServer("0.1.4", null), false);
});

test("shouldKillProcessOnPort does not kill unidentified health responders", () => {
  assert.equal(shouldKillProcessOnPort("0.1.4", { ok: true, app: "other", version: "0.1.3" }), false);
});

test("shouldKillProcessOnPort kills pre-handshake Lavish servers after shutdown fails", () => {
  assert.equal(shouldKillProcessOnPort("0.1.4", { ok: true }), true);
});

test("shouldKillProcessOnPort only kills Lavish servers with a mismatched version", () => {
  assert.equal(shouldKillProcessOnPort("0.1.4", { ok: true, app: "lavish-axi", version: "0.1.3" }), true);
  assert.equal(shouldKillProcessOnPort("0.1.4", { ok: true, app: "lavish-axi", version: "0.1.4" }), false);
});

test("shutdownServerOnPort kills pre-handshake Lavish servers when shutdown does not free the port", async () => {
  let shutdowns = 0;
  let kills = 0;
  const portFreeResults = [false, true];

  const output = await shutdownServerOnPort(4387, {
    baseUrl: "http://127.0.0.1:4387",
    currentVersion: "0.1.4",
    fetchHealth: async () => ({ ok: true }),
    requestShutdown: async () => {
      shutdowns += 1;
    },
    waitForPortFree: async () => portFreeResults.shift() ?? false,
    killProcessOnPort: () => {
      kills += 1;
    },
    processMatchesLavish: () => true,
  });

  assert.equal(shutdowns, 1);
  assert.equal(kills, 1);
  assert.deepEqual(output, { server: { status: "stopped", port: 4387 } });
});

test("shutdownServerOnPort ignores unidentified health responders", async () => {
  let shutdowns = 0;
  let kills = 0;

  const output = await shutdownServerOnPort(4387, {
    baseUrl: "http://127.0.0.1:4387",
    currentVersion: "0.1.4",
    fetchHealth: async () => ({ ok: true }),
    requestShutdown: async () => {
      shutdowns += 1;
    },
    waitForPortFree: async () => false,
    killProcessOnPort: () => {
      kills += 1;
    },
    processMatchesLavish: () => false,
  });

  assert.equal(shutdowns, 0);
  assert.equal(kills, 0);
  assert.deepEqual(output, { server: { status: "not-lavish", port: 4387 } });
});

test("open can resume a session without opening another browser window", () => {
  assert.equal(shouldOpenBrowser(["--no-open", "artifact.html"], {}), false);
  assert.equal(shouldOpenBrowser(["artifact.html", "--no-open"], {}), false);
  assert.equal(shouldOpenBrowser(["artifact.html"], { LAVISH_AXI_NO_OPEN: "1" }), false);
  assert.equal(shouldOpenBrowser(["artifact.html"], {}), true);
  assert.match(getCommandHelp("open"), /--no-open/);
  assert.match(getCommandHelp("playbook"), /diagram/);
  assert.match(getCommandHelp("playbook"), /code/);
  assert.match(getCommandHelp("playbook"), /input/);
  assert.doesNotMatch(getCommandHelp("playbook"), new RegExp(`${"di"}ff, input`));
  assert.doesNotMatch(getCommandHelp("playbook"), /interactive/);
  assert.match(getCommandHelp("design"), /DaisyUI/);
  assert.match(getCommandHelp("design"), /lavish-axi design/);
  assert.match(getCommandHelp("design"), /portable/);
  assert.match(getCommandHelp("design"), /prefer.*CDN snippet.*hand-writing styles/i);
  assert.match(getCommandHelp("design"), /unless.*explicitly instructed/i);
  assert.match(getCommandHelp("design"), /priority order/i);
  assert.match(getCommandHelp("design"), /current project/i);
  assert.match(getCommandHelp("design"), /fallback, not the default/i);
  assert.match(getCommandHelp("design"), /inspect the project/i);
  assert.doesNotMatch(getCommandHelp("design"), /auto-injects/);
});

test("polling a file without an active session tells the agent to open it first", () => {
  assert.throws(
    () => createPollOutput({ file: "/tmp/report.html", response: { status: "missing" } }),
    (error) => {
      assert.ok(error instanceof AxiError);
      assert.equal(error.code, "NOT_FOUND");
      assert.match(error.message, /No active Lavish Editor session/);
      assert.ok(error.suggestions.some((item) => item.includes("lavish-axi /tmp/report.html")));
      return true;
    },
  );
});

test("network fetch failures become structured Lavish server errors", async () => {
  await assert.rejects(
    () => fetchJson("http://127.0.0.1:1/api/poll"),
    (error) => {
      assert.ok(error instanceof AxiError);
      assert.equal(error.code, "SERVER_ERROR");
      assert.match(error.message, /Lavish Editor server connection failed/);
      assert.ok(error.suggestions.some((item) => item.includes("lavish-axi server --verbose")));
      return true;
    },
  );
});

test("fetchJson retries transient connection failures", async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    if (requests === 1) {
      req.socket.destroy();
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "waiting" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind to a TCP port");
    const port = address.port;
    const result = await fetchJson(`http://127.0.0.1:${port}/api/poll`, { retries: 1, retryDelayMs: 1 });

    assert.deepEqual(result, { status: "waiting" });
    assert.equal(requests, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fetchJson reports interrupted response body failures without retrying", async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind to a TCP port");
    const port = address.port;

    await assert.rejects(
      () => fetchJson(`http://127.0.0.1:${port}/api/poll`, { retries: 1, retryDelayMs: 1 }),
      (error) => {
        assert.ok(error instanceof AxiError);
        assert.equal(error.code, "SERVER_ERROR");
        assert.match(error.message, /Lavish Editor poll response was interrupted/);
        return true;
      },
    );
    assert.equal(requests, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("stop command shuts down the running server on the configured port", async () => {
  const dir = await mkdtemp(`${os.tmpdir()}/lavish-axi-stop-test-`);
  const server = await serve({ port: 0, stateFile: `${dir}/state.json`, version: "9.9.9-test" });
  try {
    const output = await stopCommand(["--port", String(server.port)]);
    assert.deepEqual(output, { server: { status: "stopped", port: server.port } });
    await server.done;
    await assert.rejects(() => fetch(`http://127.0.0.1:${server.port}/health`), /fetch failed|ECONNREFUSED/);
  } finally {
    await server.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("stop command reports when no server is running", async () => {
  const dir = await mkdtemp(`${os.tmpdir()}/lavish-axi-stop-test-`);
  try {
    // Bind then release a port so we know nothing is listening on it.
    const probe = await serve({ port: 0, stateFile: `${dir}/state.json` });
    const freePort = probe.port;
    await probe.close();

    const output = await stopCommand(["--port", String(freePort)]);
    assert.deepEqual(output, { server: { status: "not-running", port: freePort } });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
