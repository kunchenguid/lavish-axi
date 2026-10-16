import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { parse } from "parse5";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const playbooksPath = process.env.LAVISH_AXI_PLAYBOOKS_MODULE || path.join(repoRoot, "src/playbooks.js");
const { PLAYBOOKS } = await import(pathToFileURL(playbooksPath).href);
let chromeLaunchState;

async function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return "";
}

async function headlessChromeState(chrome) {
  if (chromeLaunchState) return chromeLaunchState;
  const root = await mkdtemp(path.join(os.tmpdir(), "lavish-copy-all-probe-"));
  try {
    const result = spawnSync(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        `--user-data-dir=${path.join(root, "chrome-profile")}`,
        "--dump-dom",
        "about:blank",
      ],
      { stdio: "ignore", timeout: 15_000 },
    );
    chromeLaunchState =
      result.status === 0
        ? { available: true }
        : {
            available: false,
            reason: `Chrome or Chromium could not launch headless (${result.signal || `exit ${result.status}`})`,
          };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return chromeLaunchState;
}

function copyAllHtmlSnippet() {
  const inputPlaybook = PLAYBOOKS.find(({ id }) => id === "input");
  assert.ok(inputPlaybook, "the exported playbooks include the input playbook");
  const htmlBlocks = inputPlaybook.lavish_notes.flatMap((note) =>
    [...note.matchAll(/```html\r?\n([\s\S]*?)\r?\n```/g)].map((match) => match[1]),
  );
  assert.equal(htmlBlocks.length, 1, "the input playbook emits one standalone HTML snippet");
  return htmlBlocks[0];
}

function fixtureQuestions() {
  return `<form data-lavish-question="plan">
      <label><input type="radio" name="plan" value="Starter" checked> Starter</label>
      <label><input type="radio" name="plan" value="Pro"> Pro</label>
      <label><input type="checkbox" name="billing" value="Annual" checked> Annual</label>
      <label><input type="checkbox" name="billing" value="Monthly"> Monthly</label>
      <input type="text" name="blank" value="   ">
      <button type="submit">Submit</button>
    </form>
    <form data-lavish-question="delivery">
      <label for="goal">Goal</label><input id="goal" type="text" name="goal" value="Ship the review">
      <label for="context">Context</label><textarea id="context" name="context">Keep the scope opt-in</textarea>
    </form>`;
}

function probeScript(scenario, { clicks = 1 } = {}) {
  const setup = {
    clipboard:
      "window.__copied = ''; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { window.__copied = value; } } });",
    execCommand:
      "window.__execCommandText = ''; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('permission denied'); } } }); document.execCommand = (command) => { if (command !== 'copy') return false; const temporary = [...document.querySelectorAll('textarea')].find((area) => area.readOnly && !area.dataset.lavishCopyAllManual); window.__execCommandText = temporary?.value || ''; return Boolean(temporary); };",
    manual:
      "Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); document.execCommand = undefined;",
    delayedManual:
      "Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise((_, reject) => setTimeout(() => reject(new Error('permission denied')), 5)) } }); document.execCommand = undefined;",
    staleFailure:
      "window.__copied = ''; let writes = 0; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (value) => ++writes === 1 ? new Promise((_, reject) => setTimeout(() => reject(new Error('permission denied')), 15)) : Promise.resolve(window.__copied = value) } }); document.execCommand = undefined;",
    empty:
      "window.__clipboardCalls = 0; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { window.__clipboardCalls += 1; } } });",
  }[scenario];

  const clickOnce = `document.querySelector('button[type="button"]').click(); await new Promise((resolve) => setTimeout(resolve, 0));`;
  const clickLines =
    scenario === "staleFailure"
      ? `document.querySelector('button[type="button"]').click(); document.querySelector('input[name="answer"]').value = 'New answer'; document.querySelector('button[type="button"]').click(); await new Promise((resolve) => setTimeout(resolve, 30));`
      : scenario === "delayedManual"
        ? `for (let i = 0; i < ${clicks}; i++) document.querySelector('button[type="button"]').click(); await new Promise((resolve) => setTimeout(resolve, 20));`
        : Array.from({ length: clicks }, () => clickOnce).join("\n        ");

  return `<script>
    (async () => {
      try {
        ${setup}
        ${clickLines}
        const manual = [...document.querySelectorAll('textarea')]
          .filter((area) => area.readOnly)
          .map((area) => ({
            value: area.value,
            selected: area.selectionStart === 0 && area.selectionEnd === area.value.length,
            visible: area.getBoundingClientRect().width > 0 && area.getBoundingClientRect().height > 0,
          }));
        document.body.dataset.result = JSON.stringify({
          status: document.querySelector('[role="status"]').textContent,
          noLavish: typeof window.lavish === 'undefined',
          copied: window.__copied,
          execCommandText: window.__execCommandText,
          clipboardCalls: window.__clipboardCalls,
          manual,
          textareaCount: document.querySelectorAll('textarea').length,
          manualTextareaCount: document.querySelectorAll('[data-lavish-copy-all-manual]').length,
        });
      } catch (error) {
        document.body.dataset.result = JSON.stringify({ error: String(error) });
      }
    })();
  </script>`;
}

