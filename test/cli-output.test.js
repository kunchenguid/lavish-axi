import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AxiError } from "axi-sdk-js";

import {
  collapseHomeDirectory,
  computeCopilotCliHookUpdate,
  createCopilotCliAmbientContextScript,
  createCopilotCliSessionStartHook,
  createDesignOutput,
  createExportOutput,
  createHomeOutput,
  createOpenOutput,
  createPollOutput,
  createPlaybookOutput,
  createServerSpawnOptions,
  createShareOutput,
  createUserEndedOpenOutput,
  fetchJson,
  getCommandHelp,
  normalizeArgv,
  pollInterruptedText,
  pollWaitBannerText,
  pollWaitTickText,
  resolveCopilotHookDir,
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

function setupHooksEnv(homeDir, stateDir) {
  // eslint-disable-next-line no-unused-vars
  const { COPILOT_HOME, ...env } = process.env;
  return { ...env, HOME: homeDir, LAVISH_AXI_STATE_DIR: stateDir };
}

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
  assert.ok(output.visual_guidance.length <= 5);
  assert.ok(output.visual_guidance.some((item) => item.includes("visual hierarchy")));
  assert.ok(
    output.visual_guidance.some((item) => /screenshot/i.test(item) && /embed/i.test(item) && /prose/i.test(item)),
  );
  assert.ok(output.visual_guidance.some((item) => item.includes("sections, cards, tables")));
  assert.ok(output.visual_guidance.some((item) => item.includes("horizontal overflow")));
  assert.ok(output.visual_guidance.some((item) => item.includes("minmax(0, 1fr)")));
  assert.ok(output.visual_guidance.some((item) => /nested grid\/flex/i.test(item)));
  assert.ok(output.visual_guidance.some((item) => /pixel or monospace fonts/i.test(item)));
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
  assert.ok(output.help.some((item) => item.includes("MUST open each matching playbook")));
  assert.ok(output.help.some((item) => item.includes("reference other filesystem assets")));
  assert.ok(output.help.some((item) => item.includes("same directory as the HTML file")));
  assert.ok(output.help.some((item) => item.includes("does not auto-inject")));
  assert.ok(output.help.some((item) => item.includes("portable")));
  assert.ok(output.help.some((item) => item.includes("Tailwind CSS browser runtime v4")));
  assert.ok(output.help.some((item) => item.includes("lavish-axi design")));
  assert.ok(output.help.some((item) => /prefer.*CDN snippet.*hand-writing styles/i.test(item)));
  assert.ok(output.help.some((item) => /unless.*explicitly instructed/i.test(item)));
  assert.ok(output.help.some((item) => /priority order/i.test(item)));
  assert.ok(output.help.some((item) => /subject or product/i.test(item)));
  assert.ok(output.help.some((item) => /current working directory/i.test(item)));
  assert.ok(output.help.some((item) => /before writing any html/i.test(item)));
  assert.ok(output.help.some((item) => /inspect the project the artifact is about/i.test(item)));
  assert.ok(output.help.some((item) => /previews, proposes, or mocks/i.test(item)));
  assert.ok(output.help.some((item) => /app's own design system/i.test(item)));
  assert.ok(output.help.some((item) => /css variables|design tokens/i.test(item)));
  assert.ok(output.help.some((item) => /component library/i.test(item)));
  assert.ok(output.help.some((item) => /only when both steps come up empty/i.test(item)));
  assert.ok(output.help.some((item) => /state which of the three design sources/i.test(item)));
  assert.ok(!output.help.some((item) => /inspect the current project/i.test(item)));
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
    assert.match(result.stdout, /subject or product/i);
    assert.match(result.stdout, /current working directory/i);
    assert.match(result.stdout, /inspect the project the artifact is about/i);
    assert.match(result.stdout, /previews, proposes, or mocks/i);
    assert.match(result.stdout, /app's own design system/i);
    assert.doesNotMatch(result.stdout, /inspect the current project/i);
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

  assert.match(output.playbook_router.instruction, /MUST open each matching playbook before writing HTML/);
  assert.equal(output.playbook_router.playbooks.length, 7);
  assert.equal(
    output.playbook_router.playbooks.find((playbook) => playbook.id === "diagram")?.use_when,
    "Map relationships, flows, state, and architecture",
  );
  assert.match(output.design.summary, /does not auto-inject/);
  assert.match(output.design.summary, /Tailwind CSS browser runtime v4/);
  assert.match(output.design.summary, /DaisyUI v5/);
  assert.match(output.design.summary, /prefer.*CDN snippet.*hand-writing styles/i);
  assert.match(output.design.summary, /unless.*explicitly instructed/i);
  assert.match(output.design.summary, /priority order/i);
  assert.match(output.design.summary, /subject or product/i);
  assert.match(output.design.summary, /current working directory/i);
  assert.match(output.design.summary, /previews, proposes, or mocks/i);
  assert.match(output.design.summary, /app's own design system/i);
  assert.doesNotMatch(output.design.summary, /inspect the current project/i);
  assert.match(output.design.summary, /^Use this .*fallback only if/i);
  assert.match(output.design.summary, /no design direction/i);
  assert.match(output.design.summary, /inspect/i);
  assert.match(output.design.summary, /check first/i);
  assert.match(output.design.cdn_snippet, /cdn\.jsdelivr\.net\/npm\/daisyui@/);
  assert.match(output.design.cdn_snippet, /cdn\.jsdelivr\.net\/npm\/daisyui@.*\/themes\.css/);
  assert.match(output.design.cdn_snippet, /cdn\.jsdelivr\.net\/npm\/@tailwindcss\/browser@/);
  assert.match(output.design.layout_safety_snippet, /min-width: 0/);
  assert.match(output.design.layout_safety_snippet, /overflow-wrap: anywhere/);
  assert.match(output.design.layout_safety_snippet, /max-width: 100%/);
  assert.match(output.design.layout_safety_note, /Optional copy-paste CSS/);
  assert.match(output.design.layout_safety_note, /never auto-injects/);
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
  assert.match(output.diagram_tooling.use_when, /flows \/ architecture \/ state \/ sequence diagrams/);
  assert.match(output.diagram_tooling.use_when, /hand-built div\/flexbox boxes/);
  assert.match(output.diagram_tooling.mermaid_cdn_snippet, /cdn\.jsdelivr\.net\/npm\/mermaid@\d+\.\d+\.\d+/);
  assert.match(output.diagram_tooling.mermaid_cdn_snippet, /mermaid\.initialize/);
  assert.match(output.diagram_tooling.mermaid_cdn_snippet, /startOnLoad: true/);
  assert.match(
    output.diagram_tooling.cdn_urls.mermaid,
    /^https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@\d+\.\d+\.\d+\/dist\/mermaid\.esm\.min\.mjs$/,
  );
  assert.equal(output.diagram_tooling.versions.mermaid, "11.15.0");
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
  assert.ok(output.help.some((item) => item.includes("MUST open each matching playbook")));
});

test("diagram playbook names the hand-built flow anti-pattern", () => {
  const output = createPlaybookOutput(["diagram"]);

  assert.ok(output.playbook.choose.some((item) => item.includes("Mermaid")));
  assert.ok(output.playbook.pitfalls.some((item) => /hand-build boxes-and-arrows/i.test(item)));
  assert.ok(output.playbook.pitfalls.some((item) => /div\/flexbox/i.test(item)));
  assert.ok(output.playbook.pitfalls.some((item) => /does not auto-route edges/i.test(item)));
});

test("playbook detail output returns focused Lavish-native guidance", () => {
  const output = createPlaybookOutput(["input"]);

  assert.equal(output.playbook.id, "input");
  assert.match(output.playbook.use_when, /Must be used/);
  assert.match(output.playbook.use_when, /collect user input/);
  assert.ok(output.playbook.choose.some((item) => item.includes("control")));
  assert.ok(output.playbook.structure.some((item) => item.includes("decision")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("queuePrompt")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("per-question form submit")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("radio change handlers")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("data-lavish-action")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("data-lavish-question")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("queueKey")));
  assert.ok(output.playbook.lavish_notes.some((item) => item.includes("window.lavish.queuePrompt")));
  assert.ok(output.playbook.lavish_notes.some((item) => item.includes("onsubmit")));
  assert.ok(output.playbook.pitfalls.some((item) => item.includes("unclear")));
  assert.ok(output.playbook.pitfalls.some((item) => item.includes("radio change")));
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
  assert.match(output.next_step, /layout_warnings/);
  assert.match(output.next_step, /in-iframe layout audit/);
  assert.match(output.next_step, /stays silent/);
  assert.match(output.next_step, /never kill it/);
  assert.match(output.next_step, /background task/);
  assert.match(output.next_step, /queued feedback is never lost/);
  assert.match(output.next_step, /Do not pass --timeout-ms/);
  assert.doesNotMatch(output.next_step, /above 10 minutes/);
  assert.match(output.next_step, /If the user ends the session, stop polling and do not reopen it/);
  assert.match(output.next_step, /--reopen/);
});

test("a user-ended open refuses with a status agents can branch on, not a URL to open", () => {
  const output = createUserEndedOpenOutput({
    file: "/tmp/artifact.html",
    url: "http://localhost:4387/session/abc123",
  });

  assert.equal(output.session.file, "/tmp/artifact.html");
  assert.equal(output.session.status, "user-ended");
  assert.match(output.next_step, /user explicitly ended this Lavish Editor session from the browser/);
  assert.match(output.next_step, /did not reopen it/);
  assert.match(output.next_step, /Do not reopen unless the user asks for further review/);
  assert.match(output.next_step, /lavish-axi \/tmp\/artifact\.html --reopen/);
});

test("export output reports the written file and reassures it needs no server", () => {
  const output = createExportOutput({
    source: "/tmp/report.html",
    output: "/tmp/report.export.html",
    html: "<html></html>",
    warnings: [],
  });

  assert.equal(output.export.source, "/tmp/report.html");
  assert.equal(output.export.output, "/tmp/report.export.html");
  assert.equal(output.export.unresolved_local_assets, 0);
  assert.equal(output.export.bytes, Buffer.byteLength("<html></html>"));
  assert.match(output.next_step, /no Lavish server/);
  assert.match(output.next_step, /remote CDN\/font references are left as links/);
});

test("export output surfaces local assets that could not be inlined", () => {
  const output = createExportOutput({
    source: "/tmp/report.html",
    output: "/tmp/report.export.html",
    html: "<html></html>",
    warnings: [{ kind: "load-failed", ref: "./missing.png" }],
  });

  assert.deepEqual(output.unresolved_local_assets, [{ kind: "load-failed", ref: "./missing.png" }]);
  assert.match(output.next_step, /LOCAL assets could not be inlined/);
});

test("export output counts active srcdoc refs as unresolved assets", () => {
  const output = createExportOutput({
    source: "/tmp/report.html",
    output: "/tmp/report.export.html",
    html: "<html></html>",
    warnings: [{ kind: "srcdoc-resource", ref: "local.png" }],
  });

  assert.equal(output.export.unresolved_local_assets, 1);
  assert.deepEqual(output.unresolved_local_assets, [{ kind: "srcdoc-resource", ref: "local.png" }]);
  assert.equal("notices" in output, false);
});

test("export output separates unresolved assets from notices", () => {
  const output = createExportOutput({
    source: "/tmp/report.html",
    output: "/tmp/report.export.html",
    html: "<html></html>",
    warnings: [
      { kind: "load-failed", ref: "./missing.png", reason: "ENOENT" },
      { kind: "file-url-redacted", ref: "file:///Users/kun/secret.png" },
      { kind: "csp-meta", ref: "script-src 'self'" },
    ],
  });

  assert.equal(output.export.unresolved_local_assets, 1);
  assert.equal(output.export.notices, 2);
  assert.deepEqual(output.unresolved_local_assets, [{ kind: "load-failed", ref: "./missing.png", reason: "ENOENT" }]);
  assert.deepEqual(output.notices, [
    { kind: "file-url-redacted", ref: "file:///Users/kun/secret.png" },
    { kind: "csp-meta", ref: "script-src 'self'" },
  ]);
  assert.equal(output.warnings.length, 3);
});

test("export command writes a portable HTML file next to the artifact", async () => {
  const dir = await mkdtemp(`${os.tmpdir()}/lavish-axi-export-test-`);
  const artifact = `${dir}/report.html`;
  await writeFile(`${dir}/theme.css`, ".btn{color:rebeccapurple}", "utf8");
  await writeFile(
    artifact,
    '<!doctype html><html><head><link rel="stylesheet" href="theme.css">' +
      '<link rel="stylesheet" href="https://cdn.example/app.css"></head><body><h1>Hi</h1></body></html>',
    "utf8",
  );
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)), "export", artifact],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, LAVISH_AXI_STATE_DIR: dir, LAVISH_AXI_TELEMETRY: "0" },
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /report\.export\.html/);
    const exported = await readFile(`${dir}/report.export.html`, "utf8");
    // local stylesheet inlined; remote stylesheet left as a link; SDK stripped
    assert.match(exported, /<style>\.btn\{color:rebeccapurple\}<\/style>/);
    assert.match(exported, /<link rel="stylesheet" href="https:\/\/cdn\.example\/app\.css">/);
    assert.doesNotMatch(exported, /sdk\.js/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("export command treats --out value as an option operand, not the source file", async () => {
  const dir = await mkdtemp(`${os.tmpdir()}/lavish-axi-export-test-`);
  const artifact = `${dir}/report.html`;
  const output = `${dir}/custom.html`;
  await writeFile(artifact, "<!doctype html><html><body><h1>Hi</h1></body></html>", "utf8");
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)), "export", "--out", output, artifact],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, LAVISH_AXI_STATE_DIR: dir, LAVISH_AXI_TELEMETRY: "0" },
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /custom\.html/);
    assert.match(await readFile(output, "utf8"), /<h1>Hi<\/h1>/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("share output reports the public url and the secret update key", () => {
  const output = createShareOutput({
    source: "/tmp/report.html",
    site: { url: "https://x.ht-ml.app/", site_id: "x", update_key: "uk_secret", status: "active" },
    warnings: [],
  });

  assert.equal(output.share.source, "/tmp/report.html");
  assert.equal(output.share.url, "https://x.ht-ml.app/");
  assert.equal(output.share.update_key, "uk_secret");
  assert.equal(output.share.public, true);
  assert.equal(output.share.visibility, "public");
  assert.match(output.next_step, /PUBLIC/);
  assert.match(output.next_step, /update_key/);
  assert.match(output.next_step, /x\.ht-ml\.app/);
  assert.match(output.next_step, /ht-ml\.app \(https:\/\/ht-ml\.app\), a third-party host not part of Lavish/);
});

test("password-protected share output tells viewers they also need the password", () => {
  const output = createShareOutput({
    source: "/tmp/report.html",
    site: { url: "https://x.ht-ml.app/", site_id: "x", update_key: "uk_secret", status: "active" },
    warnings: [],
    passwordProtected: true,
  });

  assert.equal(output.share.password_protected, true);
  assert.equal(output.share.public, false);
  assert.equal(output.share.visibility, "private");
  assert.match(output.next_step, /PASSWORD-PROTECTED/);
  assert.match(output.next_step, /viewers also need the password/);
  assert.match(output.next_step, /ht-ml\.app \(https:\/\/ht-ml\.app\), a third-party host not part of Lavish/);
  assert.doesNotMatch(output.next_step, /anyone with the link can view/);
});

test("share output surfaces local assets that could not be inlined", () => {
  const output = createShareOutput({
    source: "/tmp/report.html",
    site: { url: "https://x.ht-ml.app/", site_id: "x", update_key: "uk_secret", status: "active" },
    warnings: [{ kind: "load-failed", ref: "./missing.png" }],
  });

  assert.equal(output.share.unresolved_local_assets, 1);
  assert.deepEqual(output.unresolved_local_assets, [{ kind: "load-failed", ref: "./missing.png" }]);
  assert.match(output.next_step, /LOCAL assets could not be inlined/);
  assert.match(output.next_step, /ht-ml\.app \(https:\/\/ht-ml\.app\), a third-party host not part of Lavish/);
  assert.doesNotMatch(output.next_step, /share this URL/);
});

test("share output separates unresolved assets from notices", () => {
  const output = createShareOutput({
    source: "/tmp/report.html",
    site: { url: "https://x.ht-ml.app/", site_id: "x", update_key: "uk_secret", status: "active" },
    warnings: [
      { kind: "module-external", ref: "./main.js" },
      { kind: "file-url-redacted", ref: "file:///Users/kun/secret.png" },
      { kind: "csp-meta", ref: "script-src 'self'" },
    ],
  });

  assert.equal(output.share.unresolved_local_assets, 1);
  assert.equal(output.share.notices, 2);
  assert.deepEqual(output.unresolved_local_assets, [{ kind: "module-external", ref: "./main.js" }]);
  assert.deepEqual(output.notices, [
    { kind: "file-url-redacted", ref: "file:///Users/kun/secret.png" },
    { kind: "csp-meta", ref: "script-src 'self'" },
  ]);
  assert.equal(output.warnings.length, 3);
  assert.match(output.next_step, /Export notices are available in notices/);
});

test("password-protected share output with unresolved assets still mentions the password", () => {
  const output = createShareOutput({
    source: "/tmp/report.html",
    site: { url: "https://x.ht-ml.app/", site_id: "x", update_key: "uk_secret", status: "active" },
    warnings: [{ kind: "load-failed", ref: "./missing.png" }],
    passwordProtected: true,
  });

  assert.equal(output.share.public, false);
  assert.equal(output.share.visibility, "private");
  assert.match(output.next_step, /PASSWORD-PROTECTED/);
  assert.match(output.next_step, /viewers also need the password/);
  assert.match(output.next_step, /ht-ml\.app \(https:\/\/ht-ml\.app\), a third-party host not part of Lavish/);
  assert.doesNotMatch(output.next_step, /anyone with the link can view/);
});

test("share command publishes the artifact to ht-ml.app and returns the public url", async () => {
  const dir = await mkdtemp(`${os.tmpdir()}/lavish-axi-share-test-`);
  const artifact = `${dir}/report.html`;
  await writeFile(`${dir}/theme.css`, ".btn{color:teal}", "utf8");
  await writeFile(
    artifact,
    '<!doctype html><html><head><link rel="stylesheet" href="theme.css"></head><body><h1>Hi</h1></body></html>',
    "utf8",
  );

  const requests = [];
  const htmlApp = await startFakeHtmlApp(requests);
  try {
    // Use async spawn (not spawnSync): the child publishes to the fake ht-ml.app server hosted
    // on this process's event loop, which spawnSync would block, deadlocking the request.
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)), "share", "--password", "pw", artifact],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          ...process.env,
          LAVISH_AXI_STATE_DIR: dir,
          LAVISH_AXI_TELEMETRY: "0",
          LAVISH_AXI_HTML_APP_API_URL: `http://127.0.0.1:${htmlApp.port}`,
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const code = await new Promise((resolve) => child.on("close", resolve));

    assert.equal(code, 0, stderr);
    assert.match(stdout, /abc123\.ht-ml\.app/);
    assert.match(stdout, /PASSWORD-PROTECTED/);
    assert.match(stdout, /viewers also need the password/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/v1/sites");
    assert.match(requests[0].body.html_content, /<style>\.btn\{color:teal\}<\/style>/);
    assert.equal(requests[0].body.password, "pw");
  } finally {
    await htmlApp.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("share command treats a whitespace-only password as public", async () => {
  const dir = await mkdtemp(`${os.tmpdir()}/lavish-axi-share-test-`);
  const artifact = `${dir}/report.html`;
  await writeFile(artifact, "<!doctype html><html><body><h1>Hi</h1></body></html>", "utf8");

  const requests = [];
  const htmlApp = await startFakeHtmlApp(requests);
  try {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)), "share", "--password", "   ", artifact],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          ...process.env,
          LAVISH_AXI_STATE_DIR: dir,
          LAVISH_AXI_TELEMETRY: "0",
          LAVISH_AXI_HTML_APP_API_URL: `http://127.0.0.1:${htmlApp.port}`,
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const code = await new Promise((resolve) => child.on("close", resolve));

    assert.equal(code, 0, stderr);
    assert.match(stdout, /PUBLIC/);
    assert.match(stdout, /anyone with the link can view/);
    assert.doesNotMatch(stdout, /PASSWORD-PROTECTED/);
    assert.equal(requests.length, 1);
    assert.equal("password" in requests[0].body, false);
  } finally {
    await htmlApp.close();
    await rm(dir, { force: true, recursive: true });
  }
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

test("share help distinguishes public default from password-protected shares", () => {
  const help = getCommandHelp("share");
  const home = createHomeOutput({ bin: "lavish-axi", sessions: [] });
  const homeShareHelp = home.help.find((item) => item.includes("lavish-axi share <html-file>"));

  assert.match(help, /PUBLIC by default/);
  assert.match(help, /Pass --password to publish a PRIVATE password-protected page/);
  assert.match(help, /viewers must supply the password to view/);
  assert.match(help, /not blocked by CSP on ht-ml\.app/);
  assert.match(help, /load over the viewer's network/);
  assert.doesNotMatch(help, /EVERYTHING PUBLISHED IS PUBLIC/);
  assert.doesNotMatch(help, /load fine/);
  assert.match(homeShareHelp, /PUBLIC by default/);
  assert.match(homeShareHelp, /Pass --password to publish a PRIVATE password-protected page/);
  assert.doesNotMatch(homeShareHelp, /Everything published is public/);
});

test("feedback next step tells agents to keep polling without timeout flag", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: { status: "feedback", dom_snapshot: "", prompts: [] },
  });

  assert.equal("layout_warnings" in output, false);
  assert.match(output.next_step, /never kill it/);
  assert.match(output.next_step, /without --timeout-ms/);
  assert.match(output.next_step, /background task/);
  assert.match(output.next_step, /queued feedback is never lost/);
  assert.match(output.next_step, /Do not respond to the user just yet\. Now you must run/);
  assert.match(output.next_step, /fresh layout_warnings/);
  assert.doesNotMatch(output.next_step, /above 10 minutes/);
});

