import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WebSocket from "ws";

import { AxiError } from "axi-sdk-js";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

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
  createShareUnpublishOutput,
  createShareUpdateOutput,
  createUserEndedOpenOutput,
  detectInvokingAgent,
  fetchJson,
  getCommandHelp,
  normalizeArgv,
  resolveShareRequest,
  pollInterruptedText,
  pollWaitBannerText,
  pollWaitTickText,
  resolveCopilotHookDir,
  resolveHookHomeDir,
  resolveServerEntry,
  serverReplacementReason,
  shareCommand,
  shutdownServerOnPort,
  shouldForceRestartForLocalBuild,
  shouldKillProcessOnPort,
  shouldNarratePollWaitTicks,
  shouldOpenBrowser,
  shouldRestartServer,
  startPollWaitReporter,
  stopCommand,
  telemetryCommandName,
  VERSION,
} from "../src/cli.js";
import { DESIGN_PRIORITY_RULE, DESIGN_SYSTEM_HINT } from "../src/design-reference.js";
import { resolveVsCodeSettingsFile } from "../src/plugin.js";
import { createSkillMarkdown } from "../src/skill.js";
import { SELF_PAINT_WARNING } from "../src/self-paint.js";
import { serve } from "../src/server.js";
import { canonicalFile, sessionKey } from "../src/session-store.js";

async function waitForPollListening(base, key, timeoutMs = 10_000) {
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/events/${key}`, { origin: base });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for listening presence")), timeoutMs);
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type !== "agent-presence" || message.data.state !== "listening") return;
        clearTimeout(timer);
        resolve(undefined);
      });
      socket.once("error", reject);
    });
  } finally {
    socket.close();
  }
}

/** @returns {NodeJS.ProcessEnv} */
function setupHooksEnv(homeDir, stateDir) {
  // eslint-disable-next-line no-unused-vars
  const { COPILOT_HOME, ...env } = process.env;
  return { ...env, HOME: homeDir, LAVISH_AXI_STATE_DIR: stateDir };
}

function assertObservablePollWakePath(text) {
  assert.match(text, /Keep the poll in the foreground by default/i);
  assert.match(text, /return the feedback directly to the agent/i);
  assert.match(text, /harness-native tracked background-job facility/i);
  assert.match(text, /guaranteed to resume or notify the same agent/i);
  assert.match(text, /Never use `nohup`/);
  assert.match(text, /shell `&`/);
  assert.match(text, /`disown`/);
  assert.match(text, /redirected fire-and-forget processes/);
  assert.match(text, /detached terminal without an explicit verified callback/);
  assert.match(text, /no completion-aware background facility/i);
  assert.match(text, /verified wake callback into the surrounding supervisor/i);
  assert.match(text, /Do not tell the user the artifact is being monitored until that wake path is live/i);
  assert.doesNotMatch(text, /foreground command may run.*run the poll as a background task/i);
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
  assert.ok(output.visual_guidance.length <= 6);
  assert.ok(output.visual_guidance.some((item) => item.includes("visual hierarchy")));
  assert.ok(
    output.visual_guidance.some(
      (item) =>
        /show, don't tell/i.test(item) && /inline SVG/.test(item) && /screenshot/i.test(item) && /prose/i.test(item),
    ),
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
  assert.ok(output.help.includes(DESIGN_SYSTEM_HINT), "home help carries the single-sourced design rule verbatim");
  assert.ok(!output.help.some((item) => item.includes('<meta name="lavish-design" content="off">')));
  assert.ok(!output.help.some((item) => item.includes("Known IDs")));
  assert.ok(output.help.some((item) => item.includes("technical plan")));
});

test("the design-priority rule is single-sourced and keeps its three-step semantics", () => {
  // Keyword-level checks on the one owner constant; every surface that needs the rule
  // embeds DESIGN_PRIORITY_RULE, so wording changes happen here and nowhere else.
  assert.match(DESIGN_PRIORITY_RULE, /strict priority order/);
  assert.match(DESIGN_PRIORITY_RULE, /\(1\)[\s\S]*\(2\)[\s\S]*\(3\)/);
  assert.match(DESIGN_PRIORITY_RULE, /user asked for a specific look or named design system/);
  assert.match(DESIGN_PRIORITY_RULE, /project the artifact is about/);
  assert.match(DESIGN_PRIORITY_RULE, /current working directory/);
  assert.match(DESIGN_PRIORITY_RULE, /previews, proposes, or mocks/);
  assert.match(DESIGN_PRIORITY_RULE, /app's own design system/);
  assert.match(DESIGN_PRIORITY_RULE, /Tailwind CSS browser runtime v4 \+ DaisyUI v5/);
  assert.match(DESIGN_PRIORITY_RULE, /only when both steps come up empty/);
  assert.match(DESIGN_PRIORITY_RULE, /hand-writing styles/);
  assert.match(DESIGN_PRIORITY_RULE, /unless explicitly instructed/);
  assert.doesNotMatch(DESIGN_PRIORITY_RULE, /inspect the current project/i);

  assert.ok(DESIGN_SYSTEM_HINT.includes(DESIGN_PRIORITY_RULE), "the home hint embeds the rule");
  assert.match(DESIGN_SYSTEM_HINT, /does not auto-inject/);
  assert.match(DESIGN_SYSTEM_HINT, /portable/);
  assert.match(DESIGN_SYSTEM_HINT, /lavish-axi design/);
  assert.match(DESIGN_SYSTEM_HINT, /state which of the three design sources/);
});

test("design output is the sole emitted concise explicit-background guidance", () => {
  const output = createDesignOutput();
  const instruction = "Paint an explicit page background and readable text.";
  assert.match(output.design.summary, new RegExp(instruction.replaceAll(".", "\\.")));
  assert.equal(output.self_paint_rule, undefined);

  // The diagram playbook owns the figure render-verify rule, so it is exempt from the
  // render-verify exclusivity sweep but must still not restate the background instruction.
  const diagramSurface = JSON.stringify(createPlaybookOutput(["diagram"]));
  assert.ok(!diagramSurface.includes(instruction));
  assert.match(diagramSurface, /render-verify/i);
  const otherAgentSurfaces = [
    JSON.stringify(createHomeOutput({ bin: "lavish-axi", sessions: [] })),
    getCommandHelp("design"),
    createSkillMarkdown(),
    ...["table", "comparison", "plan", "code", "input", "slides"].map((id) =>
      JSON.stringify(createPlaybookOutput([id])),
    ),
  ];
  for (const surface of otherAgentSurfaces) {
    assert.ok(!surface.includes(instruction));
    assert.doesNotMatch(surface, /render-verify/i);
  }
});

test("open output flags an artifact that never paints its own page surface", () => {
  const warned = createOpenOutput({
    file: "/tmp/artifact.html",
    url: "http://localhost:4387/session/abc123",
    status: "opened",
    selfPaintWarning: SELF_PAINT_WARNING,
  });

  assert.equal(warned.self_paint_warning, SELF_PAINT_WARNING);
  assert.match(warned.next_step, /^First fix the unpainted page surface flagged in self_paint_warning/);
  assert.match(warned.next_step, /live-reloads the artifact automatically/);
  assert.match(warned.next_step, /lavish-axi poll \/tmp\/artifact\.html/, "the poll contract stays intact");

  const clean = createOpenOutput({
    file: "/tmp/artifact.html",
    url: "http://localhost:4387/session/abc123",
    status: "opened",
  });
  assert.equal("self_paint_warning" in clean, false);
  assert.match(clean.next_step, /^Do not respond to the user just yet\./);
});

test("open output surfaces unavailable Tailscale phone access", () => {
  const output = createOpenOutput({
    file: "/tmp/artifact.html",
    url: "http://127.0.0.1:4387/session/abc123",
    status: "opened",
    networkWarning: "Tailscale binding failed; there is no phone access.",
  });
  assert.equal(output.network_warning, "Tailscale binding failed; there is no phone access.");
});

test("export and share outputs flag an unpainted page surface before it reaches a host", () => {
  const exported = createExportOutput({
    source: "/tmp/report.html",
    output: "/tmp/report.export.html",
    html: "<html></html>",
    warnings: [],
    selfPaintWarning: SELF_PAINT_WARNING,
  });
  assert.equal(exported.self_paint_warning, SELF_PAINT_WARNING);
  assert.match(exported.next_step, /^Fix the unpainted page surface flagged in self_paint_warning/);
  assert.match(exported.next_step, /no Lavish server/, "the export contract stays intact");

  const shared = createShareOutput({
    source: "/tmp/report.html",
    site: { url: "https://ht-ml.app/s/x", site_id: "x", update_key: "k" },
    warnings: [],
    selfPaintWarning: SELF_PAINT_WARNING,
  });
  assert.equal(shared.self_paint_warning, SELF_PAINT_WARNING);
  assert.match(shared.next_step, /^Fix the unpainted page surface flagged in self_paint_warning/);
  assert.match(shared.next_step, /re-run the share command/);
  assert.match(shared.next_step, /replacement URL/);
  assert.doesNotMatch(shared.next_step, /with the update_key/);

  const cleanExport = createExportOutput({
    source: "/tmp/report.html",
    output: "/tmp/report.export.html",
    html: "<html></html>",
    warnings: [],
  });
  assert.equal("self_paint_warning" in cleanExport, false);
});

test("home output warns agents that poll needs an observable wake path", () => {
  const output = createHomeOutput({ bin: "lavish-axi", sessions: [] });
  const pollHelp = output.help.find((item) => item.includes("lavish-axi poll <html-file>"));

  assert.ok(pollHelp, "home help mentions the poll command");
  assert.match(pollHelp, /long-poll/);
  assert.match(pollHelp, /stays silent/);
  assert.match(pollHelp, /never kill it/);
  assertObservablePollWakePath(pollHelp);
  assert.doesNotMatch(pollHelp, /Codex/);
  assert.match(pollHelp, /re-run/);
  assert.match(pollHelp, /feedback remains queued until delivery/);
  assert.match(pollHelp, /`Send & End` ends the session/);
  assert.match(pollHelp, /final feedback is still delivered once/);
  assert.doesNotMatch(pollHelp, /above 10 minutes/);
});

test("ambient and per-artifact output never nags about installing the plugin", () => {
  // Home output loads on every session and open/poll run constantly; setup belongs in the
  // setup surfaces only, so an install prompt here would be pure recurring token cost.
  const home = createHomeOutput({ bin: "lavish-axi", sessions: [] });

  assert.doesNotMatch(JSON.stringify(home), /setup plugin/);
  assert.doesNotMatch(JSON.stringify(home), /setup hooks/);
});

test("home output tailors poll guidance when invoked under Codex", () => {
  const output = createHomeOutput({ bin: "lavish-axi", sessions: [], agent: "codex" });
  const pollHelp = output.help.find((item) => item.includes("lavish-axi poll <html-file>"));

  assertObservablePollWakePath(pollHelp);
  assert.match(pollHelp, /Codex detected/);
  assert.match(pollHelp, /keep the poll attached to the active turn/);
});

test("home output keeps static skill poll guidance safe and agent-neutral", () => {
  const output = createHomeOutput({ bin: "lavish-axi", sessions: [], agent: "static" });
  const pollHelp = output.help.find((item) => item.includes("lavish-axi poll <html-file>"));

  assertObservablePollWakePath(pollHelp);
  assert.doesNotMatch(pollHelp, /keep the poll attached to the active turn/i);
  assert.doesNotMatch(pollHelp, /Codex detected/);
  assert.match(pollHelp, /feedback remains queued until delivery/);
});

test("invoking agent detection recognizes Codex runtime markers only", () => {
  assert.equal(detectInvokingAgent({ PATH: "/bin", CODEX_SANDBOX: "seatbelt" }), "codex");
  assert.equal(detectInvokingAgent({ PATH: "/bin", CODEX_THREAD_ID: "thread" }), "codex");
  assert.equal(detectInvokingAgent({ PATH: "/bin", CODEX_HOME: "/tmp/codex" }), "generic");
  assert.equal(detectInvokingAgent({ PATH: "/bin", CODEX_EXPERIMENTAL_FEATURE: "1" }), "generic");
  assert.equal(detectInvokingAgent({ PATH: "/bin" }), "generic");
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
    assert.match(result.stdout, /strict priority order/);
    assert.match(result.stdout, /never kill it/);
    assert.match(result.stdout, /feedback remains queued until delivery/);
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
    "Explain relationships, flows, state, architecture, and concepts with illustrations",
  );
  assert.ok(output.design.summary.includes(DESIGN_PRIORITY_RULE), "design summary embeds the single-sourced rule");
  assert.match(output.design.summary, /does not auto-inject/);
  assert.match(output.design.summary, /^Use this .*fallback only if/i);
  assert.match(output.design.summary, /no design direction/i);
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
  assert.match(output.whiteboard_tooling.use_when, /^Opt-in only/);
  assert.match(output.whiteboard_tooling.use_when, /asks for an editable whiteboard/);
  assert.match(output.whiteboard_tooling.use_when, /hand-authored inline SVG per the diagram playbook/);
  assert.match(output.whiteboard_tooling.mermaid_cdn_snippet, /cdn\.jsdelivr\.net\/npm\/mermaid@\d+\.\d+\.\d+/);
  assert.match(output.whiteboard_tooling.mermaid_cdn_snippet, /mermaid\.initialize/);
  assert.match(
    output.whiteboard_tooling.cdn_urls.mermaid,
    /^https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@\d+\.\d+\.\d+\/dist\/mermaid\.esm\.min\.mjs$/,
  );
  assert.equal(output.whiteboard_tooling.versions.mermaid, "11.15.0");
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

test("diagram playbook defaults to hand-authored SVG and names the anti-patterns", () => {
  const output = createPlaybookOutput(["diagram"]);

  assert.ok(output.playbook.choose.some((item) => /Default to hand-authored inline SVG/.test(item)));
  assert.ok(output.playbook.choose.some((item) => /only when the user asks for an editable whiteboard/i.test(item)));
  assert.ok(output.playbook.pitfalls.some((item) => /hand-build boxes-and-arrows/i.test(item)));
  assert.ok(output.playbook.pitfalls.some((item) => /div\/flexbox/i.test(item)));
  assert.ok(output.playbook.pitfalls.some((item) => /reach for Mermaid to save authoring effort/i.test(item)));
});

test("diagram playbook owns assume-nothing and one-concept-per-diagram guidance", async () => {
  const output = createPlaybookOutput(["diagram"]);
  assert.ok(
    output.playbook.structure.some((item) => /knows nothing/i.test(item) && /from zero/i.test(item)),
    "the diagram playbook must tell agents to explain from zero",
  );
  assert.ok(
    output.playbook.structure.some((item) => /one concept per diagram/i.test(item)),
    "the diagram playbook must prefer one concept per diagram",
  );

  const otherSurfaces = [
    JSON.stringify(createHomeOutput({ bin: "lavish-axi", sessions: [] })),
    JSON.stringify(createDesignOutput()),
    createSkillMarkdown(),
  ];
  for (const surface of otherSurfaces) {
    assert.doesNotMatch(surface, /one concept per diagram/i);
    assert.doesNotMatch(surface, /knows nothing/i);
  }

  const stateDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-playbook-diagram-`);
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)), "playbook", "diagram"],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        env: { ...process.env, LAVISH_AXI_STATE_DIR: stateDir },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /knows nothing/i);
    assert.match(result.stdout, /one concept per diagram/i);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test("diagram playbook routes whiteboard Mermaid through the theme-aware design snippet", () => {
  const output = createPlaybookOutput(["diagram"]);

  assert.ok(
    output.playbook.design_rules.some(
      (item) => /mermaid/i.test(item) && /theme-aware/i.test(item) && /`lavish-axi design`/.test(item),
    ),
    "the whiteboard opt-in must still theme Mermaid through the design snippet instead of hardcoding one theme",
  );
});

