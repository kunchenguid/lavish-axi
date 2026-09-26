import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionStore } from "../src/session-store.js";
import { serve } from "../src/server.js";
import { createPollOutput } from "../src/cli.js";

async function fixture(t, entryName = "entry.html") {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-page-batches-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, entryName);
  await writeFile(file, "<!doctype html><p>entry</p>");
  const stateFile = path.join(root, "state.json");
  const store = new SessionStore(stateFile);
  const session = await store.upsertSession(file, "http://localhost/session/test");
  const handoff = await store.issueReviewerHandoff(session.key);
  const load = await store.beginArtifactLoad(session.key, {
    requestId: "test",
    requestSequence: 1,
    handoffToken: handoff.chrome_load_token,
  });
  return { file, stateFile, store, key: session.key, load };
}

function submission(page, id, snapshot = id) {
  return {
    page_protocol: 1,
    prompts: [{ prompt_id: id, prompt: id, tag: "message", page, page_proof: "proof-" + page }],
    domSnapshot: snapshot,
    snapshot_page: page,
    snapshot_page_proof: "proof-" + page,
  };
}

function failure(load, page, sequence, detail = page) {
  return {
    // The browser's fatal-report wire shape intentionally has no page_protocol.
    page,
    page_proof: "proof-" + page,
    document_sequence: sequence,
    artifact_load_token: load.artifact_load_token,
    artifact_revision: load.artifact_revision,
    failures: [{ kind: "artifact-asset-unavailable", detail }],
  };
}

test("prompt submission delivers ordinary feedback and rejects forged warning pages", async (t) => {
  const { store, key, load } = await fixture(t);
  const ordinary = await store.queuePrompts(key, submission("a.html", "ordinary"));
  assert.equal(ordinary.invalid_page_context, undefined);
  assert.deepEqual(
    (await store.takeFeedback(key)).prompts.map((prompt) => prompt.prompt),
    ["ordinary"],
  );

  const recorded = await store.recordLayoutDiagnostics(
    key,
    {
      page: "a.html",
      page_proof: "proof-a.html",
      document_sequence: 1,
      artifact_load_token: load.artifact_load_token,
      artifact_revision: load.artifact_revision,
      artifact_pass_sequence: 1,
      complete: true,
      viewport_width: 1080,
      findings: [{ selector: "p", kind: "clipped-text", axis: "horizontal", overflowPx: 20, severity: "error" }],
    },
    {
      validatePageContext: async ({ page, proof }) => ({
        ok: page === "a.html" && proof === "proof-a.html",
        page,
        proof,
      }),
    },
  );
  assert.equal(recorded.warnings.length, 1);
  const prepared = await store.prepareLayoutWarningFixes(key, [recorded.warnings[0].id], { page: "a.html" });
  const warningPrompt = { ...prepared.prompt, tag: "layout-warnings", page: "a.html", page_proof: "proof-a.html" };
  const forged = await store.queuePrompts(key, {
    page_protocol: 1,
    prompts: [
      {
        ...warningPrompt,
        target: { ...warningPrompt.target, warnings: [{ ...warningPrompt.target.warnings[0], page: "b.html" }] },
      },
    ],
  });
  assert.equal(forged.invalid_page_context, true);
  assert.equal((await store.takeFeedback(key)).status, "waiting");

  const accepted = await store.queuePrompts(key, { page_protocol: 1, prompts: [warningPrompt] });
  assert.equal(accepted.invalid_page_context, undefined);
  const delivered = await store.takeFeedback(key);
  assert.equal(delivered.prompts[0].target.warnings[0].page, "a.html");
});

