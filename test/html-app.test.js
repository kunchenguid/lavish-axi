import assert from "node:assert/strict";
import test from "node:test";

import { publishToHtmlApp, SHARE_DISABLED_MESSAGE } from "../src/html-app.js";

test("hosted publishing refuses before invoking the transport", async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    throw new Error("transport must stay unreachable");
  };

  await assert.rejects(
    () => publishToHtmlApp("<h1>Private</h1>", { fetch: fetchImpl, apiUrl: "http://127.0.0.1:9" }),
    (error) => error instanceof Error && error.message === SHARE_DISABLED_MESSAGE,
  );
  assert.equal(fetchCalls, 0);
});
