import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import WebSocket from "ws";

import { run, stopCommand, VERSION } from "../src/cli.js";
import { controlTokenFile } from "../src/paths.js";
import { serve } from "../src/server.js";

async function controlTokenFor(dir) {
  return (await readFile(controlTokenFile(path.join(dir, "state.json")), "utf8")).trim();
}

const SERVER_ENTRY = fileURLToPath(new URL("../bin/lavish-axi-server.js", import.meta.url));

// 192.0.2.0/24 is TEST-NET-1: routable nowhere and assigned to no interface, so binding it fails
// with EADDRNOTAVAIL exactly the way a pinned Tailscale address does once Tailscale goes down.
const UNBINDABLE_HOST = "192.0.2.1";

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-bind-durability-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeArtifact(dir) {
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body>review</body></html>");
  return artifact;
}

async function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) previous[key] = process.env[key];
  const previousExitCode = process.exitCode;
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    process.exitCode = previousExitCode;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function listenHealth(host, port, body) {
  const server = createHttpServer((req, res) => {
    if (req.url?.startsWith("/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen({ host, port }, () => resolve(server));
  });
}

test("a degraded bind stays quiet while the requested address is still unavailable", async () => {
  await withTempDir(async (dir) => {
    const server = await serve({
      port: 0,
      stateFile: path.join(dir, "state.json"),
      version: "9.9.9-test",
      env: { LAVISH_AXI_HOST: UNBINDABLE_HOST },
      log: () => {},
      idleTimeoutMs: null,
    });
    try {
      assert.deepEqual(server.hosts, ["127.0.0.1"]);
      const health = await fetch(`http://127.0.0.1:${server.port}/health?reconcile_network=1`).then((response) =>
        response.json(),
      );
      assert.equal(health.ok, true);
      assert.equal(health.network_stale, undefined);
    } finally {
      await server.close();
    }
  });
});

test("a stale control-channel server is replaced only once per CLI invocation", { timeout: 20_000 }, async () => {
  await withTempDir(async (dir) => {
    const artifact = await writeArtifact(dir);

    async function countShutdowns(healthBody) {
      let shutdowns = 0;
      const fake = createHttpServer((req, res) => {
        if (req.url?.startsWith("/health")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(healthBody));
          return;
        }
        if (req.method === "POST" && req.url === "/shutdown") {
          shutdowns += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise((resolve) => fake.listen({ host: "127.0.0.1", port: 0 }, () => resolve(undefined)));
      const port = /** @type {{ port: number }} */ (fake.address()).port;
      try {
        await withEnv(
          {
            LAVISH_AXI_PORT: String(port),
            LAVISH_AXI_HOST: "127.0.0.1",
            LAVISH_AXI_STATE_DIR: dir,
            LAVISH_AXI_NO_OPEN: "1",
            LAVISH_AXI_TELEMETRY: "0",
            // The real server this spawns can take the port once the fake closes; let it idle out
            // instead of outliving the test.
            LAVISH_AXI_IDLE_TIMEOUT_MS: "1000",
          },
          async () => {
            try {
              await run(["open", artifact, "--no-open"]);
            } catch {
              // The fake control channel has no session route; axi-sdk may print that 404
              // without throwing. The assertion below is the replacement-count contract.
            }
          },
        );
      } finally {
        await new Promise((resolve) => fake.close(() => resolve(undefined)));
      }
      return shutdowns;
    }

    assert.equal(await countShutdowns({ ok: true, app: "lavish-axi", version: VERSION, network_stale: true }), 1);
    assert.equal(await countShutdowns({ ok: true, app: "lavish-axi", version: "0.0.1", network_stale: true }), 2);
  });
});

test("an occupied loopback control address prevents binding another listener", async () => {
  await withTempDir(async (dir) => {
    // Drops each connection: startup probes an occupied loopback port for a Lavish owner, and a
    // connection nobody reads would hold this server's close() open.
    const squatter = createServer((socket) => socket.destroy());
    await new Promise((resolve) => squatter.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined)));
    const occupiedPort = /** @type {{ port: number }} */ (squatter.address()).port;
    try {
      await assert.rejects(
        serve({
          port: occupiedPort,
          stateFile: path.join(dir, "state.json"),
          version: "9.9.9-test",
          env: {},
          hosts: ["127.0.0.1", "::1"],
          log: () => {},
          idleTimeoutMs: null,
        }),
        (error) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Loopback .* already in use/);
          return true;
        },
      );
      const probe = createServer();
      await new Promise((resolve, reject) => {
        probe.once("error", reject);
        probe.listen({ port: occupiedPort, host: "::1" }, () => resolve(undefined));
      });
      await new Promise((resolve) => probe.close(() => resolve(undefined)));
    } finally {
      await new Promise((resolve) => squatter.close(() => resolve(undefined)));
    }
  });
});

