import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDraftWrite,
  DraftTooLargeError,
  MAX_DRAFT_PROMPTS,
  MAX_DRAFT_TABS,
  pruneSentDrafts,
  serializeDrafts,
} from "../src/review-drafts.js";

let nextSeq = 0;
function write(session, payload, options) {
  nextSeq += 1;
  return applyDraftWrite(session, { seq: nextSeq, ...payload }, options);
}

function note(id, text = `note ${id}`) {
  return { prompt: text, selector: "main > p", tag: "p", prompt_id: id };
}

test("a tab's write is stored and served back to the next tab", () => {
  const session = { chat: [] };
  const changed = write(session, { tab: "tabA", queue: [note("p1")] }, { now: "2026-11-09T10:00:00.000Z" });
  assert.equal(changed, true);
  assert.deepEqual(serializeDrafts(session), [
    { tab: "tabA", queue: [note("p1")], review_state: null, updated_at: "2026-11-09T10:00:00.000Z" },
  ]);
});

test("a write older than the tab's stored one is refused, so a late save never undoes a flush", () => {
  const session = {};
  const cardText = { card: { selector: "h1", text: "Half a thought" }, fields: [] };
  // S1 (queue only) is still in flight when the page is hidden and S2 (queue plus card text) is
  // flushed; S2 lands first.
  applyDraftWrite(session, { tab: "tabA", seq: 2, queue: [note("p1")], review_state: cardText });
  assert.equal(applyDraftWrite(session, { tab: "tabA", seq: 1, queue: [note("p1")] }), false);
  assert.deepEqual(serializeDrafts(session)[0].review_state, cardText);
  assert.equal(applyDraftWrite(session, { tab: "tabA", seq: 2, queue: [] }), false, "a replay is not newer");
});

test("an emptied queue is no longer served, and an older write cannot bring it back", () => {
  const session = {};
  applyDraftWrite(session, { tab: "tabA", seq: 1, queue: [note("p1")] });
  assert.equal(applyDraftWrite(session, { tab: "tabA", seq: 3, queue: [] }), true);
  assert.deepEqual(serializeDrafts(session), []);
  assert.equal(applyDraftWrite(session, { tab: "tabA", seq: 2, queue: [note("p1")] }), false);
  assert.deepEqual(serializeDrafts(session), []);
});

test("an open card with text is a draft on its own; an empty card is not", () => {
  const session = {};
  const reviewState = { card: { selector: "h1", text: "Tighten this" }, fields: [] };
  write(session, { tab: "tabA", queue: [], review_state: reviewState });
  assert.deepEqual(serializeDrafts(session)[0].review_state, reviewState);
  write(session, { tab: "tabA", queue: [], review_state: { card: { selector: "h1", text: "  " } } });
  assert.deepEqual(serializeDrafts(session), []);
});

test("adopting removes the other tabs' records in the same write", () => {
  const session = {};
  write(session, { tab: "tabA", queue: [note("p1")] }, { now: "2026-11-09T10:00:00.000Z" });
  write(
    session,
    { tab: "tabB", queue: [note("p1")], adopted: [{ tab: "tabA", review_state: true }] },
    { now: "2026-11-09T10:01:00.000Z" },
  );
  assert.deepEqual(
    serializeDrafts(session).map((record) => record.tab),
    ["tabB"],
  );
});

test("acknowledged prompts are never stored or served as drafts", () => {
  const session = { chat: [{ role: "user", text: "sent", prompt_id: "p1" }], chat_ack_ids: ["p2"] };
  write(session, { tab: "tabA", queue: [note("p1"), note("p2"), note("p3")] });
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
  write(session, {
    tab: "tabA",
    queue: [note("p1"), note("p1", "dup"), { prompt: "no id" }, "junk", null, note("bad id!")],
  });
  assert.deepEqual(serializeDrafts(session)[0].queue, [note("p1")]);
});

