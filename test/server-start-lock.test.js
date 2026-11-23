import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("an empty lock file between create and PID write is not broken", async () => {
  await withStateDir(async () => {
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      await writeFile(serverStartLockPath(), "");
      await writeFile(serverStartLockPath(), String(holder.pid));
      const contender = await acquireServerStartLock({ budgetMs: 120, delayMs: 10 });
      assert.equal(contender, null, "the holder keeps the lock");
      // A caller that read nothing between the holder's create and PID write must not break it.
      await rm(serverStartLockPath(), { force: true });
      await writeFile(serverStartLockPath(), "");
      const justCreated = await acquireServerStartLock({ budgetMs: 120, delayMs: 10 });
      assert.equal(justCreated, null, "a just-created empty lock is not treated as stale");
      // Restore the holder's PID record, then retire the holder so the lock becomes takeable.
      await rm(serverStartLockPath(), { force: true });
      await writeFile(serverStartLockPath(), String(holder.pid));
    } finally {
      holder.kill("SIGKILL");
      await exitCodeOf(holder);
    }
    const release = await acquireServerStartLock({ budgetMs: 1000, delayMs: 5 });
    assert.equal(typeof release, "function", "once the holder exits the lock is taken");
    release();
  });
});

test("a release does not remove a successor's lock that replaced it", async () => {
  await withStateDir(async () => {
    const successor = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      const release = await acquireServerStartLock({ budgetMs: 100, delayMs: 5 });
      // A contender broke our lock and took over with its own live-pid lock under a new inode.
      await rm(serverStartLockPath(), { force: true });
      await writeFile(serverStartLockPath(), String(successor.pid));
      release();
      assert.equal(await readFile(serverStartLockPath(), "utf8"), String(successor.pid));
    } finally {
      successor.kill("SIGKILL");
      await exitCodeOf(successor);
    }
    const release = await acquireServerStartLock({ budgetMs: 1000, delayMs: 5 });
    assert.equal(typeof release, "function");
    release();
  });
});

test("a release does not remove a same-inode lock whose recorded PID is no longer ours", async () => {
  await withStateDir(async () => {
    const successor = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      const release = await acquireServerStartLock({ budgetMs: 100, delayMs: 5 });
      // A contender rewrote the path's content to its own live PID under the same inode
      // (same dev/ino, different recorded holder): the path no longer names our lock.
      await writeFile(serverStartLockPath(), String(successor.pid));
      release();
      assert.equal(await readFile(serverStartLockPath(), "utf8"), String(successor.pid));
    } finally {
      successor.kill("SIGKILL");
      await exitCodeOf(successor);
    }
    const release = await acquireServerStartLock({ budgetMs: 1000, delayMs: 5 });
    assert.equal(typeof release, "function");
    release();
  });
});

test(
  "an unreadable start lock is waited out for the budget, not spun on",
  { skip: process.platform === "win32" },
  async () => {
    await withStateDir(async () => {
      // A lock no contender can read (EACCES on every open) must not turn the acquire loop
      // into a synchronous hot spin: the waiter has to spend the startup budget instead.
      await writeFile(serverStartLockPath(), String(process.pid));
      await chmod(serverStartLockPath(), 0o000);
      const previous = process.env.LAVISH_AXI_STARTUP_WAIT_MS;
      process.env.LAVISH_AXI_STARTUP_WAIT_MS = "150";
      try {
        const started = Date.now();
        const outcome = await acquireServerStartLock({ delayMs: 10 });
        assert.equal(outcome, null, "an unreadable lock is never taken");
        assert.ok(Date.now() - started >= 120, "the contender honored LAVISH_AXI_STARTUP_WAIT_MS instead of spinning");
      } finally {
        if (previous === undefined) delete process.env.LAVISH_AXI_STARTUP_WAIT_MS;
        else process.env.LAVISH_AXI_STARTUP_WAIT_MS = previous;
        await chmod(serverStartLockPath(), 0o600);
      }
    });
  },
);
