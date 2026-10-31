import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import WebSocket from "ws";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import { serve } from "../src/server.js";
import { attachmentPath } from "../src/attachment-store.js";
import { SessionStore } from "../src/session-store.js";

// W2 of the feedback-delivery gaps: `takeFeedback` drains the queue and stamps Seen before the poll
// response exists, so a response that is ended but never finishes (its socket dies while the bytes
// are still being flushed) must put the batch back like a disconnect during the take does. These
// tests pin that local recovery. They do not assert a lease/ACK protocol, process-death safety, that
// an agent application received a batch, or exactly-once delivery.
//
// Two kinds of evidence, kept apart on purpose:
// - "injected": the poll response fails on the server side just as `end()` is called (its socket is
//   destroyed, it errors, or the write throws), so the client is certain to get nothing. This proves
//   the recovery path; it does not prove the window is reachable.
// - "stalled": a raw loopback client does not read, the batch is large enough to stall the server's
//   write, and the client then disconnects. Nothing is injected on the server side.

const STEP_TIMEOUT_MS = 5000;
// Recovery is asynchronous (a state write, then events), so observations are retried until they
// match or this deadline passes; the final observation is what gets asserted.
const SETTLE_TIMEOUT_MS = 2000;
const SETTLE_INTERVAL_MS = 20;
const CLEANUP_TIMEOUT_MS = 5000;
const SMALL_BATCH = { count: 2, chars: 64 };
// Each prompt is its own POST (the JSON parser caps one body at 2 MB).
const LARGE_BATCH = { count: 32, chars: 1_000_000 };
// Batch setup rewrites the store per POST; keep its aggregate bound separate from recovery steps.
const BATCH_SETUP_TIMEOUT_MS = 15000;

function buildBatch({ count, chars }, label = "note") {
  return Array.from({ length: count }, (_, index) => ({
    uid: `${label}-uid-${index}`,
    prompt: `${label} ${index}: ${"abcdefghij".repeat(Math.ceil(chars / 10))}`.slice(0, chars),
    selector: "body",
    tag: "message",
    text: "",
  }));
}

function summarize(prompts) {
  const list = Array.isArray(prompts) ? prompts : [];
  return { count: list.length, digest: createHash("sha256").update(JSON.stringify(list)).digest("hex").slice(0, 16) };
}

async function withTimeout(promise, label, ms = STEP_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-reads a non-destructive observation until it equals `expected`, then asserts the last one.
async function settlesTo(observe, expected, message) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let actual = await observe();
  while (!isDeepStrictEqual(actual, expected) && Date.now() < deadline) {
    await delay(SETTLE_INTERVAL_MS);
    actual = await observe();
  }
  if (message === undefined) assert.deepEqual(actual, expected);
  else assert.deepEqual(actual, expected, message);
}

// A promise that resolves once something else calls `open()`. Teardown opens every gate, so a
// handler awaiting one is never left suspended after its test failed.
function createGate() {
  /** @type {() => void} */
  let open = () => {};
  const opened = new Promise((resolve) => {
    open = () => resolve(undefined);
  });
  return { opened, open };
}

// Settles once when the client handle is fully closed, whichever kind it is. A WebSocket that
// will not close cleanly in time is terminated.
async function closeClientHandle(handle) {
  if (handle instanceof WebSocket) {
    if (handle.readyState === WebSocket.CLOSED) return;
    const closed = once(handle, "close");
    if (handle.readyState === WebSocket.OPEN) handle.close();
    else handle.terminate();
    try {
      await withTimeout(closed, "a WebSocket to close", CLEANUP_TIMEOUT_MS / 2);
    } catch {
      handle.terminate();
      await withTimeout(closed, "a terminated WebSocket to close", CLEANUP_TIMEOUT_MS / 2);
    }
    return;
  }
  if (handle.closed) return;
  const closed = once(handle, "close");
  handle.destroy();
  await withTimeout(closed, "a raw socket to close", CLEANUP_TIMEOUT_MS);
}

