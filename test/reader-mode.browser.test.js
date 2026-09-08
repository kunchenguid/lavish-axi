import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Mobile reader mode is a geometry contract, and geometry is the one thing a DOM harness cannot
// check: the unit tests pin the state machine, and this pins what the reviewer actually gets - a
// phone screen that is all artifact while they read, and chrome that always comes back.
const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(repoRoot, "test/fixtures/reader-mode");

function run(command, args, env, timeout = 45_000) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a TCP port");
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return address.port;
}

test(
  "mobile reader mode hands the phone screen to the artifact and always gives it back",
  {
    skip: !runBrowserE2e,
    timeout: 420_000,
  },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-reader-mode-"));
    const port = await freePort();
    const lavishEnv = {
      LAVISH_AXI_PORT: String(port),
      LAVISH_AXI_STATE_DIR: path.join(temp, "state"),
      LAVISH_AXI_NO_OPEN: "1",
      LAVISH_AXI_TELEMETRY: "0",
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
    };
    const chromeEnv = {
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-reader-mode-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };

    /** Evaluate an expression in the chrome page and return its JSON-decoded result. */
    function evaluate(expression) {
      const output = run("chrome-devtools-axi", ["eval", expression], chromeEnv);
      const raw = output.match(/result:\s*("(?:[^"\\]|\\.)*")/s)?.[1];
      assert.ok(raw, output);
      let value = JSON.parse(raw);
      while (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          break;
        }
      }
      return value;
    }

    // Settling time is the harness's own business, and the driver's `wait` subcommand is not
    // reliable across its versions, so this blocks in this process instead of spending a browser
    // round-trip on it. The surrounding helpers are synchronous, so this sleep is too.
    function wait(ms) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    }

    // Accessibility-tree refs go stale after every action, so always resolve a fresh one.
    function snapshot() {
      return run("chrome-devtools-axi", ["snapshot"], chromeEnv);
    }
    function click(pattern) {
      const line = snapshot()
        .split("\n")
        .find((candidate) => pattern.test(candidate));
      assert.ok(line, `no snapshot line matching ${pattern}`);
      run("chrome-devtools-axi", ["click", `@${line.trim().split(/\s+/)[0].replace(/^uid=/, "")}`], chromeEnv);
    }

    function layout() {
      return evaluate(
        "JSON.stringify({" +
          ' reader: document.body.classList.contains("reader-mode"),' +
          ' barHeight: Math.round(document.querySelector(".bar").getBoundingClientRect().height),' +
          ' frameHeight: Math.round(document.querySelector(".frame").getBoundingClientRect().height),' +
          // The phone panel is a fixed-height bottom sheet that is translated, not resized, so its
          // own height says nothing about what the reviewer sees. How much of it is on screen does.
          ' panelOnScreen: Math.max(0, Math.round(window.innerHeight - document.querySelector(".panel").getBoundingClientRect().top)),' +
          ' sheetOpen: document.body.classList.contains("sheet-open"),' +
          ' restoreHidden: document.getElementById("readerRestore").hidden,' +
          ' restoreVisible: getComputedStyle(document.getElementById("readerRestore")).display !== "none",' +
          " viewportHeight: window.innerHeight," +
          " docOverflow: document.documentElement.scrollWidth - window.innerWidth," +
          ' draft: document.getElementById("chatInput").value,' +
          "})",
      );
    }

    // The artifact is sandboxed with an opaque origin, so the driver cannot script it directly. The
    // fixture turns this message into a real window.scrollBy, which is what the SDK reports on.
    function scrollArtifact(dy) {
      evaluate(
        'JSON.stringify((() => { document.getElementById("artifact").contentWindow.postMessage(' +
          `{ type: "lavish-test:scrollBy", dy: ${dy} }, "*"); return "sent"; })())`,
      );
      // Long enough for the artifact's scroll frame, its postMessage, and any chrome transition.
      wait(400);
    }

    try {
      const artifact = path.join(temp, "article.html");
      await copyFile(path.join(fixtures, "tall-article.html"), artifact);
      const output = run(process.execPath, ["bin/lavish-axi.js", artifact, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);

      // chrome-devtools-axi emulates against the selected page, and a freshly launched browser has
      // no selection yet, so the blank startup tab is selected first.
      run("chrome-devtools-axi", ["selectpage", "1"], chromeEnv);
      run("chrome-devtools-axi", ["emulate", "--viewport", "390x844x3,mobile,touch"], chromeEnv);
      run("chrome-devtools-axi", ["open", url], chromeEnv);
      wait(5000);

      const initial = layout();
      assert.equal(initial.reader, false, "a review opens with its chrome in place");
      assert.ok(initial.barHeight > 40, "the header is present");
      assert.ok(initial.panelOnScreen > 40, "the conversation dock is present");
      assert.equal(initial.sheetOpen, false, "the review opens with the sheet down");
      assert.equal(initial.restoreHidden, true, "no restore control while the chrome is visible");
      assert.equal(initial.docOverflow, 0, "the narrow layout does not scroll sideways");

      // ---------------------------------------------------------------------
      // Scrolling down hands the screen to the artifact.
      // ---------------------------------------------------------------------
      scrollArtifact(160);
      scrollArtifact(160);

      const collapsed = layout();
      assert.equal(collapsed.reader, true, "scrolling down collapses the chrome");
      assert.equal(collapsed.barHeight, 0, "the header is gone, not merely faded");
      assert.equal(collapsed.panelOnScreen, 0, "the conversation dock is off the screen, not merely faded");
      assert.equal(
        collapsed.frameHeight,
        collapsed.viewportHeight,
        "the artifact gets the whole viewport while the reviewer reads",
      );
      assert.equal(collapsed.restoreHidden, false, "the restore control appears with the collapsed chrome");
      assert.equal(collapsed.docOverflow, 0, "collapsing never introduces horizontal overflow");

      // ---------------------------------------------------------------------
      // Scrolling up gives it straight back.
      // ---------------------------------------------------------------------
      scrollArtifact(-160);

      const restored = layout();
      assert.equal(restored.reader, false, "scrolling up restores the chrome");
      assert.equal(restored.barHeight, initial.barHeight);
      assert.equal(restored.panelOnScreen, initial.panelOnScreen);
      assert.equal(restored.restoreHidden, true);

      // ---------------------------------------------------------------------
      // A composer in use is never pulled out from under the reviewer.
      // ---------------------------------------------------------------------
      // On a phone the composer only exists inside the raised sheet - the docked half is inert -
      // so this is what "typing in the composer" actually looks like here.
      evaluate('JSON.stringify((() => { document.getElementById("panelHead").click(); return "raised"; })())');
      wait(600);
      evaluate(
        'JSON.stringify((() => { const input = document.getElementById("chatInput");' +
          ' input.focus(); input.value = "half-written feedback";' +
          ' input.dispatchEvent(new Event("input", { bubbles: true }));' +
          " return document.activeElement && document.activeElement.id; })())",
      );
      scrollArtifact(200);
      scrollArtifact(200);
      const typing = layout();
      assert.equal(typing.reader, false, "a composer in use is never pulled out from under the reviewer");
      assert.equal(typing.sheetOpen, true, "and the sheet it lives in stays up");
      assert.equal(typing.draft, "half-written feedback");

      evaluate(
        'JSON.stringify((() => { document.getElementById("chatInput").blur();' +
          ' document.getElementById("panelHead").click(); return "done"; })())',
      );
      wait(600);
      scrollArtifact(200);
      scrollArtifact(200);
      const afterBlur = layout();
      assert.equal(afterBlur.reader, true, "the auto-hide resumes once the composer is done");
      assert.equal(afterBlur.draft, "half-written feedback", "the draft survives the collapse");

      // ---------------------------------------------------------------------
      // The restore control is the guaranteed way back.
      // ---------------------------------------------------------------------
      const recovered = evaluate(
        'JSON.stringify((() => { const button = document.getElementById("readerRestore");' +
          " button.focus(); button.click(); return {" +
          ' reader: document.body.classList.contains("reader-mode"),' +
          " focus: document.activeElement && document.activeElement.id," +
          ' draft: document.getElementById("chatInput").value,' +
          "}; })())",
      );
      assert.equal(recovered.reader, false, "the restore control brings the chrome back");
      assert.equal(recovered.focus, "annotation", "keyboard focus lands on a control that is actually visible");
      assert.equal(recovered.draft, "half-written feedback", "the draft survives the restore");

      // ---------------------------------------------------------------------
      // Escape works with focus inside the sandboxed artifact, not just in the chrome.
      // ---------------------------------------------------------------------
      // Explore mode so a tap inside the article moves focus into the iframe without opening an
      // annotation card, which would suppress the auto-hide on purpose.
      evaluate('JSON.stringify((() => { document.getElementById("annotation").click(); return "explore"; })())');
      wait(400);
      click(/Paragraph 3\./);
      wait(400);
      const focused = evaluate(
        'JSON.stringify({ tag: document.activeElement && document.activeElement.tagName, reader: document.body.classList.contains("reader-mode") })',
      );
      assert.equal(focused.tag, "IFRAME", "the tap really moved focus into the sandboxed artifact");

      scrollArtifact(200);
      scrollArtifact(200);
      assert.equal(layout().reader, true, "the chrome still collapses with focus inside the artifact");

      run("chrome-devtools-axi", ["press", "Escape"], chromeEnv);
      wait(400);
      const afterEscape = layout();
      assert.equal(afterEscape.reader, false, "Escape reaches the chrome from inside the sandboxed iframe");
      assert.equal(afterEscape.restoreHidden, true);
      assert.equal(afterEscape.draft, "half-written feedback", "the draft survives an Escape restore");

      evaluate('JSON.stringify((() => { document.getElementById("annotation").click(); return "annotate"; })())');

      // ---------------------------------------------------------------------
      // The bottom-sheet conversation still works, and the two never fight.
      // ---------------------------------------------------------------------
      // Raise the sheet from the dock, exactly as a tap does.
      evaluate('JSON.stringify((() => { document.getElementById("panelHead").click(); return "raised"; })())');
      wait(600);
      const raised = layout();
      assert.equal(raised.sheetOpen, true, "the dock still raises the conversation sheet");
      assert.ok(raised.panelOnScreen > 200, "the raised sheet covers most of the screen");
      assert.equal(raised.draft, "half-written feedback", "the draft is still in the composer the sheet reveals");

      scrollArtifact(200);
      scrollArtifact(200);
      const scrolledUnderSheet = layout();
      assert.equal(scrolledUnderSheet.reader, false, "a raised sheet is never slid away by a scroll underneath it");
      assert.equal(scrolledUnderSheet.sheetOpen, true);

      // Lowering it hands the artifact back and reader mode resumes from there.
      evaluate('JSON.stringify((() => { document.getElementById("panelHead").click(); return "lowered"; })())');
      wait(600);
      assert.equal(layout().sheetOpen, false, "the sheet lowers back to its dock");
      scrollArtifact(200);
      scrollArtifact(200);
      const afterSheet = layout();
      assert.equal(afterSheet.reader, true, "reader mode resumes once the sheet is down");
      assert.equal(afterSheet.panelOnScreen, 0);

      // Raising the conversation from a collapsed chrome brings the whole chrome back with it.
      evaluate('JSON.stringify((() => { document.getElementById("readerRestore").click(); return "restored"; })())');
      wait(600);
      evaluate('JSON.stringify((() => { document.getElementById("panelHead").click(); return "raised"; })())');
      wait(600);
      const raisedAgain = layout();
      assert.equal(raisedAgain.reader, false, "the sheet never rises out of chrome that is still collapsed");
      assert.equal(raisedAgain.sheetOpen, true);
      assert.ok(raisedAgain.barHeight > 40, "the header comes back with it");
      evaluate('JSON.stringify((() => { document.getElementById("panelHead").click(); return "lowered"; })())');
      wait(600);

      // ---------------------------------------------------------------------
      // Desktop is untouched.
      // ---------------------------------------------------------------------
      run("chrome-devtools-axi", ["emulate", "--viewport", "1440x1000x1"], chromeEnv);
      wait(5000);
      scrollArtifact(300);
      scrollArtifact(300);
      const desktop = layout();
      assert.equal(desktop.reader, false, "a desktop viewport never collapses its chrome");
      assert.ok(desktop.barHeight > 40);
      assert.equal(desktop.restoreVisible, false, "the restore control does not exist on desktop");
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
