import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import { isAttachmentUploadApiPath, serve } from "../src/server.js";

// A 2x1 PNG.
const PNG_2x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8BQz0BkYGAAADAAA/8W1p0AAAAASUVORK5CYII=",
  "base64",
);

/**
 * @param {(ctx: { base: string, key: string, artifact: string }) => Promise<void>} run
 * @param {{ env?: Record<string, string> }} [options]
 */
async function withSession(run, { env } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-attach-srv-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  const saved = {};
  if (env) {
    for (const [name, value] of Object.entries(env)) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
  }
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const open = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const { key } = await open.json();
    await run({ base, key, artifact });
  } finally {
    await server.close();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

function uploadImage(base, key, body, { origin = base, contentType = "image/png" } = {}) {
  return fetch(`${base}/api/${key}/attachments`, {
    method: "POST",
    headers: { "content-type": contentType, origin },
    body,
  });
}

test("isAttachmentUploadApiPath matches only the upload route", () => {
  assert.equal(isAttachmentUploadApiPath("/api/0123456789abcdef/attachments"), true);
  assert.equal(isAttachmentUploadApiPath("/api/0123456789abcdef/attachments/x.png"), false);
  assert.equal(isAttachmentUploadApiPath("/api/zz/attachments"), false);
});

test("POST /api/:key/attachments stores an image and returns server-vetted metadata", async () => {
  await withSession(async ({ base, key }) => {
    const res = await uploadImage(base, key, PNG_2x1);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "stored");
    assert.equal(body.attachment.type, "image");
    assert.equal(body.attachment.mime, "image/png");
    assert.equal(body.attachment.bytes, PNG_2x1.length);
    assert.equal(body.attachment.width, 2);
    assert.equal(body.attachment.height, 1);
    assert.match(body.attachment.id, /^[0-9a-f]{64}\.png$/);
    assert.ok(body.attachment.path.endsWith(path.join("attachments", key, body.attachment.id)));
  });
});

test("GET /api/:key/attachments/:id serves the stored bytes with the right type", async () => {
  await withSession(async ({ base, key }) => {
    const { attachment } = await (await uploadImage(base, key, PNG_2x1)).json();
    const res = await fetch(`${base}/api/${key}/attachments/${attachment.id}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /image\/png/);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(bytes, PNG_2x1);
  });
});

test("GET returns 404 for unknown or malformed ids", async () => {
  await withSession(async ({ base, key }) => {
    assert.equal((await fetch(`${base}/api/${key}/attachments/${"f".repeat(64)}.png`)).status, 404);
    assert.equal((await fetch(`${base}/api/${key}/attachments/not-a-valid-id`)).status, 404);
  });
});

test("DELETE removes a stored attachment and is idempotent", async () => {
  await withSession(async ({ base, key }) => {
    const { attachment } = await (await uploadImage(base, key, PNG_2x1)).json();
    const first = await fetch(`${base}/api/${key}/attachments/${attachment.id}`, {
      method: "DELETE",
      headers: { origin: base },
    });
    assert.deepEqual(await first.json(), { status: "removed" });
    const second = await fetch(`${base}/api/${key}/attachments/${attachment.id}`, {
      method: "DELETE",
      headers: { origin: base },
    });
    assert.deepEqual(await second.json(), { status: "absent" });
    assert.equal((await fetch(`${base}/api/${key}/attachments/${attachment.id}`)).status, 404);
  });
});

test("DELETE keeps a content-addressed file still referenced by a queued prompt (refcount)", async () => {
  await withSession(async ({ base, key, artifact }) => {
    const { attachment } = await (await uploadImage(base, key, PNG_2x1)).json();
    // Queue a prompt that references the image, then try to delete that same id
    // (as a second card removing the deduped chip would). The queued prompt still
    // needs the file, so the delete must be refused and the bytes must survive.
    await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        prompts: [
          { uid: "1", prompt: "look", selector: "body", tag: "body", text: "", attachments: [{ id: attachment.id }] },
        ],
      }),
    });
    const del = await fetch(`${base}/api/${key}/attachments/${attachment.id}`, {
      method: "DELETE",
      headers: { origin: base },
    });
    assert.deepEqual(await del.json(), { status: "referenced" });
    // The file is still fetchable, so the queued prompt's thumbnail/path is intact.
    assert.equal((await fetch(`${base}/api/${key}/attachments/${attachment.id}`)).status, 200);

    // Delivering the feedback does NOT release the reference: the agent has just
    // been handed this path and is only now reading it, so the file stays protected
    // for the delivery read grace rather than becoming collectable mid-read.
    await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`);
    const del2 = await fetch(`${base}/api/${key}/attachments/${attachment.id}`, {
      method: "DELETE",
      headers: { origin: base },
    });
    assert.deepEqual(await del2.json(), { status: "referenced" });
    assert.equal((await fetch(`${base}/api/${key}/attachments/${attachment.id}`)).status, 200);
  });
});

