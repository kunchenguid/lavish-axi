import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  getCommandHelp,
  normalizeArgv,
  resolveServerEntry,
  shouldForceRestartForLocalBuild,
  shouldKillProcessOnPort,
  shouldOpenBrowser,
  shouldRestartServer,
  telemetryCommandName,
  VERSION,
} from "../src/cli.js";

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
  assert.ok(output.help.some((item) => item.includes("Tailwind CSS browser runtime v4")));
  assert.ok(output.help.some((item) => item.includes('<meta name="lavish-design" content="off">')));
  assert.ok(output.help.some((item) => item.includes("lavish-axi design")));
  assert.ok(!output.help.some((item) => item.includes("Known IDs")));
  assert.ok(output.help.some((item) => item.includes("technical plan")));
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
    assert.match(result.stdout, /Tailwind CSS browser runtime v4/);
    assert.match(result.stdout, /lavish-axi design/);
    assert.match(result.stdout, /lavish-design/);
    assert.doesNotMatch(result.stdout, /sessions\[/);
    assert.doesNotMatch(result.stdout, /Known IDs/);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test("design output documents the auto-injected DaisyUI system", () => {
  const output = createDesignOutput();

  assert.match(output.design.summary, /Tailwind CSS browser runtime v4/);
  assert.match(output.design.summary, /DaisyUI v5/);
  assert.match(output.design.rule, /Do not add Tailwind or DaisyUI/);
  assert.match(output.design.opt_out, /<meta name="lavish-design" content="off">/);
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

test("playbook index output lists known playbooks with concise descriptions", () => {
  const output = createPlaybookOutput([]);

  assert.equal(output.playbooks.length, 7);
  assert.deepEqual(
    output.playbooks.map((playbook) => playbook.id),
    ["diagram", "table", "comparison", "plan", "diff", "input", "slides"],
  );
  assert.equal(
    output.playbooks.find((playbook) => playbook.id === "plan")?.use_when,
    "Explain a technical plan before implementation",
  );
  assert.equal(
    output.playbooks.find((playbook) => playbook.id === "input")?.use_when,
    "Must be used when the agent needs to collect user input on decisions, choices, preferences, triage, scope, or other structured feedback from within the artifact",
  );
  assert.ok(output.playbooks.every((playbook) => playbook.use_when.length > 20));
  assert.ok(output.help.some((item) => item.includes("lavish-axi playbook <playbook_id>")));
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
  assert.match(output.next_step, /do not set a short shell timeout/i);
  assert.match(output.next_step, /above 10 minutes/);
  assert.match(output.next_step, /Do not pass --timeout-ms/);
});

test("poll help warns agents not to use short shell timeouts", () => {
  const help = getCommandHelp("poll");

  assert.match(help, /long-polls indefinitely/);
  assert.match(help, /do not set a short shell timeout/);
  assert.match(help, /above 10 minutes/);
  assert.match(help, /Do not pass --timeout-ms/);
  assert.match(help, /tests and debugging only/);
});

test("feedback next step tells agents to keep polling without timeout flag", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: { status: "feedback", dom_snapshot: "", prompts: [] },
  });

  assert.match(output.next_step, /without --timeout-ms/);
  assert.match(output.next_step, /above 10 minutes/);
  assert.match(output.next_step, /Do not respond to the user just yet\. Now you must run/);
});

test("html file arguments normalize to the hidden open command", () => {
  assert.deepEqual(normalizeArgv(["report.html"]), ["open", "report.html"]);
  assert.deepEqual(normalizeArgv(["--no-open", "report.html"]), ["open", "--no-open", "report.html"]);
  assert.deepEqual(normalizeArgv(["poll", "report.html"]), ["poll", "report.html"]);
  assert.deepEqual(normalizeArgv(["playbook", "diagram"]), ["playbook", "diagram"]);
  assert.deepEqual(normalizeArgv(["design"]), ["design"]);
  assert.deepEqual(normalizeArgv(["--help"]), ["--help"]);
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

test("open can resume a session without opening another browser window", () => {
  assert.equal(shouldOpenBrowser(["--no-open", "artifact.html"], {}), false);
  assert.equal(shouldOpenBrowser(["artifact.html", "--no-open"], {}), false);
  assert.equal(shouldOpenBrowser(["artifact.html"], { LAVISH_AXI_NO_OPEN: "1" }), false);
  assert.equal(shouldOpenBrowser(["artifact.html"], {}), true);
  assert.match(getCommandHelp("open"), /--no-open/);
  assert.match(getCommandHelp("playbook"), /diagram/);
  assert.match(getCommandHelp("playbook"), /input/);
  assert.doesNotMatch(getCommandHelp("playbook"), /interactive/);
  assert.match(getCommandHelp("design"), /DaisyUI/);
  assert.match(getCommandHelp("design"), /lavish-axi design/);
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
