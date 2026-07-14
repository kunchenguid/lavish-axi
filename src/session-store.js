import crypto from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeMermaidNodeTarget } from "./mermaid-node.js";
import { EXCALIDRAW_SCENE_TARGET_TYPE, normalizeExcalidrawSceneTarget } from "./whiteboard-core.js";

export class SessionStore {
  constructor(file) {
    this.file = file;
  }

  async listSessions() {
    const state = await this.readState();
    return Object.values(state.sessions).sort((a, b) => a.file.localeCompare(b.file));
  }

  async findByFile(file) {
    const absolute = await canonicalFile(file);
    const state = await this.readState();
    return state.sessions[sessionKey(absolute)] || null;
  }

  async findByKey(key) {
    const state = await this.readState();
    return state.sessions[key] || null;
  }

  async upsertSession(file, url) {
    const absolute = await canonicalFile(file);
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
      layout_warnings: [],
      delivered_layout_warning_keys: existing.delivered_layout_warning_keys || [],
      dom_snapshot: existing.dom_snapshot || "",
      chat: existing.chat || [],
      updated_at: new Date().toISOString(),
    };
    state.sessions[key] = session;
    await this.writeState(state);
    return session;
  }

  async queuePrompts(key, payload) {
    const state = await this.readState();
    const session = state.sessions[key];
    if (!session) {
      return null;
    }
    const prompts = Array.isArray(payload.prompts) ? payload.prompts : [];
    const shouldEndSession = Boolean(payload.endSession || payload.end_session);
    const alreadyEnded = session.status === "ended";
    const normalizedPrompts = prompts.map(normalizePrompt);
    const userMessages = normalizedPrompts
      .filter((prompt) => prompt.tag === "message" && prompt.prompt)
      .map((prompt) => ({ role: "user", text: prompt.prompt, at: new Date().toISOString() }));
    session.prompts = [...(session.prompts || []), ...normalizedPrompts];
    session.chat = [...(session.chat || []), ...userMessages];
    session.pending_prompts = session.prompts.length;
    session.dom_snapshot = String(payload.domSnapshot || payload.dom_snapshot || "");
    session.status = shouldEndSession || alreadyEnded ? "ended" : "feedback";
    if (shouldEndSession) session.ended_by = "user";
    session.updated_at = new Date().toISOString();
    await this.writeState(state);
    return session;
  }

  async recordLayoutWarnings(key, payload) {
    const state = await this.readState();
    const session = state.sessions[key];
    if (!session) {
      return null;
    }
    const deliveredWarningKeys = session.delivered_layout_warning_keys || [];
    const deliveredKeys = new Set(deliveredWarningKeys);
    const layoutWarnings = normalizeLayoutWarnings(
      payload.layout_warnings || payload.layoutWarnings || [],
      deliveredKeys,
    );
    const activeWarningKeys = new Set(layoutWarnings.map(layoutWarningKey));
    const nextDeliveredWarningKeys = deliveredWarningKeys.filter((key) => activeWarningKeys.has(key)).slice(-200);
    const deliveredKeysChanged =
      nextDeliveredWarningKeys.length !== deliveredWarningKeys.length ||
      nextDeliveredWarningKeys.some((key, index) => key !== deliveredWarningKeys[index]);
    const previousSignature = JSON.stringify(session.layout_warnings || []);
    const nextSignature = JSON.stringify(layoutWarnings);
    const warningsChanged = previousSignature !== nextSignature;
    if (!warningsChanged && !deliveredKeysChanged) {
      return { session, changed: false, hasWarnings: layoutWarnings.length > 0 };
    }
    session.layout_warnings = layoutWarnings;
    session.delivered_layout_warning_keys = nextDeliveredWarningKeys;
    if (layoutWarnings.length > 0 && session.status !== "ended") {
      session.status = "feedback";
    } else if ((session.prompts || []).length === 0 && session.status !== "ended") {
      session.status = "open";
    }
    session.updated_at = new Date().toISOString();
    await this.writeState(state);
    return { session, changed: warningsChanged, hasWarnings: layoutWarnings.length > 0 };
  }

  async takeFeedback(key) {
    const state = await this.readState();
    const session = state.sessions[key];
    if (!session) {
      return { status: "missing" };
    }
    // Prompts queued before the session ended (a browser send-and-end) must still reach the
    // agent, so deliver them before reporting the ended state; the next poll then sees ended.
    const prompts = session.prompts || [];
    const layoutWarnings = session.layout_warnings || [];
    const alreadyEnded = session.status === "ended";
    if (prompts.length === 0 && layoutWarnings.length === 0) {
      return alreadyEnded ? { status: "ended", ended_by: session.ended_by } : { status: "waiting" };
    }
    const result = {
      status: "feedback",
      dom_snapshot: session.dom_snapshot || "",
      prompts,
      ...(layoutWarnings.length > 0 ? { layout_warnings: layoutWarnings } : {}),
      // This is the final delivery before the session shows as ended - flag it so the agent
      // knows not to expect (or force) a reopened browser afterward.
      ...(alreadyEnded ? { session_ended: true, ended_by: session.ended_by } : {}),
    };
    session.prompts = [];
    session.layout_warnings = [];
    session.pending_prompts = 0;
    session.dom_snapshot = "";
    if (layoutWarnings.length > 0) {
      const deliveredKeys = new Set(session.delivered_layout_warning_keys || []);
      for (const warning of layoutWarnings) deliveredKeys.add(layoutWarningKey(warning));
      session.delivered_layout_warning_keys = [...deliveredKeys].slice(-200);
    }
    if (!alreadyEnded) {
      session.status = "open";
    }
    session.updated_at = new Date().toISOString();
    await this.writeState(state);
    return result;
  }

  // `endedBy` distinguishes a human ending review from the browser chrome ("user") from an
  // agent explicitly closing the loop via `lavish-axi end` ("agent"). Only a user-initiated end
  // blocks a plain reopen - see `SessionStore` callers in server.js.
  async endSession(key, endedBy = "agent") {
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
  }

  async addAgentReply(key, text) {
    const state = await this.readState();
    const session = state.sessions[key];
    if (!session) {
      return null;
    }
    session.chat = [...(session.chat || []), { role: "agent", text: String(text || ""), at: new Date().toISOString() }];
    session.updated_at = new Date().toISOString();
    await this.writeState(state);
    return session;
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
  const target = normalizeTarget(prompt.target);
  if (target) normalized.target = target;
  return normalized;
}

