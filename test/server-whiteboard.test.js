import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import {
  createWhiteboardChannelToken,
  createWhiteboardFrameHtml,
  isValidWhiteboardChannelToken,
  isWhiteboardWriteApiPath,
  serve,
} from "../src/server.js";
import { mermaidSourceHash } from "../src/mermaid-source.js";

const ARTIFACT_HTML = `<!doctype html><html><body>
<h1>Demo</h1>
<pre class="mermaid">flowchart TD
  A["OBJECTIVE:<br/>do the thing"] --&gt; B{Ready?}</pre>
<pre class="mermaid">sequenceDiagram
  CLI-&gt;&gt;Server: poll</pre>
</body></html>`;

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** @param {{ artifactPageOpen?: (...args: any[]) => any }} [options] */
async function startWhiteboardServer({ artifactPageOpen } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-wb-server-"));
  const assetsDir = path.join(dir, "whiteboard-assets");
  await mkdir(path.join(assetsDir, "fonts", "Excalifont"), { recursive: true });
  await writeFile(path.join(assetsDir, "whiteboard.js"), "// fake bundle\n");
  await writeFile(path.join(assetsDir, "whiteboard.css"), "body{}\n");
  await writeFile(path.join(assetsDir, "fonts", "Excalifont", "Excalifont-Regular.woff2"), "fake-font");
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, ARTIFACT_HTML);
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    whiteboardAssetsDir: assetsDir,
    artifactPageOpen,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const opened = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: artifact }),
  }).then((res) => res.json());
  return {
    dir,
    base,
    key: opened.key,
    server,
    sameOrigin: { "content-type": "application/json", origin: base },
    async close() {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function pageContext(ctx, page) {
  const document = await fetch(`${ctx.base}/artifact/${ctx.key}/${page}`).then((res) => res.text());
  const script = document.match(/<script src="([^"]*\/sdk\.js\?[^"]+)"><\/script>/)?.[1];
  assert.ok(script, `expected injected SDK for ${page}`);
  const params = new URL(script, ctx.base).searchParams;
  return { page: params.get("page"), page_proof: params.get("page_proof") };
}

test("isWhiteboardWriteApiPath matches only whiteboard write routes", () => {
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/whiteboard/0"), true);
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/whiteboard/12/feedback-files"), true);
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/whiteboard/12?page=page.html"), true);
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/whiteboard/12/feedback-files?page=page.html"), true);
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/prompts"), false);
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/whiteboard/9999"), false);
  assert.equal(isWhiteboardWriteApiPath("/api/BAD/whiteboard/0"), false);
  assert.equal(isWhiteboardWriteApiPath("/whiteboard-frame"), false);
});

test("createWhiteboardFrameHtml loads only whiteboard-assets resources", () => {
  const html = createWhiteboardFrameHtml("channel-token");
  assert.match(html, /<link rel="stylesheet" href="\/whiteboard-assets\/whiteboard\.css">/);
  assert.match(html, /<script src="\/whiteboard-assets\/whiteboard\.js"><\/script>/);
  assert.match(html, /__lavishWhiteboardChannelToken="channel-token"/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test("whiteboard confirms sanitized links inside the frame", async () => {
  const frame = await readFile(new URL("../src/whiteboard-frame.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/whiteboard-frame.css", import.meta.url), "utf8");

  assert.doesNotMatch(frame, /window\.confirm/);
  assert.match(frame, /setAttribute\("role", "dialog"\)/);
  assert.match(frame, /setAttribute\("aria-modal", "true"\)/);
  assert.match(frame, /setAttribute\("aria-label", "Open external link"\)/);
  assert.match(frame, /event\.key === "Escape"/);
  assert.match(frame, /event\.key !== "Tab"/);
  assert.match(frame, /window\.open\(safe, "_blank", "noopener,noreferrer"\)/);
  assert.match(css, /\.wb-link-confirm/);
  assert.match(css, /data-lavish-whiteboard-theme="dark"/);
});

test("whiteboard channel tokens are signed, session bound, and short lived", () => {
  const secret = Buffer.from("whiteboard-test-secret");
  const now = 1_700_000_000_000;
  const sessionKey = "0123456789abcdef";
  const token = createWhiteboardChannelToken(secret, sessionKey, now);
  assert.equal(isValidWhiteboardChannelToken(token, secret, sessionKey, now), true);
  assert.equal(isValidWhiteboardChannelToken(`${token}x`, secret, sessionKey, now), false);
  assert.equal(isValidWhiteboardChannelToken(token, secret, sessionKey, now + 5 * 60_000 + 1), false);
  // A token minted for one session must never authenticate another, and a
  // token minted without a session must never authenticate anything.
  assert.equal(isValidWhiteboardChannelToken(token, secret, "fedcba9876543210", now), false);
  assert.equal(isValidWhiteboardChannelToken(createWhiteboardChannelToken(secret, "", now), secret, "", now), false);
});

test("GET /api/:key/mermaid-sources preserves label breaks and returns ordered sources with hashes", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const data = await fetch(`${ctx.base}/api/${ctx.key}/mermaid-sources`).then((res) => res.json());
    assert.equal(data.sources.length, 2);
    assert.equal(data.sources[0].index, 0);
    const expectedFlowchart = 'flowchart TD\n  A["OBJECTIVE:<br/>do the thing"] --> B{Ready?}';
    assert.equal(data.sources[0].source, expectedFlowchart);
    assert.equal(data.sources[0].hash, mermaidSourceHash(expectedFlowchart));
    assert.equal(data.sources[1].source, "sequenceDiagram\n  CLI->>Server: poll");
  } finally {
    await ctx.close();
  }
});

test("mermaid source reads reject a validated path swapped to an outside symlink", async () => {
  let armed = false;
  let swapped = false;
  let artifactFile = "";
  let outsideFile = "";
  const ctx = await startWhiteboardServer({
    artifactPageOpen: async (file, flags) => {
      if (armed && !swapped && file === artifactFile) {
        swapped = true;
        await rm(artifactFile);
        await symlink(outsideFile, artifactFile);
      }
      return open(file, flags);
    },
  });
  const outside = await mkdtemp(path.join(tmpdir(), "lavish-wb-outside-"));
  const secret = "OUTSIDE_MERMAID_SENTINEL";
  try {
    artifactFile = await realpath(path.join(ctx.dir, "artifact.html"));
    outsideFile = path.join(outside, "secret.html");
    await writeFile(outsideFile, `<pre class=mermaid>${secret}</pre>`);
    const page = await pageContext(ctx, "artifact.html");
    armed = true;
    const response = await fetch(
      `${ctx.base}/api/${ctx.key}/mermaid-sources?page=${encodeURIComponent(page.page)}&page_proof=${encodeURIComponent(page.page_proof)}`,
      { headers: { origin: ctx.base } },
    );
    const body = await response.text();
    assert.equal(response.status, 403);
    assert.equal(swapped, true);
    assert.doesNotMatch(body, new RegExp(secret));
  } finally {
    await ctx.close();
    await rm(outside, { recursive: true, force: true });
  }
});

test("modern whiteboard content is page-scoped and reads each page fresh", async () => {
  const ctx = await startWhiteboardServer();
  try {
    await mkdir(path.join(ctx.dir, "sub"));
    await writeFile(
      path.join(ctx.dir, "sub", "page.html"),
      "<!doctype html><html><body><pre class=mermaid>flowchart LR\n  S-->T</pre></body></html>",
    );
    const entry = await pageContext(ctx, "artifact.html");
    const sibling = await pageContext(ctx, "sub/page.html");
    const sameOrigin = { ...ctx.sameOrigin };

    const entrySources = await fetch(
      `${ctx.base}/api/${ctx.key}/mermaid-sources?page=${encodeURIComponent(entry.page)}&page_proof=${encodeURIComponent(entry.page_proof)}`,
      { headers: { origin: ctx.base } },
    );
    assert.equal(entrySources.status, 200);
    assert.equal((await entrySources.json()).sources.length, 2);

    const siblingSources = await fetch(
      `${ctx.base}/api/${ctx.key}/mermaid-sources?page=${encodeURIComponent(sibling.page)}&page_proof=${encodeURIComponent(sibling.page_proof)}`,
      { headers: { referer: `${ctx.base}/session/${ctx.key}` } },
    );
    assert.equal(siblingSources.status, 200);
    const siblingData = await siblingSources.json();
    assert.equal(siblingData.sources.length, 1);
    assert.equal(siblingData.sources[0].source, "flowchart LR\n  S-->T");

    const scene = { elements: [{ id: "sibling", type: "rectangle" }], appState: {}, files: {} };
    const put = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0`, {
      method: "PUT",
      headers: sameOrigin,
      body: JSON.stringify({
        page: sibling.page,
        page_proof: sibling.page_proof,
        artifact_revision: 999,
        artifact_load_token: "expired-live-token",
        document_sequence: 999,
        source_hash: "sibling-source",
        scene,
      }),
    });
    assert.equal(put.status, 200);

    const siblingRead = await fetch(
      `${ctx.base}/api/${ctx.key}/whiteboard/0?page=${encodeURIComponent(sibling.page)}&page_proof=${encodeURIComponent(sibling.page_proof)}`,
      { headers: { origin: ctx.base } },
    );
    assert.equal(siblingRead.status, 200);
    assert.equal((await siblingRead.json()).whiteboard.source_hash, "sibling-source");

    // A page-aware read never falls back to the legacy entry sidecar, even when the sibling has
    // no saved scene yet.
    const entryPut = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/1`, {
      method: "PUT",
      headers: sameOrigin,
      body: JSON.stringify({ source_hash: "entry-only", scene: { elements: [] } }),
    });
    assert.equal(entryPut.status, 200);
    const siblingIndexOne = await fetch(
      `${ctx.base}/api/${ctx.key}/whiteboard/1?page=${encodeURIComponent(sibling.page)}&page_proof=${encodeURIComponent(sibling.page_proof)}`,
      { headers: { origin: ctx.base } },
    );
    assert.equal(siblingIndexOne.status, 200);
    assert.equal((await siblingIndexOne.json()).whiteboard, null);

    const feedback = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0/feedback-files`, {
      method: "POST",
      headers: sameOrigin,
      body: JSON.stringify({
        page: sibling.page,
        page_proof: sibling.page_proof,
        scene,
        pngDataUrl: PNG_DATA_URL,
      }),
    });
    assert.equal(feedback.status, 200);
    const feedbackPaths = await feedback.json();
    assert.match(feedbackPaths.scene_path, /whiteboards[\\/]\w+[\\/]\w{64}[\\/]0\.excalidraw$/);
    assert.match(feedbackPaths.preview_path, /whiteboards[\\/]\w+[\\/]\w{64}[\\/]0\.png$/);
  } finally {
    await ctx.close();
  }
});

test("modern entry whiteboards retain the legacy namespace while siblings stay isolated", async () => {
  const ctx = await startWhiteboardServer();
  try {
    await mkdir(path.join(ctx.dir, "sub"));
    await writeFile(path.join(ctx.dir, "sub", "page.html"), ARTIFACT_HTML);
    const entry = await pageContext(ctx, "artifact.html");
    const sibling = await pageContext(ctx, "sub/page.html");

    const legacyPut = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0`, {
      method: "PUT",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ source_hash: "pre-upgrade", scene: { elements: [{ id: "legacy" }] } }),
    });
    assert.equal(legacyPut.status, 200);

    const modernEntryRead = await fetch(
      `${ctx.base}/api/${ctx.key}/whiteboard/0?page=${encodeURIComponent(entry.page)}&page_proof=${encodeURIComponent(entry.page_proof)}`,
      { headers: { origin: ctx.base } },
    );
    assert.equal(modernEntryRead.status, 200);
    assert.equal((await modernEntryRead.json()).whiteboard.source_hash, "pre-upgrade");

    const modernEntryPut = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0`, {
      method: "PUT",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        page: entry.page,
        page_proof: entry.page_proof,
        source_hash: "modern-entry",
        scene: { elements: [{ id: "updated-entry" }] },
      }),
    });
    assert.equal(modernEntryPut.status, 200);
    const legacyRead = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0`).then((response) => response.json());
    assert.equal(legacyRead.whiteboard.source_hash, "modern-entry");
    assert.equal(legacyRead.whiteboard.scene.elements[0].id, "updated-entry");

    const feedback = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0/feedback-files`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        page: entry.page,
        page_proof: entry.page_proof,
        scene: { elements: [{ id: "entry-feedback", type: "rectangle" }] },
        pngDataUrl: PNG_DATA_URL,
      }),
    });
    assert.equal(feedback.status, 200);
    const feedbackPaths = await feedback.json();
    assert.ok(feedbackPaths.scene_path.endsWith(`${path.sep}whiteboards${path.sep}${ctx.key}${path.sep}0.excalidraw`));
    assert.ok(feedbackPaths.preview_path.endsWith(`${path.sep}whiteboards${path.sep}${ctx.key}${path.sep}0.png`));

    const siblingRead = await fetch(
      `${ctx.base}/api/${ctx.key}/whiteboard/0?page=${encodeURIComponent(sibling.page)}&page_proof=${encodeURIComponent(sibling.page_proof)}`,
      { headers: { origin: ctx.base } },
    );
    assert.equal(siblingRead.status, 200);
    assert.equal((await siblingRead.json()).whiteboard, null);
  } finally {
    await ctx.close();
  }
});

test("modern whiteboard routes fail closed for proof, page, origin and source races", async () => {
  const first = await startWhiteboardServer();
  const second = await startWhiteboardServer();
  try {
    await mkdir(path.join(first.dir, "sub"));
    await writeFile(path.join(first.dir, "sub", "page.html"), ARTIFACT_HTML);
    const firstPage = await pageContext(first, "sub/page.html");
    const secondPage = await pageContext(second, "artifact.html");

    const missingProof = await fetch(`${first.base}/api/${first.key}/mermaid-sources?page=sub%2Fpage.html`, {
      headers: { origin: first.base },
    });
    assert.equal(missingProof.status, 400);

    const hostile = await fetch(
      `${first.base}/api/${first.key}/mermaid-sources?page=${encodeURIComponent(firstPage.page)}&page_proof=${encodeURIComponent(firstPage.page_proof)}`,
      { headers: { origin: "https://evil.example" } },
    );
    assert.equal(hostile.status, 403);

    const opaque = await fetch(
      `${first.base}/api/${first.key}/whiteboard/0?page=${encodeURIComponent(firstPage.page)}&page_proof=${encodeURIComponent(firstPage.page_proof)}`,
      { headers: { origin: "null" } },
    );
    assert.equal(opaque.status, 403);

    const absent = await fetch(
      `${first.base}/api/${first.key}/whiteboard/0?page=${encodeURIComponent(firstPage.page)}&page_proof=${encodeURIComponent(firstPage.page_proof)}`,
    );
    assert.equal(absent.status, 403);

    const otherSessionProof = await fetch(
      `${first.base}/api/${first.key}/mermaid-sources?page=${encodeURIComponent(secondPage.page)}&page_proof=${encodeURIComponent(secondPage.page_proof)}`,
      { headers: { origin: first.base } },
    );
    assert.equal(otherSessionProof.status, 403);

    const mismatch = await fetch(
      `${first.base}/api/${first.key}/mermaid-sources?page=${encodeURIComponent(firstPage.page)}&page_proof=${encodeURIComponent(secondPage.page_proof)}`,
      { headers: { origin: first.base } },
    );
    assert.equal(mismatch.status, 403);

    await rm(path.join(first.dir, "sub", "page.html"));
    const missingPage = await fetch(
      `${first.base}/api/${first.key}/mermaid-sources?page=${encodeURIComponent(firstPage.page)}&page_proof=${encodeURIComponent(firstPage.page_proof)}`,
      { headers: { origin: first.base } },
    );
    assert.equal(missingPage.status, 404);

    const malformedIndex = await fetch(`${first.base}/api/${first.key}/whiteboard/not-an-index`, {
      headers: { origin: first.base },
    });
    assert.equal(malformedIndex.status, 400);
  } finally {
    await first.close();
    await second.close();
  }
});

test("whiteboard scene round-trips through PUT and GET", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const empty = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0`).then((res) => res.json());
    assert.equal(empty.whiteboard, null);

    const scene = { elements: [{ id: "A", type: "rectangle" }], appState: { theme: "dark" }, files: {} };
    const put = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0`, {
      method: "PUT",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        source_hash: "hash-1",
        text_metrics_version: 1,
        scene,
        baseline: { elements: scene.elements },
      }),
    });
    assert.equal(put.status, 200);

    const loaded = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0`).then((res) => res.json());
    assert.equal(loaded.whiteboard.source_hash, "hash-1");
    assert.equal(loaded.whiteboard.text_metrics_version, 1);
    assert.deepEqual(loaded.whiteboard.scene, { ...scene, appState: {} });
    assert.deepEqual(loaded.whiteboard.baseline, { elements: scene.elements });
  } finally {
    await ctx.close();
  }
});

