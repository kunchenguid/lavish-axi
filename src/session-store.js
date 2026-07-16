import crypto from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  applyDiagnosticPass,
  dismissLayoutWarning as dismissWarningRecord,
  hasOutstandingRepairRequest,
  isSelectableLayoutWarning,
  layoutWarningPromptPayload,
  markObsoleteViewportWarnings,
  normalizeLayoutWarningsTarget,
  normalizeStoredWarnings,
  queueLayoutWarnings as queueWarningRecords,
  serializeLayoutWarnings,
} from "./layout-warnings.js";
import { AsyncMutex } from "./async-mutex.js";
import { normalizeMermaidNodeTarget } from "./mermaid-node.js";
import { EXCALIDRAW_SCENE_TARGET_TYPE, normalizeExcalidrawSceneTarget } from "./whiteboard-core.js";

export const LAYOUT_WARNINGS_TARGET_TYPE = "layout-warnings";
const MAX_ARTIFACT_FAILURES = 20;
// How long a just-delivered attachment stays referenced after `takeFeedback`
// hands its path to the agent. The sweeper's reference set is built from PENDING
// prompts, which delivery clears - so without this window an attachment that is
// TTL-expired or disk-cap-eligible becomes sweepable at the exact moment the agent
// starts reading it. It is a bounded read window, not a second lifetime: the TTL
// and the disk cap must still be able to reclaim delivered bytes eventually.
export const ATTACHMENT_DELIVERY_GRACE_MS = 60 * 60 * 1000; // 1 hour

// A whole POST /prompts batch is one user's queued annotations, so its total image
// count is small in every real use. Bounding it is what keeps the resolver work
// below O(payload size) while the store's global lock is held. It bounds ONE
// request; prompts accumulate across requests until a poll drains them, so it says
// nothing about how much a single delivery carries.
export const MAX_REQUEST_ATTACHMENT_REFS = 256;

// Bounds only the retained HISTORY of earlier deliveries - state.json is rewritten
// wholesale on every store operation, so the list cannot grow forever.
//
// It deliberately does NOT bound the current delivery. The invariant is structural,
// not numeric: whatever `takeFeedback` just handed the agent is retained in full,
// however large, and this cap only decides how much older history rides along. Any
// number chosen here would be wrong, because pending prompts accumulate across an
// unbounded number of accepted requests - so a single poll can legitimately deliver
// far more than any one request may queue. Trimming the current delivery to fit a
// constant is what reopens the hole this retention exists to close.
export const MAX_DELIVERED_ATTACHMENTS = 256;

export class SessionStore {
  constructor(file) {
    this.file = file;
    // One mutex serializes every state.json read-modify-write and the server's
    // attachment disk lifecycle sections through runExclusive.
    this.lock = new AsyncMutex();
    this.artifactLoads = new Map();
    this.chromeLoadContexts = new Map();
  }

  async listSessions() {
    return this.runExclusive(async () => {
      const state = await this.readState();
      return Object.values(state.sessions).sort((a, b) => a.file.localeCompare(b.file));
    });
  }

  async findByFile(file) {
    const absolute = await canonicalFile(file);
    return this.runExclusive(async () => {
      const state = await this.readState();
      return state.sessions[sessionKey(absolute)] || null;
    });
  }

