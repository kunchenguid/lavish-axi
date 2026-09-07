import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import WebSocket from "ws";
import { serve } from "../src/server.js";
import { VERSION } from "../src/cli.js";

const exec = promisify(execFile);
const cliEntry = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-feedback-"));
  const file = path.join(dir, "artifact.html");
  const stateFile = path.join(dir, "state.json");
  await writeFile(file, "<!doctype html><title>Synthetic review</title><main>Review fixture</main>");
  const server = await serve({
    port: 0,
    host: "127.0.0.1",
    stateFile,
    version: VERSION,
    env: { LAVISH_AXI_HOST: "127.0.0.1" },
  });
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.port}`;
  async function post(route, body) {
    const response = await fetch(base + route, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  const { key } = await post("/api/sessions", { file });
  const poll = (timeout = 0, signal = undefined) =>
    fetch(`${base}/api/poll?file=${encodeURIComponent(file)}&timeoutMs=${timeout}`, { signal }).then((r) => r.json());
  const send = (text) => post(`/api/${key}/prompts`, { prompts: [{ tag: "message", prompt: text }] });
  async function presence() {
    const socket = new WebSocket(`${base.replace("http:", "ws:")}/events/${key}`, { origin: base });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.terminate();
        reject(new Error("presence snapshot timed out"));
      }, 2000);
      socket.on("error", reject);
      socket.on("message", (raw) => {
        const event = JSON.parse(String(raw));
        if (event.type !== "agent-presence") return;
        clearTimeout(timeout);
        socket.close();
        resolve(event.data);
      });
    });
  }
  const cli = (...args) =>
    exec(process.execPath, [cliEntry, "poll", file, "--timeout-ms", "1", ...args], {
      env: {
        ...process.env,
        LAVISH_AXI_PORT: new URL(base).port,
        LAVISH_AXI_HOST: "127.0.0.1",
        LAVISH_AXI_LINK_HOST: "127.0.0.1",
        LAVISH_AXI_STATE_DIR: path.dirname(stateFile),
        LAVISH_AXI_TELEMETRY: "0",
        LAVISH_AXI_NO_OPEN: "1",
      },
      timeout: 10_000,
    });
  return { base, key, file, stateFile, post, poll, send, presence, cli };
}

test("public CLI carries the completion identity through a reply while another receiver stays attached", async (t) => {
  const f = await fixture(t);
  await f.send("CLI task");
  const delivered = await f.cli();
  const feedbackId = delivered.stdout.match(/feedback_id:\s*"?([0-9a-f-]+)/)?.[1];
  assert.ok(feedbackId, delivered.stdout);
  assert.ok(delivered.stdout.includes(`--feedback-id ${feedbackId}`));
  const controller = new AbortController();
  const receiving = f.poll(10_000, controller.signal).catch((error) => {
    if (error.name !== "AbortError") throw error;
  });
  try {
    const deadline = Date.now() + 2000;
    while (!(await f.presence()).receiving && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(await f.presence(), { state: "working", receiving: true });
    await f.cli("--agent-reply", "Could not complete the requested change", "--feedback-id", feedbackId);
    assert.deepEqual(await f.presence(), { state: "listening", receiving: true });
    const state = JSON.parse(await readFile(f.stateFile, "utf8"));
    assert.equal(state.sessions[f.key].chat.at(-1).text, "Could not complete the requested change");
  } finally {
    controller.abort();
    await receiving;
  }
});

test("public CLI rejects an equals-form feedback id without an agent reply", async (t) => {
  const f = await fixture(t);

  await assert.rejects(
    () => f.cli("--feedback-id=unfinished-batch"),
    (error) => {
      assert.match(`${error.stdout}${error.stderr}`, /--feedback-id requires a batch id and --agent-reply/);
      return true;
    },
  );
});

test("receiving another poll does not conclude delivered work, including reconnect", async (t) => {
  const f = await fixture(t);
  await f.send("First task");
  assert.equal((await f.poll()).status, "feedback");
  assert.equal((await f.presence()).state, "working");
  assert.equal((await f.poll(1)).status, "waiting");
  assert.equal((await f.presence()).state, "working", "a receiving poll is not completion");
});

test("scoped replies conclude only their delivered batch, including late duplicate completion", async (t) => {
  const f = await fixture(t);
  await f.send("First task");
  const first = await f.poll();
  assert.equal(typeof first.feedback_id, "string");
  const receiver = f.poll(1000);
  await f.send("Second task while working");
  const second = await receiver;
  assert.equal(second.status, "feedback");
  assert.notEqual(first.feedback_id, second.feedback_id);
  await f.post(`/api/${f.key}/agent-reply`, { text: "First task completed", feedback_id: first.feedback_id });
  assert.equal((await f.presence()).state, "working");
  await f.post(`/api/${f.key}/agent-reply`, { text: "Late first reply", feedback_id: first.feedback_id });
  assert.equal((await f.presence()).state, "working");
  await f.post(`/api/${f.key}/agent-reply`, { text: "Progress without completion" });
  assert.equal((await f.presence()).state, "working", "unscoped replies cannot guess which work finished");
  await f.post(`/api/${f.key}/agent-reply`, { text: "Second task cancelled", feedback_id: second.feedback_id });
  assert.equal((await f.presence()).state, "waiting");
});

test("accepted attachment-only and annotated messages have sanitized durable receipts", async (t) => {
  const f = await fixture(t);
  const upload = await fetch(`${f.base}/api/${f.key}/attachments`, {
    method: "POST",
    headers: { "content-type": "image/png", origin: f.base },
    body: png,
  });
  assert.equal(upload.status, 200);
  const { attachment } = await upload.json();
  assert.ok(attachment.id);
  await f.post(`/api/${f.key}/prompts`, {
    prompts: [
      { tag: "message", prompt: "Plain text" },
      { tag: "message", prompt: "", attachments: [{ id: attachment.id, name: "reference.png", path: "/untrusted" }] },
      { tag: "div", prompt: "Annotated reference", attachments: [{ id: attachment.id, name: "detail.png" }] },
    ],
  });
  await f.poll();
  const state = JSON.parse(await readFile(f.stateFile, "utf8"));
  const chat = state.sessions[f.key].chat;
  assert.equal(chat.length, 3);
  assert.equal(chat[0].text, "Plain text");
  assert.equal(chat[1].text, "");
  assert.equal(chat[1].attachments[0].name, "reference.png");
  assert.equal(chat[1].attachments[0].mime, "image/png");
  assert.equal(chat[1].attachments[0].path, undefined);
  assert.equal(chat[2].attachments[0].name, "detail.png");
  const html = await fetch(`${f.base}/session/${f.key}`).then((r) => r.text());
  const bootstrap = JSON.parse(
    html.match(/<script id="lavish-session" type="application\/json">([\s\S]*?)<\/script>/)[1],
  );
  assert.deepEqual(bootstrap.initialChat, chat);
});
