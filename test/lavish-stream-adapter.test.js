// @ts-nocheck
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { VERSION } from "../src/cli.js";
import {
  createCapabilitiesOutput,
  initHomeCapability,
  readHomeCapabilityFile,
  resolveStreamBounds,
} from "../src/lavish-stream-adapter.js";
import { serve } from "../src/server.js";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-adapt-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function start(dir) {
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: VERSION,
    idleTimeoutMs: null,
    host: "127.0.0.1",
    linkHost: "127.0.0.1",
    eventStreamBounds: resolveStreamBounds({
      LAVISH_AXI_EVENT_MAX_UNACKED_REVIEW: "256",
    }),
  });
  return { server, base: `http://127.0.0.1:${server.port}` };
}

function auth(id) {
  return { authorization: `Bearer ${id}`, "content-type": "application/json" };
}

test("capabilities expose event_stream and Lavish is only a consumer label", () => {
  const caps = createCapabilitiesOutput({ version: "0.2.0-test" });
  assert.equal(caps.protocol.event_stream.version, 1);
  assert.equal(caps.lavish_version, "0.2.0-test");
});

test("Lavish adapter: claim adopts pre-claim prompts; Send&End order; claimed poll exclusive", async () => {
  await withTemp(async (dir) => {
    const { server, base } = await start(dir);
    try {
      const homeRoot = path.join(dir, "home");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(homeRoot, { recursive: true });
      const minted = await initHomeCapability({ root: homeRoot });
      const home = await readHomeCapabilityFile(minted.file);

      const file = path.join(dir, "a.html");
      await writeFile(file, "<h1>A</h1>");
      const opened = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file }),
      }).then((r) => r.json());

      // Queue prompts BEFORE claim - must be adopted.
      await fetch(`${base}/api/${opened.key}/prompts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompts: [{ uid: "1", prompt: "pre-claim words", selector: "h1", tag: "h1", text: "A" }],
        }),
      });

      const claim = await fetch(`${base}/api/review/claim`, {
        method: "POST",
        headers: auth(home.home_id),
        body: JSON.stringify({ generation: 1, review_id: opened.key, home_root: home.home_root }),
      }).then(async (r) => ({ status: r.status, body: await r.json() }));
      assert.equal(claim.status, 200, JSON.stringify(claim.body));

      // Poll must say claimed even with history.
      const poll = await fetch(`${base}/api/poll?file=${encodeURIComponent(file)}&timeoutMs=100`).then((r) => r.json());
      assert.equal(poll.status, "claimed");

      const frames = [];
      const subRes = await new Promise((resolve, reject) => {
        import("node:http").then(({ default: http }) => {
          const url = new URL(`${base}/api/events/stream`);
          url.searchParams.set("generation", "1");
          const req = http.get(url, { headers: { authorization: `Bearer ${home.home_id}` } }, (res) => {
            let buf = "";
            res.on("data", (c) => {
              buf += c;
              let i;
              while ((i = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                if (line.trim()) frames.push(JSON.parse(line));
              }
            });
            resolve({ res, req, status: res.statusCode });
          });
          req.on("error", reject);
        });
      });
      assert.equal(subRes.status, 200);
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(frames.some((f) => f.type === "feedback" && f.payload?.prompts?.[0]?.prompt === "pre-claim words"));

      // Send & End
      await fetch(`${base}/api/${opened.key}/prompts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompts: [{ uid: "2", prompt: "final\n$meta", selector: "h1", tag: "h1", text: "A" }],
          endSession: true,
        }),
      });
      await new Promise((r) => setTimeout(r, 100));
      const finals = frames.filter((f) => f.schema === "multiplexed.event/1" || f.schema === "lavish.event/1");
      // Foundation schema is multiplexed.event/1
      const ff = frames.find((f) => f.type === "feedback_final");
      const en = frames.find((f) => f.type === "ended");
      assert.ok(ff && en);
      assert.ok(ff.log_position < en.log_position);
      assert.equal(ff.payload.prompts[0].prompt, "final\n$meta");

      // Ended claimed still returns claimed from poll
      const poll2 = await fetch(`${base}/api/poll?file=${encodeURIComponent(file)}&timeoutMs=100`).then((r) =>
        r.json(),
      );
      assert.equal(poll2.status, "claimed");

      subRes.req.destroy();
      void finals;
    } finally {
      await server.close();
    }
  });
});

test("0.1.x state migrates without losing session prompts", async () => {
  await withTemp(async (dir) => {
    const { SessionStore, sessionKey, canonicalFile } = await import("../src/session-store.js");
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "old.html");
    await writeFile(artifact, "<h1>Old</h1>");
    const key = sessionKey(await canonicalFile(artifact));
    await writeFile(
      stateFile,
      JSON.stringify({
        sessions: {
          [key]: {
            key,
            file: await canonicalFile(artifact),
            url: "http://x/s",
            status: "feedback",
            pending_prompts: 1,
            prompts: [{ uid: "1", prompt: "legacy", selector: "h1", tag: "h1", text: "Old" }],
            layout_warnings: [],
            artifact_revision: 1,
            artifact_failures: [],
            chat: [],
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        },
      }) + "\n",
    );
    const store = new SessionStore(stateFile);
    const sessions = await store.listSessions();
    assert.equal(sessions[0].prompts[0].prompt, "legacy");
    await store.upsertSession(artifact, sessions[0].url);
    const raw = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(raw.state_version, 2);
  });
});