test("design output emits a theme-aware Mermaid init that re-renders on page-theme change", () => {
  const snippet = createDesignOutput().whiteboard_tooling.mermaid_cdn_snippet;

  // The old bug: a single hardcoded Mermaid theme that ignores the page theme.
  assert.doesNotMatch(snippet, /theme:\s*["']base["']/);

  // It must choose the Mermaid theme from the page's effective light/dark
  // appearance, covering both a data-theme toggle and the OS preference.
  assert.match(snippet, /prefers-color-scheme:\s*dark/);
  assert.match(snippet, /["']dark["']/);
  assert.match(snippet, /["']default["']/);
  assert.match(snippet, /backgroundColor/);

  // Mermaid does not restyle an already-rendered SVG, so the snippet must
  // re-render: it drives rendering itself and reacts to theme changes.
  assert.match(snippet, /startOnLoad:\s*false/);
  assert.match(snippet, /mermaid\.run/);
  assert.match(snippet, /MutationObserver/);
  assert.match(snippet, /data-theme/);
  assert.match(snippet, /document\.addEventListener\(["']change["'],\s*queueRender,\s*true\)/);
  assert.match(snippet, /document\.addEventListener\(\s*["']transitionend["']/);
  assert.match(snippet, /background-color/);
  assert.match(snippet, /function compositeRgba/);
  assert.match(snippet, /colorScheme/);
  assert.match(snippet, /addEventListener\(["']change["']/);
});

test("theme-aware Mermaid snippet serializes rapid theme-change renders", async () => {
  const snippet = createDesignOutput()
    .whiteboard_tooling.mermaid_cdn_snippet.replace(/^<script type="module">\n/, "")
    .replace(/\n<\/script>$/, "")
    .replace(/^\s*import mermaid from "[^"]+";\n/m, "");
  let dark = false;
  let observedThemeMutations = false;
  const observedThemeTargets = [];
  const documentListeners = new Map();
  const initializedThemes = [];
  const mediaListeners = [];
  const pendingRenders = [];
  const loggedRenderErrors = [];
  let nextRenderError;
  let activeRenders = 0;
  let maxActiveRenders = 0;
  const renderedSources = [];
  let bodyColor = "white";
  let rootColor = "white";
  let rootColorScheme = "normal";
  const paint = {
    color: "",
    clearRect() {},
    set fillStyle(color) {
      this.color = color;
    },
    fillRect() {},
    getImageData() {
      const colors = {
        black: [0, 0, 0, 255],
        transparent: [0, 0, 0, 0],
        white: [255, 255, 255, 255],
        "white-40": [255, 255, 255, 102],
      };
      return { data: colors[this.color] };
    },
  };
  let diagramMarkup = 'flowchart TD\\n  A["OBJECTIVE:<br/>do the thing"]';
  const diagram = {
    get innerHTML() {
      return diagramMarkup;
    },
    set innerHTML(value) {
      diagramMarkup = value;
    },
    get textContent() {
      return diagramMarkup.replace(/<br\s*\/?\s*>/gi, "");
    },
    set textContent(value) {
      diagramMarkup = value;
    },
    removeAttribute() {},
  };
  const document = {
    body: { id: "body" },
    documentElement: { id: "root" },
    readyState: "complete",
    createElement() {
      return { getContext: () => paint };
    },
    querySelectorAll() {
      return [diagram];
    },
    addEventListener(type, callback, capture) {
      documentListeners.set(type, { callback, capture });
    },
  };
  const darkQuery = {
    get matches() {
      return dark;
    },
    addEventListener(type, callback) {
      assert.equal(type, "change");
      mediaListeners.push(callback);
    },
  };
  const window = {
    matchMedia() {
      return darkQuery;
    },
    addEventListener() {
      assert.fail("the snippet should render immediately after document load");
    },
  };
  class TestMutationObserver {
    constructor() {
      observedThemeMutations = true;
    }

    observe(target) {
      observedThemeTargets.push(target);
    }
  }
  const mermaid = {
    initialize({ theme }) {
      initializedThemes.push(theme);
    },
    run() {
      renderedSources.push(diagram.innerHTML);
      activeRenders += 1;
      maxActiveRenders = Math.max(maxActiveRenders, activeRenders);
      if (nextRenderError) {
        const error = nextRenderError;
        nextRenderError = undefined;
        activeRenders -= 1;
        return Promise.reject(error);
      }
      return new Promise((resolve) => {
        pendingRenders.push(() => {
          activeRenders -= 1;
          resolve();
        });
      });
    },
  };
  function finishNextRender() {
    const finish = pendingRenders.shift();
    if (!finish) throw new Error("expected a pending Mermaid render");
    finish();
  }

  new Function("mermaid", "window", "document", "MutationObserver", "getComputedStyle", "console", snippet)(
    mermaid,
    window,
    document,
    TestMutationObserver,
    (element) => ({
      backgroundColor: element === document.body ? bodyColor : rootColor,
      colorScheme: element === document.documentElement ? rootColorScheme : "normal",
    }),
    { error: (...args) => loggedRenderErrors.push(args) },
  );

  assert.equal(mediaListeners.length, 1);
  assert.equal(observedThemeMutations, true);
  assert.deepEqual(observedThemeTargets, [document.documentElement, document.body]);
  const changeListener = documentListeners.get("change");
  assert.equal(typeof changeListener?.callback, "function");
  assert.equal(changeListener?.capture, true);
  const transitionListener = documentListeners.get("transitionend");
  assert.equal(typeof transitionListener?.callback, "function");
  assert.equal(transitionListener?.capture, true);
  assert.deepEqual(initializedThemes, ["default"]);
  assert.deepEqual(renderedSources, ['flowchart TD\\n  A["OBJECTIVE:<br/>do the thing"]']);
  bodyColor = "white-40";
  rootColor = "black";
  transitionListener.callback({ propertyName: "color" });
  assert.deepEqual(initializedThemes, ["default"]);
  transitionListener.callback({ propertyName: "background-color" });
  assert.equal(maxActiveRenders, 1);
  assert.deepEqual(initializedThemes, ["default"]);

  finishNextRender();
  await Promise.resolve();
  assert.deepEqual(initializedThemes, ["default", "dark"]);
  assert.equal(maxActiveRenders, 1);

  finishNextRender();
  await Promise.resolve();
  assert.equal(activeRenders, 0);
  assert.equal(initializedThemes.filter((entry) => entry === "dark").length, 1);

  bodyColor = "transparent";
  rootColor = "transparent";
  rootColorScheme = "light";
  changeListener.callback();
  assert.deepEqual(initializedThemes, ["default", "dark", "default"]);
  finishNextRender();
  await Promise.resolve();

  rootColorScheme = "dark";
  transitionListener.callback({ propertyName: "background-color" });
  assert.deepEqual(initializedThemes, ["default", "dark", "default", "dark"]);
  finishNextRender();
  await Promise.resolve();

  const renderError = new Error("invalid Mermaid syntax");
  nextRenderError = renderError;
  rootColorScheme = "light";
  transitionListener.callback({ propertyName: "background-color" });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(loggedRenderErrors, [["Mermaid diagram render failed:", renderError]]);

  changeListener.callback();
  assert.equal(activeRenders, 1);
  finishNextRender();
  await Promise.resolve();
});

test("Mermaid after evidence embeds the shipped theme-aware snippet", async () => {
  const evidence = await readFile(new URL("../task-evidence/mermaid-theme/after.html", import.meta.url), "utf8");
  const start = evidence.indexOf('    <script type="module">');
  const closingScript = evidence.indexOf("    </script>", start);

  assert.notEqual(start, -1);
  assert.notEqual(closingScript, -1);
  assert.equal(
    evidence.slice(start, closingScript + "    </script>".length).replace(/^ {4}/gm, ""),
    createDesignOutput().whiteboard_tooling.mermaid_cdn_snippet,
  );
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
  // Keyword-level lock on the load-bearing semantics of this agent-facing string:
  // poll now (not the user-facing URL), never kill the poll, no --timeout-ms, and the
  // reopen etiquette. Sentence-level phrasing is free to change without touching this test.
  assert.doesNotMatch(output.next_step, /Tell the user (?:to open|to visit)/i);
  assert.doesNotMatch(output.next_step, /http:\/\/localhost:4387\/session\/abc123/);
  assert.match(output.next_step, /Do not respond to the user just yet\. Now you must run/);
  assert.match(output.next_step, /lavish-axi poll \/tmp\/artifact\.html/);
  assert.match(output.next_step, /Layout issues inbox/);
  assert.doesNotMatch(output.next_step, /layout_warnings/);
  assert.match(output.next_step, /never kill it/);
  assertObservablePollWakePath(output.next_step);
  assert.doesNotMatch(output.next_step, /Codex/);
  assert.match(output.next_step, /feedback remains queued until delivery/);
  assert.match(output.next_step, /Do not pass --timeout-ms/);
  assert.match(output.next_step, /If the user ends the session, stop polling and do not reopen it/);
  assert.match(output.next_step, /--reopen/);
});

test("open output gives Codex the shared wake-path contract plus an attached-turn warning", () => {
  const output = createOpenOutput({
    file: "/tmp/artifact.html",
    url: "http://localhost:4387/session/abc123",
    status: "opened",
    agent: "codex",
  });

  assertObservablePollWakePath(output.next_step);
  assert.match(output.next_step, /Codex detected/);
  assert.match(output.next_step, /keep the poll attached to the active turn/);
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

test("share dispatches create, republish, and unpublish to the right host request", async () => {
  const dir = await mkdtemp(`${os.tmpdir()}/lavish-axi-share-dispatch-`);
  const artifact = `${dir}/report.html`;
  const marker = "SECRET-ARTIFACT-BODY";
  await writeFile(artifact, `<!doctype html><html><body><h1>${marker}</h1></body></html>`, "utf8");

  const requests = [];
  const htmlApp = await startFakeHtmlApp(requests);
  const previousApiUrl = process.env.LAVISH_AXI_HTML_APP_API_URL;
  process.env.LAVISH_AXI_HTML_APP_API_URL = `http://127.0.0.1:${htmlApp.port}`;
  try {
    await shareCommand([artifact]);
    await shareCommand([artifact, "--site", "abc123", "--update-key", "uk_secret"]);
    await shareCommand([artifact, "--site", "abc123", "--update-key", "uk_secret", "--private"]);
    await shareCommand(["--unpublish", "--site", "abc123", "--update-key", "uk_secret"]);

    const [create, republish, locked, unpublish] = requests;

    assert.equal(create.method, "POST");
    assert.equal(create.url, "/v1/sites");
    assert.match(create.body.html_content, new RegExp(marker));
    assert.equal("password" in create.body, false, "a plain publish stays public");

    assert.equal(republish.method, "PUT");
    assert.equal(republish.url, "/v1/sites/abc123");
    assert.equal(republish.headers.authorization, "Bearer uk_secret");
    assert.match(republish.body.html_content, new RegExp(marker), "a republish sends the artifact");
    assert.equal("password" in republish.body, false, "a plain republish must not touch the password");

    assert.equal(locked.method, "PUT");
    assert.match(String(locked.body.password), /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/, "--private rotates");

    assert.equal(unpublish.method, "PUT");
    assert.equal(unpublish.url, "/v1/sites/abc123");
    assert.equal(unpublish.headers.authorization, "Bearer uk_secret");
    // The regression this guards: sending the artifact instead of the placeholder would republish
    // the very content the user asked to take down.
    assert.doesNotMatch(unpublish.body.html_content, new RegExp(marker));
    assert.match(unpublish.body.html_content, /has been unpublished/);
    assert.ok(unpublish.body.password, "the placeholder must be locked behind a password");
  } finally {
    await htmlApp.close();
    if (previousApiUrl === undefined) delete process.env.LAVISH_AXI_HTML_APP_API_URL;
    else process.env.LAVISH_AXI_HTML_APP_API_URL = previousApiUrl;
    await rm(dir, { recursive: true, force: true });
  }
});

async function startFailingHtmlApp(status, detail) {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const PASSWORD_SHAPE = /[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/;

// A recovery hint is only recovery if the CLI accepts it. Pull the command Lavish printed out of
// the text it printed and run it back through the real argument parser, so a hint that drifts into
// a usage error - `--site`/`--update-key` with no HTML file was one - fails here instead of on the
// user's next paste.
function parseSuggestedShareCommand(text) {
  const match = /`lavish-axi share ([^`]+)`/.exec(String(text));
  assert.ok(match, `expected a suggested share command in: ${text}`);
  const argv = match[1].trim().split(/\s+/);
  const request = resolveShareRequest(argv);
  // `<html-file>` and `<key>` fail loudly when pasted literally - one is not a file, the other
  // earns a 401 - but ANY non-empty string is a valid password, so a placeholder that reaches the
  // parser as a password value would be accepted and would rotate a live page to a secret nobody
  // was told, which ht-ml.app cannot clear. A suggested command must never carry one.
  assert.ok(
    request.generatedPassword || request.password === undefined,
    `a suggested command must not dictate a password value, got ${request.password} from: ${argv.join(" ")}`,
  );
  return request;
}

test("an indeterminate republish failure reads as unknown, with the generated password only when there is one", async () => {
  const dir = await mkdtemp(`${os.tmpdir()}/lavish-axi-share-rotate-fail-`);
  const artifact = `${dir}/report.html`;
  await writeFile(artifact, "<!doctype html><html><body><h1>Hi</h1></body></html>", "utf8");

  // A 5xx can come back after the origin already committed the PUT, so the rotation may have
  // landed and a generated password that dies with the error leaves the page gated by a secret
  // nobody holds.
  const failing = await startFailingHtmlApp(503, "upstream exploded");
  const previousApiUrl = process.env.LAVISH_AXI_HTML_APP_API_URL;
  process.env.LAVISH_AXI_HTML_APP_API_URL = `http://127.0.0.1:${failing.port}`;
  try {
    await assert.rejects(
      () => shareCommand([artifact, "--site", "abc123", "--update-key", "uk_secret", "--private"]),
      (error) => {
        assert.ok(error instanceof AxiError);
        assert.match(error.message, /upstream exploded/, "the original failure must survive");
        const hints = (error.suggestions || []).join(" ");
        assert.match(hints, PASSWORD_SHAPE, "the generated password must be recoverable");
        assert.match(hints, /may or may not have applied/i, "the outcome must read as unknown");
        assert.match(hints, /--private/);
        const suggested = parseSuggestedShareCommand(hints);
        assert.equal(suggested.mode, "update", "the suggested recovery command must be a republish");
        assert.equal(suggested.generatedPassword, true, "it must be the shape that mints a visible password");
        return true;
      },
    );

    // A plain republish mints no password, but the outcome is just as unknown: the page may
    // already show the new HTML, so reporting a flat failure tells the user the old version is
    // still up when it may not be. The password hint is the only part that is conditional.
    await assert.rejects(
      () => shareCommand([artifact, "--site", "abc123", "--update-key", "uk_secret"]),
      (error) => {
        assert.ok(error instanceof AxiError);
        assert.match(error.message, /upstream exploded/, "the original failure must survive");
        const hints = (error.suggestions || []).join(" ");
        assert.match(hints, /may or may not have applied/i, "the outcome must read as unknown");
        assert.match(hints, /may already show the new content/i);
        assert.match(hints, /safe and converges/i, "re-running must be described as safe");
        assert.doesNotMatch(`${error.message} ${hints}`, PASSWORD_SHAPE, "there is no password to hand back");
        const suggested = parseSuggestedShareCommand(hints);
        assert.equal(suggested.mode, "update");
        assert.equal(suggested.generatedPassword, false, "a plain republish must not be told to rotate");
        assert.equal(suggested.password, undefined);
        return true;
      },
    );

    // An explicit --password republish is the same: no generated secret to recover, but the retry
    // has to carry the flag or it would converge on a different page state than the one asked for.
    await assert.rejects(
      () => shareCommand([artifact, "--site", "abc123", "--update-key", "uk_secret", "--password", "hunter2"]),
      (error) => {
        assert.ok(error instanceof AxiError);
        const hints = (error.suggestions || []).join(" ");
        assert.match(hints, /may or may not have applied/i);
        assert.doesNotMatch(hints, /hunter2/, "a password the user chose is never echoed back");
        // The retry still has to set the same password, but the command may not spell a value:
        // pasted literally, a `<pw>` placeholder is accepted and locks the page to that string.
        assert.match(hints, /same --password value you supplied/i);
        const suggested = parseSuggestedShareCommand(hints);
        assert.equal(suggested.mode, "update");
        assert.equal(suggested.generatedPassword, false);
        assert.equal(suggested.password, undefined, "no password value may appear in the command");
        return true;
      },
    );
  } finally {
    await failing.close();
    if (previousApiUrl === undefined) delete process.env.LAVISH_AXI_HTML_APP_API_URL;
    else process.env.LAVISH_AXI_HTML_APP_API_URL = previousApiUrl;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a republish the host rejected never offers the generated password as if it applied", async () => {
  const dir = await mkdtemp(`${os.tmpdir()}/lavish-axi-share-rejected-`);
  const artifact = `${dir}/report.html`;
  await writeFile(artifact, "<!doctype html><html><body><h1>Hi</h1></body></html>", "utf8");

  // A mistyped update_key is the likeliest failure here. The host wrote nothing, so the generated
  // password gates nothing, and relaying it would send the user chasing a page that never changed.
  const rejecting = await startFailingHtmlApp(401, "");
  const previousApiUrl = process.env.LAVISH_AXI_HTML_APP_API_URL;
  process.env.LAVISH_AXI_HTML_APP_API_URL = `http://127.0.0.1:${rejecting.port}`;
  try {
    await assert.rejects(
      () => shareCommand([artifact, "--site", "abc123", "--update-key", "WRONG", "--private"]),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /unauthorized/i, "the host's reason must survive");
        const suggestions = error instanceof AxiError ? error.suggestions || [] : [];
        const reported = `${error.message} ${suggestions.join(" ")}`;
        assert.doesNotMatch(reported, PASSWORD_SHAPE, "a rejected republish must not surface the password");
        assert.doesNotMatch(reported, /may or may not have applied/i);
        return true;
      },
    );
  } finally {
    await rejecting.close();
    if (previousApiUrl === undefined) delete process.env.LAVISH_AXI_HTML_APP_API_URL;
    else process.env.LAVISH_AXI_HTML_APP_API_URL = previousApiUrl;
    await rm(dir, { recursive: true, force: true });
  }
});

test("an indeterminate --unpublish failure says the takedown may already have landed", async () => {
  // Same window as a republish: a 5xx can follow a PUT the origin already committed, so reporting
  // a flat failure tells the user the old content is still readable when it may already be gone.
  const failing = await startFailingHtmlApp(503, "upstream exploded");
  const previousApiUrl = process.env.LAVISH_AXI_HTML_APP_API_URL;
  process.env.LAVISH_AXI_HTML_APP_API_URL = `http://127.0.0.1:${failing.port}`;
  try {
    await assert.rejects(
      () => shareCommand(["--unpublish", "--site", "abc123", "--update-key", "uk_secret"]),
      (error) => {
        assert.ok(error instanceof AxiError);
        assert.match(error.message, /upstream exploded/, "the original failure must survive");
        const hints = (error.suggestions || []).join(" ");
        assert.match(hints, /may or may not have applied/i, "the outcome must read as unknown");
        assert.match(hints, /safe and converges/i, "re-running must be described as safe");
        // The lock password is discarded by design, so there is nothing to hand back and echoing
        // one would suggest the user could still open the page.
        assert.doesNotMatch(hints, PASSWORD_SHAPE);
        assert.equal(parseSuggestedShareCommand(hints).mode, "unpublish");
        return true;
      },
    );
  } finally {
    await failing.close();
    if (previousApiUrl === undefined) delete process.env.LAVISH_AXI_HTML_APP_API_URL;
    else process.env.LAVISH_AXI_HTML_APP_API_URL = previousApiUrl;
  }
});

test("an --unpublish the host rejected reports a plain failure, not an unknown outcome", async () => {
  const rejecting = await startFailingHtmlApp(401, "");
  const previousApiUrl = process.env.LAVISH_AXI_HTML_APP_API_URL;
  process.env.LAVISH_AXI_HTML_APP_API_URL = `http://127.0.0.1:${rejecting.port}`;
  try {
    await assert.rejects(
      () => shareCommand(["--unpublish", "--site", "abc123", "--update-key", "WRONG"]),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /unauthorized/i, "the host's reason must survive");
        const suggestions = error instanceof AxiError ? error.suggestions || [] : [];
        assert.doesNotMatch(`${error.message} ${suggestions.join(" ")}`, /may or may not have applied/i);
        return true;
      },
    );
  } finally {
    await rejecting.close();
    if (previousApiUrl === undefined) delete process.env.LAVISH_AXI_HTML_APP_API_URL;
    else process.env.LAVISH_AXI_HTML_APP_API_URL = previousApiUrl;
  }
});

test("a literal password placeholder would be accepted, which is why no suggestion prints one", () => {
  // The hazard `parseSuggestedShareCommand` guards against, proven against the real parser: unlike
  // `<html-file>` and `<key>`, a `<pw>` left literal does not fail - it is a valid password, so it
  // would reach the host and gate a live page behind that string with no way to clear it.
  const parsed = resolveShareRequest(["report.html", "--site", "abc123", "--update-key", "k", "--password", "<pw>"]);
  assert.equal(parsed.password, "<pw>", "a bracketed placeholder is a perfectly valid password value");
  assert.equal(parsed.generatedPassword, false);
});

test("an indeterminate create failure says the page may be live and unreclaimable", async () => {
  const dir = await mkdtemp(`${os.tmpdir()}/lavish-axi-share-create-fail-`);
  const artifact = `${dir}/report.html`;
  await writeFile(artifact, "<!doctype html><html><body><h1>Hi</h1></body></html>", "utf8");

  // The worst window in the feature: a 5xx after the origin committed the POST leaves the artifact
  // publicly hosted while the only copy of its update_key dies with the response, so the page can
  // never be republished or unpublished. Reporting a flat failure hides a permanent public page.
  const failing = await startFailingHtmlApp(503, "upstream exploded");
  const previousApiUrl = process.env.LAVISH_AXI_HTML_APP_API_URL;
  process.env.LAVISH_AXI_HTML_APP_API_URL = `http://127.0.0.1:${failing.port}`;
  try {
    await assert.rejects(
      () => shareCommand([artifact]),
      (error) => {
        assert.ok(error instanceof AxiError);
        assert.equal(error.code, "UNKNOWN");
        assert.match(error.message, /upstream exploded/, "the original failure must survive");
        const hints = (error.suggestions || []).join(" ");
        assert.match(hints, /may or may not have published/i, "the outcome must read as unknown");
        assert.match(hints, /PUBLICLY/, "a default share that landed is readable by anyone");
        assert.match(hints, /update_key/, "the lost credential must be named");
        assert.match(hints, /no recovery/i, "and the absence of a way back stated plainly");
        assert.match(hints, /SECOND page/, "re-running must not read as a retry that replaces it");
        return true;
      },
    );

    // --private mints a password that also dies with the response, so it is worth handing back.
    await assert.rejects(
      () => shareCommand([artifact, "--private"]),
      (error) => {
        assert.ok(error instanceof AxiError);
        const hints = (error.suggestions || []).join(" ");
        assert.match(hints, PASSWORD_SHAPE, "the generated password must be recoverable");
        assert.doesNotMatch(hints, /PUBLICLY/, "a --private page that landed is not public");
        return true;
      },
    );
  } finally {
    await failing.close();
    if (previousApiUrl === undefined) delete process.env.LAVISH_AXI_HTML_APP_API_URL;
    else process.env.LAVISH_AXI_HTML_APP_API_URL = previousApiUrl;
    await rm(dir, { recursive: true, force: true });
  }
});

async function startIncompleteHtmlApp(body) {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test("a 200 with a malformed body is reported as published, not as an unknown outcome", async () => {
  const dir = await mkdtemp(`${os.tmpdir()}/lavish-axi-share-incomplete-`);
  const artifact = `${dir}/report.html`;
  await writeFile(artifact, "<!doctype html><html><body><h1>Hi</h1></body></html>", "utf8");

  // The host answered 200, so the page definitely landed. Hedging that into "may or may not have
  // published" throws away the one thing worth saying: here is the live URL, and its write
  // credential is gone forever.
  const noKey = await startIncompleteHtmlApp({ site_id: "abc123", url: "https://abc123.ht-ml.app/" });
  const previousApiUrl = process.env.LAVISH_AXI_HTML_APP_API_URL;
  process.env.LAVISH_AXI_HTML_APP_API_URL = `http://127.0.0.1:${noKey.port}`;
  try {
    await assert.rejects(
      () => shareCommand([artifact]),
      (error) => {
        assert.ok(error instanceof AxiError);
        const hints = (error.suggestions || []).join(" ");
        assert.doesNotMatch(hints, /may or may not have published/i, "a 200 is not an unknown outcome");
        assert.match(hints, /the page IS live/i);
        assert.match(hints, /https:\/\/abc123\.ht-ml\.app\//, "the URL Lavish knows must be handed over");
        assert.match(hints, /no recovery/i, "the lost update_key has none");
        assert.match(hints, /SECOND page/);
        return true;
      },
    );
  } finally {
    await noKey.close();
    if (previousApiUrl === undefined) delete process.env.LAVISH_AXI_HTML_APP_API_URL;
    else process.env.LAVISH_AXI_HTML_APP_API_URL = previousApiUrl;
  }

  // The mirror case: no url came back, but the update_key did, so the page IS still changeable and
  // saying "no recovery" would be the opposite error.
  const noUrl = await startIncompleteHtmlApp({ site_id: "abc123", update_key: "uk_secret" });
  process.env.LAVISH_AXI_HTML_APP_API_URL = `http://127.0.0.1:${noUrl.port}`;
  try {
    await assert.rejects(
      () => shareCommand([artifact, "--private"]),
      (error) => {
        assert.ok(error instanceof AxiError);
        const hints = (error.suggestions || []).join(" ");
        assert.match(hints, /uk_secret/, "a surviving update_key must reach the user");
        assert.match(hints, /carried no url/i);
        assert.doesNotMatch(hints, /no recovery/i, "the page is still changeable with that key");
        assert.match(hints, PASSWORD_SHAPE, "the generated password still gates it");
        return true;
      },
    );
  } finally {
    await noUrl.close();
    if (previousApiUrl === undefined) delete process.env.LAVISH_AXI_HTML_APP_API_URL;
    else process.env.LAVISH_AXI_HTML_APP_API_URL = previousApiUrl;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a create whose host returns no usable site_id says the page can never be republished", async () => {
  const dir = await mkdtemp(`${os.tmpdir()}/lavish-axi-share-nosite-`);
  const artifact = `${dir}/report.html`;
  await writeFile(artifact, "<!doctype html><html><body><h1>Hi</h1></body></html>", "utf8");

  // A site_id that fails validation must never be propagated - that is the injection boundary -
  // but an empty field beside "keep it to republish later" is worse than useless: --site is half
  // the republish credential, so the user needs to learn now, not when --site rejects the value.
  const hostile = await startIncompleteHtmlApp({
    site_id: "abc123 --password evil",
    url: "https://abc123.ht-ml.app/",
    update_key: "uk_secret",
    status: "active",
  });
  const previousApiUrl = process.env.LAVISH_AXI_HTML_APP_API_URL;
  process.env.LAVISH_AXI_HTML_APP_API_URL = `http://127.0.0.1:${hostile.port}`;
  try {
    const output = await shareCommand([artifact]);
    const share = /** @type {any} */ (output.share);

    assert.equal("site_id" in share, false, "an unusable id is omitted, never emitted empty");
    assert.equal(share.update_key, "uk_secret", "the page still published");
    assert.match(output.next_step, /never be republished or unpublished/i);
    assert.doesNotMatch(output.next_step, /--password/, "and no flag may ride in through the echo");
  } finally {
    await hostile.close();
    if (previousApiUrl === undefined) delete process.env.LAVISH_AXI_HTML_APP_API_URL;
    else process.env.LAVISH_AXI_HTML_APP_API_URL = previousApiUrl;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a site_id the host echoes cannot inject flags into the suggested republish command", async () => {
  const dir = await mkdtemp(`${os.tmpdir()}/lavish-axi-share-echo-`);
  try {
    // next_step is text an agent may run. A backend reached through LAVISH_AXI_HTML_APP_API_URL
    // answering with `abc123 --password evil` would otherwise append a flag that gates the page
    // behind a value nobody chose, and ht-ml.app cannot clear a password.
    const hostile = await startIncompleteHtmlApp({
      site_id: "abc123 --password evil",
      url: "https://abc123.ht-ml.app/",
      update_key: "uk_secret",
      status: "active",
    });
    const previousApiUrl = process.env.LAVISH_AXI_HTML_APP_API_URL;
    process.env.LAVISH_AXI_HTML_APP_API_URL = `http://127.0.0.1:${hostile.port}`;
    try {
      const output = await shareCommand(["--unpublish", "--site", "abc123", "--update-key", "uk_secret"]);

      assert.doesNotMatch(output.next_step, /--password/, "no flag may be smuggled in through the echo");
      const suggested = parseSuggestedShareCommand(output.next_step);
      assert.equal(suggested.siteId, "abc123", "the command names the id the request was addressed to");
      assert.equal(suggested.generatedPassword, true, "only --private, whose password Lavish mints and reports");
    } finally {
      await hostile.close();
      if (previousApiUrl === undefined) delete process.env.LAVISH_AXI_HTML_APP_API_URL;
      else process.env.LAVISH_AXI_HTML_APP_API_URL = previousApiUrl;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a create the host rejected reports a plain failure, not an unknown outcome", async () => {
  const dir = await mkdtemp(`${os.tmpdir()}/lavish-axi-share-create-rejected-`);
  const artifact = `${dir}/report.html`;
  await writeFile(artifact, "<!doctype html><html><body><h1>Hi</h1></body></html>", "utf8");

  // A 400 is an answer: nothing was published, so claiming a page might be live would send the
  // user hunting for a URL that does not exist.
  const rejecting = await startFailingHtmlApp(400, "bad request");
  const previousApiUrl = process.env.LAVISH_AXI_HTML_APP_API_URL;
  process.env.LAVISH_AXI_HTML_APP_API_URL = `http://127.0.0.1:${rejecting.port}`;
  try {
    await assert.rejects(
      () => shareCommand([artifact, "--private"]),
      (error) => {
        assert.ok(error instanceof Error);
        const suggestions = error instanceof AxiError ? error.suggestions || [] : [];
        const reported = `${error.message} ${suggestions.join(" ")}`;
        assert.doesNotMatch(reported, /may or may not have published/i);
        assert.doesNotMatch(reported, PASSWORD_SHAPE, "a rejected create gates nothing");
        return true;
      },
    );
  } finally {
    await rejecting.close();
    if (previousApiUrl === undefined) delete process.env.LAVISH_AXI_HTML_APP_API_URL;
    else process.env.LAVISH_AXI_HTML_APP_API_URL = previousApiUrl;
    await rm(dir, { recursive: true, force: true });
  }
});

test("share reports a bad --site as a usage error before reading the artifact", async () => {
  const dir = await mkdtemp(`${os.tmpdir()}/lavish-axi-share-siteid-`);
  const artifact = `${dir}/report.html`;
  await writeFile(artifact, "<!doctype html><html><body><h1>Hi</h1></body></html>", "utf8");

  const requests = [];
  const htmlApp = await startFakeHtmlApp(requests);
  const previousApiUrl = process.env.LAVISH_AXI_HTML_APP_API_URL;
  process.env.LAVISH_AXI_HTML_APP_API_URL = `http://127.0.0.1:${htmlApp.port}`;
  try {
    // Pasting the share URL is the likeliest mistake here, since the URL is what the user holds.
    for (const site of ["https://abc123.ht-ml.app/", "not a site id", ".."]) {
      await assert.rejects(
        () => shareCommand([artifact, "--site", site, "--update-key", "k"]),
        (error) => {
          assert.ok(error instanceof AxiError, `${site} must raise an AxiError`);
          assert.equal(error.code, "VALIDATION_ERROR", `${site} must read as bad usage`);
          assert.match(error.message, /site_id/);
          return true;
        },
      );
    }
    assert.equal(requests.length, 0, "a rejected site id must never reach the host");
  } finally {
    await htmlApp.close();
    if (previousApiUrl === undefined) delete process.env.LAVISH_AXI_HTML_APP_API_URL;
    else process.env.LAVISH_AXI_HTML_APP_API_URL = previousApiUrl;
    await rm(dir, { recursive: true, force: true });
  }
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

test("share command refuses a whitespace-only password instead of quietly publishing a public page", async () => {
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

    // Asking for a password and getting an unprotected page is the surprise worth refusing: the
    // user meant to gate the artifact, and nothing downstream can tell that intent was dropped.
    assert.notEqual(code, 0);
    const output = `${stdout}${stderr}`;
    assert.match(output, /--password was given an empty value/);
    assert.match(output, /--private/);
    assert.equal(requests.length, 0, "nothing may be published when the arguments are refused");
  } finally {
    await htmlApp.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("poll help requires an observable wake path", () => {
  const help = getCommandHelp("poll");

  assert.match(help, /long-polls indefinitely/);
  assert.match(help, /stays silent/);
  assert.match(help, /never kill it/);
  assertObservablePollWakePath(help);
  assert.doesNotMatch(help, /Codex/);
  assert.match(help, /feedback remains queued until delivery/);
  assert.match(help, /Do not pass --timeout-ms/);
  assert.match(help, /tests and debugging only/);
  assert.match(help, /`Send & End` ends the session/);
  assert.match(help, /final feedback is still delivered once/);
  assert.doesNotMatch(help, /above 10 minutes/);
});

test("poll help is Codex-aware when requested", () => {
  const help = getCommandHelp("poll", { agent: "codex" });

  assertObservablePollWakePath(help);
  assert.match(help, /Codex detected/);
  assert.match(help, /keep the poll attached to the active turn/);
});

test("share help distinguishes public default from password-protected shares", () => {
  const help = getCommandHelp("share");
  const home = createHomeOutput({ bin: "lavish-axi", sessions: [] });
  const homeShareHelp = home.help.find((item) => item.includes("lavish-axi share <html-file>"));

  assert.match(help, /PUBLIC by default/);
  assert.match(help, /Pass --private to publish a PRIVATE page behind a generated password/);
  assert.match(help, /--password <pw> instead when the user chose the password/);
  assert.match(help, /shared secret/);
  assert.match(help, /not blocked by CSP on ht-ml\.app/);
  assert.match(help, /load over the viewer's network/);
  assert.doesNotMatch(help, /EVERYTHING PUBLISHED IS PUBLIC/);
  assert.doesNotMatch(help, /load fine/);
  assert.match(homeShareHelp, /PUBLIC by default/);
  assert.match(homeShareHelp, /Pass --private to publish a PRIVATE page behind a password Lavish generates/);
  assert.match(homeShareHelp, /shared secret/);
  assert.doesNotMatch(homeShareHelp, /Everything published is public/);
});

test("share help announces that an empty password value is refused rather than published public", () => {
  // Deliberate behavior change: `--password "$PW"` with an unset $PW used to publish a PUBLIC page.
  // The help is where an agent or user learns that before hitting the error.
  const help = getCommandHelp("share");
  assert.match(help, /empty or whitespace-only value is REFUSED/);
  assert.match(help, /PUBLIC page/);

  assert.throws(
    () => resolveShareRequest(["report.html", "--password", ""]),
    (error) => {
      assert.ok(error instanceof AxiError);
      assert.equal(error.code, "VALIDATION_ERROR");
      assert.match(error.message, /PUBLIC page/, "the error must name what it prevented");
      assert.match((error.suggestions || []).join(" "), /--private/, "and how to get a generated password");
      return true;
    },
  );
});

test("home share guidance defers republish and unpublish mechanics to share --help", () => {
  // Home output is paid on every no-argument invocation, so it may name the update_key and point
  // at the command that owns it, but must not restate that command's flag mechanics.
  const help = getCommandHelp("share");
  const home = createHomeOutput({ bin: "lavish-axi", sessions: [] });
  const homeShareHelp = home.help.find((item) => item.includes("lavish-axi share <html-file>"));

  assert.match(homeShareHelp, /run `lavish-axi share --help` before using it/);
  assert.doesNotMatch(homeShareHelp, /--site/);
  assert.doesNotMatch(homeShareHelp, /--update-key/);
  assert.doesNotMatch(homeShareHelp, /--unpublish/);
  assert.match(help, /--site <site_id> with --update-key <key> republishes an existing page in place/);
  assert.match(help, /--unpublish takes the same credentials and no file/);
  assert.match(help, /NO delete endpoint/);
});

test("feedback next step keeps the next poll completion observable", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: { status: "feedback", dom_snapshot: "", prompts: [] },
  });

  assert.equal("artifact_failures" in output, false);
  assert.equal("layout_warnings" in output, false);
  assert.match(output.next_step, /never kill it/);
  assert.match(output.next_step, /without --timeout-ms/);
  assertObservablePollWakePath(output.next_step);
  assert.doesNotMatch(output.next_step, /Codex/);
  assert.match(output.next_step, /feedback remains queued until delivery/);
  assert.match(output.next_step, /Do not respond to the user just yet\. Now you must run/);
  assert.doesNotMatch(output.next_step, /above 10 minutes/);
});

test("poll feedback and the next step are emitted before the bulky DOM snapshot", async () => {
  const stateDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-poll-output-test-`);
  const artifact = `${stateDir}/artifact.html`;
  await writeFile(artifact, "<html><body>hello</body></html>", "utf8");
  const response = {
    status: "feedback",
    prompts: [{ prompt: "Ship it", tag: "message" }],
    artifact_failures: [{ kind: "artifact-unavailable", detail: "HTTP 404", severity: "fatal" }],
    dom_snapshot: "large snapshot",
  };
  const server = createServer((req, res) => {
    if (new URL(req.url || "/", "http://localhost").pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, app: "lavish-axi", version: VERSION }));
      return;
    }
    if (req.url?.startsWith("/api/poll?")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)), "poll", artifact, "--timeout-ms", "1000"],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, LAVISH_AXI_STATE_DIR: stateDir, LAVISH_AXI_PORT: String(address.port) },
      },
    );
    let stdout = "";
    let stderr = "";
    assert.ok(child.stdout);
    assert.ok(child.stderr);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const result = await new Promise((resolve) => {
      child.on("close", (status, signal) => resolve({ status, signal }));
    });

    assert.equal(result.status, 0, stderr);
    const promptsIndex = stdout.indexOf("prompts[");
    const failuresIndex = stdout.indexOf("artifact_failures[");
    const nextStepIndex = stdout.indexOf("next_step:");
    const snapshotIndex = stdout.indexOf("dom_snapshot:");
    assert.ok(promptsIndex >= 0, "poll stdout contains prompts");
    assert.ok(failuresIndex >= 0, "poll stdout contains artifact_failures");
    assert.ok(nextStepIndex >= 0, "poll stdout contains next_step");
    assert.ok(snapshotIndex >= 0, "poll stdout contains dom_snapshot");
    assert.ok(promptsIndex < failuresIndex, "prompts precede artifact_failures in poll stdout");
    assert.ok(failuresIndex < nextStepIndex, "artifact_failures precede next_step in poll stdout");
    assert.ok(nextStepIndex < snapshotIndex, "next_step precedes dom_snapshot in poll stdout");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(stateDir, { force: true, recursive: true });
  }
});

test("feedback next step is Codex-aware when requested", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: { status: "feedback", dom_snapshot: "", prompts: [] },
    agent: "codex",
  });

  assertObservablePollWakePath(output.next_step);
  assert.match(output.next_step, /Codex detected/);
  assert.match(output.next_step, /keep the poll attached to the active turn/);
});

test("detected layout warnings never appear in poll output", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [{ uid: "", prompt: "Tighten the header", selector: "h1", tag: "annotation", text: "Header" }],
    },
  });

  assert.equal("layout_warnings" in output, false);
  assert.equal("artifact_failures" in output, false);
  assert.match(output.next_step, /Apply the requested changes/);
});

test("a queued layout-warnings batch reads as ordinary feedback with lifecycle guidance", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [
        {
          uid: "",
          prompt: "Fix these 2 layout issues the browser detected in this artifact:\\n1. [w1] ...",
          selector: "",
          tag: "layout-warnings",
          text: "Layout issues: 2 selected",
          target: { type: "layout-warnings", warnings: [{ id: "w1" }, { id: "w2" }] },
        },
      ],
    },
  });

  assert.equal("layout_warnings" in output, false, "no parallel protocol - it is just a prompt");
  assert.equal(output.prompts[0].tag, "layout-warnings");
  assert.match(output.next_step, /Layout issues inbox/);
  assert.match(output.next_step, /in one pass before saving so the user's review refreshes once/);
  assert.match(output.next_step, /Queueing is a repair request, not a resolution/);
  assert.match(output.next_step, /newer artifact load and a complete check at the same viewport/);
});

test("a fatal artifact failure is the only thing that reaches the agent without user action", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [],
      artifact_failures: [
        { kind: "artifact-asset-unavailable", detail: "<img> could not load /artifact/x/logo.png", severity: "fatal" },
      ],
    },
  });

  assert.ok("artifact_failures" in output);
  assert.equal(output.artifact_failures.length, 1);
  assert.match(output.next_step, /1 fatal artifact failure detected/);
  assert.match(output.next_step, /the review surface could not be used/);
  assert.match(output.next_step, /artifact-asset-unavailable/);
});

test("whiteboard feedback tells agents to read the summary, inspect files when needed, and update the Mermaid source", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [
        {
          uid: "",
          prompt: "Whiteboard edits to diagram 1:\nMoved rectangle (Auth)",
          selector: "",
          tag: "whiteboard",
          text: "Whiteboard: diagram 1",
          target: {
            type: "excalidraw-scene",
            diagramIndex: 0,
            diagramId: "mermaid-1",
            sourceHash: "abc",
            scenePath: "/state/whiteboards/k/0.excalidraw",
            previewPath: "/state/whiteboards/k/0.png",
            imageFallback: false,
            stats: { added: 0, removed: 0, moved: 1, relabeled: 0, drawn: 0 },
          },
        },
      ],
    },
  });

  assert.match(output.next_step, /whiteboard edits \(tag "whiteboard"\)/);
  assert.match(output.next_step, /read the edit summary in the prompt text first/);
  assert.match(output.next_step, /scenePath/);
  assert.match(output.next_step, /previewPath/);
  assert.match(output.next_step, /Mermaid source stays authoritative/);
  assert.match(output.next_step, /never try to write the \.excalidraw scene back/);
});

test("image-attachment feedback tells agents to open the local image paths", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [
        {
          uid: "1",
          prompt: "Match this mock",
          selector: "header",
          tag: "header",
          text: "",
          attachments: [
            {
              id: "a".repeat(64) + ".png",
              type: "image",
              path: "/state/attachments/k/" + "a".repeat(64) + ".png",
              mime: "image/png",
              bytes: 1234,
              width: 800,
              height: 600,
              name: "mock.png",
            },
          ],
        },
      ],
    },
  });

  assert.match(output.next_step, /image attachments/);
  assert.match(output.next_step, /`attachments` array/);
  assert.match(output.next_step, /absolute local `path`/);
});

test("feedback without attachments does not mention image attachments", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [{ uid: "1", prompt: "Tweak this", selector: "h1", tag: "h1", text: "" }],
    },
  });
  assert.doesNotMatch(output.next_step, /image attachments/);
});

test("non-whiteboard feedback does not mention whiteboard guidance", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [{ uid: "", prompt: "Tighten this", selector: "h1", tag: "h1", text: "Title" }],
    },
  });

  assert.doesNotMatch(output.next_step, /whiteboard/i);
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

test("final user-ended feedback still reports a fatal artifact failure without reopening", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      prompts: [],
      artifact_failures: [{ kind: "artifact-unavailable", detail: "HTTP 404", severity: "fatal" }],
      session_ended: true,
      ended_by: "user",
    },
  });

  assert.match(output.next_step, /fatal artifact failure/);
  assert.match(output.next_step, /confirm it renders without reopening this ended Lavish session/);
  assert.doesNotMatch(output.next_step, /--reopen/);
});

test("final agent-ended feedback points a fatal artifact failure at a fresh session", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      prompts: [],
      artifact_failures: [{ kind: "artifact-unavailable", detail: "HTTP 404", severity: "fatal" }],
      session_ended: true,
      ended_by: "agent",
    },
  });

  assert.match(output.next_step, /fatal artifact failure/);
  assert.match(output.next_step, /to open a fresh session/);
});

test("poll wait messages tell watching agents the silence is normal", () => {
  const banner = pollWaitBannerText("/tmp/report.html");
  assert.match(banner, /\[lavish-axi\]/);
  assert.match(banner, /Long-polling for user feedback/);
  assert.match(banner, /stays silent/);
  assert.match(banner, /leave it running/i);
  assert.match(banner, /feedback remains queued until delivery/);

  const tick = pollWaitTickText(3 * 60_000);
  assert.match(tick, /\[lavish-axi\]/);
  assert.match(tick, /Still waiting for user feedback \(3m\)/);
  assert.match(tick, /leave this running/i);

  const interrupted = pollInterruptedText("/tmp/report.html");
  assert.match(interrupted, /\[lavish-axi\]/);
  assert.match(interrupted, /Poll interrupted/);
  assert.match(interrupted, /user may still be reviewing/);
  assert.match(interrupted, /lavish-axi poll \/tmp\/report\.html/);
  assert.match(interrupted, /feedback remains queued until delivery/);
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

test("poll wait reporter still banners without ticks when narration is off", async () => {
  const lines = [];
  const reporter = startPollWaitReporter({
    file: "/tmp/report.html",
    write: (line) => {
      lines.push(line);
    },
    intervalMs: 5,
    narrateTicks: false,
  });

  try {
    assert.equal(lines.length, 1, "the one-shot not-hung banner is unconditional");
    assert.match(lines[0], /Long-polling for user feedback/);

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(lines.length, 1, "suppresses the recurring heartbeat lines");
  } finally {
    reporter.stop();
  }
});

test("shouldNarratePollWaitTicks heartbeats only in an interactive terminal", () => {
  assert.equal(shouldNarratePollWaitTicks({ isTTY: true }), true);
  assert.equal(shouldNarratePollWaitTicks({ isTTY: undefined }), false);
  assert.equal(shouldNarratePollWaitTicks({ isTTY: false }), false);
});

test("spawned poll with piped stderr banners once and leaves re-run guidance when killed", async () => {
  const stateDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-poll-wait-test-`);
  const artifact = `${stateDir}/artifact.html`;
  await writeFile(artifact, "<html><body>hello</body></html>", "utf8");
  const server = await serve({ port: 0, stateFile: `${stateDir}/state.json`, version: VERSION });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const sessionResponse = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    assert.ok(sessionResponse.ok, "session opens");

    const key = sessionKey(await canonicalFile(artifact));

    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)), "poll", artifact],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, LAVISH_AXI_STATE_DIR: stateDir, LAVISH_AXI_PORT: String(server.port) },
      },
    );

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    await waitForPollListening(base, key);
    assert.equal(
      stderr.match(/Long-polling for user feedback/g)?.length,
      1,
      "piped stderr still gets the one-shot not-hung banner",
    );
    assert.doesNotMatch(stderr, /Still waiting for user feedback/, "the banner carries no immediate wait tick");

    // Wait for "close" rather than "exit": "exit" can fire while the final stderr chunk is
    // still in flight, so asserting on stderr at "exit" races the guidance message.
    const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
    child.kill("SIGTERM");
    await closed;

    // Windows terminates Node child processes directly instead of delivering SIGTERM
    // to the child process's JavaScript signal handler.
    if (process.platform !== "win32") {
      assert.match(stderr, /Poll interrupted/);
      assert.match(stderr, /feedback remains queued until delivery/);
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
  assert.match(output.next_step, /feedback remains queued until delivery/);
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

// `copilot` is a real binary on developer machines; an empty PATH keeps `setup plugin`
// from registering the plugin into the tester's own Copilot CLI.
function setupPluginEnv(homeDir, stateDir, pathDir) {
  const env = setupHooksEnv(homeDir, stateDir);
  delete env.APPDATA;
  delete env.XDG_CONFIG_HOME;
  return { ...env, PATH: pathDir, Path: pathDir };
}

function runSetupPlugin(homeDir, stateDir, pathDir) {
  return spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)), "setup", "plugin"],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      env: setupPluginEnv(homeDir, stateDir, pathDir),
    },
  );
}

async function writeCopilotCommandStub(pathDir, options) {
  const source = `
const fs = require("node:fs");
const options = ${JSON.stringify(options)};
const args = process.argv.slice(2);
const command = args.slice(0, 2).join(" ");
if (command === "plugins list") {
  if (options.invalidList) {
    process.stdout.write("not json\\n");
  } else {
    const records = [{ kind: "plugin", name: "lavish-axi-tools", source: "direct" }];
    if (options.installedSource && fs.existsSync(options.installedSource)) {
      records.push(options.listSourcePath
        ? { kind: "plugin", name: "lavish-axi", sourcePath: fs.readFileSync(options.installedSource, "utf8") }
        : { kind: "plugin", name: "lavish-axi", source: "direct" });
    }
    process.stdout.write(JSON.stringify(records));
  }
  process.exit(0);
}
if (command === "plugin install") {
  if (options.installFails) {
    process.stderr.write("replacement failed\\n");
    process.exit(1);
  }
  const pluginRoot = args[2];
  if (options.installedSource) fs.writeFileSync(options.installedSource, pluginRoot);
  if (options.copilotConfig) {
    fs.writeFileSync(options.copilotConfig, JSON.stringify({
      installedPlugins: [{ name: "lavish-axi", source: { source: "local", path: pluginRoot } }],
    }));
  }
  if (options.installLog) fs.appendFileSync(options.installLog, "install\\n");
  process.exit(0);
}
process.exit(1);
`;
  if (process.platform === "win32") {
    const script = path.join(pathDir, "copilot-stub.cjs");
    await writeFile(script, source, "utf8");
    await writeFile(path.join(pathDir, "copilot.cmd"), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");
    return;
  }
  await writeFile(path.join(pathDir, "copilot"), `#!${process.execPath}\n${source}`, {
    encoding: "utf8",
    mode: 0o755,
  });
}

test("setup plugin registers the installed package in the clients that are present", async () => {
  const stateDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-plugin-state-`);
  const homeDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-plugin-home-`);
  const pathDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-plugin-path-`);
  try {
    await mkdir(`${homeDir}/.cursor`, { recursive: true });

    const result = runSetupPlugin(homeDir, stateDir, pathDir);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /name: lavish-axi/);
    assert.match(result.stdout, /cursor,registered/);
    // No VS Code settings and no copilot binary in this environment.
    assert.match(result.stdout, /vscode,absent/);
    assert.match(result.stdout, /copilot,absent/);

    // The registered slot points at the package root, which is where plugin.json lives.
    const linked = await realpath(`${homeDir}/.cursor/plugins/local/lavish-axi`);
    assert.equal(linked, await realpath(fileURLToPath(new URL("..", import.meta.url))));
    assert.ok(existsSync(`${linked}/plugin.json`));
    assert.ok(existsSync(`${linked}/skills/lavish/SKILL.md`));
  } finally {
    await rm(stateDir, { force: true, recursive: true });
    await rm(homeDir, { force: true, recursive: true });
    await rm(pathDir, { force: true, recursive: true });
  }
});

test("setup plugin registers VS Code without disturbing existing settings", async () => {
  const stateDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-plugin-vs-state-`);
  const homeDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-plugin-vs-home-`);
  const pathDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-plugin-vs-path-`);
  const settingsFile = resolveVsCodeSettingsFile({}, homeDir);
  try {
    await mkdir(path.dirname(settingsFile), { recursive: true });
    await writeFile(settingsFile, JSON.stringify({ "editor.fontSize": 13 }), "utf8");

    const first = runSetupPlugin(homeDir, stateDir, pathDir);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.match(first.stdout, /vscode,registered/);

    const settings = JSON.parse(await readFile(settingsFile, "utf8"));
    assert.equal(settings["editor.fontSize"], 13, "unrelated settings survive");
    const registered = Object.keys(settings["chat.pluginLocations"]);
    assert.equal(registered.length, 1);
    assert.ok(existsSync(`${registered[0]}/plugin.json`));

    // Re-running is a no-op rather than a duplicate registration.
    const second = runSetupPlugin(homeDir, stateDir, pathDir);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.match(second.stdout, /vscode,current/);
    assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")), settings);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
    await rm(homeDir, { force: true, recursive: true });
    await rm(pathDir, { force: true, recursive: true });
  }
});

test("setup plugin creates VS Code settings for a fresh installation", async () => {
  const stateDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-plugin-vs-fresh-state-`);
  const homeDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-plugin-vs-fresh-home-`);
  const pathDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-plugin-vs-fresh-path-`);
  const settingsFile = resolveVsCodeSettingsFile({}, homeDir);
  try {
    await mkdir(path.dirname(settingsFile), { recursive: true });

    const result = runSetupPlugin(homeDir, stateDir, pathDir);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /vscode,registered/);
    const settings = JSON.parse(await readFile(settingsFile, "utf8"));
    const registered = Object.keys(settings["chat.pluginLocations"]);
    assert.equal(registered.length, 1);
    assert.ok(existsSync(`${registered[0]}/plugin.json`));
  } finally {
    await rm(stateDir, { force: true, recursive: true });
    await rm(homeDir, { force: true, recursive: true });
    await rm(pathDir, { force: true, recursive: true });
  }
});

test("setup plugin leaves unparseable VS Code settings alone", async () => {
  const stateDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-plugin-jsonc-state-`);
  const homeDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-plugin-jsonc-home-`);
  const pathDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-plugin-jsonc-path-`);
  const settingsFile = resolveVsCodeSettingsFile({}, homeDir);
  const original = '{\n  // VS Code settings allow comments\n  "editor.fontSize": 13,\n}\n';
  try {
    await mkdir(path.dirname(settingsFile), { recursive: true });
    await writeFile(settingsFile, original, "utf8");

    const result = runSetupPlugin(homeDir, stateDir, pathDir);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /vscode,manual/);
    assert.equal(await readFile(settingsFile, "utf8"), original, "settings are not rewritten");
  } finally {
    await rm(stateDir, { force: true, recursive: true });
    await rm(homeDir, { force: true, recursive: true });
    await rm(pathDir, { force: true, recursive: true });
  }
});

test("setup plugin repairs Copilot registration without trusting list text", async () => {
  const stateDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-plugin-copilot-state-`);
  const homeDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-plugin-copilot-home-`);
  const pathDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-plugin-copilot-path-`);
  const installedSource = path.join(homeDir, "copilot-installed-source");
  const installLog = path.join(homeDir, "copilot-install-log");
  const copilotConfig = path.join(homeDir, ".copilot", "config.json");
  try {
    await mkdir(path.dirname(copilotConfig), { recursive: true });
    await writeFile(copilotConfig, '{"installedPlugins":[]}');
    await writeCopilotCommandStub(pathDir, { installedSource, installLog, copilotConfig });

    const first = runSetupPlugin(homeDir, stateDir, pathDir);

    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.match(first.stdout, /copilot,registered/);
    const pluginRoot = await realpath(fileURLToPath(new URL("..", import.meta.url)));
    assert.equal(await realpath(await readFile(installedSource, "utf8")), pluginRoot);

    const second = runSetupPlugin(homeDir, stateDir, pathDir);

    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.match(second.stdout, /copilot,current/);
    assert.equal(await realpath(await readFile(installedSource, "utf8")), pluginRoot);
    assert.equal(await readFile(installLog, "utf8"), "install\n");

    await writeFile(installedSource, "/stale/lavish-axi");
    await writeFile(
      copilotConfig,
      '{"installedPlugins":[{"name":"lavish-axi","source":{"source":"local","path":"/stale/lavish-axi"}}]}',
    );
    const repaired = runSetupPlugin(homeDir, stateDir, pathDir);

    assert.equal(repaired.status, 0, repaired.stderr || repaired.stdout);
    assert.match(repaired.stdout, /copilot,registered/);
    assert.equal(await realpath(await readFile(installedSource, "utf8")), pluginRoot);
    assert.equal(await readFile(installLog, "utf8"), "install\ninstall\n");
  } finally {
    await rm(stateDir, { force: true, recursive: true });
    await rm(homeDir, { force: true, recursive: true });
    await rm(pathDir, { force: true, recursive: true });
  }
});

test("setup plugin preserves Copilot registration when replacement fails", async () => {
  const stateDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-plugin-copilot-failure-state-`);
  const homeDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-plugin-copilot-failure-home-`);
  const pathDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-plugin-copilot-failure-path-`);
  const installedSource = path.join(homeDir, "copilot-installed-source");
  const originalSource = "/working/lavish-axi";
  try {
    await writeFile(installedSource, originalSource);
    await writeCopilotCommandStub(pathDir, { installedSource, listSourcePath: true, installFails: true });

    const result = runSetupPlugin(homeDir, stateDir, pathDir);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /copilot,failed/);
    assert.equal(await readFile(installedSource, "utf8"), originalSource);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
    await rm(homeDir, { force: true, recursive: true });
    await rm(pathDir, { force: true, recursive: true });
  }
});

test("setup plugin does not install when Copilot records are invalid", async () => {
  const stateDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-plugin-copilot-invalid-state-`);
  const homeDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-plugin-copilot-invalid-home-`);
  const pathDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-plugin-copilot-invalid-path-`);
  const installLog = path.join(homeDir, "copilot-install-log");
  try {
    await writeCopilotCommandStub(pathDir, { invalidList: true, installLog });

    const result = runSetupPlugin(homeDir, stateDir, pathDir);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /copilot,manual/);
    assert.equal(existsSync(installLog), false);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
    await rm(homeDir, { force: true, recursive: true });
    await rm(pathDir, { force: true, recursive: true });
  }
});

test("setup plugin isolates a client it cannot register from the ones it can", async () => {
  const stateDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-plugin-iso-state-`);
  const homeDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-plugin-iso-home-`);
  const pathDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-plugin-iso-path-`);
  const settingsFile = resolveVsCodeSettingsFile({}, homeDir);
  try {
    // A real directory in Cursor's slot is unregisterable - the same reported (not thrown)
    // path a Windows box without Developer Mode takes when link creation is refused.
    const occupied = `${homeDir}/.cursor/plugins/local/lavish-axi`;
    await mkdir(occupied, { recursive: true });
    await writeFile(`${occupied}/keep.txt`, "user content", "utf8");
    await mkdir(path.dirname(settingsFile), { recursive: true });
    await writeFile(settingsFile, JSON.stringify({ "editor.fontSize": 13 }), "utf8");

    const result = runSetupPlugin(homeDir, stateDir, pathDir);

    assert.equal(result.status, 0, "an unregisterable client never fails the command");
    assert.match(result.stdout, /cursor,manual/);
    assert.match(result.stdout, /vscode,registered/, "the other client is still registered");

    const settings = JSON.parse(await readFile(settingsFile, "utf8"));
    assert.equal(Object.keys(settings["chat.pluginLocations"]).length, 1);
    assert.equal(await readFile(`${occupied}/keep.txt`, "utf8"), "user content", "user content survives");
  } finally {
    await rm(stateDir, { force: true, recursive: true });
    await rm(homeDir, { force: true, recursive: true });
    await rm(pathDir, { force: true, recursive: true });
  }
});

