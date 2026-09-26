import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { serve } from "../src/server.js";

async function openAndLoad(base, file) {
  const opened = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file }),
  });
  assert.equal(opened.status, 200);
  const session = await opened.json();
  const handoffResponse = await fetch(`${base}/api/${session.key}/chrome-loads/begin`, {
    method: "POST",
    headers: { origin: base },
  });
  assert.equal(handoffResponse.status, 200);
  const handoff = await handoffResponse.json();
  const loadResponse = await fetch(`${base}/api/${session.key}/artifact-loads/begin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request_id: "routing-test",
      request_sequence: 1,
      chrome_load_token: handoff.chrome_load_token,
    }),
  });
  assert.equal(loadResponse.status, 200);
  const load = await loadResponse.json();
  return { session, handoff, load };
}

function injectedPageContext(base, html) {
  const source = html.match(/<script src="([^"]*\/sdk\.js\?[^"]+)"><\/script>/)?.[1];
  assert.ok(source, "the review document has one injected SDK URL");
  const params = new URL(source, base).searchParams;
  return {
    page: params.get("page"),
    page_proof: params.get("page_proof"),
    route: params.get("served_route"),
  };
}

test("a restarted review keeps its load while feedback moves from entry to authored sibling", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-352-restart-sibling-"));
  const entry = path.join(root, "entry.html");
  const stateFile = path.join(root, "state.json");
  await writeFile(entry, '<!doctype html><a href="sibling.html">Sibling</a>');
  await writeFile(path.join(root, "sibling.html"), "<!doctype html><p>Sibling page</p>");
  let server = await serve({ port: 0, stateFile, version: "restart-sibling-test" });
  try {
    let base = `http://127.0.0.1:${server.port}`;
    const { session, load } = await openAndLoad(base, entry);
    const post = (route, body, origin = base) =>
      fetch(`${base}/api/${session.key}/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify(body),
      });
    const entryFeedback = await post("prompts", {
      page_protocol: 1,
      prompts: [
        {
          uid: "entry-note",
          tag: "p",
          selector: "a",
          prompt: "Review entry",
          page: load.page,
          page_proof: load.page_proof,
        },
      ],
      domSnapshot: "ENTRY SNAPSHOT",
      snapshot_page: load.page,
      snapshot_page_proof: load.page_proof,
    });
    assert.equal(entryFeedback.status, 200);

    await server.close();
    server = await serve({ port: 0, stateFile, version: "restart-sibling-test" });
    base = `http://127.0.0.1:${server.port}`;
    const restored = await post("chrome-loads/begin", {});
    assert.equal(restored.status, 200);
    const restoredHandoff = await restored.json();
    assert.equal(restoredHandoff.artifact_load_token, load.artifact_load_token);
    const siblingHtml = await fetch(`${base}/artifact/${session.key}/sibling.html`).then((response) => response.text());
    const sibling = injectedPageContext(base, siblingHtml);
    const destination = { ...sibling, url: `/artifact/${session.key}/sibling.html`, query: "", fragment: "" };
    const next = await post("artifact-loads/begin", {
      request_id: "authored-sibling-after-restart",
      request_sequence: 2,
      chrome_load_token: restoredHandoff.chrome_load_token,
      destination,
    });
    assert.equal(next.status, 200);
    const siblingLoad = await next.json();
    assert.equal(siblingLoad.page, "sibling.html");
    assert.equal(siblingLoad.artifact_revision, load.artifact_revision + 1);
    assert.equal(
      (
        await post("artifact-failures", {
          failures: [{ kind: "artifact-asset-unavailable", detail: "stale entry" }],
          artifact_load_token: load.artifact_load_token,
          artifact_revision: load.artifact_revision,
          page: load.page,
          page_proof: load.page_proof,
          document_sequence: 1,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await post("artifact-failures", {
          failures: [{ kind: "artifact-asset-unavailable", detail: "wrong proof" }],
          artifact_load_token: siblingLoad.artifact_load_token,
          artifact_revision: siblingLoad.artifact_revision,
          page: siblingLoad.page,
          page_proof: load.page_proof,
          document_sequence: 1,
        })
      ).status,
      400,
    );
    const siblingFeedback = await post("prompts", {
      page_protocol: 1,
      prompts: [
        {
          uid: "sibling-note",
          tag: "p",
          selector: "p",
          prompt: "Review sibling",
          page: siblingLoad.page,
          page_proof: siblingLoad.page_proof,
        },
      ],
      domSnapshot: "SIBLING SNAPSHOT",
      snapshot_page: siblingLoad.page,
      snapshot_page_proof: siblingLoad.page_proof,
    });
    assert.equal(siblingFeedback.status, 200);
    const failure = await post("artifact-failures", {
      failures: [{ kind: "artifact-asset-unavailable", detail: "sibling asset" }],
      artifact_load_token: siblingLoad.artifact_load_token,
      artifact_revision: siblingLoad.artifact_revision,
      page: siblingLoad.page,
      page_proof: siblingLoad.page_proof,
      document_sequence: 1,
    });
    assert.equal(failure.status, 200);

    const first = await fetch(`${base}/api/poll?file=${encodeURIComponent(entry)}&timeoutMs=0`).then((r) => r.json());
    const second = await fetch(`${base}/api/poll?file=${encodeURIComponent(entry)}&timeoutMs=0`).then((r) => r.json());
    assert.deepEqual([first.snapshot_page, second.snapshot_page], ["entry.html", "sibling.html"]);
    assert.deepEqual([first.prompts[0].page, second.prompts[0].page], ["entry.html", "sibling.html"]);
    assert.equal(second.artifact_failures[0].page, "sibling.html");
    assert.equal(second.artifact_failures[0].detail, "sibling asset");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("destination receipts authenticate decoded segments while preserving authored URL spelling", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-url-spelling-")));
  const entry = path.join(root, "entry.html");
  await writeFile(entry, "<p>Entry</p>");
  const server = await serve({ port: 0, stateFile: path.join(root, "state.json") });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const { session, handoff, load } = await openAndLoad(base, entry);
    let sequence = 1;
    let currentLoad = load;
    const post = (route, body) =>
      fetch(`${base}/api/${session.key}/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify(body),
      });
    for (const [file, spelling] of [
      ["a+b.html", "a+b.html"],
      ["a+b.html", "a%2bb.html"],
      ["100%.html", "100%25.html"],
      ["café space.html", "caf%c3%a9%20space.html"],
    ]) {
      await writeFile(path.join(root, file), "<p>Sibling</p>");
      const context = injectedPageContext(
        base,
        await fetch(`${base}/artifact/${session.key}/${spelling}`).then((r) => r.text()),
      );
      const destination = {
        ...context,
        url: `/artifact/${session.key}/${spelling}?author=a+b#part`,
        query: "author=a+b",
        fragment: "part",
      };
      const mint = (candidate) =>
        post("artifact-bindings/validate", {
          ...currentLoad,
          ...context,
          served_route: context.route,
          document_id: "spelling-document",
          destination: candidate,
        });
      const signed = await mint(destination);
      assert.equal(signed.status, 200, spelling);
      const { receipt } = await signed.json();
      for (const unsafe of [
        "sub%2f..%2f" + spelling,
        "%2e%2e/" + spelling,
        "sub/../" + spelling,
        "bad%ZZ.html",
        "sub%5c" + spelling,
        "other.html",
      ]) {
        assert.equal(
          (await mint({ ...destination, url: `/artifact/${session.key}/${unsafe}?author=a+b#part` })).status,
          403,
          unsafe,
        );
      }
      const recovered = await post("artifact-loads/begin", {
        request_id: `spelling-${++sequence}`,
        request_sequence: sequence,
        chrome_load_token: handoff.chrome_load_token,
        historical_page: { ...destination, document_id: "spelling-document", receipt },
      });
      assert.equal(recovered.status, 200);
      currentLoad = await recovered.json();
      assert.equal(currentLoad.artifact_url, destination.url);
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a recovered sibling can be atomically rewritten after its pinned first GET", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-352-rewrite-sibling-"));
  const entry = path.join(root, "entry.html");
  const sibling = path.join(root, "sibling.html");
  const replacement = path.join(root, "replacement.html");
  await writeFile(entry, '<!doctype html><a href="sibling.html">Sibling</a>');
  await writeFile(sibling, "<!doctype html><p>First sibling</p>");
  const server = await serve({ port: 0, stateFile: path.join(root, "state.json"), version: "rewrite-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const { session, handoff } = await openAndLoad(base, entry);
    const route = `/artifact/${session.key}/sibling.html`;
    const context = injectedPageContext(base, await fetch(`${base}${route}`).then((response) => response.text()));
    const destination = { ...context, url: route, query: "", fragment: "" };
    const begin = async (sequence) => {
      const response = await fetch(`${base}/api/${session.key}/artifact-loads/begin`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({
          request_id: `rewrite-${sequence}`,
          request_sequence: sequence,
          chrome_load_token: handoff.chrome_load_token,
          destination,
        }),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    await begin(2);
    await writeFile(replacement, "<!doctype html><p>Changed before first GET</p>");
    await rename(replacement, sibling);
    assert.equal((await fetch(`${base}${route}`)).status, 403, "a pinned first GET rejects a changed inode");

    await begin(3);
    assert.match(await fetch(`${base}${route}`).then((response) => response.text()), /Changed before first GET/);
    await writeFile(replacement, "<!doctype html><p>Changed after first GET</p>");
    await rename(replacement, sibling);
    const reviewed = await fetch(`${base}${route}`);
    assert.equal(reviewed.status, 200, "a later visit reads the current root-contained sibling");
    assert.match(await reviewed.text(), /Changed after first GET/);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("historical destination receipts bind exact URLs and documents across restart, and fail closed on races", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-history-receipts-")));
  const entry = path.join(root, "entry.html");
  const alias = path.join(root, "alias.html");
  const stateFile = path.join(root, "state.json");
  let pauseStat = null;
  const options = {
    port: 0,
    stateFile,
    version: "receipt-test",
    artifactPageStat: async (file, opts) => {
      const details = await stat(file, opts);
      if (pauseStat) {
        const pause = pauseStat;
        pauseStat = null;
        await pause();
      }
      return details;
    },
  };
  await writeFile(entry, "<!doctype html><p>ENTRY</p>");
  await writeFile(path.join(root, "a.html"), "<!doctype html><p>A</p>");
  await writeFile(path.join(root, "b.html"), "<!doctype html><p>B</p>");
  await symlink("a.html", alias);
  let server = await serve(options);
  try {
    let base = `http://127.0.0.1:${server.port}`;
    const opened = await openAndLoad(base, entry);
    const { session } = opened;
    let handoff = opened.handoff;
    let load = opened.load;
    let sequence = 1;
    const post = (route, body) =>
      fetch(`${base}/api/${session.key}/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify(body),
      });
    const begin = (extra = {}) =>
      post("artifact-loads/begin", {
        request_id: `receipt-${++sequence}`,
        request_sequence: sequence,
        chrome_load_token: handoff.chrome_load_token,
        ...extra,
      });
    const html = await fetch(`${base}/artifact/${session.key}/alias.html`).then((r) => r.text());
    const context = injectedPageContext(base, html);
    const destination = {
      ...context,
      url: `/artifact/${session.key}/alias.html?view=one&view=two#part`,
      query: "view=one&view=two",
      fragment: "part",
    };
    const mint = (candidate = destination, documentId = "document-a") =>
      post("artifact-bindings/validate", {
        ...load,
        ...context,
        served_route: context.route,
        document_id: documentId,
        destination: candidate,
      });
    const first = await mint();
    assert.equal(first.status, 200);
    assert.equal((await mint(null)).status, 403, "receipt minting requires a complete destination");
    const receipt = (await first.json()).receipt;
    const historical = { ...destination, document_id: "document-a", receipt };
    const otherDestination = {
      ...destination,
      url: `/artifact/${session.key}/alias.html?view=other#different`,
      query: "view=other",
      fragment: "different",
    };
    const second = await mint(otherDestination);
    assert.equal(second.status, 200);
    const secondReceipt = (await second.json()).receipt;
    assert.notEqual(secondReceipt, receipt);
    for (const changed of [
      { ...historical, document_id: "document-b" },
      { ...historical, ...otherDestination },
      { ...historical, receipt: secondReceipt },
      { ...historical, route: "a.html" },
      { ...historical, url: "https://example.com/alias.html" },
      { ...historical, page: "b.html" },
      { ...historical, receipt: undefined },
    ])
      assert.equal((await begin({ historical_page: changed })).status, 400);

    // Hold binding validation in a filesystem await while another request establishes G2.
    let release = () => {};
    let reached;
    const reachedPromise = new Promise((resolve) => {
      reached = resolve;
    });
    const gate = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    pauseStat = async () => {
      reached();
      await gate;
    };
    const delayedMint = mint();
    await reachedPromise;
    const advanced = await begin();
    assert.equal(advanced.status, 200);
    release();
    const staleMint = await delayedMint;
    assert.equal(staleMint.status, 409);
    assert.deepEqual(await staleMint.json(), { status: "stale" });
    assert.equal((await mint()).status, 409, "stale challenge cannot mint evidence");

    await server.close();
    server = await serve(options);
    base = `http://127.0.0.1:${server.port}`;
    handoff = await post("chrome-loads/begin", {}).then((r) => r.json());
    assert.equal(
      (await begin({ historical_page: historical, chrome_load_token: opened.handoff.chrome_load_token })).status,
      409,
      "a durable receipt does not bypass the current chrome handoff",
    );
    const recovered = await begin({ historical_page: historical });
    assert.equal(recovered.status, 200);
    load = await recovered.json();
    assert.equal(load.artifact_url, destination.url);
    assert.equal((await fetch(`${base}${load.artifact_url}`)).status, 200);

    // The receipt is historical, but the accepted recovery target must also survive until GET.
    await rm(alias);
    await symlink("b.html", alias);
    assert.equal((await fetch(`${base}${load.artifact_url}`)).status, 403);
    assert.equal((await begin({ historical_page: historical })).status, 400);
    await rm(alias);
    await symlink("a.html", alias);
    const nextRecovery = await begin({
      historical_page: { ...otherDestination, document_id: "document-a", receipt: secondReceipt },
    });
    assert.equal(nextRecovery.status, 200);
    assert.equal((await nextRecovery.json()).artifact_url, otherDestination.url);
    await rm(path.join(root, "a.html"));
    assert.equal((await begin({ historical_page: historical })).status, 400);
    assert.equal((await fetch(`${base}${destination.url}`)).status, 404);
    await rm(alias);
    await symlink("b.html", alias);
    assert.equal((await begin()).status, 200);
    assert.equal((await fetch(`${base}${destination.url}`)).status, 200, "target pin is generation scoped");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("issue 352 routes the actual entry basename and keeps legacy virtual index explicit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-352-routing-"));
  const artifact = path.join(root, "report.html");
  try {
    await writeFile(artifact, "<!doctype html><body><main>REPORT ENTRY</main></body>");
    await writeFile(path.join(root, "index.html"), "<!doctype html><body><main>REAL INDEX</main></body>");
    await mkdir(path.join(root, "sub"));
    await writeFile(path.join(root, "sub", "page.htm"), "<!doctype html><body><main>SUB PAGE</main></body>");
    const server = await serve({ port: 0, stateFile: path.join(root, "state.json"), version: "routing-test" });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const { session, load } = await openAndLoad(base, artifact);

      const redirect = await fetch(`${base}/artifact/${session.key}`, { redirect: "manual" });
      assert.equal(redirect.status, 302);
      assert.equal(redirect.headers.get("location"), `/artifact/${session.key}/report.html`);

      const actual = await fetch(`${base}/artifact/${session.key}/report.html`);
      const actualBody = await actual.text();
      assert.equal(actual.status, 200);
      assert.match(actualBody, /REPORT ENTRY/);
      assert.match(actualBody, /page_protocol=1/);
      assert.match(actualBody, /page=report.html/);
      assert.match(actualBody, /page_proof=/);
      assert.match(actualBody, /served_route=report.html/);
      assert.equal((actualBody.match(/<script src="\/sdk\.js\?/g) || []).length, 1);

      const realIndex = await fetch(`${base}/artifact/${session.key}/index.html`);
      const realIndexBody = await realIndex.text();
      assert.equal(realIndex.status, 200);
      assert.match(realIndexBody, /REAL INDEX/);
      assert.doesNotMatch(realIndexBody, /REPORT ENTRY/);
      assert.match(realIndexBody, /page= index\.html|page=index\.html/);

      const legacy = await fetch(
        `${base}/artifact/${session.key}/index.html?artifact_revision=${load.artifact_revision}&artifact_load_token=${encodeURIComponent(load.artifact_load_token)}`,
      );
      const legacyBody = await legacy.text();
      assert.equal(legacy.status, 200);
      assert.match(legacyBody, /REPORT ENTRY/);
      assert.doesNotMatch(legacyBody, /page_protocol=1/);

      const incompleteLegacy = await fetch(
        `${base}/artifact/${session.key}/index.html?artifact_load_token=${encodeURIComponent(load.artifact_load_token)}`,
      );
      assert.equal(incompleteLegacy.status, 409);

      const sibling = await fetch(`${base}/artifact/${session.key}/sub/./page.htm`);
      assert.equal(sibling.status, 200);
      assert.match(await sibling.text(), /page=sub%2Fpage.htm/);

      const proofKey = await fetch(`${base}/artifact/${session.key}/page-proof.key`);
      assert.equal(proofKey.status, 403, "the durable signing key is never an artifact asset");
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "issue 352 preserves literal-backslash POSIX entries without admitting backslash siblings",
  { skip: path.sep !== "/" },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lavish-352-backslash-entry-"));
    const artifact = path.join(root, "report\\final.html");
    const sibling = path.join(root, "sibling\\page.html");
    try {
      await writeFile(artifact, "<!doctype html><body>EXACT BACKSLASH ENTRY</body>");
      await writeFile(sibling, "<!doctype html><body>BACKSLASH SIBLING</body>");
      await symlink(artifact, path.join(root, "alias.html"));
      const server = await serve({ port: 0, stateFile: path.join(root, "state.json"), version: "entry-test" });
      try {
        const base = `http://127.0.0.1:${server.port}`;
        const { session, load } = await openAndLoad(base, artifact);
        const exactUrl = `/artifact/${session.key}/${encodeURIComponent(path.basename(artifact))}`;
        assert.equal(load.artifact_url, exactUrl);
        assert.equal(load.page, path.basename(artifact));
        assert.ok(load.page_proof);

        const redirect = await fetch(`${base}/artifact/${session.key}`, { redirect: "manual" });
        assert.equal(redirect.status, 302);
        assert.equal(redirect.headers.get("location"), exactUrl);

        const entryUrl = new URL(load.artifact_url, base);
        entryUrl.searchParams.set("artifact_revision", String(load.artifact_revision));
        entryUrl.searchParams.set("artifact_load_token", load.artifact_load_token);
        const entryResponse = await fetch(entryUrl);
        const entryBody = await entryResponse.text();
        assert.equal(entryResponse.status, 200);
        assert.match(entryBody, /EXACT BACKSLASH ENTRY/);
        assert.match(entryBody, /<script src="\/sdk\.js\?/);
        assert.match(entryBody, /page_protocol=1/);
        assert.match(entryResponse.headers.get("content-security-policy"), /^sandbox allow-scripts /);
        assert.doesNotMatch(entryResponse.headers.get("content-security-policy"), /frame-ancestors/);
        const sdkSource = entryBody.match(/<script src="([^"]*\/sdk\.js\?[^"]+)">/)[1];
        assert.equal((await fetch(new URL(sdkSource, base))).status, 200);
        const context = { page: load.page, page_proof: load.page_proof };
        const headers = { "content-type": "application/json", origin: base };
        const diagnostic = await fetch(`${base}/api/${session.key}/layout-diagnostics`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...context,
            page_protocol: 1,
            artifact_revision: load.artifact_revision,
            artifact_load_token: load.artifact_load_token,
            artifact_pass_sequence: 1,
            document_sequence: 1,
            complete: true,
            viewport_width: 1440,
            findings: [{ selector: "p", kind: "clipped-text", axis: "vertical", overflowPx: 30, severity: "error" }],
          }),
        });
        assert.equal(diagnostic.status, 200);
        assert.equal((await diagnostic.json()).warnings[0].page, path.basename(artifact));
        const sdkUrl = new URL(sdkSource, base);
        sdkUrl.searchParams.set("served_route", path.basename(sibling));
        assert.equal((await fetch(sdkUrl)).status, 403, "entry proof does not authorize a sibling backslash route");
        sdkUrl.searchParams.set("served_route", "ordinary.html");
        assert.equal((await fetch(sdkUrl)).status, 403, "exact-entry proof also requires the exact served route");
        const saved = await fetch(`${base}/api/${session.key}/whiteboard/0`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ ...context, source_hash: "entry", scene: { elements: [{ id: "entry-scene" }] } }),
        });
        assert.equal(saved.status, 200);
        const legacyScene = await fetch(`${base}/api/${session.key}/whiteboard/0`).then((r) => r.json());
        assert.equal(legacyScene.whiteboard.scene.elements[0].id, "entry-scene");
        const sources = await fetch(`${base}/api/${session.key}/mermaid-sources?${new URLSearchParams(context)}`, {
          headers,
        });
        assert.equal(sources.status, 200);
        const queued = await fetch(`${base}/api/${session.key}/prompts`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            page_protocol: 1,
            prompts: [{ uid: "exact-entry", tag: "p", selector: "p", prompt: "Review exact entry", ...context }],
            domSnapshot: "EXACT ENTRY SNAPSHOT",
            snapshot_page: load.page,
            snapshot_page_proof: load.page_proof,
          }),
        });
        assert.equal(queued.status, 200);
        const feedback = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`).then((r) =>
          r.json(),
        );
        assert.equal(feedback.prompts[0].page, path.basename(artifact));
        assert.equal(feedback.snapshot_page, path.basename(artifact));

        const siblingResponse = await fetch(
          `${base}/artifact/${session.key}/${encodeURIComponent(path.basename(sibling))}`,
        );
        const siblingBody = await siblingResponse.text();
        assert.equal(siblingResponse.status, 403);
        assert.doesNotMatch(siblingBody, /BACKSLASH SIBLING/);
        assert.equal(
          (await fetch(`${base}/artifact/${session.key}/alias.html`)).status,
          403,
          "an ordinary sibling alias cannot invoke the exact saved-entry exception",
        );
      } finally {
        await server.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("issue 352 artifact reads reject a validated path swapped to an outside symlink", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-352-artifact-swap-"));
  const outside = await mkdtemp(path.join(tmpdir(), "lavish-352-artifact-outside-"));
  const artifact = path.join(root, "entry.html");
  const secret = "OUTSIDE_ARTIFACT_SENTINEL";
  let swapped = false;
  try {
    await writeFile(artifact, "<!doctype html><body>INSIDE</body>");
    const canonicalArtifact = await realpath(artifact);
    const outsideFile = path.join(outside, "secret.html");
    await writeFile(outsideFile, secret);
    const server = await serve({
      port: 0,
      stateFile: path.join(root, "state.json"),
      version: "artifact-swap-test",
      artifactPageStat: async (file, options) => {
        if (!swapped && file === canonicalArtifact) {
          swapped = true;
          await rm(canonicalArtifact);
          await symlink(outsideFile, canonicalArtifact);
        }
        return stat(file, options);
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const opened = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: artifact }),
      }).then((response) => response.json());
      const response = await fetch(`${base}/artifact/${opened.key}/entry.html`);
      const body = await response.text();
      assert.equal(response.status, 403);
      assert.equal(swapped, true);
      assert.doesNotMatch(body, new RegExp(secret));
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("issue 352 sdk route rejects tampered proofs and tokenless page-aware loads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-352-sdk-"));
  const artifact = path.join(root, "entry.html");
  try {
    await writeFile(artifact, "<!doctype html><body><main>ENTRY</main></body>");
    const server = await serve({ port: 0, stateFile: path.join(root, "state.json"), version: "sdk-test" });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const { session } = await openAndLoad(base, artifact);
      const document = await fetch(`${base}/artifact/${session.key}/entry.html`);
      const html = await document.text();
      const script = html.match(/<script src="([^"]*\/sdk\.js\?[^"]+)"><\/script>/)?.[1];
      assert.ok(script);
      const sdkUrl = new URL(script, base);
      const proof = sdkUrl.searchParams.get("page_proof");
      assert.ok(proof);
      sdkUrl.searchParams.set("page_proof", `${proof.slice(0, -1)}${proof.endsWith("A") ? "B" : "A"}`);
      const forged = await fetch(sdkUrl);
      assert.equal(forged.status, 403);

      const recoveryUrl = new URL(`${base}/sdk.js`);
      recoveryUrl.searchParams.set("key", session.key);
      recoveryUrl.searchParams.set("page_protocol", "1");
      recoveryUrl.searchParams.set("page", "entry.html");
      recoveryUrl.searchParams.set("page_proof", proof);
      recoveryUrl.searchParams.set("served_route", "entry.html");
      recoveryUrl.searchParams.delete("artifact_revision");
      recoveryUrl.searchParams.delete("artifact_load_token");
      const recovery = await fetch(recoveryUrl);
      assert.equal(recovery.status, 409);
      assert.deepEqual(await recovery.json(), { status: "stale" });
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("issue 352 begin-load freshly validates and returns the proven current destination", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-352-reload-destination-"));
  const artifact = path.join(root, "entry.html");
  try {
    await writeFile(artifact, "<!doctype html><body><a href='sub/page.html'>Sibling</a></body>");
    await mkdir(path.join(root, "sub"));
    await writeFile(path.join(root, "sub", "page.html"), "<!doctype html><body>SIBLING</body>");
    const server = await serve({ port: 0, stateFile: path.join(root, "state.json"), version: "reload-test" });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const { session, handoff, load } = await openAndLoad(base, artifact);
      const siblingHtml = await fetch(`${base}/artifact/${session.key}/sub/page.html`).then((response) =>
        response.text(),
      );
      const context = injectedPageContext(base, siblingHtml);
      const destination = {
        ...context,
        url: `/artifact/${session.key}/sub/page.html?view=full&view=print#section-2`,
        query: "view=full&view=print",
        fragment: "section-2",
      };
      const begin = (requestId, requestSequence, candidate) =>
        fetch(`${base}/api/${session.key}/artifact-loads/begin`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            request_id: requestId,
            request_sequence: requestSequence,
            chrome_load_token: handoff.chrome_load_token,
            destination: candidate,
          }),
        });

      const receiptResponse = await fetch(`${base}/api/${session.key}/artifact-bindings/validate`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({
          ...load,
          ...context,
          served_route: context.route,
          document_id: "history-document",
          destination,
        }),
      });
      assert.equal(receiptResponse.status, 200);
      const { receipt } = await receiptResponse.json();
      const historicalPage = { ...destination, document_id: "history-document", receipt };
      const acceptedResponse = await begin("reload-sibling", 2, destination);
      assert.equal(acceptedResponse.status, 200);
      const accepted = await acceptedResponse.json();
      assert.equal(accepted.artifact_url, `/artifact/${session.key}/sub/page.html?view=full&view=print#section-2`);
      assert.equal(accepted.artifact_revision, load.artifact_revision + 1);
      assert.equal(accepted.page, "sub/page.html");
      assert.equal(accepted.page_proof, context.page_proof);
      assert.equal(accepted.served_route, "sub/page.html");

      const recoveredResponse = await fetch(`${base}/api/${session.key}/artifact-loads/begin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: "recover-history",
          request_sequence: 3,
          chrome_load_token: handoff.chrome_load_token,
          historical_page: historicalPage,
        }),
      });
      assert.equal(recoveredResponse.status, 200);
      const recovered = await recoveredResponse.json();
      assert.equal(recovered.artifact_url, destination.url);
      assert.equal(recovered.page, "sub/page.html");
      assert.equal(recovered.served_route, "sub/page.html");
      assert.equal(recovered.artifact_revision, accepted.artifact_revision + 1);

      const forgedRecovery = await fetch(`${base}/api/${session.key}/artifact-loads/begin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: "forged-history",
          request_sequence: 4,
          chrome_load_token: handoff.chrome_load_token,
          historical_page: { page: context.page, page_proof: "x".repeat(43) },
        }),
      });
      assert.equal(forgedRecovery.status, 400);
      assert.deepEqual(await forgedRecovery.json(), { status: "invalid-destination" });

      const tampered = await begin("tampered-proof", 5, { ...destination, page_proof: "x".repeat(43) });
      assert.equal(tampered.status, 400);
      assert.deepEqual(await tampered.json(), { status: "invalid-destination" });

      const external = await begin("external-url", 6, { ...destination, url: "https://example.com/page.html" });
      assert.equal(external.status, 400);

      const reserved = await begin("reserved-query", 7, {
        ...destination,
        url: `/artifact/${session.key}/sub/page.html?__lavish_reload=authored#section-2`,
        query: "__lavish_reload=authored",
      });
      assert.equal(reserved.status, 400);

      const revision = await fetch(`${base}/api/${session.key}/layout-warnings`).then((response) => response.json());
      assert.equal(revision.revision, recovered.artifact_revision, "rejected destinations never advance the load");

      await rm(path.join(root, "sub", "page.html"));
      const deleted = await begin("deleted-page", 8, destination);
      assert.equal(deleted.status, 400, "a historical proof is not fresh file-read authorization");
      assert.deepEqual(await deleted.json(), { status: "invalid-destination" });

      const deletedRecovery = await fetch(`${base}/api/${session.key}/artifact-loads/begin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: "deleted-history",
          request_sequence: 9,
          chrome_load_token: handoff.chrome_load_token,
          historical_page: historicalPage,
        }),
      });
      assert.equal(deletedRecovery.status, 400);

      await writeFile(path.join(root, "sub", "page.html"), "<!doctype html><body>REPLACED</body>");
      const retargeted = await begin("retargeted-page", 10, {
        ...destination,
        route: "entry.html",
        url: `/artifact/${session.key}/entry.html?view=full&view=print#section-2`,
        fallback_to_entry: true,
      });
      assert.equal(retargeted.status, 400);
      assert.deepEqual(await retargeted.json(), { status: "invalid-destination" });
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("issue 352 fatal document failures retain the accepted page before SDK binding", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-352-pending-failure-"));
  const artifact = path.join(root, "entry.html");
  try {
    await writeFile(artifact, "<!doctype html><body>ENTRY</body>");
    await mkdir(path.join(root, "sub"));
    const sibling = path.join(root, "sub", "page.html");
    await writeFile(sibling, "<!doctype html><body>SIBLING</body>");
    const server = await serve({ port: 0, stateFile: path.join(root, "state.json"), version: "failure-test" });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const { session, handoff } = await openAndLoad(base, artifact);
      const context = injectedPageContext(
        base,
        await fetch(`${base}/artifact/${session.key}/sub/page.html`).then((response) => response.text()),
      );
      const acceptedResponse = await fetch(`${base}/api/${session.key}/artifact-loads/begin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: "pending-failure",
          request_sequence: 2,
          chrome_load_token: handoff.chrome_load_token,
          destination: {
            ...context,
            url: `/artifact/${session.key}/sub/page.html`,
            query: "",
            fragment: "",
          },
        }),
      });
      assert.equal(acceptedResponse.status, 200);
      const accepted = await acceptedResponse.json();
      assert.equal(accepted.page, "sub/page.html");
      assert.equal(accepted.page_proof, context.page_proof);

      await rm(sibling);
      const documentUrl = new URL(accepted.artifact_url, base);
      documentUrl.searchParams.set("artifact_revision", String(accepted.artifact_revision));
      documentUrl.searchParams.set("artifact_load_token", accepted.artifact_load_token);
      const document = await fetch(documentUrl);
      assert.equal(document.status, 404);

      const recorded = await fetch(`${base}/api/${session.key}/artifact-failures`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({
          failures: [{ kind: "artifact-unavailable", detail: "the artifact document responded with HTTP 404" }],
          artifact_load_token: accepted.artifact_load_token,
          artifact_revision: accepted.artifact_revision,
          page: accepted.page,
          page_proof: accepted.page_proof,
          document_sequence: 1,
        }),
      });
      assert.equal(recorded.status, 200);

      const feedback = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`).then(
        (response) => response.json(),
      );
      assert.equal(feedback.status, "feedback");
      assert.equal(feedback.artifact_failures[0].page, "sub/page.html");
      assert.equal(feedback.artifact_failures[0].page_proof, undefined);
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("issue 352 authenticates a live page binding before chrome activation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-352-binding-"));
  const artifact = path.join(root, "entry.html");
  try {
    await writeFile(artifact, "<!doctype html><body>ENTRY</body>");
    await writeFile(path.join(root, "other.html"), "<!doctype html><body>OTHER</body>");
    const server = await serve({ port: 0, stateFile: path.join(root, "state.json"), version: "binding-test" });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const { session, load } = await openAndLoad(base, artifact);
      const entryContext = injectedPageContext(
        base,
        await fetch(`${base}/artifact/${session.key}/entry.html`).then((response) => response.text()),
      );
      const otherContext = injectedPageContext(
        base,
        await fetch(`${base}/artifact/${session.key}/other.html`).then((response) => response.text()),
      );
      const validate = (body, origin = base) =>
        fetch(`${base}/api/${session.key}/artifact-bindings/validate`, {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify(body),
        });
      const binding = {
        page: entryContext.page,
        page_proof: entryContext.page_proof,
        served_route: entryContext.route,
        artifact_load_token: load.artifact_load_token,
        artifact_revision: load.artifact_revision,
      };

      assert.equal((await validate(binding)).status, 204);
      assert.equal((await validate({ ...binding, page_proof: otherContext.page_proof })).status, 403);
      assert.equal((await validate({ ...binding, served_route: "other.html" })).status, 403);
      assert.equal((await validate({ ...binding, artifact_load_token: "stale" })).status, 409);
      assert.equal((await validate(binding, "http://attacker.invalid")).status, 403);
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("issue 352 rejects cross-page sends and warning selections while accepting one authenticated page", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-page-queue-"));
  const entry = path.join(root, "a.html");
  let server;
  try {
    await writeFile(entry, "<!doctype html><p>A</p>");
    await writeFile(path.join(root, "b.html"), "<!doctype html><p>B</p>");
    server = await serve({ port: 0, stateFile: path.join(root, "state.json"), version: "page-queue-test" });
    const base = `http://127.0.0.1:${server.port}`;
    const { session, load } = await openAndLoad(base, entry);
    const contexts = [];
    const headers = { "content-type": "application/json", origin: base };
    const post = (route, body) =>
      fetch(`${base}/api/${session.key}/${route}`, { method: "POST", headers, body: JSON.stringify(body) });
    for (const [index, page] of ["a.html", "b.html"].entries()) {
      const context = injectedPageContext(
        base,
        await fetch(`${base}/artifact/${session.key}/${page}`).then((r) => r.text()),
      );
      contexts.push(context);
      const diagnostic = await post("layout-diagnostics", {
        ...context,
        page_protocol: 1,
        artifact_revision: load.artifact_revision,
        artifact_load_token: load.artifact_load_token,
        artifact_pass_sequence: 1,
        document_sequence: index + 1,
        complete: true,
        viewport_width: 1440,
        findings: [{ selector: "p", kind: "clipped-text", axis: "vertical", overflowPx: 30, severity: "error" }],
      });
      assert.equal(diagnostic.status, 200);
    }
    const warnings = (await fetch(`${base}/api/${session.key}/layout-warnings`).then((r) => r.json())).warnings;
    assert.equal(warnings.length, 2);
    const ids = warnings.map((warning) => warning.id);
    assert.equal((await post("layout-warnings/queue", { page_protocol: 1, ...contexts[0], ids })).status, 400);
    assert.equal(
      (await post("layout-warnings/queue", { ids })).status,
      400,
      "legacy shape cannot create a mixed-page batch",
    );
    const aIds = warnings.filter((warning) => warning.page === "a.html").map((warning) => warning.id);
    const prepared = await post("layout-warnings/queue", { page_protocol: 1, ...contexts[0], ids: aIds });
    assert.equal(prepared.status, 200);
    const aPrompt = (await prepared.json()).prompt;
    const bId = warnings.find((warning) => warning.page === "b.html").id;
    assert.notEqual(bId, aPrompt.target.warnings[0].id);
    const legacyWrongPage = await post("prompts", {
      prompts: [
        {
          ...aPrompt,
          tag: "layout-warnings",
          page: undefined,
          page_proof: undefined,
          target: { ...aPrompt.target, warnings: [{ id: bId }] },
        },
      ],
    });
    const legacyWrongPageBody = await legacyWrongPage.json();
    assert.equal(
      legacyWrongPage.status,
      400,
      `legacy prompts cannot queue a sibling warning under the entry page: ${JSON.stringify(legacyWrongPageBody)}`,
    );
    assert.equal(legacyWrongPageBody.status, "invalid-page-context");
    const prompts = contexts.map((context) => ({ ...context, prompt: "page note", tag: "message" }));
    assert.equal((await post("prompts", { page_protocol: 1, prompts })).status, 400);
    assert.equal(
      (
        await post("prompts", {
          page_protocol: 1,
          prompts: [prompts[0]],
          domSnapshot: "B snapshot",
          snapshot_page: contexts[1].page,
          snapshot_page_proof: contexts[1].page_proof,
        })
      ).status,
      400,
    );
    assert.equal(
      (await post("prompts", { page_protocol: 1, prompts: [{ ...aPrompt, tag: "layout-warnings", ...contexts[1] }] }))
        .status,
      400,
      "warning IDs cannot be restamped as another page",
    );
    const accepted = await post("prompts", {
      page_protocol: 1,
      prompts: [{ ...aPrompt, tag: "layout-warnings", ...contexts[0] }],
    });
    assert.equal(accepted.status, 200);
    const feedback = await fetch(`${base}/api/poll?file=${encodeURIComponent(entry)}&timeoutMs=0`).then((r) =>
      r.json(),
    );
    assert.equal(feedback.prompts.length, 1);
    assert.equal(feedback.prompts[0].page, "a.html");
    assert.equal(feedback.prompts[0].target.warnings[0].page, "a.html");
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("issue 352 validates page claims atomically and keeps proofs out of poll output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-352-context-"));
  const artifact = path.join(root, "entry.html");
  try {
    await writeFile(artifact, "<!doctype html><body><main>ENTRY CONTEXT</main></body>");
    const server = await serve({ port: 0, stateFile: path.join(root, "state.json"), version: "context-test" });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const { session } = await openAndLoad(base, artifact);
      const document = await fetch(`${base}/artifact/${session.key}/entry.html`);
      const html = await document.text();
      const script = html.match(/<script src="([^"]*\/sdk\.js\?[^"]+)"><\/script>/)?.[1];
      assert.ok(script);
      const sdkUrl = new URL(script, base);
      const proof = sdkUrl.searchParams.get("page_proof");
      assert.ok(proof);

      const invalid = await fetch(`${base}/api/${session.key}/prompts`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({
          page_protocol: 1,
          prompts: [
            {
              uid: "good-but-mixed",
              prompt: "must not persist either",
              selector: "main",
              tag: "main",
              text: "ENTRY CONTEXT",
              page: "entry.html",
              page_proof: proof,
            },
            {
              uid: "bad",
              prompt: "must not persist",
              selector: "main",
              tag: "main",
              text: "ENTRY CONTEXT",
              // This used to be normalized to null before the server saw it, which made the
              // malformed claim indistinguishable from an intentional page:null annotation.
              page: "/outside.html",
              page_proof: "",
            },
          ],
          domSnapshot: 'uid=good-but-mixed main "must not persist either"',
          snapshot_page: "entry.html",
          snapshot_page_proof: proof,
        }),
      });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).status, "invalid-page-context");
      const afterInvalid = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`).then(
        (response) => response.json(),
      );
      assert.equal(afterInvalid.status, "waiting");

      const malformedShape = await fetch(`${base}/api/${session.key}/prompts`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({
          page_protocol: 1,
          prompts: [
            {
              uid: "array-page",
              prompt: "array page must not persist",
              selector: "main",
              tag: "main",
              text: "ENTRY CONTEXT",
              // A String(array) coercion would turn this into the valid page identity.
              page: ["entry.html"],
              page_proof: proof,
            },
          ],
          snapshot_page: null,
          snapshot_page_proof: "",
        }),
      });
      assert.equal(malformedShape.status, 400);
      assert.equal((await malformedShape.json()).status, "invalid-page-context");
      const afterMalformedShape = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`).then(
        (response) => response.json(),
      );
      assert.equal(afterMalformedShape.status, "waiting");

      const legacyQueued = await fetch(`${base}/api/${session.key}/prompts`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({
          page_protocol: 1,
          prompts: [
            {
              uid: "legacy",
              prompt: "preserve pre-feature writing",
              selector: "main",
              tag: "main",
              text: "ENTRY CONTEXT",
              page: null,
              page_proof: "",
            },
          ],
          domSnapshot: "",
          snapshot_page: null,
          snapshot_page_proof: "",
        }),
      });
      assert.equal(legacyQueued.status, 400, "modern unavailable-page feedback cannot be sent as a page batch");
      const legacyFeedback = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`).then(
        (response) => response.json(),
      );
      assert.equal(legacyFeedback.status, "waiting");

      const accepted = await fetch(`${base}/api/${session.key}/prompts`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({
          page_protocol: 1,
          prompts: [
            {
              uid: "good",
              prompt: "keep the page",
              selector: "main",
              tag: "main",
              text: "ENTRY CONTEXT",
              page: "entry.html",
              page_proof: proof,
            },
          ],
          domSnapshot: 'uid=good main "ENTRY CONTEXT"',
          snapshot_page: "entry.html",
          snapshot_page_proof: proof,
        }),
      });
      assert.equal(accepted.status, 200);

      const feedback = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`).then(
        (response) => response.json(),
      );
      assert.equal(feedback.status, "feedback");
      assert.equal(feedback.prompts[0].page, "entry.html");
      assert.equal(feedback.prompts[0].page_proof, undefined);
      assert.equal(feedback.snapshot_page, "entry.html");
      assert.equal(feedback.snapshot_page_proof, undefined);
      assert.match(feedback.dom_snapshot, /ENTRY CONTEXT/);
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
