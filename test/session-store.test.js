import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ATTACHMENT_DELIVERY_GRACE_MS,
  MAX_DELIVERED_ATTACHMENTS,
  MAX_REQUEST_ATTACHMENT_REFS,
  SessionStore,
} from "../src/session-store.js";

let beginRequestSequence = 0;

async function beginArtifactLoad(store, key) {
  const context = await store.issueReviewerHandoff(key);
  const requestSequence = context.artifact_load_sequence + 1;
  const load = await store.beginArtifactLoad(key, {
    requestId: `test-load-${++beginRequestSequence}`,
    requestSequence,
    handoffToken: context.chrome_load_token,
  });
  assert.ok(load?.artifact_load_token);
  return load;
}

function diagnosticPayload(load, sequence, body = {}) {
  return {
    artifact_load_token: load.artifact_load_token,
    artifact_revision: load.artifact_revision,
    artifact_pass_sequence: sequence,
    ...body,
  };
}

function feedbackResult(result) {
  assert.equal(result.status, "feedback");
  return /** @type {{ status: string, dom_snapshot: string, prompts: any[], artifact_failures?: any[], session_ended?: boolean, ended_by?: string }} */ (
    result
  );
}

test("queued prompts are returned with DOM snapshot context and then cleared", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.queuePrompts(session.key, {
      domSnapshot: 'uid=1 h1 "Hello"',
      prompts: [{ uid: "1", prompt: "Make this warmer", selector: "h1", tag: "h1", text: "Hello" }],
    });

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(first.dom_snapshot, 'uid=1 h1 "Hello"');
    assert.deepEqual(first.prompts, [
      { uid: "1", prompt: "Make this warmer", selector: "h1", tag: "h1", text: "Hello" },
    ]);

    const second = await store.takeFeedback(session.key);
    assert.equal(second.status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("queued text selection prompts preserve range anchors", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<p id='intro'>Hello <strong>bright</strong> world</p>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const target = {
      type: "text-range",
      text: "lo bright wo",
      selector: "p#intro",
      start: { selector: "p#intro", path: [0], offset: 3 },
      end: { selector: "p#intro", path: [2], offset: 3 },
    };

    await store.queuePrompts(session.key, {
      prompts: [
        { uid: "", prompt: "Make this phrase punchier", selector: "p#intro", tag: "text", text: target.text, target },
      ],
    });

    const result = feedbackResult(await store.takeFeedback(session.key));
    assert.deepEqual(result.prompts, [
      { uid: "", prompt: "Make this phrase punchier", selector: "p#intro", tag: "text", text: target.text, target },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("queued mermaid node prompts preserve node identity and drop unknown fields", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<div class='mermaid'>graph TD; A-->B;</div>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const target = {
      type: "mermaid-node",
      diagramId: "mermaid-7",
      nodeId: "flowchart-HomeAgentChat-3",
      label: "HomeAgentChat",
      selector: "svg#mermaid-7 > g > g.node",
      // A hostile/legacy field that must be stripped by the normalizer:
      injected: { nested: "should not survive" },
    };

    await store.queuePrompts(session.key, {
      prompts: [
        {
          uid: "",
          prompt: "This is where the orphan happens",
          selector: target.selector,
          tag: "mermaid-node",
          text: target.label,
          target,
        },
      ],
    });

    const result = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(result.prompts.length, 1);
    assert.deepEqual(result.prompts[0].target, {
      type: "mermaid-node",
      diagramId: "mermaid-7",
      nodeId: "flowchart-HomeAgentChat-3",
      label: "HomeAgentChat",
      selector: "svg#mermaid-7 > g > g.node",
    });
    assert.equal(result.prompts[0].tag, "mermaid-node");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("queued whiteboard prompts normalize the excalidraw-scene target to its fixed shape", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<div class='mermaid'>graph TD; A-->B;</div>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");

    await store.queuePrompts(session.key, {
      prompts: [
        {
          uid: "",
          prompt: "Whiteboard edits:\nMoved rectangle (Auth)",
          selector: "",
          tag: "whiteboard",
          text: "Whiteboard edits",
          target: {
            type: "excalidraw-scene",
            diagramIndex: "1",
            diagramId: "mermaid-2",
            sourceHash: "abc123def4567890",
            scenePath: "/state/whiteboards/k/1.excalidraw",
            previewPath: "/state/whiteboards/k/1.png",
            imageFallback: false,
            stats: { added: 1, removed: 0, moved: 2, relabeled: 0, drawn: 1 },
            hostile: { nested: "should not survive" },
          },
        },
      ],
    });

    const result = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(result.prompts.length, 1);
    assert.equal(result.prompts[0].tag, "whiteboard");
    assert.deepEqual(result.prompts[0].target, {
      type: "excalidraw-scene",
      diagramIndex: 1,
      diagramId: "mermaid-2",
      sourceHash: "abc123def4567890",
      scenePath: "/state/whiteboards/k/1.excalidraw",
      previewPath: "/state/whiteboards/k/1.png",
      imageFallback: false,
      stats: { added: 1, removed: 0, moved: 2, relabeled: 0, drawn: 1 },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a diagnostic pass records warnings passively and never becomes agent feedback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const load = await beginArtifactLoad(store, session.key);
    const result = await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(load, 1, {
        complete: true,
        viewport_width: 720,
        findings: [
          {
            selector: "html",
            kind: "page-horizontal-overflow",
            overflowPx: 24.5,
            viewportWidth: 720,
            severity: "error",
          },
        ],
      }),
    );

    assert.equal(result.changed, true);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].status, "open");
    assert.equal(result.warnings[0].active, true);
    assert.equal(result.warnings[0].selectable, true);
    // The whole point of the passive inbox: detection alone must not make poll return.
    const feedback = await store.takeFeedback(session.key);
    assert.equal(feedback.status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a newer begun load invalidates an older diagnostic atomically", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const load = await beginArtifactLoad(store, session.key);
    const newerContext = await store.issueReviewerHandoff(session.key);
    await Promise.all([
      store.beginArtifactLoad(session.key, {
        requestId: "newer-load",
        requestSequence: newerContext.artifact_load_sequence + 1,
        handoffToken: newerContext.chrome_load_token,
      }),
      store.recordLayoutDiagnostics(
        session.key,
        diagnosticPayload(load, 1, {
          complete: true,
          viewport_width: 1440,
          findings: [{ selector: "html", kind: "page-horizontal-overflow", overflowPx: 24, severity: "error" }],
        }),
      ),
    ]);

    const updated = await store.findByKey(session.key);
    assert.equal(updated.artifact_revision, 2);
    assert.equal(updated.layout_warnings.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a retried begin request reuses the same load epoch", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const context = await store.issueReviewerHandoff(session.key);
    const first = await store.beginArtifactLoad(session.key, {
      requestId: "request-1",
      requestSequence: 1,
      handoffToken: context.chrome_load_token,
    });
    const retry = await store.beginArtifactLoad(session.key, {
      requestId: "request-1",
      requestSequence: 1,
      handoffToken: context.chrome_load_token,
    });
    const next = await store.beginArtifactLoad(session.key, {
      requestId: "request-2",
      requestSequence: 2,
      handoffToken: context.chrome_load_token,
    });

    assert.equal(retry.artifact_revision, first.artifact_revision);
    assert.equal(retry.artifact_load_token, first.artifact_load_token);
    assert.equal(next.artifact_revision, first.artifact_revision + 1);
    assert.notEqual(next.artifact_load_token, first.artifact_load_token);

    const stale = await store.beginArtifactLoad(session.key, {
      requestId: "request-1",
      requestSequence: 1,
      handoffToken: context.chrome_load_token,
    });
    assert.equal(stale.stale, "out-of-order");
    assert.equal(stale.artifact_revision, next.artifact_revision);
    assert.equal(stale.artifact_load_token, next.artifact_load_token);
    assert.equal((await store.findByKey(session.key)).artifact_revision, next.artifact_revision);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reopening a session preserves the live reviewer handoff and artifact load", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const handoff = await store.issueReviewerHandoff(session.key);
    const load = await store.beginArtifactLoad(session.key, {
      requestId: "live-load",
      requestSequence: 1,
      handoffToken: handoff.chrome_load_token,
    });
    const before = await store.verifyArtifactLoad(session.key, load.artifact_load_token, load.artifact_revision);

    await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const after = await store.verifyArtifactLoad(session.key, load.artifact_load_token, load.artifact_revision);
    const next = await store.beginArtifactLoad(session.key, {
      requestId: "next-load",
      requestSequence: 2,
      handoffToken: handoff.chrome_load_token,
    });

    assert.equal(before.valid, true);
    assert.equal(after.valid, true);
    assert.equal(next.artifact_revision, load.artifact_revision + 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("typed handoff outcomes separate superseded and no-handoff begins", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const noHandoff = await store.beginArtifactLoad(session.key, {
      requestId: "missing",
      requestSequence: 1,
      handoffToken: "",
    });
    assert.equal(noHandoff.stale, "no-handoff");
    const unknownNoHandoff = await store.beginArtifactLoad(session.key, {
      requestId: "unknown",
      requestSequence: 1,
      handoffToken: "unknown",
    });
    assert.equal(unknownNoHandoff.stale, "no-handoff");

    const firstHandoff = await store.issueReviewerHandoff(session.key);
    const firstLoad = await store.beginArtifactLoad(session.key, {
      requestId: "first",
      requestSequence: 1,
      handoffToken: firstHandoff.chrome_load_token,
    });
    const secondHandoff = await store.issueReviewerHandoff(session.key);
    const superseded = await store.beginArtifactLoad(session.key, {
      requestId: "old",
      requestSequence: 2,
      handoffToken: firstHandoff.chrome_load_token,
    });
    const current = await store.beginArtifactLoad(session.key, {
      requestId: "current",
      requestSequence: secondHandoff.artifact_load_sequence + 1,
      handoffToken: secondHandoff.chrome_load_token,
    });

    assert.equal(firstLoad.artifact_revision, 1);
    assert.equal(superseded.stale, "superseded");
    assert.equal(current.artifact_revision, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-severe observations never enter the inbox", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const load = await beginArtifactLoad(store, session.key);
    const result = await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(load, 1, {
        complete: true,
        viewport_width: 720,
        findings: [
          {
            selector: ".accent",
            kind: "element-parent-overflow",
            overflowPx: 20,
            viewportWidth: 720,
            severity: "warning",
          },
          { selector: ".unproven", kind: "clipped-text", overflowPx: 200, viewportWidth: 720 },
        ],
      }),
    );

    assert.equal(result.warnings.length, 0);
    assert.equal((await store.takeFeedback(session.key)).status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("queueing a warning produces one ordinary prompt and leaves the warning unresolved", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const load = await beginArtifactLoad(store, session.key);
    const recorded = await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(load, 1, {
        complete: true,
        viewport_width: 1440,
        findings: [
          { selector: "button", kind: "clipped-control", axis: "horizontal", overflowPx: 20, severity: "error" },
          { selector: "p", kind: "clipped-text", axis: "vertical", overflowPx: 27, severity: "error" },
        ],
      }),
    );
    const [first, second] = recorded.warnings;

    const queued = await store.prepareLayoutWarningFixes(session.key, [first.id]);
    assert.equal(queued.queued.length, 1);
    assert.match(queued.prompt.prompt, /Fix this layout issue/);
    assert.equal(queued.prompt.target.type, "layout-warnings");
    assert.equal(queued.prompt.target.warnings[0].id, first.id);

    const prepared = queued.warnings.find((warning) => warning.id === first.id);
    assert.equal(prepared.status, "open");
    assert.equal(prepared.selectable, true);
    assert.equal(queued.warnings.find((warning) => warning.id === second.id).status, "open");
    await store.queuePrompts(session.key, { prompts: [{ ...queued.prompt, uid: "", tag: "layout-warnings" }] });
    const after = (await store.listLayoutWarnings(session.key)).warnings.find((warning) => warning.id === first.id);
    assert.equal(after.status, "queued");
    assert.equal(after.active, true);
    assert.equal(after.selectable, false);
    assert.equal(after.outstanding, true);
    const retry = await store.queuePrompts(session.key, {
      prompts: [{ ...queued.prompt, uid: "", tag: "layout-warnings" }],
    });
    assert.equal(retry.conflict, undefined);
    assert.equal(retry.prompts.length, 1);
    const feedback = await store.takeFeedback(session.key);
    assert.equal(feedback.status, "feedback");
    assert.equal(feedback.prompts[0].tag, "layout-warnings");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a prepared layout prompt conflicts when its warning changes before sending", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const firstLoad = await beginArtifactLoad(store, session.key);
    const recorded = await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(firstLoad, 1, {
        complete: true,
        viewport_width: 1440,
        findings: [{ selector: "p", kind: "clipped-text", axis: "vertical", overflowPx: 27, severity: "error" }],
      }),
    );
    const prepared = await store.prepareLayoutWarningFixes(session.key, [recorded.warnings[0].id]);

    const secondLoad = await beginArtifactLoad(store, session.key);
    const resolved = await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(secondLoad, 1, {
        complete: true,
        target_presence_complete: true,
        viewport_width: 1440,
        findings: [],
      }),
    );
    assert.equal(resolved.warnings[0].status, "resolved");

    const conflict = await store.queuePrompts(session.key, {
      prompts: [{ ...prepared.prompt, uid: "", selector: "", tag: "layout-warnings" }],
    });
    assert.equal(conflict.conflict, true);
    assert.deepEqual(conflict.warning_ids, [recorded.warnings[0].id]);
    assert.equal((await store.takeFeedback(session.key)).status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stale diagnostic pass cannot mutate the current revision", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const firstLoad = await beginArtifactLoad(store, session.key);
    const recorded = await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(firstLoad, 1, {
        complete: true,
        viewport_width: 1440,
        findings: [{ selector: "p", kind: "clipped-text", axis: "vertical", overflowPx: 27, severity: "error" }],
      }),
    );

    const secondLoad = await beginArtifactLoad(store, session.key);
    const stale = await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(secondLoad, 1, {
        artifact_load_token: firstLoad.artifact_load_token,
        artifact_revision: firstLoad.artifact_revision,
        complete: true,
        viewport_width: 1440,
        findings: [],
      }),
    );
    assert.equal(stale.stale, true);
    assert.equal(stale.warnings[0].status, "open");
    assert.equal(stale.warnings[0].last_seen_revision, 1);
    assert.equal(recorded.warnings[0].id, stale.warnings[0].id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a queued layout-warnings prompt is normalized like ordinary feedback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.queuePrompts(session.key, {
      prompts: [
        {
          uid: "",
          prompt: "Fix these layout issues",
          selector: "",
          tag: "layout-warnings",
          text: "Layout issues: 1 selected",
          target: {
            type: "layout-warnings",
            warnings: [{ id: "abc", rule: "clipped-text", selector: "p", axis: "vertical", overflow_px: 27 }],
          },
        },
      ],
    });

    const result = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(result.prompts.length, 1);
    assert.equal(result.prompts[0].tag, "layout-warnings");
    assert.equal(result.prompts[0].target.warnings[0].id, "abc");
    assert.equal("artifact_failures" in result, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the inbox survives reopening the same artifact", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const load = await beginArtifactLoad(store, session.key);
    await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(load, 1, {
        complete: true,
        viewport_width: 720,
        findings: [{ selector: "html", kind: "page-horizontal-overflow", overflowPx: 24, severity: "error" }],
      }),
    );

    const reopened = await store.upsertSession(artifact, "http://localhost:4387/session/test");

    assert.equal(reopened.status, "open");
    assert.equal(reopened.layout_warnings.length, 1);
    assert.equal((await store.listLayoutWarnings(session.key)).warnings[0].status, "open");
    assert.equal((await store.takeFeedback(session.key)).status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dismissing a warning lasts only for the current artifact revision", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const firstLoad = await beginArtifactLoad(store, session.key);
    const finding = { selector: "html", kind: "page-horizontal-overflow", overflowPx: 40, severity: "error" };
    const recorded = await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(firstLoad, 1, {
        complete: true,
        viewport_width: 720,
        findings: [finding],
      }),
    );
    const id = recorded.warnings[0].id;

    const dismissed = await store.dismissLayoutWarning(session.key, id);
    assert.equal(dismissed.warnings[0].status, "dismissed");
    assert.equal(dismissed.warnings[0].active, false);

    // Same revision: still dismissed even though the pass keeps seeing it.
    const sameRevision = await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(firstLoad, 2, {
        complete: true,
        viewport_width: 720,
        findings: [finding],
      }),
    );
    assert.equal(sameRevision.warnings[0].status, "dismissed");

    const secondLoad = await beginArtifactLoad(store, session.key);
    const laterRevision = await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(secondLoad, 1, {
        complete: true,
        viewport_width: 720,
        findings: [finding],
      }),
    );
    assert.equal(laterRevision.warnings[0].status, "open");
    assert.equal(laterRevision.warnings[0].active, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fatal artifact failures still reach the agent without user action", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const load = await beginArtifactLoad(store, session.key);
    const result = await store.recordArtifactFailures(session.key, {
      ...diagnosticPayload(load, 1),
      failures: [
        { kind: "artifact-asset-unavailable", detail: "<img> could not load /artifact/x/logo.png" },
        { kind: "not-a-real-kind", detail: "ignored" },
      ],
    });
    assert.equal(result.changed, true);

    const feedback = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(feedback.artifact_failures.length, 1);
    assert.equal(feedback.artifact_failures[0].severity, "fatal");
    assert.equal((await store.takeFeedback(session.key)).status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stale artifact failures and duplicate diagnostic sequences have no side effects", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const load = await beginArtifactLoad(store, session.key);
    const finding = { selector: "p", kind: "clipped-text", axis: "vertical", overflowPx: 20, severity: "error" };
    const first = await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(load, 1, {
        complete: true,
        target_presence_complete: true,
        viewport_width: 1440,
        findings: [finding],
      }),
    );
    const duplicate = await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(load, 1, {
        complete: true,
        target_presence_complete: true,
        viewport_width: 1440,
        findings: [],
      }),
    );
    assert.equal(first.changed, true);
    assert.equal(duplicate.stale, true);
    assert.equal(duplicate.warnings[0].status, "open");

    const staleFailure = await store.recordArtifactFailures(session.key, {
      failures: [{ kind: "artifact-asset-unavailable", detail: "missing token" }],
    });
    assert.equal(staleFailure.stale, true);
    assert.equal((await store.takeFeedback(session.key)).status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ending a session makes feedback return ended", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.endSession(session.key);

    const result = await store.takeFeedback(session.key);
    assert.equal(result.status, "ended");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ending a session defaults to agent-initiated and takeFeedback reports who ended it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const ended = await store.endSession(session.key);

    assert.equal(ended.ended_by, "agent");
    const result = await store.takeFeedback(session.key);
    assert.equal(result.status, "ended");
    assert.equal(result.ended_by, "agent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ending a session as the user is recorded distinctly from an agent end", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const ended = await store.endSession(session.key, "user");

    assert.equal(ended.ended_by, "user");
    const result = await store.takeFeedback(session.key);
    assert.equal(result.status, "ended");
    assert.equal(result.ended_by, "user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent cleanup cannot overwrite an existing user end", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.endSession(session.key, "user");
    const ended = await store.endSession(session.key, "agent");

    assert.equal(ended.ended_by, "user");
    const result = await store.takeFeedback(session.key);
    assert.equal(result.status, "ended");
    assert.equal(result.ended_by, "user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the final feedback batch before an end flags session_ended with who ended it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    // Browser send-and-end: prompts land first, then the session ends before delivery.
    await store.queuePrompts(session.key, {
      domSnapshot: 'uid=1 h1 "Hello"',
      prompts: [{ uid: "", prompt: "Parting feedback", selector: "", tag: "message", text: "Freeform message" }],
    });
    await store.endSession(session.key, "user");

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(first.session_ended, true);
    assert.equal(first.ended_by, "user");

    const second = await store.takeFeedback(session.key);
    assert.equal(second.status, "ended");
    assert.equal(second.ended_by, "user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("queued prompts can atomically carry a browser end intent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.queuePrompts(session.key, {
      domSnapshot: 'uid=1 h1 "Hello"',
      endSession: true,
      prompts: [{ uid: "", prompt: "Parting feedback", selector: "", tag: "message", text: "Freeform message" }],
    });

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(first.session_ended, true);
    assert.equal(first.ended_by, "user");
    assert.equal(first.prompts.length, 1);

    const second = await store.takeFeedback(session.key);
    assert.equal(second.status, "ended");
    assert.equal(second.ended_by, "user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("late prompts after a user end preserve the ended session state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.endSession(session.key, "user");
    await store.queuePrompts(session.key, {
      domSnapshot: 'uid=1 h1 "Hello"',
      prompts: [{ uid: "", prompt: "Late feedback", selector: "", tag: "message", text: "Freeform message" }],
    });

    const updated = await store.findByKey(session.key);
    assert.equal(updated.status, "ended");
    assert.equal(updated.ended_by, "user");

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(first.session_ended, true);
    assert.equal(first.ended_by, "user");
    assert.equal(first.prompts[0].prompt, "Late feedback");

    const second = await store.takeFeedback(session.key);
    assert.equal(second.status, "ended");
    assert.equal(second.ended_by, "user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("late layout diagnostics do not reopen ended sessions or become feedback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.endSession(session.key);
    const load = await beginArtifactLoad(store, session.key);
    await store.recordLayoutDiagnostics(
      session.key,
      diagnosticPayload(load, 1, {
        complete: true,
        viewport_width: 720,
        findings: [{ selector: "html", kind: "page-horizontal-overflow", overflowPx: 24, severity: "error" }],
      }),
    );

    const updated = await store.findByKey(session.key);
    assert.equal(updated.status, "ended");
    assert.equal((await store.takeFeedback(session.key)).status, "ended");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prompts queued before ending are still delivered before the ended status", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    // Browser send-and-end with no agent listening: prompts land first, then the session ends.
    await store.queuePrompts(session.key, {
      domSnapshot: 'uid=1 h1 "Hello"',
      prompts: [{ uid: "", prompt: "Parting feedback", selector: "", tag: "message", text: "Freeform message" }],
    });
    await store.endSession(session.key);

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(first.prompts.length, 1);
    assert.equal(first.prompts[0].prompt, "Parting feedback");
    assert.equal(first.dom_snapshot, 'uid=1 h1 "Hello"');

    // Delivering the final batch must not resurrect the session.
    const second = await store.takeFeedback(session.key);
    assert.equal(second.status, "ended");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent replies are stored in session chat history", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.addAgentReply(session.key, "Applied the requested changes.");

    const updated = await store.findByKey(session.key);
    assert.deepEqual(
      updated.chat.map((item) => [item.role, item.text]),
      [["agent", "Applied the requested changes."]],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("freeform user prompts are stored in session chat history", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.queuePrompts(session.key, {
      prompts: [
        { uid: "", prompt: "Please make this clearer", selector: "", tag: "message", text: "Freeform message" },
      ],
    });

    const updated = await store.findByKey(session.key);
    assert.deepEqual(
      updated.chat.map((item) => [item.role, item.text]),
      [["user", "Please make this clearer"]],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("queued prompt attachments are resolved server-side and client path claims are ignored", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hi</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");

    // The resolver stands in for the on-disk attachment store: only a known id
    // resolves, and it returns the authoritative metadata (never the client's).
    const known = "a".repeat(64) + ".png";
    const resolveAttachment = async (_key, id) =>
      id === known
        ? { id: known, type: "image", path: "/vetted/path.png", mime: "image/png", bytes: 42, width: 2, height: 1 }
        : null;

    await store.queuePrompts(
      session.key,
      {
        prompts: [
          {
            uid: "1",
            prompt: "Match this mock",
            selector: "h1",
            tag: "h1",
            text: "Hi",
            attachments: [{ id: known, name: "mock.png", path: "/etc/passwd", mime: "text/evil", bytes: 999999 }],
          },
        ],
      },
      { resolveAttachment, maxPerPrompt: 4, maxPromptBytes: 25 * 1024 * 1024 },
    );

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.deepEqual(first.prompts[0].attachments, [
      {
        id: known,
        type: "image",
        path: "/vetted/path.png",
        mime: "image/png",
        bytes: 42,
        width: 2,
        height: 1,
        name: "mock.png",
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("duplicate attachment ids preserve logical refs and count toward prompt caps", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hi</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const id = "a".repeat(64) + ".png";
    const resolveAttachment = async (_key, attachmentId) => ({
      id: attachmentId,
      type: "image",
      path: "/vetted/path.png",
      mime: "image/png",
      bytes: 10,
      width: 2,
      height: 1,
    });

    await store.queuePrompts(
      session.key,
      {
        prompts: [
          {
            uid: "1",
            prompt: "compare both",
            selector: "h1",
            tag: "h1",
            text: "Hi",
            attachments: [
              { id, name: "first.png" },
              { id, name: "second.png" },
            ],
          },
        ],
      },
      { resolveAttachment, maxPerPrompt: 2, maxPromptBytes: 20 },
    );

    const delivered = feedbackResult(await store.takeFeedback(session.key));
    assert.deepEqual(
      delivered.prompts[0].attachments.map((attachment) => [attachment.id, attachment.name]),
      [
        [id, "first.png"],
        [id, "second.png"],
      ],
    );

    const rejected = await store.queuePrompts(
      session.key,
      {
        prompts: [
          {
            uid: "2",
            prompt: "over cap",
            selector: "h1",
            tag: "h1",
            text: "Hi",
            attachments: [{ id }, { id }],
          },
        ],
      },
      { resolveAttachment, maxPerPrompt: 1, maxPromptBytes: 20 },
    );
    assert.deepEqual(rejected.rejected, [{ id, name: "", reason: "too-many" }]);
    assert.equal((await store.takeFeedback(session.key)).status, "waiting");

    const byteRejected = await store.queuePrompts(
      session.key,
      {
        prompts: [
          {
            uid: "3",
            prompt: "over bytes",
            selector: "h1",
            tag: "h1",
            text: "Hi",
            attachments: [{ id }, { id }],
          },
        ],
      },
      { resolveAttachment, maxPerPrompt: 2, maxPromptBytes: 19 },
    );
    assert.deepEqual(byteRejected.rejected, [{ id, name: "", reason: "prompt-bytes-exceeded" }]);
    assert.equal((await store.takeFeedback(session.key)).status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("queuePrompts rejects the batch atomically when the count or byte cap is exceeded (C4)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hi</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const ids = [0, 1, 2, 3, 4].map((n) => String(n).repeat(64).slice(0, 64) + ".png");
    const resolveAttachment = async (_key, id) => ({
      id,
      type: "image",
      path: "/x/" + id,
      mime: "image/png",
      bytes: 10,
      width: 1,
      height: 1,
    });

    // Over the per-prompt count cap: the whole batch is rejected and nothing persists.
    const overCount = await store.queuePrompts(
      session.key,
      {
        prompts: [
          { uid: "1", prompt: "many", selector: "", tag: "h1", text: "", attachments: ids.map((id) => ({ id })) },
        ],
      },
      { resolveAttachment, maxPerPrompt: 2, maxPromptBytes: 25 * 1024 * 1024 },
    );
    assert.ok(overCount.rejected, "over-count batch reports rejections");
    assert.equal(
      overCount.rejected.every((r) => r.reason === "too-many"),
      true,
    );
    assert.equal(overCount.caps.maxPerPrompt, 2);
    assert.equal((await store.takeFeedback(session.key)).status, "waiting", "nothing was persisted");

    // Over the total-byte cap: same atomic rejection.
    const overBytes = await store.queuePrompts(
      session.key,
      {
        prompts: [
          { uid: "2", prompt: "heavy", selector: "", tag: "h1", text: "", attachments: ids.map((id) => ({ id })) },
        ],
      },
      { resolveAttachment, maxPerPrompt: 10, maxPromptBytes: 25 },
    );
    assert.ok(overBytes.rejected, "over-byte batch reports rejections");
    assert.equal(
      overBytes.rejected.some((r) => r.reason === "prompt-bytes-exceeded"),
      true,
    );
    assert.equal(overBytes.caps.maxPromptBytes, 25);
    assert.equal((await store.takeFeedback(session.key)).status, "waiting", "nothing was persisted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("queuePrompts rejects the batch atomically when an attachment id is unknown (C4)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hi</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const known = "a".repeat(64) + ".png";
    const unknown = "b".repeat(64) + ".png";
    const resolveAttachment = async (_key, id) =>
      id === known
        ? { id: known, type: "image", path: "/vetted.png", mime: "image/png", bytes: 5, width: 1, height: 1 }
        : null;

    // A valid image alongside an unresolvable id: the user's real work is not
    // silently half-delivered - the whole batch is rejected and preserved client-side.
    const result = await store.queuePrompts(
      session.key,
      {
        prompts: [
          {
            uid: "1",
            prompt: "mixed",
            selector: "",
            tag: "h1",
            text: "",
            attachments: [{ id: known }, { id: unknown, name: "gone.png" }],
          },
        ],
      },
      { resolveAttachment, maxPerPrompt: 4, maxPromptBytes: 25 * 1024 * 1024 },
    );
    assert.deepEqual(result.rejected, [{ id: unknown, name: "gone.png", reason: "not-found" }]);
    assert.equal((await store.takeFeedback(session.key)).status, "waiting", "nothing was persisted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("attachments are dropped when no resolver is supplied", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hi</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.queuePrompts(session.key, {
      prompts: [
        {
          uid: "1",
          prompt: "no resolver",
          selector: "",
          tag: "h1",
          text: "",
          attachments: [{ id: "a".repeat(64) + ".png" }],
        },
      ],
    });
    const result = feedbackResult(await store.takeFeedback(session.key));
    assert.equal("attachments" in result.prompts[0], false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("referencedAttachmentIds covers pending prompts, then the delivery read grace", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hi</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const id = "a".repeat(64) + ".png";
    const resolveAttachment = async (_key, ref) => ({
      id: ref,
      type: "image",
      path: "/x/" + ref,
      mime: "image/png",
      bytes: 5,
      width: 1,
      height: 1,
    });

    await store.queuePrompts(
      session.key,
      { prompts: [{ uid: "1", prompt: "look", selector: "", tag: "h1", text: "", attachments: [{ id }] }] },
      { resolveAttachment },
    );

    assert.deepEqual([...(await store.referencedAttachmentIds())], [`${session.key}/${id}`]);

    // takeFeedback clears the pending prompts, but the agent only starts reading the
    // delivered path now, so the id stays referenced for the read grace and is
    // released once that window lapses.
    await store.takeFeedback(session.key);
    assert.deepEqual([...(await store.referencedAttachmentIds())], [`${session.key}/${id}`]);
    assert.deepEqual(
      [...(await store.referencedAttachmentIds({ now: Date.now() + ATTACHMENT_DELIVERY_GRACE_MS + 1 }))],
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("queuePrompts and takeFeedback serialize so a mid-resolution poll never clobbers state (E1)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hi</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");

    // Prompt A is already queued and undelivered.
    await store.queuePrompts(session.key, { prompts: [{ uid: "A", prompt: "A", selector: "", tag: "h1", text: "" }] });

    // A resolver we can hold open, so queuePrompts(B) parks INSIDE its critical
    // section (after reading the [A] snapshot) while a concurrent takeFeedback tries
    // to run. Before E1, takeFeedback (unlocked) would deliver+clear A, then B's
    // stale-snapshot write would resurrect A and lose the clear.
    /** @type {(value?: unknown) => void} */
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const knownId = "b".repeat(64) + ".png";
    const resolveAttachment = async (_key, id) => {
      await gate;
      return { id, type: "image", path: "/vetted/" + id, mime: "image/png", bytes: 5, width: 1, height: 1 };
    };

    const queueB = store.queuePrompts(
      session.key,
      { prompts: [{ uid: "B", prompt: "B", selector: "", tag: "h1", text: "", attachments: [{ id: knownId }] }] },
      { resolveAttachment, maxPerPrompt: 4, maxPromptBytes: 25 * 1024 * 1024 },
    );
    // Let queueB acquire the lock and park on the gate.
    await new Promise((resolve) => setTimeout(resolve, 15));

    // takeFeedback must block on the same lock until queueB commits.
    const take = store.takeFeedback(session.key);
    await new Promise((resolve) => setTimeout(resolve, 15));
    release();

    const [, feedback] = await Promise.all([queueB, take]);
    // Because the two serialized, the single delivery carries BOTH A and B exactly once.
    assert.equal(feedback.status, "feedback");
    assert.deepEqual(feedback.prompts.map((p) => p.uid).sort(), ["A", "B"]);
    // Nothing was resurrected or left behind.
    assert.equal((await store.takeFeedback(session.key)).status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A well-formed but nonexistent content-hash id, distinct per index.
function unknownAttachmentId(index) {
  return String(index).padStart(64, "0") + ".png";
}

async function withStore(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");
    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await run({ store, session });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a raw over-cap attachment array is rejected before any resolver call (E3)", async () => {
  await withStore(async ({ store, session }) => {
    let resolverCalls = 0;
    // Every id is well-formed and unknown. The cap counts RESOLVED refs, so an
    // unknown id never advances it: without a raw-count check each one costs a
    // sequential filesystem stat, and the whole loop runs while holding the
    // store's single global mutex - blocking every poll and state mutation.
    const attachments = Array.from({ length: 5000 }, (_, i) => ({ id: unknownAttachmentId(i) }));
    const result = await store.queuePrompts(
      session.key,
      { prompts: [{ uid: "1", prompt: "dos", selector: "h1", tag: "h1", text: "", attachments }] },
      {
        resolveAttachment: async () => {
          resolverCalls += 1;
          return null;
        },
        maxPerPrompt: 4,
        maxPromptBytes: 25 * 1024 * 1024,
      },
    );

    assert.equal(resolverCalls, 0, "the resolver is never reached for a raw over-cap array");
    assert.equal(result.rejected[0].reason, "too-many");
    assert.ok(result.rejected.length <= 4, "the rejection list stays bounded, not one entry per crafted id");
    assert.equal((await store.takeFeedback(session.key)).status, "waiting", "nothing was persisted");
  });
});

test("a request-wide attachment ref flood is rejected before any resolver call (E3)", async () => {
  await withStore(async ({ store, session }) => {
    let resolverCalls = 0;
    // Each prompt sits at the per-prompt cap, so only a request-wide bound stops
    // the batch from multiplying the resolver work across thousands of prompts.
    const prompts = Array.from({ length: 400 }, (_, i) => ({
      uid: String(i),
      prompt: "p" + i,
      selector: "h1",
      tag: "h1",
      text: "",
      attachments: Array.from({ length: 4 }, (_, j) => ({ id: unknownAttachmentId(i * 4 + j) })),
    }));
    const result = await store.queuePrompts(
      session.key,
      { prompts },
      {
        resolveAttachment: async () => {
          resolverCalls += 1;
          return null;
        },
        maxPerPrompt: 4,
        maxPromptBytes: 25 * 1024 * 1024,
      },
    );

    assert.equal(resolverCalls, 0, "the resolver is never reached for a request-wide flood");
    assert.equal(result.rejected[0].reason, "too-many-in-request");
    assert.ok(result.rejected.length <= 4, "the rejection list stays bounded");
    assert.equal((await store.takeFeedback(session.key)).status, "waiting", "nothing was persisted");
  });
});

test("a legitimate batch still resolves every attachment (E3 does not over-reject)", async () => {
  await withStore(async ({ store, session }) => {
    let resolverCalls = 0;
    const prompts = Array.from({ length: 3 }, (_, i) => ({
      uid: String(i),
      prompt: "p" + i,
      selector: "h1",
      tag: "h1",
      text: "",
      attachments: [{ id: unknownAttachmentId(i), name: "shot.png" }],
    }));
    const result = await store.queuePrompts(
      session.key,
      { prompts },
      {
        resolveAttachment: async (_key, id) => {
          resolverCalls += 1;
          return { id, type: "image", path: "/tmp/" + id, mime: "image/png", bytes: 10, width: 1, height: 1 };
        },
        maxPerPrompt: 4,
        maxPromptBytes: 25 * 1024 * 1024,
      },
    );

    assert.equal(resolverCalls, 3, "each in-cap ref still resolves exactly once");
    assert.equal(result.pending_prompts, 3);
    const feedback = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(feedback.prompts[0].attachments[0].path, "/tmp/" + unknownAttachmentId(0));
  });
});

test("a malformed attachments field rejects the whole batch instead of dropping it (W1)", async () => {
  await withStore(async ({ store, session }) => {
    // `attachments` is not an array at all. Silently normalizing this to "no
    // attachments" lets the POST succeed, and the chrome then clears its queue
    // believing the images were delivered - the C4 all-or-nothing violation.
    const result = await store.queuePrompts(
      session.key,
      { prompts: [{ uid: "1", prompt: "hi", selector: "h1", tag: "h1", text: "", attachments: "nope" }] },
      { resolveAttachment: async () => null, maxPerPrompt: 4, maxPromptBytes: 25 * 1024 * 1024 },
    );

    assert.equal(result.rejected[0].reason, "malformed");
    assert.equal((await store.takeFeedback(session.key)).status, "waiting", "the batch persisted nothing");
  });
});

test("malformed attachment entries reject the whole batch (W1)", async () => {
  await withStore(async ({ store, session }) => {
    for (const attachments of [[null], [{ name: "no-id.png" }], [["nested"]], ["just-a-string"]]) {
      const result = await store.queuePrompts(
        session.key,
        { prompts: [{ uid: "1", prompt: "hi", selector: "h1", tag: "h1", text: "", attachments }] },
        { resolveAttachment: async () => null, maxPerPrompt: 4, maxPromptBytes: 25 * 1024 * 1024 },
      );
      assert.equal(result.rejected[0].reason, "malformed", `entry ${JSON.stringify(attachments)} is malformed`);
    }
    assert.equal((await store.takeFeedback(session.key)).status, "waiting", "no malformed batch persisted");
  });
});

test("a malformed entry fails the batch even alongside a resolvable one (W1)", async () => {
  await withStore(async ({ store, session }) => {
    const good = unknownAttachmentId(1);
    const result = await store.queuePrompts(
      session.key,
      {
        prompts: [{ uid: "1", prompt: "hi", selector: "h1", tag: "h1", text: "", attachments: [{ id: good }, null] }],
      },
      {
        resolveAttachment: async (_key, id) => ({
          id,
          type: "image",
          path: "/tmp/" + id,
          mime: "image/png",
          bytes: 10,
          width: 1,
          height: 1,
        }),
        maxPerPrompt: 4,
        maxPromptBytes: 25 * 1024 * 1024,
      },
    );

    assert.equal(result.rejected[0].reason, "malformed");
    assert.equal((await store.takeFeedback(session.key)).status, "waiting", "the good ref is not delivered either");
  });
});

test("an absent attachments field is not malformed (W1)", async () => {
  await withStore(async ({ store, session }) => {
    const result = await store.queuePrompts(
      session.key,
      { prompts: [{ uid: "1", prompt: "plain", selector: "h1", tag: "h1", text: "" }] },
      { resolveAttachment: async () => null, maxPerPrompt: 4, maxPromptBytes: 25 * 1024 * 1024 },
    );
    assert.equal(result.rejected, undefined, "a prompt with no images is untouched by attachment validation");
    assert.equal(result.pending_prompts, 1);
  });
});

test("a delivered attachment stays referenced while the agent reads it (post-poll-retention)", async () => {
  await withStore(async ({ store, session }) => {
    const id = unknownAttachmentId(7);
    await store.queuePrompts(
      session.key,
      { prompts: [{ uid: "1", prompt: "look", selector: "h1", tag: "h1", text: "", attachments: [{ id }] }] },
      {
        resolveAttachment: async (_key, attachmentId) => ({
          id: attachmentId,
          type: "image",
          path: "/tmp/" + attachmentId,
          mime: "image/png",
          bytes: 10,
          width: 1,
          height: 1,
        }),
        maxPerPrompt: 4,
        maxPromptBytes: 25 * 1024 * 1024,
      },
    );
    assert.ok((await store.referencedAttachmentIds()).has(`${session.key}/${id}`), "referenced while pending");

    // Delivery clears the pending prompts - but the agent is only now reading the
    // path it was just handed. Dropping the reference here lets the very next sweep
    // reap the file (TTL-expired or disk-cap-eligible) mid-read.
    const feedback = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(feedback.prompts[0].attachments[0].path, "/tmp/" + id);

    assert.ok(
      (await store.referencedAttachmentIds()).has(`${session.key}/${id}`),
      "a just-delivered attachment is still referenced",
    );
  });
});

test("a delivered attachment is released once its read grace elapses (post-poll-retention)", async () => {
  await withStore(async ({ store, session }) => {
    const id = unknownAttachmentId(8);
    await store.queuePrompts(
      session.key,
      { prompts: [{ uid: "1", prompt: "look", selector: "h1", tag: "h1", text: "", attachments: [{ id }] }] },
      {
        resolveAttachment: async (_key, attachmentId) => ({
          id: attachmentId,
          type: "image",
          path: "/tmp/" + attachmentId,
          mime: "image/png",
          bytes: 10,
          width: 1,
          height: 1,
        }),
        maxPerPrompt: 4,
        maxPromptBytes: 25 * 1024 * 1024,
      },
    );
    await store.takeFeedback(session.key);

    // The grace is a bounded read window, not a second lifetime: once it lapses the
    // file is ordinary unreferenced bytes again, or the TTL and disk cap could never
    // reclaim anything that had ever been delivered.
    const later = Date.now() + ATTACHMENT_DELIVERY_GRACE_MS + 1;
    assert.equal(
      (await store.referencedAttachmentIds({ now: later })).has(`${session.key}/${id}`),
      false,
      "the read grace does not extend forever",
    );
  });
});

test("the delivered-attachment retention list stays bounded (post-poll-retention)", async () => {
  await withStore(async ({ store, session }) => {
    // Retention lives in state.json, which is rewritten wholesale on every store
    // operation, so it must never grow without bound across a long session.
    for (let i = 0; i < 60; i += 1) {
      const id = unknownAttachmentId(100 + i);
      await store.queuePrompts(
        session.key,
        { prompts: [{ uid: String(i), prompt: "p", selector: "h1", tag: "h1", text: "", attachments: [{ id }] }] },
        {
          resolveAttachment: async (_key, attachmentId) => ({
            id: attachmentId,
            type: "image",
            path: "/tmp/" + attachmentId,
            mime: "image/png",
            bytes: 10,
            width: 1,
            height: 1,
          }),
          maxPerPrompt: 4,
          maxPromptBytes: 25 * 1024 * 1024,
        },
      );
      await store.takeFeedback(session.key);
    }

    const stored = JSON.parse(await readFile(store.file, "utf8"));
    const retained = stored.sessions[session.key].delivered_attachments || [];
    assert.ok(retained.length <= MAX_DELIVERED_ATTACHMENTS, `retention list bounded, got ${retained.length}`);
    // The most recent delivery is the one that still matters.
    assert.ok((await store.referencedAttachmentIds()).has(`${session.key}/${unknownAttachmentId(159)}`));
  });
});

test("reopening a session preserves the delivery read grace (post-poll-retention)", async () => {
  await withStore(async ({ store, session }) => {
    const id = unknownAttachmentId(21);
    const resolveAttachment = async (_key, attachmentId) => ({
      id: attachmentId,
      type: "image",
      path: "/tmp/" + attachmentId,
      mime: "image/png",
      bytes: 10,
      width: 1,
      height: 1,
    });
    await store.queuePrompts(
      session.key,
      { prompts: [{ uid: "1", prompt: "look", selector: "h1", tag: "h1", text: "", attachments: [{ id }] }] },
      { resolveAttachment, maxPerPrompt: 4, maxPromptBytes: 25 * 1024 * 1024 },
    );
    await store.takeFeedback(session.key);

    // `upsertSession` rebuilds the session from an explicit field list, so any field
    // it forgets is erased. Re-opening the artifact during the grace hour must not
    // drop the protection and hand the next sweep a path the agent is still reading.
    await store.upsertSession(session.file, "http://localhost:4387/session/test");

    assert.ok(
      (await store.referencedAttachmentIds()).has(`${session.key}/${id}`),
      "a reopen inside the grace window keeps the delivered attachment referenced",
    );
  });
});

test("delivery-grace retention dedupes by content id before its bound (post-poll-retention)", async () => {
  await withStore(async ({ store, session }) => {
    const resolveAttachment = async (_key, attachmentId) => ({
      id: attachmentId,
      type: "image",
      path: "/tmp/" + attachmentId,
      mime: "image/png",
      bytes: 10,
      width: 1,
      height: 1,
    });
    const distinct = unknownAttachmentId(30);
    // The distinct image is delivered first, then one reused image is delivered far
    // more times than the bound. Content-addressed ids mean those are all the SAME
    // file, so letting each delivery take a slot evicts the distinct attachment that
    // is still inside its own grace - the very thing the retention exists to prevent.
    await store.queuePrompts(
      session.key,
      { prompts: [{ uid: "d", prompt: "d", selector: "h1", tag: "h1", text: "", attachments: [{ id: distinct }] }] },
      { resolveAttachment, maxPerPrompt: 4, maxPromptBytes: 25 * 1024 * 1024 },
    );
    await store.takeFeedback(session.key);

    const reused = unknownAttachmentId(31);
    for (let i = 0; i < MAX_DELIVERED_ATTACHMENTS + 10; i += 1) {
      await store.queuePrompts(
        session.key,
        {
          prompts: [
            { uid: String(i), prompt: "r", selector: "h1", tag: "h1", text: "", attachments: [{ id: reused }] },
          ],
        },
        { resolveAttachment, maxPerPrompt: 4, maxPromptBytes: 25 * 1024 * 1024 },
      );
      await store.takeFeedback(session.key);
    }

    const referenced = await store.referencedAttachmentIds();
    assert.ok(referenced.has(`${session.key}/${reused}`), "the reused image is retained");
    assert.ok(
      referenced.has(`${session.key}/${distinct}`),
      "a reused image cannot evict a distinct one still in grace",
    );
  });
});

test("every image in a max-size batch survives its own delivery (post-poll-retention)", async () => {
  await withStore(async ({ store, session }) => {
    const resolveAttachment = async (_key, attachmentId) => ({
      id: attachmentId,
      type: "image",
      path: "/tmp/" + attachmentId,
      mime: "image/png",
      bytes: 10,
      width: 1,
      height: 1,
    });
    // A batch sized to exactly the request-wide bound: the queue path accepts it, so
    // delivery must protect all of it. A retention bound lower than the request bound
    // silently leaves the overflow sweepable the instant the agent is handed those
    // very paths - the retention hole reopening for the largest legal batch.
    const total = MAX_REQUEST_ATTACHMENT_REFS;
    const prompts = [];
    for (let i = 0; i < total / 4; i += 1) {
      prompts.push({
        uid: String(i),
        prompt: "p" + i,
        selector: "h1",
        tag: "h1",
        text: "",
        attachments: Array.from({ length: 4 }, (_, j) => ({ id: unknownAttachmentId(500 + i * 4 + j) })),
      });
    }
    const queued = await store.queuePrompts(
      session.key,
      { prompts },
      { resolveAttachment, maxPerPrompt: 4, maxPromptBytes: 25 * 1024 * 1024 },
    );
    assert.equal(queued.rejected, undefined, "a batch at the request bound is accepted");

    await store.takeFeedback(session.key);
    const referenced = await store.referencedAttachmentIds();
    const missing = [];
    for (let i = 0; i < total; i += 1) {
      const id = unknownAttachmentId(500 + i);
      if (!referenced.has(`${session.key}/${id}`)) missing.push(id);
    }
    assert.deepEqual(missing, [], `every delivered image stays referenced (${missing.length} of ${total} were not)`);
  });
});

test("every image delivered in one poll survives, across accumulated batches (post-poll-retention)", async () => {
  await withStore(async ({ store, session }) => {
    const resolveAttachment = async (_key, attachmentId) => ({
      id: attachmentId,
      type: "image",
      path: "/tmp/" + attachmentId,
      mime: "image/png",
      bytes: 10,
      width: 1,
      height: 1,
    });
    const batch = (offset) => {
      const prompts = [];
      for (let i = 0; i < MAX_REQUEST_ATTACHMENT_REFS / 4; i += 1) {
        prompts.push({
          uid: `${offset}-${i}`,
          prompt: "p",
          selector: "h1",
          tag: "h1",
          text: "",
          attachments: Array.from({ length: 4 }, (_, j) => ({ id: unknownAttachmentId(offset + i * 4 + j) })),
        });
      }
      return prompts;
    };
    // Prompts ACCUMULATE across POSTs until a poll drains them. The per-request bound
    // says nothing about how many are pending when takeFeedback finally runs, so a
    // retention bound sized to ONE request silently drops everything the earlier
    // batches delivered - the exact paths the agent is being handed right now.
    const opts = { resolveAttachment, maxPerPrompt: 4, maxPromptBytes: 25 * 1024 * 1024 };
    assert.equal((await store.queuePrompts(session.key, { prompts: batch(1000) }, opts)).rejected, undefined);
    assert.equal((await store.queuePrompts(session.key, { prompts: batch(2000) }, opts)).rejected, undefined);

    const feedback = feedbackResult(await store.takeFeedback(session.key));
    const delivered = feedback.prompts.flatMap((p) => (p.attachments || []).map((a) => a.id));
    assert.equal(delivered.length, MAX_REQUEST_ATTACHMENT_REFS * 2, "one poll delivered both batches");

    const referenced = await store.referencedAttachmentIds();
    const missing = delivered.filter((id) => !referenced.has(`${session.key}/${id}`));
    assert.deepEqual(missing, [], `every id in the actual delivery stays referenced (${missing.length} were not)`);
  });
});
