import { normalizePromptId } from "./chat-messages.js";

// Unsent review drafts: the notes a reviewer has queued but not sent, plus the open annotation
// card's text. They used to live only in the tab's sessionStorage, so closing the tab (or an
// in-app browser that discards it) lost them and reopening the link showed an empty queue. The
// chrome now mirrors them here as it changes, one record per tab, and a tab that boots adopts
// the records other tabs left behind.
//
// These are pure functions over the stored `session.drafts` map so the rules are unit-testable
// without a server; `SessionStore.saveDrafts` only persists what they return.

// Each record is keyed by a tab id the chrome keeps in its own sessionStorage, so a reload of the
// same tab overwrites its record instead of adding one. Bounded so a crafted writer cannot grow
// state.json without limit: state.json is rewritten wholesale on every store write.
export const MAX_DRAFT_TABS = 8;
export const MAX_DRAFT_PROMPTS = 100;
// Serialized size of one tab's record. The chrome's queue is the user's own typing plus anchor
// metadata, so this is far above any real queue and well below the route's body limit.
export const MAX_DRAFT_RECORD_BYTES = 256 * 1024;

export class DraftTooLargeError extends Error {
  constructor() {
    super("draft too large");
    this.code = "DRAFT_TOO_LARGE";
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// A tab id has the same compact shape as a prompt identity, for the same reason: it is a map key
// in a file that is rewritten wholesale.
export function normalizeDraftTabId(value) {
  return normalizePromptId(value);
}

// Every write carries a per-tab sequence number that only grows. A page being hidden flushes a
// keepalive write while an earlier one may still be in flight, and the two can land in either
// order; the stored sequence is what lets the older one be refused instead of winning.
export function normalizeDraftSeq(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

// Only entries with a prompt identity are kept. The identity is what lets a draft that was
// already sent be recognized and dropped (by the transcript's acks), so an identity-less entry
// could be resurrected after delivery and sent twice.
function normalizeDraftQueue(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const queue = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const id = normalizePromptId(item.prompt_id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    queue.push(item);
    if (queue.length >= MAX_DRAFT_PROMPTS) break;
  }
  return queue;
}

// Only a review state that carries something the user wrote is worth keeping: an open card with
// text, or question-field values. Anything else retires the stored state.
function normalizeReviewState(value) {
  if (!isPlainObject(value)) return null;
  const card = isPlainObject(value.card) ? value.card : null;
  const hasCardText = Boolean(card && String(card.text || "").trim());
  const fields = Array.isArray(value.fields) ? value.fields : [];
  if (!hasCardText && !fields.length) return null;
  return value;
}

function acknowledgedIdSet(session) {
  const ids = new Set();
  for (const entry of Array.isArray(session?.chat) ? session.chat : []) {
    const id = normalizePromptId(entry?.prompt_id);
    if (id) ids.add(id);
  }
  for (const value of Array.isArray(session?.chat_ack_ids) ? session.chat_ack_ids : []) {
    const id = normalizePromptId(value);
    if (id) ids.add(id);
  }
  return ids;
}

function storedDrafts(session) {
  return isPlainObject(session?.drafts) ? session.drafts : {};
}

function recordIsEmpty(record) {
  return !record || ((!Array.isArray(record.queue) || !record.queue.length) && !record.review_state);
}

/**
 * Apply one tab's draft write to a session in place. Returns whether `session.drafts` changed.
 *
 * - A write whose `seq` is not above the one stored for its tab is older than what the server
 *   already has, and changes nothing.
 * - The writer's record is replaced wholesale (the chrome always sends its whole queue), minus
 *   any prompt the transcript already acknowledges.
 * - `adopted` names, as `{ tab, review_state }`, other tabs' records the writer took over at
 *   boot. Their queue always goes, so the notes have exactly one stored owner afterwards; the
 *   record itself goes only when the writer took its card text too (`review_state: true`) or it
 *   had none. A record kept for card text the writer could not take keeps no queue.
 * - An empty record is kept, with nothing in it, so its sequence still refuses an older write
 *   that would bring back what the tab removed. It is never served and is evicted first.
 * - At most MAX_DRAFT_TABS records are kept; the least recently written go first.
 *
 * Throws DraftTooLargeError when the writer's record is over MAX_DRAFT_RECORD_BYTES. Nothing is
 * changed in that case.
 *
 * @param {any} session
 * @param {{ tab?: unknown, seq?: unknown, queue?: unknown, review_state?: unknown, adopted?: unknown }} payload
 * @param {{ now?: string }} [options]
 */
export function applyDraftWrite(session, payload, { now = new Date().toISOString() } = {}) {
  const tab = normalizeDraftTabId(payload?.tab);
  if (!tab) throw new TypeError("a draft write needs a tab id");
  const seq = normalizeDraftSeq(payload?.seq);
  if (!seq) throw new TypeError("a draft write needs a sequence number");
  const acknowledged = acknowledgedIdSet(session);
  const queue = normalizeDraftQueue(payload?.queue).filter(
    (prompt) => !acknowledged.has(normalizePromptId(prompt.prompt_id)),
  );
  const reviewState = normalizeReviewState(payload?.review_state);
  const record = { queue, review_state: reviewState, seq, updated_at: now };
  if (Buffer.byteLength(JSON.stringify(record)) > MAX_DRAFT_RECORD_BYTES) throw new DraftTooLargeError();

  /** @type {Record<string, any>} */
  const drafts = { ...storedDrafts(session) };
  if (normalizeDraftSeq(drafts[tab]?.seq) >= seq) return false;
  const adopted = Array.isArray(payload?.adopted) ? payload.adopted.slice(0, MAX_DRAFT_TABS * 4) : [];
  for (const value of adopted) {
    const id = normalizeDraftTabId(value?.tab);
    const other = id && id !== tab ? drafts[id] : null;
    if (!other) continue;
    if (value.review_state === true || !other.review_state) delete drafts[id];
    else drafts[id] = { ...other, queue: [] };
  }
  drafts[tab] = record;
  const ordered = Object.entries(drafts).sort(
    ([, a], [, b]) =>
      Number(recordIsEmpty(a)) - Number(recordIsEmpty(b)) ||
      String(b?.updated_at || "").localeCompare(String(a?.updated_at || "")),
  );
  session.drafts = Object.fromEntries(ordered.slice(0, MAX_DRAFT_TABS));
  return true;
}

/**
 * Drop the given prompt identities from every stored draft record, in place. Called when a batch
 * is accepted, so a note that was sent never comes back as a draft even if the tab that queued it
 * closed before it could write its now-empty queue. Returns whether anything changed.
 *
 * @param {any} session
 * @param {Iterable<string>} promptIds
 */
export function pruneSentDrafts(session, promptIds) {
  const ids = new Set();
  for (const value of promptIds) {
    const id = normalizePromptId(value);
    if (id) ids.add(id);
  }
  if (!ids.size || !isPlainObject(session?.drafts)) return false;
  let changed = false;
  for (const [tab, record] of Object.entries(session.drafts)) {
    if (!isPlainObject(record) || !Array.isArray(record.queue)) continue;
    const queue = record.queue.filter((prompt) => !ids.has(normalizePromptId(prompt?.prompt_id)));
    if (queue.length === record.queue.length) continue;
    changed = true;
    session.drafts[tab] = { ...record, queue };
  }
  return changed;
}

/**
 * The draft records a booting chrome may adopt, most recently written first, with every prompt
 * the transcript already acknowledges removed.
 *
 * @param {any} session
 * @returns {{ tab: string, queue: any[], review_state: any, updated_at: string }[]}
 */
export function serializeDrafts(session) {
  const acknowledged = acknowledgedIdSet(session);
  const records = [];
  for (const [tab, record] of Object.entries(storedDrafts(session))) {
    if (!normalizeDraftTabId(tab) || !isPlainObject(record)) continue;
    const queue = normalizeDraftQueue(record.queue).filter(
      (prompt) => !acknowledged.has(normalizePromptId(prompt.prompt_id)),
    );
    const reviewState = normalizeReviewState(record.review_state);
    if (!queue.length && !reviewState) continue;
    records.push({ tab, queue, review_state: reviewState, updated_at: String(record.updated_at || "") });
  }
  return records.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