// Every resource is registered the moment it exists, and teardown attempts every cleanup even when
// one of them fails, so a failing case cannot leak a server, socket, gate, patch, or env var. The
// first failure of the test itself is the one reported; cleanup failures ride on it.
async function withPollFixture(run, serveOptions = {}) {
  const previousStateDir = process.env.LAVISH_AXI_STATE_DIR;
  const teardown = new AbortController();
  /** @type {Array<() => unknown>} */
  const cleanups = [];
  /** @type {Set<WebSocket | import("node:net").Socket>} */
  const clients = new Set();
  /** @type {Set<Promise<unknown>>} */
  const background = new Set();
  let failed = false;
  let failure;
  let outcome;
  try {
    const dir = await mkdtemp(path.join(tmpdir(), "lavish-poll-flush-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    process.env.LAVISH_AXI_STATE_DIR = dir;
    const artifact = path.join(dir, "artifact.html");
    const stateFile = path.join(dir, "state.json");
    await writeFile(artifact, "<!doctype html><html><body></body></html>");
    /** @type {string[]} */
    const logs = [];
    const server = await serve({
      port: 0,
      stateFile,
      version: "9.9.9-test",
      log: (line) => logs.push(line),
      ...serveOptions,
    });
    cleanups.push(() => withTimeout(server.close(), "the server to close", CLEANUP_TIMEOUT_MS));
    cleanups.push(() => Promise.allSettled([...background]));
    cleanups.push(() => Promise.all([...clients].map(closeClientHandle)));
    const base = `http://127.0.0.1:${server.port}`;
    const boundedFetch = (url, init = {}) =>
      fetch(url, { ...init, signal: AbortSignal.any([teardown.signal, AbortSignal.timeout(STEP_TIMEOUT_MS)]) });
    const open = await boundedFetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const { key } = await open.json();

    async function startPresenceStream() {
      const socket = new WebSocket(`${base.replace(/^http/, "ws")}/events/${key}`, { origin: base });
      clients.add(socket);
      socket.on("error", () => {});
      const states = [];
      const events = new EventEmitter();
      socket.on("message", (data) => {
        const message = JSON.parse(String(data));
        if (message.type !== "agent-presence") return;
        states.push(message.data.state);
        events.emit("state");
      });
      await withTimeout(once(socket, "open"), "presence socket open");
      return {
        async next() {
          if (states.length === 0) await withTimeout(once(events, "state"), "an agent-presence event");
          return states.shift();
        },
        close: () => closeClientHandle(socket),
      };
    }

    const ctx = {
      server,
      base,
      key,
      artifact,
      dir,
      logs,
      fetch: boundedFetch,
      onCleanup: (cleanup) => cleanups.push(cleanup),
      // Runs a request the test does not await yet. Teardown aborts and joins it.
      background(promise) {
        background.add(promise);
        promise.catch(() => {});
        return promise;
      },
      // Swaps a method for the rest of the test; the original is back before the server closes.
      patch(target, name, replacement) {
        const original = target[name];
        cleanups.push(() => {
          target[name] = original;
        });
        target[name] = replacement(original);
      },
      gate() {
        const gate = createGate();
        cleanups.push(gate.open);
        return gate;
      },
      // The store rewrites state.json in place, so a read can land mid-write; that is no observation.
      async readSession() {
        const deadline = Date.now() + STEP_TIMEOUT_MS;
        for (;;) {
          try {
            return JSON.parse(await readFile(stateFile, "utf8")).sessions[key];
          } catch (error) {
            if (!(error instanceof SyntaxError) || Date.now() >= deadline) throw error;
            await delay(SETTLE_INTERVAL_MS);
          }
        }
      },
      async postPrompts(prompts, body = {}) {
        for (const prompt of prompts) {
          const response = await boundedFetch(`${base}/api/${key}/prompts`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: base },
            body: JSON.stringify({ domSnapshot: "uid=1 body", ...body, prompts: [prompt] }),
          });
          assert.equal(response.status, 200);
        }
      },
      async poll(query = "&timeoutMs=0", init = {}) {
        return (await boundedFetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}${query}`, init)).json();
      },
      startPresenceStream,
      async currentPresence() {
        const stream = await startPresenceStream();
        try {
          return await stream.next();
        } finally {
          await stream.close();
        }
      },
      // A poll from a client that reads nothing until the test says so.
      async openRawPoll(query, { method = "GET", body = "" } = {}) {
        const socket = netConnect(server.port, "127.0.0.1");
        clients.add(socket);
        socket.on("error", () => {});
        await withTimeout(once(socket, "connect"), "the raw poll to connect");
        socket.pause();
        const headers = [
          `${method} /api/poll?file=${encodeURIComponent(artifact)}${query} HTTP/1.1`,
          `Host: 127.0.0.1:${server.port}`,
          "Connection: close",
          ...(method === "POST"
            ? ["Content-Type: application/json", `Content-Length: ${Buffer.byteLength(body)}`]
            : []),
        ];
        await withTimeout(
          new Promise((resolve) => socket.write(`${headers.join("\r\n")}\r\n\r\n${body}`, resolve)),
          "the raw poll request to be written",
        );
        return socket;
      },
    };
    outcome = await run(ctx);
  } catch (error) {
    failed = true;
    failure = error;
  }
  const cleanupErrors = [];
  try {
    teardown.abort();
    for (const cleanup of cleanups.reverse()) {
      try {
        await withTimeout(Promise.resolve().then(cleanup), "a fixture cleanup", CLEANUP_TIMEOUT_MS);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  } finally {
    if (previousStateDir === undefined) delete process.env.LAVISH_AXI_STATE_DIR;
    else process.env.LAVISH_AXI_STATE_DIR = previousStateDir;
  }
  if (failed) {
    if (cleanupErrors.length > 0 && failure && typeof failure === "object") failure.cleanupErrors = cleanupErrors;
    throw failure;
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "poll fixture cleanup failed");
  return outcome;
}

async function readRawBody(socket) {
  const chunks = [];
  socket.on("data", (chunk) => chunks.push(chunk));
  socket.resume();
  await withTimeout(once(socket, "close"), "the raw client to read the whole response");
  const raw = Buffer.concat(chunks).toString("utf8");
  const split = raw.indexOf("\r\n\r\n");
  let body = raw.slice(split + 4);
  if (/transfer-encoding:\s*chunked/i.test(raw.slice(0, split))) {
    // The waiting long-poll streams a heartbeat byte first, so its body is chunked.
    let decoded = "";
    for (let at = 0; ; ) {
      const lineEnd = body.indexOf("\r\n", at);
      const size = parseInt(body.slice(at, lineEnd), 16);
      if (!size) break;
      decoded += body.slice(lineEnd + 2, lineEnd + 2 + size);
      at = lineEnd + 2 + size + 2;
    }
    body = decoded;
  }
  return JSON.parse(body.trim());
}

// Observes every /api/poll response. `fault` is applied once, to the first response that is ended:
// "destroy" kills its socket just before `end()` writes, "error" emits a response error and then
// kills the socket (two failure signals for one delivery), and "throw" makes `end()` throw before
// writing anything. The record keeps what the response looked like at `close`, because ended is
// not finished.
function observePollResponses(ctx, { fault = null } = {}) {
  const events = new EventEmitter();
  let pendingFault = fault;
  ctx.patch(
    ServerResponse.prototype,
    "end",
    (originalEnd) =>
      /** @this {any} */
      function (...args) {
        if (!String(this.req?.url).startsWith("/api/poll") || this.lavishPollRecord) {
          return originalEnd.apply(this, args);
        }
        const record = { res: this, closed: null };
        record.closed = new Promise((resolve) => {
          this.once("close", () =>
            resolve({ writableEnded: this.writableEnded, writableFinished: this.writableFinished }),
          );
        });
        this.lavishPollRecord = record;
        events.emit("end", record);
        const injected = pendingFault;
        pendingFault = null;
        if (injected === "throw") throw new Error("injected write failure");
        if (injected === "error") this.emit("error", new Error("injected response error"));
        if (injected === "destroy" || injected === "error") this.socket.destroy();
        return originalEnd.apply(this, args);
      },
  );
  return { nextEnd: () => once(events, "end").then(([record]) => record) };
}

// Counts restores of this session. With `hold`, each restore is held after its state write and
// before the rest of its recovery (the wake and the chat-sync) until `release()`.
function watchRestores(ctx, { hold = false } = {}) {
  let count = 0;
  const reached = createGate();
  const release = ctx.gate();
  ctx.patch(
    SessionStore.prototype,
    "queuePrompts",
    (original) =>
      async function (sessionKey, payload, options) {
        const result = await original.call(this, sessionKey, payload, options);
        if (sessionKey === ctx.key && options?.restore) {
          count += 1;
          if (hold) {
            reached.open();
            await release.opened;
          }
        }
        return result;
      },
  );
  return { count: () => count, held: reached.opened, release: release.open };
}

// Holds the next take after install (install it once the poll is listening, so that is the long-poll's
// own `respond()` take) so several POSTs can accumulate into one batch. With `afterTake`, the take
// runs first and its result is held, so the batch is already out of the store.
function gateNextTake(ctx, { afterTake = false } = {}) {
  const reached = createGate();
  const release = ctx.gate();
  let gated = false;
  ctx.patch(
    SessionStore.prototype,
    "takeFeedback",
    (original) =>
      async function (sessionKey) {
        if (gated || sessionKey !== ctx.key) return original.call(this, sessionKey);
        gated = true;
        const result = afterTake ? await original.call(this, sessionKey) : null;
        reached.open();
        await release.opened;
        return afterTake ? result : original.call(this, sessionKey);
      },
  );
  return { held: reached.opened, release: release.open };
}

// The transcript entry exactly as it was before a take stamped it Seen.
function withoutSeen(entry) {
  const rest = { ...entry };
  delete rest.delivered_at;
  delete rest.delivered_seq;
  return rest;
}

const stampedCount = (session) => session.chat.filter((entry) => entry.delivered_seq !== undefined).length;

// The transcript is bounded (MAX_CHAT_STORED_BYTES), so a large batch may keep fewer user entries than
// it had prompts. Every user entry still retained must carry the receipt after a delivery.
const retainedUserEntries = (session) => session.chat.filter((entry) => entry.role === "user").length;

// Queues `prompts` and drives a raw poll to the point where the server has called `end()` on the poll
// response. "immediate": the batch is queued before the poll. "pending": a listening poll is woken by
// the POSTs. `chatBefore` is the transcript just before the take that delivers the batch.
async function pollUntilEnd(ctx, { deliver, prompts, observer, rawPoll = {} }) {
  const ended = observer.nextEnd();
  ended.catch(() => {});
  let chatBefore;
  let socket;
  if (deliver === "immediate") {
    await ctx.postPrompts(prompts);
    chatBefore = (await ctx.readSession()).chat;
    socket = await ctx.openRawPoll("&timeoutMs=0");
  } else {
    const presence = await ctx.startPresenceStream();
    assert.equal(await presence.next(), "waiting");
    socket = await ctx.openRawPoll("", rawPoll);
    assert.equal(await presence.next(), "listening");
    const gate = gateNextTake(ctx);
    try {
      const posting = ctx.background(ctx.postPrompts(prompts));
      await withTimeout(gate.held, "the long-poll's own take");
      await withTimeout(posting, "the batch to be queued", BATCH_SETUP_TIMEOUT_MS);
      chatBefore = (await ctx.readSession()).chat;
    } finally {
      gate.release();
    }
  }
  const record = await withTimeout(ended, "the server to call end() on the poll response");
  return { record, socket, chatBefore };
}

// What a failed delivery must leave behind once its recovery has settled: the batch queued again,
// no Seen receipts, the transcript as it was, and nobody marked working.
function observeRecovery(ctx, restores, chatBefore) {
  return async () => {
    const session = await ctx.readSession();
    return {
      restores: restores.count(),
      queued: summarize(session.prompts),
      stamped: stampedCount(session),
      chatUnchanged: JSON.stringify(session.chat) === JSON.stringify(chatBefore),
      presence: await ctx.currentPresence(),
    };
  };
}

async function assertRedeliveredOnce(ctx, prompts, restores) {
  const redelivered = await ctx.poll();
  const followUp = await ctx.poll();
  assert.deepEqual(
    {
      redelivered: { status: redelivered.status, ...summarize(redelivered.prompts) },
      followUp: followUp.status,
      restores: restores.count(),
    },
    { redelivered: { status: "feedback", ...summarize(prompts) }, followUp: "waiting", restores: 1 },
  );
}

const failedDeliveryScenarios = [
  { name: "immediate poll, socket killed before the write (injected fault)", deliver: "immediate", fault: "injected" },
  { name: "pending poll, socket killed before the write (injected fault)", deliver: "pending", fault: "injected" },
  {
    name: "immediate poll, raw loopback client disconnects mid-flush of a large batch (stalled real socket)",
    deliver: "immediate",
    fault: "stalled",
  },
  {
    name: "pending poll, raw loopback client disconnects mid-flush of a large batch (stalled real socket)",
    deliver: "pending",
    fault: "stalled",
  },
];

for (const { name, deliver, fault } of failedDeliveryScenarios) {
  test(`a poll response that is ended but never finishes puts the batch back: ${name}`, async () => {
    await withPollFixture(async (ctx) => {
      const prompts = buildBatch(fault === "stalled" ? LARGE_BATCH : SMALL_BATCH);
      const observer = observePollResponses(ctx, { fault: fault === "injected" ? "destroy" : null });
      const restores = watchRestores(ctx);

      const { record, socket, chatBefore } = await pollUntilEnd(ctx, { deliver, prompts, observer });
      if (fault === "stalled") {
        // One loop turn is enough for a write the kernel accepted to finish. A write stalled on the
        // client that does not read is still unfinished afterwards: the precondition for this case.
        await yieldToEventLoop();
        assert.equal(
          record.res.writableFinished,
          false,
          "precondition: batch fit the socket buffers; raise LARGE_BATCH",
        );
        assert.ok(record.res.socket.writableLength > 0, "precondition: nothing left buffered in the server socket");
        socket.destroy();
      }
      // Real or injected, this is the window under test: the response was ended, never finished.
      assert.deepEqual(await withTimeout(record.closed, "the poll response to close"), {
        writableEnded: true,
        writableFinished: false,
      });

      await settlesTo(observeRecovery(ctx, restores, chatBefore), {
        restores: 1,
        queued: summarize(prompts),
        stamped: 0,
        chatUnchanged: true,
        presence: "waiting",
      });
      await assertRedeliveredOnce(ctx, prompts, restores);
    });
  });
}

// A finished delivery is the success boundary: presence turns working there, so a restore that has
// not run by then must never run.
async function assertDeliveredOnce(ctx, { closeState, received, prompts, restores }) {
  await settlesTo(
    async () => {
      const session = await ctx.readSession();
      return {
        closeState,
        restores: restores.count(),
        status: received.status,
        received: summarize(received.prompts),
        queued: summarize(session.prompts),
        receiptsComplete: stampedCount(session) === retainedUserEntries(session) && retainedUserEntries(session) > 0,
        presence: await ctx.currentPresence(),
      };
    },
    {
      closeState: { writableEnded: true, writableFinished: true },
      restores: 0,
      status: "feedback",
      received: summarize(prompts),
      queued: summarize([]),
      receiptsComplete: true,
      presence: "working",
    },
  );
  assert.equal((await ctx.poll()).status, "waiting");
  assert.equal(restores.count(), 0);
}

test("control: a large batch the slow client reads in full is delivered once and is not restored", async () => {
  await withPollFixture(async (ctx) => {
    const prompts = buildBatch(LARGE_BATCH);
    const observer = observePollResponses(ctx);
    const restores = watchRestores(ctx);

    const { record, socket } = await pollUntilEnd(ctx, { deliver: "immediate", prompts, observer });
    await yieldToEventLoop();
    assert.equal(record.res.writableFinished, false, "precondition: batch fit the socket buffers; raise LARGE_BATCH");
    const received = await readRawBody(socket);
    const closeState = await withTimeout(record.closed, "the poll response to close");
    await assertDeliveredOnce(ctx, { closeState, received, prompts, restores });
  });
});

for (const deliver of ["immediate", "pending"]) {
  test(`control: a small batch delivered over a healthy connection is not restored (${deliver})`, async () => {
    await withPollFixture(async (ctx) => {
      const prompts = buildBatch(SMALL_BATCH);
      const observer = observePollResponses(ctx);
      const restores = watchRestores(ctx);

      const { record, socket } = await pollUntilEnd(ctx, { deliver, prompts, observer });
      const received = await readRawBody(socket);
      const closeState = await withTimeout(record.closed, "the poll response to close");
      await assertDeliveredOnce(ctx, { closeState, received, prompts, restores });
    });
  });
}

// Several failure signals can describe one failed delivery: a response error followed by its close,
// or a synchronous write failure followed by the error response. Exactly one restore may follow.
for (const fault of ["error", "throw"]) {
  for (const deliver of ["immediate", "pending"]) {
    test(`a delivery that fails with "${fault}" is restored exactly once (${deliver})`, async () => {
      await withPollFixture(async (ctx) => {
        const prompts = buildBatch(SMALL_BATCH);
        const observer = observePollResponses(ctx, { fault });
        const restores = watchRestores(ctx);

        const { chatBefore } = await pollUntilEnd(ctx, { deliver, prompts, observer });
        await settlesTo(observeRecovery(ctx, restores, chatBefore), {
          restores: 1,
          queued: summarize(prompts),
          stamped: 0,
          chatUnchanged: true,
          presence: "waiting",
        });
        await assertRedeliveredOnce(ctx, prompts, restores);
      });
    });
  }
}

test("a reply poll whose request body completed still recovers a delivery its response never finished", async () => {
  await withPollFixture(async (ctx) => {
    const prompts = buildBatch(SMALL_BATCH);
    const observer = observePollResponses(ctx, { fault: "destroy" });
    const restores = watchRestores(ctx);

    const { chatBefore } = await pollUntilEnd(ctx, {
      deliver: "pending",
      prompts,
      observer,
      rawPoll: { method: "POST", body: JSON.stringify({ agent_reply: "Reworked the header." }) },
    });
    await settlesTo(observeRecovery(ctx, restores, chatBefore), {
      restores: 1,
      queued: summarize(prompts),
      stamped: 0,
      chatUnchanged: true,
      presence: "waiting",
    });
    const replies = (await ctx.readSession()).chat.filter((entry) => entry.role === "agent");
    assert.deepEqual(
      replies.map((entry) => entry.text),
      ["Reworked the header."],
    );
    await assertRedeliveredOnce(ctx, prompts, restores);
  });
});

test("a slow but healthy pending delivery is not rolled back while heartbeats would have fired", async () => {
  await withPollFixture(
    async (ctx) => {
      const prompts = buildBatch(LARGE_BATCH);
      const observer = observePollResponses(ctx);
      const restores = watchRestores(ctx);

      const { record, socket } = await pollUntilEnd(ctx, { deliver: "pending", prompts, observer });
      await delay(100);
      const stalled = await ctx.readSession();
      assert.deepEqual(
        { finished: record.res.writableFinished, restores: restores.count(), queued: summarize(stalled.prompts) },
        { finished: false, restores: 0, queued: summarize([]) },
        "precondition and expectation: still flushing ten heartbeat intervals later, nothing put back",
      );
      // The poll keeps its ownership while its batch is being written.
      const rival = await ctx.fetch(`${ctx.base}/api/poll?file=${encodeURIComponent(ctx.artifact)}&timeoutMs=0`);
      assert.deepEqual(
        { status: rival.status, code: (await rival.json()).code },
        { status: 409, code: "LISTENER_ACTIVE" },
      );
      const received = await readRawBody(socket);
      const closeState = await withTimeout(record.closed, "the poll response to close");
      await assertDeliveredOnce(ctx, { closeState, received, prompts, restores });
    },
    { pollHeartbeatMs: 10 },
  );
});

// Races `successor` against a short window that starts once the old delivery reached `checkpoint`:
// "blocked" means the successor had not answered by then.
async function successorStateAfter(checkpoint, successor) {
  return withTimeout(
    Promise.race([
      successor.then((body) => `answered ${body.status}`),
      checkpoint.then(() => delay(150)).then(() => "blocked"),
    ]),
    "the successor to answer or the old delivery to reach its checkpoint",
  );
}

test("a takeover during an unfinished flush waits until the old batch is fully put back, then gets it", async () => {
  await withPollFixture(async (ctx) => {
    const prompts = buildBatch(LARGE_BATCH);
    const observer = observePollResponses(ctx);
    const restores = watchRestores(ctx, { hold: true });

    const { record, socket } = await pollUntilEnd(ctx, { deliver: "immediate", prompts, observer });
    await yieldToEventLoop();
    assert.equal(record.res.writableFinished, false, "precondition: batch fit the socket buffers; raise LARGE_BATCH");
    const successor = ctx.background(ctx.poll("&takeover=1&timeoutMs=0", { method: "POST" }));
    assert.equal(await successorStateAfter(restores.held, successor), "blocked");
    restores.release();
    const delivered = await withTimeout(successor, "the successor's answer");
    socket.resume();
    await withTimeout(once(socket, "close"), "the replaced client's connection to close");
    assert.deepEqual(
      { status: delivered.status, ...summarize(delivered.prompts), restores: restores.count() },
      { status: "feedback", ...summarize(prompts), restores: 1 },
    );
    await settlesTo(async () => ({ presence: await ctx.currentPresence() }), { presence: "working" });
    assert.equal((await ctx.poll()).status, "waiting");
  });
});

test("a takeover while the old poll holds a taken batch waits for it to be put back, then gets it", async () => {
  await withPollFixture(async (ctx) => {
    const prompts = buildBatch(SMALL_BATCH);
    const restores = watchRestores(ctx);
    const presence = await ctx.startPresenceStream();
    assert.equal(await presence.next(), "waiting");
    const socket = await ctx.openRawPoll("");
    assert.equal(await presence.next(), "listening");
    const take = gateNextTake(ctx, { afterTake: true });
    ctx.background(ctx.postPrompts(prompts.slice(0, 1)));
    const successor = ctx.background(take.held.then(() => ctx.poll("&takeover=1&timeoutMs=0", { method: "POST" })));
    assert.equal(await successorStateAfter(take.held, successor), "blocked");
    take.release();
    const delivered = await withTimeout(successor, "the successor's answer");
    const replaced = await readRawBody(socket);
    assert.deepEqual(
      {
        status: delivered.status,
        ...summarize(delivered.prompts),
        restores: restores.count(),
        replaced: replaced.code,
      },
      { status: "feedback", ...summarize(prompts.slice(0, 1)), restores: 1, replaced: "LISTENER_REPLACED" },
    );
  });
});

test("prompts and a snapshot queued during an unfinished flush stay after the put-back batch and win", async () => {
  await withPollFixture(async (ctx) => {
    const prompts = buildBatch(LARGE_BATCH);
    const newer = buildBatch(SMALL_BATCH, "newer");
    const observer = observePollResponses(ctx);
    const restores = watchRestores(ctx);

    const { record, socket } = await pollUntilEnd(ctx, { deliver: "immediate", prompts, observer });
    await yieldToEventLoop();
    assert.equal(record.res.writableFinished, false, "precondition: batch fit the socket buffers; raise LARGE_BATCH");
    await ctx.postPrompts(newer, { domSnapshot: "uid=2 newer body" });
    const chatWithNewer = (await ctx.readSession()).chat;
    socket.destroy();
    await withTimeout(record.closed, "the poll response to close");

    await settlesTo(
      async () => {
        const session = await ctx.readSession();
        return {
          restores: restores.count(),
          queued: summarize(session.prompts),
          snapshot: session.dom_snapshot,
          stamped: stampedCount(session),
          chatUnstamped: JSON.stringify(session.chat) === JSON.stringify(chatWithNewer.map(withoutSeen)),
          presence: await ctx.currentPresence(),
        };
      },
      {
        restores: 1,
        queued: summarize([...prompts, ...newer]),
        snapshot: "uid=2 newer body",
        stamped: 0,
        chatUnstamped: true,
        presence: "waiting",
      },
    );
    const redelivered = await ctx.poll();
    assert.deepEqual(
      { status: redelivered.status, ...summarize(redelivered.prompts), snapshot: redelivered.dom_snapshot },
      { status: "feedback", ...summarize([...prompts, ...newer]), snapshot: "uid=2 newer body" },
    );
  });
});

async function recordArtifactFailure(ctx, detail) {
  const html = await (await ctx.fetch(`${ctx.base}/session/${ctx.key}`)).text();
  const chrome = JSON.parse(html.match(/<script id="lavish-session" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  const begun = await ctx.fetch(`${ctx.base}/api/${ctx.key}/artifact-loads/begin`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ctx.base },
    body: JSON.stringify({
      request_id: "poll-flush-load-1",
      request_sequence: chrome.initialArtifactLoadSequence + 1,
      chrome_load_token: chrome.chromeLoadToken,
    }),
  });
  assert.equal(begun.status, 200);
  const load = await begun.json();
  const recorded = await ctx.fetch(`${ctx.base}/api/${ctx.key}/artifact-failures`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      artifact_load_token: load.artifact_load_token,
      artifact_revision: load.artifact_revision,
      failures: [{ kind: "artifact-asset-unavailable", detail }],
    }),
  });
  assert.equal(recorded.status, 200);
}

test("a failed delivery of fatal artifact failures alone is put back without inventing receipts", async () => {
  await withPollFixture(async (ctx) => {
    const observer = observePollResponses(ctx, { fault: "destroy" });
    const restores = watchRestores(ctx);
    await recordArtifactFailure(ctx, "<img> could not load /artifact/x/logo.png");
    const before = await ctx.readSession();
    await ctx.openRawPoll("&timeoutMs=0");
    await withTimeout(observer.nextEnd(), "the server to call end() on the poll response");

    await settlesTo(
      async () => {
        const session = await ctx.readSession();
        return {
          restores: restores.count(),
          failures: (session.artifact_failures || []).map((failure) => failure.detail),
          deliverySeq: session.delivery_seq,
          chatUnchanged: JSON.stringify(session.chat) === JSON.stringify(before.chat),
          presence: await ctx.currentPresence(),
        };
      },
      {
        restores: 1,
        failures: ["<img> could not load /artifact/x/logo.png"],
        deliverySeq: before.delivery_seq,
        chatUnchanged: true,
        presence: "waiting",
      },
    );
    const redelivered = await ctx.poll();
    assert.deepEqual(
      {
        status: redelivered.status,
        failures: (redelivered.artifact_failures || []).map((failure) => failure.detail),
        followUp: (await ctx.poll()).status,
      },
      { status: "feedback", failures: ["<img> could not load /artifact/x/logo.png"], followUp: "waiting" },
    );
  });
});

test("a failed send-and-end delivery is put back into the ended session and delivered once more", async () => {
  await withPollFixture(async (ctx) => {
    const prompts = buildBatch({ count: 1, chars: 64 });
    const observer = observePollResponses(ctx, { fault: "destroy" });
    const restores = watchRestores(ctx);
    // An open review page keeps the server from stepping down when the session ends.
    await ctx.startPresenceStream();
    await ctx.postPrompts(prompts, { endSession: true });
    const chatBefore = (await ctx.readSession()).chat;
    await ctx.openRawPoll("&timeoutMs=0");
    await withTimeout(observer.nextEnd(), "the server to call end() on the poll response");

    await settlesTo(
      async () => ({
        ...(await observeRecovery(ctx, restores, chatBefore)()),
        status: (await ctx.readSession()).status,
      }),
      {
        restores: 1,
        queued: summarize(prompts),
        stamped: 0,
        chatUnchanged: true,
        presence: "waiting",
        status: "ended",
      },
    );
    const redelivered = await ctx.poll();
    const followUp = await ctx.poll();
    assert.deepEqual(
      {
        status: redelivered.status,
        ...summarize(redelivered.prompts),
        sessionEnded: redelivered.session_ended,
        endedBy: redelivered.ended_by,
        followUp: followUp.status,
      },
      { status: "feedback", ...summarize(prompts), sessionEnded: true, endedBy: "user", followUp: "ended" },
    );
    await settlesTo(async () => ({ presence: await ctx.currentPresence() }), { presence: "waiting" });
  });
});

// The round a delivery belongs to can be concluded while its bytes are still flushing. The late
// finish must not mark that concluded round working again.
const concludedDuringFlush = [
  {
    name: "the user ends the session",
    conclude: (ctx) => ctx.fetch(`${ctx.base}/api/${ctx.key}/end`, { method: "POST", headers: { origin: ctx.base } }),
    followUp: "ended",
  },
  {
    name: "the agent replies",
    conclude: (ctx) =>
      ctx.fetch(`${ctx.base}/api/${ctx.key}/agent-reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Earlier round is done." }),
      }),
    followUp: "waiting",
  },
];