test("authenticated failure-only A then B reports form durable FIFO batches without a protocol flag", async (t) => {
  const { store, key, load, stateFile } = await fixture(t);
  const validatePageContext = async ({ page, proof }) => ({ ok: proof === "proof-" + page, page, proof });
  for (const [index, page] of ["a.html", "b.html", "a.html"].entries()) {
    const result = await store.recordArtifactFailures(key, failure(load, page, index + 1, "failure-" + index), {
      validatePageContext,
    });
    assert.equal(result.changed, true);
  }
  const persisted = JSON.parse(await readFile(stateFile, "utf8")).sessions[key];
  assert.deepEqual(
    persisted.feedback_batches?.map((batch) => [batch.page, batch.modern]),
    [
      ["a.html", true],
      ["b.html", true],
      ["a.html", true],
    ],
  );
  const restarted = new SessionStore(stateFile);
  for (const page of ["a.html", "b.html", "a.html"]) {
    const delivered = await restarted.takeFeedback(key);
    assert.deepEqual(delivered.prompts, []);
    assert.deepEqual(
      delivered.artifact_failures.map((item) => item.page),
      [page],
    );
    assert.equal(delivered.dom_snapshot, "");
    assert.equal(delivered.snapshot_page, null);
  }
  assert.equal((await restarted.takeFeedback(key)).status, "waiting");
});

test("partial and rejected fatal page contexts cannot create modern batches while legacy remains legacy", async (t) => {
  const { store, key, load, stateFile } = await fixture(t);
  const valid = failure(load, "a.html", 1);
  const validatePageContext = async ({ page, proof }) => ({
    ok: page === "a.html" && proof === "proof-a.html",
    page,
    proof,
  });
  for (const candidate of [
    { ...valid, page_proof: "forged" },
    { ...valid, page: undefined },
    { ...valid, page_proof: undefined },
    { ...valid, document_sequence: undefined },
    { ...valid, document_sequence: 0 },
    { ...valid, document_sequence: true },
    { ...valid, document_sequence: [1] },
    { ...valid, page: "../a.html" },
  ]) {
    assert.equal((await store.recordArtifactFailures(key, candidate, { validatePageContext })).stale, true);
  }
  // Even trusted in-process callers need a complete page context before inference.
  assert.equal((await store.recordArtifactFailures(key, { ...valid, page_proof: "" })).stale, true);
  assert.equal((await store.recordArtifactFailures(key, { ...valid, page_proof: { forged: true } })).stale, true);
  const legacy = {
    artifact_load_token: load.artifact_load_token,
    artifact_revision: load.artifact_revision,
    failures: [{ kind: "artifact-unavailable", detail: "Legacy entry" }],
  };
  assert.equal((await store.recordArtifactFailures(key, legacy)).changed, true);
  const persisted = JSON.parse(await readFile(stateFile, "utf8")).sessions[key];
  assert.equal(persisted.feedback_batches, undefined);
  const delivered = await store.takeFeedback(key);
  assert.equal(delivered.artifact_failures.length, 1);
  assert.equal(delivered.artifact_failures[0].detail, "Legacy entry");
});

test("camel-case proof-only reports cannot bypass fatal or layout context validation as legacy", async (t) => {
  for (const method of ["recordArtifactFailures", "recordLayoutDiagnostics"]) {
    const { store, key, load } = await fixture(t);
    const legacy = {
      artifact_load_token: load.artifact_load_token,
      artifact_revision: load.artifact_revision,
      artifact_pass_sequence: 1,
      complete: true,
      viewport_width: 1080,
      findings: [{ selector: "html", kind: "page-horizontal-overflow", overflowPx: 20, severity: "error" }],
      failures: [{ kind: "artifact-unavailable", detail: "Legacy entry" }],
    };
    for (const options of [{}, { validatePageContext: async () => ({ ok: false }) }]) {
      for (const pageProof of ["forged", "", null, undefined]) {
        const rejected = await store[method](key, { ...legacy, pageProof }, options);
        assert.equal(rejected.stale, true, method);
        assert.equal(rejected.invalid_page_context, true, method);
      }
    }
    const unchanged = await store.findByKey(key);
    assert.equal(unchanged.artifact_failures.length, 0);
    assert.equal(unchanged.layout_warnings.length, 0);
    const accepted = await store[method](key, legacy);
    assert.equal(
      accepted.changed,
      true,
      "genuine legacy input remains valid and rejected reports do not advance ordering",
    );
  }
});

