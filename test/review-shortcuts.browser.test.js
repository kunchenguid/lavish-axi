import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const enabled = process.env.LAVISH_AXI_BROWSER_E2E === "1";

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 45000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command}: ${result.stdout}\n${result.stderr}`);
  return result.stdout || "";
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port allocated");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

test(
  "review shortcuts create persistent text markers and done states in a real browser",
  { skip: !enabled, timeout: 180000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-review-shortcuts-"));
    const port = await freePort();
    const bridgePort = await freePort();
    const env = {
      LAVISH_AXI_PORT: String(port),
      LAVISH_AXI_STATE_DIR: path.join(temp, "state"),
      LAVISH_AXI_NO_OPEN: "1",
      LAVISH_AXI_TELEMETRY: "0",
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
    };
    const browser = {
      CHROME_DEVTOOLS_AXI_OWNER_ID: `lavish-review-${process.pid}`,
      CHROME_DEVTOOLS_AXI_PORT: String(bridgePort),
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-review-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };
    const file = path.join(temp, "review.html");
    await writeFile(
      file,
      `<!doctype html><html><body><section id="box" style="padding:24px;border:1px solid"><div class="l1"><div class="l2"><div class="l3"><div class="l4"><div class="l5"><div class="l6"><p id="text">A precise selection for review and another phrase.</p></div></div></div></div></div></div></section><script>
    window.addEventListener('message', e => {
      if (e.source !== parent || e.data.type !== 'test-review') return;
      const box = document.querySelector('#box');
      const p = document.querySelector('#text');
      const root = document.querySelector('[data-lavish-ui="annotation-root"]')?.shadowRoot;
      if (e.data.action === 'select') {
        const range = document.createRange(); range.setStart(p.firstChild, 2); range.setEnd(p.firstChild, 19);
        getSelection().removeAllRanges(); getSelection().addRange(range);
        p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      }
      if (e.data.action === 'key') {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: e.data.key, shiftKey: Boolean(e.data.shiftKey), bubbles: true, cancelable: true }));
      }
      if (e.data.action === 'click-mark') {
        const markEl = root?.querySelector('.lavish-persistent-mark');
        const r = markEl ? markEl.getBoundingClientRect() : p.getBoundingClientRect();
        p.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + 8 }));
      }
      if (e.data.action === 'click-add-comment') {
        root?.querySelector('.lavish-mark-add-comment,.lavish-mark-badge')?.click();
      }
      if (e.data.action === 'submit-card') {
        const ta = root?.querySelector('.lavish-annotation-card textarea');
        const sendBtn = root?.querySelector('.lavish-send');
        if (ta) {
          ta.value = e.data.key || 'Kommentar zur Markierung';
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          sendBtn?.click();
        }
      }
      if (e.data.action === 'pointer') p.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 40, clientY: 40 }));
      if (e.data.action === 'cancel-card') {
        root?.querySelector('.lavish-cancel')?.click();
      }
      setTimeout(() => {
        const currentRoot = document.querySelector('[data-lavish-ui="annotation-root"]')?.shadowRoot;
        const cardTextarea = currentRoot?.querySelector('.lavish-annotation-card textarea');
        parent.postMessage({
          type: 'test-review-result',
          selected: String(getSelection()),
          done: p.getAttribute('data-lavish-done'),
          boxDone: box.getAttribute('data-lavish-done'),
          hasCard: Boolean(cardTextarea),
          cardValue: cardTextarea ? cardTextarea.value : null,
          cardFocused: Boolean(cardTextarea && currentRoot?.activeElement === cardTextarea),
          markCount: currentRoot ? currentRoot.querySelectorAll('.lavish-persistent-mark').length : 0,
          selectedMarkCount: currentRoot ? currentRoot.querySelectorAll('.lavish-persistent-mark.is-selected').length : 0,
          commentedMarkCount: currentRoot ? currentRoot.querySelectorAll('.lavish-persistent-mark.is-commented').length : 0,
        }, '*');
      }, 80);
    });
  </script></body></html>`,
    );
    function evaluate(expression) {
      const output = run("chrome-devtools-axi", ["eval", expression], browser);
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
    function command(action, key = "", shiftKey = false) {
      return evaluate(
        `() => new Promise(resolve => { const frame = document.getElementById('artifact'); function receive(e) { if (e.source !== frame.contentWindow || e.data.type !== 'test-review-result') return; window.removeEventListener('message', receive); resolve(JSON.stringify(e.data)); } window.addEventListener('message', receive); frame.contentWindow.postMessage({type:'test-review', action:${JSON.stringify(action)}, key:${JSON.stringify(key)}, shiftKey:${JSON.stringify(shiftKey)}}, '*'); })`,
      );
    }
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    try {
      const output = run(process.execPath, ["bin/lavish-axi.js", file, "--no-open"], env);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);
      run("chrome-devtools-axi", ["newpage", url], browser);
      await sleep(3200);
      assert.equal(command("select").selected, "precise selection");
      const afterM = command("key", "m");
      assert.equal(afterM.selected, "");
      await sleep(300);
      const afterM2 = command("select");
      assert.equal(afterM2.markCount, 1);
      // Pressing M again on the same range must NOT stack a second marker.
      const afterDuplicateM = command("key", "m");
      await sleep(200);
      assert.equal(afterDuplicateM.markCount, 1);

      // Pressing C without an active blue selection comments on the selected mark.
      const afterCOnMark = command("key", "c");
      assert.equal(afterCOnMark.hasCard, true);
      assert.equal(afterCOnMark.cardValue, "");
      assert.equal(afterCOnMark.cardFocused, true);
      command("cancel-card");

      // Clicking the + comment overlay button also opens the comment box and submitting converts the mark in-place.
      const afterOverlayClick = command("click-add-comment");
      assert.equal(afterOverlayClick.hasCard, true);
      command("submit-card", "Direkter Kommentar");
      await sleep(250);
      const afterCommentSubmit = command("click-mark");
      assert.equal(afterCommentSubmit.markCount, 1);
      assert.equal(afterCommentSubmit.commentedMarkCount, 1);
      assert.equal(afterCommentSubmit.selectedMarkCount, 1);

      // Pressing Delete removes the clicked marker immediately.
      const afterDelete = command("key", "Delete");
      assert.equal(afterDelete.markCount, 0);

      // Selecting text and pressing C directly opens the comment card.
      assert.equal(command("select").selected, "precise selection");
      const afterC = command("key", "c");
      assert.equal(afterC.hasCard, true);
      assert.equal(afterC.cardValue, "");
      assert.equal(afterC.cardFocused, true);
      command("cancel-card");

      command("pointer");
      assert.equal(command("key", "d").done, "true");
      const afterShiftD = command("key", "D", true);
      assert.equal(afterShiftD.done, null);
      assert.equal(afterShiftD.boxDone, "true");
      const afterShiftDToggleOff = command("key", "D", true);
      assert.equal(afterShiftDToggleOff.boxDone, null);
      const afterShiftDToggleOn = command("key", "D", true);
      assert.equal(afterShiftDToggleOn.boxDone, "true");
      await sleep(300);
      const done = evaluate(
        `() => JSON.stringify(Object.fromEntries(Object.entries(sessionStorage).filter(([key]) => key.startsWith('lavish-axi:done-boxes:'))))`,
      );
      assert.equal(Object.keys(done).length, 1);
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], env);
      run("chrome-devtools-axi", ["stop"], browser);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