test("upload and delete reject cross-origin requests", async () => {
  await withSession(async ({ base, key }) => {
    const upload = await uploadImage(base, key, PNG_2x1, { origin: "https://attacker.example" });
    assert.equal(upload.status, 403);
    const del = await fetch(`${base}/api/${key}/attachments/${"a".repeat(64)}.png`, {
      method: "DELETE",
      headers: { origin: "https://attacker.example" },
    });
    assert.equal(del.status, 403);
  });
});

// Issue a raw HTTP request so we can forge the Host header - browser `fetch`
// treats Host as forbidden and won't override it, but a DNS rebinding attack is
// exactly a real browser sending a foreign Host to this loopback port. Connect to
// 127.0.0.1 while presenting an arbitrary Host (and matching Origin).
/**
 * @param {number} port
 * @param {string} pathname
 * @param {{ method?: string, host?: string, headers?: Record<string, string>, body?: string | Buffer }} [options]
 */
function rawRequest(port, pathname, { method = "GET", host, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const finalHeaders = { ...headers };
    if (host !== undefined) finalHeaders.host = host;
    const req = httpRequest({ host: "127.0.0.1", port, path: pathname, method, headers: finalHeaders }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// The attachment routes MUST sit behind Kun's Host-allowlist guard. The
// same-origin guard alone does NOT stop DNS rebinding: a rebound page carries its
// hostile domain in BOTH Origin and Host, so those still match and isSameOriginRequest
// passes. Only the Host allowlist - which the rebound domain is never on - rejects it.
test("attachment routes reject a rebound (forged-Host) request even when Origin matches Host", async () => {
  await withSession(async ({ base, key }) => {
    const port = Number(new URL(base).port);
    // A legitimate loopback same-origin upload passes and yields a stored id.
    const legit = await uploadImage(base, key, PNG_2x1);
    assert.equal(legit.status, 200);
    const { attachment } = await legit.json();

    const evilHost = `evil.example:${port}`;
    // Rebound upload: Origin matches the forged Host (same-origin passes), valid PNG
    // bytes, so ONLY the Host allowlist can stop it. Must be a clean 403 forbidden host.
    const uploadForged = await rawRequest(port, `/api/${key}/attachments`, {
      method: "POST",
      host: evilHost,
      headers: { origin: `http://${evilHost}`, "content-type": "image/png" },
      body: PNG_2x1,
    });
    assert.equal(uploadForged.status, 403);
    assert.deepEqual(JSON.parse(uploadForged.body), { error: "forbidden host" });

    // Rebound fetch of already-stored bytes must not reach the attacker's origin.
    const fetchForged = await rawRequest(port, `/api/${key}/attachments/${attachment.id}`, { host: evilHost });
    assert.equal(fetchForged.status, 403);

    // Rebound delete must be refused before touching the lifecycle.
    const delForged = await rawRequest(port, `/api/${key}/attachments/${attachment.id}`, {
      method: "DELETE",
      host: evilHost,
      headers: { origin: `http://${evilHost}` },
    });
    assert.equal(delForged.status, 403);

    // The rebound delete never ran: the bytes are still fetchable via a legit request.
    assert.equal((await fetch(`${base}/api/${key}/attachments/${attachment.id}`)).status, 200);
  });
});

test("upload rejects non-image bytes with 415", async () => {
  await withSession(async ({ base, key }) => {
    const res = await uploadImage(base, key, Buffer.from("<svg/>"), { contentType: "image/svg+xml" });
    assert.equal(res.status, 415);
  });
});

test("upload to an unknown session returns 404", async () => {
  await withSession(async ({ base }) => {
    const res = await uploadImage(base, "0123456789abcdef", PNG_2x1);
    assert.equal(res.status, 404);
  });
});

test("a queued prompt carries the server-vetted attachment path, not the client's claim", async () => {
  await withSession(async ({ base, key, artifact }) => {
    const { attachment } = await (await uploadImage(base, key, PNG_2x1)).json();
    const queued = await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        prompts: [
          {
            uid: "1",
            prompt: "match this",
            selector: "body",
            tag: "body",
            text: "",
            attachments: [{ id: attachment.id, name: "mock.png", path: "/etc/passwd" }],
          },
        ],
      }),
    });
    assert.equal(queued.status, 200);
    const poll = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`);
    const feedback = await poll.json();
    const attachments = feedback.prompts[0].attachments;
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].id, attachment.id);
    assert.equal(attachments[0].name, "mock.png");
    assert.equal(attachments[0].path, attachment.path);
    assert.notEqual(attachments[0].path, "/etc/passwd");
    assert.ok(attachments[0].path.includes(path.join("attachments", key)));
  });
});

test("prompts POST rejects the batch atomically (400) when an attachment can't be resolved (C4)", async () => {
  await withSession(async ({ base, key, artifact }) => {
    const { attachment } = await (await uploadImage(base, key, PNG_2x1)).json();
    const unknown = "f".repeat(64) + ".png";
    const queued = await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        prompts: [
          {
            uid: "1",
            prompt: "match this",
            selector: "body",
            tag: "body",
            text: "",
            attachments: [{ id: attachment.id }, { id: unknown }],
          },
        ],
      }),
    });
    assert.equal(queued.status, 400);
    const body = await queued.json();
    assert.deepEqual(
      body.rejected.map((r) => ({ id: r.id, reason: r.reason })),
      [{ id: unknown, reason: "not-found" }],
    );
    // Persist nothing: the poll sees no feedback, so the valid image is not half-delivered.
    const poll = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`);
    const feedback = await poll.json();
    assert.notEqual(feedback.status, "feedback");
  });
});