test("layout warning feedback tells agents to fix layout before involving the human", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [],
      layout_warnings: [
        {
          selector: "html",
          kind: "page-horizontal-overflow",
          overflowPx: 16,
          viewportWidth: 720,
          severity: "error",
        },
      ],
    },
  });

  assert.ok("layout_warnings" in output);
  assert.equal(output.layout_warnings.length, 1);
  assert.match(output.next_step, /1 layout warning detected/);
  assert.match(output.next_step, /fix horizontal overflow/);
  assert.match(output.next_step, /before involving the human/);
  assert.doesNotMatch(output.next_step, /reload or re-open/);
});

test("a poll reporting the session ended by the user tells the agent to stop and not reopen", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: { status: "ended", ended_by: "user" },
  });

  assert.equal(output.session.status, "ended");
  assert.equal(output.session.ended_by, "user");
  assert.match(output.next_step, /user ended this Lavish Editor session/);
  assert.match(output.next_step, /Stop polling/);
  assert.match(output.next_step, /do not run `lavish-axi \/tmp\/report\.html` to reopen it/);
  assert.match(output.next_step, /deliver any remaining updates directly in this conversation/i);
  assert.match(output.next_step, /lavish-axi \/tmp\/report\.html --reopen/);
});

test("a poll reporting an agent-ended session allows a plain reopen if still needed", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: { status: "ended", ended_by: "agent" },
  });

  assert.equal(output.session.ended_by, "agent");
  assert.match(output.next_step, /Stop polling/);
  assert.match(output.next_step, /lavish-axi \/tmp\/report\.html`\s+to open a fresh session/);
  assert.doesNotMatch(output.next_step, /--reopen/);
});

test("the final feedback batch before a user end flags session_ended and skips the reopen instruction", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [{ uid: "", prompt: "Parting feedback", selector: "", tag: "message", text: "bye" }],
      session_ended: true,
      ended_by: "user",
    },
  });

  assert.equal(output.session.session_ended, true);
  assert.equal(output.session.ended_by, "user");
  assert.match(output.next_step, /last feedback before the user ended the session/);
  assert.match(output.next_step, /Stop polling \/tmp\/report\.html and do not reopen it/);
  assert.match(output.next_step, /lavish-axi \/tmp\/report\.html --reopen/);
  assert.doesNotMatch(output.next_step, /reload or re-open/);
});

test("the final feedback batch before an agent end preserves ended_by and allows plain reopen", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [{ uid: "", prompt: "Parting feedback", selector: "", tag: "message", text: "bye" }],
      session_ended: true,
      ended_by: "agent",
    },
  });

  assert.equal(output.session.session_ended, true);
  assert.equal(output.session.ended_by, "agent");
  assert.match(output.next_step, /last feedback before the Lavish Editor session ended/);
  assert.match(output.next_step, /lavish-axi \/tmp\/report\.html`\s+to open a fresh session/);
  assert.doesNotMatch(output.next_step, /--reopen/);
  assert.doesNotMatch(output.next_step, /user ended this Lavish Editor session/);
});