function dumpChromeDom(chrome, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(chrome, args, { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    const stop = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      if (error) reject(error);
      else resolve(stdout);
    };
    const timer = setTimeout(() => finish(new Error("Chrome did not dump the fixture DOM in time")), timeoutMs);
    child.on("error", finish);
    child.on("exit", (code) => {
      if (!settled) finish(new Error(`Chrome exited before dumping the fixture DOM (${code})`));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 2 * 1024 * 1024) {
        finish(new Error("Chrome fixture DOM exceeded 2 MB"));
      } else if (stdout.includes("</html>")) {
        finish();
      }
    });
  });
}

function resultFromDump(html) {
  const document = parse(html);
  const stack = /** @type {import("parse5").DefaultTreeAdapterMap["node"][]} */ ([document]);
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.nodeName === "body") {
      const element = /** @type {import("parse5").DefaultTreeAdapterMap["element"]} */ (node);
      const result = element.attrs.find((attribute) => attribute.name === "data-result");
      if (result) return JSON.parse(result.value);
    }
    if ("childNodes" in node) stack.push(...node.childNodes);
  }
  return null;
}

async function runBrowserScenario(t, scenario, fixture, options = {}) {
  if (process.platform === "win32") {
    t.skip("the headless dump harness relies on POSIX process-group cleanup");
    return null;
  }
  const snippet = copyAllHtmlSnippet();
  const chrome = await chromePath();
  if (!chrome) {
    t.skip("Chrome or Chromium is required for the standalone copy behavior regression");
    return null;
  }
  const launchState = await headlessChromeState(chrome);
  if (!launchState.available) {
    t.skip(launchState.reason);
    return null;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "lavish-copy-all-"));
  const fixtureHtml = typeof fixture === "string" ? fixture : fixture ? fixtureQuestions() : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Standalone answers</title></head><body>${fixtureHtml}${snippet}${probeScript(scenario, options)}</body></html>`;
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(html);
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(undefined));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind to a TCP port");
    const stdout = await dumpChromeDom(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        `--user-data-dir=${path.join(root, "chrome-profile")}`,
        "--run-all-compositor-stages-before-draw",
        "--virtual-time-budget=5000",
        "--dump-dom",
        `http://127.0.0.1:${address.port}/`,
      ],
      30_000,
    );
    const result = resultFromDump(stdout);
    assert.ok(result, "browser fixture did not report a result");
    assert.equal(result.error, undefined, result.error);
    return result;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

const expected =
  "plan:\n  plan: Starter\n  billing: Annual\n\n" +
  "delivery:\n  goal: Ship the review\n  context: Keep the scope opt-in";

test("clipboard API copies checked and filled answers from two forms without Lavish", async (t) => {
  const result = await runBrowserScenario(t, "clipboard", true);
  if (!result) return;
  assert.equal(result.noLavish, true);
  assert.equal(result.status, "Answers copied.");
  assert.equal(result.copied, expected);
});

test("a rejected clipboard API falls back to document.execCommand", async (t) => {
  const result = await runBrowserScenario(t, "execCommand", true);
  if (!result) return;
  assert.equal(result.noLavish, true);
  assert.equal(result.status, "Answers copied.");
  assert.equal(result.execCommandText, expected);
  assert.equal(result.textareaCount, 1, "the temporary copy textarea is removed after use");
});

test("unavailable clipboard paths show a visible selected read-only textarea", async (t) => {
  const result = await runBrowserScenario(t, "manual", true);
  if (!result) return;
  assert.equal(result.noLavish, true);
  assert.match(result.status, /copy.*manually/i);
  assert.equal(result.manual.length, 1);
  assert.equal(result.manual[0].value, expected);
  assert.equal(result.manual[0].selected, true);
  assert.equal(result.manual[0].visible, true);
});

test("a page without questions reports a harmless empty state", async (t) => {
  const result = await runBrowserScenario(t, "empty", false);
  if (!result) return;
  assert.equal(result.noLavish, true);
  assert.equal(result.status, "No questions or answers to copy.");
  assert.equal(result.clipboardCalls, 0);
  assert.equal(result.manual.length, 0);
});

test("repeated clicks with the fallback forced leave exactly one manual textarea", async (t) => {
  const result = await runBrowserScenario(t, "manual", true, { clicks: 2 });
  if (!result) return;
  assert.equal(result.noLavish, true);
  assert.equal(result.manualTextareaCount, 1, "the prior manual textarea is removed before a new one is added");
  assert.equal(result.manual.length, 1);
  assert.equal(result.manual[0].value, expected);
});

