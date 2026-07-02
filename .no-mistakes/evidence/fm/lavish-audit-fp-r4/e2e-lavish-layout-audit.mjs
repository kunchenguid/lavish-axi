import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sessionKey } from "../../../../src/session-store.js";

const evidenceDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(evidenceDir, "../../../..");
const tempRoot = path.join(repoRoot, ".no-mistakes/tmp/lavish-audit-fp-r4");
const stateDir = path.join(tempRoot, "state");
const chromeProfile = path.join(tempRoot, "chrome-profile");
const nodeBin = process.execPath;
const cli = path.join(repoRoot, "bin/lavish-axi.js");
const chrome = "chrome-devtools-axi";

function run(command, args, { env = {}, input, timeout = 30_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    input,
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function writeEvidence(name, content) {
  const file = path.join(evidenceDir, name);
  writeFileSync(file, content);
  return file;
}

function assertContains(text, pattern, message) {
  if (!pattern.test(text)) throw new Error(`${message}\nPattern: ${pattern}\nText:\n${text}`);
}

function assertNotContains(text, pattern, message) {
  if (pattern.test(text)) throw new Error(`${message}\nPattern: ${pattern}\nText:\n${text}`);
}

function countWarningRows(pollOutput) {
  return pollOutput.split("\n").filter((line) => /^\s*[^,\s]+,clipped-text,/.test(line)).length;
}

function chromeEnv() {
  return {
    CHROME_DEVTOOLS_AXI_SESSION: "lavish-audit-fp-r4",
    CHROME_DEVTOOLS_AXI_USER_DATA_DIR: chromeProfile,
  };
}

function lavishEnv(port) {
  return {
    LAVISH_AXI_PORT: String(port),
    LAVISH_AXI_STATE_DIR: stateDir,
    LAVISH_AXI_NO_OPEN: "1",
    LAVISH_AXI_TELEMETRY: "0",
  };
}

function sessionUrl(file, port) {
  return `http://127.0.0.1:${port}/session/${sessionKey(file)}?no-gate=1`;
}

async function main() {
  rmSync(tempRoot, { recursive: true, force: true });
  await mkdir(evidenceDir, { recursive: true });
  await mkdir(tempRoot, { recursive: true });

  const wrappedHtml = path.join(evidenceDir, "wrapped-inline-no-warnings.html");
  const spillHtml = path.join(evidenceDir, "visible-spill-one-warning.html");
  await writeFile(
    wrappedHtml,
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Wrapped inline audit repro</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #f6f1e8;
      color: #1c2430;
      font: 17px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(460px, calc(100vw - 48px));
      padding: 28px;
      border: 1px solid #d8c8ad;
      background: #fffaf0;
      box-shadow: 0 18px 60px rgb(62 45 17 / 12%);
    }
    h1 { margin: 0 0 14px; font-size: 26px; line-height: 1.1; }
    p { margin: 0; }
    strong, code {
      color: #673c12;
      background: #f1dfbd;
      border-radius: 4px;
      padding: 1px 4px;
    }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .94em; }
  </style>
</head>
<body>
  <main>
    <h1>Healthy Wrapped Inline Text</h1>
    <p>
      This paragraph intentionally contains a
      <strong>long bold phrase that wraps naturally across a line</strong>
      beside a <code>short-code-token</code>.
      The wrapped inline fragments are healthy text flow and should not report overlapping-text.
    </p>
  </main>
</body>
</html>
`,
  );
  await writeFile(
    spillHtml,
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Visible spill audit repro</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #edf4f8;
      color: #10202b;
      font: 16px/1.4 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(520px, calc(100vw - 48px));
      padding: 28px;
      border: 1px solid #b7cad6;
      background: #ffffff;
      box-shadow: 0 18px 60px rgb(16 32 43 / 12%);
    }
    h1 { margin: 0 0 14px; font-size: 26px; line-height: 1.1; }
    .status-row {
      display: flex;
      align-items: flex-start;
      gap: 16px;
      padding: 14px;
      border: 1px solid #d0dfe7;
      background: #f8fbfd;
    }
    #spilling-badge {
      display: inline-block;
      width: 58px;
      height: 24px;
      padding: 2px 8px;
      border-radius: 999px;
      background: #0f766e;
      color: white;
      font-size: 13px;
      font-weight: 700;
      line-height: 18px;
      text-align: center;
      white-space: normal;
      overflow: visible;
    }
    .status-copy { max-width: 330px; }
  </style>
</head>
<body>
  <main>
    <h1>Visible Badge Spill</h1>
    <section class="status-row" aria-label="build status">
      <span id="spilling-badge">Needs review</span>
      <p class="status-copy">
        The badge has a fixed DaisyUI-style pill height and default visible overflow.
        The audit should report the badge itself once, not every ancestor.
      </p>
    </section>
  </main>
</body>
</html>
`,
  );

  const port = await getFreePort();
  const env = lavishEnv(port);
  const wrappedFile = await realpath(wrappedHtml);
  const spillFile = await realpath(spillHtml);
  const summary = {
    port,
    wrappedHtml,
    spillHtml,
    checks: [],
    artifacts: [],
  };

  try {
    run(nodeBin, [cli, "open", wrappedFile, "--no-open", "--no-gate"], { env });
    run(chrome, ["resize", "1280", "900"], { env: chromeEnv(), timeout: 45_000 });
    run(chrome, ["open", sessionUrl(wrappedFile, port)], { env: chromeEnv(), timeout: 45_000 });
    run(chrome, ["wait", "2800"], { env: chromeEnv(), timeout: 45_000 });
    run(chrome, ["screenshot", path.join(evidenceDir, "wrapped-inline-no-warnings.png")], {
      env: chromeEnv(),
      timeout: 45_000,
    });
    summary.artifacts.push("wrapped-inline-no-warnings.png");

    const wrappedPoll = run(nodeBin, [cli, "poll", wrappedFile, "--timeout-ms", "1200"], { env }).stdout;
    writeEvidence("wrapped-inline-poll.txt", wrappedPoll);
    assertContains(wrappedPoll, /status:\s*waiting/, "Healthy wrapped inline artifact should not deliver feedback");
    assertNotContains(wrappedPoll, /layout_warnings/, "Healthy wrapped inline artifact reported layout warnings");
    summary.checks.push("wrapped inline page loaded in Chrome and CLI poll returned waiting with no layout_warnings");
    summary.artifacts.push("wrapped-inline-poll.txt");

    run(nodeBin, [cli, "open", spillFile, "--no-open", "--no-gate"], { env });
    run(chrome, ["open", sessionUrl(spillFile, port)], { env: chromeEnv(), timeout: 45_000 });
    run(chrome, ["wait", "2800"], { env: chromeEnv(), timeout: 45_000 });
    run(chrome, ["screenshot", path.join(evidenceDir, "visible-spill-one-warning.png")], {
      env: chromeEnv(),
      timeout: 45_000,
    });
    summary.artifacts.push("visible-spill-one-warning.png");

    const firstSpillPoll = run(nodeBin, [cli, "poll", spillFile, "--timeout-ms", "2500"], { env }).stdout;
    writeEvidence("visible-spill-first-poll.txt", firstSpillPoll);
    assertContains(firstSpillPoll, /layout_warnings\[1\]/, "Visible spill should produce exactly one warning");
    assertContains(firstSpillPoll, /span#spilling-badge,clipped-text,/, "Visible spill warning should target the badge");
    assertContains(firstSpillPoll, /error,false/, "First visible spill warning should be fresh and error severity");
    assertContains(firstSpillPoll, /fix horizontal overflow/, "Fresh error-severity warning should require a fix pass");
    if (countWarningRows(firstSpillPoll) !== 1) {
      throw new Error(`Visible spill first poll had ${countWarningRows(firstSpillPoll)} clipped-text rows`);
    }
    summary.checks.push("fixed-height visible-overflow badge produced one fresh clipped-text warning on the badge");
    summary.artifacts.push("visible-spill-first-poll.txt");

    run(chrome, ["eval", "location.reload()"], { env: chromeEnv(), timeout: 45_000 });
    run(chrome, ["wait", "2800"], { env: chromeEnv(), timeout: 45_000 });
    const repeatSpillPoll = run(nodeBin, [cli, "poll", spillFile, "--timeout-ms", "2500"], { env }).stdout;
    writeEvidence("visible-spill-repeat-poll.txt", repeatSpillPoll);
    assertContains(repeatSpillPoll, /layout_warnings\[1\]/, "Repeat visible spill should still produce one warning");
    assertContains(repeatSpillPoll, /span#spilling-badge,clipped-text,/, "Repeat visible spill warning should target the badge");
    assertContains(repeatSpillPoll, /error,true/, "Repeat visible spill warning should be marked persistent");
    assertContains(
      repeatSpillPoll,
      /already reported in a prior poll|no fresh error-severity findings|fine to proceed to the human/,
      "Persistent warning guidance should permit proceeding instead of forcing another loop",
    );
    if (countWarningRows(repeatSpillPoll) !== 1) {
      throw new Error(`Visible spill repeat poll had ${countWarningRows(repeatSpillPoll)} clipped-text rows`);
    }
    summary.checks.push("the same badge warning became persistent on repeat poll and next_step stopped mandating a loop");
    summary.artifacts.push("visible-spill-repeat-poll.txt");

    await writeFile(path.join(evidenceDir, "e2e-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    run(nodeBin, [cli, "stop", "--port", String(port)], { env, timeout: 15_000 });
    run(chrome, ["stop"], { env: chromeEnv(), timeout: 45_000 });
    rmSync(tempRoot, { recursive: true, force: true });
  }

  const summaryText = await readFile(path.join(evidenceDir, "e2e-summary.json"), "utf8");
  process.stdout.write(summaryText);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