test("an occupied requested address does not report network_stale after loopback fallback", async () => {
  await withTempDir(async (dir) => {
    const occupiedHost = "::1";
    // Drops each connection: startup probes an occupied loopback port for a Lavish owner, and a
    // connection nobody reads would hold this server's close() open.
    const squatter = createServer((socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      squatter.once("error", reject);
      squatter.listen({ port: 0, host: occupiedHost }, () => resolve(undefined));
    });
    const occupiedPort = /** @type {{ port: number }} */ (squatter.address()).port;
    try {
      const server = await serve({
        port: occupiedPort,
        stateFile: path.join(dir, "state.json"),
        version: "9.9.9-test",
        env: { LAVISH_AXI_HOST: occupiedHost },
        log: () => {},
        idleTimeoutMs: null,
      });
      try {
        assert.deepEqual(server.hosts, ["127.0.0.1"]);
        assert.equal(server.port, occupiedPort);
        const health = await fetch(`http://127.0.0.1:${server.port}/health?reconcile_network=1`).then((response) =>
          response.json(),
        );
        assert.equal(health.ok, true);
        assert.equal(health.network_stale, undefined);
      } finally {
        await server.close();
      }
    } finally {
      await new Promise((resolve) => squatter.close(() => resolve(undefined)));
    }
  });
});

test("a sole unbindable host falls back to loopback instead of leaving no listener", async () => {
  await withTempDir(async (dir) => {
    const artifact = await writeArtifact(dir);
    const logs = [];
    // Before the fix this rejected: the "has anything bound yet" guard ran before the retry and
    // before any fallback, so a single pinned host that could not bind exited with no listener at
    // all and the CLI reported "Lavish Editor server did not start".
    const server = await serve({
      port: 0,
      stateFile: path.join(dir, "state.json"),
      version: "9.9.9-test",
      env: {},
      hosts: [UNBINDABLE_HOST],
      log: (line) => logs.push(line),
      idleTimeoutMs: null,
    });
    try {
      assert.deepEqual(server.hosts, ["127.0.0.1"]);

      const health = await fetch(`http://127.0.0.1:${server.port}/health`).then((response) => response.json());
      assert.equal(health.ok, true);
      assert.ok(
        logs.some((line) => line.includes(UNBINDABLE_HOST) && line.includes("fell back to loopback")),
        `expected a loopback-fallback warning, got ${JSON.stringify(logs)}`,
      );

      // A session URL has to name somewhere that is actually listening, so the fallback moves the
      // link host too - otherwise every URL points at the address that just failed to bind.
      const opened = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: artifact }),
      }).then((response) => response.json());
      assert.match(opened.url, new RegExp(`^http://127\\.0\\.0\\.1:${server.port}/session/`));
      assert.match(opened.network_warning, /fell back to loopback/);
    } finally {
      await server.close();
    }
  });
});

