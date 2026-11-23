import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import { createLandingHtml, isDirectoryRequest, isLoopbackPeer, serve } from "../src/server.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withServer(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-index-"));
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    detectTailscale: async () => null,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const open = async (name) => {
    const file = path.join(dir, name);
    await writeFile(file, "<!doctype html><html><body>x</body></html>");
    const res = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file }),
    });
    await sleep(5); // updated_at has millisecond resolution; keep the order unambiguous
    return (await res.json()).key;
  };
  try {
    await fn({ base, port: server.port, dir, open });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const getHtml = (url, headers = {}) => fetch(url, { headers: { accept: "text/html", ...headers }, redirect: "manual" });

test("the root page lists open sessions newest first and links each to its session", async () => {
  await withServer(async ({ base, dir, open }) => {
    const a = await open("a.html");
    const b = await open("b.html");
    const c = await open("c.html");
    await fetch(`${base}/api/${b}/end`, { method: "POST" });

    const res = await getHtml(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control") || "", /no-store/);
    const html = await res.text();
    assert.match(html, /<meta http-equiv="refresh" content="5">/);
    assert.ok(html.includes(`href="/session/${a}"`));
    assert.ok(html.includes(`href="/session/${c}"`));
    assert.equal(html.includes(`/session/${b}`), false, "an ended session is not listed");
    assert.ok(html.indexOf(`/session/${c}`) < html.indexOf(`/session/${a}`), "newest first");
    assert.ok(html.includes(`${path.basename(dir)}/c.html`) || html.includes("c.html"));
  });
});

test("the root page keeps the running message when no session is open", async () => {
  await withServer(async ({ base }) => {
    const html = await getHtml(`${base}/`).then((r) => r.text());
    assert.match(html, /Lavish Editor is running/);
    assert.doesNotMatch(html, /http-equiv="refresh"/);
  });
});

test("/latest redirects to the newest open session, else back to the index", async () => {
  await withServer(async ({ base, open }) => {
    const none = await fetch(`${base}/latest`, { redirect: "manual" });
    assert.equal(none.status, 302);
    assert.equal(none.headers.get("location"), "/");

    await open("a.html");
    const b = await open("b.html");
    const res = await fetch(`${base}/latest`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), `/session/${b}`);
    assert.match(res.headers.get("cache-control") || "", /no-store/);

    await fetch(`${base}/api/${b}/end`, { method: "POST" });
    const after = await fetch(`${base}/latest`, { redirect: "manual" });
    assert.notEqual(after.headers.get("location"), `/session/${b}`);
  });
});

test("the index shows how many prompts are queued for a session", async () => {
  await withServer(async ({ base, open }) => {
    const key = await open("a.html");
    const res = await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        prompts: [
          { type: "freeform", text: "one" },
          { type: "freeform", text: "two" },
        ],
      }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    const html = await getHtml(`${base}/`).then((r) => r.text());
    assert.match(html, /2 queued/);
  });
});

test("the landing page escapes markup in a label and path", () => {
  // A fake row, not a directory: Windows refuses `<` and `>` in path names.
  const hostile = "<img src=x onerror=alert(1)>/a.html";
  const html = createLandingHtml([{ key: "k1", name: hostile, file: `~/${hostile}`, queued: 0 }]);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;\/a\.html/);
  assert.ok(html.includes('href="/session/k1"'));
});

test("a foreign Host header never reaches the index", async () => {
  await withServer(async ({ port, open }) => {
    const key = await open("a.html");
    const body = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/", headers: { host: "evil.example", accept: "text/html" } },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode, data }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.notEqual(body.status, 200);
    assert.equal(body.data.includes(key), false);
  });
});

test("a loopback request carrying a forwarding header gets no session list", async () => {
  await withServer(async ({ base, open }) => {
    const key = await open("a.html");
    for (const header of ["x-forwarded-for", "x-real-ip", "x-forwarded-proto", "forwarded"]) {
      const html = await getHtml(`${base}/`, { [header]: "203.0.113.9" }).then((r) => r.text());
      assert.equal(html.includes(key), false, header);
      assert.match(html, /Lavish Editor is running/);
      const latest = await fetch(`${base}/latest`, { headers: { [header]: "203.0.113.9" }, redirect: "manual" });
      assert.equal(latest.headers.get("location"), "/", header);
    }
  });
});

test("isLoopbackPeer accepts only loopback TCP peers", () => {
  for (const ok of ["127.0.0.1", "127.8.9.1", "::1", "::ffff:127.0.0.1"]) assert.equal(isLoopbackPeer(ok), true, ok);
  for (const bad of [
    "100.64.0.5",
    "192.168.1.2",
    "::ffff:10.0.0.1",
    "2001:db8::1",
    "127.example.com",
    "",
    undefined,
    null,
  ]) {
    assert.equal(isLoopbackPeer(bad), false, String(bad));
  }
});

test("isDirectoryRequest needs a loopback peer and no forwarding header", () => {
  const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
  assert.equal(isDirectoryRequest(req("127.0.0.1")), true);
  assert.equal(isDirectoryRequest(req("127.0.0.1", { "x-forwarded-host": "x" })), false);
  assert.equal(isDirectoryRequest(req("100.64.0.5")), false);
});