test("overlapping rejected clipboard writes leave one manual textarea", async (t) => {
  const result = await runBrowserScenario(t, "delayedManual", true, { clicks: 2 });
  if (!result) return;
  assert.equal(result.manualTextareaCount, 1);
  assert.equal(result.manual.length, 1);
  assert.equal(result.manual[0].value, expected);
  assert.equal(result.manual[0].selected, true);
});

test("an older rejected copy cannot replace a newer successful answer", async (t) => {
  const result = await runBrowserScenario(
    t,
    "staleFailure",
    '<form data-lavish-question="revision"><input name="answer" value="Old answer"></form>',
  );
  if (!result) return;
  assert.equal(result.copied, "revision:\n  answer: New answer");
  assert.equal(result.manualTextareaCount, 0);
  assert.equal(result.status, "Answers copied.");
});

test("checked choices with empty or missing values copy their visible labels", async (t) => {
  const result = await runBrowserScenario(
    t,
    "clipboard",
    '<form data-lavish-question="choices"><label><input type="checkbox" name="feature" value="" checked> Include notes</label><label><input type="radio" name="tier" checked> Standard tier</label></form>',
  );
  if (!result) return;
  assert.equal(result.copied, "choices:\n  feature: Include notes\n  tier: Standard tier");
});

const fieldsetFixture = `<form data-lavish-question="access">
      <fieldset disabled>
        <label><input type="checkbox" name="legacy" value="Yes" checked> Legacy</label>
      </fieldset>
      <input type="text" name="note" value="Keep this" disabled>
      <input type="text" name="active" value="Visible answer">
    </form>`;

test("fieldset-disabled and directly disabled controls are excluded", async (t) => {
  const result = await runBrowserScenario(t, "clipboard", fieldsetFixture);
  if (!result) return;
  assert.equal(result.noLavish, true);
  assert.equal(result.copied, "access:\n  active: Visible answer");
});

const unsupportedInputFixture = `<form data-lavish-question="settings">
      <input type="range" name="volume" value="50">
      <input type="color" name="accent" value="#000000">
      <input type="text" name="note" value="Keep this">
    </form>`;

test("range and color values are excluded from copied answers", async (t) => {
  const result = await runBrowserScenario(t, "clipboard", unsupportedInputFixture);
  if (!result) return;
  assert.equal(result.copied, "settings:\n  note: Keep this");
});

const multiSelectFixture = `<form data-lavish-question="tags">
      <select name="tags" multiple>
        <option value="alpha" selected>Alpha</option>
        <option value="beta" selected>Beta</option>
        <option value="gamma">Gamma</option>
      </select>
    </form>`;

test("a multi-value select copies one line per selected option", async (t) => {
  const result = await runBrowserScenario(t, "clipboard", multiSelectFixture);
  if (!result) return;
  assert.equal(result.noLavish, true);
  assert.equal(result.copied, "tags:\n  tags: alpha\n  tags: beta");
});

const disabledSelectedOptionsFixture = `<form data-lavish-question="tags">
      <select name="tags" multiple>
        <option value="alpha" selected>Alpha</option>
        <option value="beta" selected disabled>Beta</option>
        <optgroup label="Unavailable" disabled>
          <option value="gamma" selected>Gamma</option>
        </optgroup>
        <option value="delta" selected>Delta</option>
      </select>
    </form>`;

test("disabled selected options and disabled optgroups are excluded", async (t) => {
  const result = await runBrowserScenario(t, "clipboard", disabledSelectedOptionsFixture);
  if (!result) return;
  assert.equal(result.copied, "tags:\n  tags: alpha\n  tags: delta");
});

const multilineFixture = `<form data-lavish-question="notes">
      <textarea name="notes">Line one
Line two
Line three</textarea>
    </form>`;

test("a multi-line textarea value indents its continuation lines under the label", async (t) => {
  const result = await runBrowserScenario(t, "clipboard", multilineFixture);
  if (!result) return;
  assert.equal(result.noLavish, true);
  assert.equal(result.copied, "notes:\n  notes: Line one\n    Line two\n    Line three");
});

const nestedQuestionFixture = `<form data-lavish-question="outer">
      <div data-lavish-question="inner">
        <input type="text" name="detail" value="Nested answer">
      </div>
    </form>`;

test("a nested question's control is counted once, under the inner question", async (t) => {
  const result = await runBrowserScenario(t, "clipboard", nestedQuestionFixture);
  if (!result) return;
  assert.equal(result.noLavish, true);
  assert.equal(result.copied, "inner:\n  detail: Nested answer");
});