test("whiteboard write routes reject cross-origin and unknown sessions", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const crossOrigin = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ source_hash: "x", scene: null }),
    });
    assert.equal(crossOrigin.status, 403);

    const noOrigin = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_hash: "x", scene: null }),
    });
    assert.equal(noOrigin.status, 403);

    const missingSession = await fetch(`${ctx.base}/api/ffffffffffffffff/whiteboard/0`, {
      method: "PUT",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ source_hash: "x", scene: null }),
    });
    assert.equal(missingSession.status, 404);
  } finally {
    await ctx.close();
  }
});

async function frameChannelToken(base, query = "") {
  const frame = await fetch(`${base}/whiteboard-frame${query}`).then((res) => res.text());
  return /__lavishWhiteboardChannelToken="([^"]+)"/.exec(frame)?.[1] || "";
}

async function beginArtifactLoad(ctx) {
  const handoff = await fetch(`${ctx.base}/api/${ctx.key}/chrome-loads/begin`, {
    method: "POST",
    headers: { origin: ctx.base },
  });
  assert.equal(handoff.status, 200);
  const handoffBody = await handoff.json();
  const load = await fetch(`${ctx.base}/api/${ctx.key}/artifact-loads/begin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request_id: "whiteboard-channel-test",
      request_sequence: 1,
      chrome_load_token: handoffBody.chrome_load_token,
    }),
  });
  assert.equal(load.status, 200);
  return load.json();
}

test("whiteboard channel authentication accepts only the frame-issued token", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const token = await frameChannelToken(ctx.base, `?key=${ctx.key}`);
    assert.ok(token);

    const accepted = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard-channel`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ token }),
    });
    assert.equal(accepted.status, 200);

    const rejected = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard-channel`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ token: "forged" }),
    });
    assert.equal(rejected.status, 403);
  } finally {
    await ctx.close();
  }
});

// Regression: a channel token used to be signed over `${now}.${nonce}` alone,
// so any token - including one minted by a request that named no session at
// all - authenticated an arbitrary session's whiteboard channel.
test("a whiteboard channel token minted for another session never authenticates this one", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const foreignToken = await frameChannelToken(ctx.base, "?key=ffffffffffffffff");
    assert.ok(foreignToken);
    const foreign = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard-channel`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ token: foreignToken }),
    });
    assert.equal(foreign.status, 403);

    // A keyless frame request must not yield a usable token either.
    const keyless = await fetch(`${ctx.base}/whiteboard-frame`);
    assert.equal(keyless.status, 400);

    const own = await frameChannelToken(ctx.base, `?key=${ctx.key}`);
    const accepted = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard-channel`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ token: own }),
    });
    assert.equal(accepted.status, 200);
  } finally {
    await ctx.close();
  }
});

test("modern whiteboard channels require the durable page and current live load", async () => {
  const ctx = await startWhiteboardServer();
  try {
    await mkdir(path.join(ctx.dir, "sub"));
    await writeFile(path.join(ctx.dir, "sub", "page.html"), ARTIFACT_HTML);
    await beginArtifactLoad(ctx);
    const page = await pageContext(ctx, "sub/page.html");
    const token = await frameChannelToken(ctx.base, `?key=${ctx.key}`);
    const current = {
      token,
      page_protocol: 1,
      page: page.page,
      page_proof: page.page_proof,
      artifact_load_token: "",
      artifact_revision: 0,
      document_sequence: 1,
    };

    // The active load values are deliberately read from the injected SDK URL: a valid durable
    // proof alone cannot establish a new live channel.
    const document = await fetch(`${ctx.base}/artifact/${ctx.key}/sub/page.html`).then((res) => res.text());
    const sdkUrl = document.match(/<script src="([^"]*\/sdk\.js\?[^"\s]+)"><\/script>/)?.[1];
    assert.ok(sdkUrl);
    const sdkParams = new URL(sdkUrl, ctx.base).searchParams;
    current.artifact_load_token = sdkParams.get("artifact_load_token");
    current.artifact_revision = Number(sdkParams.get("artifact_revision"));

    const establish = () =>
      fetch(`${ctx.base}/api/${ctx.key}/whiteboard-channel`, {
        method: "POST",
        headers: ctx.sameOrigin,
        body: JSON.stringify(current),
      });
    assert.equal((await establish()).status, 200);

    const staleRevision = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard-channel`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ ...current, artifact_revision: current.artifact_revision - 1 }),
    });
    assert.equal(staleRevision.status, 409);

    const advanced = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard-channel`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ ...current, document_sequence: 2 }),
    });
    assert.equal(advanced.status, 200);

    const staleSequence = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard-channel`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ ...current, document_sequence: 1 }),
    });
    assert.equal(staleSequence.status, 409);

    const missingContext = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard-channel`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ token, page_protocol: 1 }),
    });
    assert.equal(missingContext.status, 400);
  } finally {
    await ctx.close();
  }
});

test("feedback-files writes the .excalidraw and PNG sidecars and returns their paths", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const response = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/1/feedback-files`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        scene: { elements: [{ id: "B", type: "ellipse" }], appState: {}, files: {} },
        pngDataUrl: PNG_DATA_URL,
      }),
    });
    assert.equal(response.status, 200);
    const { scene_path, preview_path } = await response.json();
    assert.ok(scene_path.endsWith(`${path.sep}whiteboards${path.sep}${ctx.key}${path.sep}1.excalidraw`));
    const sceneFile = JSON.parse(await readFile(scene_path, "utf8"));
    assert.equal(sceneFile.type, "excalidraw");
    assert.equal(sceneFile.elements[0].id, "B");
    const png = await readFile(preview_path);
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  } finally {
    await ctx.close();
  }
});