test("trusted fatal context aliases infer modern batches while unbound pre-SDK failures stay legacy", async (t) => {
  const { store, key, load } = await fixture(t);
  const unbound = {
    artifact_load_token: load.artifact_load_token,
    artifact_revision: load.artifact_revision,
    page: null,
    page_proof: "",
    document_sequence: 0,
    failures: [{ kind: "artifact-unavailable", detail: "Pre-SDK" }],
  };
  assert.equal((await store.recordArtifactFailures(key, unbound)).changed, true);
  const legacy = await store.takeFeedback(key);
  assert.equal(legacy.feedback_batch, undefined);
  assert.equal(legacy.artifact_failures[0].detail, "Pre-SDK");
  for (const [index, page] of ["a.html", "b.html"].entries()) {
    const report = {
      page_protocol: 0,
      page,
      pageProof: "proof-" + page,
      documentSequence: String(index + 1),
      artifactLoadToken: load.artifact_load_token,
      artifactRevision: load.artifact_revision,
      failures: [{ kind: "artifact-asset-unavailable", detail: page }],
    };
    assert.equal((await store.recordArtifactFailures(key, report)).changed, true);
  }
  for (const page of ["a.html", "b.html"]) {
    const delivered = await store.takeFeedback(key);
    assert.equal(delivered.feedback_batch.modern, true);
    assert.deepEqual(
      delivered.artifact_failures.map((failure) => failure.page),
      [page],
    );
  }
});

test("durable page FIFO preserves snapshots, failures, ack retries, reopen and terminal ordering", async (t) => {
  const { store, stateFile, file, key, load } = await fixture(t);
  await store.queuePrompts(key, {
    ...submission("a.html", "a-first"),
    feedback_batch: { page: "b.html", id: "untrusted-restore-metadata", modern: false },
  });
  await store.queuePrompts(key, submission("a.html", "a-latest"));
  await store.recordArtifactFailures(key, failure(load, "a.html", 1));
  await store.queuePrompts(key, submission("b.html", "b-only"));
  await store.recordArtifactFailures(key, failure(load, "b.html", 2));
  const duplicate = await store.queuePrompts(key, submission("a.html", "a-first", "must not replace any snapshot"));
  assert.equal(duplicate.fresh_feedback, false);
  await store.queuePrompts(key, { ...submission("a.html", "a-after-b"), endSession: true });
  const restarted = new SessionStore(stateFile);
  const first = await restarted.takeFeedback(key);
  assert.deepEqual(
    first.prompts.map((prompt) => prompt.prompt),
    ["a-first", "a-latest"],
  );
  assert.equal(first.dom_snapshot, "a-latest");
  assert.equal(first.snapshot_page, "a.html");
  assert.deepEqual(
    first.artifact_failures.map((item) => item.page),
    ["a.html"],
  );
  assert.equal(first.session_ended, undefined, "ending must not hide the remaining B and A batches");
  const second = await restarted.takeFeedback(key);
  assert.deepEqual(
    second.prompts.map((prompt) => prompt.prompt),
    ["b-only"],
  );
  assert.equal(second.dom_snapshot, "b-only");
  assert.deepEqual(
    second.artifact_failures.map((item) => item.page),
    ["b.html"],
  );
  const third = await restarted.takeFeedback(key);
  assert.deepEqual(
    third.prompts.map((prompt) => prompt.prompt),
    ["a-after-b"],
  );
  assert.equal(third.dom_snapshot, "a-after-b");
  assert.equal(third.artifact_failures, undefined);
  assert.equal(third.session_ended, true);
  assert.equal((await restarted.takeFeedback(key)).status, "ended");
  await restarted.upsertSession(file, "http://localhost/reopened");
  assert.equal((await restarted.takeFeedback(key)).status, "waiting");
});

test("failure-only page batches survive reopen without borrowing another page's snapshot", async (t) => {
  const { store, stateFile, file, key, load } = await fixture(t);
  await store.recordArtifactFailures(key, failure(load, "a.html", 1));
  await store.queuePrompts(key, submission("b.html", "b"));
  await store.recordArtifactFailures(key, failure(load, "b.html", 2));
  const restarted = new SessionStore(stateFile);
  await restarted.upsertSession(file, "http://localhost/reopened");
  const first = await restarted.takeFeedback(key);
  assert.deepEqual(first.prompts, []);
  assert.equal(first.dom_snapshot, "");
  assert.equal(first.snapshot_page, null);
  assert.deepEqual(
    first.artifact_failures.map((item) => item.page),
    ["a.html"],
  );
  const second = await restarted.takeFeedback(key);
  assert.equal(second.prompts[0].page, "b.html");
  assert.equal(second.dom_snapshot, "b");
  assert.equal(second.artifact_failures[0].page, "b.html");
});