test("upload rejects bytes over the configured per-image cap with 413", async () => {
  await withSession(
    async ({ base, key }) => {
      const res = await uploadImage(base, key, PNG_2x1);
      assert.equal(res.status, 413);
    },
    { env: { LAVISH_AXI_MAX_ATTACHMENT_BYTES: "8" } },
  );
});

// Non-regression for the merged export/share feature (#123): the raw-body upload
// route and the attachment plumbing must not interfere with export, and queued
// image attachments (which live in the state dir, not the artifact) must never
// leak into an exported bundle.
test("export still works and leaks no attachment data when a prompt references an image", async () => {
  await withSession(async ({ base, key }) => {
    const { attachment } = await (await uploadImage(base, key, PNG_2x1)).json();
    await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        prompts: [
          { uid: "1", prompt: "match", selector: "body", tag: "body", text: "", attachments: [{ id: attachment.id }] },
        ],
      }),
    });
    const res = await fetch(`${base}/api/${key}/export`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    const html = await res.text();
    assert.doesNotMatch(html, new RegExp(attachment.id));
    assert.doesNotMatch(html, /\/api\/[0-9a-f]{16}\/attachments/);
    assert.doesNotMatch(html, /lavish:uploadAttachment/);
  });
});

test("the server sweeps an expired, unreferenced attachment at startup", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-attach-sweep-"));
  const stateFile = path.join(dir, "state.json");
  const key = "0123456789abcdef";
  const id = "a".repeat(64) + ".png";
  const attachmentDir = path.join(dir, "attachments", key);
  const attachmentFile = path.join(attachmentDir, id);
  await mkdir(attachmentDir, { recursive: true });
  await writeFile(attachmentFile, PNG_2x1);
  const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
  await utimes(attachmentFile, new Date(old), new Date(old));

  const saved = process.env.LAVISH_AXI_ATTACHMENT_TTL_MS;
  process.env.LAVISH_AXI_ATTACHMENT_TTL_MS = "1000";
  const server = await serve({ port: 0, stateFile, version: "9.9.9-test" });
  try {
    const deadline = Date.now() + 2000;
    let gone = false;
    while (Date.now() < deadline) {
      try {
        await access(attachmentFile);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch {
        gone = true;
        break;
      }
    }
    assert.ok(gone, "expired orphan attachment should be swept on startup");
  } finally {
    await server.close();
    if (saved === undefined) delete process.env.LAVISH_AXI_ATTACHMENT_TTL_MS;
    else process.env.LAVISH_AXI_ATTACHMENT_TTL_MS = saved;
    await rm(dir, { recursive: true, force: true });
  }
});
