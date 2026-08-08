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
import { normalizeMermaidNodeTarget } from "./mermaid-node.js";
import { EXCALIDRAW_SCENE_TARGET_TYPE, normalizeExcalidrawSceneTarget } from "./whiteboard-core.js";

export const LAYOUT_WARNINGS_TARGET_TYPE = "layout-warnings";
const MAX_ARTIFACT_FAILURES = 20;

export class SessionStore {
  constructor(file) {
    this.file = file;
    /** @type {Promise<unknown>} */
    this.stateOperationQueue = Promise.resolve();
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
    const absolute = await canonicalFile(file);
    const key = sessionKey(absolute);
    return this.runExclusive(async () => {
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
        dom_snapshot: existing.dom_snapshot || "",
        chat: existing.chat || [],
        annotations: existing.annotations || [],
        updated_at: new Date().toISOString(),
      };
      state.sessions[key] = session;
      await this.writeState(state);
      return session;
    });
  }

  async queuePrompts(key, payload) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const prompts = Array.isArray(payload.prompts) ? payload.prompts : [];
      const shouldEndSession = Boolean(payload.endSession || payload.end_session);
      const alreadyEnded = session.status === "ended";
      const normalizedPrompts = prompts.map(normalizePrompt);
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
        .map((prompt) => ({ role: "user", text: prompt.prompt, at }));
      // Annotation-tagged prompts never reach session.chat (only tag === "message" does) and
      // session.prompts is a write-only outbox drained by takeFeedback, so without this they
      // leave no visible trace once sent. This is the durable, human-facing record of them.
      const newAnnotations = acceptedPrompts
        .filter((prompt) => prompt.tag !== "message" && prompt.selector)
        .map((prompt) => ({
          id: prompt.id || "",
          selector: prompt.selector,
          tag: prompt.tag,
          text: prompt.text,
          prompt: prompt.prompt,
          at,
          ...(prompt.target ? { target: prompt.target } : {}),
        }));
      session.prompts = [...(session.prompts || []), ...acceptedPrompts];
      session.chat = [...(session.chat || []), ...userMessages];
      session.annotations = [...(session.annotations || []), ...newAnnotations];
      session.pending_prompts = session.prompts.length;
      session.dom_snapshot = String(payload.domSnapshot || payload.dom_snapshot || "");
      session.status = shouldEndSession || alreadyEnded ? "ended" : session.prompts.length > 0 ? "feedback" : "open";
      if (shouldEndSession) session.ended_by = "user";
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return session;
    });
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
      // Layout warnings are NOT delivered here. Detection is passive: the user decides which
      // warnings become work by queueing them, and that arrives as an ordinary prompt above.
      // Only artifact failures - a review that cannot be used at all - still reach the agent
      // without user action.
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
        // This is the final delivery before the session shows as ended - flag it so the agent
        // knows not to expect (or force) a reopened browser afterward.
        ...(alreadyEnded ? { session_ended: true, ended_by: session.ended_by } : {}),
      };
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
    const result = this.stateOperationQueue.then(operation);
    this.stateOperationQueue = result.catch(() => {});
    return result;
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

function normalizePrompt(prompt) {
  const normalized = {
    uid: String(prompt.uid || ""),
    prompt: String(prompt.prompt || ""),
    selector: String(prompt.selector || ""),
    tag: String(prompt.tag || ""),
    text: String(prompt.text || ""),
  };
  const id = String(prompt.id || "").trim();
  if (id) normalized.id = id;
  const target = normalizeTarget(prompt.target);
  if (target) normalized.target = target;
  return normalized;
}

function layoutWarningPromptIds(prompt) {
  if (prompt?.tag !== "layout-warnings" || prompt.target?.type !== LAYOUT_WARNINGS_TARGET_TYPE) return null;
  return Array.isArray(prompt.target.warnings)
    ? prompt.target.warnings.map((warning) => String(warning?.id || "")).filter(Boolean)
    : [];
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
