import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import WebSocket from "ws";

import { inheritedListenHosts, run, VERSION } from "../src/cli.js";
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
  const state = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
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
        await withEnv(cliEnv(dir, port, undefined), () => runCli(["open", artifact, "--no-open"]));
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
        await withEnv(cliEnv(dir, port, undefined), () => runCli(["open", artifact, "--no-open"]));
        assert.equal(await isResolved(otherInstall.done), false, "another installation's server was stopped");
        assert.equal(await isResolved(kept.done), false);
      } finally {
        await otherInstall.close();
        await rm(otherInstallDir, { recursive: true, force: true });
      }

      // The same situation with a shared state file is the duplicate daemon pair the old discovery
      // created: the one the CLI does not adopt is shut down over its own /shutdown.
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
        await withEnv(cliEnv(dir, port, undefined), () => runCli(["open", artifact, "--no-open"]));
        assert.ok(await waitFor(() => isResolved(duplicate.done)), "the duplicate daemon was not retired");
        assert.equal(await isResolved(kept.done), false, "the adopted server was stopped");
      } finally {
        await duplicate.close().catch(() => {});
        await kept.close();
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
        await withEnv(cliEnv(dir, port, otherHost), () => runCli(["open", artifact, "--no-open"]));
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
      } finally {
        await old.close().catch(() => {});
        await shutdownAt("127.0.0.1", port);
      }
    });
  },
);

test("a replacement for a changed network keeps explicit addresses but not the gone Tailscale one", async (t) => {
  const otherHost = otherLocalIpv4();
  if (!otherHost || !(await ipv6LoopbackAvailable())) {
    t.skip("host needs a non-loopback IPv4 address and IPv6 loopback");
    return;
  }
  await withTempDir(async (dir) => {
    const port = await freePort(otherHost);
    let tailscale = { ipv4: otherHost, magicDnsName: "box.example.ts.net" };
    const server = await serve({
      port,
      stateFile: path.join(dir, "state.json"),
      version: VERSION,
      env: {},
      detectTailscale: async () => tailscale,
      extraListenHosts: ["::1"],
      log: () => {},
      idleTimeoutMs: null,
    });
    try {
      assert.deepEqual(inheritedListenHosts([await health("127.0.0.1", port)], []), [otherHost, "::1"]);
      tailscale = null;
      const stale = await health("127.0.0.1", port, "?reconcile_network=1");
      assert.equal(stale.network_stale, true);
      assert.deepEqual(inheritedListenHosts([stale], []), ["::1"]);
    } finally {
      await server.close();
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
