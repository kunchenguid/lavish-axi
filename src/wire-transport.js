/**
 * Wire-AXI Transport Adapter for Lavish Editor
 * Implements RFC-001 specification:
 * - Single-line text frames: [type]:[seq_id]:[channel]:[flags] [payload]
 * - Monotonic sequence IDs per channel
 * - Lossless sliding-window buffer with explicit client ACK
 * - Reconnection replay via last_seen_seq
 * - Real-time WebSocket client for atomic wait and poll
 */

import { EventEmitter } from "node:events";

export class WireFrameError extends Error {
  constructor(message) {
    super(message);
    this.name = "WireFrameError";
  }
}

export const OPCODES = Object.freeze({
  OPEN: "O",
  MESSAGE: "P",
  ACK: "A",
  HEARTBEAT: "H",
  CLOSE: "E",
  PUSH: "P",
  END: "E",
});

export const FLAGS = Object.freeze({
  REQUIRES_ACK: "R",
  END_SESSION: "E",
  TRUNCATED: "T",
  NONE: "-",
});

/** @type {Set<string>} */
const VALID_OPCODES = new Set(["O", "M", "A", "H", "C", "P", "E"]);
/** @type {Set<string>} */
const VALID_FLAGS = new Set(["R", "E", "T", "-"]);

/**
 * Encode a protocol frame into a wire string.
 * @param {object} param0
 * @param {string} param0.type
 * @param {number|string} [param0.seqId]
 * @param {number|string} [param0.seq]
 * @param {string} [param0.channel='default']
 * @param {string|string[]|Set<string>} [param0.flags]
 * @param {string} [param0.payload='']
 * @returns {string}
 */
export function encodeFrame({ type, seqId, seq, channel = "default", flags, payload = "" }) {
  if (!VALID_OPCODES.has(type)) {
    throw new WireFrameError(`Invalid opcode: ${type}. Must be one of ${Array.from(VALID_OPCODES).join(", ")}`);
  }

  const rawSeq = seqId !== undefined && seqId !== null ? seqId : seq;
  const s = typeof rawSeq === "number" ? Math.max(0, Math.floor(rawSeq)) : parseInt(String(rawSeq ?? 0), 10) || 0;
  const ch = (channel || "default").trim();
  if (ch.includes(":") || ch.includes(" ")) {
    throw new WireFrameError(`Invalid channel name "${ch}". Channel cannot contain colons or spaces.`);
  }

  let flagStr = "";
  if (flags instanceof Set || Array.isArray(flags)) {
    const arr = Array.from(flags);
    flagStr = arr
      .filter((f) => f && f !== "-")
      .sort()
      .join("");
  } else if (typeof flags === "string") {
    if (flags === "-") {
      flagStr = "-";
    } else {
      const cleaned = flags.replace(/[^RET]/g, "");
      flagStr =
        cleaned.length > 0
          ? Array.from(new Set(cleaned.split("")))
              .sort()
              .join("")
          : "";
    }
  }

  const cleanPayload = payload !== undefined && payload !== null ? String(payload) : "";
  if (cleanPayload.length > 0) {
    return `${type}:${s}:${ch}:${flagStr} ${cleanPayload}`;
  }
  return `${type}:${s}:${ch}:${flagStr}`;
}

/**
 * Decode a wire line into a protocol frame object.
 * @param {string} line
 * @returns {{
 *   type: string,
 *   seqId: number,
 *   seq: number,
 *   channel: string,
 *   rawFlags: string,
 *   flags: string,
 *   flagSet: Set<string>,
 *   payload: string
 * }}
 */
