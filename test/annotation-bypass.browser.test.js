import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";

// A test-only driver lives inside the opaque-origin artifact. Its DOM events exercise the real
// SDK and browser defaults; trusted clicks and keyboard presses also enter via the browser CLI.
const artifact = `<!doctype html><html><head><meta charset="utf-8"><title>Annotation bypass fixture</title>
<style>body{font:18px system-ui;padding:32px}#target{cursor:pointer;padding:24px;background:#eee}input{margin:16px}#diagram svg{display:block;height:160px;width:600px;max-width:100%}</style>
</head><body><h1>Annotation bypass fixture</h1><div id="diagram"></div><div id="target" tabindex="0">Explore this section</div>
<p id="text">Select these sample words.</p><label><input id="check" type="checkbox">Enable sample</label>
<input id="input" aria-label="Sample input"><div id="edit" contenteditable="true">Editable sample</div>
<a href="#destination">Sample link</a><p id="destination">Destination</p>
<script src="mermaid.min.js"></script>
<script>
mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });
mermaid.render('mermaid-bypass', 'flowchart LR; A[Start] --> B[Finish]').then(({svg}) => {
  document.getElementById('diagram').innerHTML = svg;
});
let queuedHold = null;
let delayHold = false;
window.addEventListener('message', event => {
  if (delayHold && event.source === parent && event.data?.type === 'lavish:setAnnotationBypass' && event.data.held) {
    event.stopImmediatePropagation(); queuedHold = event.data; delayHold = false;
  }
}, true);
const errors = [];
window.addEventListener('error', event => errors.push(event.message));
let clicks = 0;
const keys = [];
document.getElementById('target').addEventListener('click', () => clicks++);
const cards = () => [...document.querySelectorAll('[data-lavish-ui="annotation-root"]')]
  .flatMap(root => [...root.shadowRoot.querySelectorAll('.lavish-annotation-card')]);
for (const type of ['keydown', 'keyup']) document.addEventListener(type, event => {
  keys.push({ type, key: event.key, trusted: event.isTrusted, prevented: event.defaultPrevented,
    cursor: !!document.getElementById('lavish-cursor-style') });
});
window.addEventListener('message', event => {
  if (event.source !== parent || event.data?.type !== 'bypass-test') return;
  const d = event.data;
  const target = document.querySelector(d.selector || '#target');
  let prevented = null;
  if (d.action === 'delay') delayHold = true;
  if (d.action === 'deliver') {
    target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', altKey: false, bubbles: true }));
    window.dispatchEvent(new MessageEvent('message', { source: parent, data: queuedHold }));
  }
  const svg = document.querySelector('#diagram svg');
  const before = svg?.getAttribute('viewBox');
  if (d.action === 'drag' || d.action === 'wheel') {
    const r = svg.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (d.action === 'wheel') svg.dispatchEvent(new WheelEvent('wheel', {
      clientX: x, clientY: y, deltaY: -100, altKey: !!d.held, bubbles: true, cancelable: true
    }));
    else {
      for (const [type, offset] of [['pointerdown', 0], ['pointermove', 12], ['pointerup', 12]]) {
        svg.dispatchEvent(new PointerEvent(type, { clientX: x + offset, clientY: y + offset,
          button: 0, pointerId: 1, altKey: !!d.held, bubbles: true }));
      }
    }
  }
  if (d.action === 'key') target.dispatchEvent(new KeyboardEvent(d.event || 'keydown', {
    key: d.key || 'Alt', altKey: d.held, bubbles: true, cancelable: true, repeat: !!d.repeat
  }));
  if (d.action === 'click') {
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, altKey: !!d.held });
    target.dispatchEvent(click); prevented = click.defaultPrevented;
  }
  if (d.action === 'select') {
    const range = document.createRange(); range.selectNodeContents(target);
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, altKey: !!d.held }));
  }
  if (d.action === 'focus') target.focus();
  if (d.action === 'blur') window.dispatchEvent(new Event('blur'));
  if (d.action === 'hidden') {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange')); delete document.hidden;
  }
  if (d.action === 'draft') cards()[0].querySelector('textarea').value = 'Keep this sample draft';
  if (d.action === 'cancel') cards()[0]?.querySelector('.lavish-cancel').click();
  parent.postMessage({ type: 'bypass-test-result', result: {
    errors, before, viewBox: svg?.getAttribute('viewBox'), queued: !!queuedHold, prevented, clicks, cards: cards().length, draft: cards()[0]?.querySelector('textarea').value,
    cursor: !!document.getElementById('lavish-cursor-style'), checked: document.getElementById('check').checked,
    input: document.getElementById('input').value, edit: document.getElementById('edit').textContent,
    selection: document.getSelection().toString(), keys
  } }, '*');
});
</script></body></html>`;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return address.port;
}

