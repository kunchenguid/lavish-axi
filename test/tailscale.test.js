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
    execFile: /** @type {any} */ (async (command) => {
      attempted.push(command);
      if (command === "tailscale") return { stdout: JSON.stringify({ BackendState: "Stopped" }) };
      return {
        stdout: JSON.stringify({
          BackendState: "Running",
          Self: { TailscaleIPs: ["100.64.12.34"], DNSName: "review.tailnet.ts.net." },
        }),
      };
    }),
  });
  assert.deepEqual(attempted, ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]);
  assert.deepEqual(result, { ipv4: "100.64.12.34", magicDnsName: "review.tailnet.ts.net" });
});

test("parseTailscaleStatus ignores malformed or non-running status", () => {
  assert.equal(parseTailscaleStatus("not json"), null);
  assert.equal(
    parseTailscaleStatus(JSON.stringify({ BackendState: "Running", Self: { TailscaleIPs: ["999.1.1.1"] } })),
    null,
  );
});
