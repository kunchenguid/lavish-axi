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
    const session = {
      key,
      file: absolute,
      url,
      status: existing.status === "ended" ? "open" : existing.status || "open",
      pending_prompts: existing.pending_prompts || 0,
      prompts: existing.prompts || [],
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

  async takeFeedback(key) {
    const state = await this.readState();
    const session = state.sessions[key];
    if (!session) {
      return { status: "missing" };
    }
    if (session.status === "ended") {
      return { status: "ended" };
    }
    const prompts = session.prompts || [];
    if (prompts.length === 0) {
      return { status: "waiting" };
    }
    const result = {
      status: "feedback",
      dom_snapshot: session.dom_snapshot || "",
      prompts,
    };
    session.prompts = [];
    session.pending_prompts = 0;
    session.dom_snapshot = "";
    session.status = "open";
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

function normalizeTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  return JSON.parse(JSON.stringify(target));
}
