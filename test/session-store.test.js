import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionStore } from "../src/session-store.js";

function feedbackResult(result) {
  assert.equal(result.status, "feedback");
  return /** @type {{ status: string, dom_snapshot: string, prompts: any[], layout_warnings?: any[], session_ended?: boolean, ended_by?: string }} */ (
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

test("layout warnings are returned as feedback and then cleared", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const result = await store.recordLayoutWarnings(session.key, {
      layout_warnings: [
        {
          selector: "html",
          kind: "page-horizontal-overflow",
          overflowPx: 24.5,
          viewportWidth: 720,
          severity: "error",
        },
      ],
    });

    assert.equal(result.changed, true);
    assert.equal(result.hasWarnings, true);

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.deepEqual(first.prompts, []);
    assert.deepEqual(first.layout_warnings, [
      {
        selector: "html",
        kind: "page-horizontal-overflow",
        overflowPx: 24.5,
        viewportWidth: 720,
        severity: "error",
        persistent: false,
      },
    ]);

    const second = await store.takeFeedback(session.key);
    assert.equal(second.status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("warning-only layout observations never become agent feedback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const result = await store.recordLayoutWarnings(session.key, {
      layout_warnings: [
        {
          selector: ".accent",
          kind: "element-parent-overflow",
          overflowPx: 20,
          viewportWidth: 720,
          severity: "warning",
        },
        {
          selector: ".unproven",
          kind: "clipped-text",
          overflowPx: 200,
          viewportWidth: 720,
        },
      ],
    });

    assert.equal(result.hasWarnings, false);
    assert.equal((await store.takeFeedback(session.key)).status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a severe finding re-reported after the agent already received it is marked persistent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const warning = {
      selector: "main > header > strong",
      kind: "overlapping-text",
      overflowPx: 0,
      viewportWidth: 720,
      severity: "error",
    };

    await store.recordLayoutWarnings(session.key, { layout_warnings: [warning] });
    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(first.layout_warnings[0].persistent, false);

    // Simulate a reload after an attempted fix that reports the identical finding again -
    // the agent already saw this exact selector+kind, so it should now read as a repeat.
    await store.recordLayoutWarnings(session.key, { layout_warnings: [warning] });
    const second = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(second.layout_warnings[0].persistent, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a severe finding that materially worsens at mobile is fresh", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<p>Important content</p>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const base = {
      selector: "p",
      kind: "clipped-text",
      axis: "vertical",
      severity: "error",
    };

    await store.recordLayoutWarnings(session.key, {
      layout_warnings: [{ ...base, overflowPx: 30, viewportWidth: 1080 }],
    });
    await store.takeFeedback(session.key);
    await store.recordLayoutWarnings(session.key, {
      layout_warnings: [{ ...base, overflowPx: 123, viewportWidth: 390 }],
    });

    const mobile = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(mobile.layout_warnings[0].persistent, false);
    assert.equal(mobile.layout_warnings[0].axis, "vertical");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a severe finding is fresh again after a clean audit resolves it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const warning = {
      selector: "main > header > strong",
      kind: "overlapping-text",
      overflowPx: 0,
      viewportWidth: 720,
      severity: "error",
    };

    await store.recordLayoutWarnings(session.key, { layout_warnings: [warning] });
    await store.takeFeedback(session.key);
    const clean = await store.recordLayoutWarnings(session.key, { layout_warnings: [] });
    await store.recordLayoutWarnings(session.key, { layout_warnings: [warning] });

    const result = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(clean.hasWarnings, false);
    assert.equal(result.layout_warnings[0].persistent, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persistence memory survives reopening the same artifact", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const warning = {
      selector: "main > header > strong",
      kind: "overlapping-text",
      overflowPx: 0,
      viewportWidth: 720,
      severity: "error",
    };

    await store.recordLayoutWarnings(session.key, { layout_warnings: [warning] });
    await store.takeFeedback(session.key);

    await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.recordLayoutWarnings(session.key, { layout_warnings: [warning] });
    const result = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(result.layout_warnings[0].persistent, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reopening a session clears stale layout warnings", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.recordLayoutWarnings(session.key, {
      layout_warnings: [
        {
          selector: "html",
          kind: "page-horizontal-overflow",
          overflowPx: 24,
          viewportWidth: 720,
          severity: "error",
        },
      ],
    });

    const reopened = await store.upsertSession(artifact, "http://localhost:4387/session/test");

    assert.equal(reopened.status, "open");
    assert.deepEqual(reopened.layout_warnings, []);
    assert.equal((await store.takeFeedback(session.key)).status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("empty layout warning reports clear pending warnings without waking feedback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.recordLayoutWarnings(session.key, {
      layout_warnings: [
        {
          selector: "html",
          kind: "page-horizontal-overflow",
          overflowPx: 24,
          viewportWidth: 720,
          severity: "error",
        },
      ],
    });
    const cleared = await store.recordLayoutWarnings(session.key, { layout_warnings: [] });

    assert.equal(cleared.changed, true);
    assert.equal(cleared.hasWarnings, false);
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

test("late layout warnings do not reopen ended sessions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.endSession(session.key);
    await store.recordLayoutWarnings(session.key, {
      layout_warnings: [
        {
          selector: "html",
          kind: "page-horizontal-overflow",
          overflowPx: 24,
          viewportWidth: 720,
          severity: "error",
        },
      ],
    });

    const updated = await store.findByKey(session.key);
    assert.equal(updated.status, "ended");

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(first.layout_warnings.length, 1);
    const second = await store.takeFeedback(session.key);
    assert.equal(second.status, "ended");
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
