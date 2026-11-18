import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import { createChromeHtml, serve } from "../src/server.js";

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

test("the root page lists open sessions, escapes labels, and links to each session", async () => {
  await withServer(async ({ base, dir, open }) => {
    const hostile = path.join(dir, "<img src=x onerror=alert(1)>");
    await mkdir(hostile);
    const a = await open("<img src=x onerror=alert(1)>/a.html");
    const html = await fetch(`${base}/`, { headers: { accept: "text/html" } }).then((r) => r.text());
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;\/a\.html/);
    assert.ok(html.includes(`href="/session/${a.body.key}"`));
  });
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
