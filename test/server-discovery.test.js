import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import WebSocket from "ws";

import { inheritedListenHosts, run, stopCommand, VERSION } from "../src/cli.js";
import { stateId } from "../src/paths.js";
import { serve } from "../src/server.js";

// 192.0.2.0/24 is TEST-NET-1: assigned to no interface, so binding it fails with EADDRNOTAVAIL.
const UNBINDABLE_HOST = "192.0.2.1";

// A second concrete address on this machine, standing in for the Tailscale or LAN address one
// agent pins with LAVISH_AXI_HOST while another agent on the same machine sets nothing.
function otherLocalIpv4() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal && entry.address !== "127.0.0.1") return entry.address;
    }
  }
  return null;
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-discovery-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeArtifact(dir, name = "artifact.html") {
  const artifact = path.join(dir, name);
  await writeFile(artifact, "<!doctype html><html><body>review</body></html>");
  // Session identity is the canonical path, and tmpdir() is behind a symlink on macOS.
  return realpath(artifact);
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

function cliEnv(dir, port, host) {
  return {
    LAVISH_AXI_PORT: String(port),
    LAVISH_AXI_HOST: host,
    LAVISH_AXI_STATE_DIR: dir,
    LAVISH_AXI_NO_OPEN: "1",
    LAVISH_AXI_TELEMETRY: "0",
    LAVISH_AXI_IDLE_TIMEOUT_MS: "60000",
  };
}

// The opt-in sweep that also dials every other local interface address. These tests stand in for a
// 0.1.77-or-older server pinned to a Tailscale or LAN address alone, which only the sweep can find.
function sweepEnv(dir, port, host) {
  return { ...cliEnv(dir, port, host), LAVISH_AXI_DISCOVER_ALL_INTERFACES: "1" };
}

// The CLI prints its TOON result to stdout; these tests assert on server and state effects instead.
async function runCli(args) {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await run(args);
  } finally {
    process.stdout.write = write;
  }
}

async function captureCli(args) {
  const write = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  try {
    await run(args);
  } finally {
    process.stdout.write = write;
  }
  return output;
}

async function freePort(host = "127.0.0.1") {
  const probe = createServer();
  await new Promise((resolve) => probe.listen({ port: 0, host }, () => resolve(undefined)));
  const { port } = /** @type {{ port: number }} */ (probe.address());
  await new Promise((resolve) => probe.close(() => resolve(undefined)));
  return port;
}

async function listenRaw(host, port) {
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port }, () => resolve(undefined));
  });
  return server;
}

function closeRaw(server) {
  return new Promise((resolve) => server.close(() => resolve(undefined)));
}

async function health(host, port, query = "") {
  const response = await fetch(`http://${host}:${port}/health${query}`, { signal: AbortSignal.timeout(3000) });
  return response.json();
}

async function reachable(host, port) {
  try {
    await health(host, port);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function ipv6LoopbackAvailable() {
  try {
    await closeRaw(await listenRaw("::1", 0));
    return true;
  } catch {
    return false;
  }
}

async function getStatus(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  await response.arrayBuffer();
  return response.status;
}

async function isResolved(promise) {
  return Promise.race([promise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 50))]);
}

async function stateSessions(dir) {
  const raw = await readFile(path.join(dir, "state.json"), "utf8").catch(() => "{}");
  const state = JSON.parse(raw);
  return Object.values(state.sessions || {}).map((session) => session.file);
}

