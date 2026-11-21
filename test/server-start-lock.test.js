import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireServerStartLock, serverStartLockPath } from "../src/cli.js";

async function withStateDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-start-lock-"));
  const previous = process.env.LAVISH_AXI_STATE_DIR;
  process.env.LAVISH_AXI_STATE_DIR = dir;
  try {
    await run(dir);
  } finally {
    if (previous === undefined) delete process.env.LAVISH_AXI_STATE_DIR;
    else process.env.LAVISH_AXI_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

async function exitCodeOf(child) {
  return new Promise((resolve) => child.on("exit", (code) => resolve(code)));
}

test("an acquired start lock records its holder and is removable and re-acquirable", async () => {
  await withStateDir(async () => {
    const release = await acquireServerStartLock({ budgetMs: 100, delayMs: 5 });
    assert.equal(typeof release, "function");
    assert.equal(existsSync(serverStartLockPath()), true);
    assert.equal(await readFile(serverStartLockPath(), "utf8"), String(process.pid), "the lock records its holder");
    release();
    assert.equal(existsSync(serverStartLockPath()), false);
    const reacquired = await acquireServerStartLock({ budgetMs: 100, delayMs: 5 });
    assert.equal(typeof reacquired, "function");
    reacquired();
    reacquired();
    assert.equal(existsSync(serverStartLockPath()), false, "release is idempotent");
  });
});

test("a start lock left by a dead holder is broken and taken", async () => {
  await withStateDir(async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await exitCodeOf(child);
    await writeFile(serverStartLockPath(), String(child.pid));
    const release = await acquireServerStartLock({ budgetMs: 100, delayMs: 5 });
    assert.equal(typeof release, "function", "a dead holder's lock is broken");
    release();
  });
});

test("a start lock held by a live holder is waited out, then honored after it clears", async () => {
  await withStateDir(async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      await writeFile(serverStartLockPath(), String(child.pid));
      const started = Date.now();
      const contended = await acquireServerStartLock({ budgetMs: 150, delayMs: 10 });
      assert.equal(contended, null, "a live holder keeps the lock for the budget");
      assert.ok(Date.now() - started >= 100, "the contender waited, not span");
    } finally {
      child.kill("SIGKILL");
      await exitCodeOf(child);
    }
    const release = await acquireServerStartLock({ budgetMs: 1000, delayMs: 5 });
    assert.equal(typeof release, "function", "once the holder exits the lock is taken");
    release();
  });
});

test("a corrupt start lock file is treated as stale", async () => {
  await withStateDir(async () => {
    await writeFile(serverStartLockPath(), "not-a-pid");
    const release = await acquireServerStartLock({ budgetMs: 100, delayMs: 5 });
    assert.equal(typeof release, "function");
    release();
  });
});