for (const { name, conclude, followUp } of concludedDuringFlush) {
  test(`a delivery that finishes after ${name} does not mark the agent working`, async () => {
    await withPollFixture(async (ctx) => {
      const prompts = buildBatch(LARGE_BATCH);
      const observer = observePollResponses(ctx);
      const restores = watchRestores(ctx);
      // An open review page keeps the server from stepping down when the session ends.
      await ctx.startPresenceStream();

      const { record, socket } = await pollUntilEnd(ctx, { deliver: "immediate", prompts, observer });
      await yieldToEventLoop();
      assert.equal(record.res.writableFinished, false, "precondition: batch fit the socket buffers; raise LARGE_BATCH");
      assert.equal((await conclude(ctx)).status, 200);
      const received = await readRawBody(socket);
      assert.deepEqual(await withTimeout(record.closed, "the poll response to close"), {
        writableEnded: true,
        writableFinished: true,
      });
      await settlesTo(
        async () => ({
          restores: restores.count(),
          received: summarize(received.prompts),
          presence: await ctx.currentPresence(),
        }),
        { restores: 0, received: summarize(prompts), presence: "waiting" },
      );
      assert.equal((await ctx.poll()).status, followUp);
    });
  });
}

test("a failed delivery whose put-back cannot be written is logged and leaves the poll usable", async () => {
  await withPollFixture(async (ctx) => {
    const prompts = buildBatch(SMALL_BATCH);
    const observer = observePollResponses(ctx, { fault: "destroy" });
    ctx.patch(
      SessionStore.prototype,
      "queuePrompts",
      (original) =>
        async function (sessionKey, payload, options) {
          if (sessionKey === ctx.key && options?.restore) throw new Error("ENOSPC: no space left on device");
          return original.call(this, sessionKey, payload, options);
        },
    );

    await pollUntilEnd(ctx, { deliver: "immediate", prompts, observer });
    await settlesTo(
      async () => ({
        logged: ctx.logs.some(
          (line) => line.includes("closed poll feedback restore failed") && line.includes("ENOSPC"),
        ),
        presence: await ctx.currentPresence(),
      }),
      { logged: true, presence: "waiting" },
    );
    assert.equal((await ctx.poll()).status, "waiting");
  });
});