  async findByKey(key) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      return state.sessions[key] || null;
    });
  }

  async upsertSession(file, url) {
    // `canonicalFile` (a realpath) does not touch state, so resolve it before
    // taking the lock and keep only the read-modify-write inside the critical
    // section.
    const absolute = await canonicalFile(file);
    return this.lock.runExclusive(() => this.#upsertSessionLocked(absolute, url));
  }

  async #upsertSessionLocked(absolute, url) {
    const key = sessionKey(absolute);
    const state = await this.readState();
    const existing = state.sessions[key] || {};
    const existingPrompts = existing.prompts || [];
    const existingStatus = existing.status === "ended" ? "open" : existing.status || "open";
    const session = {
      key,
      file: absolute,
      url,
      status: existingStatus === "feedback" && existingPrompts.length === 0 ? "open" : existingStatus,
      pending_prompts: existing.pending_prompts || 0,
      prompts: existingPrompts,
      // The warning inbox is durable review state, not deliverable feedback: reopening a session
      // must never silently drop unresolved warnings the user has not triaged yet.
      layout_warnings: normalizeStoredWarnings(existing.layout_warnings),
      artifact_revision: normalizeRevision(existing.artifact_revision),
      artifact_failures: Array.isArray(existing.artifact_failures) ? existing.artifact_failures : [],
      // Carried across a reopen on purpose: this list is what keeps a just-delivered
      // attachment out of the sweeper's reach, and re-opening the artifact during the
      // grace window would otherwise erase that protection while the agent is still
      // reading the path. Every field this constructor omits is silently dropped, so
      // any new session field must be added here too.
      delivered_attachments: Array.isArray(existing.delivered_attachments) ? existing.delivered_attachments : [],
      dom_snapshot: existing.dom_snapshot || "",
      chat: existing.chat || [],
      updated_at: new Date().toISOString(),
    };
    state.sessions[key] = session;
    await this.writeState(state);
    return session;
  }

  // `options.resolveAttachment(key, id) => Promise<metadata|null>` is the trust
  // boundary for image attachments: a prompt only ever carries the client's
  // claimed `id` (and display `name`); every authoritative field (absolute path,
  // mime, byte size, dimensions) is re-derived from disk here, so a crafted
  // `/prompts` POST cannot point an attachment at an arbitrary file. Without a
  // resolver, unresolved attachments are dropped rather than trusted.
  async queuePrompts(key, payload, options = {}) {
    // The whole read -> resolve -> write path runs under the store's single lock so
    // it is atomic against a concurrent poll's `takeFeedback` / `recordLayoutWarnings`
    // (E1) AND against the sweeper's reference snapshot + delete and upload finalize,
    // which the server runs under the same lock via `runExclusive` (D5).
    return this.lock.runExclusive(() => this.#queuePromptsLocked(key, payload, options));
  }

  async #queuePromptsLocked(key, payload, options) {
    const state = await this.readState();
    const session = state.sessions[key];
    if (!session) {
      return null;
    }
    const prompts = Array.isArray(payload.prompts) ? payload.prompts : [];
    const shouldEndSession = Boolean(payload.endSession || payload.end_session);
    const alreadyEnded = session.status === "ended";
    const normalized = prompts.map(normalizePrompt);
    const normalizedPrompts = normalized.map((entry) => entry.prompt);
    // Resolve every attachment BEFORE mutating anything. If any prompt's images
    // can't be fully honored - malformed, an unknown id, or over the per-prompt
    // count/byte cap - reject the WHOLE batch and persist nothing (C4). Silently
    // truncating here while returning success would drop images the user attached,
    // and the chrome would clear its queue believing they were delivered.
    const rejected = boundAttachmentRefs(normalized, options);
    if (!rejected.length) {
      for (const prompt of normalizedPrompts) {
        const { resolved, rejected: promptRejected } = await resolvePromptAttachments(prompt.attachments, key, options);
        if (promptRejected.length) rejected.push(...promptRejected);
        if (resolved.length > 0) prompt.attachments = resolved;
        else delete prompt.attachments;
      }
    }
    if (rejected.length) {
      return {
        rejected: rejected.slice(0, MAX_REPORTED_ATTACHMENT_REJECTIONS),
        caps: {
          maxPerPrompt: Number.isFinite(options.maxPerPrompt) ? options.maxPerPrompt : null,
          maxPromptBytes: Number.isFinite(options.maxPromptBytes) ? options.maxPromptBytes : null,
        },
      };
    }

    const revision = normalizeRevision(session.artifact_revision);
    const at = new Date().toISOString();
    let warnings = normalizeStoredWarnings(session.layout_warnings);
    const layoutPlans = [];
    const conflicts = new Set();
    for (const prompt of normalizedPrompts) {
      const warningIds = layoutWarningPromptIds(prompt);
      if (warningIds === null) {
        layoutPlans.push({
          prompt,
          warningIds: null,
          expectedRevision: null,
          conflicts: [],
          queueIds: [],
          hadKnownWarning: false,
        });
        continue;
      }
      const plan = planLayoutWarningPrompt(warnings, prompt, revision);
      for (const id of plan.conflicts) conflicts.add(id);
      layoutPlans.push({ prompt, ...plan });
    }
    if (conflicts.size > 0) {
      return {
        conflict: true,
        session,
        warning_ids: [...conflicts],
        warnings: serializeLayoutWarnings(warnings),
      };
    }
    const acceptedPrompts = [];
    for (const plan of layoutPlans) {
      if (plan.warningIds === null) {
        acceptedPrompts.push(plan.prompt);
        continue;
      }
      const result = queueWarningRecords(warnings, plan.queueIds, { revision, at });
      warnings = result.warnings;
      if (result.queued.length > 0 || !plan.hadKnownWarning) acceptedPrompts.push(plan.prompt);
    }
    session.layout_warnings = warnings;
    const userMessages = acceptedPrompts
      .filter((prompt) => prompt.tag === "message" && prompt.prompt)
      .map((prompt) => ({ role: "user", text: prompt.prompt, at: new Date().toISOString() }));
    session.prompts = [...(session.prompts || []), ...acceptedPrompts];
    session.chat = [...(session.chat || []), ...userMessages];
    session.pending_prompts = session.prompts.length;
    session.dom_snapshot = String(payload.domSnapshot || payload.dom_snapshot || "");
    session.status = shouldEndSession || alreadyEnded ? "ended" : session.prompts.length > 0 ? "feedback" : "open";
    if (shouldEndSession) session.ended_by = "user";
    session.updated_at = new Date().toISOString();
    await this.writeState(state);
    return session;
  }

  async issueReviewerHandoff(key) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const chromeLoadToken = crypto.randomBytes(24).toString("base64url");
      this.chromeLoadContexts.set(key, chromeLoadToken);
      const activeLoad = this.artifactLoads.get(key);
      return {
        session,
        chrome_load_token: chromeLoadToken,
        artifact_revision: activeLoad?.artifactRevision ?? normalizeRevision(session.artifact_revision),
        artifact_load_token: activeLoad?.artifactLoadToken || "",
        artifact_load_sequence: activeLoad?.requestSequence || 0,
      };
    });
  }

  /** @returns {Promise<any>} */
  async beginArtifactLoad(key, { requestId = "", requestSequence = 0, handoffToken = "" } = {}) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const normalizedRequestId = String(requestId || "");
      const parsedRequestSequence = Number(requestSequence);
      const normalizedRequestSequence =
        Number.isSafeInteger(parsedRequestSequence) && parsedRequestSequence > 0 ? parsedRequestSequence : 0;
      const normalizedHandoffToken = String(handoffToken || "");
      const activeHandoffToken = this.chromeLoadContexts.get(key) || "";
      const activeLoad = this.artifactLoads.get(key);
      const staleResult = (status) => ({
        session,
        stale: status,
        artifact_revision: activeLoad?.artifactRevision ?? normalizeRevision(session.artifact_revision),
        artifact_load_token: activeLoad?.artifactLoadToken || "",
      });
      if (!activeHandoffToken || !normalizedHandoffToken) {
        return staleResult("no-handoff");
      }
      if (normalizedHandoffToken !== activeHandoffToken) {
        return staleResult("superseded");
      }
      if (
        normalizedRequestId &&
        activeLoad?.requestId === normalizedRequestId &&
        activeLoad.handoffToken === normalizedHandoffToken
      ) {
        return {
          session,
          artifact_revision: activeLoad.artifactRevision,
          artifact_load_token: activeLoad.artifactLoadToken,
        };
      }
      if (
        normalizedRequestSequence > 0 &&
        activeLoad?.handoffToken === normalizedHandoffToken &&
        activeLoad.requestSequence > normalizedRequestSequence
      ) {
        return staleResult("out-of-order");
      }
      const artifactRevision = normalizeRevision(session.artifact_revision) + 1;
      const artifactLoadToken = crypto.randomBytes(24).toString("base64url");
      this.artifactLoads.set(key, {
        artifactRevision,
        artifactLoadToken,
        lastPassSequence: 0,
        requestId: normalizedRequestId,
        requestSequence: normalizedRequestSequence,
        handoffToken: normalizedHandoffToken,
      });
      session.artifact_revision = artifactRevision;
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return { session, artifact_revision: artifactRevision, artifact_load_token: artifactLoadToken };
    });
  }

  async verifyArtifactLoad(key, artifactLoadToken, artifactRevision) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const load = this.artifactLoads.get(key);
      const revision = parseRevisionValue(artifactRevision);
      const valid = Boolean(
        load &&
        String(artifactLoadToken || "") &&
        String(artifactLoadToken) === load.artifactLoadToken &&
        revision === load.artifactRevision,
      );
      return {
        session,
        valid,
        artifact_revision: load?.artifactRevision ?? normalizeRevision(session.artifact_revision),
        artifact_load_token: load?.artifactLoadToken || "",
      };
    });
  }

  // Fold one browser diagnostic pass into the passive warning inbox. This deliberately does NOT
  // touch session status or queue feedback: detection alone must never wake an agent.
  /**
   * @param {{ viewportClasses?: string[] }} [options]
   */
  async recordLayoutDiagnostics(key, payload, options = {}) {
    return this.runExclusive(async () => {
      const viewportClasses = options.viewportClasses;
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const revision = normalizeRevision(session.artifact_revision);
      const load = this.artifactLoads.get(key);
      const artifactLoadToken = String(payload?.artifact_load_token || payload?.artifactLoadToken || "");
      const reportedRevision = parseDiagnosticRevision(payload);
      const passSequence = parsePassSequence(payload);
      if (
        !load ||
        artifactLoadToken !== load.artifactLoadToken ||
        !reportedRevision.present ||
        reportedRevision.value !== load.artifactRevision ||
        !passSequence.present ||
        passSequence.value <= load.lastPassSequence
      ) {
        return {
          session,
          changed: false,
          stale: true,
          warnings: serializeLayoutWarnings(session.layout_warnings),
        };
      }
      load.lastPassSequence = passSequence.value;
      const at = new Date().toISOString();
      const pass = applyDiagnosticPass(session.layout_warnings, {
        complete: payload.complete !== false,
        targetPresenceComplete: payload.target_presence_complete === true || payload.targetPresenceComplete === true,
        viewportWidth: payload.viewport_width ?? payload.viewportWidth,
        findings: payload.findings || payload.layout_warnings || payload.layoutWarnings || [],
        revision,
        at,
      });
      let warnings = pass.warnings;
      let changed = pass.changed;
      if (viewportClasses) {
        const obsolete = markObsoleteViewportWarnings(warnings, viewportClasses, { at, revision });
        warnings = obsolete.warnings;
        changed = changed || obsolete.changed;
      }
      if (!changed) {
        return { session, changed: false, warnings: serializeLayoutWarnings(warnings) };
      }
      session.layout_warnings = warnings;
      session.updated_at = at;
      await this.writeState(state);
      return { session, changed: true, warnings: serializeLayoutWarnings(warnings) };
    });
  }

  // Prepare the user's explicit triage action. The ordinary prompt queue commits it when sent.
  async prepareLayoutWarningFixes(key, ids) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const revision = normalizeRevision(session.artifact_revision);
      const at = new Date().toISOString();
      const result = queueWarningRecords(session.layout_warnings, ids, { revision, at });
      if (!result.queued.length) {
        return { session, queued: [], prompt: null, warnings: serializeLayoutWarnings(session.layout_warnings) };
      }
      return {
        session,
        queued: result.queued,
        prompt: layoutWarningPromptPayload(result.queued),
        warnings: serializeLayoutWarnings(session.layout_warnings),
      };
    });
  }

  async dismissLayoutWarning(key, id) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const revision = normalizeRevision(session.artifact_revision);
      const result = dismissWarningRecord(session.layout_warnings, id, { revision });
      if (!result.changed) {
        return { session, changed: false, warnings: serializeLayoutWarnings(session.layout_warnings) };
      }
      session.layout_warnings = result.warnings;
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return { session, changed: true, warnings: serializeLayoutWarnings(result.warnings) };
    });
  }

  // The narrow fatal path: failures that make the review itself unusable (the artifact cannot be
  // served, or one of its own local assets cannot be loaded). These are NOT layout findings and
  // do not enter the passive inbox - they still reach the agent immediately, because there is no
  // usable review for the user to triage from.
  async recordArtifactFailures(key, payload) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const load = this.artifactLoads.get(key);
      const artifactLoadToken = String(payload?.artifact_load_token || payload?.artifactLoadToken || "");
      const reportedRevision = parseDiagnosticRevision(payload);
      if (
        !load ||
        artifactLoadToken !== load.artifactLoadToken ||
        !reportedRevision.present ||
        reportedRevision.value !== load.artifactRevision
      ) {
        return { session, changed: false, stale: true };
      }
      const normalized = normalizeArtifactFailures(payload?.failures);
      const previous = Array.isArray(session.artifact_failures) ? session.artifact_failures : [];
      const merged = [...previous];
      let changed = false;
      for (const failure of normalized) {
        if (merged.some((item) => item.kind === failure.kind && item.detail === failure.detail)) continue;
        merged.push(failure);
        changed = true;
      }
      if (!changed) {
        return { session, changed: false };
      }
      session.artifact_failures = merged.slice(-MAX_ARTIFACT_FAILURES);
      if (session.status !== "ended") session.status = "feedback";
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return { session, changed: true };
    });
  }

  async listLayoutWarnings(key) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) return null;
      return {
        warnings: serializeLayoutWarnings(session.layout_warnings),
        revision: normalizeRevision(session.artifact_revision),
      };
    });
  }

  async hasOutstandingLayoutRepairs(key) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) return false;
      return normalizeStoredWarnings(session.layout_warnings).some(hasOutstandingRepairRequest);
    });
  }

  /** @returns {Promise<any>} */
  async takeFeedback(key) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return { status: "missing" };
      }
      // Prompts queued before the session ended (a browser send-and-end) must still reach the
      // agent, so deliver them before reporting the ended state; the next poll then sees ended.
      const prompts = session.prompts || [];
      // Layout warnings stay passive until the user queues them. Only fatal artifact
      // failures can reach the agent without explicit user action.
      const artifactFailures = Array.isArray(session.artifact_failures) ? session.artifact_failures : [];
      const alreadyEnded = session.status === "ended";
      if (prompts.length === 0 && artifactFailures.length === 0) {
        return alreadyEnded ? { status: "ended", ended_by: session.ended_by } : { status: "waiting" };
      }
      const result = {
        status: "feedback",
        dom_snapshot: session.dom_snapshot || "",
        prompts,
        ...(artifactFailures.length > 0 ? { artifact_failures: artifactFailures } : {}),
        ...(alreadyEnded ? { session_ended: true, ended_by: session.ended_by } : {}),
      };
      // Delivery clears pending prompts, so retain the attachment ids for a bounded
      // grace window while the polling agent opens the absolute paths it received.
      const deliveredNow = Date.now();
      const deliveredIds = new Set();
      for (const prompt of prompts) {
        for (const attachment of prompt.attachments || []) {
          if (attachment?.id) deliveredIds.add(attachment.id);
        }
      }
      const carried = (session.delivered_attachments || [])
        .filter(
          (entry) =>
            entry &&
            entry.id &&
            !deliveredIds.has(entry.id) &&
            deliveredNow - Number(entry.at) <= ATTACHMENT_DELIVERY_GRACE_MS,
        )
        .map((entry) => ({ id: entry.id, at: Number(entry.at) }))
        .sort((a, b) => a.at - b.at);
      const current = [...deliveredIds].map((id) => ({ id, at: deliveredNow }));
      const historyRoom = Math.max(0, MAX_DELIVERED_ATTACHMENTS - current.length);
      session.delivered_attachments = [...carried.slice(-historyRoom), ...current];
      session.prompts = [];
      session.artifact_failures = [];
      session.pending_prompts = 0;
      session.dom_snapshot = "";
      if (!alreadyEnded) {
        session.status = "open";
      }
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return result;
    });
  }

  // `endedBy` distinguishes a human ending review from the browser chrome ("user") from an
  // agent explicitly closing the loop via `lavish-axi end` ("agent"). Only a user-initiated end
  // blocks a plain reopen - see `SessionStore` callers in server.js.
  async endSession(key, endedBy = "agent") {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const existingEndedBy = session.status === "ended" ? session.ended_by : undefined;
      const nextEndedBy = endedBy === "user" || existingEndedBy === "user" ? "user" : "agent";
      session.status = "ended";
      session.ended_by = nextEndedBy;
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return session;
    });
  }

  async addAgentReply(key, text) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      session.chat = [
        ...(session.chat || []),
        { role: "agent", text: String(text || ""), at: new Date().toISOString() },
      ];
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return session;
    });
  }

  /**
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  runExclusive(operation) {
    return this.lock.runExclusive(operation);
  }

  // `key/id` strings for every attachment still referenced by a pending prompt,
  // across all sessions. The attachment sweeper and delete use this so they never
  // reap a file that belongs to a queued-but-undelivered prompt. Delivered prompts
  // are cleared from `prompts` by takeFeedback, so their attachments become
  // sweep-eligible. This is a pure read and must NOT take `this.lock`: the server
  // calls it from inside `runExclusive`, so self-locking would deadlock; running it
  // there keeps its snapshot atomic with the subsequent disk delete.
  // Every attachment the sweeper must not touch: those still queued on a pending
  // prompt, plus those handed to the agent within the delivery grace window.
  async referencedAttachmentIds({ now = Date.now() } = {}) {
    const state = await this.readState();
    const referenced = new Set();
    for (const session of Object.values(state.sessions)) {
      for (const prompt of session.prompts || []) {
        for (const attachment of prompt.attachments || []) {
          if (attachment && attachment.id) referenced.add(`${session.key}/${attachment.id}`);
        }
      }
      for (const delivered of session.delivered_attachments || []) {
        if (!delivered || !delivered.id) continue;
        if (now - Number(delivered.at) <= ATTACHMENT_DELIVERY_GRACE_MS) {
          referenced.add(`${session.key}/${delivered.id}`);
        }
      }
    }
    return referenced;
  }

  async readState() {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      return { sessions: parsed.sessions || {} };
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return { sessions: {} };
      }
      throw error;
    }
  }

  async writeState(state) {
    await writeFile(this.file, `${JSON.stringify(state, null, 2)}\n`);
  }
}

export async function canonicalFile(file) {
  const absolute = path.resolve(file);
  return realpath(absolute);
}

export function sessionKey(file) {
  return crypto.createHash("sha256").update(file).digest("hex").slice(0, 16);
}

// Returns `{ prompt, malformed }`: `malformed` is non-empty when the payload's
// `attachments` field exists but cannot be honored as written, which fails the
// whole batch rather than being normalized away (C4, see queuePrompts).
function normalizePrompt(prompt) {
  const normalized = {
    uid: String(prompt.uid || ""),
    prompt: String(prompt.prompt || ""),
    selector: String(prompt.selector || ""),
    tag: String(prompt.tag || ""),
    text: String(prompt.text || ""),
  };
  const target = normalizeTarget(prompt.target);
  if (target) normalized.target = target;
  const { refs, malformed } = normalizeAttachmentRefs(prompt.attachments);
  if (refs.length > 0) normalized.attachments = refs;
  return { prompt: normalized, malformed };
}

function layoutWarningPromptIds(prompt) {
  if (prompt?.tag !== "layout-warnings" || prompt.target?.type !== LAYOUT_WARNINGS_TARGET_TYPE) return null;
  return Array.isArray(prompt.target.warnings)
    ? prompt.target.warnings.map((warning) => String(warning?.id || "")).filter(Boolean)
    : [];
}

// Client-supplied attachment refs are stripped to just the fields the client is
// allowed to influence: the content-hash `id` and a display-only `name`. Path,
// mime, size, and dimensions are never taken from the payload (see queuePrompts).
//
// Anything that cannot be read as a ref is reported as `malformed` rather than
// skipped: dropping it here would let the POST succeed while the images the user
// attached never arrive, and the chrome would clear its queue believing they were
// delivered. An ABSENT field is not malformed - it just means no images.
function normalizeAttachmentRefs(value) {
  if (value === undefined) return { refs: [], malformed: [] };
  if (!Array.isArray(value)) return { refs: [], malformed: [{ id: "", name: "", reason: "malformed" }] };
  const refs = [];
  const malformed = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      malformed.push({ id: "", name: "", reason: "malformed" });
      continue;
    }
    const name = item.name === undefined || item.name === null ? "" : String(item.name).slice(0, 200);
    const id = String(item.id || "");
    if (!id) {
      malformed.push({ id: "", name, reason: "malformed" });
      continue;
    }
    refs.push(name ? { id, name } : { id });
  }
  return { refs, malformed };
}

// Rejections are reported back to the chrome, so the list must not itself become
// a payload amplifier for a crafted batch.
const MAX_REPORTED_ATTACHMENT_REJECTIONS = 4;

// The cheap gate that must run BEFORE `resolvePromptAttachments` touches the
// filesystem: every check here is pure arithmetic over the parsed payload.
//
// The per-prompt cap inside the resolver counts RESOLVED refs, which a crafted
// batch never advances - thousands of well-formed ids for files that don't exist
// each cost a sequential `stat` and the count stays at zero. Because the whole
// path runs under the store's single mutex (E1/D5), that stalls polling and every
// state mutation. Counting the RAW refs first bounds the work a caller can buy.
function boundAttachmentRefs(normalized, options) {
  const maxPerPrompt = Number.isFinite(options.maxPerPrompt) ? options.maxPerPrompt : Infinity;
  const malformed = normalized.flatMap((entry) => entry.malformed);
  if (malformed.length) return malformed;

  // Per-prompt first: it is the more specific diagnosis, and the chrome turns it
  // into actionable wording ("more than N images on one annotation"). A single
  // crafted prompt trips both caps, and that message is the useful one.
  const rejected = [];
  for (const { prompt } of normalized) {
    const refs = prompt.attachments || [];
    // One rejection per over-cap prompt, not one per crafted ref.
    if (refs.length > maxPerPrompt) {
      rejected.push({ id: refs[0]?.id || "", name: refs[0]?.name || "", reason: "too-many" });
    }
  }
  if (rejected.length) return rejected;

  let requestRefs = 0;
  for (const { prompt } of normalized) requestRefs += prompt.attachments?.length || 0;
  if (requestRefs > MAX_REQUEST_ATTACHMENT_REFS) {
    return [{ id: "", name: "", reason: "too-many-in-request" }];
  }
  return rejected;
}

// Replace each client ref with server-vetted metadata, enforcing the per-prompt
// count and total-byte caps. Returns `{ resolved, rejected }`: every ref that
// can't be honored (unknown id, over the count cap, or over the total-byte cap)
// is reported in `rejected` with a machine-readable `reason` rather than silently
// dropped, so the caller can fail the batch atomically (C4). The display `name` is
// the only client value carried through (it never touches a filesystem path).
async function resolvePromptAttachments(refs, key, options = {}) {
  const { resolveAttachment, maxPerPrompt = Infinity, maxPromptBytes = Infinity } = options;
  if (!Array.isArray(refs) || refs.length === 0 || typeof resolveAttachment !== "function") {
    return { resolved: [], rejected: [] };
  }
  const resolved = [];
  const rejected = [];
  let totalBytes = 0;
  for (const ref of refs) {
    if (resolved.length >= maxPerPrompt) {
      rejected.push({ id: ref.id, name: ref.name || "", reason: "too-many" });
      continue;
    }
    const metadata = await resolveAttachment(key, ref.id);
    if (!metadata) {
      rejected.push({ id: ref.id, name: ref.name || "", reason: "not-found" });
      continue;
    }
    const bytes = Number(metadata.bytes) || 0;
    if (totalBytes + bytes > maxPromptBytes) {
      rejected.push({ id: ref.id, name: ref.name || "", reason: "prompt-bytes-exceeded" });
      continue;
    }
    totalBytes += bytes;
    resolved.push(ref.name ? { ...metadata, name: ref.name } : metadata);
  }
  return { resolved, rejected };
}

function planLayoutWarningPrompt(warnings, prompt, revision) {
  const warningIds = layoutWarningPromptIds(prompt);
  const hasRevision = Object.hasOwn(prompt.target || {}, "artifact_revision");
  const expectedRevision = hasRevision ? parseRevisionValue(prompt.target.artifact_revision) : null;
  const conflicts = [];
  const queueIds = [];
  let hadKnownWarning = false;

  for (const id of warningIds) {
    const warning = warnings.find((candidate) => candidate.id === id);
    if (!warning) continue;
    hadKnownWarning = true;
    const duplicate =
      warning.status === "queued" &&
      Boolean(warning.queued_at) &&
      expectedRevision !== null &&
      warning.queued_revision === expectedRevision;
    if (duplicate) continue;
    if (hasRevision && (expectedRevision === null || expectedRevision !== revision)) {
      conflicts.push(id);
      continue;
    }
    if (isSelectableLayoutWarning(warning)) queueIds.push(id);
    else if (hasRevision) conflicts.push(id);
  }

  return { warningIds, expectedRevision, conflicts, queueIds, hadKnownWarning };
}

function normalizeRevision(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function parseRevisionValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function parseDiagnosticRevision(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const present = Object.hasOwn(source, "artifact_revision") || Object.hasOwn(source, "artifactRevision");
  if (!present) return { present: false, value: null };
  return { present: true, value: parseRevisionValue(source.artifact_revision ?? source.artifactRevision) };
}

function parsePassSequence(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const present = Object.hasOwn(source, "artifact_pass_sequence") || Object.hasOwn(source, "artifactPassSequence");
  const value = Number(source.artifact_pass_sequence ?? source.artifactPassSequence);
  return { present, value: Number.isSafeInteger(value) && value > 0 ? value : null };
}

const ARTIFACT_FAILURE_KINDS = new Set(["artifact-unavailable", "artifact-asset-unavailable"]);

function normalizeArtifactFailures(failures) {
  if (!Array.isArray(failures)) return [];
  return failures
    .filter((failure) => failure && typeof failure === "object" && !Array.isArray(failure))
    .map((failure) => ({
      kind: String(failure.kind || ""),
      detail: String(failure.detail || "").slice(0, 300),
      severity: "fatal",
    }))
    .filter((failure) => ARTIFACT_FAILURE_KINDS.has(failure.kind))
    .slice(0, MAX_ARTIFACT_FAILURES);
}

function normalizeTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  if (target.type === "mermaid-node") return normalizeMermaidNodeTarget(target);
  if (target.type === EXCALIDRAW_SCENE_TARGET_TYPE) return normalizeExcalidrawSceneTarget(target);
  if (target.type === LAYOUT_WARNINGS_TARGET_TYPE) return normalizeLayoutWarningsTarget(target);
  // text-range and any other/legacy target shapes pass through unchanged.
  return JSON.parse(JSON.stringify(target));
}
