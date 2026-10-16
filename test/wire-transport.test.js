import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import { VERSION } from "../src/cli.js";
import { serve } from "../src/server.js";
import { sessionKey } from "../src/session-store.js";
import {
  decodeFrame,
  encodeFrame,
  formatParams,
  OPCODES,
  parseParams,
  WireChannel,
  WireClient,
  WireFrameError,
} from "../src/wire-transport.js";

const CLI = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, stdin?: string }} [options]
 */
function runCli(args, { cwd = REPO_ROOT, env = process.env, stdin } = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.on("error", (error) => {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EPIPE") throw error;
  });
  if (stdin !== undefined) {
    child.stdin.end(stdin);
  } else {
    child.stdin.end();
  }
  return new Promise((resolve) => {
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

test("encodeFrame and decodeFrame handle RFC-001 framing format", () => {
  const encodedPush = encodeFrame({
    type: OPCODES.PUSH,
    seq: 1,
    channel: "feedback",
    flags: "R",
    payload: JSON.stringify({ prompts: [{ prompt: "hello" }] }),
  });
  assert.equal(encodedPush, 'P:1:feedback:R {"prompts":[{"prompt":"hello"}]}');

  const decodedPush = decodeFrame(encodedPush);
  assert.equal(decodedPush.type, OPCODES.PUSH);
  assert.equal(decodedPush.seq, 1);
  assert.equal(decodedPush.channel, "feedback");
  assert.equal(decodedPush.flags, "R");
  assert.deepEqual(JSON.parse(decodedPush.payload), { prompts: [{ prompt: "hello" }] });

  const encodedAck = encodeFrame({
    type: OPCODES.ACK,
    seq: 42,
    channel: "feedback",
  });
  assert.equal(encodedAck, "A:42:feedback:");

  const decodedAck = decodeFrame(encodedAck);
  assert.equal(decodedAck.type, OPCODES.ACK);
  assert.equal(decodedAck.seq, 42);
  assert.equal(decodedAck.channel, "feedback");
  assert.equal(decodedAck.payload, "");

  const encodedEnd = encodeFrame({
    type: OPCODES.END,
    seq: 0,
    channel: "session",
    payload: JSON.stringify({ ended_by: "user" }),
  });
  assert.equal(encodedEnd, 'E:0:session: {"ended_by":"user"}');

  assert.throws(
    () => decodeFrame("invalid-frame-header"),
    (err) => err instanceof WireFrameError,
  );
  assert.throws(
    () => decodeFrame("X:0:channel:"),
    (err) => err instanceof WireFrameError,
  );
});

test("parseParams and formatParams serialize key-value strings", () => {
  const parsed = parseParams("timeout=5000;last_seen_seq=3;mode=fast");
  assert.deepEqual(parsed, { timeout: "5000", last_seen_seq: "3", mode: "fast" });

  const formatted = formatParams({ timeout: 5000, last_seen_seq: 3, empty: undefined });
  assert.equal(formatted, "timeout=5000;last_seen_seq=3");
});

test("WireChannel maintains monotonic sequence, sliding-window replay, and ACKs", () => {
  const channel = new WireChannel("default", { windowSize: 3 });

  assert.equal(channel.lastSeq, 0);
  assert.equal(channel.lastAcked, 0);

  const f1 = channel.push({ channel: "feedback", flags: "R", payload: "one" });
  assert.equal(f1.seq, 1);
  assert.equal(f1.type, OPCODES.PUSH);

  const f2 = channel.push({ channel: "feedback", flags: "R", payload: "two" });
  assert.equal(f2.seq, 2);

  const f3 = channel.push({ channel: "feedback", flags: "R", payload: "three" });
  assert.equal(f3.seq, 3);

  // Unacked since 0
  const unackedAll = channel.getUnacked(0);
  assert.equal(unackedAll.length, 3);
  assert.equal(unackedAll[0].seq, 1);
  assert.equal(unackedAll[2].seq, 3);

  // Unacked since seq 1
  const unackedSince1 = channel.getUnacked(1);
  assert.equal(unackedSince1.length, 2);
  assert.equal(unackedSince1[0].seq, 2);
  assert.equal(unackedSince1[1].seq, 3);

  // ACK seq 2
  const ackRes = channel.ack(2);
  assert.equal(ackRes, true);
  assert.equal(channel.lastAcked, 2);

  // Unacked since 0 after ack 2 returns only unacked seq > 2
  assert.equal(channel.getUnacked(0).length, 1);
  assert.equal(channel.getUnacked(0)[0].seq, 3);

  // Pushing past windowSize evicts oldest acked frames
  const f4 = channel.push({ channel: "feedback", flags: "R", payload: "four" });
  assert.equal(f4.seq, 4);
});

test("server /wire/:key WebSocket connection, push receipt, sequence ACK, and replay", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-wire-test-"));
  const stateDir = path.join(dir, "state");
  await mkdir(stateDir);
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body>ok</body></html>", "utf8");

  const server = await serve({
    port: 0,
    host: "127.0.0.1",
    stateFile: path.join(stateDir, "state.json"),
    version: VERSION,
  });

  try {
    const base = `http://127.0.0.1:${server.port}`;
    const wsBase = `ws://127.0.0.1:${server.port}`;
    const opened = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact, noGate: true }),
    }).then((res) => res.json());

    const key = opened.key || sessionKey(artifact);

    // 1. Connect WebSocket to /wire/:key
    const ws = new WebSocket(`${wsBase}/wire/${key}`);
    /** @type {string[]} */
    const receivedFrames = [];
    ws.on("message", (data) => {
      receivedFrames.push(String(data));
    });

    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    // 2. Post a prompt via /api/:key/prompts
    const promptRes = await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ prompts: [{ prompt: "First wire test prompt", tag: "message" }] }),
    });
    assert.equal(promptRes.status, 200);

    // Wait for frame to arrive over WebSocket
    const deadline = Date.now() + 3000;
    while (receivedFrames.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(receivedFrames.length >= 1, "Expected frame over wire WebSocket");
    const frame1 = decodeFrame(receivedFrames[0]);
    assert.equal(frame1.type, OPCODES.PUSH);
    assert.equal(frame1.seq, 1);
    assert.equal(frame1.channel, "feedback");
    assert.equal(frame1.flags, "R");
    const payload1 = JSON.parse(frame1.payload);
    assert.equal(payload1.prompts[0].prompt, "First wire test prompt");

    // 3. ACK the frame
    ws.send(encodeFrame({ type: OPCODES.ACK, seq: 1, channel: "feedback" }));

    // 4. Send 2nd prompt
    const promptRes2 = await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ prompts: [{ prompt: "Second wire test prompt", tag: "message" }] }),
    });
    assert.equal(promptRes2.status, 200);

    while (receivedFrames.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(receivedFrames.length >= 2, "Expected second frame over wire");
    const frame2 = decodeFrame(receivedFrames[1]);
    assert.equal(frame2.seq, 2);

    // 5. Close socket without acking frame 2
    ws.close();
    await new Promise((r) => setTimeout(r, 50));

    // 6. Reconnect with last_seen_seq=1, expect frame 2 replayed
    const ws2 = new WebSocket(`${wsBase}/wire/${key}?last_seen_seq=1`);
    /** @type {string[]} */
    const replayedFrames = [];
    ws2.on("message", (data) => {
      replayedFrames.push(String(data));
    });
    await new Promise((resolve, reject) => {
      ws2.once("open", resolve);
      ws2.once("error", reject);
    });

    const deadline2 = Date.now() + 3000;
    while (replayedFrames.length === 0 && Date.now() < deadline2) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(replayedFrames.length >= 1, "Expected replay of unacked frame 2");
    const replayed = decodeFrame(replayedFrames[0]);
    assert.equal(replayed.seq, 2);
    assert.equal(JSON.parse(replayed.payload).prompts[0].prompt, "Second wire test prompt");

    // 7. Test inbound agent reply frame over wire socket
    ws2.send(
      encodeFrame({
        type: OPCODES.PUSH,
        seq: 0,
        channel: "agent-reply",
        payload: "Implemented button color fix",
      }),
    );

    // Give server a moment to record agent reply in chat
    await new Promise((r) => setTimeout(r, 100));
    const storedState = JSON.parse(await readFile(path.join(stateDir, "state.json"), "utf8"));
    const chat = storedState.sessions[key].chat;
    const lastChat = chat.at(-1);
    assert.equal(lastChat.role, "agent");
    assert.equal(lastChat.text, "Implemented button color fix");

    ws2.close();
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("WireClient helper connects, waits for feedback, ACKs, and sends replies", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-wire-client-test-"));
  const stateDir = path.join(dir, "state");
  await mkdir(stateDir);
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body>ok</body></html>", "utf8");

  const server = await serve({
    port: 0,
    host: "127.0.0.1",
    stateFile: path.join(stateDir, "state.json"),
    version: VERSION,
  });

  try {
    const base = `http://127.0.0.1:${server.port}`;
    const opened = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact, noGate: true }),
    }).then((res) => res.json());

    const client = new WireClient({
      serverUrl: base,
      sessionKey: opened.key,
      timeoutMs: 3000,
    });

    const connected = await client.connect();
    assert.equal(connected, true);

    // Queue prompt
    await fetch(`${base}/api/${opened.key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ prompts: [{ prompt: "Test client feedback", tag: "message" }] }),
    });

    const feedback = await client.waitForFeedback();
    assert.ok(feedback);
    assert.equal(feedback.status, "feedback");
    assert.equal(feedback.prompts[0].prompt, "Test client feedback");
    assert.equal(feedback.seq, 1);

    // Send reply
    await client.sendReply("Reply from WireClient");
    await new Promise((r) => setTimeout(r, 100));

    const storedState = JSON.parse(await readFile(path.join(stateDir, "state.json"), "utf8"));
    const lastChat = storedState.sessions[opened.key].chat.at(-1);
    assert.equal(lastChat.role, "agent");
    assert.equal(lastChat.text, "Reply from WireClient");

    client.close();
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI wait command executes atomic turn with wire transport and terse next_step", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-wait-cli-"));
  const stateDir = path.join(dir, "state");
  await mkdir(stateDir);
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body>ok</body></html>", "utf8");

  const server = await serve({
    port: 0,
    host: "127.0.0.1",
    stateFile: path.join(stateDir, "state.json"),
    version: VERSION,
  });

  const env = {
    ...process.env,
    LAVISH_AXI_STATE_DIR: stateDir,
    LAVISH_AXI_PORT: String(server.port),
    LAVISH_AXI_HOST: "127.0.0.1",
    LAVISH_AXI_LINK_HOST: "127.0.0.1",
    LAVISH_AXI_TELEMETRY: "0",
    LAVISH_AXI_NO_OPEN: "1",
  };

  try {
    const base = `http://127.0.0.1:${server.port}`;
    const opened = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact, noGate: true }),
    }).then((res) => res.json());

    const key = opened.key || sessionKey(artifact);

    // Post prompt so wait resolves immediately
    await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ prompts: [{ prompt: "Atomic wait prompt", tag: "message" }] }),
    });

    const result = await runCli(["wait", artifact, "--reply", "Done with changes", "--timeout-ms", "3000"], {
      env,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    assert.match(result.stdout, /status:\s*feedback/);
    assert.match(result.stdout, /Atomic wait prompt/);
    assert.match(result.stdout, /seq:\s*1/);
    // Terse next_step by default
    assert.match(result.stdout, /Apply the requested changes to/);
    assert.doesNotMatch(result.stdout, /Only when a longer reply is genuinely necessary/);

    // Check agent reply was recorded
    const storedState = JSON.parse(await readFile(path.join(stateDir, "state.json"), "utf8"));
    const lastChat = storedState.sessions[key].chat.at(-1);
    assert.equal(lastChat.text, "Done with changes");

    // Test with --verbose-instructions
    await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ prompts: [{ prompt: "Second verbose prompt", tag: "message" }] }),
    });

    const verboseResult = await runCli(
      ["wait", artifact, "--reply", "Second reply", "--verbose-instructions", "--timeout-ms", "3000"],
      { env },
    );
    assert.equal(verboseResult.status, 0, verboseResult.stderr || verboseResult.stdout);
    assert.match(verboseResult.stdout, /Only when a longer reply is genuinely necessary/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI poll falls back cleanly to HTTP long-polling when WebSocket is refused", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-poll-fallback-"));
  const stateDir = path.join(dir, "state");
  await mkdir(stateDir);
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body>ok</body></html>", "utf8");

  process.env.LAVISH_AXI_DISABLE_WIRE = "1";
  const server = await serve({
    port: 0,
    host: "127.0.0.1",
    stateFile: path.join(stateDir, "state.json"),
    version: VERSION,
  });

  const env = {
    ...process.env,
    LAVISH_AXI_STATE_DIR: stateDir,
    LAVISH_AXI_PORT: String(server.port),
    LAVISH_AXI_HOST: "127.0.0.1",
    LAVISH_AXI_LINK_HOST: "127.0.0.1",
    LAVISH_AXI_TELEMETRY: "0",
    LAVISH_AXI_NO_OPEN: "1",
    LAVISH_AXI_DISABLE_WIRE: "1",
  };

  try {
    const base = `http://127.0.0.1:${server.port}`;
    const opened = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact, noGate: true }),
    }).then((res) => res.json());

    const key = opened.key || sessionKey(artifact);

    // Queue prompt
    await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ prompts: [{ prompt: "Fallback test prompt", tag: "message" }] }),
    });

    // Poll command with --verbose-instructions
    const result = await runCli(["poll", artifact, "--verbose-instructions", "--timeout-ms", "3000"], { env });
    assert.match(result.stdout, /status:\s*feedback/);
    assert.match(result.stdout, /Fallback test prompt/);
  } finally {
    delete process.env.LAVISH_AXI_DISABLE_WIRE;
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI poll uses wire transport when WebSocket is available", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-poll-wire-"));
  const stateDir = path.join(dir, "state");
  await mkdir(stateDir);
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body>ok</body></html>", "utf8");

  const server = await serve({
    port: 0,
    host: "127.0.0.1",
    stateFile: path.join(stateDir, "state.json"),
    version: VERSION,
  });

  const env = {
    ...process.env,
    LAVISH_AXI_STATE_DIR: stateDir,
    LAVISH_AXI_PORT: String(server.port),
    LAVISH_AXI_HOST: "127.0.0.1",
    LAVISH_AXI_LINK_HOST: "127.0.0.1",
    LAVISH_AXI_TELEMETRY: "0",
    LAVISH_AXI_NO_OPEN: "1",
  };

  try {
    const base = `http://127.0.0.1:${server.port}`;
    const opened = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact, noGate: true }),
    }).then((res) => res.json());

    const key = opened.key || sessionKey(artifact);

    // Queue prompt
    await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ prompts: [{ prompt: "Wire poll prompt", tag: "message" }] }),
    });

    const result = await runCli(["poll", artifact, "--timeout-ms", "3000"], { env });
    assert.match(result.stdout, /status:\s*feedback/);
    assert.match(result.stdout, /Wire poll prompt/);
    assert.match(result.stdout, /seq:\s*1/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
