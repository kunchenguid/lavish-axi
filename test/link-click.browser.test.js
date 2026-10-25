import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// What a reviewer's click on a link does in annotate mode, driven in a real Chrome against one
// local Lavish server. Plain clicks are real input (chrome-devtools-axi click and hover), so the
// browser performs the link's default action. The tool cannot hold a modifier, so the Alt, Cmd
// and Ctrl clicks and the text-selection click are dispatched inside the artifact frame. The
// artifact frame is sandboxed, so every question about it goes through a postMessage probe.
const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  await new Promise((resolve) => server.close(() => resolve(address.port)));
  return address.port;
}

const OTHER_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Other document</title></head><body><p>Other document</p></body></html>`;

// Every link has its own label so the accessibility snapshot can find it, and they sit in a
// fixed bar so a real click never has to scroll the review to reach one. The window listener
// records the link's target at the moment the click reaches the page, after Lavish's capture
// listener ran, and re-reads the target and defaultPrevented after a task has passed.
const ARTIFACT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Link fixture</title>
<style>a, p { cursor: crosshair; } body { margin: 0; }</style>
</head><body>
<div style="position:fixed;top:0;left:0;background:#fff">
<p id="prose">Ordinary prose.</p>
<a id="frag" href="#sec">Jump to section</a>
<a id="other" href="other.html">Open other</a>
<a id="handled" href="other.html">Handled link</a>
<a id="mail" href="mailto:review@example.com">Mail us</a>
<a id="data" href="data:text/plain,hello">Data link</a>
<a id="self" href="">Self link</a>
<a id="spanlink" href="other.html"><span id="inner">Span link</span></a>
<a id="sellink" href="other.html">Select link</a>
</div>
<div style="height:5000px"></div>
<h2 id="sec">Section</h2>
<script>
(function () {
  var loadId = String(Math.random());
  var log = [];
  var handlers = { other: 0, handled: 0 };
  document.getElementById("other").addEventListener("click", function () { handlers.other += 1; });
  document.getElementById("handled").addEventListener("click", function (event) {
    handlers.handled += 1;
    event.preventDefault();
  });
  window.addEventListener("click", function (event) {
    var link = event.target.closest && event.target.closest("a");
    if (!link) return;
    var entry = { id: link.id, targetAtClick: link.getAttribute("target") };
    log.push(entry);
    setTimeout(function () {
      entry.targetAfter = link.getAttribute("target");
      entry.defaultPrevented = event.defaultPrevented;
    }, 50);
  });

  function cardState() {
    var host = document.querySelector('[data-lavish-ui="annotation-root"]');
    var card = host && host.shadowRoot && host.shadowRoot.querySelector(".lavish-annotation-card");
    var heading = card && card.querySelector(".lavish-heading");
    return { open: Boolean(card), heading: heading ? heading.textContent : "" };
  }
  function closeCard() {
    var host = document.querySelector('[data-lavish-ui="annotation-root"]');
    var cancel = host && host.shadowRoot && host.shadowRoot.querySelector(".lavish-cancel");
    if (cancel) cancel.click();
  }
  function modifierClick(data) {
    var el = document.getElementById(data.id);
    var init = { bubbles: true, cancelable: true, view: window, altKey: !!data.altKey, ctrlKey: !!data.ctrlKey, metaKey: !!data.metaKey };
    if (data.select) {
      var range = document.createRange();
      range.selectNodeContents(el);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      el.dispatchEvent(new MouseEvent("mouseup", init));
    }
    var notCanceled = el.dispatchEvent(new MouseEvent("click", init));
    return { notCanceled: notCanceled };
  }

  window.addEventListener("message", function (event) {
    var data = event.data || {};
    if (data.type !== "lavish-link-probe") return;
    var reply = {};
    if (data.action === "reset") {
      closeCard();
      window.getSelection().removeAllRanges();
      log.length = 0;
      handlers.other = 0;
      handlers.handled = 0;
    } else if (data.action === "click") {
      reply = modifierClick(data);
    } else if (data.action === "read") {
      var link = document.getElementById("other");
      var linkStyle = getComputedStyle(link);
      var inner = document.getElementById(data.id || "other");
      reply = {
        loadId: loadId,
        scrollY: window.scrollY,
        hash: location.hash,
        viewport: window.innerHeight,
        sectionTop: Math.round(document.getElementById("sec").getBoundingClientRect().top),
        log: log.slice(),
        handlers: handlers,
        card: cardState(),
        apple: /Mac|iP(hone|ad|od)/.test(navigator.platform),
        outline: { link: link.style.outline, spanlink: document.getElementById("spanlink").style.outline, inner: document.getElementById("inner").style.outline, prose: document.getElementById("prose").style.outline },
        cursor: { link: linkStyle.cursor, prose: getComputedStyle(document.getElementById("prose")).cursor },
        selected: inner.style.outline,
      };
    }
    parent.postMessage({ type: "lavish-link-probe-result", nonce: data.nonce, reply: reply }, "*");
  });
})();
</script>
</body></html>`;