test("a bind that cannot succeed anywhere still fails loudly and names the cause", async () => {
  await withTempDir(async (dir) => {
    // Occupy loopback so even the fallback has nowhere to go: the retry must terminate and the
    // failure must still surface, rather than the loop spinning or swallowing the reason.
    // Drops each connection: startup probes an occupied loopback port for a Lavish owner, and a
    // connection nobody reads would hold this server's close() open.
    const squatter = createServer((socket) => socket.destroy());
    await new Promise((resolve) => squatter.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined)));
    const occupiedPort = /** @type {{ port: number }} */ (squatter.address()).port;
    try {
      await assert.rejects(
        serve({
          port: occupiedPort,
          stateFile: path.join(dir, "state.json"),
          version: "9.9.9-test",
          env: {},
          hosts: ["127.0.0.1"],
          log: () => {},
          idleTimeoutMs: null,
        }),
        (error) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Loopback .* already in use/);
          // The cause has to survive so a caller can diagnose the occupied port.
          assert.ok(error.cause instanceof Error && "code" in error.cause);
          assert.equal(error.cause.code, "EADDRINUSE");
          return true;
        },
      );
    } finally {
      await new Promise((resolve) => squatter.close(() => resolve(undefined)));
    }
  });
});

// A bounded timeout, because the pre-fix behaviour is not a wrong value but an absent event:
// the mute socket simply stays open forever, so without this a regression hangs the suite.
test(
  "an unresponsive live-event client is reaped so the server stops counting a reviewer who is gone",
  { timeout: 5000 },
  async () => {
    await withTempDir(async (dir) => {
      const artifact = await writeArtifact(dir);
      const server = await serve({
        port: 0,
        stateFile: path.join(dir, "state.json"),
        version: "9.9.9-test",
        env: {},
        hosts: ["127.0.0.1"],
        log: () => {},
        idleTimeoutMs: null,
        liveEventHeartbeatMs: 60,
      });
      const base = `http://127.0.0.1:${server.port}`;
      try {
        const opened = await fetch(`${base}/api/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ file: artifact }),
        }).then((response) => response.json());

        // A slept laptop or a dropped tailnet path leaves a socket that answers nothing and never
        // emits `close`. `autoPong: false` reproduces exactly that: the connection is open at the
        // TCP level and silent at the application level.
        const mute = new WebSocket(`${base.replace(/^http/, "ws")}/events/${opened.key}`, {
          origin: base,
          autoPong: false,
        });
        await once(mute, "open");
        await once(mute, "close");
        assert.equal(mute.readyState, WebSocket.CLOSED);
      } finally {
        await server.close();
      }
    });
  },
);

test("a live-event client that answers its pings is left connected", async () => {
  await withTempDir(async (dir) => {
    const artifact = await writeArtifact(dir);
    const server = await serve({
      port: 0,
      stateFile: path.join(dir, "state.json"),
      version: "9.9.9-test",
      env: {},
      hosts: ["127.0.0.1"],
      log: () => {},
      idleTimeoutMs: null,
      liveEventHeartbeatMs: 40,
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const opened = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: artifact }),
      }).then((response) => response.json());

      const healthy = new WebSocket(`${base.replace(/^http/, "ws")}/events/${opened.key}`, { origin: base });
      await once(healthy, "open");
      let closed = false;
      healthy.once("close", () => {
        closed = true;
      });
      // Several heartbeat rounds: a reviewer sitting quietly on a board must never be reaped as
      // absent, which is the failure mode a liveness check most easily introduces.
      await new Promise((resolve) => setTimeout(resolve, 260));
      assert.equal(closed, false);
      assert.equal(healthy.readyState, WebSocket.OPEN);
      healthy.close();
    } finally {
      await server.close();
    }
  });
});

test("a module-load failure after the stdio writer is installed is timestamped", async () => {
  await withTempDir(async (dir) => {
    const thrower = path.join(dir, "throw.mjs");
    await writeFile(thrower, "throw new Error('cli-load-failed');\n");
    const boot = path.join(dir, "boot.mjs");
    const serverLog = pathToFileURL(fileURLToPath(new URL("../src/server-log.js", import.meta.url))).href;
    await writeFile(
      boot,
      `import { installServerStdioTimestamps } from ${JSON.stringify(serverLog)};
installServerStdioTimestamps();
try {
  await import(${JSON.stringify(pathToFileURL(thrower).href)});
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
`,
    );
    const logFile = path.join(dir, "out.log");
    const fd = openSync(logFile, "a");
    try {
      const child = spawn(process.execPath, [boot], { stdio: ["ignore", fd, fd] });
      await once(child, "exit");
    } finally {
      closeSync(fd);
    }
    const log = await readFile(logFile, "utf8");
    assert.match(log, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /m);
    assert.match(log, /cli-load-failed/);
  });
});

test("a clean detached-server shutdown exits 0 without an error in server.log", async () => {
  await withTempDir(async (dir) => {
    const holder = createServer();
    await new Promise((resolve) => holder.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined)));
    const port = /** @type {{ port: number }} */ (holder.address()).port;
    await new Promise((resolve) => holder.close(() => resolve(undefined)));
    const logFile = path.join(dir, "server.log");
    const fd = openSync(logFile, "a");
    const child = spawn(process.execPath, [SERVER_ENTRY, "server", "--port", String(port)], {
      env: {
        ...process.env,
        LAVISH_AXI_STATE_DIR: dir,
        LAVISH_AXI_HOST: "127.0.0.1",
        LAVISH_AXI_NO_OPEN: "1",
        LAVISH_AXI_TELEMETRY: "0",
        LAVISH_AXI_IDLE_TIMEOUT_MS: "off",
      },
      stdio: ["ignore", fd, fd],
    });
    try {
      const deadline = Date.now() + 5000;
      let ready = false;
      while (Date.now() < deadline) {
        try {
          const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
          if (health.ok) {
            ready = true;
            break;
          }
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      assert.equal(ready, true);
      await fetch(`http://127.0.0.1:${port}/shutdown`, {
        method: "POST",
        headers: { "lavish-control-token": await controlTokenFor(dir) },
      });
      const [code] = await once(child, "exit");
      assert.equal(code, 0);
    } finally {
      child.kill();
      closeSync(fd);
    }
    const log = await readFile(logFile, "utf8");
    assert.doesNotMatch(log, /TypeError/);
    assert.doesNotMatch(log, /run is not a function/);
    assert.doesNotMatch(log, /\bError:/);
  });
});

