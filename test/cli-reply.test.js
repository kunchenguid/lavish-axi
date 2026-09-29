import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { on, once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WebSocket from "ws";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import { VERSION } from "../src/cli.js";
import { serve } from "../src/server.js";
import { canonicalFile, sessionKey } from "../src/session-store.js";

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
  if (stdin !== undefined) child.stdin.end(stdin);
  else child.stdin.end();
  return new Promise((resolve) => {
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function chromeSessionData(html) {
  const match = String(html).match(/<script id="lavish-session" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(match, "chrome page embeds lavish-session JSON");
  return JSON.parse(match[1]);
}

function cliEnv(stateDir, port) {
  return {
    ...process.env,
    LAVISH_AXI_STATE_DIR: stateDir,
    LAVISH_AXI_PORT: String(port),
    LAVISH_AXI_HOST: "127.0.0.1",
    LAVISH_AXI_LINK_HOST: "127.0.0.1",
    LAVISH_AXI_TELEMETRY: "0",
    LAVISH_AXI_NO_OPEN: "1",
  };
}

/**
 * @param {string} base
 * @param {string} key
 */
async function openLiveEvents(base, key) {
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/events/${key}`, { origin: base });
  const messages = on(socket, "message");
  await once(socket, "open");
  return {
    async nextMatching(predicate, label) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const remaining = Math.max(1, deadline - Date.now());
        const result = await Promise.race([
          messages.next(),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), remaining)),
        ]);
        if (result.done) throw new Error(`${label} stream closed`);
        const message = JSON.parse(String(result.value[0]));
        if (predicate(message)) return message;
      }
      throw new Error(`timed out waiting for ${label}`);
    },
    async close() {
      await messages.return();
      socket.close();
    },
  };
}

/**
 * @param {(ctx: {
 *   dir: string,
 *   stateDir: string,
 *   stateFile: string,
 *   artifact: string,
 *   absolute: string,
 *   env: NodeJS.ProcessEnv,
 *   base: string,
 *   server: { port: number, close: () => Promise<void> },
 *   key: string,
 * }) => Promise<void>} fn
 * @param {{ open?: boolean }} [options]
 */
async function withArtifact(fn, { open = true } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-reply-"));
  const stateDir = path.join(dir, "state");
  await mkdir(stateDir);
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body>ok</body></html>", "utf8");
  const absolute = await canonicalFile(artifact);
  const stateFile = path.join(stateDir, "state.json");
  const server = await serve({
    port: 0,
    host: "127.0.0.1",
    stateFile,
    version: VERSION,
  });
  const env = cliEnv(stateDir, server.port);
  const base = `http://127.0.0.1:${server.port}`;
  try {
    if (open) {
      const opened = await runCli([artifact, "--no-open"], { env });
      assert.equal(opened.status, 0, opened.stderr || opened.stdout);
    }
    await fn({
      dir,
      stateDir,
      stateFile,
      artifact,
      absolute,
      env,
      base,
      server,
      key: sessionKey(absolute),
    });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function queuePrompt(base, key, text) {
  const queued = await fetch(`${base}/api/${key}/prompts`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ prompts: [{ prompt: text, tag: "message" }] }),
  });
  assert.equal(queued.status, 200, await queued.text());
}

test("reply help and top-level help say when to prefer reply over poll --agent-reply", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "lavish-reply-help-"));
  const env = cliEnv(stateDir, 0);
  try {
    const top = await runCli(["--help"], { env });
    assert.equal(top.status, 0, top.stderr || top.stdout);
    assert.match(top.stdout, /lavish-axi reply <html-file> --agent-reply/);
    assert.match(top.stdout, /not about to long-poll/);
    assert.match(top.stdout, /poll <html-file> --agent-reply/);

    const reply = await runCli(["reply", "--help"], { env });
    assert.equal(reply.status, 0, reply.stderr || reply.stdout);
    assert.match(reply.stdout, /--agent-reply "\.\.\."/);
    assert.match(reply.stdout, /--agent-reply-file <path>/);
    assert.match(reply.stdout, /Exit 0 only when the server answers that the reply was sent/);
    assert.match(reply.stdout, /not about to wait for more feedback/);
    assert.match(reply.stdout, /lavish-axi poll <html-file> --agent-reply/);
    assert.match(reply.stdout, /does not exit when the reply is accepted/);

    const poll = await runCli(["poll", "--help"], { env });
    assert.equal(poll.status, 0, poll.stderr || poll.stdout);
    assert.match(poll.stdout, /lavish-axi reply <html-file> --agent-reply/);
    assert.match(poll.stdout, /not about to long-poll/);
    assert.match(poll.stdout, /lavish-axi poll report\.html --agent-reply "Renamed the payment step\."/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("reply exits 0 only after the server accepts, delivers the reply, and clears Working", async () => {
  await withArtifact(async ({ artifact, absolute, env, base, key }) => {
    await queuePrompt(base, key, "change the title");
    const delivered = await runCli(["poll", artifact, "--timeout-ms", "1000"], { env });
    assert.equal(delivered.status, 0, delivered.stderr || delivered.stdout);
    assert.match(delivered.stdout, /status: feedback/);

    const live = await openLiveEvents(base, key);
    try {
      const working = await live.nextMatching(
        (message) => message.type === "agent-presence" && message.data.state === "working",
        "working presence",
      );
      assert.equal(working.data.mode, "agent-busy");

      const replyPromise = runCli(["reply", artifact, "--agent-reply", "Decision recorded."], { env });
      const accepted = await live.nextMatching(
        (message) => message.type === "agent-reply" && message.data.text === "Decision recorded.",
        "agent-reply event",
      );
      assert.match(accepted.data.html, /Decision recorded\./);
      const waiting = await live.nextMatching(
        (message) => message.type === "agent-presence" && message.data.state === "waiting",
        "waiting presence",
      );
      assert.equal(waiting.data.state, "waiting");

      const reply = await replyPromise;
      assert.equal(reply.status, 0, reply.stderr || reply.stdout);
      assert.match(reply.stdout, /status: sent/);
      assert.match(reply.stdout, /no longer showing Working/);
      assert.doesNotMatch(reply.stdout, /status: waiting/);
      assert.ok(reply.stdout.includes(absolute));
    } finally {
      await live.close();
    }

    const chrome = chromeSessionData(await fetch(`${base}/session/${key}`).then((response) => response.text()));
    assert.equal(chrome.initialChat.at(-1).text, "Decision recorded.");
    assert.match(chrome.initialChat.at(-1).html, /<p>Decision recorded\.<\/p>/);

    const fromFile = path.join(path.dirname(artifact), "reply.md");
    const structured = ["## What changed", "", "- kept the heading"].join("\n");
    await writeFile(fromFile, structured, "utf8");
    const filed = await runCli(["reply", artifact, "--agent-reply-file", fromFile], { env });
    assert.equal(filed.status, 0, filed.stderr || filed.stdout);
    assert.match(filed.stdout, /status: sent/);

    const fromStdin = await runCli(["reply", artifact, "--agent-reply-file", "-"], {
      env,
      stdin: "Read from stdin.",
    });
    assert.equal(fromStdin.status, 0, fromStdin.stderr || fromStdin.stdout);
    assert.match(fromStdin.stdout, /status: sent/);

    const after = chromeSessionData(await fetch(`${base}/session/${key}`).then((response) => response.text()));
    const texts = after.initialChat.map((entry) => entry.text);
    assert.ok(texts.includes("Decision recorded."));
    assert.ok(texts.includes(structured));
    assert.ok(texts.includes("Read from stdin."));
    assert.match(after.initialChat.find((entry) => entry.text === structured).html, /What changed/);
  });
});

test("reply refuses a missing session, an unreachable server, and a non-success response", async () => {
  await withArtifact(async ({ artifact, env, stateFile }) => {
    await chmod(stateFile, 0o000);
    try {
      const refused = await runCli(["reply", artifact, "--agent-reply", "should not land"], { env });
      assert.notEqual(refused.status, 0);
      assert.match(refused.stdout, /did not accept the agent reply \(500\)/);
      assert.match(refused.stdout, /SERVER_ERROR/);
      assert.doesNotMatch(refused.stdout, /status: sent/);
    } finally {
      await chmod(stateFile, 0o644);
    }
    const stored = JSON.parse(await readFile(stateFile, "utf8"));
    const chat = Object.values(stored.sessions)[0].chat || [];
    assert.equal(
      chat.some((entry) => entry.text === "should not land"),
      false,
    );
  });

  await withArtifact(
    async ({ artifact, env }) => {
      const missing = await runCli(["reply", artifact, "--agent-reply", "nobody is reviewing"], { env });
      assert.notEqual(missing.status, 0);
      assert.match(missing.stdout, /No active Lavish Editor session for this file/);
      assert.match(missing.stdout, /NOT_FOUND/);
      assert.match(missing.stdout, /lavish-axi/);
      assert.doesNotMatch(missing.stdout, /status: sent/);
    },
    { open: false },
  );

  const holder = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ version: "not-lavish" }));
  });
  await new Promise((resolve) => holder.listen(0, "127.0.0.1", () => resolve()));
  const port = /** @type {import("node:net").AddressInfo} */ (holder.address()).port;
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-reply-down-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body>ok</body></html>", "utf8");
  try {
    const down = await runCli(["reply", artifact, "--agent-reply", "cannot reach"], {
      env: cliEnv(path.join(dir, "state"), port),
    });
    assert.notEqual(down.status, 0);
    assert.match(down.stdout, /occupied by a non-Lavish server|server connection failed|server did not start/);
    assert.match(down.stdout, /SERVER_ERROR/);
    assert.doesNotMatch(down.stdout, /status: sent/);
  } finally {
    await new Promise((resolve, reject) => holder.close((error) => (error ? reject(error) : resolve())));
    await rm(dir, { recursive: true, force: true });
  }
});

