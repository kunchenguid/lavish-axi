import crypto from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  applyDiagnosticPass,
  dismissLayoutWarning as dismissWarningRecord,
  hasOutstandingRepairRequest,
  isSelectableLayoutWarning,
  layoutWarningFingerprint,
  layoutWarningPromptPayload,
  markObsoleteViewportWarnings,
  normalizeWarningPage,
  normalizeLayoutWarningsTarget,
  normalizeStoredWarnings,
  queueLayoutWarnings as queueWarningRecords,
  serializeLayoutWarnings,
} from "./layout-warnings.js";
import { AsyncMutex } from "./async-mutex.js";
import { boundStoredChat, chatEntryForPrompt, collectChatAckIds, normalizePromptId } from "./chat-messages.js";
import { normalizeMermaidNodeTarget } from "./mermaid-node.js";
import { EXCALIDRAW_SCENE_TARGET_TYPE, normalizeExcalidrawSceneTarget } from "./whiteboard-core.js";

export const LAYOUT_WARNINGS_TARGET_TYPE = "layout-warnings";
// Server state gained page attribution after the original entry-only schema.  The marker is
// deliberately a small integer rather than a proof or a visited-page registry: migration only
// records that the bounded, typed rewrite has happened once for this session.
export const PAGE_SCHEMA_VERSION = 1;
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
    // Hot copies of `session.artifact_load`, which is the durable record. A process that did not
    // issue the load reads it back through `#activeArtifactLoad` the first time it is asked for.
    this.artifactLoads = new Map();
    this.chromeLoadContexts = new Map();
  }

  // The one reader of the active load. It exists because the load outlives the process that
  // issued it: an upgrade restart replaces the server under a reviewer who never asked for it,
  // and a load this store merely forgot is not a load that ended. Whether a token is still
  // current is decided by `beginArtifactLoad` alone - nothing else may retire one.
  #activeArtifactLoad(session) {
    const cached = this.artifactLoads.get(session.key);
    if (cached) return cached;
    const restored = restoreArtifactLoad(session.artifact_load);
    if (!restored) return undefined;
    this.artifactLoads.set(session.key, restored);
    // The handoff that owns this load is part of the same record. Restoring the load without it
    // would hand the review to whichever tab re-handshakes first, so a restart would decide the
    // single-reviewer question that only an explicit takeover is allowed to decide. A handoff
    // this process has already issued is newer than the record and always wins.
    if (!this.chromeLoadContexts.has(session.key)) {
      this.chromeLoadContexts.set(session.key, restored.handoffToken);
    }
    return restored;
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
      page_schema: normalizePageSchema(existing.page_schema) || PAGE_SCHEMA_VERSION,
      status: existingStatus === "feedback" && existingPrompts.length === 0 ? "open" : existingStatus,
      pending_prompts: existing.pending_prompts || 0,
      prompts: existingPrompts,
      ...(Array.isArray(existing.feedback_batches) ? { feedback_batches: existing.feedback_batches } : {}),
      // The warning inbox is durable review state, not deliverable feedback: reopening a session
      // must never silently drop unresolved warnings the user has not triaged yet.
      layout_warnings: normalizeStoredWarnings(existing.layout_warnings),
      artifact_revision: normalizeRevision(existing.artifact_revision),
      // The reviewer's open tab is holding this token, so reopening the artifact must not retire
      // it: only a newer `beginArtifactLoad` retires a load.
      artifact_load: normalizeStoredArtifactLoad(existing.artifact_load),
      artifact_failures: normalizeArtifactFailures(existing.artifact_failures),
      // Carried across a reopen on purpose: this list is what keeps a just-delivered
      // attachment out of the sweeper's reach, and re-opening the artifact during the
      // grace window would otherwise erase that protection while the agent is still
      // reading the path. Every field this constructor omits is silently dropped, so
      // any new session field must be added here too.
      delivered_attachments: Array.isArray(existing.delivered_attachments) ? existing.delivered_attachments : [],
      dom_snapshot: existing.dom_snapshot || "",
      snapshot_page: Object.hasOwn(existing, "snapshot_page") ? normalizeStoredPage(existing.snapshot_page) : null,
      snapshot_page_proof: String(existing.snapshot_page_proof || ""),
      chat: existing.chat || [],
      chat_revision: normalizeRevision(existing.chat_revision),
      // Compact prompt_id acks for bubbles evicted by the stored-chat byte bound. Reopening
      // must keep them: they are the settlement/dedup source once the visible entry is gone.
      chat_ack_ids: Array.isArray(existing.chat_ack_ids) ? existing.chat_ack_ids : [],
      updated_at: new Date().toISOString(),
    };
    if (Array.isArray(session.feedback_batches)) syncFeedbackBatches(session);
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
    // `options.restore` re-queues a batch `takeFeedback` already removed (a poll whose client
    // disconnected before its response was written). Those prompts were accepted once already, so
    // restoring replays them verbatim: no layout-warning plan or conflict check to re-run and no
    // chat messages to re-append. Restored prompts are prepended to newer prompts, while newer
    // snapshots and failures are preserved. Attachments are still re-derived through the resolver,
    // because restore re-enters the same trust boundary.
    const restoring = options.restore === true;
    const alreadyEnded = session.status === "ended";
    // A session already ended by someone else (an agent's `lavish-axi end`, or the user in
    // another tab) must not accept a further batch as if it were queued for delivery: no agent
    // will ever poll it again, so a 200 here would be a promise the server cannot keep. This
    // applies even to a batch that also requests `endSession` - a redundant end of an
    // already-ended session is still a late batch nobody will read. Only `restore` is exempt,
    // because it never originated a new POST: it replays a batch `takeFeedback` already
    // accepted and removed, and its payload never sets `endSession`. A batch that ends a session
    // that is not yet ended is unaffected, because `alreadyEnded` is false for that call.
    if (alreadyEnded && !restoring) {
      return { ended: true, ended_by: session.ended_by };
    }
    let normalized = prompts.map(normalizePrompt);
    if (!restoring) {
      const acknowledgedIds = new Set(
        [
          ...(session.chat || []).map((entry) => normalizePromptId(entry?.prompt_id)),
          ...(session.chat_ack_ids || []).map((id) => normalizePromptId(id)),
        ].filter(Boolean),
      );
      normalized = normalized.filter(({ prompt }) => {
        const promptId = normalizePromptId(prompt.prompt_id);
        if (!promptId) return true;
        if (acknowledgedIds.has(promptId)) return false;
        acknowledgedIds.add(promptId);
        return true;
      });
    }
    const normalizedPrompts = normalized.map((entry) => entry.prompt);
    const contextValidation = options.validatePromptContext
      ? await options.validatePromptContext(normalizedPrompts, payload, session)
      : { ok: true };
    if (!contextValidation?.ok) return contextValidation?.result || { invalid_page_context: true };
    const modernBatch = Number(payload?.page_protocol) === 1 || (restoring && payload?.feedback_batch?.modern === true);
    if (!restoring && modernBatch && normalizedPrompts.length) {
      const page = normalizeStoredPage(normalizedPrompts[0]?.page);
      if (
        page === null ||
        normalizedPrompts.some((prompt) => normalizeStoredPage(prompt.page) !== page) ||
        (String(payload.domSnapshot || payload.dom_snapshot || "") &&
          normalizeStoredPage(payload.snapshot_page) !== page)
      )
        return { invalid_page_context: true };
    }
    if (!restoring) {
      const warningContextValidation = validateLayoutWarningClaims(
        session.layout_warnings,
        normalizedPrompts,
        Number(payload?.page_protocol) === 1,
      );
      if (!warningContextValidation.ok) return warningContextValidation.result;
    }
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
    let acceptedPrompts;
    if (restoring) {
      acceptedPrompts = normalizedPrompts;
    } else {
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
      acceptedPrompts = [];
      for (const plan of layoutPlans) {
        if (plan.warningIds === null) {
          acceptedPrompts.push(plan.prompt);
          continue;
        }
        plan.prompt.target = authoritativeLayoutWarningTarget(warnings, plan.prompt.target);
        const result = queueWarningRecords(warnings, plan.queueIds, { revision, at });
        warnings = result.warnings;
        if (result.queued.length > 0 || !plan.hadKnownWarning) acceptedPrompts.push(plan.prompt);
      }
    }
    session.layout_warnings = warnings;
    // Every accepted prompt with something to display joins the transcript, not only composer
    // messages: the notes a reviewer sends are the half of the conversation the panel used to
    // lose on send.
    const userMessages = restoring
      ? []
      : acceptedPrompts.map((prompt) => chatEntryForPrompt(prompt, at)).filter(Boolean);
    const existingPrompts = Array.isArray(session.prompts) ? session.prompts : [];
    // A restore replays a batch that was already accepted, so it does not need to retain any
    // transport-only credentials either. Keep the same agent-facing shape on both paths; this
    // prevents a legacy state file (or a future restore caller) from reintroducing page proofs
    // into the next poll response.
    const storedPrompts = acceptedPrompts.map(agentFacingPrompt);
    const batched = modernBatch || Array.isArray(session.feedback_batches);
    if (batched) {
      const failures = restoring ? normalizeArtifactFailures(payload.artifact_failures) : [];
      if (storedPrompts.length || failures.length) {
        const page = normalizeStoredPage(
          (restoring ? payload?.feedback_batch?.page : undefined) ?? storedPrompts[0]?.page ?? failures[0]?.page,
        );
        appendFeedbackBatch(
          session,
          {
            id: restoring ? String(payload?.feedback_batch?.id || crypto.randomUUID()) : crypto.randomUUID(),
            modern: modernBatch,
            page,
            prompts: storedPrompts,
            artifact_failures: failures,
            dom_snapshot: String(payload.domSnapshot || payload.dom_snapshot || ""),
            snapshot_page: normalizeStoredPage(payload.snapshot_page),
            snapshot_page_proof: String(payload.snapshot_page_proof || ""),
            snapshot_updated:
              restoring && typeof payload?.feedback_batch?.snapshot_updated === "boolean"
                ? payload.feedback_batch.snapshot_updated
                : storedPrompts.length > 0 || Boolean(payload.domSnapshot || payload.dom_snapshot),
          },
          { restore: restoring },
        );
      }
    } else {
      session.prompts = restoring ? [...storedPrompts, ...existingPrompts] : [...existingPrompts, ...storedPrompts];
    }
    session.chat = [...(session.chat || []), ...userMessages];
    applyTranscriptBound(session);
    if (userMessages.length > 0) session.chat_revision = normalizeRevision(session.chat_revision) + 1;
    if (restoring && !batched) {
      const restoredFailures = normalizeArtifactFailures(payload.artifact_failures);
      const existingFailures = Array.isArray(session.artifact_failures) ? session.artifact_failures : [];
      session.artifact_failures = mergeArtifactFailures(restoredFailures, existingFailures).failures;
    }
    session.pending_prompts = session.prompts.length;
    const restoredSnapshot = String(payload.domSnapshot || payload.dom_snapshot || "");
    const restoredSnapshotPage = normalizeStoredPage(payload.snapshot_page);
    const restoredSnapshotProof = String(payload.snapshot_page_proof || "");
    if (!batched && (!restoring || (existingPrompts.length === 0 && !session.dom_snapshot))) {
      session.dom_snapshot = restoredSnapshot;
      session.snapshot_page = restoredSnapshot ? restoredSnapshotPage : null;
      session.snapshot_page_proof = restoredSnapshot ? restoredSnapshotProof : "";
    }
    session.status =
      shouldEndSession || alreadyEnded
        ? "ended"
        : session.prompts.length > 0 ||
            ((restoring || batched) && Array.isArray(session.artifact_failures) && session.artifact_failures.length > 0)
          ? "feedback"
          : "open";
    if (shouldEndSession) session.ended_by = "user";
    session.updated_at = new Date().toISOString();
    await this.writeState(state);
    return { ...session, fresh_feedback: !restoring && acceptedPrompts.length > 0 };
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
      const activeLoad = this.#activeArtifactLoad(session);
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
      // Read the load first: restoring it is also what re-establishes the handoff that owns it,
      // so a reviewer whose server was replaced is not answered `no-handoff` for holding a
      // capability that is still the current one.
      const activeLoad = this.#activeArtifactLoad(session);
      const activeHandoffToken = this.chromeLoadContexts.get(key) || "";
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
      const load = {
        artifactRevision,
        artifactLoadToken,
        lastDocumentSequence: 0,
        lastPassSequence: 0,
        requestId: normalizedRequestId,
        requestSequence: normalizedRequestSequence,
        handoffToken: normalizedHandoffToken,
      };
      this.artifactLoads.set(key, load);
      session.artifact_load = serializeArtifactLoad(load);
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
      const load = this.#activeArtifactLoad(session);
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

  async authenticateWhiteboardChannel(key, artifactLoadToken, artifactRevision, documentSequence) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) return null;
      const load = this.#activeArtifactLoad(session);
      const revision = parseRevisionValue(artifactRevision);
      if (
        !load ||
        !String(artifactLoadToken || "") ||
        String(artifactLoadToken) !== load.artifactLoadToken ||
        revision !== load.artifactRevision
      ) {
        return { session, status: "stale" };
      }
      if (documentSequence < Number(load.lastDocumentSequence || 0)) {
        return { session, status: "stale-sequence" };
      }
      if (documentSequence > Number(load.lastDocumentSequence || 0)) {
        load.lastDocumentSequence = documentSequence;
        load.lastPassSequence = 0;
        session.artifact_load = serializeArtifactLoad(load);
        await this.writeState(state);
      }
      return { session, status: "authenticated" };
    });
  }

  // Native navigation inside the artifact does not carry the query string that the chrome adds
  // to the initial iframe URL.  Page routes use this read-only snapshot to stamp the same active
  // generation onto an eligible sibling without minting a second load or weakening the existing
  // token/revision checks used by the entry document and SDK route.
  async currentArtifactLoad(key) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) return null;
      const load = this.#activeArtifactLoad(session);
      return {
        session,
        valid: Boolean(load?.artifactLoadToken),
        artifact_revision: load?.artifactRevision ?? normalizeRevision(session.artifact_revision),
        artifact_load_token: load?.artifactLoadToken || "",
      };
    });
  }

  // Fold one browser diagnostic pass into the passive warning inbox. This deliberately does NOT
  // touch session status or queue feedback: detection alone must never wake an agent.
  /**
   * @param {{ viewportClasses?: string[], validatePageContext?: (context: any) => Promise<any> }} [options]
   * @returns {Promise<any>}
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
      const load = this.#activeArtifactLoad(session);
      const artifactLoadToken = String(payload?.artifact_load_token || payload?.artifactLoadToken || "");
      const reportedRevision = parseDiagnosticRevision(payload);
      const passSequence = parsePassSequence(payload);
      const pageContext = await validateLivePageContext(session, payload, options);
      const documentSequence = parseDocumentSequence(payload);
      const modernContext = hasDocumentContext(payload);
      if (
        !load ||
        artifactLoadToken !== load.artifactLoadToken ||
        !reportedRevision.present ||
        reportedRevision.value !== load.artifactRevision ||
        !passSequence.present ||
        passSequence.value === null ||
        (modernContext && (documentSequence.value === null || documentSequence.value <= 0)) ||
        !pageContext.ok ||
        (modernContext &&
          (documentSequence.value < Number(load.lastDocumentSequence || 0) ||
            (documentSequence.value === Number(load.lastDocumentSequence || 0) &&
              passSequence.value <= Number(load.lastPassSequence || 0)))) ||
        (!modernContext && passSequence.value <= Number(load.lastPassSequence || 0))
      ) {
        return {
          session,
          changed: false,
          stale: true,
          ...(pageContext.ok ? {} : { invalid_page_context: true }),
          warnings: serializeLayoutWarnings(session.layout_warnings),
        };
      }
      // Every request has been authenticated and fully ordered before this high-water update.
      // A newer document starts its pass counter at one; equal documents retain pass ordering.
      const documentAdvanced = modernContext && documentSequence.value > Number(load.lastDocumentSequence || 0);
      if (documentAdvanced) {
        load.lastDocumentSequence = documentSequence.value;
        load.lastPassSequence = 0;
      }
      load.lastPassSequence = passSequence.value;
      const at = new Date().toISOString();
      const pass = applyDiagnosticPass(session.layout_warnings, {
        complete: payload.complete !== false,
        targetPresenceComplete: payload.target_presence_complete === true || payload.targetPresenceComplete === true,
        viewportWidth: payload.viewport_width ?? payload.viewportWidth,
        findings: payload.findings || payload.layout_warnings || payload.layoutWarnings || [],
        page: pageContext.page,
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
        if (documentAdvanced) {
          session.artifact_load = serializeArtifactLoad(load);
          await this.writeState(state);
        }
        return { session, changed: false, warnings: serializeLayoutWarnings(warnings) };
      }
      session.layout_warnings = warnings;
      // Ride along with a write this pass was already making. The pass fence is deliberately NOT
      // worth a write of its own: a repeat pass that changes no warning must not rewrite
      // state.json, and a fence restored one pass behind only re-admits a pass whose findings
      // `applyDiagnosticPass` already treats as the same answer.
      session.artifact_load = serializeArtifactLoad(load);
      session.updated_at = at;
      await this.writeState(state);
      return { session, changed: true, warnings: serializeLayoutWarnings(warnings) };
    });
  }

  // Prepare the user's explicit triage action. The ordinary prompt queue commits it when sent.
  async prepareLayoutWarningFixes(key, ids, options = {}) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const revision = normalizeRevision(session.artifact_revision);
      const at = new Date().toISOString();
      const result = queueWarningRecords(session.layout_warnings, ids, { revision, at });
      const pages = new Set(result.queued.map((warning) => normalizeWarningPage(warning.page)));
      if (
        pages.size > 1 ||
        (Object.hasOwn(options, "page") && result.queued.some((warning) => warning.page !== options.page))
      )
        return {
          session,
          invalid_page_context: true,
          queued: [],
          prompt: null,
          warnings: serializeLayoutWarnings(session.layout_warnings),
        };
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
  /** @returns {Promise<any>} */
  async recordArtifactFailures(key, payload, options = {}) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const load = this.#activeArtifactLoad(session);
      const artifactLoadToken = String(payload?.artifact_load_token || payload?.artifactLoadToken || "");
      const reportedRevision = parseDiagnosticRevision(payload);
      const pageContext = await validateLivePageContext(session, payload, options);
      const documentSequence = parseDocumentSequence(payload);
      const boundDocument = hasDocumentContext(payload) && pageContext.page !== null;
      const sequenceInput = payload?.document_sequence ?? payload?.documentSequence;
      const proofInput = payload?.page_proof || payload?.pageProof || "";
      const invalidPageContext =
        !pageContext.ok ||
        (boundDocument &&
          (!pageContext.proof ||
            typeof proofInput !== "string" ||
            !["number", "string"].includes(typeof sequenceInput)));
      if (
        !load ||
        artifactLoadToken !== load.artifactLoadToken ||
        !reportedRevision.present ||
        reportedRevision.value !== load.artifactRevision ||
        invalidPageContext ||
        (boundDocument &&
          (documentSequence.value === null ||
            documentSequence.value <= 0 ||
            documentSequence.value < Number(load.lastDocumentSequence || 0)))
      ) {
        return { session, changed: false, stale: true, ...(invalidPageContext ? { invalid_page_context: true } : {}) };
      }
      const documentAdvanced = boundDocument && documentSequence.value > Number(load.lastDocumentSequence || 0);
      if (documentAdvanced) {
        load.lastDocumentSequence = documentSequence.value;
        load.lastPassSequence = 0;
      }
      // Fatal browser reports predate the optional page_protocol flag. A complete
      // page/proof/document tuple has already passed validation and live ordering
      // above, so it belongs to the same FIFO as modern prompts on that page.
      // Unbound pre-SDK failures and genuine protocol-0 reports stay legacy.
      const modernBatch = boundDocument || Number(payload?.page_protocol) === 1;
      if (modernBatch && pageContext.page === null)
        return { session, changed: false, stale: true, invalid_page_context: true };
      const normalized = normalizeArtifactFailures(payload?.failures, pageContext.page);
      if (modernBatch || Array.isArray(session.feedback_batches)) {
        ensureFeedbackBatches(session);
        // Repeated diagnostics must not resurrect the same pending observation in
        // a later batch merely because navigation moved away and returned.
        const fresh = normalized.filter(
          (failure) =>
            !session.artifact_failures.some(
              (old) => old.page === failure.page && old.kind === failure.kind && old.detail === failure.detail,
            ),
        );
        if (!fresh.length) {
          if (documentAdvanced) {
            session.artifact_load = serializeArtifactLoad(load);
            await this.writeState(state);
          }
          return { session, changed: false, failures: session.artifact_failures };
        }
        appendFeedbackBatch(
          session,
          {
            id: crypto.randomUUID(),
            modern: modernBatch,
            page: pageContext.page,
            prompts: [],
            artifact_failures: fresh,
            dom_snapshot: "",
            snapshot_page: null,
            snapshot_page_proof: "",
            snapshot_updated: false,
          },
          { keepSnapshot: true },
        );
        if (session.status !== "ended") session.status = "feedback";
        if (documentAdvanced) session.artifact_load = serializeArtifactLoad(load);
        session.updated_at = new Date().toISOString();
        await this.writeState(state);
        return { session, changed: true, failures: session.artifact_failures };
      }
      const previous = Array.isArray(session.artifact_failures) ? session.artifact_failures : [];
      const { failures, changed } = mergeArtifactFailures(previous, normalized);
      if (!changed) {
        if (documentAdvanced) {
          session.artifact_load = serializeArtifactLoad(load);
          await this.writeState(state);
        }
        return { session, changed: false, failures };
      }
      session.artifact_failures = failures;
      session.artifact_load = serializeArtifactLoad(load);
      if (session.status !== "ended") session.status = "feedback";
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return { session, changed: true, failures };
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
      const batch = Array.isArray(session.feedback_batches) ? session.feedback_batches[0] : null;
      const prompts = batch ? batch.prompts : session.prompts || [];
      // Layout warnings stay passive until the user queues them. Only fatal artifact
      // failures can reach the agent without explicit user action.
      const artifactFailures = batch
        ? batch.artifact_failures
        : Array.isArray(session.artifact_failures)
          ? session.artifact_failures
          : [];
      const alreadyEnded = session.status === "ended";
      if (prompts.length === 0 && artifactFailures.length === 0) {
        return alreadyEnded ? { status: "ended", ended_by: session.ended_by } : { status: "waiting" };
      }
      const result = {
        status: "feedback",
        dom_snapshot: session.dom_snapshot || "",
        snapshot_page: session.dom_snapshot ? normalizeStoredPage(session.snapshot_page) : null,
        snapshot_page_proof: session.dom_snapshot ? String(session.snapshot_page_proof || "") : "",
        prompts: prompts.map(agentFacingPrompt),
        ...(artifactFailures.length > 0 ? { artifact_failures: artifactFailures } : {}),
        ...(batch
          ? {
              feedback_batch: {
                id: batch.id,
                page: batch.page,
                modern: batch.modern,
                snapshot_updated: batch.snapshot_updated,
              },
            }
          : {}),
        ...(alreadyEnded && (!batch || session.feedback_batches.length === 1)
          ? { session_ended: true, ended_by: session.ended_by }
          : {}),
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
      if (batch) {
        session.feedback_batches.shift();
        syncFeedbackBatches(session);
      } else {
        session.prompts = [];
        session.artifact_failures = [];
        session.pending_prompts = 0;
        session.dom_snapshot = "";
        session.snapshot_page = null;
        session.snapshot_page_proof = "";
      }
      if (!alreadyEnded) {
        session.status = session.prompts.length || session.artifact_failures.length ? "feedback" : "open";
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
      const at = new Date().toISOString();
      session.chat = [...(session.chat || []), { role: "agent", text: String(text || ""), at }];
      applyTranscriptBound(session);
      session.chat_revision = normalizeRevision(session.chat_revision) + 1;
      session.updated_at = at;
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
      const state = { sessions: parsed.sessions || {} };
      let changed = false;
      for (const session of Object.values(state.sessions)) {
        if (!session || typeof session !== "object" || Array.isArray(session)) continue;
        const migrated = migrateLegacySession(session);
        // Upgrade old aggregate multi-page queues before their first poll, even
        // if no new browser submission arrives after this server restarts.
        const pages = new Set(
          [...(session.prompts || []), ...(session.artifact_failures || [])]
            .map((item) => normalizeStoredPage(item.page))
            .filter((page) => page !== null),
        );
        if (!Array.isArray(session.feedback_batches) && pages.size > 1) {
          ensureFeedbackBatches(session);
          changed = true;
        }
        if (Array.isArray(session.feedback_batches)) syncFeedbackBatches(session);
        const bounded = applyTranscriptBound(session);
        if (migrated || bounded) {
          if (bounded) session.chat_revision = normalizeRevision(session.chat_revision) + 1;
          changed = true;
        }
      }
      if (changed) await this.writeState(state);
      return state;
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

// Once present, feedback_batches owns delivery. Flat fields are compatibility
// projections for status, attachment retention and the existing restore audit;
// they are never drained independently of the FIFO.
function syncFeedbackBatches(session) {
  const batches = session.feedback_batches;
  session.prompts = batches.flatMap((batch) => batch.prompts);
  session.artifact_failures = batches.flatMap((batch) => batch.artifact_failures);
  session.pending_prompts = session.prompts.length;
  const first = batches[0];
  session.dom_snapshot = first?.dom_snapshot || "";
  session.snapshot_page = session.dom_snapshot ? normalizeStoredPage(first.snapshot_page) : null;
  session.snapshot_page_proof = session.dom_snapshot ? String(first.snapshot_page_proof || "") : "";
  if (session.status !== "ended") session.status = batches.length ? "feedback" : "open";
}

function ensureFeedbackBatches(session) {
  if (Array.isArray(session.feedback_batches)) return;
  const batches = [];
  const makeBatch = (page) => ({
    id: crypto.randomUUID(),
    modern: false,
    page,
    prompts: [],
    artifact_failures: [],
    dom_snapshot: "",
    snapshot_page: null,
    snapshot_page_proof: "",
    snapshot_updated: false,
  });
  // Legacy aggregate state did not record cross-channel arrival order. Preserve
  // prompt order, attach each failure to its last matching page batch, and keep
  // the one recoverable snapshot only on its recorded page; invent no context.
  for (const prompt of session.prompts || []) {
    const page = normalizeStoredPage(prompt.page);
    if (!batches.length || batches.at(-1).page !== page) batches.push(makeBatch(page));
    batches.at(-1).prompts.push(prompt);
  }
  for (const failure of session.artifact_failures || []) {
    const page = normalizeStoredPage(failure.page);
    let batch = batches.findLast((candidate) => candidate.page === page);
    if (!batch) {
      batch = makeBatch(page);
      batches.push(batch);
    }
    batch.artifact_failures.push(failure);
  }
  const snapshotBatch = batches.findLast((batch) => batch.page === normalizeStoredPage(session.snapshot_page));
  if (snapshotBatch && session.dom_snapshot) {
    snapshotBatch.dom_snapshot = session.dom_snapshot;
    snapshotBatch.snapshot_page = session.snapshot_page;
    snapshotBatch.snapshot_page_proof = session.snapshot_page_proof || "";
    snapshotBatch.snapshot_updated = true;
  }
  session.feedback_batches = batches;
  syncFeedbackBatches(session);
}

function appendFeedbackBatch(session, incoming, { restore = false, keepSnapshot = false } = {}) {
  ensureFeedbackBatches(session);
  const batches = session.feedback_batches;
  if (restore && batches.some((batch) => batch.id === incoming.id)) return;
  const tail = batches.at(-1);
  // Coalescing only the adjacent tail preserves A -> B -> A arrival order.
  if (!restore && tail && tail.page === incoming.page && tail.modern === incoming.modern) {
    tail.prompts.push(...incoming.prompts);
    tail.artifact_failures = mergeArtifactFailures(tail.artifact_failures, incoming.artifact_failures).failures;
    if (!keepSnapshot) {
      tail.dom_snapshot = incoming.dom_snapshot;
      tail.snapshot_page = incoming.dom_snapshot ? incoming.snapshot_page : null;
      tail.snapshot_page_proof = incoming.dom_snapshot ? incoming.snapshot_page_proof : "";
      tail.snapshot_updated = incoming.snapshot_updated;
    }
  } else if (restore) {
    const first = batches[0];
    if (first && first.page === incoming.page && first.modern === incoming.modern) {
      // No intervening page: restore earlier writing before the newer same-page
      // work, while its latest snapshot (including an explicit clear) wins.
      first.prompts.unshift(...incoming.prompts);
      first.artifact_failures = mergeArtifactFailures(incoming.artifact_failures, first.artifact_failures).failures;
      // Diagnostics do not clear snapshots. Distinguish their lack of context
      // from a newer prompt submission that explicitly cleared its snapshot.
      if (!first.snapshot_updated && incoming.snapshot_updated) {
        first.dom_snapshot = incoming.dom_snapshot;
        first.snapshot_page = incoming.snapshot_page;
        first.snapshot_page_proof = incoming.snapshot_page_proof;
        first.snapshot_updated = true;
      }
      first.id = incoming.id;
    } else batches.unshift(incoming);
  } else batches.push(incoming);
  syncFeedbackBatches(session);
}

/**
 * Rewrite one pre-page-schema session in place.
 *
 * The store can establish only the saved entry identity here. It must not mint a page proof (the
 * server owns that key and its verification boundary), and it never treats arbitrary page-less
 * chat as entry feedback. A missing `file` is therefore a deliberate no-op: the caller that
 * later supplies canonical entry context can run this same migration again.
 *
 * @param {any} session
 * @param {{ entryPage?: string | ((session: any) => string | null | undefined) }} [options]
 * @returns {boolean} whether the session was changed
 */
export function migrateLegacySession(session, options = {}) {
  if (!session || typeof session !== "object" || Array.isArray(session)) return false;
  if (normalizePageSchema(session.page_schema) >= PAGE_SCHEMA_VERSION) return false;

  const entryPage = resolveMigrationEntryPage(session, options.entryPage);
  if (!entryPage) return false;

  let changed = false;
  const warnings = Array.isArray(session.layout_warnings) ? session.layout_warnings : [];
  if (migrateLegacyWarnings(warnings, entryPage)) changed = true;
  if (migrateLegacyPrompts(session, entryPage, warnings)) changed = true;
  if (migrateLegacyChat(session)) changed = true;
  if (migrateLegacyFailures(session, entryPage)) changed = true;
  if (migrateLegacySnapshot(session, entryPage)) changed = true;

  // Mark completion even when this session had no legacy fields. That makes a second state read
  // byte-stable and prevents a future caller from interpreting a newly added explicit null as
  // evidence that it was an old entry item.
  if (session.page_schema !== PAGE_SCHEMA_VERSION) {
    session.page_schema = PAGE_SCHEMA_VERSION;
    changed = true;
  }
  return changed;
}

function normalizePageSchema(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function resolveMigrationEntryPage(session, supplied) {
  let candidate = supplied;
  if (typeof supplied === "function") {
    try {
      candidate = supplied(session);
    } catch {
      candidate = null;
    }
  }
  if (candidate === undefined) {
    const file = typeof session.file === "string" ? session.file : "";
    if (!file || file.includes("\0")) return null;
    candidate = path.basename(file);
  }
  if (typeof candidate !== "string") return null;
  return normalizeWarningPage(candidate);
}

function migrateLegacyPrompts(session, entryPage, warnings) {
  if (!Array.isArray(session.prompts)) return false;
  let changed = false;
  const warningById = new Map(
    warnings
      .filter((warning) => warning && typeof warning === "object" && !Array.isArray(warning))
      .map((warning) => [String(warning.id || ""), warning])
      .filter(([id]) => id),
  );
  for (const prompt of session.prompts) {
    if (!prompt || typeof prompt !== "object" || Array.isArray(prompt)) continue;
    if (prompt.tag === "layout-warnings" && prompt.target?.type === LAYOUT_WARNINGS_TARGET_TYPE) {
      const items = Array.isArray(prompt.target.warnings) ? prompt.target.warnings : [];
      for (const item of items) {
        if (
          !item ||
          typeof item !== "object" ||
          Array.isArray(item) ||
          (Object.hasOwn(item, "page") && item.page !== "")
        )
          continue;
        const warning = warningById.get(String(item.id || ""));
        item.page = warning && Object.hasOwn(warning, "page") ? normalizeWarningPage(warning.page) : null;
        changed = true;
      }
      // Historical batches may predate page isolation. Preserve their recorded
      // attribution; do not invent a common page while migrating old transcripts.
      continue;
    }
    if (Object.hasOwn(prompt, "page") && prompt.page !== "") continue;
    prompt.page = entryPage;
    changed = true;
  }
  return changed;
}

function migrateLegacyChat(session) {
  if (!Array.isArray(session.chat)) return false;
  let changed = false;
  for (const entry of session.chat) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.hasOwn(entry, "page")) continue;
    // Chat can have been typed over an ineligible/remote document. Its words are durable, but
    // there is no server-established page provenance to recover.
    entry.page = null;
    changed = true;
  }
  return changed;
}

function migrateLegacyFailures(session, entryPage) {
  if (!Array.isArray(session.artifact_failures)) return false;
  let changed = false;
  for (const failure of session.artifact_failures) {
    if (
      !failure ||
      typeof failure !== "object" ||
      Array.isArray(failure) ||
      (Object.hasOwn(failure, "page") && failure.page !== "")
    )
      continue;
    failure.page = entryPage;
    changed = true;
  }
  return changed;
}

function migrateLegacySnapshot(session, entryPage) {
  const snapshot = String(session.dom_snapshot || "");
  let changed = false;
  if (!snapshot) {
    if (!Object.hasOwn(session, "snapshot_page") || session.snapshot_page !== null) {
      session.snapshot_page = null;
      changed = true;
    }
    if (!Object.hasOwn(session, "snapshot_page_proof") || session.snapshot_page_proof !== "") {
      session.snapshot_page_proof = "";
      changed = true;
    }
    return changed;
  }
  // Older writers sometimes serialized an unavailable page as an empty string. It is not the
  // explicit modern null sentinel, so a nonempty historical snapshot may still recover entry
  // provenance in that case.
  if (!Object.hasOwn(session, "snapshot_page") || session.snapshot_page === "") {
    session.snapshot_page = entryPage;
    changed = true;
  }
  return changed;
}

function migrateLegacyWarnings(warnings, entryPage) {
  let changed = false;
  for (const warning of warnings) {
    if (
      !warning ||
      typeof warning !== "object" ||
      Array.isArray(warning) ||
      (Object.hasOwn(warning, "page") && warning.page !== "")
    )
      continue;
    warning.page = entryPage;
    warning.fingerprint = layoutWarningFingerprint({
      rule: warning.rule || warning.kind,
      target: warning.selector,
      viewportClass: warning.viewport_class,
      page: entryPage,
    });
    changed = true;
  }
  return changed;
}

function applyTranscriptBound(session) {
  const originalChat = Array.isArray(session.chat) ? session.chat : [];
  const { chat, evicted } = boundStoredChat(session.chat);
  const chatChanged =
    !Array.isArray(session.chat) ||
    chat.length !== originalChat.length ||
    chat.some((entry, index) => entry !== originalChat[index]);
  session.chat = chat;
  if (evicted.length === 0) return chatChanged;
  const existingAckCount = Array.isArray(session.chat_ack_ids) ? session.chat_ack_ids.length : 0;
  session.chat_ack_ids = collectChatAckIds(evicted, session.chat_ack_ids);
  return chatChanged || session.chat_ack_ids.length !== existingAckCount;
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
  // Preserve the claim as supplied until the server's page-proof validator sees it. Coercing an
  // invalid path (or a non-string value) to null here would turn an untrusted claim into the
  // legitimate "no page" value and let it bypass atomic context validation. Validated production
  // requests are canonicalized by the server before this prompt can be persisted; this raw value
  // is deliberately only an intermediate trust-boundary representation.
  if (Object.hasOwn(prompt || {}, "page")) normalized.page = prompt.page;
  if (Object.hasOwn(prompt || {}, "page_proof")) normalized.page_proof = String(prompt.page_proof || "");
  const promptId = normalizePromptId(prompt.prompt_id);
  if (promptId) normalized.prompt_id = promptId;
  const target = normalizeTarget(prompt.target);
  if (target) normalized.target = target;
  const { refs, malformed } = normalizeAttachmentRefs(prompt.attachments);
  if (refs.length > 0) normalized.attachments = refs;
  return { prompt: normalized, malformed };
}

// Settlement identity is transcript-owned. The agent-facing prompt list must not carry it:
// poll output stays the reviewer's words, and a restore replay never re-appends chat.
function agentFacingPrompt(prompt) {
  if (!prompt || typeof prompt !== "object") return prompt;
  const rest = { ...prompt };
  if (rest.prompt_id !== undefined) delete rest.prompt_id;
  delete rest.page_proof;
  return rest;
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

  // The request-wide bound guards ONE untrusted POST. A restore is not a request: it re-queues a
  // batch this store already accepted across an unbounded number of earlier POSTs, so measuring it
  // against a single request's budget rejects the whole batch and loses feedback for good - the
  // exact loss restore exists to prevent. The per-prompt cap above and the resolver's own work
  // still apply, and the ref count is bounded by what was already admitted.
  if (options.restore !== true) {
    let requestRefs = 0;
    for (const { prompt } of normalized) requestRefs += prompt.attachments?.length || 0;
    if (requestRefs > MAX_REQUEST_ATTACHMENT_REFS) {
      return [{ id: "", name: "", reason: "too-many-in-request" }];
    }
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

function validateLayoutWarningClaims(warnings, prompts, modern = false) {
  const records = normalizeStoredWarnings(warnings);
  const invalid = [];
  for (const [promptIndex, prompt] of (Array.isArray(prompts) ? prompts : []).entries()) {
    if (prompt?.tag !== "layout-warnings" || prompt.target?.type !== LAYOUT_WARNINGS_TARGET_TYPE) continue;
    for (const [warningIndex, item] of (Array.isArray(prompt.target.warnings)
      ? prompt.target.warnings
      : []
    ).entries()) {
      const record = records.find((candidate) => candidate.id === String(item.id || ""));
      const recordPage = record ? normalizeWarningPage(record.page) : null;
      if (
        (modern && (!record || typeof prompt.page !== "string" || recordPage !== prompt.page)) ||
        (!modern && typeof prompt.page === "string" && recordPage !== null && recordPage !== prompt.page)
      ) {
        invalid.push({ index: promptIndex, warning_index: warningIndex, prompt_id: prompt.prompt_id || "" });
        continue;
      }
      if (!Object.hasOwn(item || {}, "page") || item.page === null || item.page === "") continue;
      const claimed = normalizeWarningPage(item.page);
      if (!record || claimed === null || claimed !== recordPage) {
        invalid.push({ index: promptIndex, warning_index: warningIndex, prompt_id: prompt.prompt_id || "" });
      }
    }
  }
  return invalid.length
    ? { ok: false, result: { invalid_page_context: true, invalid: invalid.slice(0, 8) } }
    : { ok: true };
}

function authoritativeLayoutWarningTarget(warnings, target) {
  const normalized = normalizeLayoutWarningsTarget(target);
  const records = normalizeStoredWarnings(warnings);
  return {
    ...normalized,
    warnings: normalized.warnings.map((item) => {
      const record = records.find((candidate) => candidate.id === item.id);
      return {
        ...item,
        page: record ? normalizeWarningPage(record.page) : null,
      };
    }),
  };
}

// The active artifact load, in the shape state.json carries it. Snake-cased like every other
// stored field, and complete: the fences a begin is judged against (`request_id`,
// `request_sequence`, `handoff_token`) belong to the same epoch as the token, so a process that
// restored the token without them would answer a reviewer's retry with a new epoch, or let a
// begin the previous process already overtook win.
function serializeArtifactLoad(load) {
  return {
    schema_version: 2,
    artifact_load_token: load.artifactLoadToken,
    artifact_revision: load.artifactRevision,
    last_document_sequence: load.lastDocumentSequence,
    last_pass_sequence: load.lastPassSequence,
    request_id: load.requestId,
    request_sequence: load.requestSequence,
    handoff_token: load.handoffToken,
  };
}

// #371 wrote the first six fields before page-scoped document fencing existed. Versioned loads
// require all seven; the complete older shape restores with the new fence at zero.
const STORED_ARTIFACT_LOAD_FIELDS = [
  "artifact_load_token",
  "artifact_revision",
  "last_document_sequence",
  "last_pass_sequence",
  "request_id",
  "request_sequence",
  "handoff_token",
];

// All of the epoch or none of it. Restoring a partial record would honor the token while some
// fence it travels with defaulted away: without `handoff_token` the load answers 200 to everyone
// while its own reviewer's next begin is told `no-handoff`, and without `request_sequence` a begin
// the previous process already overtook wins. A partial versioned state.json degrades to the
// pre-persistence behaviour - one re-handshake and a fresh epoch - rather than admitting a load
// the store can only partly describe. Presence and type are what is checked, not value:
// `request_id` is legitimately "" and each sequence fence is legitimately 0 on a just-begun
// load. The revision is not: `beginArtifactLoad` only mints positive ones, so 0 is a value this
// code never wrote and a load restored with it would be served at a revision that never existed.
// The two tokens are additionally required non-empty, which rejects nothing this code wrote
// (`beginArtifactLoad` only mints non-empty ones) and is load-bearing for `artifact_load_token`:
// diagnostics compare their own token against it, so an empty restored token would be matched by
// a token-less pass.
function restoreArtifactLoad(stored) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  const versioned = Object.hasOwn(stored, "schema_version");
  if (versioned && stored.schema_version !== 2) return null;
  const priorEpoch = !versioned && !Object.hasOwn(stored, "last_document_sequence");
  if (STORED_ARTIFACT_LOAD_FIELDS.some((field) => field !== "last_document_sequence" && !Object.hasOwn(stored, field)))
    return null;
  if (!priorEpoch && !Object.hasOwn(stored, "last_document_sequence")) return null;
  const artifactLoadToken = stored.artifact_load_token;
  const handoffToken = stored.handoff_token;
  const requestId = stored.request_id;
  if (typeof artifactLoadToken !== "string" || !artifactLoadToken) return null;
  if (typeof handoffToken !== "string" || !handoffToken) return null;
  if (typeof requestId !== "string") return null;
  const artifactRevision = parseSequenceValue(stored.artifact_revision);
  if (artifactRevision === 0) return null;
  const lastDocumentSequence = priorEpoch ? 0 : parseSequenceValue(stored.last_document_sequence);
  const lastPassSequence = parseSequenceValue(stored.last_pass_sequence);
  const requestSequence = parseSequenceValue(stored.request_sequence);
  if (
    artifactRevision === null ||
    lastDocumentSequence === null ||
    lastPassSequence === null ||
    requestSequence === null
  )
    return null;
  return {
    artifactRevision,
    artifactLoadToken,
    lastDocumentSequence,
    lastPassSequence,
    requestId,
    requestSequence,
    handoffToken,
  };
}

function normalizeStoredArtifactLoad(stored) {
  const restored = restoreArtifactLoad(stored);
  return restored ? serializeArtifactLoad(restored) : null;
}

// Null rather than 0 for anything unreadable: 0 is a real sequence, so coercing to it would turn a
// corrupt fence into an open one.
function parseSequenceValue(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
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

function parseDocumentSequence(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const present = Object.hasOwn(source, "document_sequence") || Object.hasOwn(source, "documentSequence");
  const value = Number(source.document_sequence ?? source.documentSequence);
  return { present, value: Number.isSafeInteger(value) && value > 0 ? value : null };
}

function hasDocumentContext(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  return (
    Object.hasOwn(source, "page") ||
    Object.hasOwn(source, "page_proof") ||
    Object.hasOwn(source, "pageProof") ||
    Object.hasOwn(source, "document_sequence") ||
    Object.hasOwn(source, "documentSequence")
  );
}

async function validateLivePageContext(session, payload, options) {
  const modern = hasDocumentContext(payload);
  if (!modern) return { ok: true, page: null, proof: "", legacy: true };
  const page = Object.hasOwn(payload || {}, "page") ? payload.page : undefined;
  const proof = String(payload?.page_proof || payload?.pageProof || "");
  const validator = options?.validatePageContext || options?.validatePageClaim;
  if (typeof validator === "function") {
    const result = await validator({ session, page, proof, payload });
    if (!result || result.ok === false) return { ok: false, page: null, proof: "" };
    const canonicalPage = Object.hasOwn(result, "page")
      ? normalizeWarningPage(result.page)
      : normalizeWarningPage(page);
    return { ok: true, page: canonicalPage, proof: String(result.proof || proof) };
  }
  // The HTTP server supplies the proof validator. Pure store callers still get page isolation;
  // their page is normalized here and cannot be used to authorize a network request.
  if (page === null || page === "") return { ok: proof === "", page: null, proof: "" };
  const normalized = normalizeWarningPage(page);
  return { ok: Boolean(normalized), page: normalized, proof };
}

const ARTIFACT_FAILURE_KINDS = new Set(["artifact-unavailable", "artifact-asset-unavailable"]);

// The single merge policy for legacy failures and each FIFO page batch, shared by both writers
// (a fresh report and a closed-poll restore), which is why `earlier` is always the chronologically
// older side. A repeat of a failure already on file is not a second failure, and the list stays
// bounded because state.json is rewritten wholesale.
//
// Which END the bound trims is one policy for both writers, and it is load-bearing that a restore
// does not get its own: the bound keeps the NEWEST entries, so no write can evict an observation
// made after it. A restore that trimmed the newest end instead would delete failures recorded
// inside its own disconnect window - never delivered either, and describing the artifact the
// reviewer is looking at now - and nothing else holds them, because the restore REPLACES this list.
// At the bound the restore's own overflow is dropped, which `restoreClosedFeedback` reports through
// its incomplete-restore log rather than losing silently.
function mergeArtifactFailures(earlier, later) {
  const merged = Array.isArray(earlier) ? [...earlier] : [];
  let changed = false;
  for (const failure of Array.isArray(later) ? later : []) {
    if (
      merged.some(
        (item) =>
          normalizeWarningPage(item.page) === normalizeWarningPage(failure.page) &&
          item.kind === failure.kind &&
          item.detail === failure.detail,
      )
    )
      continue;
    merged.push(failure);
    changed = true;
  }
  return { failures: merged.slice(-MAX_ARTIFACT_FAILURES), changed };
}

function normalizeArtifactFailures(failures, capturedPage = undefined) {
  if (!Array.isArray(failures)) return [];
  const hasCapturedPage = capturedPage !== undefined;
  const normalizedCapturedPage = hasCapturedPage ? normalizeWarningPage(capturedPage) : null;
  return failures
    .filter((failure) => failure && typeof failure === "object" && !Array.isArray(failure))
    .map((failure) => ({
      kind: String(failure.kind || ""),
      detail: String(failure.detail || "").slice(0, 300),
      page: hasCapturedPage ? normalizedCapturedPage : normalizeWarningPage(failure.page),
      severity: "fatal",
    }))
    .filter((failure) => ARTIFACT_FAILURE_KINDS.has(failure.kind))
    .slice(-MAX_ARTIFACT_FAILURES);
}

function normalizeTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  if (target.type === "mermaid-node") return normalizeMermaidNodeTarget(target);
  if (target.type === EXCALIDRAW_SCENE_TARGET_TYPE) return normalizeExcalidrawSceneTarget(target);
  if (target.type === LAYOUT_WARNINGS_TARGET_TYPE) return normalizeLayoutWarningsTarget(target);
  // text-range and any other/legacy target shapes pass through unchanged.
  return JSON.parse(JSON.stringify(target));
}

function normalizeStoredPage(value) {
  if (value === null || value === undefined || value === "") return null;
  const page = String(value);
  if (
    page.length > 16 * 1024 ||
    page.includes("\0") ||
    (page.includes("\\") && page.includes("/")) ||
    page.startsWith("/")
  )
    return null;
  return page;
}
