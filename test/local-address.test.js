import assert from "node:assert/strict";
import test from "node:test";

import { isLocalAddressPresent } from "../src/local-address.js";

test("loopback is present on this host", () => {
  assert.equal(isLocalAddressPresent("127.0.0.1"), true);
});

test("TEST-NET-1 is not a local address", () => {
  assert.equal(isLocalAddressPresent("192.0.2.1"), false);
});