test("a failed delivery whose image is gone by the put-back is refused, logged, and loses its receipts", async () => {
  await withPollFixture(async (ctx) => {
    const observer = observePollResponses(ctx, { fault: "destroy" });
    const restores = watchRestores(ctx);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8BQz0BkYGAAADAAA/8W1p0AAAAASUVORK5CYII=",
      "base64",
    );
    const upload = await ctx.fetch(`${ctx.base}/api/${ctx.key}/attachments`, {
      method: "POST",
      headers: { "content-type": "image/png", origin: ctx.base },
      body: png,
    });
    assert.equal(upload.status, 200);
    const { attachment } = await upload.json();
    const prompts = [
      {
        uid: "img-1",
        prompt: "Use this image",
        selector: "body",
        tag: "message",
        text: "",
        attachments: [{ id: attachment.id }],
      },
    ];
    await ctx.postPrompts(prompts);
    const chatBefore = (await ctx.readSession()).chat;
    await unlink(attachmentPath(ctx.dir, ctx.key, attachment.id));
    await ctx.openRawPoll("&timeoutMs=0");
    await withTimeout(observer.nextEnd(), "the server to call end() on the poll response");

    await settlesTo(
      async () => ({
        ...(await observeRecovery(ctx, restores, chatBefore)()),
        refusedLogged: ctx.logs.some((line) => line.includes("closed poll feedback restore was refused")),
      }),
      {
        restores: 1,
        queued: summarize([]),
        stamped: 0,
        chatUnchanged: true,
        presence: "waiting",
        refusedLogged: true,
      },
    );
    assert.equal((await ctx.poll()).status, "waiting");
  });
});