test("a detached server crash writes a timestamped line to server.log", async () => {
  await withTempDir(async (dir) => {
    // Drops each connection: startup probes an occupied loopback port for a Lavish owner, and a
    // connection nobody reads would hold this server's close() open.
    const squatter = createServer((socket) => socket.destroy());
    await new Promise((resolve) => squatter.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined)));
    const occupiedPort = /** @type {{ port: number }} */ (squatter.address()).port;
    const logFile = path.join(dir, "server.log");
    const fd = openSync(logFile, "a");
    try {
      const child = spawn(process.execPath, [SERVER_ENTRY, "server", "--port", String(occupiedPort)], {
        env: {
          ...process.env,
          LAVISH_AXI_STATE_DIR: dir,
          LAVISH_AXI_HOST: "127.0.0.1",
          LAVISH_AXI_NO_OPEN: "1",
          LAVISH_AXI_TELEMETRY: "0",
        },
        stdio: ["ignore", fd, fd],
      });
      await once(child, "exit");
    } finally {
      closeSync(fd);
      await new Promise((resolve) => squatter.close(() => resolve(undefined)));
    }
    const log = await readFile(logFile, "utf8");
    assert.match(log, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /m);
  });
});

test(
  "a post-listen HTTP error is logged while the server remains controllably alive",
  { timeout: 10_000 },
  async () => {
    await withTempDir(async (dir) => {
      const preload = path.join(dir, "post-listen-error.mjs");
      await writeFile(
        preload,
        `import net from "node:net";
const originalEmit = net.Server.prototype.emit;
net.Server.prototype.emit = function (event, ...args) {
  if (event === "listening" && !this.__lavishPostListenRepro) {
    this.__lavishPostListenRepro = true;
    setImmediate(() => this.emit("error", new Error("post-listen-repro")));
  }
  return originalEmit.call(this, event, ...args);
};
`,
      );
      const holder = createServer();
      await new Promise((resolve) => holder.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined)));
      const port = /** @type {{ port: number }} */ (holder.address()).port;
      await new Promise((resolve) => holder.close(() => resolve(undefined)));
      const logFile = path.join(dir, "server.log");
      const fd = openSync(logFile, "a");
      const child = spawn(process.execPath, [SERVER_ENTRY, "server", "--port", String(port)], {
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
          LAVISH_AXI_STATE_DIR: dir,
          LAVISH_AXI_HOST: "127.0.0.1",
          LAVISH_AXI_NO_OPEN: "1",
          LAVISH_AXI_TELEMETRY: "0",
          LAVISH_AXI_IDLE_TIMEOUT_MS: "off",
        },
        stdio: ["ignore", fd, fd],
      });
      try {
        let ready = false;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          try {
            const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
            if (health.ok) {
              ready = true;
              break;
            }
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        assert.equal(ready, true, "post-listen error must not take down the server");
        await fetch(`http://127.0.0.1:${port}/shutdown`, {
          method: "POST",
          headers: { "lavish-control-token": await controlTokenFor(dir) },
        });
        const [code] = await once(child, "exit");
        assert.equal(code, 0);
      } finally {
        child.kill();
        closeSync(fd);
      }
      const log = await readFile(logFile, "utf8");
      assert.match(
        log,
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[lavish\] HTTP server error: post-listen-repro$/m,
      );
    });
  },
);