test("persistent layout warnings after a failed fix attempt permit proceeding to the human", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [],
      layout_warnings: [
        {
          selector: "main > header > strong",
          kind: "overlapping-text",
          overflowPx: 0,
          viewportWidth: 720,
          severity: "warning",
          persistent: true,
        },
      ],
    },
  });

  assert.match(output.next_step, /already reported in a prior poll/);
  assert.match(output.next_step, /fine to proceed to the human with a short note/);
  assert.doesNotMatch(output.next_step, /fix horizontal overflow/);
});

test("low-severity text-flow warnings permit proceeding to the human without looping", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [],
      layout_warnings: [
        {
          selector: "main > header > code",
          kind: "overlapping-text",
          overflowPx: 0,
          viewportWidth: 720,
          severity: "warning",
          persistent: false,
        },
      ],
    },
  });

  assert.match(output.next_step, /low-severity layout warning/);
  assert.match(output.next_step, /fine to proceed to the human with a note/);
  assert.doesNotMatch(output.next_step, /fix horizontal overflow/);
});

test("a mix of fresh error-severity and persistent warnings still mandates a fix pass", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [],
      layout_warnings: [
        {
          selector: "html",
          kind: "page-horizontal-overflow",
          overflowPx: 16,
          viewportWidth: 720,
          severity: "error",
          persistent: false,
        },
        {
          selector: ".badge",
          kind: "clipped-text",
          overflowPx: 12,
          viewportWidth: 720,
          severity: "error",
          persistent: true,
        },
      ],
    },
  });

  assert.match(output.next_step, /2 layout warnings detected - fix horizontal overflow/);
  assert.match(output.next_step, /before involving the human/);
});

