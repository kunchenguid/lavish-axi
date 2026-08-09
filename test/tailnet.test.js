import assert from "node:assert/strict";
import test from "node:test";

import {
  buildServeArgs,
  buildServeOffArgs,
  DEFAULT_TAILNET_HTTPS_PORT,
  normalizeDnsName,
  parseSelfDnsName,
  readTailnetState,
  resolveTailnetHttpsPort,
  tailnetAllowedHosts,
  tailnetUrlFor,
} from "../src/tailnet.js";

test("normalizeDnsName strips the FQDN trailing dot and trims", () => {
  assert.equal(normalizeDnsName("devcube.tail1234.ts.net."), "devcube.tail1234.ts.net");
  assert.equal(normalizeDnsName("  devcube.tail1234.ts.net  "), "devcube.tail1234.ts.net");
  assert.equal(normalizeDnsName("devcube.tail1234.ts.net"), "devcube.tail1234.ts.net");
  assert.equal(normalizeDnsName(""), "");
  assert.equal(normalizeDnsName(undefined), "");
});

test("parseSelfDnsName reads Self.DNSName from tailscale status JSON and fails closed", () => {
  assert.equal(
    parseSelfDnsName(JSON.stringify({ Self: { DNSName: "devcube.tail1234.ts.net." } })),
    "devcube.tail1234.ts.net",
  );
  assert.equal(parseSelfDnsName(JSON.stringify({ Self: {} })), "");
  assert.equal(parseSelfDnsName(JSON.stringify({})), "");
  assert.equal(parseSelfDnsName("not json"), "");
  assert.equal(parseSelfDnsName(JSON.stringify({ Self: { DNSName: 42 } })), "");
});

test("resolveTailnetHttpsPort defaults to 8443 and rejects junk", () => {
  assert.equal(resolveTailnetHttpsPort({}), DEFAULT_TAILNET_HTTPS_PORT);
  assert.equal(resolveTailnetHttpsPort({ LAVISH_AXI_TAILNET_HTTPS_PORT: "10000" }), 10_000);
  assert.equal(resolveTailnetHttpsPort({ LAVISH_AXI_TAILNET_HTTPS_PORT: "0" }), DEFAULT_TAILNET_HTTPS_PORT);
  assert.equal(resolveTailnetHttpsPort({ LAVISH_AXI_TAILNET_HTTPS_PORT: "-1" }), DEFAULT_TAILNET_HTTPS_PORT);
  assert.equal(resolveTailnetHttpsPort({ LAVISH_AXI_TAILNET_HTTPS_PORT: "70000" }), DEFAULT_TAILNET_HTTPS_PORT);
  assert.equal(resolveTailnetHttpsPort({ LAVISH_AXI_TAILNET_HTTPS_PORT: "eight" }), DEFAULT_TAILNET_HTTPS_PORT);
});

test("serve args are port-scoped so operator config on other ports is never touched", () => {
  assert.deepEqual(buildServeArgs({ httpsPort: 8443, port: 4387 }), [
    "serve",
    "--bg",
    "--https=8443",
    "http://127.0.0.1:4387",
  ]);
  assert.deepEqual(buildServeOffArgs({ httpsPort: 8443 }), ["serve", "--bg", "--https=8443", "off"]);
});

test("readTailnetState parses persisted state and fails closed on junk", () => {
  const read = (text) => readTailnetState({ readFile: () => text, file: "/tmp/tailnet.json" });
  assert.deepEqual(read(JSON.stringify({ hostname: "devcube.tail1234.ts.net.", httpsPort: 8443 })), {
    hostname: "devcube.tail1234.ts.net",
    httpsPort: 8443,
  });
  assert.deepEqual(read(JSON.stringify({ hostname: "devcube.tail1234.ts.net" })), {
    hostname: "devcube.tail1234.ts.net",
    httpsPort: DEFAULT_TAILNET_HTTPS_PORT,
  });
  assert.equal(read(JSON.stringify({ hostname: "" })), null);
  assert.equal(read(JSON.stringify({})), null);
  assert.equal(read("not json"), null);
  assert.equal(
    read(JSON.stringify({ hostname: "h.ts.net", httpsPort: 70_000 }))?.httpsPort,
    DEFAULT_TAILNET_HTTPS_PORT,
  );
  assert.equal(
    readTailnetState({
      readFile: () => {
        throw new Error("ENOENT");
      },
      file: "/tmp/absent.json",
    }),
    null,
  );
});

test("tailnetAllowedHosts contributes the hostname only while enabled", () => {
  assert.deepEqual(tailnetAllowedHosts({ hostname: "devcube.tail1234.ts.net", httpsPort: 8443 }), [
    "devcube.tail1234.ts.net",
  ]);
  assert.deepEqual(tailnetAllowedHosts(null), []);
});

test("tailnetUrlFor moves scheme and authority, preserving path, query, and hash", () => {
  const state = { hostname: "devcube.tail1234.ts.net", httpsPort: 8443 };
  assert.equal(
    tailnetUrlFor(state, "http://127.0.0.1:4387/session/96890a47d20aef18"),
    "https://devcube.tail1234.ts.net:8443/session/96890a47d20aef18",
  );
  assert.equal(
    tailnetUrlFor(state, "http://127.0.0.1:4387/session/abc?no-gate=1"),
    "https://devcube.tail1234.ts.net:8443/session/abc?no-gate=1",
  );
  assert.equal(
    tailnetUrlFor({ hostname: "devcube.tail1234.ts.net", httpsPort: 443 }, "http://127.0.0.1:4387/session/abc"),
    "https://devcube.tail1234.ts.net/session/abc",
  );
  assert.equal(tailnetUrlFor(state, "not a url"), "");
});