export function decodeFrame(line) {
  if (typeof line !== "string") {
    throw new WireFrameError("Frame must be a string");
  }

  const trimmed = line.trimEnd();
  if (!trimmed) {
    throw new WireFrameError("Empty frame line");
  }

  const spaceIdx = trimmed.indexOf(" ");
  const header = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const payload = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);

  const parts = header.split(":");
  if (parts.length !== 4) {
    throw new WireFrameError(`Invalid frame header "${header}". Expected [type]:[seq_id]:[channel]:[flags]`);
  }

  const [type, seqStr, channel, rawFlags] = parts;

  if (!VALID_OPCODES.has(type)) {
    throw new WireFrameError(`Invalid opcode "${type}" in frame header`);
  }

  const seqId = parseInt(seqStr, 10);
  if (Number.isNaN(seqId) || seqId < 0) {
    throw new WireFrameError(`Invalid seq_id "${seqStr}". Must be a non-negative integer.`);
  }

  if (!channel) {
    throw new WireFrameError("Channel cannot be empty in frame header");
  }

  const flags = new Set();
  if (rawFlags && rawFlags !== "-") {
    for (const char of rawFlags) {
      if (!VALID_FLAGS.has(char)) {
        throw new WireFrameError(`Invalid flag character "${char}"`);
      }
      flags.add(char);
    }
  }

  return {
    type,
    seqId,
    seq: seqId,
    channel,
    rawFlags: rawFlags || "-",
    flags: rawFlags || "-",
    flagSet: flags,
    payload,
  };
}

/**
 * Parse key=value;key2=val2 parameters from a payload.
 * @param {string} payload
 * @returns {Record<string, string>}
 */
export function parseParams(payload) {
  if (!payload || typeof payload !== "string") return {};
  /** @type {Record<string, string>} */
  const params = {};
  const pairs = payload.split(";");
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx !== -1) {
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (k) params[k] = v;
    }
  }
  return params;
}

/**
 * Format key-value parameters into a parameter string.
 * @param {Record<string, any>} params
 * @returns {string}
 */