test("pre-FIFO aggregate state partitions on restart without inventing the lost A snapshot", async (t) => {
  const { stateFile, key } = await fixture(t);
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  const session = state.sessions[key];
  session.prompts = [...submission("a.html", "legacy-a").prompts, ...submission("b.html", "legacy-b").prompts];
  session.artifact_failures = [{ kind: "artifact-unavailable", detail: "A", page: "a.html", severity: "fatal" }];
  session.dom_snapshot = "only B survived in the old schema";
  session.snapshot_page = "b.html";
  session.snapshot_page_proof = "proof-b.html";
  await writeFile(stateFile, JSON.stringify(state));
  const restarted = new SessionStore(stateFile);
  const a = await restarted.takeFeedback(key);
  assert.deepEqual(
    a.prompts.map((prompt) => prompt.page),
    ["a.html"],
  );
  assert.equal(a.dom_snapshot, "");
  assert.equal(a.artifact_failures[0].page, "a.html");
  const b = await restarted.takeFeedback(key);
  assert.deepEqual(
    b.prompts.map((prompt) => prompt.page),
    ["b.html"],
  );
  assert.equal(b.dom_snapshot, "only B survived in the old schema");
});

test("disconnect restoration prepends the original page batch without replacing later snapshots", async (t) => {
  const { store, key } = await fixture(t);
  await store.queuePrompts(key, submission("a.html", "a"));
  const taken = await store.takeFeedback(key);
  await store.queuePrompts(key, submission("b.html", "b"));
  await store.queuePrompts(key, submission("a.html", "new-a"));
  await store.queuePrompts(key, taken, { restore: true });
  await store.queuePrompts(key, taken, { restore: true });
  for (const [page, snapshot] of [
    ["a.html", "a"],
    ["b.html", "b"],
    ["a.html", "new-a"],
  ]) {
    const result = await store.takeFeedback(key);
    assert.deepEqual(
      result.prompts.map((prompt) => prompt.page),
      [page],
    );
    assert.equal(result.dom_snapshot, snapshot);
  }
  assert.equal((await store.takeFeedback(key)).status, "waiting");
});

test("same-page restore retains the latest snapshot or explicit clear without duplicating acknowledgements", async (t) => {
  for (const latest of ["latest", ""]) {
    const { store, key } = await fixture(t);
    await store.queuePrompts(key, submission("a.html", "earlier"));
    const taken = await store.takeFeedback(key);
    await store.queuePrompts(key, submission("a.html", "later", latest));
    await store.queuePrompts(key, taken, { restore: true });
    const session = await store.findByKey(key);
    assert.equal(session.chat.length, 2, "restoration does not append transcript/ack entries");
    const restored = await store.takeFeedback(key);
    assert.deepEqual(
      restored.prompts.map((prompt) => prompt.prompt),
      ["earlier", "later"],
    );
    assert.equal(restored.dom_snapshot, latest);
    assert.equal(restored.snapshot_page, latest ? "a.html" : null);
    assert.equal((await store.takeFeedback(key)).status, "waiting");
  }
});

test("a diagnostic-only restore window does not erase the taken page snapshot", async (t) => {
  const { store, key, load } = await fixture(t);
  await store.queuePrompts(key, submission("a.html", "a-snapshot"));
  const taken = await store.takeFeedback(key);
  await store.recordArtifactFailures(key, failure(load, "a.html", 1));
  await store.queuePrompts(key, taken, { restore: true });
  const restored = await store.takeFeedback(key);
  assert.equal(restored.dom_snapshot, "a-snapshot");
  assert.equal(restored.snapshot_page, "a.html");
  assert.equal(restored.artifact_failures[0].page, "a.html");
});

