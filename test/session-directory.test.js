import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import {
  createChromeHtml,
  createLandingHtml,
  isDirectoryRequest,
  isLoopbackPeer,
  normalizeSessionName,
  serve,
} from "../src/server.js";

async function withServer(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-directory-"));
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    detectTailscale: async () => null,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const open = async (name, body = {}) => {
    const file = path.join(dir, name);
    await writeFile(file, "<!doctype html><html><body>x</body></html>");
    const res = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file, ...body }),
    });
    return { file, body: await res.json() };
  };
  try {
    await fn({ base, dir, open });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("GET /api/sessions lists open sessions, labelled by directory and file, and omits ended ones", async () => {
  await withServer(async ({ base, dir, open }) => {
    const a = await open("a.html");
    const b = await open("b.html");
    const c = await open("c.html");
    await fetch(`${base}/api/${c.body.key}/end`, { method: "POST" });

    const list = await fetch(`${base}/api/sessions`).then((r) => r.json());
    const byKey = new Map(list.sessions.map((s) => [s.key, s]));
    assert.equal(list.sessions.length, 2);
    assert.equal(byKey.get(a.body.key).name, `${path.basename(dir)}/a.html`);
    assert.match(byKey.get(a.body.key).url, /\/session\//);
    assert.ok(byKey.has(b.body.key));
    assert.equal(byKey.has(c.body.key), false);
    // Never leak the raw prompts/chat/dom snapshot through the directory.
    assert.deepEqual(Object.keys(byKey.get(a.body.key)).sort(), ["file", "key", "name", "status", "updated_at", "url"]);
  });
});

test("the root page lists open sessions and links to each session", async () => {
  await withServer(async ({ base, open }) => {
    const a = await open("a.html");
    const html = await fetch(`${base}/`, { headers: { accept: "text/html" } }).then((r) => r.text());
    assert.ok(html.includes(`href="/session/${a.body.key}"`));
  });
});

test("the landing page escapes markup in a session label and path", () => {
  // A fake row, not a directory: Windows refuses `<` and `>` in path names.
  const hostile = "<img src=x onerror=alert(1)>/a.html";
  const html = createLandingHtml([{ key: "k1", name: hostile, file: `~/${hostile}` }]);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;\/a\.html/);
  assert.ok(html.includes('href="/session/k1"'));
});

test("the root page keeps the running message when no session is open", async () => {
  await withServer(async ({ base }) => {
    const html = await fetch(`${base}/`, { headers: { accept: "text/html" } }).then((r) => r.text());
    assert.match(html, /Lavish Editor is running/);
  });
});

test("the chrome navbar carries a session switcher with an escaped label", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/<plan>/a.html", prompts: [], chat: [] }, { title: "t" });
  assert.match(html, /id="sessionsButton"/);
  assert.match(html, /id="sessionsMenu"/);
  assert.ok(html.includes("&lt;plan&gt;/a.html"));
  assert.doesNotMatch(html, /<plan>\/a\.html/);
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

test("a loopback request carrying a forwarding header gets no directory", async () => {
  await withServer(async ({ base, open }) => {
    const a = await open("a.html");
    const plain = await fetch(`${base}/api/sessions`).then((r) => r.json());
    assert.equal(plain.sessions.length, 1);
    for (const header of ["x-forwarded-for", "x-real-ip", "x-forwarded-proto", "forwarded"]) {
      const proxied = await fetch(`${base}/api/sessions`, { headers: { [header]: "203.0.113.9" } }).then((r) =>
        r.json(),
      );
      assert.deepEqual(proxied.sessions, [], header);
      const html = await fetch(`${base}/`, { headers: { [header]: "203.0.113.9", accept: "text/html" } }).then((r) =>
        r.text(),
      );
      assert.doesNotMatch(html, new RegExp(a.body.key), header);
      assert.match(html, /Lavish Editor is running/);
    }
  });
});

test("isDirectoryRequest needs a loopback peer and no forwarding header", () => {
  const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
  assert.equal(isDirectoryRequest(req("127.0.0.1")), true);
  assert.equal(isDirectoryRequest(req("127.0.0.1", { "x-forwarded-host": "x" })), false);
  assert.equal(isDirectoryRequest(req("100.64.0.5")), false);
});

test("normalizeSessionName trims, collapses whitespace, and bounds the name", () => {
  assert.equal(normalizeSessionName("  Checkout   flow \n"), "Checkout flow");
  assert.equal(normalizeSessionName(""), "");
  assert.equal(normalizeSessionName(undefined), "");
  assert.equal(normalizeSessionName(42), "");
  assert.equal(normalizeSessionName("a\u0000b\u001bc"), "abc");
  assert.equal(normalizeSessionName("x".repeat(500)).length, 80);
});

test("a stored name replaces the default label in the directory, root page and chrome", async () => {
  await withServer(async ({ base, open }) => {
    const a = await open("a.html", { name: "<b>Checkout</b> flow" });
    const list = await fetch(`${base}/api/sessions`).then((r) => r.json());
    assert.equal(list.sessions.find((s) => s.key === a.body.key).name, "<b>Checkout</b> flow");
    const root = await fetch(`${base}/`, { headers: { accept: "text/html" } }).then((r) => r.text());
    assert.doesNotMatch(root, /<b>Checkout/);
    assert.match(root, /&lt;b&gt;Checkout&lt;\/b&gt; flow/);
    const chrome = createChromeHtml(
      { key: "abc", file: "/tmp/a.html", name: "My <plan>", prompts: [], chat: [] },
      { title: "t" },
    );
    assert.ok(chrome.includes("My &lt;plan&gt;"));
    assert.doesNotMatch(chrome, /My <plan>/);
  });
});

test("reopening without a name keeps the stored name and a new name renames it", async () => {
  await withServer(async ({ base, open }) => {
    const first = await open("a.html", { name: "Plan v1" });
    await open("a.html");
    let list = await fetch(`${base}/api/sessions`).then((r) => r.json());
    assert.equal(list.sessions[0].name, "Plan v1");
    await open("a.html", { name: "Plan v2" });
    list = await fetch(`${base}/api/sessions`).then((r) => r.json());
    assert.equal(list.sessions.length, 1);
    assert.equal(list.sessions[0].key, first.body.key);
    assert.equal(list.sessions[0].name, "Plan v2");
  });
});