test("an uncaught server exception is timestamped before deterministic exit", { timeout: 10_000 }, async () => {
  await withTempDir(async (dir) => {
    const preload = path.join(dir, "uncaught-error.mjs");
    await writeFile(preload, `setTimeout(() => { throw new Error("uncaught-repro"); }, 200);\n`);
    const logFile = path.join(dir, "server.log");
    const fd = openSync(logFile, "a");
    const child = spawn(process.execPath, [SERVER_ENTRY, "server", "--port", "0"], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        LAVISH_AXI_STATE_DIR: dir,
        LAVISH_AXI_HOST: "127.0.0.1",
        LAVISH_AXI_NO_OPEN: "1",
        LAVISH_AXI_TELEMETRY: "0",
        LAVISH_AXI_IDLE_TIMEOUT_MS: "off",
      },
      stdio: ["ignore", fd, fd],
    });
    try {
      const [code] = await once(child, "exit");
      assert.equal(code, 1);
    } finally {
      child.kill();
      closeSync(fd);
    }
    const log = await readFile(logFile, "utf8");
    assert.match(
      log,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[lavish\] uncaught exception: Error: uncaught-repro$/m,
    );
  });
});

test("a shutdown records why it happened", async () => {
  await withTempDir(async (dir) => {
    const logs = [];
    const server = await serve({
      port: 0,
      stateFile: path.join(dir, "state.json"),
      version: "9.9.9-test",
      env: {},
      hosts: ["127.0.0.1"],
      log: (line) => logs.push(line),
      idleTimeoutMs: null,
    });
    await server.close();
    // server.log previously recorded an exit with no explanation at all, which is what made
    // "was it the idle timeout, a version replacement, or a crash?" unanswerable after the fact.
    assert.ok(
      logs.some((line) => line.includes("shutting down") && line.includes("close() called")),
      `expected a shutdown cause in the log, got ${JSON.stringify(logs)}`,
    );
  });
});

