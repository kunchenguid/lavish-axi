import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { pollHolderResponseDead, serve } from "../src/server.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Capture a real ServerResponse from a real HTTP exchange, because the dead-holder check reads
// node's own response/socket state.
function captureResponse() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      req.resume();
      resolve({
        server,
        res,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = /** @type {import("node:net").AddressInfo} */ (server.address());
      const request = http.get(`http://127.0.0.1:${address.port}`);
      request.on("error", () => {});
    });
  });
}

test("a live poll holder's response is not dead", async () => {
  const { res, close } = await captureResponse();
  try {
    assert.equal(pollHolderResponseDead({ res }), false);
    assert.equal(pollHolderResponseDead(null), false);
    assert.equal(pollHolderResponseDead({ key: "k" }), false, "holders without a res keep the manual takeover path");
  } finally {
    close();
  }
});

test("a poll holder whose socket is destroyed is provably dead", async () => {
  const { res, close } = await captureResponse();
  try {
    res.socket.destroy();
    await delay(10);
    assert.equal(pollHolderResponseDead({ res }), true);
  } finally {
    close();
  }
});

test("a poll holder whose response already ended is provably dead", async () => {
  const { res, close } = await captureResponse();
  try {
    res.end("done");
    assert.equal(res.writableEnded, true);
    assert.equal(pollHolderResponseDead({ res }), true);
  } finally {
    close();
  }
});

// The persistent dead-holder state itself (a registered holder whose close event never arrives)
// is not reachable through the HTTP surface from a test, so the unit tests above carry the
// provably-dead classification; this test pins the user-visible contract around it: once the
// owning socket is gone, the next listener attaches without --takeover.
test("after the owning poll socket dies, the next listener attaches without a takeover", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-poll-own-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const { key } = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    }).then((res) => res.json());
    assert.ok(key);

    const abort = new AbortController();
    const first = fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&owner=worker-a`, {
      signal: abort.signal,
    }).catch(() => {});
    await delay(30);
    const held = await fetch(`${base}/health`).then((res) => res.json());
    assert.deepEqual(
      held.listeners.map((listener) => listener.label),
      ["worker-a"],
    );

    abort.abort();
    await first;
    await delay(30);

    const next = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&owner=worker-b&timeoutMs=0`);
    assert.equal(next.status, 200, "the released ownership does not refuse the next listener");
    assert.equal((await next.json()).status, "waiting");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
