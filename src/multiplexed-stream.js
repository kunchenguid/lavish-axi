import crypto from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ConsumerEventLog,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_MAX_UNACKED_PER_CONSUMER,
  DEFAULT_MAX_UNACKED_PER_STREAM,
  DEFAULT_RETENTION_MS,
  STREAM_SCHEMA,
  atomicWriteJson,
  atomicWriteText,
  consumerHash,
  isValidConsumerId,
  isValidStreamKey,
} from "./multiplexed-stream-log.js";

export {
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_MAX_UNACKED_PER_CONSUMER,
  DEFAULT_MAX_UNACKED_PER_STREAM,
  DEFAULT_RETENTION_MS,
  STREAM_SCHEMA,
  consumerHash,
  isValidConsumerId,
  isValidStreamKey,
  atomicWriteText,
  atomicWriteJson,
};

export const MULTIPLEXED_STREAM_PROTOCOL = Object.freeze({
  version: 1,
  min_client: 1,
  max_client: 1,
});

export function createCapabilitiesProtocolBlock() {
  return { event_stream: { ...MULTIPLEXED_STREAM_PROTOCOL } };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
/** @returns {{ maxPayloadBytes: number, maxUnackedPerStream: number, maxUnackedPerReview?: number, maxUnackedPerConsumer: number, retentionMs: number, leaseTtlMs: number }} */
export function resolveStreamBounds(env = process.env) {
  const perStream = positiveInt(
    env.LAVISH_AXI_EVENT_MAX_UNACKED_STREAM || env.LAVISH_AXI_EVENT_MAX_UNACKED_REVIEW,
    DEFAULT_MAX_UNACKED_PER_STREAM,
  );
  return {
    maxPayloadBytes: positiveInt(env.LAVISH_AXI_EVENT_MAX_PAYLOAD_BYTES, DEFAULT_MAX_PAYLOAD_BYTES),
    maxUnackedPerStream: perStream,
    maxUnackedPerReview: perStream,
    maxUnackedPerConsumer: positiveInt(
      env.LAVISH_AXI_EVENT_MAX_UNACKED_HOME || env.LAVISH_AXI_EVENT_MAX_UNACKED_CONSUMER,
      DEFAULT_MAX_UNACKED_PER_CONSUMER,
    ),
    retentionMs: positiveInt(env.LAVISH_AXI_EVENT_RETENTION_MS, DEFAULT_RETENTION_MS),
    leaseTtlMs: positiveInt(env.LAVISH_AXI_EVENT_LEASE_TTL_MS, DEFAULT_LEASE_TTL_MS),
  };
}

function positiveInt(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/**
 * Mint a consumer capability file at mode 0600. Never prints the token.
 * Domain-neutral: consumer_id + optional root for containment checks by adapters.
 */
export async function initConsumerCapability({ root, file = undefined, prefix = "cid" }) {
  const consumerRoot = path.resolve(root);
  try {
    const st = await stat(consumerRoot);
    if (!st.isDirectory()) return { error: "consumer_root_not_directory", consumer_root: consumerRoot };
  } catch {
    return { error: "consumer_root_missing", consumer_root: consumerRoot };
  }
  const target = file ? path.resolve(file) : path.join(consumerRoot, ".multiplexed-consumer.json");
  try {
    await stat(target);
    return { error: "consumer_file_exists", file: target, consumer_root: consumerRoot };
  } catch {
    // create
  }
  const consumerId = `${prefix}_${crypto.randomBytes(24).toString("base64url")}`;
  const payload = {
    version: 1,
    consumer_id: consumerId,
    consumer_root: consumerRoot,
    created_at: new Date().toISOString(),
  };
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmod(target, 0o600);
  } catch {
    // ignore
  }
  return { status: "created", file: target, consumer_root: consumerRoot };
}

/** Lavish-facing alias that writes the same shape with home_* field names for Firstmate. */
export async function initHomeCapability({ root, file = undefined }) {
  const result = await initConsumerCapability({
    root,
    file: file || path.join(path.resolve(root), ".lavish-home.json"),
    prefix: "fmh",
  });
  if (result.error) {
    return {
      error: result.error.replace("consumer_", "home_"),
      file: result.file,
      home_root: result.consumer_root,
    };
  }
  // Rewrite file with home_* keys for Firstmate compatibility.
  const raw = JSON.parse(await readFile(result.file, "utf8"));
  await writeFile(
    result.file,
    `${JSON.stringify(
      {
        version: 1,
        home_id: raw.consumer_id,
        home_root: raw.consumer_root,
        created_at: raw.created_at,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  try {
    await chmod(result.file, 0o600);
  } catch {
    // ignore
  }
  return { status: "created", file: result.file, home_root: result.consumer_root };
}

export async function readConsumerCapabilityFile(file) {
  const absolute = path.resolve(file);
  let st;
  try {
    st = await stat(absolute);
  } catch {
    return { error: "consumer_file_missing", file: absolute };
  }
  if (!st.isFile()) return { error: "consumer_file_missing", file: absolute };
  const mode = st.mode & 0o777;
  if (mode & 0o077) {
    return {
      error: "consumer_file_insecure_permissions",
      file: absolute,
      mode: mode.toString(8).padStart(3, "0"),
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(absolute, "utf8"));
  } catch {
    return { error: "consumer_file_invalid", file: absolute };
  }
  // Accept both domain-neutral and Lavish home_* aliases.
  const consumerId = String(parsed?.consumer_id || parsed?.home_id || "");
  const consumerRoot = String(parsed?.consumer_root || parsed?.home_root || "");
  if (!isValidConsumerId(consumerId)) return { error: "consumer_file_invalid", file: absolute };
  return {
    consumer_id: consumerId,
    consumer_root: consumerRoot ? path.resolve(consumerRoot) : "",
    home_id: consumerId,
    home_root: consumerRoot ? path.resolve(consumerRoot) : "",
    file: absolute,
  };
}

export const readHomeCapabilityFile = readConsumerCapabilityFile;

/**
 * Domain-neutral multiplexed event stream foundation.
 *
 * Vocabulary: consumer, stream_key, generation, lease, event.
 * No knowledge of reviews, artifacts, prompts, or Lavish sessions.
 */
export class MultiplexedEventStream {
  /**
   * @param {{
   *   stateDir: string,
   *   bounds?: ReturnType<typeof resolveStreamBounds>,
   *   now?: () => number,
   *   log?: ((line: string) => void) | null,
   * }} options
   */
  constructor({ stateDir, bounds = resolveStreamBounds(), now = () => Date.now(), log = null }) {
    this.stateDir = stateDir;
    this.bounds = {
      maxPayloadBytes: bounds.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
      maxUnackedPerStream: bounds.maxUnackedPerStream ?? bounds.maxUnackedPerReview ?? DEFAULT_MAX_UNACKED_PER_STREAM,
      maxUnackedPerConsumer: bounds.maxUnackedPerConsumer ?? DEFAULT_MAX_UNACKED_PER_CONSUMER,
      retentionMs: bounds.retentionMs ?? DEFAULT_RETENTION_MS,
      leaseTtlMs: bounds.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
    };
    this.now = now;
    this.log = log;
    this.stateFile = path.join(stateDir, "multiplexed-stream.json");
    this.eventsRoot = path.join(stateDir, "events");
    /** @type {Map<string, ConsumerEventLog>} */
    this.logs = new Map();
    /** @type {Map<string, ActiveSubscription>} */
    this.subscriptions = new Map();
    /** @type {Map<string, { stream: boolean, consumer: boolean, streams: Set<string> }>} */
    this.pressure = new Map();
    /** @type {Promise<unknown>} */
    this.queue = Promise.resolve();
    /** @type {Map<string, Promise<unknown>>} */
    this.consumerAdmission = new Map();
    this.ready = this.#init();
  }

  async #init() {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await mkdir(this.eventsRoot, { recursive: true, mode: 0o700 });
    try {
      await stat(this.stateFile);
    } catch (error) {
      if (error && /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
        await atomicWriteJson(this.stateFile, { schema_version: 1, consumers: {}, claims: {} });
      } else throw error;
    }
  }

  /**
   * @template T
   * @param {() => Promise<T>} op
   * @returns {Promise<T>}
   */
  runExclusive(op) {
    const result = this.queue.then(op);
    this.queue = result.catch(() => {});
    return result;
  }

  /**
   * Serialize admission for one consumer.
   * @template T
   * @param {string} consumerKey
   * @param {() => Promise<T>} op
   */
  runConsumerAdmission(consumerKey, op) {
    const prev = this.consumerAdmission.get(consumerKey) || Promise.resolve();
    const next = prev.then(op, op);
    this.consumerAdmission.set(
      consumerKey,
      next.then(
        () => {},
        () => {},
      ),
    );
    return next;
  }

  activeSubscriptionCount() {
    return this.subscriptions.size;
  }

  async #readState() {
    await this.ready;
    try {
      const raw = await readFile(this.stateFile, "utf8");
      const parsed = JSON.parse(raw);
      return {
        schema_version: Number(parsed.schema_version) || 1,
        consumers: parsed.consumers && typeof parsed.consumers === "object" ? parsed.consumers : {},
        claims: parsed.claims && typeof parsed.claims === "object" ? parsed.claims : {},
      };
    } catch (error) {
      if (error && /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
        return { schema_version: 1, consumers: {}, claims: {} };
      }
      throw error;
    }
  }

  async #writeState(state) {
    await atomicWriteJson(this.stateFile, {
      schema_version: 1,
      consumers: state.consumers || {},
      claims: state.claims || {},
    });
  }

  /** @param {string} consumerId */
  async #logFor(consumerId) {
    const key = consumerHash(consumerId);
    let log = this.logs.get(key);
    if (!log) {
      log = new ConsumerEventLog(path.join(this.eventsRoot, key), {
        consumerId,
        maxPayloadBytes: this.bounds.maxPayloadBytes,
        now: this.now,
      });
      this.logs.set(key, log);
    }
    await log.ensureLoaded();
    return log;
  }

  async ensureConsumer(consumerId, { consumerRoot = "" } = {}) {
    if (!isValidConsumerId(consumerId)) return { error: "invalid_consumer" };
    return this.runExclusive(async () => {
      const state = await this.#readState();
      const key = consumerHash(consumerId);
      const existing = state.consumers[key] || {};
      state.consumers[key] = {
        generation: Number(existing.generation) || 0,
        lease_expires_at: Number(existing.lease_expires_at) || 0,
        consumer_root: consumerRoot || existing.consumer_root || "",
        created_at: existing.created_at || new Date(this.now()).toISOString(),
        updated_at: new Date(this.now()).toISOString(),
      };
      await this.#writeState(state);
      await this.#logFor(consumerId);
      return { consumer_key: key, consumer_id: consumerId };
    });
  }

  /**
   * Atomic claim: validation + ownership/lease/inode mutation in one exclusive section.
   * @param {string} consumerId
   * @param {number} generation
   * @param {string} streamKey
   * @param {{
   *   consumerRoot?: string,
   *   attributes?: object,
   *   inode?: { dev: string, ino: string } | null,
   *   pathInsideRoot?: (attrs: object, root: string) => boolean | Promise<boolean>,
   * }} [options]
   */
  async claim(consumerId, generation, streamKey, options = {}) {
    if (!isValidConsumerId(consumerId)) return { error: "invalid_consumer" };
    if (!isValidStreamKey(streamKey)) return { error: "invalid_stream_key" };
    const gen = normalizeGeneration(generation);
    if (gen === null) return { error: "invalid_generation" };

    return this.runExclusive(async () => {
      const state = await this.#readState();
      const key = consumerHash(consumerId);
      const consumer = state.consumers[key] || {
        generation: 0,
        lease_expires_at: 0,
        consumer_root: "",
        created_at: new Date(this.now()).toISOString(),
      };
      const recorded = Number(consumer.generation) || 0;
      if (gen < recorded) return { error: "fenced", generation: recorded };
      if (gen > recorded) consumer.generation = gen;
      consumer.consumer_root = options.consumerRoot || consumer.consumer_root || "";
      consumer.updated_at = new Date(this.now()).toISOString();
      state.consumers[key] = consumer;

      const existing = state.claims[streamKey];
      if (existing && existing.consumer_key !== key) {
        const other = state.consumers[existing.consumer_key];
        const leaseLive = other && Number(other.lease_expires_at || 0) > this.now();
        if (leaseLive) return { error: "owned_by_other_consumer" };
        const root = options.consumerRoot || consumer.consumer_root || "";
        let inside = false;
        if (root && typeof options.pathInsideRoot === "function") {
          inside = Boolean(await options.pathInsideRoot(existing.attributes || {}, root));
        }
        if (!inside) return { error: "owned_by_other_consumer" };
      }

      const inode = options.inode || null;
      if (inode?.dev && inode?.ino) {
        for (const [otherKey, claim] of Object.entries(state.claims)) {
          if (otherKey === streamKey) continue;
          if (claim.inode_dev === inode.dev && claim.inode_ino === inode.ino) {
            return {
              error: "identity_alias",
              existing_stream_key: otherKey,
              help: "This stream identity aliases an already-claimed stream.",
            };
          }
        }
      }

      const prior = existing?.consumer_key === key ? existing : null;
      state.claims[streamKey] = {
        consumer_key: key,
        claimed_at: prior?.claimed_at || new Date(this.now()).toISOString(),
        attributes: options.attributes || prior?.attributes || {},
        inode_dev: inode?.dev || prior?.inode_dev || "",
        inode_ino: inode?.ino || prior?.inode_ino || "",
        signal_state: prior?.signal_state || "ok",
      };
      await this.#writeState(state);
      await this.#logFor(consumerId);
      this.#log(`claim stream=${streamKey} consumer=${key}`);
      return {
        status: "claimed",
        stream_key: streamKey,
        generation: consumer.generation,
        existing: Boolean(prior),
        claim: { stream_key: streamKey, ...state.claims[streamKey] },
      };
    });
  }

  async retire(consumerId, generation, streamKey) {
    if (!isValidConsumerId(consumerId)) return { error: "invalid_consumer" };
    if (!isValidStreamKey(streamKey)) return { error: "invalid_stream_key" };
    const gen = normalizeGeneration(generation);
    if (gen === null) return { error: "invalid_generation" };

    // Same exclusive queue as publish/claim so pending check cannot race an append.
    return this.runExclusive(async () => {
      const state = await this.#readState();
      const key = consumerHash(consumerId);
      const consumer = state.consumers[key];
      if (!consumer) return { error: "unknown_consumer" };
      const recorded = Number(consumer.generation) || 0;
      if (gen < recorded) return { error: "fenced", generation: recorded };

      const claim = state.claims[streamKey];
      if (!claim) return { error: "not_claimed" };
      if (claim.consumer_key !== key) return { error: "owned_by_other_consumer" };

      const log = await this.#logFor(consumerId);
      const pending = log.pendingCountForStream(streamKey);
      if (pending > 0) return { error: "pending_events", pending_events: pending };

      delete state.claims[streamKey];
      await this.#writeState(state);
      this.#log(`retire stream=${streamKey} consumer=${key}`);
      return { status: "retired", stream_key: streamKey };
    });
  }

  async listClaims(consumerId) {
    if (!isValidConsumerId(consumerId)) return { error: "invalid_consumer" };
    return this.runExclusive(async () => {
      const state = await this.#readState();
      const key = consumerHash(consumerId);
      const log = await this.#logFor(consumerId);
      const streams = Object.entries(state.claims)
        .filter(([, claim]) => claim.consumer_key === key)
        .map(([stream_key, claim]) => ({
          stream_key,
          attributes: claim.attributes || {},
          claimed_at: claim.claimed_at || "",
          unacked: log.unackedCountForStream(stream_key),
          held: log.heldCountForStream(stream_key),
        }));
      return { streams };
    });
  }

  getClaim(streamKey) {
    return this.runExclusive(async () => {
      const state = await this.#readState();
      const claim = state.claims[streamKey];
      return claim ? { stream_key: streamKey, ...claim } : null;
    });
  }

  /**
   * Publish an event for a claimed stream.
   * Under pressure, volume is held outside the deliverable log; existing unacked stay deliverable.
   * Control/terminal events always enter the deliverable log.
   *
   * @param {string} streamKey
   * @param {{
   *   type: string,
   *   payload?: object,
   *   end_state?: string | null,
   *   idempotency_key?: string,
   *   attributes?: object,
   * }} event
   */
  async publish(streamKey, event) {
    if (!isValidStreamKey(streamKey)) return { error: "invalid_stream_key" };
    return this.runExclusive(async () => {
      const state = await this.#readState();
      const claim = state.claims[streamKey];
      if (!claim) return { error: "not_claimed" };
      const consumer = state.consumers[claim.consumer_key];
      if (!consumer) return { error: "unknown_consumer" };

      const consumerId = await this.#consumerIdForKey(claim.consumer_key);
      if (!consumerId) return { error: "unknown_consumer" };
      const log = await this.#logFor(consumerId);
      const generation = Number(consumer.generation) || 0;

      const type = String(event.type || "");
      const isControl =
        type === "backpressure" || type === "retention_overflow" || type === "oversize" || event.end_state != null;

      const streamCount = log.unackedCountForStream(streamKey);
      const consumerCount = log.unackedCount();
      const streamFull = streamCount >= this.bounds.maxUnackedPerStream;
      const consumerFull = consumerCount >= this.bounds.maxUnackedPerConsumer;

      if (!isControl && (streamFull || consumerFull)) {
        const held = await log.hold({
          stream_key: streamKey,
          generation,
          type,
          payload: event.payload,
          end_state: event.end_state ?? null,
          idempotency_key: event.idempotency_key,
          attributes: event.attributes,
        });
        await this.#updateBackpressure(consumerId, generation);
        await this.#deliver(consumerId);
        return { status: "held", held: held.held, reason: "backpressure" };
      }

      const result = await log.appendDeliverable({
        stream_key: streamKey,
        generation,
        type,
        payload: event.payload,
        end_state: event.end_state ?? null,
        idempotency_key: event.idempotency_key,
        attributes: event.attributes,
      });
      await this.#updateBackpressure(consumerId, generation);
      await this.#deliver(consumerId);
      this.#log(`publish stream=${streamKey} type=${type} status=${result.status}`);
      return result;
    });
  }

  /**
   * Subscribe one consumer to all its claimed streams.
   * Admission is serialized per consumer.
   */
  async subscribe(consumerId, generation, options) {
    if (!isValidConsumerId(consumerId)) return { error: "invalid_consumer" };
    const gen = normalizeGeneration(generation);
    if (gen === null) return { error: "invalid_generation" };
    const key = consumerHash(consumerId);

    return this.runConsumerAdmission(key, async () => {
      await this.ensureConsumer(consumerId, { consumerRoot: options.consumerRoot || "" });

      return this.runExclusive(async () => {
        const state = await this.#readState();
        const consumer = state.consumers[key];
        const recorded = Number(consumer?.generation || 0);
        if (gen < recorded) return { error: "fenced", generation: recorded };

        const existing = this.subscriptions.get(key);
        if (existing) {
          if (gen < existing.generation) return { error: "fenced", generation: existing.generation };
          if (gen === existing.generation) return { error: "duplicate_subscriber", generation: gen };
          existing.fence("fenced");
          this.subscriptions.delete(key);
        }

        if (gen > recorded) {
          consumer.generation = gen;
          consumer.updated_at = new Date(this.now()).toISOString();
          state.consumers[key] = consumer;
        }
        consumer.lease_expires_at = this.now() + this.bounds.leaseTtlMs;
        state.consumers[key] = consumer;
        await this.#writeState(state);

        await this.#logFor(consumerId);
        await this.#reconcileRetention(consumerId, Number(consumer.generation) || gen);

        /** @type {Set<string>} */
        const delivered = new Set();
        const cursor = Number(options.cursor) || 0;

        /** @type {ActiveSubscription} */
        const sub = {
          consumer_key: key,
          consumer_id: consumerId,
          generation: gen,
          write: options.write,
          onClose: options.onClose,
          delivered,
          closed: false,
          fence: (reason) => {
            if (sub.closed) return;
            sub.closed = true;
            try {
              options.write(
                JSON.stringify({
                  schema: STREAM_SCHEMA,
                  type: reason === "fenced" ? "fenced" : "stream_closed",
                  reason,
                  generation: gen,
                }) + "\n",
              );
            } catch {
              // ignore
            }
            try {
              options.onClose?.();
            } catch {
              // ignore
            }
          },
        };
        // Install before returning so concurrent admission sees it.
        this.subscriptions.set(key, sub);
        this.#log(`subscribe consumer=${key} generation=${gen}`);

        const start = async () => {
          if (sub.closed) return;
          options.write(
            JSON.stringify({
              schema: STREAM_SCHEMA,
              type: "subscribed",
              generation: gen,
              cursor,
              consumer_key: key,
            }) + "\n",
          );
          await this.#deliver(consumerId);
        };

        return {
          status: "subscribed",
          generation: gen,
          start,
          close: () => {
            if (this.subscriptions.get(key) === sub) this.subscriptions.delete(key);
            sub.closed = true;
          },
        };
      });
    });
  }

  async acknowledge(consumerId, generation, eventIds) {
    if (!isValidConsumerId(consumerId)) return { error: "invalid_consumer" };
    const gen = normalizeGeneration(generation);
    if (gen === null) return { error: "invalid_generation" };
    const key = consumerHash(consumerId);

    return this.runExclusive(async () => {
      const state = await this.#readState();
      const consumer = state.consumers[key];
      const recorded = Number(consumer?.generation || 0);
      if (gen < recorded) {
        const ids = Array.isArray(eventIds) ? eventIds.map(String) : [];
        return {
          status: "rejected",
          results: ids.map((event_id) => ({ event_id, status: "rejected", reason: "fenced" })),
        };
      }
      const sub = this.subscriptions.get(key);
      if (sub && gen < sub.generation) {
        const ids = Array.isArray(eventIds) ? eventIds.map(String) : [];
        return {
          status: "rejected",
          results: ids.map((event_id) => ({ event_id, status: "rejected", reason: "fenced" })),
        };
      }

      const log = await this.#logFor(consumerId);
      const results = await log.acknowledge(eventIds);
      if (consumer) {
        consumer.lease_expires_at = this.now() + this.bounds.leaseTtlMs;
        state.consumers[key] = consumer;
        await this.#writeState(state);
      }
      // Drain held volume now that capacity may have freed.
      await log.drainHeld({
        maxUnackedPerStream: this.bounds.maxUnackedPerStream,
        maxUnackedPerConsumer: this.bounds.maxUnackedPerConsumer,
      });
      await this.#updateBackpressure(consumerId, recorded);
      await this.#deliver(consumerId);
      return { status: "ok", results };
    });
  }

  async renewLease(consumerId, generation) {
    if (!isValidConsumerId(consumerId)) return { error: "invalid_consumer" };
    const gen = normalizeGeneration(generation);
    if (gen === null) return { error: "invalid_generation" };
    return this.runExclusive(async () => {
      const state = await this.#readState();
      const key = consumerHash(consumerId);
      const consumer = state.consumers[key];
      if (!consumer) return { error: "unknown_consumer" };
      const recorded = Number(consumer.generation) || 0;
      if (gen < recorded) return { error: "fenced", generation: recorded };
      consumer.lease_expires_at = this.now() + this.bounds.leaseTtlMs;
      state.consumers[key] = consumer;
      await this.#writeState(state);
      return { status: "renewed", generation: Math.max(recorded, gen) };
    });
  }

  async sweepLeases() {
    const now = this.now();
    for (const [key, sub] of this.subscriptions) {
      const state = await this.#readState();
      const consumer = state.consumers[key];
      if (!consumer || Number(consumer.lease_expires_at || 0) <= now) {
        sub.fence("lease_expired");
        this.subscriptions.delete(key);
        this.#log(`lease-expired consumer=${key}`);
      }
    }
  }

  async resumeDelivery(consumerId) {
    await this.#deliver(consumerId);
  }

  async #updateBackpressure(consumerId, generation) {
    const log = await this.#logFor(consumerId);
    const key = consumerHash(consumerId);
    let state = this.pressure.get(key);
    if (!state) {
      state = { stream: false, consumer: false, streams: new Set() };
      this.pressure.set(key, state);
    }

    const consumerCount = log.unackedCount();
    const consumerActive = consumerCount >= this.bounds.maxUnackedPerConsumer;
    if (consumerActive !== state.consumer) {
      state.consumer = consumerActive;
      await log.appendDeliverable({
        stream_key: "",
        generation,
        type: "backpressure",
        payload: {
          scope: "consumer",
          active: consumerActive,
          unacked: consumerCount,
          limit: this.bounds.maxUnackedPerConsumer,
        },
      });
    }

    const counts = new Map();
    for (const event of log.unacked) {
      if (!event.stream_key) continue;
      counts.set(event.stream_key, (counts.get(event.stream_key) || 0) + 1);
    }
    for (const [streamKey, count] of counts) {
      const active = count >= this.bounds.maxUnackedPerStream;
      const was = state.streams.has(streamKey);
      if (active && !was) {
        state.streams.add(streamKey);
        await log.appendDeliverable({
          stream_key: streamKey,
          generation,
          type: "backpressure",
          payload: {
            scope: "stream",
            active: true,
            unacked: count,
            limit: this.bounds.maxUnackedPerStream,
          },
        });
      } else if (!active && was) {
        state.streams.delete(streamKey);
        await log.appendDeliverable({
          stream_key: streamKey,
          generation,
          type: "backpressure",
          payload: {
            scope: "stream",
            active: false,
            unacked: count,
            limit: this.bounds.maxUnackedPerStream,
          },
        });
      }
    }
    for (const streamKey of [...state.streams]) {
      if (!counts.has(streamKey)) {
        state.streams.delete(streamKey);
        await log.appendDeliverable({
          stream_key: streamKey,
          generation,
          type: "backpressure",
          payload: {
            scope: "stream",
            active: false,
            unacked: 0,
            limit: this.bounds.maxUnackedPerStream,
          },
        });
      }
    }
  }

  async #deliver(consumerId) {
    const key = consumerHash(consumerId);
    const sub = this.subscriptions.get(key);
    if (!sub || sub.closed) return;
    const log = await this.#logFor(consumerId);

    // Deliver ALL unacked events in order. Pressure blocks ingestion (hold), not delivery of
    // retained backlog - so consumers can always ack down below the bound.
    for (const event of log.listUnacked()) {
      if (sub.closed) break;
      if (sub.delivered.has(event.event_id)) continue;
      const ok = sub.write(`${JSON.stringify(event)}\n`);
      sub.delivered.add(event.event_id);
      if (ok === false) break;
    }
  }

  async #reconcileRetention(consumerId, generation) {
    const log = await this.#logFor(consumerId);
    const candidates = log.listRetentionCandidates(this.bounds.retentionMs);
    if (candidates.length === 0) return;
    const byStream = new Map();
    for (const event of candidates) {
      byStream.set(event.stream_key, (byStream.get(event.stream_key) || 0) + 1);
    }
    await log.appendDeliverable({
      stream_key: "",
      generation,
      type: "retention_overflow",
      payload: { evicted: candidates.length, streams: Object.fromEntries(byStream) },
    });
    await log.forceDrop(candidates.map((e) => e.event_id));
    this.#log(`retention-overflow consumer=${consumerHash(consumerId)} evicted=${candidates.length}`);
  }

  async #consumerIdForKey(consumerKey) {
    try {
      const metaPath = path.join(this.eventsRoot, consumerKey, "consumer.json");
      const raw = await readFile(metaPath, "utf8");
      const parsed = JSON.parse(raw);
      const id = String(parsed.consumer_id || "");
      return isValidConsumerId(id) ? id : null;
    } catch {
      return null;
    }
  }

  /** @param {string} line */
  #log(line) {
    this.log?.(line);
  }
}

/**
 * @typedef {{
 *   consumer_key: string,
 *   consumer_id: string,
 *   generation: number,
 *   write: (line: string) => boolean | void,
 *   onClose?: () => void,
 *   delivered: Set<string>,
 *   closed: boolean,
 *   fence: (reason: string) => void,
 * }} ActiveSubscription
 */

function normalizeGeneration(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n;
}