test("a mix of persistent errors and fresh low-severity warnings permits proceeding", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [],
      layout_warnings: [
        {
          selector: ".badge",
          kind: "clipped-text",
          overflowPx: 12,
          viewportWidth: 720,
          severity: "error",
          persistent: true,
        },
        {
          selector: "main > header > code",
          kind: "overlapping-text",
          overflowPx: 0,
          viewportWidth: 720,
          severity: "warning",
          persistent: false,
        },
      ],
    },
  });

  assert.match(output.next_step, /no fresh error-severity findings/);
  assert.match(output.next_step, /fine to proceed to the human with a note/);
  assert.doesNotMatch(output.next_step, /fix horizontal overflow/);
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
  assert.deepEqual(normalizeArgv(["--no-gate", "report.html"]), ["open", "--no-gate", "report.html"]);
  assert.deepEqual(normalizeArgv(["poll", "report.html"]), ["poll", "report.html"]);
  assert.deepEqual(normalizeArgv(["setup", "hooks"]), ["setup", "hooks"]);
  assert.deepEqual(normalizeArgv(["playbook", "diagram"]), ["playbook", "diagram"]);
  assert.deepEqual(normalizeArgv(["design"]), ["design"]);
  assert.deepEqual(normalizeArgv(["--help"]), ["--help"]);
});