test("page batching keeps all pending attachment references and rejects modern null or mixed feedback", async (t) => {
  const { store, key, load } = await fixture(t);
  const id = "b".repeat(64) + ".png";
  await store.queuePrompts(key, submission("a.html", "a"));
  const b = submission("b.html", "b");
  await store.queuePrompts(
    key,
    { ...b, prompts: [{ ...b.prompts[0], attachments: [{ id }] }] },
    {
      resolveAttachment: async () => ({
        id,
        name: "b.png",
        mime: "image/png",
        bytes: 5,
        width: 1,
        height: 1,
        path: "/tmp/b.png",
      }),
    },
  );
  await store.takeFeedback(key);
  assert.ok((await store.referencedAttachmentIds()).has(`${key}/${id}`));
  assert.equal((await store.findByKey(key)).pending_prompts, 1);
  assert.equal((await store.findByKey(key)).status, "feedback");
  const invalid = await store.queuePrompts(key, { page_protocol: 1, prompts: [{ prompt: "unknown", page: null }] });
  assert.equal(invalid.invalid_page_context, true);
  const mixed = await store.queuePrompts(key, {
    page_protocol: 1,
    prompts: [...submission("a.html", "x").prompts, ...submission("b.html", "y").prompts],
  });
  assert.equal(mixed.invalid_page_context, true);
  const failed = await store.recordArtifactFailures(key, {
    ...failure(load, null, 1),
    page_protocol: 1,
    page_proof: "",
  });
  assert.equal(failed.invalid_page_context, true);
  const remaining = await store.takeFeedback(key);
  assert.deepEqual(
    remaining.prompts.map((prompt) => prompt.page),
    ["b.html"],
  );
  assert.equal(remaining.artifact_failures, undefined);
});

