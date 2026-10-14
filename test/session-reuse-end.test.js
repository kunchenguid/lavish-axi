import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WebSocket from "ws";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import { parseEndTarget, VERSION } from "../src/cli.js";
import { serve } from "../src/server.js";
import { canonicalFile, sessionKey } from "../src/session-store.js";

const CLI = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** @param {string[]} args @param {NodeJS.ProcessEnv} env */
function runCli(args, env) {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })));
}

async function withServer(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-reuse-end-"));
  const stateDir = path.join(dir, "state");
  await mkdir(stateDir);
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body>ok</body></html>", "utf8");
  const absolute = await canonicalFile(artifact);
  const stateFile = path.join(stateDir, "state.json");
  const server = await serve({ port: 0, host: "127.0.0.1", stateFile, version: VERSION });
  const base = `http://127.0.0.1:${server.port}`;
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
    await fn({ dir, artifact, absolute, stateFile, server, base, env, key: sessionKey(absolute) });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const postSessions = (base, body) =>
  fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((response) => response.json());

const postEnd = (base, body) =>
  fetch(`${base}/api/end`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function connectBrowser(base, key) {
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/events/${key}`, { origin: base });
  await once(socket, "open");
  return socket;
}

async function closeBrowser(socket) {
  const closed = once(socket, "close");
  socket.close();
  await closed;
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("POST /api/sessions reports browser_connected only for an open session with a live review browser", async () => {
  await withServer(async ({ absolute, base, key }) => {
    const first = await postSessions(base, { file: absolute });
    assert.equal(first.browser_connected, false, "first publish has no browser yet");

    const second = await postSessions(base, { file: absolute });
    assert.equal(second.browser_connected, false, "an open session with no attached browser still opens one");

    const socket = await connectBrowser(base, key);
    try {
      await waitFor(
        async () => (await postSessions(base, { file: absolute })).browser_connected === true,
        "the live events connection to register",
      );
    } finally {
      await closeBrowser(socket);
    }
    await waitFor(
      async () => (await postSessions(base, { file: absolute })).browser_connected === false,
      "the closed browser to be forgotten",
    );
  });
});

test("a connected browser on another session does not suppress the open", async () => {
  await withServer(async ({ dir, absolute, base, key }) => {
    const other = path.join(dir, "other.html");
    await writeFile(other, "<!doctype html><html><body>other</body></html>", "utf8");
    const otherAbsolute = await canonicalFile(other);
    await postSessions(base, { file: absolute });
    await postSessions(base, { file: otherAbsolute });
    const socket = await connectBrowser(base, sessionKey(otherAbsolute));
    try {
      await waitFor(
        async () => (await postSessions(base, { file: otherAbsolute })).browser_connected === true,
        "the other session's browser to register",
      );
      assert.equal((await postSessions(base, { file: absolute })).browser_connected, false);
      assert.notEqual(key, sessionKey(otherAbsolute));
    } finally {
      await closeBrowser(socket);
    }
  });
});

test("reopening an ended session reports browser_connected false so a fresh tab opens", async () => {
  await withServer(async ({ absolute, base, key }) => {
    await postSessions(base, { file: absolute });
    const socket = await connectBrowser(base, key);
    try {
      await waitFor(
        async () => (await postSessions(base, { file: absolute })).browser_connected === true,
        "the live events connection to register",
      );
      assert.equal((await postEnd(base, { file: absolute })).status, 200);
      const reopened = await postSessions(base, { file: absolute });
      assert.equal(reopened.status, "opened");
      assert.equal(reopened.browser_connected, false);
    } finally {
      await closeBrowser(socket);
    }
  });
});

test("POST /api/end accepts a session key and marks the end agent-initiated", async () => {
  await withServer(async ({ absolute, base, key, stateFile }) => {
    await postSessions(base, { file: absolute });
    const ended = await postEnd(base, { key });
    assert.equal(ended.status, 200);
    const body = await ended.json();
    assert.equal(body.status, "ended");
    assert.equal(body.key, key);
    assert.equal(body.file, absolute);
    const session = JSON.parse(await readFile(stateFile, "utf8")).sessions[key];
    assert.equal(session.status, "ended");
    assert.equal(session.ended_by, "agent");
  });
});

test("POST /api/end by key ends a session whose HTML file was deleted", async () => {
  await withServer(async ({ absolute, artifact, base, key, stateFile }) => {
    await postSessions(base, { file: absolute });
    await rm(artifact);
    const byFile = await postEnd(base, { file: absolute });
    assert.notEqual(byFile.status, 200, "the file-based form cannot resolve a deleted file");
    const ended = await postEnd(base, { key });
    assert.equal(ended.status, 200);
    const session = JSON.parse(await readFile(stateFile, "utf8")).sessions[key];
    assert.equal(session.status, "ended");
    assert.equal(session.ended_by, "agent");
  });
});

test("POST /api/end by key refuses malformed and unknown keys without touching state", async () => {
  await withServer(async ({ absolute, base, key, stateFile }) => {
    await postSessions(base, { file: absolute });
    for (const bad of ["", "../state", "ZZZZZZZZZZZZZZZZ", "abc", 7, null]) {
      const response = await postEnd(base, { key: bad });
      assert.equal(response.status, 400, `key ${JSON.stringify(bad)}`);
    }
    const unknown = await postEnd(base, { key: "0123456789abcdef" });
    assert.equal(unknown.status, 404);
    const session = JSON.parse(await readFile(stateFile, "utf8")).sessions[key];
    assert.equal(session.status, "open");
    assert.equal(Object.keys(JSON.parse(await readFile(stateFile, "utf8")).sessions).length, 1);
  });
});

test("an agent end by key does not downgrade a user-initiated end", async () => {
  await withServer(async ({ dir, absolute, base, key, stateFile }) => {
    await postSessions(base, { file: absolute });
    // A second open session keeps the server alive after the first one ends.
    const other = path.join(dir, "keepalive.html");
    await writeFile(other, "<!doctype html><html><body>keepalive</body></html>", "utf8");
    await postSessions(base, { file: other });
    const userEnd = await fetch(`${base}/api/${key}/end`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: "{}",
    });
    assert.equal(userEnd.status, 200);
    assert.equal((await postEnd(base, { key })).status, 200);
    const session = JSON.parse(await readFile(stateFile, "utf8")).sessions[key];
    assert.equal(session.ended_by, "user");
  });
});

test("parseEndTarget resolves a session URL, a bare key, and a file path", async () => {
  assert.deepEqual(await parseEndTarget("http://127.0.0.1:4387/session/0123456789abcdef"), {
    key: "0123456789abcdef",
  });
  assert.deepEqual(await parseEndTarget("http://127.0.0.1:4387/session/0123456789abcdef?nogate=1"), {
    key: "0123456789abcdef",
  });
  assert.deepEqual(await parseEndTarget("https://example.test:9/session/0123456789ABCDEF/"), {
    key: "0123456789abcdef",
  });
  assert.deepEqual(await parseEndTarget("0123456789abcdef"), { key: "0123456789abcdef" });
  assert.deepEqual(await parseEndTarget("/tmp/report.html"), { file: "/tmp/report.html" });
  assert.deepEqual(await parseEndTarget("http://127.0.0.1:4387/session/short"), {
    file: "http://127.0.0.1:4387/session/short",
  });
});

test("parseEndTarget treats an existing file named like a key as a path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-end-target-"));
  const previous = process.cwd();
  try {
    await writeFile(path.join(dir, "0123456789abcdef"), "x", "utf8");
    process.chdir(dir);
    assert.deepEqual(await parseEndTarget("0123456789abcdef"), { file: "0123456789abcdef" });
  } finally {
    process.chdir(previous);
    await rm(dir, { recursive: true, force: true });
  }
});

test("lavish-axi end accepts a session key or URL after the HTML file was deleted", async () => {
  for (const asUrl of [false, true]) {
    await withServer(async ({ absolute, artifact, base, env, key, stateFile }) => {
      const opened = await runCli([artifact, "--no-open"], env);
      assert.equal(opened.status, 0, opened.stderr || opened.stdout);
      await rm(artifact);
      const target = asUrl ? `${base}/session/${key}` : key;
      const ended = await runCli(["end", target], env);
      assert.equal(ended.status, 0, ended.stderr || ended.stdout);
      assert.match(ended.stdout, /status: ended/);
      assert.ok(ended.stdout.includes(key));
      assert.ok(ended.stdout.includes(absolute));
      const session = JSON.parse(await readFile(stateFile, "utf8")).sessions[key];
      assert.equal(session.status, "ended");
      assert.equal(session.ended_by, "agent");
    });
  }
});

test("lavish-axi end with an unknown key fails clearly and a file path still works", async () => {
  await withServer(async ({ artifact, env, key, stateFile }) => {
    const opened = await runCli([artifact, "--no-open"], env);
    assert.equal(opened.status, 0, opened.stderr || opened.stdout);
    const unknown = await runCli(["end", "0123456789abcdef"], env);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stdout, /NOT_FOUND/);
    const byPath = await runCli(["end", artifact], env);
    assert.equal(byPath.status, 0, byPath.stderr || byPath.stdout);
    assert.equal(JSON.parse(await readFile(stateFile, "utf8")).sessions[key].status, "ended");
  });
});