test("reply rejects missing, conflicting, empty, and unreadable reply input", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-reply-flags-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body>ok</body></html>", "utf8");
  const env = cliEnv(path.join(dir, "state"), 0);
  try {
    const missing = await runCli(["reply", artifact], { env });
    assert.equal(missing.status, 2, missing.stdout);
    assert.match(missing.stdout, /An agent reply is required/);
    assert.match(missing.stdout, /VALIDATION_ERROR/);

    const conflict = await runCli(
      ["reply", artifact, "--agent-reply", "hi", "--agent-reply-file", path.join(dir, "reply.md")],
      { env },
    );
    assert.equal(conflict.status, 2, conflict.stdout);
    assert.match(conflict.stdout, /cannot be combined/);

    const emptyInline = await runCli(["reply", artifact, "--agent-reply", "   "], { env });
    assert.equal(emptyInline.status, 2, emptyInline.stdout);
    assert.match(emptyInline.stdout, /Agent reply text was empty/);

    const emptyFile = path.join(dir, "empty.md");
    await writeFile(emptyFile, " \n", "utf8");
    const emptyFromFile = await runCli(["reply", artifact, "--agent-reply-file", emptyFile], { env });
    assert.equal(emptyFromFile.status, 2, emptyFromFile.stdout);
    assert.match(emptyFromFile.stdout, /--agent-reply-file was empty/);

    const emptyStdin = await runCli(["reply", artifact, "--agent-reply-file", "-"], { env, stdin: "\n" });
    assert.equal(emptyStdin.status, 2, emptyStdin.stdout);
    assert.match(emptyStdin.stdout, /--agent-reply-file was empty/);

    const unreadable = await runCli(["reply", artifact, "--agent-reply-file", path.join(dir, "missing.md")], { env });
    assert.equal(unreadable.status, 2, unreadable.stdout);
    assert.match(unreadable.stdout, /Cannot read --agent-reply-file/);

    const noFile = await runCli(["reply", "--agent-reply", "hi"], { env });
    assert.equal(noFile.status, 2, noFile.stdout);
    assert.match(noFile.stdout, /HTML file path is required/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("poll --agent-reply still posts inside the poll and does not return a sent receipt", async () => {
  await withArtifact(async ({ artifact, env, base, key }) => {
    const polled = await runCli(["poll", artifact, "--agent-reply", "Still posted by poll.", "--timeout-ms", "200"], {
      env,
    });
    assert.equal(polled.status, 0, polled.stderr || polled.stdout);
    assert.match(polled.stdout, /status: waiting/);
    assert.doesNotMatch(polled.stdout, /status: sent/);

    const chrome = chromeSessionData(await fetch(`${base}/session/${key}`).then((response) => response.text()));
    assert.equal(chrome.initialChat.at(-1).text, "Still posted by poll.");
  });
});