test(
  "Alt exploration bypass works across chrome and the sandbox without changing the selected mode",
  {
    skip: !runBrowserE2e,
    timeout: 300_000,
  },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-bypass-"));
    const port = await freePort();
    const lavishEnv = {
      LAVISH_AXI_STATE_DIR: path.join(temp, "state"),
      LAVISH_AXI_PORT: String(port),
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
      LAVISH_AXI_TELEMETRY: "0",
    };
    const chromeEnv = {
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-bypass-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };
    function run(command, args, env) {
      const result = spawnSync(command, args, { env: { ...process.env, ...env }, encoding: "utf8", timeout: 45_000 });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      return result.stdout;
    }
    const browser = (...args) => run("chrome-devtools-axi", args, chromeEnv);
    function evaluate(js) {
      const output = browser("eval", js);
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
    function probe(data = {}) {
      return evaluate(`() => new Promise(resolve => {
      const frame = document.getElementById('artifact');
      const listener = event => {
        if (event.source !== frame.contentWindow || event.data?.type !== 'bypass-test-result') return;
        window.removeEventListener('message', listener);
        resolve(JSON.stringify(event.data.result));
      };
      window.addEventListener('message', listener);
      frame.contentWindow.postMessage({ type: 'bypass-test', ...${JSON.stringify(data)} }, '*');
    })`);
    }
    async function evidence(name) {
      const dir = process.env.LAVISH_AXI_BROWSER_EVIDENCE_DIR;
      if (!dir) return;
      await mkdir(dir, { recursive: true });
      browser("screenshot", path.join(dir, name + ".png"));
    }
    function chromeKey(held, type = "keydown") {
      evaluate(`() => { document.dispatchEvent(new KeyboardEvent('${type}', {
      key: 'Alt', altKey: ${held}, bubbles: true, cancelable: true
    })); return 'ok'; }`);
    }
    function label() {
      return evaluate(`JSON.stringify({ pressed: document.getElementById('annotation').getAttribute('aria-pressed'),
      label: document.getElementById('annotationLabel').textContent, hint: document.getElementById('annotation').title })`);
    }
    function assertEnabledSwitchColors() {
      const colors = evaluate(`JSON.stringify({
        pressed: document.getElementById('annotation').getAttribute('aria-pressed'),
        track: getComputedStyle(document.querySelector('#annotation .switch-track')).backgroundColor,
        knob: getComputedStyle(document.querySelector('#annotation .switch-knob')).backgroundColor
      })`);
      assert.deepEqual(colors, { pressed: "true", track: "rgb(244, 201, 93)", knob: "rgb(23, 19, 10)" });
    }
    try {
      const file = path.join(temp, "artifact.html");
      await writeFile(file, artifact);
      await copyFile("node_modules/mermaid/dist/mermaid.min.js", path.join(temp, "mermaid.min.js"));
      const opened = run(process.execPath, ["bin/lavish-axi.js", file, "--no-open"], lavishEnv);
      const url = opened.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, opened);
      browser("open", url);
      browser("wait", "3000");
      assert.match(label().hint, /Hold Alt\/Option/);
      assertEnabledSwitchColors();

      // Hold is queued by chrome, but the artifact observes release while still locally false.
      probe({ action: "delay" });
      chromeKey(true);
      assert.equal(probe().queued, true);
      probe({ action: "deliver" });
      assert.equal(probe().cursor, true);
      assert.equal(label().label, "Annotate");
      await evidence("release-after-delayed-hold");

      // Symmetric race: an artifact hold is queued while chrome observes release.
      evaluate(`() => {
        window.delayedArtifactHold = null;
        const delay = event => {
          if (event.source !== document.getElementById('artifact').contentWindow ||
              event.data?.type !== 'lavish:annotationBypass' || !event.data.held) return;
          event.stopImmediatePropagation();
          window.delayedArtifactHold = event.data;
          window.removeEventListener('message', delay, true);
        };
        window.addEventListener('message', delay, true);
        return 'ok';
      }`);
      probe({ action: "key", held: true });
      chromeKey(false, "keyup");
      evaluate(`() => {
        if (!window.delayedArtifactHold) throw new Error('missing queued artifact hold');
        window.dispatchEvent(new MessageEvent('message', {
          source: document.getElementById('artifact').contentWindow, data: window.delayedArtifactHold
        }));
        return 'ok';
      }`);
      assert.equal(label().label, "Annotate");
      assert.equal(probe().cursor, true);

      // Real Mermaid-rendered SVG: assert effective movement, not just modifier state.
      for (const action of ["drag", "wheel"]) {
        let gesture = probe({ action });
        assert.ok(gesture.viewBox, "Mermaid has rendered");
        assert.equal(gesture.viewBox, gesture.before, `${action} frozen before holding`);
        gesture = probe({ action, held: true });
        assert.notEqual(gesture.viewBox, gesture.before, `${action} observes Alt before handling the gesture`);
        console.log(`${action} while held: ${gesture.before} -> ${gesture.viewBox}`);
        gesture = probe({ action });
        assert.equal(gesture.viewBox, gesture.before, `${action} freezes immediately on release`);
        chromeKey(true);
        gesture = probe({ action, held: true });
        assert.notEqual(gesture.viewBox, gesture.before, `${action} after entry from chrome`);
        chromeKey(false, "keyup");
        gesture = probe({ action });
        assert.equal(gesture.viewBox, gesture.before, `${action} after cross-document release`);
      }

      assert.deepEqual(probe().errors, [], "diagram gestures run without browser errors");

      // A trusted unmodified click really intercepts and opens the card.
      const snapshot = browser("snapshot");
      const target = snapshot.split("\n").find((line) => /Explore this section/.test(line));
      assert.ok(target, snapshot);
      browser("click", "@" + target.trim().split(/\s+/)[0].replace(/^uid=/, ""));
      assert.equal(probe().cards, 1);
      probe({ action: "draft" });
      probe({ action: "key", held: true });
      assert.equal(label().label, "Annotate (paused)");
      let state = probe({ action: "click", held: true });
      assert.equal(state.prevented, false);
      assert.equal(state.clicks, 1);
      assert.equal(state.cursor, false);
      assert.equal(state.draft, "Keep this sample draft");
      probe({ action: "key", held: true, repeat: true });
      state = probe({ action: "select", selector: "#text", held: true });
      assert.equal(state.selection, "Select these sample words.");
      assert.equal(state.cards, 1, "selection during bypass does not replace the draft");
      assert.equal(probe({ action: "click", selector: "#check", held: true }).checked, true);

      for (const action of ["drag", "wheel"]) {
        let gesture = probe({ action, held: true });
        assert.notEqual(gesture.viewBox, gesture.before);
        probe({ action: "key", event: "keyup", held: false });
        gesture = probe({ action });
        assert.equal(gesture.viewBox, gesture.before);
        assert.equal(gesture.draft, "Keep this sample draft");
      }

      await evidence("released-diagram-with-draft");

      // Release in the other document, then reverse the direction.
      chromeKey(false, "keyup");
      assert.equal(probe().cursor, true);
      assert.equal(label().pressed, "true");
      chromeKey(true);
      assert.equal(probe().cursor, false);
      probe({ action: "key", held: false, event: "keyup" });
      assert.equal(label().label, "Annotate");
      assert.equal(probe({ action: "click" }).prevented, true);
      probe({ action: "cancel" });
      for (const action of ["blur", "hidden"]) {
        probe({ action: "key", held: true });
        assert.equal(probe().cursor, false);
        probe({ action });
        assert.equal(probe().cursor, true, `${action} retires a lost keyup`);
      }

      // Physical browser keys work inside the sandbox, including native inputs and editables.
      probe({ action: "focus", selector: "#input" });
      browser("press", "Alt");
      const keys = probe().keys.filter((entry) => entry.trusted && entry.key === "Alt");
      assert.ok(keys.some((entry) => entry.type === "keydown" && !entry.cursor && !entry.prevented));
      assert.ok(keys.some((entry) => entry.type === "keyup" && entry.cursor && !entry.prevented));
      browser("type", "sample");
      assert.equal(probe().input, "sample");
      probe({ action: "focus", selector: "#edit" });
      browser("press", "Alt");
      browser("type", "word ");
      assert.match(probe().edit, /word/);
      browser("press", "Control+i");
      assert.equal(label().pressed, "false");
      probe({ action: "key", held: true });
      probe({ action: "key", held: false, event: "keyup" });
      assert.equal(probe({ action: "click" }).prevented, false, "off stays off");
      browser("press", "Control+i");
      assert.equal(label().pressed, "true");

      chromeKey(true);
      evaluate(`() => { document.getElementById('reloadArtifact').click(); return 'ok'; }`);
      browser("wait", "3000");
      assert.equal(label().label, "Annotate");
      assert.equal(probe({ action: "click" }).prevented, true, "reload restores interception");
      assertEnabledSwitchColors();
      console.log(
        "Verified hold/release, repeats, cross-document release, blur/visibility, reload, drafts, controls, selection, trusted keys and click interception.",
      );
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop"], lavishEnv);
      browser("stop");
      await rm(temp, { recursive: true, force: true });
    }
  },
);