async function openSession(host, port, file) {
  const response = await fetch(`http://${host}:${port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file }),
  });
  return response.json();
}

async function shutdownAt(host, port) {
  await fetch(`http://${host}:${port}/shutdown`, { method: "POST" }).catch(() => {});
  await waitFor(async () => !(await reachable(host, port)));
}

test(
  "a live-event client that attaches while a later address is still binding does not crash the server",
  { timeout: 15_000 },
  async () => {
    await withTempDir(async (dir) => {
      const port = await freePort();
      // Loopback binds first and then the unbindable host spends its retry budget. A restarted
      // server's reviewers reconnect exactly in that window, which used to throw
      // "Cannot access 'idleTimer' before initialization" and take the new server down.
      const starting = serve({
        port,
        stateFile: path.join(dir, "state.json"),
        version: "9.9.9-test",
        env: {},
        detectTailscale: null,
        hosts: ["127.0.0.1", UNBINDABLE_HOST],
        log: () => {},
        idleTimeoutMs: 60_000,
        bindRecoveryDelaysMs: [],
      });
      let ready = false;
      starting.then(
        () => {
          ready = true;
        },
        () => {
          ready = true;
        },
      );
      let attachedDuringStartup = false;
      /** @type {WebSocket | null} */
      let socket = null;
      while (!ready && !attachedDuringStartup) {
        const candidate = new WebSocket(`ws://127.0.0.1:${port}/events/0123456789abcdef`, {
          origin: `http://127.0.0.1:${port}`,
        });
        attachedDuringStartup = await new Promise((resolve) => {
          candidate.once("open", () => resolve(!ready));
          candidate.once("error", () => resolve(false));
        });
        if (attachedDuringStartup) socket = candidate;
        else await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(attachedDuringStartup, true, "expected a live-event client to attach before startup finished");
      const server = await starting;
      try {
        assert.deepEqual(server.hosts, ["127.0.0.1"]);
        assert.equal((await health("127.0.0.1", server.port)).ok, true);
      } finally {
        socket?.close();
        await server.close();
      }
    });
  },
);

test(
  "a requested address that is taken is retried in the background, reported loudly, and served once free",
  { timeout: 15_000 },
  async (t) => {
    const otherHost = otherLocalIpv4();
    if (!otherHost) {
      t.skip("host has no non-loopback IPv4 address");
      return;
    }
    await withTempDir(async (dir) => {
      const artifact = await writeArtifact(dir);
      const port = await freePort(otherHost);
      const squatter = await listenRaw(otherHost, port);
      const logs = [];
      const server = await serve({
        port,
        stateFile: path.join(dir, "state.json"),
        version: "9.9.9-test",
        env: { LAVISH_AXI_HOST: otherHost },
        log: (line) => logs.push(line),
        idleTimeoutMs: null,
        bindRecoveryDelaysMs: [100],
      });
      try {
        assert.deepEqual(server.hosts, ["127.0.0.1"]);
        const degraded = await health("127.0.0.1", port);
        assert.deepEqual(degraded.hosts, ["127.0.0.1"]);
        assert.deepEqual(degraded.requested_hosts, [otherHost, "127.0.0.1"]);
        assert.match(degraded.network_warning, new RegExp(`Could not bind ${otherHost}:${port} \\(EADDRINUSE`));
        assert.match(degraded.network_warning, /keeps retrying/);
        assert.ok(
          logs.some((line) => line.includes("WARNING") && line.includes(`${otherHost}:${port}`)),
          `expected a logged warning, got ${JSON.stringify(logs)}`,
        );
        const whileDegraded = await openSession("127.0.0.1", port, artifact);
        assert.match(whileDegraded.url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/session/`));
        assert.match(whileDegraded.network_warning, /EADDRINUSE/);

        await closeRaw(squatter);
        assert.ok(await waitFor(async () => (await health("127.0.0.1", port)).hosts.includes(otherHost)));
        const recovered = await health(otherHost, port);
        assert.equal(recovered.network_warning, undefined);
        assert.ok(logs.some((line) => line.includes(`now listening on ${otherHost}:${port}`)));
        const reopened = await openSession(otherHost, port, artifact);
        assert.match(reopened.url, new RegExp(`^http://${otherHost.replaceAll(".", "\\.")}:${port}/session/`));
        assert.equal(reopened.network_warning, undefined);
      } finally {
        await server.close();
        await closeRaw(squatter).catch(() => {});
      }
    });
  },
);

test(
  "a Tailscale address freed after startup is bound by the next reconcile and restores the MagicDNS link",
  { timeout: 15_000 },
  async (t) => {
    const tailscaleIpv4 = otherLocalIpv4();
    if (!tailscaleIpv4) {
      t.skip("host has no non-loopback IPv4 address");
      return;
    }
    await withTempDir(async (dir) => {
      const artifact = await writeArtifact(dir);
      const port = await freePort(tailscaleIpv4);
      const squatter = await listenRaw(tailscaleIpv4, port);
      const magicDnsName = "review-phone.example.ts.net";
      const server = await serve({
        port,
        stateFile: path.join(dir, "state.json"),
        version: "9.9.9-test",
        env: {},
        detectTailscale: async () => ({ ipv4: tailscaleIpv4, magicDnsName }),
        log: () => {},
        idleTimeoutMs: null,
        // Far beyond the test: only the reconcile a CLI invocation triggers can bind it here.
        bindRecoveryDelaysMs: [600_000],
      });
      try {
        const degraded = await openSession("127.0.0.1", port, artifact);
        assert.match(degraded.url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/session/`));
        assert.match(
          degraded.network_warning,
          new RegExp(`Tailscale binding failed for ${tailscaleIpv4}:${port} \\(EADDRINUSE.*no phone access`),
        );

        await closeRaw(squatter);
        const reconciled = await health("127.0.0.1", port, "?reconcile_network=1");
        assert.equal(reconciled.network_stale, undefined);
        assert.equal(reconciled.network_warning, undefined);
        assert.ok(reconciled.hosts.includes(tailscaleIpv4));
        const recovered = await openSession("127.0.0.1", port, artifact);
        assert.equal(recovered.url, `http://${magicDnsName}:${port}/session/${recovered.key}`);
      } finally {
        await server.close();
        await closeRaw(squatter).catch(() => {});
      }
    });
  },
);

test("a second server for a port whose loopback a Lavish server owns refuses to start", async (t) => {
  const otherHost = otherLocalIpv4();
  if (!otherHost) {
    t.skip("host has no non-loopback IPv4 address");
    return;
  }
  await withTempDir(async (dir) => {
    const owner = await serve({
      port: 0,
      stateFile: path.join(dir, "state.json"),
      version: "9.9.9-test",
      env: {},
      detectTailscale: null,
      hosts: ["127.0.0.1"],
      log: () => {},
      idleTimeoutMs: null,
    });
    try {
      await assert.rejects(
        serve({
          port: owner.port,
          stateFile: path.join(dir, "state.json"),
          version: "9.9.9-test",
          env: { LAVISH_AXI_HOST: otherHost },
          log: () => {},
          idleTimeoutMs: null,
        }),
        /Another Lavish server .* already owns port/,
      );
      // The loser must not have taken the other address on its way out: a split daemon pair on one
      // port is exactly what the loopback owner check exists to prevent.
      const probe = await listenRaw(otherHost, owner.port);
      await closeRaw(probe);
    } finally {
      await owner.close();
    }
  });
});

test("a foreign loopback listener prevents a pinned server from claiming the same port", async (t) => {
  const otherHost = otherLocalIpv4();
  if (!otherHost) {
    t.skip("host has no non-loopback IPv4 address");
    return;
  }
  await withTempDir(async (dir) => {
    const loopback = await listenRaw("127.0.0.1", 0);
    const port = /** @type {import('node:net').AddressInfo} */ (loopback.address()).port;
    try {
      const contender = await serve({
        port,
        stateFile: path.join(dir, "state.json"),
        version: "9.9.9-test",
        env: { LAVISH_AXI_HOST: otherHost },
        log: () => {},
        idleTimeoutMs: null,
      }).then(
        (server) => ({ server, error: null }),
        (error) => ({ server: null, error }),
      );
      try {
        assert.match(contender.error?.message || "", /loopback.*already in use|already in use.*loopback/i);
        const available = await listenRaw(otherHost, port);
        await closeRaw(available);
      } finally {
        await contender.server?.close();
      }
    } finally {
      await closeRaw(loopback);
    }
  });
});

test("a symlinked state directory adopts the daemon started at its target", async () => {
  await withTempDir(async (dir) => {
    const alias = path.join(dir, "alias");
    await symlink(dir, alias, "dir");
    const artifact = await writeArtifact(dir);
    const port = await freePort();
    const owner = await serve({
      port,
      stateFile: path.join(dir, "state.json"),
      version: VERSION,
      env: { LAVISH_AXI_HOST: "127.0.0.1" },
      detectTailscale: null,
      log: () => {},
      idleTimeoutMs: null,
    });
    try {
      await withEnv(cliEnv(alias, port, "127.0.0.1"), async () => {
        await runCli(["open", artifact, "--no-open"]);
      });
      assert.equal(await isResolved(owner.done), false, "the original daemon was replaced");
      const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
      assert.equal(health.state_id, stateId(path.join(alias, "state.json")));
      assert.equal(health.version, VERSION);
    } finally {
      await owner.close();
    }
  });
});

test(
  "a client with no host finds a server listening only at another local address instead of spawning a duplicate",
  { timeout: 20_000 },
  async (t) => {
    const otherHost = otherLocalIpv4();
    if (!otherHost) {
      t.skip("host has no non-loopback IPv4 address");
      return;
    }
    await withTempDir(async (dir) => {
      const artifact = await writeArtifact(dir);
      const port = await freePort(otherHost);
      // A pinned server from before loopback was always bound: it listens on the tailnet/LAN address only.
      const pinned = await serve({
        port,
        stateFile: path.join(dir, "state.json"),
        version: VERSION,
        env: {},
        detectTailscale: null,
        hosts: [otherHost],
        log: () => {},
        idleTimeoutMs: null,
      });
      try {
        await withEnv(sweepEnv(dir, port, undefined), () => runCli(["open", artifact, "--no-open"]));
        assert.equal(await reachable("127.0.0.1", port), false, "a duplicate server started on loopback");
        assert.equal(await isResolved(pinned.done), false);
        assert.deepEqual(await stateSessions(dir), [artifact]);
      } finally {
        await pinned.close();
        await shutdownAt("127.0.0.1", port);
      }
    });
  },
);

test(
  "switching LAVISH_AXI_HOST from loopback to another address replaces the server once and keeps its sessions",
  { timeout: 30_000 },
  async (t) => {
    const otherHost = otherLocalIpv4();
    if (!otherHost) {
      t.skip("host has no non-loopback IPv4 address");
      return;
    }
    await withTempDir(async (dir) => {
      const first = await writeArtifact(dir, "first.html");
      const second = await writeArtifact(dir, "second.html");
      const port = await freePort(otherHost);
      const loopbackOnly = await serve({
        port,
        stateFile: path.join(dir, "state.json"),
        version: VERSION,
        env: { LAVISH_AXI_HOST: "127.0.0.1" },
        log: () => {},
        idleTimeoutMs: null,
      });
      try {
        await openSession("127.0.0.1", port, first);
        await withEnv(cliEnv(dir, port, otherHost), () => runCli(["open", second, "--no-open"]));
        assert.equal(await isResolved(loopbackOnly.done), true, "the loopback-only server was not replaced");
        const replacement = await health(otherHost, port);
        assert.equal(replacement.ok, true);
        assert.deepEqual([...replacement.hosts].sort(), ["127.0.0.1", otherHost].sort());
        assert.deepEqual((await health("127.0.0.1", port)).hosts, replacement.hosts);
        assert.deepEqual((await stateSessions(dir)).sort(), [first, second].sort());

        // Switching back does not replace it again: a server that already serves loopback is
        // adopted, so agents configured differently share one daemon instead of trading it.
        await withEnv(cliEnv(dir, port, "127.0.0.1"), () => runCli(["open", first, "--no-open"]));
        await withEnv(cliEnv(dir, port, undefined), () => runCli(["open", second, "--no-open"]));
        const after = await health(otherHost, port);
        assert.deepEqual(after.hosts, replacement.hosts);
        assert.equal(after.state_id, replacement.state_id);
      } finally {
        await loopbackOnly.close().catch(() => {});
        await shutdownAt("127.0.0.1", port);
        await shutdownAt(otherHost, port);
      }
    });
  },
);

test(
  "switching LAVISH_AXI_HOST from another address to loopback adopts the running server",
  { timeout: 20_000 },
  async (t) => {
    const otherHost = otherLocalIpv4();
    if (!otherHost) {
      t.skip("host has no non-loopback IPv4 address");
      return;
    }
    await withTempDir(async (dir) => {
      const first = await writeArtifact(dir, "first.html");
      const second = await writeArtifact(dir, "second.html");
      const port = await freePort(otherHost);
      const pinned = await serve({
        port,
        stateFile: path.join(dir, "state.json"),
        version: VERSION,
        env: { LAVISH_AXI_HOST: otherHost },
        log: () => {},
        idleTimeoutMs: null,
      });
      try {
        assert.deepEqual(pinned.hosts, ["127.0.0.1", otherHost]);
        await openSession(otherHost, port, first);
        await withEnv(cliEnv(dir, port, "127.0.0.1"), () => runCli(["open", second, "--no-open"]));
        await withEnv(cliEnv(dir, port, undefined), () => runCli(["open", first, "--no-open"]));
        await withEnv(cliEnv(dir, port, otherHost), () => runCli(["open", second, "--no-open"]));
        assert.equal(await isResolved(pinned.done), false, "the pinned server was replaced");
        assert.deepEqual((await stateSessions(dir)).sort(), [first, second].sort());
      } finally {
        await pinned.close();
      }
    });
  },
);

test(
  "a same-port duplicate of this installation is retired, and another installation's server is left alone",
  { timeout: 20_000 },
  async (t) => {
    const otherHost = otherLocalIpv4();
    if (!otherHost) {
      t.skip("host has no non-loopback IPv4 address");
      return;
    }
    await withTempDir(async (dir) => {
      const artifact = await writeArtifact(dir);
      const port = await freePort(otherHost);
      const kept = await serve({
        port,
        stateFile: path.join(dir, "state.json"),
        version: VERSION,
        env: {},
        detectTailscale: null,
        hosts: ["127.0.0.1"],
        log: () => {},
        idleTimeoutMs: null,
      });
      const otherInstallDir = await mkdtemp(path.join(tmpdir(), "lavish-discovery-other-"));
      const otherInstall = await serve({
        port,
        stateFile: path.join(otherInstallDir, "state.json"),
        version: VERSION,
        env: {},
        detectTailscale: null,
        hosts: [otherHost],
        log: () => {},
        idleTimeoutMs: null,
      });
      try {
        await withEnv(sweepEnv(dir, port, undefined), () => runCli(["open", artifact, "--no-open"]));
        assert.equal(await isResolved(otherInstall.done), false, "another installation's server was stopped");
        assert.equal(await isResolved(kept.done), false);
      } finally {
        await otherInstall.close();
        await rm(otherInstallDir, { recursive: true, force: true });
      }

      // The same situation with a shared state file is the duplicate daemon pair the old discovery
      // created. Retiring the duplicate must not take its address with it: review links already
      // handed out there keep working, served by one server for both addresses.
      const duplicate = await serve({
        port,
        stateFile: path.join(dir, "state.json"),
        version: VERSION,
        env: {},
        detectTailscale: null,
        hosts: [otherHost],
        log: () => {},
        idleTimeoutMs: null,
      });
      try {
        const { key } = await openSession(otherHost, port, artifact);
        await withEnv(sweepEnv(dir, port, undefined), () => runCli(["open", artifact, "--no-open"]));
        assert.ok(await waitFor(() => isResolved(duplicate.done)), "the duplicate daemon was not retired");
        const survivor = await health(otherHost, port);
        assert.ok(survivor.hosts.includes("127.0.0.1") && survivor.hosts.includes(otherHost), survivor.hosts.join());
        assert.deepEqual((await health("127.0.0.1", port)).hosts, survivor.hosts);
        assert.equal(await getStatus(`http://${otherHost}:${port}/session/${key}`), 200);
        assert.deepEqual(await stateSessions(dir), [artifact]);
      } finally {
        await duplicate.close().catch(() => {});
        await kept.close().catch(() => {});
        await shutdownAt("127.0.0.1", port);
        await shutdownAt(otherHost, port);
      }
    });
  },
);

test("another installation's server on loopback is never used or stopped", { timeout: 20_000 }, async () => {
  await withTempDir(async (dir) => {
    const artifact = await writeArtifact(dir);
    const otherInstallDir = await mkdtemp(path.join(tmpdir(), "lavish-discovery-other-"));
    const port = await freePort();
    const otherInstall = await serve({
      port,
      stateFile: path.join(otherInstallDir, "state.json"),
      version: VERSION,
      env: {},
      detectTailscale: null,
      hosts: ["127.0.0.1"],
      log: () => {},
      idleTimeoutMs: null,
    });
    try {
      const output = await withEnv(cliEnv(dir, port, undefined), () => captureCli(["open", artifact, "--no-open"]));
      assert.match(output, /SERVER_ERROR/);
      // TOON escapes backslashes in quoted Windows paths.
      assert.ok(
        output.includes(otherInstallDir.replaceAll("\\", "\\\\")),
        `expected the other state directory in ${output}`,
      );
      await withEnv(cliEnv(dir, port, undefined), () => assert.rejects(stopCommand([]), { code: "SERVER_ERROR" }));
      assert.equal(await isResolved(otherInstall.done), false, "another installation's server was stopped");
      assert.deepEqual(await stateSessions(otherInstallDir), []);
    } finally {
      await otherInstall.close();
      await rm(otherInstallDir, { recursive: true, force: true });
    }
  });
});

test(
  "a server too old to name its installation is left alone when it is only reached at another address",
  { timeout: 20_000 },
  async (t) => {
    const otherHost = otherLocalIpv4();
    if (!otherHost) {
      t.skip("host has no non-loopback IPv4 address");
      return;
    }
    await withTempDir(async (dir) => {
      const artifact = await writeArtifact(dir);
      const port = await freePort(otherHost);
      let shutdowns = 0;
      // 0.1.77 and older report no state_id, so one found only by the interface sweep may be
      // another installation's.
      const old = createHttpServer((req, res) => {
        if (req.url?.startsWith("/health")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, app: "lavish-axi", version: "0.1.77" }));
          return;
        }
        if (req.method === "POST" && req.url === "/shutdown") shutdowns += 1;
        res.writeHead(404).end();
      });
      await new Promise((resolve) => old.listen({ host: otherHost, port }, () => resolve(undefined)));
      try {
        await withEnv(sweepEnv(dir, port, undefined), () => runCli(["open", artifact, "--no-open"]));
        assert.equal(shutdowns, 0, "the old server at another address was asked to shut down");
        const started = await health("127.0.0.1", port);
        assert.equal(started.version, VERSION);
        assert.deepEqual(await stateSessions(dir), [artifact]);
      } finally {
        await new Promise((resolve) => old.close(() => resolve(undefined)));
        await shutdownAt("127.0.0.1", port);
      }
    });
  },
);

test(
  "a loopback-only server that wins the port during a host replacement is replaced once more",
  { timeout: 30_000 },
  async (t) => {
    const otherHost = otherLocalIpv4();
    if (!otherHost) {
      t.skip("host has no non-loopback IPv4 address");
      return;
    }
    await withTempDir(async (dir) => {
      const artifact = await writeArtifact(dir);
      const port = await freePort(otherHost);
      const loopbackOnly = () =>
        serve({
          port,
          stateFile: path.join(dir, "state.json"),
          version: VERSION,
          env: {},
          detectTailscale: null,
          hosts: ["127.0.0.1"],
          log: () => {},
          idleTimeoutMs: null,
        });
      const first = await loopbackOnly();
      // Another CLI with no host starts a loopback-only server the moment the first one exits,
      // before the replacement this CLI spawns can bind.
      const racer = first.done.then(() => loopbackOnly());
      try {
        await withEnv(cliEnv(dir, port, otherHost), () => runCli(["open", artifact, "--no-open"]));
        const winner = await racer;
        assert.equal(await isResolved(winner.done), true, "the racing loopback-only server was adopted");
        const served = await health(otherHost, port);
        assert.deepEqual([...served.hosts].sort(), ["127.0.0.1", otherHost].sort());
        assert.deepEqual(await stateSessions(dir), [artifact]);
      } finally {
        await first.close().catch(() => {});
        await (await racer.catch(() => null))?.close().catch(() => {});
        await shutdownAt("127.0.0.1", port);
        await shutdownAt(otherHost, port);
      }
    });
  },
);

test(
  "a server that still lacks this CLI's address after the one retry fails the open instead of adopting it",
  { timeout: 30_000 },
  async (t) => {
    const otherHost = otherLocalIpv4();
    if (!otherHost) {
      t.skip("host has no non-loopback IPv4 address");
      return;
    }
    await withTempDir(async (dir) => {
      const artifact = await writeArtifact(dir);
      const port = await freePort(otherHost);
      // A loopback-only server of this installation that another CLI restarts every time this one
      // shuts it down: after each /shutdown it answers like a Lavish server still starting (503),
      // which frees the port for this CLI's probes but makes the server it spawns stand down.
      let shutdowns = 0;
      let startingUntil = 0;
      const loopbackOnly = createHttpServer((req, res) => {
        if (req.url?.startsWith("/health")) {
          const starting = Date.now() < startingUntil;
          res.writeHead(starting ? 503 : 200, { "content-type": "application/json" });
          res.end(
            JSON.stringify(
              starting
                ? { ok: false, app: "lavish-axi", version: VERSION }
                : {
                    ok: true,
                    app: "lavish-axi",
                    version: VERSION,
                    state_id: stateId(path.join(dir, "state.json")),
                    hosts: ["127.0.0.1"],
                    requested_hosts: ["127.0.0.1"],
                  },
            ),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/shutdown") {
          shutdowns += 1;
          startingUntil = Date.now() + 1200;
        }
        res.writeHead(404).end();
      });
      await new Promise((resolve) => loopbackOnly.listen({ host: "127.0.0.1", port }, () => resolve(undefined)));
      try {
        const output = await withEnv(cliEnv(dir, port, otherHost), () => captureCli(["open", artifact, "--no-open"]));
        assert.equal(shutdowns, 2, "expected the initial replacement plus exactly one retry");
        assert.match(output, /SERVER_ERROR/);
        assert.ok(output.includes(otherHost), `expected the missing address in ${output}`);
        assert.match(output, /lavish-axi stop/);
      } finally {
        await new Promise((resolve) => loopbackOnly.close(() => resolve(undefined)));
        await shutdownAt(otherHost, port);
      }
    });
  },
);

test(
  "an upgrade retires every older daemon on the port, including one that only holds another address",
  { timeout: 30_000 },
  async (t) => {
    const otherHost = otherLocalIpv4();
    if (!otherHost) {
      t.skip("host has no non-loopback IPv4 address");
      return;
    }
    await withTempDir(async (dir) => {
      const artifact = await writeArtifact(dir);
      const port = await freePort(otherHost);
      // The pair the old discovery left behind: one daemon on loopback, one pinned to the tailnet
      // address, both on one port and one state file, both from an older release.
      const oldLoopback = await serve({
        port,
        stateFile: path.join(dir, "state.json"),
        version: "0.0.1",
        env: {},
        detectTailscale: null,
        hosts: ["127.0.0.1"],
        log: () => {},
        idleTimeoutMs: null,
      });
      const oldPinned = await serve({
        port,
        stateFile: path.join(dir, "state.json"),
        version: "0.0.1",
        env: {},
        detectTailscale: null,
        hosts: [otherHost],
        log: () => {},
        idleTimeoutMs: null,
      });
      try {
        await withEnv(sweepEnv(dir, port, otherHost), () => runCli(["open", artifact, "--no-open"]));
        assert.equal(await isResolved(oldLoopback.done), true, "the old loopback daemon survived the upgrade");
        assert.equal(await isResolved(oldPinned.done), true, "the old pinned daemon survived the upgrade");
        const upgraded = await health(otherHost, port);
        assert.equal(upgraded.version, VERSION);
        assert.deepEqual((await health("127.0.0.1", port)).hosts, upgraded.hosts);
        assert.deepEqual(await stateSessions(dir), [artifact]);
      } finally {
        await oldLoopback.close().catch(() => {});
        await oldPinned.close().catch(() => {});
        await shutdownAt("127.0.0.1", port);
        await shutdownAt(otherHost, port);
      }
    });
  },
);

test(
  "an upgrade started by one agent keeps every address two agents asked the server to serve",
  { timeout: 30_000 },
  async (t) => {
    const otherHost = otherLocalIpv4();
    if (!otherHost || !(await ipv6LoopbackAvailable())) {
      t.skip("host needs a non-loopback IPv4 address and IPv6 loopback");
      return;
    }
    await withTempDir(async (dir) => {
      const first = await writeArtifact(dir, "first.html");
      const second = await writeArtifact(dir, "second.html");
      const port = await freePort(otherHost);
      // An older release serving two agents: one pinned to otherHost, one to ::1.
      const old = await serve({
        port,
        stateFile: path.join(dir, "state.json"),
        version: "0.0.1",
        env: { LAVISH_AXI_HOST: otherHost },
        extraListenHosts: ["::1"],
        log: () => {},
        idleTimeoutMs: null,
      });
      try {
        const { key } = await openSession(otherHost, port, first);
        await withEnv(cliEnv(dir, port, otherHost), () => runCli(["open", second, "--no-open"]));
        assert.equal(await isResolved(old.done), true, "the old server was not replaced");
        const upgraded = await health(otherHost, port);
        assert.equal(upgraded.version, VERSION);
        assert.deepEqual([...upgraded.hosts].sort(), ["127.0.0.1", "::1", otherHost].sort());
        for (const origin of [`http://${otherHost}:${port}`, `http://[::1]:${port}`]) {
          assert.equal(await getStatus(`${origin}/session/${key}`), 200, `review link at ${origin} stopped working`);
        }
        assert.deepEqual((await stateSessions(dir)).sort(), [first, second].sort());

        // The other agent finds its address already served and keeps the same daemon.
        await withEnv(cliEnv(dir, port, "::1"), () => runCli(["open", first, "--no-open"]));
        const after = await health(otherHost, port);
        assert.equal(after.version, VERSION);
        assert.deepEqual([...after.hosts].sort(), [...upgraded.hosts].sort());
      } finally {
        await old.close().catch(() => {});
        await shutdownAt("127.0.0.1", port);
      }
    });
  },
);

test(
  "the second agent's upgrade accumulates its address beside the first agent's instead of replacing it",
  { timeout: 30_000 },
  async (t) => {
    const otherHost = otherLocalIpv4();
    if (!otherHost || !(await ipv6LoopbackAvailable())) {
      t.skip("host needs a non-loopback IPv4 address and IPv6 loopback");
      return;
    }
    await withTempDir(async (dir) => {
      const first = await writeArtifact(dir, "first.html");
      const second = await writeArtifact(dir, "second.html");
      const port = await freePort(otherHost);
      // An older release started by the agent pinned to otherHost only.
      const old = await serve({
        port,
        stateFile: path.join(dir, "state.json"),
        version: "0.0.1",
        env: { LAVISH_AXI_HOST: otherHost },
        log: () => {},
        idleTimeoutMs: null,
      });
      try {
        const { key } = await openSession(otherHost, port, first);
        await withEnv(cliEnv(dir, port, "::1"), () => runCli(["open", second, "--no-open"]));
        assert.equal(await isResolved(old.done), true, "the old server was not replaced");
        const upgraded = await health("[::1]", port);
        assert.equal(upgraded.version, VERSION);
        assert.deepEqual([...upgraded.hosts].sort(), ["127.0.0.1", "::1", otherHost].sort());
        for (const origin of [`http://${otherHost}:${port}`, `http://[::1]:${port}`]) {
          assert.equal(await getStatus(`${origin}/session/${key}`), 200, `review link at ${origin} stopped working`);
        }

        await withEnv(cliEnv(dir, port, otherHost), () => runCli(["open", first, "--no-open"]));
        assert.deepEqual([...(await health(otherHost, port)).hosts].sort(), [...upgraded.hosts].sort());
        assert.deepEqual((await stateSessions(dir)).sort(), [first, second].sort());
      } finally {
        await old.close().catch(() => {});
        await shutdownAt("127.0.0.1", port);
      }
    });
  },
);

test(
  "an explicit host that does not resolve is served, retried, and reported instead of silently dropped",
  { timeout: 30_000 },
  async () => {
    await withTempDir(async (dir) => {
      const artifact = await writeArtifact(dir);
      const unresolvable = "lavish-unresolvable.invalid";
      const port = await freePort();
      const loopbackOnly = await serve({
        port,
        stateFile: path.join(dir, "state.json"),
        version: VERSION,
        env: {},
        detectTailscale: null,
        hosts: ["127.0.0.1"],
        log: () => {},
        idleTimeoutMs: null,
      });
      try {
        const output = await withEnv(cliEnv(dir, port, unresolvable), () =>
          captureCli(["open", artifact, "--no-open"]),
        );
        assert.equal(await isResolved(loopbackOnly.done), true, "a server that never asked for the host was adopted");
        assert.match(output, /network_warning/);
        assert.ok(output.includes(unresolvable), `expected the unresolved host in ${output}`);
        const replacement = await health("127.0.0.1", port, "?reconcile_network=1");
        assert.ok(replacement.requested_hosts.includes(unresolvable));
        assert.ok(replacement.network_warning.includes(unresolvable));
        const log = await readFile(path.join(dir, "server.log"), "utf8");
        assert.ok(log.includes(`WARNING: Could not bind ${unresolvable}`), log);
        assert.deepEqual(await stateSessions(dir), [artifact]);
      } finally {
        await loopbackOnly.close().catch(() => {});
        await shutdownAt("127.0.0.1", port);
      }
    });
  },
);

test("a replacement inherits every address still on this machine and drops one that is gone", async (t) => {
  if (!(await ipv6LoopbackAvailable())) {
    t.skip("host needs IPv6 loopback");
    return;
  }
  await withTempDir(async (dir) => {
    const port = await freePort();
    const server = await serve({
      port,
      stateFile: path.join(dir, "state.json"),
      version: VERSION,
      env: {},
      hosts: ["127.0.0.1", UNBINDABLE_HOST, "::1"],
      log: () => {},
      idleTimeoutMs: null,
    });
    try {
      const running = await health("127.0.0.1", port);
      assert.ok(running.requested_hosts.includes(UNBINDABLE_HOST));
      assert.deepEqual(inheritedListenHosts([running], []), ["::1"]);
    } finally {
      await server.close();
    }
  });
});

test(
  "a network-stale replacement by an agent with its own host keeps a Tailscale address that is still live",
  { timeout: 30_000 },
  async (t) => {
    const otherHost = otherLocalIpv4();
    if (!otherHost || !(await ipv6LoopbackAvailable())) {
      t.skip("host needs a non-loopback IPv4 address and IPv6 loopback");
      return;
    }
    await withTempDir(async (dir) => {
      const artifact = await writeArtifact(dir);
      const port = await freePort(otherHost);
      // Tailscale stays up on the same address; only the MagicDNS name changes, which makes the
      // running server network-stale.
      let tailscale = { ipv4: otherHost, magicDnsName: "before.example.ts.net" };
      const stale = await serve({
        port,
        stateFile: path.join(dir, "state.json"),
        version: VERSION,
        env: {},
        detectTailscale: async () => tailscale,
        log: () => {},
        idleTimeoutMs: null,
      });
      try {
        const { key } = await openSession(otherHost, port, artifact);
        tailscale = { ipv4: otherHost, magicDnsName: "after.example.ts.net" };
        // The agent pins ::1, so the replacement it starts does not detect Tailscale itself.
        await withEnv(cliEnv(dir, port, "::1"), () => runCli(["open", artifact, "--no-open"]));
        assert.equal(await isResolved(stale.done), true, "the network-stale server was not replaced");
        const replacement = await health("127.0.0.1", port);
        assert.ok(replacement.hosts.includes(otherHost), `lost the live tailnet address: ${replacement.hosts}`);
        assert.equal(await getStatus(`http://${otherHost}:${port}/session/${key}`), 200);
      } finally {
        await stale.close().catch(() => {});
        await shutdownAt("127.0.0.1", port);
      }
    });
  },
);

test(
  "a configured name whose DNS recovers is served at its address and is not replaced",
  { timeout: 30_000 },
  async (t) => {
    const otherHost = otherLocalIpv4();
    if (!otherHost) {
      t.skip("host has no non-loopback IPv4 address");
      return;
    }
    await withTempDir(async (dir) => {
      const artifact = await writeArtifact(dir);
      const port = await freePort(otherHost);
      const name = "lavish-recovering.test";
      let dnsUp = false;
      const server = await serve({
        port,
        stateFile: path.join(dir, "state.json"),
        version: VERSION,
        env: { LAVISH_AXI_HOST: name },
        lookupHost: async (host) => {
          if (host !== name) return [{ address: host, family: host.includes(":") ? 6 : 4 }];
          if (!dnsUp) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
          return [{ address: otherHost, family: 4 }];
        },
        log: () => {},
        idleTimeoutMs: null,
      });
      try {
        assert.equal(await reachable(otherHost, port), false);
        dnsUp = true;
        const recovered = await health("127.0.0.1", port, "?reconcile_network=1");
        assert.ok(recovered.requested_hosts.includes(name));
        assert.ok(recovered.requested_hosts.includes(otherHost));
        assert.equal(recovered.network_warning, undefined);
        assert.equal(await reachable(otherHost, port), true);

        // An agent pinned to the address that name resolves to finds it served.
        await withEnv(cliEnv(dir, port, otherHost), () => runCli(["open", artifact, "--no-open"]));
        assert.equal(await isResolved(server.done), false, "a server serving the address was replaced");
      } finally {
        await server.close().catch(() => {});
        await shutdownAt("127.0.0.1", port);
        await shutdownAt(otherHost, port);
      }
    });
  },
);

function lsofAvailable() {
  return spawnSync("lsof", ["-v"]).error === undefined;
}

// A child process listening at host:port. The script's file name is what `ps` shows, so a
// pre-handshake Lavish server is one whose name says lavish-axi and an unrelated one is not.
async function spawnListener(dir, name, host, port, source) {
  const script = path.join(dir, name);
  await writeFile(script, source);
  const child = spawn(process.execPath, [script, host, String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  const [line] = await once(child.stdout, "data");
  assert.equal(String(line).trim(), "listening");
  return child;
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

test("stopping a pre-handshake server signals only the process at its own address", { timeout: 30_000 }, async (t) => {
  const otherHost = otherLocalIpv4();
  if (!otherHost || !lsofAvailable()) {
    t.skip("host needs a non-loopback IPv4 address and lsof");
    return;
  }
  await withTempDir(async (dir) => {
    const port = await freePort(otherHost);
    // Answers /health with no app or version and has no /shutdown, like the oldest releases.
    const preHandshake = await spawnListener(
      dir,
      "lavish-axi-pre-handshake.mjs",
      "127.0.0.1",
      port,
      `import { createServer } from "node:http";
const [host, port] = process.argv.slice(2);
createServer((req, res) => {
  if (req.url.startsWith("/health")) res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  else res.writeHead(404).end();
}).listen({ host, port: Number(port) }, () => console.log("listening"));
`,
    );
    const unrelated = await spawnListener(
      dir,
      "unrelated-service.mjs",
      otherHost,
      port,
      `import { createServer } from "node:net";
const [host, port] = process.argv.slice(2);
createServer((socket) => socket.destroy()).listen({ host, port: Number(port) }, () => console.log("listening"));
`,
    );
    try {
      const output = await withEnv(cliEnv(dir, port, undefined), () => stopCommand([]));
      assert.equal(output.server.status, "stopped");
      assert.ok(await waitFor(() => exited(preHandshake)), "the pre-handshake server was not stopped");
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(exited(unrelated), false, "a process at another address on the same port was signalled");
    } finally {
      preHandshake.kill();
      unrelated.kill();
    }
  });
});

test("discovery dials no other local address unless the interface sweep is enabled", { timeout: 20_000 }, async (t) => {
  const otherHost = otherLocalIpv4();
  if (!otherHost) {
    t.skip("host has no non-loopback IPv4 address");
    return;
  }
  await withTempDir(async (dir) => {
    const port = await freePort(otherHost);
    let connections = 0;
    const recorder = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise((resolve, reject) => {
      recorder.once("error", reject);
      recorder.listen({ host: otherHost, port }, () => resolve(undefined));
    });
    try {
      await withEnv(cliEnv(dir, port, undefined), () => runCli(["stop"]));
      assert.equal(connections, 0, "default discovery dialed a non-loopback interface address");

      await withEnv({ ...cliEnv(dir, port, undefined), LAVISH_AXI_DISCOVER_ALL_INTERFACES: "1" }, () =>
        runCli(["stop"]),
      );
      assert.ok(connections > 0, "the opt-in sweep did not dial the other local address");
    } finally {
      await closeRaw(recorder);
    }
  });
});

test("discovery does not keep the CLI alive after a local address drops connections", { timeout: 30_000 }, async () => {
  await withTempDir(async (dir) => {
    // A Tailscale IPv6 address drops connections to itself, so a probe of it never connects. The
    // same shape here: a TEST-NET address that routes nowhere, injected as a local interface.
    const preload = path.join(dir, "blackhole-interface.mjs");
    await writeFile(
      preload,
      `import os from "node:os";
const networkInterfaces = os.networkInterfaces;
os.networkInterfaces = () => ({ ...networkInterfaces(), blackhole: [{ address: "${UNBINDABLE_HOST}", family: "IPv4", internal: false }] });
`,
    );
    const port = await freePort();
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)), "stop", "--port", String(port)],
      {
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
          LAVISH_AXI_STATE_DIR: dir,
          LAVISH_AXI_TELEMETRY: "0",
          LAVISH_AXI_HOST: "127.0.0.1",
          LAVISH_AXI_DISCOVER_ALL_INTERFACES: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    const [code] = await once(child, "exit");
    const elapsedMs = Date.now() - started;
    assert.equal(code, 0);
    assert.match(stdout, /not-running/);
    // Before the fix the aborted probe's TCP connect kept the process alive until the OS gave up.
    assert.ok(elapsedMs < 5000, `the CLI took ${elapsedMs}ms to exit`);
  });
});
