import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDraftWrite,
  countDraftNotes,
  DraftTooLargeError,
  MAX_DRAFT_PROMPTS,
  MAX_DRAFT_TABS,
  pruneSentDrafts,
  serializeDrafts,
} from "../src/review-drafts.js";

function note(id, text = `note ${id}`) {
  return { prompt: text, selector: "main > p", tag: "p", prompt_id: id };
}

test("a tab's write is stored and served back to the next tab", () => {
  const session = { chat: [] };
  const changed = applyDraftWrite(session, { tab: "tabA", queue: [note("p1")] }, { now: "2026-11-09T10:00:00.000Z" });
  assert.equal(changed, true);
  assert.deepEqual(serializeDrafts(session), [
    { tab: "tabA", queue: [note("p1")], review_state: null, updated_at: "2026-11-09T10:00:00.000Z" },
  ]);
  assert.equal(countDraftNotes(session), 1);
});

test("rewriting the same queue does not change stored drafts", () => {
  const session = {};
  applyDraftWrite(session, { tab: "tabA", queue: [note("p1")] }, { now: "2026-11-09T10:00:00.000Z" });
  const before = JSON.stringify(session);
  assert.equal(
    applyDraftWrite(session, { tab: "tabA", queue: [note("p1")] }, { now: "2026-11-09T10:05:00.000Z" }),
    false,
  );
  assert.equal(JSON.stringify(session), before);
});

test("an emptied queue removes the tab's record", () => {
  const session = {};
  applyDraftWrite(session, { tab: "tabA", queue: [note("p1")] });
  assert.equal(applyDraftWrite(session, { tab: "tabA", queue: [] }), true);
  assert.equal("drafts" in session, false);
  assert.deepEqual(serializeDrafts(session), []);
});

test("an open card with text is a draft on its own; an empty card is not", () => {
  const session = {};
  const reviewState = { card: { selector: "h1", text: "Tighten this" }, fields: [] };
  applyDraftWrite(session, { tab: "tabA", queue: [], review_state: reviewState });
  assert.deepEqual(serializeDrafts(session)[0].review_state, reviewState);
  applyDraftWrite(session, { tab: "tabA", queue: [], review_state: { card: { selector: "h1", text: "  " } } });
  assert.deepEqual(serializeDrafts(session), []);
});

test("adopting removes the other tabs' records in the same write", () => {
  const session = {};
  applyDraftWrite(session, { tab: "tabA", queue: [note("p1")] }, { now: "2026-11-09T10:00:00.000Z" });
  applyDraftWrite(
    session,
    { tab: "tabB", queue: [note("p1")], adopted: ["tabA"] },
    { now: "2026-11-09T10:01:00.000Z" },
  );
  assert.deepEqual(
    serializeDrafts(session).map((record) => record.tab),
    ["tabB"],
  );
  assert.equal(countDraftNotes(session), 1);
});

test("acknowledged prompts are never stored or served as drafts", () => {
  const session = { chat: [{ role: "user", text: "sent", prompt_id: "p1" }], chat_ack_ids: ["p2"] };
  applyDraftWrite(session, { tab: "tabA", queue: [note("p1"), note("p2"), note("p3")] });
  assert.deepEqual(
    serializeDrafts(session)[0].queue.map((prompt) => prompt.prompt_id),
    ["p3"],
  );
  // A record written before the send was acknowledged is filtered on the way out too.
  session.chat.push({ role: "user", text: "sent", prompt_id: "p3" });
  assert.deepEqual(serializeDrafts(session), []);
});

test("entries without a prompt identity, duplicates, and non-objects are dropped", () => {
  const session = {};
  applyDraftWrite(session, {
    tab: "tabA",
    queue: [note("p1"), note("p1", "dup"), { prompt: "no id" }, "junk", null, note("bad id!")],
  });
  assert.deepEqual(serializeDrafts(session)[0].queue, [note("p1")]);
});

test("a write needs a well-formed tab id", () => {
  assert.throws(() => applyDraftWrite({}, { tab: "../etc", queue: [] }), TypeError);
  assert.throws(() => applyDraftWrite({}, { queue: [] }), TypeError);
});

test("records and queues are bounded", () => {
  const session = {};
  for (let i = 0; i < MAX_DRAFT_TABS + 3; i += 1) {
    const minute = String(i).padStart(2, "0");
    applyDraftWrite(session, { tab: `tab${i}`, queue: [note(`p${i}`)] }, { now: `2026-11-09T10:${minute}:00.000Z` });
  }
  const tabs = serializeDrafts(session).map((record) => record.tab);
  assert.equal(tabs.length, MAX_DRAFT_TABS);
  assert.equal(tabs[0], `tab${MAX_DRAFT_TABS + 2}`, "most recent first");
  assert.equal(tabs.includes("tab0"), false, "the least recently written record is evicted");

  const many = Array.from({ length: MAX_DRAFT_PROMPTS + 20 }, (_, i) => note(`q${i}`));
  applyDraftWrite(session, { tab: "tabBig", queue: many });
  assert.equal(serializeDrafts(session).find((record) => record.tab === "tabBig")?.queue.length, MAX_DRAFT_PROMPTS);
});

test("an oversized record is refused and changes nothing", () => {
  const session = {};
  applyDraftWrite(session, { tab: "tabA", queue: [note("p1")] });
  const before = JSON.stringify(session);
  assert.throws(
    () => applyDraftWrite(session, { tab: "tabA", queue: [note("p2", "x".repeat(300 * 1024))] }),
    DraftTooLargeError,
  );
  assert.equal(JSON.stringify(session), before);
});

test("pruneSentDrafts drops sent notes from every tab's record", () => {
  const session = {};
  applyDraftWrite(session, { tab: "tabA", queue: [note("p1"), note("p2")] });
  applyDraftWrite(session, { tab: "tabB", queue: [note("p1")] });
  assert.equal(pruneSentDrafts(session, ["p1"]), true);
  assert.deepEqual(
    serializeDrafts(session).map((record) => [record.tab, record.queue.map((prompt) => prompt.prompt_id)]),
    [["tabA", ["p2"]]],
  );
  assert.equal(pruneSentDrafts(session, ["p9"]), false);
  assert.equal(pruneSentDrafts(session, ["p2"]), true);
  assert.equal("drafts" in session, false);
});