// A replacement on the same port reads the same state.json. Starting one tells whether the old
// server still owns the port, and a started one is closed with the fixture.
async function startReplacement(ctx) {
  try {
    const replacement = await serve({
      port: ctx.server.port,
      stateFile: path.join(ctx.dir, "state.json"),
      version: "9.9.9-test",
      log: (line) => ctx.logs.push(line),
    });
    ctx.onCleanup(() => replacement.close());
    return { started: replacement };
  } catch (error) {
    return { refused: /already owns port/.test(String(error?.message)) ? "port owned" : String(error?.message) };
  }
}

test("orderly shutdown keeps the port until the put-back of an unfinished response has persisted", async () => {
  await withPollFixture(async (ctx) => {
    const prompts = buildBatch(LARGE_BATCH, "old");
    const newer = buildBatch({ count: 1, chars: 64 }, "new");
    const observer = observePollResponses(ctx);
    // Holds the retiring server's put-back just before it writes state.json.
    const restoring = new WeakSet();
    const reached = createGate();
    const release = ctx.gate();
    let held = false;
    ctx.patch(
      SessionStore.prototype,
      "queuePrompts",
      (original) =>
        async function (sessionKey, payload, options) {
          if (sessionKey === ctx.key && options?.restore) restoring.add(this);
          return original.call(this, sessionKey, payload, options);
        },
    );
    ctx.patch(
      SessionStore.prototype,
      "writeState",
      (original) =>
        async function (state) {
          if (!held && restoring.has(this)) {
            held = true;
            reached.open();
            await release.opened;
          }
          return original.call(this, state);
        },
    );

    const { record } = await pollUntilEnd(ctx, { deliver: "immediate", prompts, observer });
    await yieldToEventLoop();
    assert.equal(record.res.writableFinished, false, "precondition: batch fit the socket buffers; raise LARGE_BATCH");
    const closing = ctx.background(ctx.server.close());
    await withTimeout(reached.opened, "the put-back to reach its state write");

    const replacementWhileHeld = await startReplacement(ctx);
    const during = {
      close: await Promise.race([closing.then(() => "resolved"), delay(100).then(() => "pending")]),
      health: await ctx.fetch(`${ctx.base}/health`).then(
        (response) => response.status,
        () => "unreachable",
      ),
      freshPrompt: await ctx
        .fetch(`${ctx.base}/api/${ctx.key}/prompts`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ctx.base },
          body: JSON.stringify({ domSnapshot: "uid=1 body", prompts: newer }),
        })
        .then(
          (response) => response.status,
          () => "unreachable",
        ),
      replacement: replacementWhileHeld.refused ?? "started",
    };
    release.open();
    assert.deepEqual(during, { close: "pending", health: 200, freshPrompt: 503, replacement: "port owned" });

    await withTimeout(closing, "the retiring server to close");
    const retired = await ctx.readSession();
    assert.deepEqual(
      { queued: summarize(retired.prompts), stamped: stampedCount(retired) },
      { queued: summarize(prompts), stamped: 0 },
    );
    const { started } = await startReplacement(ctx);
    assert.ok(started, "the port is free once the put-back persisted");
    await ctx.postPrompts(newer);
    const redelivered = await ctx.poll();
    assert.deepEqual(
      { status: redelivered.status, ...summarize(redelivered.prompts) },
      { status: "feedback", ...summarize([...prompts, ...newer]) },
    );
  });
});

test("control: /shutdown with only a listening poll and a review page releases the port promptly", async () => {
  await withPollFixture(async (ctx) => {
    const presence = await ctx.startPresenceStream();
    assert.equal(await presence.next(), "waiting");
    const socket = await ctx.openRawPoll("");
    assert.equal(await presence.next(), "listening");
    const restores = watchRestores(ctx);

    const started = Date.now();
    const shutdown = await ctx.fetch(`${ctx.base}/shutdown`, { method: "POST" });
    assert.equal(shutdown.status, 200);
    await withTimeout(ctx.server.done, "the server to finish shutting down", 2000);
    socket.resume();
    await withTimeout(once(socket, "close"), "the listening poll's connection to close");
    const { started: replacement } = await startReplacement(ctx);
    assert.ok(replacement, "the port is free after shutdown");
    assert.deepEqual(
      {
        restores: restores.count(),
        health: (await ctx.fetch(`${ctx.base}/health`)).status,
        fast: Date.now() - started < 2000,
      },
      { restores: 0, health: 200, fast: true },
    );
  });
});
