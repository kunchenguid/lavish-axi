import assert from "node:assert/strict";
import test from "node:test";

import { localInterfaceAddresses } from "../src/local-address.js";

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
