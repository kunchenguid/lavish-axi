import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createChromeHtml, serve } from "../src/server.js";

const SANDBOX = "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads";

async function openSession(base, file, tag) {
  const session = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file }),
  }).then((response) => response.json());
  const json = { "content-type": "application/json", origin: base };
  const handoff = await fetch(`${base}/api/${session.key}/chrome-loads/begin`, {
    method: "POST",
    headers: json,
    body: "{}",
  }).then((response) => response.json());
  let sequence = 0;
  const begin = async () => {
    sequence += 1;
    const response = await fetch(`${base}/api/${session.key}/artifact-loads/begin`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        request_id: `${tag}-${sequence}`,
        request_sequence: sequence,
        chrome_load_token: handoff.chrome_load_token,
      }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  return { session, begin };
}

function sdkParams(html, base) {
  const source = html.match(/<script src="([^"]*\/sdk\.js\?[^"]+)"><\/script>/)?.[1];
  assert.ok(source, "the page carries the SDK tag");
  return new URL(source, base);
}

test("issue 352 r53: path-addressed artifact responses are framable while legacy, export, and chrome stay strict", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-352-framing-"));
  try {
    await mkdir(path.join(root, "sub"));
    await writeFile(path.join(root, "index.html"), '<body><iframe src="sub/page.html"></iframe></body>');
    await writeFile(path.join(root, "sub", "page.html"), "<body>nested</body>");
    await writeFile(path.join(root, "sub", "pic.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const server = await serve({ port: 0, stateFile: path.join(root, "state", "state.json"), version: "framing" });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const { session, begin } = await openSession(base, path.join(root, "index.html"), "framing");
      const load = await begin();
      const csp = async (url) => {
        const response = await fetch(url);
        assert.equal(response.status, 200, url);
        await response.arrayBuffer();
        return response.headers.get("content-security-policy");
      };
      assert.equal(await csp(`${base}/artifact/${session.key}/index.html`), SANDBOX);
      assert.equal(await csp(`${base}/artifact/${session.key}/sub/page.html`), SANDBOX);
      assert.equal(await csp(`${base}/artifact/${session.key}/sub/pic.svg`), SANDBOX);
      const legacy = `${base}/artifact/${session.key}/index.html?artifact_revision=${load.artifact_revision}&artifact_load_token=${encodeURIComponent(load.artifact_load_token)}`;
      assert.equal(await csp(legacy), `${SANDBOX}; frame-ancestors 'self'`);
      assert.equal(await csp(`${base}/api/${session.key}/export`), `${SANDBOX}; frame-ancestors 'self'`);
      const chrome = await fetch(`${base}/session/${session.key}`);
      assert.match(String(chrome.headers.get("content-security-policy")), /frame-ancestors 'none'/);
      assert.equal(chrome.headers.get("x-frame-options"), "DENY");
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("issue 352 r53: chrome auth is issued only to a same-origin current-generation chrome", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-352-chrome-auth-"));
  try {
    await mkdir(path.join(root, "a"));
    await mkdir(path.join(root, "b"));
    await writeFile(path.join(root, "a", "entry.html"), "<body>A</body>");
    await writeFile(path.join(root, "b", "entry.html"), "<body>B</body>");
    const server = await serve({ port: 0, stateFile: path.join(root, "state", "state.json"), version: "auth" });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const a = await openSession(base, path.join(root, "a", "entry.html"), "a");
      const b = await openSession(base, path.join(root, "b", "entry.html"), "b");
      const loadA = await a.begin();
      const loadB = await b.begin();
      const page = async (session) =>
        sdkParams(await fetch(`${base}/artifact/${session.key}/entry.html`).then((r) => r.text()), base);
      const first = await page(a.session);
      const second = await page(a.session);
      const nonce = first.searchParams.get("chrome_nonce");
      const embedded = first.searchParams.get("chrome_auth");
      assert.match(nonce, /^[A-Za-z0-9_-]{22,128}$/);
      assert.ok(embedded);
      assert.notEqual(second.searchParams.get("chrome_nonce"), nonce, "every served document gets a fresh nonce");
      assert.notEqual(second.searchParams.get("chrome_auth"), embedded);

      /** @param {string} key @param {any} body @param {Record<string, string>} [headers] */
      const ask = (key, body, headers = { origin: base }) =>
        fetch(`${base}/api/${key}/artifact-bindings/chrome-auth`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
      const current = {
        artifact_load_token: loadA.artifact_load_token,
        artifact_revision: loadA.artifact_revision,
        document_nonce: nonce,
      };
      const granted = await ask(a.session.key, current);
      assert.equal(granted.status, 200);
      assert.deepEqual(await granted.json(), { chrome_auth: embedded });

      // Foreign and header-less callers learn nothing, even with a correct body.
      assert.equal((await ask(a.session.key, current, { origin: "http://evil.example" })).status, 403);
      assert.equal((await ask(a.session.key, current, {})).status, 403);
      // Missing or forged generation material.
      assert.equal((await ask(a.session.key, { document_nonce: nonce })).status, 409);
      assert.equal((await ask(a.session.key, { ...current, artifact_load_token: "forged" })).status, 409);
      assert.equal(
        (await ask(a.session.key, { ...current, artifact_revision: loadA.artifact_revision + 1 })).status,
        409,
      );
      // Malformed nonces.
      for (const bad of [undefined, "", "short", "x".repeat(200), "has spaces in the nonce value!!", 7]) {
        assert.equal((await ask(a.session.key, { ...current, document_nonce: bad })).status, 400);
      }
      // Cross-session: B's generation cannot unlock A, and B's MAC for A's nonce is not A's.
      const crossToken = await ask(a.session.key, {
        ...current,
        artifact_load_token: loadB.artifact_load_token,
        artifact_revision: loadB.artifact_revision,
      });
      assert.equal(crossToken.status, 409);
      const crossSession = await ask(b.session.key, {
        artifact_load_token: loadB.artifact_load_token,
        artifact_revision: loadB.artifact_revision,
        document_nonce: nonce,
      });
      assert.equal(crossSession.status, 200);
      assert.notEqual((await crossSession.json()).chrome_auth, embedded);
      assert.equal((await ask("0000000000000000", current)).status, 404);

      // The SDK is only served with genuine auth material for this session.
      assert.equal((await fetch(first)).status, 200);
      const swapped = new URL(first);
      swapped.searchParams.set("chrome_auth", second.searchParams.get("chrome_auth"));
      assert.equal((await fetch(swapped)).status, 403, "a MAC replayed against another nonce is refused");
      const missing = new URL(first);
      missing.searchParams.delete("chrome_auth");
      assert.equal((await fetch(missing)).status, 403);
      const forged = new URL(first);
      forged.searchParams.set("chrome_auth", "A".repeat(43));
      assert.equal((await fetch(forged)).status, 403);

      // Generation-stale: once a newer load begins, the old generation can no longer obtain auth.
      const newer = await a.begin();
      assert.equal((await ask(a.session.key, current)).status, 409);
      const renewed = await ask(a.session.key, {
        artifact_load_token: newer.artifact_load_token,
        artifact_revision: newer.artifact_revision,
        document_nonce: nonce,
      });
      // The MAC names the document, not the generation, so a BFCache-restored document still
      // recognizes the current chrome and the stale-recovery path can run.
      assert.deepEqual(await renewed.json(), { chrome_auth: embedded });
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("issue 352 r54: the chrome renders one top bar with globally unique ids", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  assert.equal(html.match(/<div class="bar">/g)?.length, 1);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  assert.deepEqual(duplicates, []);
  for (const id of [
    "warningsButton",
    "warningsDrawer",
    "warningsQueueButton",
    "revisionsButton",
    "revisionsDrawer",
    "revisionsList",
    "annotation",
    "moreButton",
    "moreMenu",
    "reloadArtifact",
    "copySnapshot",
    "exportArtifact",
    "shareArtifact",
    "end",
  ]) {
    assert.equal(ids.filter((value) => value === id).length, 1, id);
  }
});