test("a write needs a well-formed tab id", () => {
  assert.throws(() => applyDraftWrite({}, { tab: "../etc", seq: 1, queue: [] }), TypeError);
  assert.throws(() => applyDraftWrite({}, { seq: 1, queue: [] }), TypeError);
  assert.throws(() => applyDraftWrite({}, { tab: "tabA", queue: [] }), TypeError);
  assert.throws(() => applyDraftWrite({}, { tab: "tabA", seq: 0, queue: [] }), TypeError);
});

test("records and queues are bounded", () => {
  const session = {};
  for (let i = 0; i < MAX_DRAFT_TABS + 3; i += 1) {
    const minute = String(i).padStart(2, "0");
    write(session, { tab: `tab${i}`, queue: [note(`p${i}`)] }, { now: `2026-11-09T10:${minute}:00.000Z` });
  }
  const tabs = serializeDrafts(session).map((record) => record.tab);
  assert.equal(tabs.length, MAX_DRAFT_TABS);
  assert.equal(tabs[0], `tab${MAX_DRAFT_TABS + 2}`, "most recent first");
  assert.equal(tabs.includes("tab0"), false, "the least recently written record is evicted");

  const many = Array.from({ length: MAX_DRAFT_PROMPTS + 20 }, (_, i) => note(`q${i}`));
  write(session, { tab: "tabBig", queue: many });
  assert.equal(serializeDrafts(session).find((record) => record.tab === "tabBig")?.queue.length, MAX_DRAFT_PROMPTS);
});

test("an oversized record is refused and changes nothing", () => {
  const session = {};
  write(session, { tab: "tabA", queue: [note("p1")] });
  const before = JSON.stringify(session);
  assert.throws(() => write(session, { tab: "tabA", queue: [note("p2", "x".repeat(300 * 1024))] }), DraftTooLargeError);
  assert.equal(JSON.stringify(session), before);
});

test("pruneSentDrafts drops sent notes from every tab's record", () => {
  const session = {};
  write(session, { tab: "tabA", queue: [note("p1"), note("p2")] });
  write(session, { tab: "tabB", queue: [note("p1")] });
  assert.equal(pruneSentDrafts(session, ["p1"]), true);
  assert.deepEqual(
    serializeDrafts(session).map((record) => [record.tab, record.queue.map((prompt) => prompt.prompt_id)]),
    [["tabA", ["p2"]]],
  );
  assert.equal(pruneSentDrafts(session, ["p9"]), false);
  assert.equal(pruneSentDrafts(session, ["p2"]), true);
  assert.deepEqual(serializeDrafts(session), []);
});

test("an adopting write that could not take the card text keeps it but retires the queue", () => {
  const session = {};
  const card = { card: { selector: "h1", text: "Half a thought" }, fields: [] };
  write(
    session,
    { tab: "tabA", queue: [note("n1"), note("n2")], review_state: card },
    { now: "2026-11-09T10:00:00.000Z" },
  );
  write(session, { tab: "tabB", queue: [note("n1")], review_state: null }, { now: "2026-11-09T10:00:30.000Z" });
  // Tab C takes both queues; it has a card of its own, so it cannot take tab A's.
  write(
    session,
    {
      tab: "tabC",
      queue: [note("n1")],
      adopted: [
        { tab: "tabA", review_state: false },
        { tab: "tabB", review_state: false },
      ],
    },
    { now: "2026-11-09T10:01:00.000Z" },
  );
  assert.deepEqual(
    serializeDrafts(session).map((record) => [
      record.tab,
      record.queue.map((prompt) => prompt.prompt_id),
      record.review_state,
    ]),
    [
      ["tabC", ["n1"], null],
      ["tabA", [], card],
    ],
    "n2, removed in tab C, does not come back; tab B had no card text, so its record is gone",
  );
  write(session, { tab: "tabD", queue: [], adopted: [{ tab: "tabA", review_state: true }] });
  assert.deepEqual(
    serializeDrafts(session).map((record) => record.tab),
    ["tabC"],
  );
});
