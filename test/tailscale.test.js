import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { detectTailscale, parseTailscaleStatus } from "../src/tailscale.js";

test("Tailscale detection skips unresolved candidates and probes executable files", async (t) => {
  const dir = await mkdtemp(path.join(process.cwd(), ".tailscale-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = path.join(dir, process.platform === "win32" ? "tailscale.exe" : "tailscale");
  const nonExecutable = path.join(dir, "not-executable");
  const directory = path.join(dir, "directory");
  await writeFile(executable, "test fixture, never executed", { mode: 0o700 });
  await writeFile(nonExecutable, "not executable", { mode: 0o600 });
  await mkdir(directory);
  await chmod(executable, 0o700);
  const attempted = [];
  const execFile = /** @type {any} */ (
    async (command, args) => {
      attempted.push(command);
      assert.deepEqual(args, ["status", "--json"]);
      return {
        stdout: JSON.stringify({
          BackendState: "Running",
          Self: { TailscaleIPs: ["100.64.12.34"], DNSName: "review.tailnet.ts.net." },
        }),
      };
    }
  );
  const missing = path.join(dir, "missing");
  for (const command of [missing, directory, ...(process.platform === "win32" ? [] : [nonExecutable])]) {
    assert.equal(await detectTailscale({ commands: [command], execFile }), null);
  }
  assert.equal(await detectTailscale({ commands: ["tailscale"], env: { PATH: directory }, execFile }), null);
  assert.deepEqual(attempted, []);
  for (const command of [executable, "tailscale"]) {
    assert.deepEqual(await detectTailscale({ commands: [command], env: { PATH: dir }, execFile }), {
      ipv4: "100.64.12.34",
      magicDnsName: "review.tailnet.ts.net",
    });
  }
  assert.deepEqual(attempted, [executable, executable]);
});

test("parseTailscaleStatus returns the running node IPv4 and MagicDNS name", () => {
  const result = parseTailscaleStatus(
    JSON.stringify({
      BackendState: "Running",
      Self: {
        TailscaleIPs: ["fd7a:115c:a1e0::1", "100.64.12.34"],
        DNSName: "review-phone.tailnet.ts.net.",
      },
    }),
  );
  assert.deepEqual(result, { ipv4: "100.64.12.34", magicDnsName: "review-phone.tailnet.ts.net" });
});

test("Tailscale detection fails closed when the command is unavailable or not running", async () => {
  const missing = await detectTailscale({
    resolveCommand: async (command) => command,
    // The injected command is intentionally only a test double; it need not expose
    // child-process methods from promisify(execFile).
    execFile: /** @type {any} */ (
      async () => {
        throw new Error("not installed");
      }
    ),
  });
  assert.equal(missing, null);

  const stopped = await detectTailscale({
    resolveCommand: async (command) => command,
    execFile: /** @type {any} */ (async () => ({ stdout: JSON.stringify({ BackendState: "Stopped" }) })),
  });
  assert.equal(stopped, null);
});

test("Tailscale detection falls back to the macOS application bundle", async () => {
  const attempted = [];
  const result = await detectTailscale({
    commands: ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"],
    resolveCommand: async (command) => command,
    execFile: /** @type {any} */ (
      async (command) => {
        attempted.push(command);
        if (command === "tailscale") {
          return {
            stdout: JSON.stringify({ BackendState: "Running", Self: { TailscaleIPs: ["100.64.12.34"] } }),
          };
        }
        return {
          stdout: JSON.stringify({
            BackendState: "Running",
            Self: { TailscaleIPs: ["100.64.12.34"], DNSName: "review.tailnet.ts.net." },
          }),
        };
      }
    ),
  });
  assert.deepEqual(attempted, ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]);
  assert.deepEqual(result, { ipv4: "100.64.12.34", magicDnsName: "review.tailnet.ts.net" });
});

test("Tailscale detection reports missing MagicDNS when no complete candidate exists", async () => {
  const result = await detectTailscale({
    commands: ["tailscale"],
    resolveCommand: async (command) => command,
    execFile: /** @type {any} */ (
      async () => ({
        stdout: JSON.stringify({ BackendState: "Running", Self: { TailscaleIPs: ["100.64.12.34"] } }),
      })
    ),
  });
  assert.deepEqual(result, {
    ipv4: null,
    magicDnsName: null,
    warning:
      "Tailscale is running but MagicDNS is unavailable; there is no phone access. Lavish remains available on loopback.",
  });
});

test("Tailscale detection shares one timeout budget across candidates", async () => {
  let now = 0;
  const attempts = [];
  const result = await detectTailscale({
    timeoutMs: 50,
    commands: ["one", "two", "three"],
    resolveCommand: async (command) => command,
    now: () => now,
    execFile: /** @type {any} */ (
      async (command, _args, options) => {
        attempts.push({ command, timeout: options.timeout });
        now += 30;
        throw new Error("unavailable");
      }
    ),
  });
  assert.equal(result, null);
  assert.deepEqual(attempts, [
    { command: "one", timeout: 50 },
    { command: "two", timeout: 20 },
  ]);
});

test("Tailscale detection deducts command resolution time from the probe timeout", async () => {
  let now = 1000;
  const attempts = [];
  const result = await detectTailscale({
    timeoutMs: 50,
    commands: ["tailscale"],
    now: () => now,
    resolveCommand: async (command) => {
      now += 30;
      return command;
    },
    execFile: /** @type {any} */ (
      async (command, _args, options) => {
        attempts.push({ command, timeout: options.timeout });
        return {
          stdout: JSON.stringify({
            BackendState: "Running",
            Self: { TailscaleIPs: ["100.64.12.34"], DNSName: "review.tailnet.ts.net." },
          }),
        };
      }
    ),
  });
  assert.deepEqual(attempts, [{ command: "tailscale", timeout: 20 }]);
  assert.deepEqual(result, { ipv4: "100.64.12.34", magicDnsName: "review.tailnet.ts.net" });
});

test("Tailscale detection skips execution when command resolution exhausts the probe budget", async () => {
  let now = 1000;
  const resolved = [];
  const attempted = [];
  const result = await detectTailscale({
    timeoutMs: 50,
    commands: ["one", "two"],
    now: () => now,
    resolveCommand: async (command) => {
      resolved.push(command);
      now += 50;
      return command;
    },
    execFile: /** @type {any} */ (
      async (command) => {
        attempted.push(command);
        return { stdout: "" };
      }
    ),
  });
  assert.equal(result, null);
  assert.deepEqual(resolved, ["one"]);
  assert.deepEqual(attempted, []);
});

test("parseTailscaleStatus ignores malformed or non-running status", () => {
  assert.equal(parseTailscaleStatus("not json"), null);
  assert.equal(
    parseTailscaleStatus(
      JSON.stringify({ BackendState: "Running", Self: { TailscaleIPs: ["100.64.12.34"], DNSName: "bad host" } }),
    ),
    null,
  );
  assert.equal(
    parseTailscaleStatus(JSON.stringify({ BackendState: "Running", Self: { TailscaleIPs: ["999.1.1.1"] } })),
    null,
  );
});
