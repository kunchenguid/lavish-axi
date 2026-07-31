import crypto from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, writeSync } from "node:fs";
import { chmod, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

export const EVENT_SCHEMA = "multiplexed.event/1";
export const STREAM_SCHEMA = "multiplexed.stream/1";

export const DEFAULT_MAX_PAYLOAD_BYTES = 1 * 1024 * 1024;
export const DEFAULT_MAX_UNACKED_PER_STREAM = 256;
export const DEFAULT_MAX_UNACKED_PER_CONSUMER = 4096;
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_LEASE_TTL_MS = 60_000;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * @param {() => number} [now]
 * @param {() => Uint8Array} [randomBytes]
 */
export function createUlidGenerator(now = () => Date.now(), randomBytes = () => crypto.randomBytes(10)) {
  let lastTime = -1;
  /** @type {Uint8Array | null} */
  let lastRand = null;
  return function nextUlid() {
    const time = now();
    let rand;
    if (time === lastTime && lastRand) {
      rand = Uint8Array.from(lastRand);
      for (let i = rand.length - 1; i >= 0; i -= 1) {
        rand[i] = (rand[i] + 1) & 0xff;
        if (rand[i] !== 0) break;
      }
    } else {
      const bytes = randomBytes();
      rand = new Uint8Array(10);
      rand.set(bytes.subarray(0, 10));
    }
    lastTime = time;
    lastRand = Uint8Array.from(rand);
    return encodeUlid(time, lastRand);
  };
}

/** @param {number} timeMs @param {Uint8Array} rand10 */
export function encodeUlid(timeMs, rand10) {
  const chars = new Array(26);
  let t = Math.max(0, Math.floor(timeMs));
  for (let i = 9; i >= 0; i -= 1) {
    chars[i] = CROCKFORD[t & 31];
    t = Math.floor(t / 32);
  }
  let acc = 0n;
  for (let i = 0; i < 10; i += 1) acc = (acc << 8n) | BigInt(rand10[i] ?? 0);
  for (let i = 25; i >= 10; i -= 1) {
    chars[i] = CROCKFORD[Number(acc & 31n)];
    acc >>= 5n;
  }
  return chars.join("");
}

export function consumerHash(consumerId) {
  return crypto
    .createHash("sha256")
    .update(String(consumerId || ""))
    .digest("hex")
    .slice(0, 16);
}

export function isValidConsumerId(value) {
  const id = String(value || "");
  return id.length >= 8 && id.length <= 128 && /^[A-Za-z0-9_-]+$/.test(id);
}

export function isValidStreamKey(value) {
  const key = String(value || "");
  return key.length >= 1 && key.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(key);
}

export function splitCompleteLines(raw) {
  const text = String(raw || "");
  if (!text) return { lines: /** @type {string[]} */ ([]), tornTail: false };
  const endsWithNewline = text.endsWith("\n");
  const parts = text.split("\n");
  if (endsWithNewline) {
    if (parts[parts.length - 1] === "") parts.pop();
    return { lines: parts, tornTail: false };
  }
  const torn = parts.pop() || "";
  return { lines: parts, tornTail: torn.length > 0 };
}

export async function appendFileDurable(file, data) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = openSync(file, "a", 0o600);
  try {
    const buf = Buffer.from(data, "utf8");
    let offset = 0;
    while (offset < buf.length) offset += writeSync(fd, buf, offset, buf.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export async function atomicWriteText(file, text) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    const buf = Buffer.from(text, "utf8");
    let offset = 0;
    while (offset < buf.length) offset += writeSync(fd, buf, offset, buf.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  try {
    const dfd = openSync(path.dirname(file), "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // best effort
  }
  try {
    await chmod(file, 0o600);
  } catch {
    // ignore
  }
}

export async function atomicWriteJson(file, value) {
  await atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function readTextOrEmpty(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error && /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return "";
    throw error;
  }
}

async function chmodSafe(file, mode) {
  try {
    await chmod(file, mode);
  } catch {
    // ignore
  }
}

/**
 * Durable per-consumer event log. Domain-neutral: no review/artifact vocabulary.
 */
export class ConsumerEventLog {
  /**
   * @param {string} rootDir
   * @param {{
   *   consumerId: string,
   *   maxPayloadBytes?: number,
   *   now?: () => number,
   *   nextEventId?: () => string,
   * }} options
   */
  constructor(rootDir, options) {
    this.rootDir = rootDir;
    this.consumerId = options.consumerId;
    this.consumerKey = consumerHash(options.consumerId);
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.now = options.now ?? (() => Date.now());
    this.nextEventId = options.nextEventId ?? createUlidGenerator(this.now);
    this.eventsPath = path.join(rootDir, "events.jsonl");
    this.acksPath = path.join(rootDir, "acks.jsonl");
    this.metaPath = path.join(rootDir, "consumer.json");
    this.spillDir = path.join(rootDir, "spill");
    this.heldPath = path.join(rootDir, "held.jsonl");
    /** @type {Map<string, object>} */
    this.eventsById = new Map();
    /** @type {object[]} */
    this.unacked = [];
    /** @type {object[]} held volume not yet in the deliverable log */
    this.held = [];
    /** @type {Set<string>} */
    this.ackedIds = new Set();
    /** @type {Set<string>} idempotency keys already published */
    this.idempotencyKeys = new Set();
    this.nextLogPosition = 1;
    this.loaded = false;
  }

  async ensureLoaded() {
    if (this.loaded) return;
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await mkdir(this.spillDir, { recursive: true, mode: 0o700 });
    try {
      await stat(this.metaPath);
    } catch (error) {
      if (error && /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
        await atomicWriteJson(this.metaPath, {
          consumer_id: this.consumerId,
          consumer_key: this.consumerKey,
          created_at: new Date(this.now()).toISOString(),
        });
      } else throw error;
    }
    await chmodSafe(this.metaPath, 0o600);
    await this.#loadAcks();
    await this.#loadEvents();
    await this.#loadHeld();
    await this.compactIfNeeded();
    this.loaded = true;
  }

  async #loadAcks() {
    const raw = await readTextOrEmpty(this.acksPath);
    for (const line of splitCompleteLines(raw).lines) {
      try {
        const parsed = JSON.parse(line);
        const id = String(parsed.event_id || "");
        if (id) this.ackedIds.add(id);
      } catch {
        // ignore
      }
    }
  }

  async #loadEvents() {
    const raw = await readTextOrEmpty(this.eventsPath);
    const { lines, tornTail } = splitCompleteLines(raw);
    if (tornTail) await atomicWriteText(this.eventsPath, lines.length ? `${lines.join("\n")}\n` : "");
    let maxPos = 0;
    /** @type {object[]} */
    const kept = [];
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!event?.event_id) continue;
      const pos = Number(event.log_position) || 0;
      if (pos > maxPos) maxPos = pos;
      if (event.idempotency_key) this.idempotencyKeys.add(String(event.idempotency_key));
      if (this.ackedIds.has(event.event_id)) continue;
      this.eventsById.set(event.event_id, event);
      kept.push(event);
    }
    kept.sort((a, b) => (a.log_position || 0) - (b.log_position || 0));
    this.unacked = kept;
    this.nextLogPosition = maxPos + 1;
  }

  async #loadHeld() {
    const raw = await readTextOrEmpty(this.heldPath);
    const { lines, tornTail } = splitCompleteLines(raw);
    if (tornTail) await atomicWriteText(this.heldPath, lines.length ? `${lines.join("\n")}\n` : "");
    /** @type {object[]} */
    const held = [];
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item?.held_id) {
          held.push(item);
          if (item.idempotency_key) this.idempotencyKeys.add(String(item.idempotency_key));
        }
      } catch {
        // ignore
      }
    }
    this.held = held;
  }

  unackedCount() {
    return this.unacked.length;
  }

  unackedCountForStream(streamKey) {
    const key = String(streamKey || "");
    let n = 0;
    for (const event of this.unacked) if (event.stream_key === key) n += 1;
    return n;
  }

  heldCountForStream(streamKey) {
    const key = String(streamKey || "");
    let n = 0;
    for (const item of this.held) if (item.stream_key === key) n += 1;
    return n;
  }

  pendingCountForStream(streamKey) {
    return this.unackedCountForStream(streamKey) + this.heldCountForStream(streamKey);
  }

  /**
   * Append directly to the deliverable log (caller enforces bounds).
   * @param {{
   *   stream_key: string,
   *   generation: number,
   *   type: string,
   *   payload?: object,
   *   end_state?: string | null,
   *   idempotency_key?: string,
   *   created_at?: string,
   *   attributes?: object,
   * }} input
   */
  async appendDeliverable(input) {
    await this.ensureLoaded();
    if (input.idempotency_key && this.idempotencyKeys.has(String(input.idempotency_key))) {
      const existing =
        this.unacked.find((e) => e.idempotency_key === input.idempotency_key) ||
        [...this.eventsById.values()].find((e) => e.idempotency_key === input.idempotency_key);
      return { status: "duplicate", event: existing || null };
    }

    const createdAt = input.created_at || new Date(this.now()).toISOString();
    const eventId = this.nextEventId();
    const logPosition = this.nextLogPosition;
    this.nextLogPosition += 1;

    let type = String(input.type || "");
    let payload = input.payload && typeof input.payload === "object" ? input.payload : {};
    const endState = input.end_state === undefined ? null : input.end_state;
    const payloadJson = JSON.stringify(payload);
    const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
    if (payloadBytes > this.maxPayloadBytes) {
      const spillPath = path.join(this.spillDir, `${eventId}.json`);
      await atomicWriteText(spillPath, payloadJson);
      await chmodSafe(spillPath, 0o600);
      payload = {
        truncated: true,
        original_type: type,
        original_bytes: payloadBytes,
        spill_path: spillPath,
      };
      type = "oversize";
    }

    const event = {
      schema: EVENT_SCHEMA,
      event_id: eventId,
      log_position: logPosition,
      stream_key: String(input.stream_key || ""),
      consumer_id: this.consumerId,
      generation: Number(input.generation) || 0,
      type,
      created_at: createdAt,
      payload,
      end_state: endState,
      ...(input.idempotency_key ? { idempotency_key: String(input.idempotency_key) } : {}),
      ...(input.attributes && typeof input.attributes === "object" ? { attributes: input.attributes } : {}),
    };

    await appendFileDurable(this.eventsPath, `${JSON.stringify(event)}\n`);
    await chmodSafe(this.eventsPath, 0o600);
    this.eventsById.set(eventId, event);
    this.unacked.push(event);
    if (event.idempotency_key) this.idempotencyKeys.add(String(event.idempotency_key));
    return { status: "appended", event };
  }

  /**
   * Hold volume outside the deliverable log while pressured.
   * @param {{
   *   stream_key: string,
   *   generation: number,
   *   type: string,
   *   payload?: object,
   *   end_state?: string | null,
   *   idempotency_key?: string,
   *   attributes?: object,
   * }} input
   */
  async hold(input) {
    await this.ensureLoaded();
    if (input.idempotency_key && this.idempotencyKeys.has(String(input.idempotency_key))) {
      return { status: "duplicate" };
    }
    const item = {
      held_id: this.nextEventId(),
      stream_key: String(input.stream_key || ""),
      generation: Number(input.generation) || 0,
      type: String(input.type || ""),
      payload: input.payload && typeof input.payload === "object" ? input.payload : {},
      end_state: input.end_state === undefined ? null : input.end_state,
      created_at: new Date(this.now()).toISOString(),
      ...(input.idempotency_key ? { idempotency_key: String(input.idempotency_key) } : {}),
      ...(input.attributes && typeof input.attributes === "object" ? { attributes: input.attributes } : {}),
    };
    await appendFileDurable(this.heldPath, `${JSON.stringify(item)}\n`);
    await chmodSafe(this.heldPath, 0o600);
    this.held.push(item);
    if (item.idempotency_key) this.idempotencyKeys.add(String(item.idempotency_key));
    return { status: "held", held: item };
  }

  /**
   * Drain held items into the deliverable log while under the given bounds.
   * Control/terminal types always drain first in held order.
   * @param {{ maxUnackedPerStream: number, maxUnackedPerConsumer: number }} bounds
   */
  async drainHeld(bounds) {
    await this.ensureLoaded();
    /** @type {object[]} */
    const remaining = [];
    /** @type {object[]} */
    const drained = [];
    for (const item of this.held) {
      const streamCount = this.unackedCountForStream(item.stream_key);
      const consumerCount = this.unackedCount();
      const isControl =
        item.type === "backpressure" ||
        item.type === "retention_overflow" ||
        item.type === "oversize" ||
        item.end_state != null;
      const streamFull = streamCount >= bounds.maxUnackedPerStream;
      const consumerFull = consumerCount >= bounds.maxUnackedPerConsumer;
      if (!isControl && (streamFull || consumerFull)) {
        remaining.push(item);
        continue;
      }
      const result = await this.appendDeliverable({
        stream_key: item.stream_key,
        generation: item.generation,
        type: item.type,
        payload: item.payload,
        end_state: item.end_state,
        idempotency_key: item.idempotency_key,
        attributes: item.attributes,
        created_at: item.created_at,
      });
      if (result.event) drained.push(result.event);
    }
    if (remaining.length !== this.held.length) {
      this.held = remaining;
      const body = remaining.map((item) => JSON.stringify(item)).join("\n");
      await atomicWriteText(this.heldPath, body ? `${body}\n` : "");
    }
    return drained;
  }

  /** @param {string[]} eventIds */
  async acknowledge(eventIds) {
    await this.ensureLoaded();
    const ids = Array.isArray(eventIds) ? eventIds.map(String) : [];
    /** @type {{ event_id: string, status: "acked" | "already_acked" | "unknown" }[]} */
    const results = [];
    /** @type {string[]} */
    const newly = [];
    for (const id of ids) {
      if (!id) {
        results.push({ event_id: id, status: "unknown" });
        continue;
      }
      if (this.ackedIds.has(id)) {
        results.push({ event_id: id, status: "already_acked" });
        continue;
      }
      if (!this.eventsById.has(id)) {
        results.push({ event_id: id, status: "unknown" });
        continue;
      }
      this.ackedIds.add(id);
      newly.push(id);
      results.push({ event_id: id, status: "acked" });
    }
    if (newly.length > 0) {
      const lines =
        newly.map((id) => JSON.stringify({ event_id: id, at: new Date(this.now()).toISOString() })).join("\n") + "\n";
      await appendFileDurable(this.acksPath, lines);
      await chmodSafe(this.acksPath, 0o600);
      const drop = new Set(newly);
      this.unacked = this.unacked.filter((event) => !drop.has(event.event_id));
      for (const id of newly) {
        const event = this.eventsById.get(id);
        this.eventsById.delete(id);
        if (event?.type === "oversize" && event.payload?.spill_path) {
          await rm(String(event.payload.spill_path), { force: true }).catch(() => {});
        }
      }
      await this.compactIfNeeded({ force: newly.length >= 32 || this.ackedIds.size >= 256 });
    }
    return results;
  }

  listUnacked() {
    return this.unacked.slice();
  }

  listRetentionCandidates(retentionMs) {
    const cutoff = this.now() - retentionMs;
    return this.unacked.filter((event) => {
      const t = Date.parse(event.created_at || "");
      return Number.isFinite(t) && t < cutoff;
    });
  }

  /** @param {string[]} eventIds */
  async forceDrop(eventIds) {
    await this.ensureLoaded();
    const drop = new Set((eventIds || []).map(String));
    if (drop.size === 0) return;
    for (const id of drop) {
      this.ackedIds.add(id);
      const event = this.eventsById.get(id);
      this.eventsById.delete(id);
      if (event?.type === "oversize" && event.payload?.spill_path) {
        await rm(String(event.payload.spill_path), { force: true }).catch(() => {});
      }
    }
    this.unacked = this.unacked.filter((event) => !drop.has(event.event_id));
    const lines =
      [...drop]
        .map((id) => JSON.stringify({ event_id: id, at: new Date(this.now()).toISOString(), reason: "retention" }))
        .join("\n") + "\n";
    await appendFileDurable(this.acksPath, lines);
    await this.compactIfNeeded({ force: true });
  }

  async compactIfNeeded({ force = false } = {}) {
    if (!force && this.ackedIds.size < 64) return;
    const body = this.unacked.map((event) => JSON.stringify(event)).join("\n");
    await atomicWriteText(this.eventsPath, body ? `${body}\n` : "");
    await atomicWriteText(this.acksPath, "");
    if (this.ackedIds.size > 10_000) this.ackedIds.clear();
  }
}
