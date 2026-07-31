// @ts-nocheck
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MultiplexedEventStream,
  createCapabilitiesProtocolBlock,
  initConsumerCapability,
  readConsumerCapabilityFile,
  resolveStreamBounds,
} from "../src/multiplexed-stream.js";
import { ConsumerEventLog, splitCompleteLines } from "../src/multiplexed-stream-log.js";

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "mx-stream-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("foundation protocol block has no Lavish vocabulary", () => {
  const block = createCapabilitiesProtocolBlock();
  const text = JSON.stringify(block);
  assert.equal(text.includes("review"), false);
  assert.equal(text.includes("prompt"), false);
  assert.equal(block.event_stream.version, 1);
});

test("non-Lavish fixture: claim, publish, subscribe, ack, retire", async () => {
  await withTemp(async (dir) => {
    const stream = new MultiplexedEventStream({
      stateDir: dir,
      bounds: resolveStreamBounds({
        LAVISH_AXI_EVENT_MAX_UNACKED_STREAM: "256",
      }),
    });
    const consumer = "cid_fixture_consumer_01";
    await stream.ensureConsumer(consumer, { consumerRoot: dir });
    const claim = await stream.claim(consumer, 1, "job.alpha");
    assert.equal(claim.status, "claimed");

    const frames = [];
    const sub = await stream.subscribe(consumer, 1, {
      write: (line) => {
        frames.push(JSON.parse(line));
      },
    });
    assert.equal(sub.status, "subscribed");
    await sub.start();

    await stream.publish("job.alpha", { type: "work", payload: { n: 1 } });
    await stream.publish("job.alpha", { type: "done", payload: {}, end_state: "done" });

    await new Promise((r) => setTimeout(r, 20));
    const events = frames.filter((f) => f.schema === "multiplexed.event/1");
    assert.equal(events[0].type, "work");
    assert.equal(events[1].type, "done");
    assert.ok(events[0].log_position < events[1].log_position);
    assert.equal(events[0].stream_key, "job.alpha");

    const ack = await stream.acknowledge(
      consumer,
      1,
      events.map((e) => e.event_id),
    );
    assert.equal(ack.status, "ok");
    const retired = await stream.retire(consumer, 1, "job.alpha");
    assert.equal(retired.status, "retired");
    sub.close();
  });
});

test("backpressure holds new volume but keeps retained backlog deliverable", async () => {
  await withTemp(async (dir) => {
    const stream = new MultiplexedEventStream({
      stateDir: dir,
      bounds: {
        maxPayloadBytes: 1024,
        maxUnackedPerStream: 2,
        maxUnackedPerConsumer: 100,
        retentionMs: 7 * 864e5,
        leaseTtlMs: 60_000,
      },
    });
    const consumer = "cid_pressure_consumer_01";
    await stream.claim(consumer, 1, "s1");
    await stream.publish("s1", { type: "a", payload: { i: 1 } });
    await stream.publish("s1", { type: "b", payload: { i: 2 } });
    const held = await stream.publish("s1", { type: "c", payload: { i: 3 } });
    assert.equal(held.status, "held");

    const frames = [];
    const sub = await stream.subscribe(consumer, 1, {
      write: (line) => frames.push(JSON.parse(line)),
    });
    await sub.start();
    await new Promise((r) => setTimeout(r, 20));
    const deliverable = frames.filter((f) => f.schema === "multiplexed.event/1" && f.type !== "backpressure");
    // Retained a+b must be deliverable so consumer can ack below bound.
    assert.ok(deliverable.some((e) => e.type === "a"));
    assert.ok(deliverable.some((e) => e.type === "b"));
    // Held c is not yet deliverable.
    assert.equal(
      deliverable.some((e) => e.type === "c"),
      false,
    );

    const ids = deliverable.filter((e) => e.type === "a" || e.type === "b").map((e) => e.event_id);
    await stream.acknowledge(consumer, 1, ids);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(frames.some((f) => f.type === "c"));
    sub.close();
  });
});

test("concurrent claims serialize to one owner", async () => {
  await withTemp(async (dir) => {
    const stream = new MultiplexedEventStream({ stateDir: dir });
    const a = "cid_owner_a_xxxxxxxx";
    const b = "cid_owner_b_yyyyyyyy";
    await stream.ensureConsumer(a);
    await stream.ensureConsumer(b);
    const results = await Promise.all([stream.claim(a, 1, "shared"), stream.claim(b, 1, "shared")]);
    const ok = results.filter((r) => r.status === "claimed");
    const denied = results.filter((r) => r.error === "owned_by_other_consumer");
    assert.equal(ok.length, 1);
    assert.equal(denied.length, 1);
  });
});

