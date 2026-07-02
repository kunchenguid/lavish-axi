import crypto from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

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
    const normalizedPrompts = prompts.map(normalizePrompt);
    const userMessages = normalizedPrompts
      .filter((prompt) => prompt.tag === "message" && prompt.prompt)
      .map((prompt) => ({ role: "user", text: prompt.prompt, at: new Date().toISOString() }));
    session.prompts = [...(session.prompts || []), ...normalizedPrompts];
    session.chat = [...(session.chat || []), ...userMessages];
    session.pending_prompts = session.prompts.length;
    session.dom_snapshot = String(payload.domSnapshot || payload.dom_snapshot || "");
    session.status = "feedback";
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
    // Prompts queued before the session ended (e.g. "Send & end session") must still reach the
    // agent, so deliver them before reporting the ended state; the next poll then sees ended.
    const prompts = session.prompts || [];
    const layoutWarnings = session.layout_warnings || [];
    if (prompts.length === 0 && layoutWarnings.length === 0) {
      return session.status === "ended" ? { status: "ended" } : { status: "waiting" };
    }
    const result = {
      status: "feedback",
      dom_snapshot: session.dom_snapshot || "",
      prompts,
      ...(layoutWarnings.length > 0 ? { layout_warnings: layoutWarnings } : {}),
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
    if (session.status !== "ended") {
      session.status = "open";
    }
    session.updated_at = new Date().toISOString();
    await this.writeState(state);
    return result;
  }

  async endSession(key) {
    const state = await this.readState();
    const session = state.sessions[key];
    if (!session) {
      return null;
    }
    session.status = "ended";
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
  return `${warning.kind}:${warning.selector}`;
}

// A finding whose key was already delivered to the agent in a prior poll is marked persistent
// so the agent can tell a fix attempt didn't clear it, instead of treating a reload's re-report
// of the identical warning as fresh.
function normalizeLayoutWarnings(layoutWarnings, deliveredKeys = new Set()) {
  if (!Array.isArray(layoutWarnings)) return [];
  return layoutWarnings
    .filter((warning) => warning && typeof warning === "object" && !Array.isArray(warning))
    .map((warning) => {
      const selector = String(warning.selector || "");
      const kind = String(warning.kind || "layout-warning");
      return {
        selector,
        kind,
        overflowPx: normalizeFiniteNumber(warning.overflowPx),
        viewportWidth: normalizeFiniteNumber(warning.viewportWidth),
        severity: warning.severity === "warning" ? "warning" : "error",
        persistent: deliveredKeys.has(layoutWarningKey({ kind, selector })),
      };
    });
}

function normalizeFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  return JSON.parse(JSON.stringify(target));
}