export function formatParams(params) {
  return Object.entries(params)
    .filter(([_, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join(";");
}

export function encodeAck(channel, seqId) {
  return encodeFrame({
    type: OPCODES.ACK,
    seqId,
    channel,
    flags: "-",
  });
}

/**
 * Stateful sliding-window channel buffer for wire transport.
 */
export class WireChannel {
  /**
   * @param {string | { id?: string, capacity?: number, windowSize?: number }} [idOrOptions="default"]
   * @param {{ id?: string, capacity?: number, windowSize?: number }} [options={}]
   */
  constructor(idOrOptions = "default", options = {}) {
    let opts = options;
    let id = "default";
    if (typeof idOrOptions === "object" && idOrOptions !== null) {
      opts = idOrOptions;
      id = opts.id || "default";
    } else if (typeof idOrOptions === "string") {
      id = idOrOptions;
    }
    this.id = id;
    this.status = "live";
    this.lastSeq = 0;
    this.lastAcked = 0;
    this.capacity = opts.capacity || opts.windowSize || 500;
    this.buffer = [];
    this.subscribers = new Set();
    this.unacked = new Map();
    this.clientAcks = new Map();
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
  }

  /**
   * Append a message to this channel.
   * Assigns strictly monotonic seq_id, saves to sliding buffer, tracks unacked.
   * @param {object} param0
   * @param {string} param0.payload
   * @param {string|Set<string>|string[]} [param0.flags='-']
   * @param {string} [param0.sender='server']
   * @param {string} [param0.channel]
   * @returns {object} The created message record
   */
  publish({ payload, flags = "-", sender = "server", channel = this.id }) {
    this.lastSeq += 1;
    this.updatedAt = Date.now();

    const flagSet =
      flags instanceof Set ? flags : new Set(Array.isArray(flags) ? flags : String(flags || "").split(""));
    const rawFlags =
      Array.from(flagSet)
        .filter((f) => f && f !== "-")
        .sort()
        .join("") || "-";
    const msg = {
      seq: this.lastSeq,
      seqId: this.lastSeq,
      channel: channel || this.id,
      flags: flagSet,
      rawFlags,
      payload: payload !== undefined && payload !== null ? String(payload) : "",
      sender,
      timestamp: this.updatedAt,
    };

    this.buffer.push(msg);
    if (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }

    if (flagSet.has("R")) {
      this.unacked.set(msg.seqId, msg);
    }

    if (flagSet.has("E")) {
      this.status = "ended";
    }

    return msg;
  }

  push(params) {
    const msg = this.publish(params);
    return {
      ...msg,
      type: OPCODES.PUSH,
    };
  }

  /**
   * Register explicit client acknowledgement for a sequence ID.
   * @param {number} seqId
   * @param {string} [clientId]
   */
  acknowledge(seqId, clientId = null) {
    if (clientId) {
      const current = this.clientAcks.get(clientId) || 0;
      if (seqId > current) {
        this.clientAcks.set(clientId, seqId);
      }
    }
    this.lastAcked = Math.max(this.lastAcked, seqId);
    this.unacked.delete(seqId);
    return true;
  }

  ack(seqId, clientId = null) {
    return this.acknowledge(seqId, clientId);
  }

  getUnacked(sinceSeq = 0) {
    const list = [];
    for (const msg of this.unacked.values()) {
      if (msg.seqId > sinceSeq && msg.seqId > this.lastAcked) {
        list.push(msg);
      }
    }
    return list;
  }

  /**
   * Replay messages from sliding buffer since a given sequence ID.
   * @param {number} sinceSeq
   * @returns {Array<object>}
   */
  replaySince(sinceSeq = 0) {
    return this.buffer.filter((m) => m.seqId > sinceSeq);
  }

  /**
   * Add a subscriber client to this channel.
   * @param {any} client
   */
  subscribe(client) {
    this.subscribers.add(client);
  }

  /**
   * Remove a subscriber client.
   * @param {any} client
   */
  unsubscribe(client) {
    this.subscribers.delete(client);
    if (client && client.id) {
      this.clientAcks.delete(client.id);
    }
  }

  /**
   * Close this channel.
   */
  close() {
    this.status = "ended";
    this.updatedAt = Date.now();
  }
}

/**
 * Manages active wire channels keyed by session.
 */
export class WireSessionManager {
  constructor(options = {}) {
    this.channels = new Map();
    this.options = options;
  }

  getOrCreateChannel(channelId) {
    const id = String(channelId || "default").trim();
    if (!this.channels.has(id)) {
      this.channels.set(id, new WireChannel(id, this.options));
    }
    return this.channels.get(id);
  }

  getChannel(channelId) {
    return this.channels.get(String(channelId || "").trim()) || null;
  }

  deleteChannel(channelId) {
    this.channels.delete(String(channelId || "").trim());
  }
}

/**
 * Wire-AXI Client SDK for CLI and tests.
 * Connects over WebSocket, runs handshake, and executes atomic single-turn wait.
 */
export class WireClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.role = options.role || "agent";
    this.name = options.client || "lavish-cli";
    this.sessionKey = options.sessionKey || null;
    this.wsUrl =
      options.url ||
      (options.serverUrl
        ? options.serverUrl.replace(/^http/, "ws") + "/wire/" + encodeURIComponent(options.sessionKey || "")
        : null);
    this.ws = null;
    this.isConnected = false;
    this.currentChannel = options.sessionKey || null;
    this.lastSeq = 0;
    this.pendingAcks = new Map();
    this.messageQueue = [];
    this.waitResolver = null;
    this.on("error", () => {});
  }

  /**
   * Connect to server and perform OPEN handshake.
   * @param {string} [channel]
   * @param {object} [opts]
   * @param {number} [opts.lastSeenSeq=0]
   * @param {number} [opts.timeoutMs=5000]
   * @returns {Promise<boolean>}
   */
  async connect(channel = this.sessionKey || "default", { lastSeenSeq = 0, timeoutMs = 5000 } = {}) {
    this.currentChannel = channel;
    const WebSocketCtor = this.options.WebSocket || globalThis.WebSocket;
    if (!WebSocketCtor) {
      throw new Error("WebSocket constructor is not available in this environment");
    }

    if (!this.wsUrl) {
      throw new Error("WireClient requires a target WebSocket url");
    }

    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            this.ws?.close();
          } catch {
            // ignore
          }
          reject(new Error(`WebSocket connection timed out to ${this.wsUrl}`));
        }
      }, timeoutMs);

      try {
        this.ws = new WebSocketCtor(this.wsUrl);
      } catch (err) {
        clearTimeout(timer);
        settled = true;
        reject(err);
        return;
      }

      this.ws.onopen = () => {
        if (settled) return;
        this.isConnected = true;
        clearTimeout(timer);
        settled = true;
        resolve(undefined);
      };

      this.ws.onmessage = (event) => {
        const text = typeof event.data === "string" ? event.data : String(event.data || "");
        this._processIncomingLine(text);
      };

      this.ws.onerror = (err) => {
        if (!settled) {
          clearTimeout(timer);
          settled = true;
          reject(err instanceof Error ? err : new Error("WebSocket error during connection"));
        } else {
          this.emit("error", err);
        }
      };

      this.ws.onclose = () => {
        this.isConnected = false;
        this.emit("close");
      };
    });

    // Handshake over WebSocket
    await new Promise((resolve, reject) => {
      const handshakeTimer = setTimeout(() => {
        this.removeListener("frame", onHandshake);
        reject(new Error("Wire handshake timed out"));
      }, timeoutMs);

      const onHandshake = (frame) => {
        if (frame.type === OPCODES.OPEN) {
          clearTimeout(handshakeTimer);
          this.removeListener("frame", onHandshake);
          const params = parseParams(frame.payload);
          this.lastSeq = frame.seqId;
          resolve({
            session: frame.channel,
            lastSeq: frame.seqId,
            params,
          });
        }
      };

      this.on("frame", onHandshake);

      const openFrame = encodeFrame({
        type: OPCODES.OPEN,
        seqId: lastSeenSeq,
        channel,
        flags: FLAGS.NONE,
        payload: formatParams({
          session: channel,
          role: this.role,
          client: this.name,
          last_seen_seq: lastSeenSeq,
        }),
      });

      this._rawSend(openFrame);
    });

    return true;
  }

  _rawSend(line) {
    if (!this.isConnected || !this.ws || this.ws.readyState !== 1 /* OPEN */) {
      throw new Error("WireClient is not connected");
    }
    this.ws.send(line);
  }

  _processIncomingLine(line) {
    let frame;
    try {
      frame = decodeFrame(line);
    } catch (err) {
      this.emit("error", err);
      return;
    }

    this.emit("frame", frame);

    if (frame.type === OPCODES.ACK) {
      const pending = this.pendingAcks.get(frame.seqId);
      if (pending) {
        pending.resolve(frame);
        this.pendingAcks.delete(frame.seqId);
      }
    } else if (frame.type === OPCODES.MESSAGE || frame.type === OPCODES.PUSH) {
      this.lastSeq = Math.max(this.lastSeq, frame.seqId);
      let handled = false;
      if (this.waitResolver) {
        handled = this.waitResolver(frame);
      }
      if (!handled) {
        this.messageQueue.push(frame);
      }
      this.emit("message", frame);
    } else if (frame.type === OPCODES.CLOSE || frame.type === OPCODES.END) {
      let handled = false;
      if (this.waitResolver) {
        handled = this.waitResolver(frame);
      }
      if (!handled) {
        this.messageQueue.push(frame);
      }
      this.emit("close_frame", frame);
    }
  }

  /**
   * Dispatch a message to channel.
   * @param {object} param0
   * @param {string} [param0.channel]
   * @param {string} param0.payload
   * @param {string} [param0.flags='R']
   * @returns {Promise<{ seqId: number, seq: number }>}
   */
  send({ channel, payload, flags = "R" }) {
    const ch = channel || this.currentChannel;
    return new Promise((resolve, reject) => {
      const frameStr = encodeFrame({
        type: OPCODES.MESSAGE,
        seqId: 0,
        channel: ch,
        flags,
        payload,
      });

      const ackListener = (frame) => {
        if (frame.type === OPCODES.ACK && (frame.channel === ch || frame.channel === "agent-reply")) {
          this.removeListener("frame", ackListener);
          resolve({ seqId: frame.seqId, seq: frame.seqId });
        }
      };

      this.on("frame", ackListener);
      try {
        this._rawSend(frameStr);
      } catch (err) {
        this.removeListener("frame", ackListener);
        reject(err);
      }
    });
  }

  /**
   * Send explicit sequence acknowledgement.
   * @param {string} channel
   * @param {number} seqId
   */
  ack(channel, seqId) {
    const frame = encodeFrame({
      type: OPCODES.ACK,
      seqId,
      channel: channel || this.currentChannel,
      flags: FLAGS.NONE,
    });
    this._rawSend(frame);
  }

  /**
   * Atomic single-turn execution:
   * 1. If ackSeq provided, transmits explicit ACK.
   * 2. If reply is provided, dispatches reply message.
   * 3. Blocks until next event arrives on channel.
   *
   * @param {object} param0
   * @param {string} [param0.channel]
   * @param {string} [param0.reply]
   * @param {number} [param0.ackSeq]
   * @param {number} [param0.timeoutMs]
   * @returns {Promise<object>} Received event frame
   */
  async wait({ channel, reply, ackSeq, timeoutMs } = {}) {
    const ch = channel || this.currentChannel;
    if (!this.isConnected) {
      await this.connect(ch);
    }

    if (ackSeq !== undefined && ackSeq !== null) {
      this.ack(ch, ackSeq);
    }

    if (reply) {
      await this.send({
        channel: ch,
        payload: reply,
        flags: FLAGS.REQUIRES_ACK,
      });
    }

    const isMatch = (f) => f.channel === ch || f.channel === "feedback" || f.channel === "session";

    const queuedIdx = this.messageQueue.findIndex(isMatch);
    if (queuedIdx !== -1) {
      const [frame] = this.messageQueue.splice(queuedIdx, 1);
      if (frame.flagSet?.has(FLAGS.REQUIRES_ACK) || frame.flags?.includes?.("R")) {
        this.ack(ch, frame.seqId);
      }
      return frame;
    }

    return new Promise((resolve) => {
      let timer = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.waitResolver = null;
        this.removeListener("close", onClose);
      };

      const onClose = () => {
        cleanup();
        resolve({
          type: OPCODES.CLOSE,
          seqId: this.lastSeq,
          channel: ch,
          flags: new Set([FLAGS.END_SESSION]),
          rawFlags: FLAGS.END_SESSION,
          payload: JSON.stringify({ status: "ended", ended_by: "server" }),
        });
      };

      this.waitResolver = (frame) => {
        if (isMatch(frame)) {
          cleanup();
          if (frame.flagSet?.has(FLAGS.REQUIRES_ACK) || frame.flags?.includes?.("R")) {
            this.ack(ch, frame.seqId);
          }
          resolve(frame);
          return true;
        }
        return false;
      };

      if (typeof timeoutMs === "number" && timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup();
          resolve({
            type: "TIMEOUT",
            seqId: this.lastSeq,
            channel: ch,
            flags: new Set(),
            rawFlags: "-",
            payload: JSON.stringify({ status: "waiting" }),
          });
        }, timeoutMs);
      }

      this.once("close", onClose);
    });
  }

  async waitForFeedback({ timeoutMs = this.options.timeoutMs || 5000 } = {}) {
    const frame = await this.wait({ timeoutMs });
    if (!frame || frame.type === "TIMEOUT") return null;
    let payloadData;
    try {
      payloadData = JSON.parse(frame.payload);
    } catch {
      payloadData = { prompts: [{ prompt: frame.payload, tag: "message" }] };
    }
    return {
      status: payloadData.status || "feedback",
      prompts: payloadData.prompts || [],
      seq: frame.seqId ?? frame.seq,
      raw: payloadData,
    };
  }

  async sendReply(text) {
    return this.send({
      channel: this.currentChannel,
      payload: text,
      flags: FLAGS.REQUIRES_ACK,
    });
  }

  close() {
    this.disconnect();
  }

  /**
   * Disconnect the client.
   */
  async disconnect() {
    this.isConnected = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}