test("setup rejects an unknown action and names both supported ones", async () => {
  const stateDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-setup-unknown-state-`);
  const homeDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-setup-unknown-home-`);
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)), "setup", "everything"],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        env: setupHooksEnv(homeDir, stateDir),
      },
    );

    assert.notEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /setup hooks/);
    assert.match(output, /setup plugin/);
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

test("shouldRestartServer restarts a same-version server after a Tailscale transition", () => {
  const health = { ok: true, app: "lavish-axi", version: "0.1.4", network_stale: true };
  assert.equal(shouldRestartServer("0.1.4", health), true);
  assert.equal(serverReplacementReason("0.1.4", health), "");
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

// Every other open review page is told why its server went away, so the reason has to name the
// branch that actually fired: a local-build force replaces a server of the same version, and
// calling that an update is false on both counts.
test("serverReplacementReason names a local-build force apart from a real version change", () => {
  assert.equal(serverReplacementReason("0.1.4", { ok: true, app: "lavish-axi", version: "0.1.3" }), "upgrade");
  assert.equal(serverReplacementReason("0.1.4", { ok: true, app: "lavish-axi" }), "upgrade");
  assert.equal(
    serverReplacementReason("0.1.4", { ok: true, app: "lavish-axi", version: "0.1.4" }, true),
    "local-build",
  );
  // A version difference is an upgrade even when the local-build force is also set.
  assert.equal(serverReplacementReason("0.1.4", { ok: true, app: "lavish-axi", version: "0.1.3" }, true), "upgrade");
});

test("serverReplacementReason names nothing when no replacement is warranted", () => {
  assert.equal(serverReplacementReason("0.1.4", { ok: true, app: "lavish-axi", version: "0.1.4" }), "");
  assert.equal(serverReplacementReason("0.1.4", null), "");
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
  assert.ok(getCommandHelp("design").includes(DESIGN_PRIORITY_RULE), "design help embeds the single-sourced rule");
  assert.match(getCommandHelp("design"), /fallback, not the default/i);
  assert.match(getCommandHelp("design"), /inspect the subject project/i);
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
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
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

// A stand-in for a running server of another version: it answers /health, records what the CLI
// actually puts on the wire at /shutdown, and then frees the port like a real one.
async function startShutdownRecorder(version = "0.0.0-previous") {
  const bodies = [];
  const server = createServer((req, res) => {
    if (new URL(req.url || "/", "http://localhost").pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, app: "lavish-axi", version }));
      return;
    }
    if (req.url === "/shutdown" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        bodies.push(raw ? JSON.parse(raw) : {});
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "shutting-down" }));
        server.close();
        server.closeAllConnections?.();
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return { bodies, port: address.port, close: () => server.close() };
}

test("lavish-axi stop tells the server it was stopped, and names no session to reload", async () => {
  const recorder = await startShutdownRecorder();
  try {
    const output = await shutdownServerOnPort(recorder.port, {
      baseUrl: `http://127.0.0.1:${recorder.port}`,
      currentVersion: "0.1.4",
    });

    assert.deepEqual(recorder.bodies, [{ reason: "stop" }]);
    assert.equal(output.server.status, "stopped");
  } finally {
    recorder.close();
  }
});

// The page being opened is the one that reloads itself, and the server picks it by key, so the
// key the CLI sends has to be the canonical session key for the file - an empty or non-canonical
// one silently degrades the feature to "nobody reloads, everybody gets a banner".
test("opening an artifact names that session as the one to reload across a version upgrade", async () => {
  const recorder = await startShutdownRecorder();
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-open-reload-"));
  const stateDir = path.join(dir, "state");
  const nested = path.join(dir, "pages");
  await mkdir(nested, { recursive: true });
  const artifact = path.join(nested, "board.html");
  await writeFile(artifact, "<!doctype html><html><body>board</body></html>");
  const base = `http://127.0.0.1:${recorder.port}`;

  try {
    // Spawned asynchronously on purpose: the recorder runs in this process, so a blocking
    // spawnSync would deadlock the CLI's own /health request against it.
    const child = spawn(
      process.execPath,
      // A path with a `..` hop: the key must come from the canonicalized file, not this spelling.
      [
        fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)),
        path.join(nested, "..", "pages", "board.html"),
        "--no-open",
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          ...process.env,
          LAVISH_AXI_PORT: String(recorder.port),
          LAVISH_AXI_STATE_DIR: stateDir,
          LAVISH_AXI_TELEMETRY: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.resume();
    const code = await new Promise((resolve) => child.on("exit", resolve));

    assert.equal(code, 0, stderr);
    assert.deepEqual(recorder.bodies, [{ reload_key: sessionKey(await canonicalFile(artifact)), reason: "upgrade" }]);
  } finally {
    // The CLI replaced the recorder with a real server on that port; stop it again.
    await fetch(`${base}/shutdown`, { method: "POST" }).catch(() => {});
    for (let i = 0; i < 30; i += 1) {
      const alive = await fetch(`${base}/health`).then(
        () => true,
        () => false,
      );
      if (!alive) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    recorder.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveShareRequest publishes a public page by default", () => {
  const request = resolveShareRequest(["report.html"]);

  assert.equal(request.mode, "create");
  assert.equal(request.file, "report.html");
  assert.equal(request.password, undefined);
  assert.equal(request.generatedPassword, false);
});

test("resolveShareRequest --private mints a password instead of asking the agent for one", () => {
  const request = resolveShareRequest(["report.html", "--private"]);

  assert.equal(request.mode, "create");
  assert.equal(request.generatedPassword, true);
  assert.match(String(request.password), /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
});

test("resolveShareRequest keeps an explicit password verbatim and refuses to also generate one", () => {
  assert.equal(resolveShareRequest(["report.html", "--password", "hunter2"]).password, "hunter2");
  assert.throws(() => resolveShareRequest(["report.html", "--password", "hunter2", "--private"]), /--private/);
});

test("resolveShareRequest reads the file path even when a password flag precedes it", () => {
  assert.equal(resolveShareRequest(["--password", "hunter2", "report.html"]).file, "report.html");
  assert.equal(resolveShareRequest(["--private", "report.html"]).file, "report.html");
});

test("resolveShareRequest requires both halves of the republish credential", () => {
  const request = resolveShareRequest(["report.html", "--site", "abc123", "--update-key", "uk_secret"]);

  assert.equal(request.mode, "update");
  assert.equal(request.siteId, "abc123");
  assert.equal(request.updateKey, "uk_secret");
  assert.equal(request.password, undefined, "an omitted password preserves the page's current one");
  assert.throws(() => resolveShareRequest(["report.html", "--site", "abc123"]), /--update-key/);
  assert.throws(() => resolveShareRequest(["report.html", "--update-key", "uk_secret"]), /--site/);
  assert.throws(() => resolveShareRequest(["--site", "abc123", "--update-key", "uk_secret"]), /HTML file/);
});

test("resolveShareRequest never asks the host to clear a password it silently ignores", () => {
  // The live host answers 200 to an empty password and leaves the page gated, so no argument
  // shape may produce one - a "" here would report a still-private page as public.
  for (const args of [
    ["report.html"],
    ["report.html", "--site", "abc123", "--update-key", "uk_secret"],
    ["report.html", "--private"],
    ["report.html", "--password", "hunter2"],
  ]) {
    assert.notEqual(resolveShareRequest(args).password, "", `${args.join(" ")} must not clear the password`);
  }
});

test("resolveShareRequest treats unpublish as a credentialed republish with no file", () => {
  const request = resolveShareRequest(["--unpublish", "--site", "abc123", "--update-key", "uk_secret"]);

  assert.equal(request.mode, "unpublish");
  assert.equal(request.siteId, "abc123");
  assert.equal(request.file, null);
  assert.throws(() => resolveShareRequest(["--unpublish", "--site", "abc123"]), /--update-key/);
  assert.throws(
    () => resolveShareRequest(["report.html", "--unpublish", "--site", "abc123", "--update-key", "uk"]),
    /--unpublish/,
  );
});

test("resolveShareRequest refuses a value flag that swallowed the next flag", () => {
  // An empty unquoted $PW in `share r.html --password $PW --site abc --update-key k` used to make
  // "--site" the password and silently ROTATE a live page to a literal nobody could recover.
  assert.throws(
    () => resolveShareRequest(["r.html", "--password", "--site", "abc", "--update-key", "k"]),
    /--password was given no value.*--site/s,
  );
  assert.throws(() => resolveShareRequest(["r.html", "--site", "--update-key", "k"]), /--site was given no value/);
  assert.throws(
    () => resolveShareRequest(["r.html", "--site", "abc", "--update-key", "--private"]),
    /--update-key was given no value/,
  );
  assert.throws(() => resolveShareRequest(["r.html", "--token", "--private"]), /--token was given no value/);
});

test("resolveShareRequest refuses an explicitly empty value flag", () => {
  for (const args of [
    ["r.html", "--password", ""],
    ["r.html", "--password="],
    ["r.html", "--password"],
    ["r.html", "--password", "   "],
  ]) {
    assert.throws(() => resolveShareRequest(args), /--password was given an empty value/, args.join(" "));
  }
  assert.throws(() => resolveShareRequest(["r.html", "--site=", "--update-key", "k"]), /--site was given an empty/);
});

test("resolveShareRequest still accepts a value that legitimately starts with dashes via the = form", () => {
  // The = form cannot swallow a following token, so it stays the escape hatch for such a value.
  assert.equal(resolveShareRequest(["r.html", "--password=--dashes--"]).password, "--dashes--");
});

test("resolveShareRequest rejects a bearer token on a republish or unpublish", () => {
  assert.equal(resolveShareRequest(["report.html", "--token", "tok_123"]).token, "tok_123");
  assert.throws(
    () => resolveShareRequest(["report.html", "--site", "abc123", "--update-key", "uk_secret", "--token", "tok_123"]),
    /--token only applies when creating a page/,
  );
  assert.throws(
    () => resolveShareRequest(["--unpublish", "--site", "abc123", "--update-key", "uk_secret", "--token", "tok_123"]),
    /--token only applies when creating a page/,
  );
});

test("createShareOutput hands back a generated password and tells the agent it is a shared secret", () => {
  const output = createShareOutput({
    source: "/tmp/report.html",
    site: { url: "https://x.ht-ml.app/", site_id: "x", update_key: "uk_secret", status: "active" },
    warnings: [],
    passwordProtected: true,
    password: "xk4t-9rmb-2wqz",
  });

  assert.equal(output.share.password, "xk4t-9rmb-2wqz");
  assert.equal(output.share.visibility, "private");
  assert.match(output.next_step, /xk4t-9rmb-2wqz/);
  assert.match(output.next_step, /shared secret/i);
});

test("createShareOutput never echoes a password the caller chose", () => {
  const output = createShareOutput({
    source: "/tmp/report.html",
    site: { url: "https://x.ht-ml.app/", site_id: "x", update_key: "uk_secret", status: "active" },
    warnings: [],
    passwordProtected: true,
  });

  assert.equal(output.share.password, undefined);
});

test("createShareUpdateOutput reports what a plain republish did, not a password state it cannot know", () => {
  // Lavish persists no site state, so a republish of a page created without a password would be
  // misreported by any claim that "the password was left unchanged".
  const output = createShareUpdateOutput({
    source: "/tmp/report.html",
    site: { url: "https://x.ht-ml.app/", site_id: "x", status: "active" },
    warnings: [],
  });

  assert.equal(output.share.url, "https://x.ht-ml.app/");
  assert.equal(output.share.visibility, "unchanged");
  assert.equal(output.share.password, undefined);
  assert.match(output.next_step, /same URL/i);
  assert.match(output.next_step, /did not touch the page's password/i);
  assert.match(output.next_step, /cannot tell you whether that is a password or none/i);
  assert.doesNotMatch(output.next_step, /password was left unchanged/i);
  assert.doesNotMatch(output.next_step, /it is password-protected/i);
});

test("createShareUpdateOutput surfaces a rotated password and never claims a page went public", () => {
  const rotated = createShareUpdateOutput({
    source: "/tmp/report.html",
    site: { url: "https://x.ht-ml.app/", site_id: "x", status: "active" },
    warnings: [],
    password: "xk4t-9rmb-2wqz",
    passwordProtected: true,
  });
  assert.equal(rotated.share.password, "xk4t-9rmb-2wqz");
  assert.equal(rotated.share.visibility, "private");

  const untouched = createShareUpdateOutput({
    source: "/tmp/report.html",
    site: { url: "https://x.ht-ml.app/", site_id: "x", status: "active" },
    warnings: [],
  });
  assert.equal(untouched.share.visibility, "unchanged");
  assert.doesNotMatch(untouched.next_step, /CLEARED|now public|is PUBLIC/i);
});

test("createShareUpdateOutput does not present a newly set password as an instant gate", () => {
  // Probed live: locking a page that was public left it answering uncredentialed CDN requests for
  // minutes, and Lavish persists no site state, so it cannot know the page was not public.
  const locked = createShareUpdateOutput({
    source: "/tmp/report.html",
    site: { url: "https://x.ht-ml.app/", site_id: "x", status: "active" },
    warnings: [],
    password: "xk4t-9rmb-2wqz",
    passwordProtected: true,
  });

  assert.match(locked.next_step, /NOT instant/i);
  assert.match(locked.next_step, /cach/i);
  assert.match(locked.next_step, /already private/i);

  // A plain republish sets no password, so it must not raise the caveat at all.
  const untouched = createShareUpdateOutput({
    source: "/tmp/report.html",
    site: { url: "https://x.ht-ml.app/", site_id: "x", status: "active" },
    warnings: [],
  });
  assert.doesNotMatch(untouched.next_step, /NOT instant/i);
});

test("createShareUpdateOutput says the host reported no URL rather than naming one", () => {
  const output = createShareUpdateOutput({
    source: "/tmp/report.html",
    site: { url: "", site_id: "abc123", status: "active" },
    warnings: [],
  });

  assert.equal(output.share.url, "");
  assert.match(output.next_step, /did not report a URL/i);
  assert.match(output.next_step, /abc123/);
  assert.doesNotMatch(JSON.stringify(output), /ht-ml\.app/);
});

test("createShareUnpublishOutput says the host reported no URL rather than naming one", () => {
  const output = createShareUnpublishOutput({ site: { url: "", site_id: "abc123", status: "active" } });

  assert.equal(output.share.url, "");
  assert.match(output.next_step, /did not report a URL/i);
  assert.doesNotMatch(output.next_step, /Replaced the page at /);
});

test("createShareUnpublishOutput says the page still exists and how to bring it back", () => {
  const output = createShareUnpublishOutput({
    site: { url: "https://x.ht-ml.app/", site_id: "x", status: "active" },
  });

  assert.equal(output.share.site_id, "x");
  assert.equal(output.share.unpublished, true);
  assert.match(output.next_step, /not deleted|no delete/i);
  assert.match(output.next_step, /update_key/);
  // The recovery instruction has to be one the host actually honors: clearing is ignored.
  assert.doesNotMatch(output.next_step, /--clear-password/);
  assert.match(output.next_step, /--private/);
  assert.equal(parseSuggestedShareCommand(output.next_step).mode, "update");
  assert.doesNotMatch(JSON.stringify(output), /[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/);
});

test("createShareUnpublishOutput separates the immediate content swap from the lagging lock", () => {
  // Probed live: the PUT invalidated the CDN copy and the edge then served the NEW placeholder to
  // uncredentialed requests for minutes. So the old content is gone at once and what lingers is an
  // unlocked placeholder. Saying "no visitor can read the old content" while also saying the CDN
  // kept answering was self-contradictory, and the report may not imply the old page stays up.
  const output = createShareUnpublishOutput({
    site: { url: "https://x.ht-ml.app/", site_id: "x", status: "active" },
  });

  assert.match(output.next_step, /previous content is gone/i, "the swap must read as immediate");
  assert.match(output.next_step, /cach/i, "the lagging lock must still be disclosed");
  assert.match(output.next_step, /readable without the password/i);
  assert.doesNotMatch(output.next_step, /no visitor can read the old content/i);
});
