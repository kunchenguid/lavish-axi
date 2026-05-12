import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import { AxiError } from "axi-sdk-js";

import {
  collapseHomeDirectory,
  createHomeOutput,
  createOpenOutput,
  createPollOutput,
  createServerSpawnOptions,
  getCommandHelp,
  normalizeArgv,
  shouldOpenBrowser,
  telemetryCommandName,
} from "../src/cli.js";

test("home output teaches agents when and how to use Lavish Editor", () => {
  const output = createHomeOutput({ bin: `${os.homedir()}/.local/bin/lavish-axi`, sessions: [] });

  assert.equal(output.bin, "~/.local/bin/lavish-axi");
  assert.match(output.description, /Lavish Editor/);
  assert.match(output.description, /First generate an interactive HTML artifact/);
  assert.deepEqual(output.sessions, []);
  assert.equal(output.use_cases, undefined);
  assert.ok(output.example_use_cases.some((item) => item.includes("plans with diagrams")));
  assert.ok(output.example_use_cases.some((item) => item.includes("Brainstorming early ideas")));
  assert.ok(output.artifact_guidance.some((item) => item.includes("`.lavish/`")));
  assert.ok(output.artifact_guidance.some((item) => item.includes("window.lavish.queuePrompt")));
  assert.ok(output.visual_guidance.some((item) => item.includes("visual point of view")));
  assert.ok(output.help.some((item) => item.includes("lavish-axi <html-file>")));
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

test("open output uses one next_step string for user URL and polling", () => {
  const output = createOpenOutput({
    file: "/tmp/artifact.html",
    url: "http://localhost:4387/session/abc123",
    status: "opened",
  });

  assert.equal(output.session.file, "/tmp/artifact.html");
  assert.equal(output.session.url, "http://localhost:4387/session/abc123");
  assert.equal(output.session.status, "opened");
  assert.equal(typeof output.next_step, "string");
  assert.match(output.next_step, /Tell the user to open http:\/\/localhost:4387\/session\/abc123/);
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
});

test("html file arguments normalize to the hidden open command", () => {
  assert.deepEqual(normalizeArgv(["report.html"]), ["open", "report.html"]);
  assert.deepEqual(normalizeArgv(["--no-open", "report.html"]), ["open", "--no-open", "report.html"]);
  assert.deepEqual(normalizeArgv(["poll", "report.html"]), ["poll", "report.html"]);
  assert.deepEqual(normalizeArgv(["--help"]), ["--help"]);
});

test("telemetry command names are anonymous and do not include file paths", () => {
  assert.equal(telemetryCommandName(["report.html"]), "open");
  assert.equal(telemetryCommandName(["poll", "/tmp/secret/report.html"]), "poll");
  assert.equal(telemetryCommandName(["end", "/tmp/secret/report.html"]), "end");
  assert.equal(telemetryCommandName([]), "home");
});

test("server spawn options detach without inheriting invalid streams", () => {
  const options = createServerSpawnOptions();

  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
});

test("open can resume a session without opening another browser window", () => {
  assert.equal(shouldOpenBrowser(["--no-open", "artifact.html"], {}), false);
  assert.equal(shouldOpenBrowser(["artifact.html", "--no-open"], {}), false);
  assert.equal(shouldOpenBrowser(["artifact.html"], { LAVISH_AXI_NO_OPEN: "1" }), false);
  assert.equal(shouldOpenBrowser(["artifact.html"], {}), true);
  assert.match(getCommandHelp("open"), /--no-open/);
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