test("HTTP flagless fatal-only reports reject forged context and poll A then B after restart", async (t) => {
  const { file, stateFile } = await fixture(t);
  for (const page of ["a.html", "b.html"]) await writeFile(path.join(path.dirname(file), page), "<p>Sibling</p>");
  let server = await serve({ port: 0, stateFile });
  t.after(() => server.close());
  let base = `http://127.0.0.1:${server.port}`;
  const post = (route, body = {}) =>
    fetch(`${base}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify(body),
    });
  const session = await (await post("/api/sessions", { file })).json();
  const handoff = await (await post(`/api/${session.key}/chrome-loads/begin`)).json();
  const load = await (
    await post(`/api/${session.key}/artifact-loads/begin`, {
      request_id: "flagless-failures",
      request_sequence: 1,
      chrome_load_token: handoff.chrome_load_token,
    })
  ).json();
  for (const [index, page] of ["a.html", "b.html"].entries()) {
    const html = await fetch(`${base}/artifact/${session.key}/${page}`).then((r) => r.text());
    const script = html.match(/<script src="([^"]*\/sdk\.js\?[^"]+)"><\/script>/)?.[1];
    assert.ok(script);
    const params = new URL(script, base).searchParams;
    const report = { ...failure(load, page, index + 1), page_proof: params.get("page_proof") };
    const proofOnly = {
      artifact_load_token: load.artifact_load_token,
      artifact_revision: load.artifact_revision,
      pageProof: "forged",
      failures: report.failures,
    };
    assert.equal((await post(`/api/${session.key}/artifact-failures`, proofOnly)).status, 400);
    assert.equal(
      (
        await post(`/api/${session.key}/layout-diagnostics`, {
          ...proofOnly,
          artifact_pass_sequence: 1,
          complete: true,
          findings: [],
        })
      ).status,
      400,
    );
    for (const invalid of [
      { ...report, page_proof: "unverified" },
      { ...report, page_proof: undefined },
      { ...report, page: undefined },
      { ...report, document_sequence: 0 },
      { ...report, document_sequence: true },
      { ...report, document_sequence: [index + 1] },
      { ...report, artifact_load_token: "stale" },
    ])
      assert.ok([400, 409].includes((await post(`/api/${session.key}/artifact-failures`, invalid)).status));
    assert.equal((await post(`/api/${session.key}/artifact-failures`, report)).status, 200);
  }
  await server.close();
  server = await serve({ port: 0, stateFile });
  base = `http://127.0.0.1:${server.port}`;
  for (const page of ["a.html", "b.html"]) {
    const delivered = await fetch(`${base}/api/poll?file=${encodeURIComponent(file)}&timeoutMs=0`).then((r) =>
      r.json(),
    );
    assert.deepEqual(delivered.prompts, []);
    assert.deepEqual(
      delivered.artifact_failures.map((item) => item.page),
      [page],
    );
    assert.equal(delivered.dom_snapshot, "");
    assert.equal(delivered.snapshot_page, null);
    assert.equal(delivered.feedback_batch, undefined);
    const output = createPollOutput({ file, response: delivered });
    assert.equal(output.session.file, file);
    assert.equal(output.artifact_failures[0].page, page);
  }
});

test("HTTP and CLI poll deliver A then B after server restart with an exact dot-prefixed entry", async (t) => {
  const { file, stateFile } = await fixture(t, "..report.html");
  for (const page of ["a.html", "b.html"])
    await writeFile(path.join(path.dirname(file), page), "<!doctype html><p>" + page + "</p>");
  let server = await serve({ port: 0, stateFile, version: "page-fifo-test" });
  t.after(() => server.close());
  let base = `http://127.0.0.1:${server.port}`;
  const headers = { "content-type": "application/json", origin: base };
  const opened = await fetch(`${base}/api/sessions`, { method: "POST", headers, body: JSON.stringify({ file }) }).then(
    (r) => r.json(),
  );
  const handoff = await fetch(`${base}/api/${opened.key}/chrome-loads/begin`, { method: "POST", headers }).then((r) =>
    r.json(),
  );
  const load = await fetch(`${base}/api/${opened.key}/artifact-loads/begin`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      request_id: "http-batches",
      request_sequence: 1,
      chrome_load_token: handoff.chrome_load_token,
    }),
  }).then((r) => r.json());
  assert.match(load.artifact_url, /\/\.\.report\.html$/);
  const contexts = new Map();
  for (const page of ["..report.html", "a.html", "b.html"]) {
    const response = await fetch(`${base}/artifact/${opened.key}/${page}`);
    assert.equal(response.status, 200);
    const script = (await response.text()).match(/<script src="([^"]*\/sdk\.js\?[^"]+)"><\/script>/)?.[1];
    assert.ok(script);
    const params = new URL(script, base).searchParams;
    assert.equal(params.get("page"), page);
    contexts.set(page, { page, page_proof: params.get("page_proof") });
  }
  for (const [sequence, page] of ["a.html", "b.html"].entries()) {
    const context = contexts.get(page);
    const diagnostic = await fetch(`${base}/api/${opened.key}/artifact-failures`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...failure(load, page, sequence + 1), ...context }),
    });
    assert.equal(diagnostic.status, 200);
    const submitted = await fetch(`${base}/api/${opened.key}/prompts`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...submission(page, "http-" + sequence),
        prompts: [{ ...context, prompt_id: "http-" + sequence, prompt: "Change " + page, tag: "message" }],
        snapshot_page_proof: context.page_proof,
        endSession: sequence === 1,
      }),
    });
    assert.equal(submitted.status, 200);
  }
  await server.close();
  server = await serve({ port: 0, stateFile, version: "page-fifo-restarted" });
  base = `http://127.0.0.1:${server.port}`;
  for (const [index, page] of ["a.html", "b.html"].entries()) {
    const response = await fetch(`${base}/api/poll?file=${encodeURIComponent(file)}&timeoutMs=0`).then((r) => r.json());
    assert.deepEqual(
      response.prompts.map((prompt) => prompt.page),
      [page],
    );
    assert.deepEqual(
      response.artifact_failures.map((item) => item.page),
      [page],
    );
    assert.equal(response.snapshot_page, page);
    assert.equal(response.dom_snapshot, "http-" + index);
    assert.equal(response.feedback_batch, undefined, "internal restore identity must not reach the agent");
    assert.equal(response.snapshot_page_proof, undefined);
    assert.equal(response.session_ended, index === 1 ? true : undefined);
    const output = createPollOutput({ file, response });
    assert.equal(output.prompts[0].page, page);
    assert.equal(output.snapshot_page, page);
    assert.match(output.next_step, new RegExp(page.replace(".", "\\.")));
    assert.equal(output.session.file, file);
  }
});
