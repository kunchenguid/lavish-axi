import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_STARTUP_WAIT_MS, resolveStartupWaitMs } from "../src/cli.js";

test("startup wait defaults to a generous budget when the env var is unset", () => {
  assert.equal(resolveStartupWaitMs({}), DEFAULT_STARTUP_WAIT_MS);
  assert.equal(resolveStartupWaitMs({ LAVISH_AXI_STARTUP_WAIT_MS: "   " }), DEFAULT_STARTUP_WAIT_MS);
  assert.equal(DEFAULT_STARTUP_WAIT_MS, 15000);
});

test("startup wait honors LAVISH_AXI_STARTUP_WAIT_MS", () => {
  assert.equal(resolveStartupWaitMs({ LAVISH_AXI_STARTUP_WAIT_MS: "60000" }), 60000);
  assert.equal(resolveStartupWaitMs({ LAVISH_AXI_STARTUP_WAIT_MS: " 2500 " }), 2500);
});

test("an invalid or non-positive startup wait falls back to the default", () => {
  assert.equal(resolveStartupWaitMs({ LAVISH_AXI_STARTUP_WAIT_MS: "nope" }), DEFAULT_STARTUP_WAIT_MS);
  assert.equal(resolveStartupWaitMs({ LAVISH_AXI_STARTUP_WAIT_MS: "0" }), DEFAULT_STARTUP_WAIT_MS);
  assert.equal(resolveStartupWaitMs({ LAVISH_AXI_STARTUP_WAIT_MS: "-5" }), DEFAULT_STARTUP_WAIT_MS);
});

test("startup wait clamps to setTimeout's maximum", () => {
  assert.equal(resolveStartupWaitMs({ LAVISH_AXI_STARTUP_WAIT_MS: "99999999999" }), 2147483647);
});
