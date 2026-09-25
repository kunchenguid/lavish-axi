import assert from "node:assert/strict";
import test from "node:test";

import { discoveryHosts, localInterfaceAddresses } from "../src/local-address.js";

test("loopback is among this host's interface addresses", () => {
  assert.ok(localInterfaceAddresses().includes("127.0.0.1"));
});

test("interface sweep keeps dialable addresses and drops link-local and wildcard entries", () => {
  const addresses = localInterfaceAddresses({
    lo0: [
      { address: "127.0.0.1", family: "IPv4", internal: true },
      { address: "::1", family: "IPv6", internal: true },
      { address: "fe80::1", family: "IPv6", internal: true },
    ],
    utun4: [
      { address: "100.64.0.9", family: "IPv4", internal: false },
      { address: "fd7a:115c:a1e0::9", family: 6, internal: false },
    ],
    en0: [
      { address: "192.168.1.20", family: 4, internal: false },
      { address: "0.0.0.0", family: "IPv4", internal: false },
      { address: "100.64.0.9", family: "IPv4", internal: false },
    ],
  });
  assert.deepEqual(addresses, ["127.0.0.1", "::1", "100.64.0.9", "fd7a:115c:a1e0::9", "192.168.1.20"]);
});

const SWEEP_INTERFACES = {
  lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  utun4: [{ address: "2606:4700:110:8000::9", family: "IPv6", internal: false }],
  en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
};

test("discovery dials only the configured host and loopback by default", () => {
  for (const env of [{}, { LAVISH_AXI_DISCOVER_ALL_INTERFACES: "0" }, { LAVISH_AXI_DISCOVER_ALL_INTERFACES: "" }]) {
    assert.deepEqual(discoveryHosts(["100.64.0.9", "127.0.0.1"], { env, interfaces: SWEEP_INTERFACES }), [
      "100.64.0.9",
      "127.0.0.1",
    ]);
  }
});

test("discovery collapses a configured host that is loopback", () => {
  assert.deepEqual(discoveryHosts(["127.0.0.1", "127.0.0.1"], { env: {}, interfaces: SWEEP_INTERFACES }), [
    "127.0.0.1",
  ]);
});

test("the opt-in interface sweep appends every other local address after the control hosts", () => {
  const env = { LAVISH_AXI_DISCOVER_ALL_INTERFACES: "1" };
  assert.deepEqual(discoveryHosts(["100.64.0.9", "127.0.0.1"], { env, interfaces: SWEEP_INTERFACES }), [
    "100.64.0.9",
    "127.0.0.1",
    "2606:4700:110:8000::9",
    "192.168.1.20",
  ]);
});