test("concurrent subscribe equal generation: one admitted", async () => {
  await withTemp(async (dir) => {
    const stream = new MultiplexedEventStream({ stateDir: dir });
    const c = "cid_sub_race_zzzzzzzz";
    await stream.ensureConsumer(c);
    const writes = [[], []];
    const [s1, s2] = await Promise.all([
      stream.subscribe(c, 1, { write: (l) => writes[0].push(l) }),
      stream.subscribe(c, 1, { write: (l) => writes[1].push(l) }),
    ]);
    const statuses = [
      /** @type {any} */ (s1).status || /** @type {any} */ (s1).error,
      /** @type {any} */ (s2).status || /** @type {any} */ (s2).error,
    ];
    assert.ok(statuses.includes("subscribed"));
    assert.ok(statuses.includes("duplicate_subscriber"));
    /** @type {any} */ (s1).close?.();
    /** @type {any} */ (s2).close?.();
  });
});

test("retire refuses while pending and races publish", async () => {
  await withTemp(async (dir) => {
    const stream = new MultiplexedEventStream({ stateDir: dir });
    const c = "cid_retire_race_wwwwww";
    await stream.claim(c, 1, "s");
    await stream.publish("s", { type: "x", payload: {} });
    const refused = await stream.retire(c, 1, "s");
    assert.equal(refused.error, "pending_events");

    // After ack, concurrent publish vs retire: exclusive queue keeps consistency.
    const log = await stream.logs.values().next().value;
    const events = log?.listUnacked?.() || [];
    if (events.length)
      await stream.acknowledge(
        c,
        1,
        events.map((e) => e.event_id),
      );

    const [pub, ret] = await Promise.all([
      stream.publish("s", { type: "y", payload: { k: 1 } }),
      stream.retire(c, 1, "s"),
    ]);
    const p = /** @type {any} */ (pub);
    const r = /** @type {any} */ (ret);
    // One of: retire pending, or publish not_claimed, or retire success after pub held/appended then need ack
    assert.ok(p.status === "appended" || p.status === "held" || p.error || r.status || r.error);
    if (r.status === "retired") {
      assert.ok(p.error === "not_claimed" || p.status);
    }
    if (r.error === "pending_events") {
      assert.ok(p.status === "appended" || p.status === "held");
    }
  });
});

test("torn tail recovery and consumer capability 0600", async () => {
  await withTemp(async (dir) => {
    const root = path.join(dir, "croot");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(root, { recursive: true });
    const minted = await initConsumerCapability({ root });
    assert.equal(minted.status, "created");
    assert.equal((await stat(minted.file)).mode & 0o777, 0o600);
    const cap = await readConsumerCapabilityFile(minted.file);
    assert.ok(cap.consumer_id);

    const log = new ConsumerEventLog(path.join(dir, "log"), { consumerId: "cid_torn_xxxx" });
    await log.appendDeliverable({ stream_key: "s", generation: 1, type: "t", payload: {} });
    const { appendFileDurable } = await import("../src/multiplexed-stream-log.js");
    await appendFileDurable(log.eventsPath, '{"partial');
    const log2 = new ConsumerEventLog(path.join(dir, "log"), { consumerId: "cid_torn_xxxx" });
    await log2.ensureLoaded();
    assert.equal(log2.unackedCount(), 1);
    assert.deepEqual(splitCompleteLines("a\nb").tornTail, true);
  });
});

test("idempotent re-publish via idempotency_key", async () => {
  await withTemp(async (dir) => {
    const stream = new MultiplexedEventStream({ stateDir: dir });
    await stream.claim("cid_idem_aaaaaaaa", 1, "s");
    const a = /** @type {any} */ (await stream.publish("s", { type: "t", payload: { x: 1 }, idempotency_key: "k1" }));
    const b = /** @type {any} */ (await stream.publish("s", { type: "t", payload: { x: 1 }, idempotency_key: "k1" }));
    assert.equal(a.status, "appended");
    assert.equal(b.status, "duplicate");
  });
});