test("whiteboard write routes accept payloads beyond the default 2mb JSON cap", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const bigText = "x".repeat(3 * 1024 * 1024);
    const bigScene = { elements: [{ id: "big", type: "text", text: bigText }], appState: {}, files: {} };

    const promptsResponse = await fetch(`${ctx.base}/api/${ctx.key}/prompts`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ prompts: [{ prompt: bigText, tag: "message" }] }),
    });
    assert.equal(promptsResponse.status, 413);

    const whiteboardResponse = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0`, {
      method: "PUT",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ source_hash: "big", scene: bigScene }),
    });
    assert.equal(whiteboardResponse.status, 200);
  } finally {
    await ctx.close();
  }
});

test("whiteboard assets are served with Access-Control-Allow-Origin: * and traversal is blocked", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const bundle = await fetch(`${ctx.base}/whiteboard-assets/whiteboard.js`);
    assert.equal(bundle.status, 200);
    assert.equal(bundle.headers.get("access-control-allow-origin"), "*");

    const font = await fetch(`${ctx.base}/whiteboard-assets/fonts/Excalifont/Excalifont-Regular.woff2`);
    assert.equal(font.status, 200);
    assert.equal(font.headers.get("access-control-allow-origin"), "*");

    const traversal = await fetch(`${ctx.base}/whiteboard-assets/..%2F..%2Fstate.json`);
    assert.equal(traversal.status, 403);

    const missing = await fetch(`${ctx.base}/whiteboard-assets/nope.js`);
    assert.equal(missing.status, 404);
  } finally {
    await ctx.close();
  }
});

test("the whiteboard frame page is served with the sandboxed chrome overlay pointing at it", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const framePage = await fetch(`${ctx.base}/whiteboard-frame?key=${ctx.key}`);
    assert.equal(framePage.status, 200);
    assert.equal(framePage.headers.get("cache-control"), "no-store");
    assert.match(await framePage.text(), /whiteboard-assets\/whiteboard\.js/);

    const chrome = await fetch(`${ctx.base}/session/${ctx.key}`).then((res) => res.text());
    assert.match(chrome, /id="whiteboardFrame"[^>]*sandbox="allow-scripts allow-popups"/);
    assert.doesNotMatch(chrome, /whiteboardFrame[^>]*allow-same-origin/);
    // The artifact iframe's sandbox must be unchanged by this feature.
    assert.match(
      chrome,
      /id="artifact" sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"/,
    );
    assert.doesNotMatch(chrome, /id="artifact"[^>]*allow-same-origin/);
  } finally {
    await ctx.close();
  }
});