function layoutWarningKey(warning) {
  const viewportWidth = normalizeFiniteNumber(warning.viewportWidth);
  const viewportClass = viewportWidth <= 640 ? "mobile" : viewportWidth <= 1024 ? "compact" : "desktop";
  const overflowPx = normalizeFiniteNumber(warning.overflowPx);
  const magnitude =
    overflowPx <= 0
      ? "none"
      : overflowPx < 24
        ? "small"
        : overflowPx < 64
          ? "medium"
          : overflowPx < 160
            ? "large"
            : "extreme";
  return `${warning.kind}:${warning.selector}:${warning.axis || ""}:${viewportClass}:${magnitude}`;
}

// A finding whose key was already delivered to the agent in a prior poll is marked persistent
// so the agent can tell a fix attempt didn't clear it, instead of treating a reload's re-report
// of the identical warning as fresh.
function normalizeLayoutWarnings(layoutWarnings, deliveredKeys = new Set()) {
  if (!Array.isArray(layoutWarnings)) return [];
  return layoutWarnings
    .filter(
      (warning) =>
        warning &&
        typeof warning === "object" &&
        !Array.isArray(warning) &&
        String(warning.severity || "").toLowerCase() === "error",
    )
    .map((warning) => {
      const selector = String(warning.selector || "");
      const kind = String(warning.kind || "layout-failure");
      const axis = warning.axis === "vertical" ? "vertical" : warning.axis === "horizontal" ? "horizontal" : undefined;
      return {
        selector,
        kind,
        ...(axis ? { axis } : {}),
        overflowPx: normalizeFiniteNumber(warning.overflowPx),
        viewportWidth: normalizeFiniteNumber(warning.viewportWidth),
        severity: "error",
        persistent: deliveredKeys.has(
          layoutWarningKey({
            kind,
            selector,
            axis,
            overflowPx: warning.overflowPx,
            viewportWidth: warning.viewportWidth,
          }),
        ),
      };
    });
}

function normalizeFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  if (target.type === "mermaid-node") return normalizeMermaidNodeTarget(target);
  if (target.type === EXCALIDRAW_SCENE_TARGET_TYPE) return normalizeExcalidrawSceneTarget(target);
  // text-range and any other/legacy target shapes pass through unchanged.
  return JSON.parse(JSON.stringify(target));
}