test("SDK reserved commands pass through instead of normalizing to open", () => {
  assert.deepEqual(normalizeArgv(["update"]), ["update"]);
  assert.deepEqual(normalizeArgv(["update", "--check"]), ["update", "--check"]);
  assert.deepEqual(normalizeArgv(["update", "--help"]), ["update", "--help"]);
});

test("setup hooks resolves HOME before platform-specific user profile variables", () => {
  assert.equal(
    resolveHookHomeDir({ HOME: "/tmp/lavish-home", USERPROFILE: "C:\\Users\\runneradmin" }, "/fallback"),
    "/tmp/lavish-home",
  );
});

test("setup hooks resolves Copilot hook directory from COPILOT_HOME first", () => {
  assert.equal(
    resolveCopilotHookDir({ COPILOT_HOME: "/tmp/copilot-home", HOME: "/tmp/home" }),
    path.join("/tmp/copilot-home", "hooks"),
  );
  assert.equal(resolveCopilotHookDir({ HOME: "/tmp/home" }), path.join("/tmp/home", ".copilot", "hooks"));
});

test("setup hooks creates a Copilot CLI hook that injects additional context", () => {
  const hook = createCopilotCliSessionStartHook();
  const [updated, changed] = computeCopilotCliHookUpdate(
    {
      version: 1,
      hooks: {
        sessionStart: [{ type: "command", bash: "echo keep-me" }],
      },
    },
    hook,
  );

  assert.equal(changed, true);
  assert.equal(updated.version, 1);
  assert.equal(updated.hooks.sessionStart.length, 2);
  assert.equal(updated.hooks.sessionStart[0].bash, "echo keep-me");
  assert.match(updated.hooks.sessionStart[1].bash, /additionalContext/);
  assert.match(updated.hooks.sessionStart[1].powershell, /additionalContext/);
  assert.match(updated.hooks.sessionStart[1].bash, /lavish-axi/);
  assert.equal(updated.hooks.sessionStart[1].timeoutSec, 10);

  const [unchanged, unchangedFlag] = computeCopilotCliHookUpdate(updated, hook);
  assert.equal(unchangedFlag, false);
  assert.equal(unchanged, updated);
});

