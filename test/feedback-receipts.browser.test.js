import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { serve } from "../src/server.js";

const exec = promisify(execFile);
const runBrowser = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

async function browserFixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-feedback-browser-"));
  const file = path.join(dir, "artifact.html");
  const stateFile = path.join(dir, "state.json");
  await writeFile(file, "<!doctype html><title>Synthetic feedback</title><main>Review fixture</main>");
  const server = await serve({ port: 0, host: "127.0.0.1", stateFile, env: { LAVISH_AXI_HOST: "127.0.0.1" } });
  const base = `http://127.0.0.1:${server.port}`;
  const env = {
    ...process.env,
    CHROME_DEVTOOLS_AXI_SESSION: `feedback-receipts-${server.port}-${process.pid}`,
    CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(dir, "chrome"),
    CHROME_DEVTOOLS_AXI_AUTO_CONNECT: "0",
    CHROME_DEVTOOLS_AXI_BROWSER_URL: "",
  };
  const chrome = async (...args) => (await exec("chrome-devtools-axi", args, { env, timeout: 60_000 })).stdout;
  t.after(async () => {
    try {
      await chrome("stop");
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  async function evaluate(expression) {
    const output = await chrome("eval", expression);
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
  async function post(route, body) {
    const response = await fetch(base + route, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  const { key } = await post("/api/sessions", { file, noGate: true });
  const url = `${base}/session/${key}?no-gate=1`;
  await chrome("open", url);
  async function waitFor(expression) {
    const result = await evaluate(`async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (${expression}) return true;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      return false;
    }`);
    assert.equal(result, true, expression);
  }
  await waitFor(
    'window.__lavishChromeReady && document.getElementById("artifact").src.includes("artifact_load_token")',
  );
  const poll = (timeout = 0) =>
    fetch(`${base}/api/poll?file=${encodeURIComponent(file)}&timeoutMs=${timeout}`).then((r) => r.json());
  async function send(text) {
    await evaluate(`() => {
      document.getElementById("chatInput").value = ${JSON.stringify(text)};
      document.getElementById("send").click();
      return true;
    }`);
    await waitFor('document.getElementById("annotationPills").children.length === 0');
  }
  async function upload(name, valid = true) {
    await evaluate(`() => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(valid ? imageBase64 : "bm90IGFuIGltYWdl")}), c => c.charCodeAt(0));
      const input = document.getElementById("chatAttachInput");
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], ${JSON.stringify(name)}, {type: "image/png"}));
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", {bubbles: true}));
      return true;
    }`);
    await waitFor(`document.querySelector(".chat-attachment-${valid ? "ready" : "error"}")`);
  }
  const chat = () => evaluate('() => document.getElementById("chatLog").innerText');
  async function reload() {
    await chrome("open", url);
    await waitFor("window.__lavishChromeReady");
  }
  return { dir, file, stateFile, key, base, chrome, evaluate, waitFor, post, poll, send, upload, chat, reload };
}

test(
  "browser keeps working visible while receiving and retires it after scoped completion",
  { skip: !runBrowser, timeout: 180_000 },
  async (t) => {
    const f = await browserFixture(t);
    await f.send("Apply synthetic change");
    const first = await f.poll();
    assert.equal(first.status, "feedback");
    await f.waitFor('document.querySelector(".agent-working")');
    const receiver = f.poll(30_000);
    // Wait until the receiving request is attached; the next send must traverse that real poll.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const duringReceive = await f.chat();
    assert.equal(await f.evaluate('() => document.getElementById("presenceBanner").hidden'), true);
    await f.reload();
    const afterReload = await f.chat();
    await f.send("Another task");
    const second = await receiver;
    assert.equal(second.prompts[0].prompt, "Another task");
    await writeFile(f.file, "<!doctype html><title>Synthetic feedback</title><main>Requested change applied</main>");
    await f.post(`/api/${f.key}/agent-reply`, { text: "Change applied", feedback_id: first.feedback_id });
    const duringSecond = await f.chat();
    await f.post(`/api/${f.key}/agent-reply`, { text: "Second task completed", feedback_id: second.feedback_id });
    await f.waitFor('!document.querySelector(".agent-working")');
    assert.equal(await f.evaluate('() => document.getElementById("presenceBanner").hidden'), false);
    assert.match(duringReceive, /Working\.\.\./);
    assert.match(afterReload, /Working\.\.\./);
    assert.match(duringSecond, /Working\.\.\./);
    assert.match(await f.chat(), /Second task completed/);
  },
);

test(
  "browser attachment receipts survive reload and unavailable bytes; invalid uploads retain text",
  { skip: !runBrowser, timeout: 180_000 },
  async (t) => {
    const f = await browserFixture(t);
    const untrustedName = 'reference.png <img src=x onerror="window.receiptInjected=1">';
    await f.upload(untrustedName);
    await f.send("Text with attachment <b>literal</b>");
    const textReceipt = await f.chat();
    const textWithImage = await f.poll();
    assert.equal(textWithImage.prompts[0].attachments[0].name, untrustedName);
    assert.deepEqual(await readFile(textWithImage.prompts[0].attachments[0].path), Buffer.from(imageBase64, "base64"));
    assert.equal(
      await f.evaluate('() => Boolean(window.receiptInjected || document.querySelector("#chatLog b"))'),
      false,
    );
    await f.waitFor('document.querySelector(".chat-attachment-receipt img")?.naturalWidth > 0');
    await f.upload("only-image.png");
    await f.send("");
    const imageOnly = await f.poll();
    assert.equal(imageOnly.prompts[0].prompt, "");
    assert.equal(imageOnly.prompts[0].attachments[0].name, "only-image.png");
    await f.reload();
    const afterReload = await f.chat();
    assert.equal(await f.evaluate('() => document.querySelectorAll(".bubble.user").length'), 2);
    assert.equal(await f.evaluate('() => document.querySelectorAll(".chat-attachment-receipt").length'), 2);
    await f.upload("invalid.png", false);
    await f.evaluate(
      '() => { document.getElementById("chatInput").value = "Keep this text"; document.getElementById("send").click(); return true; }',
    );
    assert.equal(await f.evaluate('() => document.getElementById("chatInput").value'), "Keep this text");
    await f.evaluate('() => { document.querySelector("[data-chat-attachment-retry]").click(); return true; }');
    await f.waitFor('document.querySelector(".chat-attachment-error")');
    assert.equal(await f.evaluate('() => document.getElementById("chatInput").value'), "Keep this text");
    await f.evaluate('() => { document.querySelector("[data-chat-attachment-remove]").click(); return true; }');
    await f.send("Keep this text");
    assert.equal((await f.poll()).prompts[0].prompt, "Keep this text");
    await f.reload();
    assert.match(await f.chat(), /Keep this text/);
    // Simulate expiration of the confined fixture bytes. History remains a receipt, not a retention guarantee.
    await rm(imageOnly.prompts[0].attachments[0].path);
    assert.equal(
      (await fetch(`${f.base}/api/${f.key}/attachments/${imageOnly.prompts[0].attachments[0].id}`)).status,
      404,
    );
    await f.chrome("stop");
    await rm(path.join(f.dir, "chrome"), { recursive: true, force: true });
    await f.reload();
    const missing = await f.chat();
    assert.match(textReceipt, /reference\.png/);
    assert.match(afterReload, /only-image\.png/);
    assert.match(missing, /only-image\.png/);
    await f.waitFor('document.getElementById("chatLog").innerText.includes("Preview unavailable")');
  },
);