test("the control channel finds a fallen-back server on loopback", async () => {
  await withTempDir(async (dir) => {
    const server = await serve({
      port: 0,
      stateFile: path.join(dir, "state.json"),
      version: "9.9.9-test",
      env: { LAVISH_AXI_HOST: UNBINDABLE_HOST },
      log: () => {},
      idleTimeoutMs: null,
    });
    try {
      assert.deepEqual(server.hosts, ["127.0.0.1"]);
      const output = await withEnv(
        {
          LAVISH_AXI_PORT: String(server.port),
          LAVISH_AXI_HOST: UNBINDABLE_HOST,
          LAVISH_AXI_STATE_DIR: dir,
        },
        () => stopCommand([]),
      );
      assert.equal(output.server.status, "stopped");
    } finally {
      await server.close().catch(() => {});
    }
  });
});

test(
  "discovery prefers Lavish on loopback over a hanging or foreign requested address",
  { timeout: 10_000 },
  async () => {
    await withTempDir(async (dir) => {
      const lavish = await serve({
        port: 0,
        stateFile: path.join(dir, "state.json"),
        version: "9.9.9-test",
        env: { LAVISH_AXI_HOST: "127.0.0.1" },
        hosts: ["127.0.0.1"],
        log: () => {},
        idleTimeoutMs: null,
      });
      const port = lavish.port;
      const hanging = createHttpServer(() => {});
      await new Promise((resolve) => hanging.listen({ host: "::1", port }, () => resolve(undefined)));
      try {
        const started = Date.now();
        const output = await withEnv(
          {
            LAVISH_AXI_PORT: String(port),
            LAVISH_AXI_HOST: "::1",
            LAVISH_AXI_STATE_DIR: dir,
          },
          () => stopCommand([]),
        );
        assert.equal(output.server.status, "stopped");
        assert.ok(Date.now() - started < 1500, `discovery stalled for ${Date.now() - started}ms`);
      } finally {
        await new Promise((resolve) => hanging.close(() => resolve(undefined)));
        await lavish.close().catch(() => {});
      }
    });

    await withTempDir(async (dir) => {
      const lavish = await serve({
        port: 0,
        stateFile: path.join(dir, "state.json"),
        version: "9.9.9-test",
        env: { LAVISH_AXI_HOST: "127.0.0.1" },
        hosts: ["127.0.0.1"],
        log: () => {},
        idleTimeoutMs: null,
      });
      const port = lavish.port;
      const foreign = await listenHealth("::1", port, { ok: true, app: "other", version: "0.0.0" });
      try {
        const output = await withEnv(
          {
            LAVISH_AXI_PORT: String(port),
            LAVISH_AXI_HOST: "::1",
            LAVISH_AXI_STATE_DIR: dir,
          },
          () => stopCommand([]),
        );
        assert.equal(output.server.status, "stopped");
      } finally {
        await new Promise((resolve) => foreign.close(() => resolve(undefined)));
        await lavish.close().catch(() => {});
      }
    });

    const foreignOnly = await listenHealth("::1", 0, { ok: true, app: "other", version: "0.0.0" });
    const foreignPort = /** @type {{ port: number }} */ (foreignOnly.address()).port;
    try {
      const output = await withEnv(
        {
          LAVISH_AXI_PORT: String(foreignPort),
          LAVISH_AXI_HOST: "::1",
        },
        () => stopCommand([]),
      );
      assert.equal(output.server.status, "not-lavish");
    } finally {
      await new Promise((resolve) => foreignOnly.close(() => resolve(undefined)));
    }

    const none = await withEnv(
      {
        LAVISH_AXI_PORT: "1",
        LAVISH_AXI_HOST: UNBINDABLE_HOST,
      },
      () => stopCommand([]),
    );
    assert.equal(none.server.status, "not-running");
  },
);
