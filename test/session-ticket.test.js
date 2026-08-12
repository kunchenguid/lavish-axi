import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSessionTicket } from "../src/session-ticket.js";

test("ticket normalization accepts a bounded Jira issue and canonicalizes case", () => {
  assert.equal(normalizeSessionTicket(" wf-92564 "), "WF-92564");
  assert.equal(normalizeSessionTicket("SM-17468"), "SM-17468");
});

test("ticket normalization rejects markup and unbounded values", () => {
  assert.equal(normalizeSessionTicket("<script>alert(1)</script>"), null);
  assert.equal(normalizeSessionTicket("WF-"), null);
  assert.equal(normalizeSessionTicket(`WF-${"9".repeat(20)}`), null);
});