test("Copilot CLI ambient context script wraps lavish output as hook JSON", async () => {
  const tempDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-copilot-hook-`);
  try {
    const fakeCli = path.join(tempDir, "fake-lavish.js");
    await writeFile(fakeCli, 'console.log("sessions: []");\n', "utf8");
    const command = `"${process.execPath}" "${fakeCli}"`;
    const result = spawnSync(process.execPath, ["-e", createCopilotCliAmbientContextScript(command)], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.match(output.additionalContext, /## AXI ambient context: lavish-axi/);
    assert.match(output.additionalContext, /sessions: \[\]/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
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
        env: setupHooksEnv(homeDir, stateDir),
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /hooks:/);
    assert.match(result.stdout, /status: installed/);
    assert.match(result.stdout, /GitHub Copilot CLI/);
    assert.match(result.stdout, /Restart your agent session/);
    assert.ok(existsSync(`${homeDir}/.claude/settings.json`));
    assert.ok(existsSync(`${homeDir}/.copilot/hooks/lavish-axi.json`));

    const copilotHook = JSON.parse(await readFile(`${homeDir}/.copilot/hooks/lavish-axi.json`, "utf8"));
    assert.equal(copilotHook.version, 1);
    assert.equal(copilotHook.hooks.sessionStart.length, 1);
    assert.match(copilotHook.hooks.sessionStart[0].bash, /additionalContext/);
    assert.match(copilotHook.hooks.sessionStart[0].powershell, /additionalContext/);
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
        env: setupHooksEnv(homeDir, stateDir),
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
  assert.equal(shouldOpenBrowser(["--no-gate", "artifact.html"], {}), true);
  assert.equal(shouldOpenBrowser(["artifact.html"], { LAVISH_AXI_NO_OPEN: "1" }), false);
  assert.equal(shouldOpenBrowser(["artifact.html"], {}), true);
  assert.match(getCommandHelp("open"), /--no-open/);
  assert.match(getCommandHelp("open"), /--no-gate/);
  assert.match(getCommandHelp("open"), /--reopen/);
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
  assert.match(getCommandHelp("design"), /project the artifact is about/i);
  assert.match(getCommandHelp("design"), /current working directory/i);
  assert.match(getCommandHelp("design"), /previews, proposes, or mocks/i);
  assert.match(getCommandHelp("design"), /app's own design system/i);
  assert.match(getCommandHelp("design"), /fallback, not the default/i);
  assert.match(getCommandHelp("design"), /inspect the subject project/i);
  assert.doesNotMatch(getCommandHelp("design"), /inspect the current project/i);
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

async function startFakeHtmlApp(requests) {
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          site_id: "abc123",
          url: "https://abc123.ht-ml.app/",
          update_key: "uk_secret",
          status: "active",
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
