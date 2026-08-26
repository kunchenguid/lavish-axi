import assert from "node:assert/strict";
import test from "node:test";

import { detectTailscale, parseTailscaleStatus } from "../src/tailscale.js";

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
    execFile: /** @type {any} */ (async () => ({ stdout: JSON.stringify({ BackendState: "Stopped" }) })),
  });
  assert.equal(stopped, null);
});

test("Tailscale detection falls back to the macOS application bundle", async () => {
  const attempted = [];
  const result = await detectTailscale({
    commands: ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"],
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