test(
  "a plain click on a link follows it in annotate mode and Alt+click annotates it",
  { skip: !runBrowserE2e, timeout: 600_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-link-e2e-"));
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
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-link-e2e-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };
    const axi = (...args) => run("chrome-devtools-axi", args, chromeEnv);

    function evaluate(expression) {
      const output = axi("eval", expression);
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

    // Asks the artifact frame a question and waits for its answer.
    let nonce = 0;
    function ask(payload) {
      nonce += 1;
      const message = JSON.stringify({ ...payload, type: "lavish-link-probe", nonce });
      return evaluate(`() => new Promise((resolve) => {
        const onMessage = (event) => {
          const data = event.data || {};
          if (data.type !== "lavish-link-probe-result" || data.nonce !== ${nonce}) return;
          window.removeEventListener("message", onMessage);
          resolve(data.reply);
        };
        window.addEventListener("message", onMessage);
        document.getElementById("artifact").contentWindow.postMessage(${message}, "*");
        setTimeout(() => { window.removeEventListener("message", onMessage); resolve({ timedOut: true }); }, 5000);
      })`);
    }

    function pause(ms) {
      evaluate(`() => new Promise((resolve) => setTimeout(() => resolve("waited"), ${ms}))`);
    }

    function read(id) {
      pause(150);
      const reply = ask({ action: "read", id });
      assert.ok(!reply.timedOut, "the artifact frame never answered the probe");
      return reply;
    }

    function ref(label) {
      const snapshot = axi("snapshot");
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = snapshot.match(new RegExp(`uid=(\\S+) (?:\\w+ )?"${escaped}"`));
      assert.ok(match, `no "${label}" in the snapshot\n${snapshot}`);
      return `@${match[1]}`;
    }

    function pages() {
      const output = axi("pages");
      return [...output.matchAll(/^\s*(\d+),(\S*),(true|false)\s*$/gm)].map((m) => ({
        id: m[1],
        url: m[2],
        selected: m[3] === "true",
      }));
    }

    const mainPage = { id: "" };
    // Closes the tabs a click opened and returns their addresses, so the next scenario starts
    // from the review page alone.
    function closeOpenedTabs(knownIds) {
      const opened = pages().filter((p) => !knownIds.has(p.id));
      for (const p of opened) axi("closepage", p.id);
      axi("selectpage", mainPage.id);
      return opened.map((p) => p.url);
    }

    // A real click, then the tabs it opened.
    function realClick(label) {
      const known = new Set(pages().map((p) => p.id));
      ask({ action: "reset" });
      axi("click", ref(label));
      pause(600);
      const opened = pages()
        .filter((p) => !known.has(p.id))
        .map((p) => p.url);
      closeOpenedTabs(known);
      return { opened };
    }

    function modifierClickOutcome(payload) {
      const known = new Set(pages().map((p) => p.id));
      ask({ action: "reset" });
      const result = ask({ action: "click", ...payload });
      pause(600);
      const opened = pages()
        .filter((p) => !known.has(p.id))
        .map((p) => p.url);
      closeOpenedTabs(known);
      return { ...result, opened };
    }

    try {
      await writeFile(path.join(temp, "other.html"), OTHER_HTML);
      const artifact = path.join(temp, "links.html");
      await writeFile(artifact, ARTIFACT_HTML);
      const output = run(process.execPath, ["bin/lavish-axi.js", artifact, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);

      axi("open", url);
      pause(4000);
      mainPage.id = pages().find((p) => p.selected)?.id ?? "";
      assert.ok(mainPage.id, "no selected review page");

      let state = null;
      for (let attempt = 0; attempt < 40 && !state?.loadId; attempt += 1) {
        pause(500);
        state = ask({ action: "read" });
      }
      assert.ok(state?.loadId, "the artifact never answered the probe");
      const loadId = state.loadId;

      const follow = state.apple ? { metaKey: true } : { ctrlKey: true };

      // (7) The pointer cursor marks a link; the outline that promises an annotation does not,
      // while a hovered paragraph still gets it.
      axi("hover", ref("Open other"));
      state = read();
      assert.equal(state.cursor.link, "pointer", "a link shows the pointer cursor in annotate mode");
      assert.equal(state.outline.link, "", "a hovered link gets no annotation outline");
      axi("hover", ref("Ordinary prose."));
      state = read();
      assert.notEqual(state.outline.prose, "", "a hovered paragraph still gets the annotation outline");
      assert.equal(state.cursor.prose, "default");

      // (1) A plain click on an in-page anchor scrolls the artifact and opens no card.
      let click = realClick("Jump to section");
      state = read();
      assert.ok(
        state.scrollY > 500,
        `the anchor scrolled the artifact ${JSON.stringify(state)} ${JSON.stringify(click)}`,
      );
      assert.equal(state.card.open, false, "following a link opens no annotation card");
      assert.deepEqual(click.opened, [], "an in-page anchor opens no tab");
      assert.equal(state.loadId, loadId);
      assert.equal(state.log[0].targetAtClick, null, "an in-page anchor keeps the browser's behavior");
      const scrolled = state.scrollY;

      // (1) A link to another document opens beside the review; the frame and its scroll survive,
      // and the author's target comes back.
      click = realClick("Open other");
      state = read();
      assert.equal(click.opened.length, 1, `the link opened one tab: ${click.opened}`);
      assert.match(click.opened[0], /other\.html/);
      assert.equal(state.loadId, loadId, "the artifact frame was not navigated away");
      assert.equal(state.scrollY, scrolled, "the review kept its scroll position");
      assert.equal(state.card.open, false);
      assert.equal(state.log[0].targetAtClick, "_blank", "the target is swapped for the click");
      assert.equal(state.log[0].targetAfter, null, "the target is restored in the next task");
      // (2) The artifact's own click handler still ran.
      assert.equal(state.handlers.other, 1, "the artifact's own click handler ran");

      // (2) A handler that calls preventDefault still wins: no tab opens.
      click = realClick("Handled link");
      state = read();
      assert.equal(state.handlers.handled, 1);
      assert.equal(state.log[0].defaultPrevented, true);
      assert.deepEqual(click.opened, [], "a handler that prevents the default keeps the link from opening");
      assert.equal(state.loadId, loadId);

      // (5) mailto: keeps the browser's behavior; data: and a fragment-less self-link get the swap.
      click = realClick("Mail us");
      state = read();
      assert.equal(state.log[0].targetAtClick, null, "a mailto: link keeps the browser's behavior");
      assert.equal(state.loadId, loadId);
      click = realClick("Data link");
      state = read();
      assert.equal(state.log[0].targetAtClick, "_blank", "a data: link opens beside the review");
      assert.equal(state.loadId, loadId, "a data: link does not navigate the artifact frame");
      click = realClick("Self link");
      state = read();
      assert.equal(state.log[0].targetAtClick, "_blank", "a fragment-less self-link gets the swap");
      assert.equal(state.loadId, loadId, "a fragment-less self-link does not reload the frame");
      assert.equal(click.opened.length, 1, `the self-link opened beside the review: ${click.opened}`);

      // (3) Alt+click annotates the link, and a span inside it resolves to the link too.
      let outcome = modifierClickOutcome({ id: "other", altKey: true });
      state = read();
      assert.equal(state.card.open, true, "Alt+click on a link opens the annotation card");
      assert.equal(outcome.notCanceled, false, "the annotation click is consumed");
      assert.deepEqual(outcome.opened, [], "Alt+click opens no tab");
      assert.equal(state.log.length, 0, "the consumed click never reaches the page");
      assert.notEqual(state.outline.link, "", "the card is anchored to the link");
      outcome = modifierClickOutcome({ id: "inner", altKey: true });
      state = read();
      assert.equal(state.card.open, true, "Alt+click on a span inside a link opens the card");
      assert.notEqual(state.outline.spanlink, "", "the card is anchored to the link");
      assert.equal(state.outline.inner, "", "the span inside the link is not what is annotated");

      // (4) The platform's follow modifier is left to the browser: not swallowed, not swapped.
      outcome = modifierClickOutcome({ id: "other", ...follow });
      state = read();
      assert.equal(state.card.open, false, "a follow-modifier click opens no annotation card");
      assert.equal(outcome.notCanceled, true, "a follow-modifier click is not swallowed");
      assert.equal(state.log[0].targetAtClick, null, "a follow-modifier click is not retargeted");
      assert.equal(state.loadId, loadId);

      // (6) A click that ends a text selection annotates the selection and does not follow.
      outcome = modifierClickOutcome({ id: "sellink", select: true });
      state = read();
      assert.equal(state.card.open, true, "a click that ends a selection opens the card");
      assert.equal(outcome.notCanceled, false, "the link is not followed");
      assert.deepEqual(outcome.opened, [], "the selection click opens no tab");
      assert.equal(state.loadId, loadId);
      ask({ action: "reset" });
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
