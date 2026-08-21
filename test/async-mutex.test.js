import assert from "node:assert/strict";
import test from "node:test";

import { AsyncMutex } from "../src/async-mutex.js";

test("runExclusive serializes critical sections that overlap on the microtask queue", async () => {
  const lock = new AsyncMutex();
  const order = [];
  let active = 0;
  let maxActive = 0;

  async function section(label) {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`${label}:enter`);
    // Yield across several turns so a non-serialized version would interleave.
    await Promise.resolve();
    await Promise.resolve();
    order.push(`${label}:exit`);
    active -= 1;
  }

  await Promise.all([
    lock.runExclusive(() => section("a")),
    lock.runExclusive(() => section("b")),
    lock.runExclusive(() => section("c")),
  ]);

  assert.equal(maxActive, 1, "at most one critical section runs at a time");
  assert.deepEqual(order, ["a:enter", "a:exit", "b:enter", "b:exit", "c:enter", "c:exit"]);
});

test("runExclusive returns the callback result and never wedges after a rejection", async () => {
  const lock = new AsyncMutex();
  await assert.rejects(
    lock.runExclusive(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  // A failed section must not poison the lock for the next caller.
  const value = await lock.runExclusive(async () => 42);
  assert.equal(value, 42);
});
