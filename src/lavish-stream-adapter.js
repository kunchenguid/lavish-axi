// @ts-nocheck - adapter bridges union-typed foundation results into Lavish vocabulary.
import crypto from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  MultiplexedEventStream,
  createCapabilitiesProtocolBlock,
  initHomeCapability,
  isValidConsumerId,
  isValidStreamKey,
  readHomeCapabilityFile,
  resolveStreamBounds,
} from "./multiplexed-stream.js";

export {
  createCapabilitiesProtocolBlock,
  initHomeCapability,
  readHomeCapabilityFile,
  resolveStreamBounds,
  isValidConsumerId as isValidHomeId,
  isValidStreamKey as isValidReviewId,
};

export function createCapabilitiesOutput({ version }) {
  return {
    lavish_version: version,
    protocol: createCapabilitiesProtocolBlock(),
  };
}

/**
 * Thin Lavish adapter over the domain-neutral multiplexed event stream.
 * Maps review identity and lifecycle into generic stream keys/events.
 * Foundation schema never sees prompts, artifacts, or Lavish sessions.
 */
export class LavishStreamAdapter {
  /**
   * @param {{
   *   store: import("./session-store.js").SessionStore,
   *   stateDir: string,
   *   bounds?: ReturnType<typeof resolveStreamBounds>,
   *   now?: () => number,
   *   log?: ((line: string) => void) | null,
   * }} options
   */
  constructor({ store, stateDir, bounds = resolveStreamBounds(), now = () => Date.now(), log = null }) {
    this.store = store;
    this.stream = new MultiplexedEventStream({ stateDir, bounds, now, log });
    this.now = now;
    this.ready = this.stream.ready;
  }

  activeSubscriptionCount() {
    return this.stream.activeSubscriptionCount();
  }

  async ensureHome(homeId, { homeRoot = "" } = {}) {
    return this.stream.ensureConsumer(homeId, { consumerRoot: homeRoot });
  }

  /**
   * Claim a review. Adopts pre-claim session prompts/failures/ended into the stream
   * atomically with the claim (via foundation exclusive queue + store exclusive).
   */
  async claimReview(homeId, generation, reviewId, { homeRoot = "" } = {}) {
    if (!isValidStreamKey(reviewId)) return { error: "invalid_review" };
    const outcome = await this.store.adoptSessionState(reviewId, async (session) => {
      const prompts = Array.isArray(session.prompts) ? session.prompts : [];
      const failures = Array.isArray(session.artifact_failures) ? session.artifact_failures : [];
      const ended = session.status === "ended";
      const artifactPath = session.file || "";
      const events = [];
      if (prompts.length > 0 || failures.length > 0) {
        events.push({
          type: ended ? "feedback_final" : "feedback",
          payload: {
            prompts,
            ...(session.dom_snapshot ? { dom_snapshot: session.dom_snapshot } : {}),
            ...(failures.length ? { artifact_failures: failures } : {}),
            ...(artifactPath ? { artifact_path: artifactPath } : {}),
          },
          idempotency_key: `adopt:${reviewId}:feedback:${payloadIdempotencyHash({ prompts, failures, ended })}`,
        });
      }
      if (ended) {
        events.push({
          type: "ended",
          payload: { ended_by: session.ended_by || "agent", ...(artifactPath ? { artifact_path: artifactPath } : {}) },
          end_state: "ended",
          idempotency_key: `adopt:${reviewId}:ended`,
        });
      }
      const inode = await stat(session.file)
        .then((st) => ({ dev: String(st.dev), ino: String(st.ino) }))
        .catch(() => null);
      const claimResult = await this.stream.claim(homeId, generation, reviewId, {
        consumerRoot: homeRoot,
        attributes: { artifact_path: session.file },
        inode,
        pathInsideRoot: async (attrs, root) => artifactResolvesInsideHome(String(attrs.artifact_path || ""), root),
        initialEvents: events,
        orderedTerminal: ended,
      });
      if (claimResult.error) return { result: claimResult };
      return {
        adopted: true,
        clearPrompts: prompts.length > 0 || failures.length > 0,
        clearFailures: failures.length > 0,
        keepEnded: ended,
        result: {
          status: "claimed",
          review_id: reviewId,
          generation: claimResult.generation,
          existing: claimResult.existing,
          artifact_path: session.file,
        },
      };
    });
    if (outcome.error === "unknown_review") {
      return { error: "unknown_review", help: "Open the artifact with lavish-axi <html-file> before claiming it." };
    }
    const result = outcome.result || outcome;
    if (result.error === "owned_by_other_consumer") return { error: "owned_by_other_home" };
    if (result.error === "identity_alias") {
      return {
        error: "hardlink_alias",
        existing_review_id: result.existing_stream_key,
        help: result.help,
      };
    }
    if (result.error === "invalid_consumer") return { error: "invalid_home" };
    if (result.error === "invalid_stream_key") return { error: "invalid_review" };
    return result;
  }

  async retireReview(homeId, generation, reviewId) {
    const result = await this.stream.retire(homeId, generation, reviewId);
    if (result.error === "owned_by_other_consumer") return { error: "owned_by_other_home" };
    if (result.error === "invalid_consumer") return { error: "invalid_home" };
    if (result.error === "invalid_stream_key") return { error: "invalid_review" };
    if (result.status === "retired") return { status: "retired", review_id: reviewId };
    return result;
  }

  async listClaims(homeId) {
    const result = await this.stream.listClaims(homeId);
    if (result.error) {
      if (result.error === "invalid_consumer") return { error: "invalid_home" };
      return result;
    }
    return {
      reviews: (result.streams || []).map((s) => ({
        review_id: s.stream_key,
        artifact_path: s.attributes?.artifact_path || "",
        claimed_at: s.claimed_at,
        unacked: s.unacked,
      })),
    };
  }

  async isClaimed(reviewId) {
    const claim = await this.stream.getClaim(reviewId);
    return Boolean(claim);
  }

  /**
   * Mirror a Lavish feedback batch into the foundation. Called from SessionStore
   * inside runExclusive with preloaded claim info - must not re-enter the store.
   */
  async mirrorFeedback(reviewId, batch) {
    const artifactPath = batch.artifact_path || "";
    const hasPrompts = Array.isArray(batch.prompts) && batch.prompts.length > 0;
    const hasFailures = Array.isArray(batch.artifact_failures) && batch.artifact_failures.length > 0;
    /** @type {object[]} */
    const created = [];

    const events = [];
    if (hasPrompts || hasFailures) {
      const type = batch.endSession ? "feedback_final" : "feedback";
      events.push({
        type,
        payload: {
          prompts: batch.prompts || [],
          ...(batch.dom_snapshot ? { dom_snapshot: batch.dom_snapshot } : {}),
          ...(hasFailures ? { artifact_failures: batch.artifact_failures } : {}),
          ...(artifactPath ? { artifact_path: artifactPath } : {}),
        },
        idempotency_key: batch.idempotency_key,
      });
    }
    if (batch.endSession) {
      events.push({
        type: "ended",
        payload: { ended_by: batch.ended_by || "user", ...(artifactPath ? { artifact_path: artifactPath } : {}) },
        end_state: "ended",
        idempotency_key:
          batch.end_idempotency_key || (batch.idempotency_key ? `${batch.idempotency_key}:ended` : undefined),
      });
    }
    if (events.length === 0) return { mirrored: false };
    const result = await this.stream.publishBatch(reviewId, events, { orderedTerminal: batch.endSession });
    if (result.error === "not_claimed") return { mirrored: false };
    if (result.error) return { mirrored: false, error: result.error };
    for (const item of result.results || []) if (item.event) created.push(item.event);
    return { mirrored: true, events: created };
  }

  async mirrorEnded(reviewId, info) {
    const artifactPath = info.artifact_path || "";
    const result = await this.stream.publish(reviewId, {
      type: "ended",
      payload: { ended_by: info.ended_by || "agent", ...(artifactPath ? { artifact_path: artifactPath } : {}) },
      end_state: "ended",
      idempotency_key: info.idempotency_key || `ended:${reviewId}:${info.ended_by || "agent"}`,
    });
    if (result.error === "not_claimed") return { mirrored: false };
    return { mirrored: !result.error, events: result.event ? [result.event] : [] };
  }

  async mirrorLifecycle(reviewId, type, info = {}) {
    const claim = await this.stream.getClaim(reviewId);
    if (!claim) return { mirrored: false };
    if (claim.signal_state === type) return { mirrored: true, duplicate: true };
    const terminal = type === "session_missing" || type === "orphaned";
    const artifactPath = info.artifact_path || claim.attributes?.artifact_path || "";
    const result = await this.stream.publish(reviewId, {
      type,
      payload: artifactPath ? { artifact_path: artifactPath } : {},
      end_state: terminal ? type : null,
      idempotency_key: `lifecycle:${reviewId}:${type}`,
    });
    // signal_state lives on foundation claim attributes via a republish of claim metadata -
    // store a lightweight marker in attributes through a dedicated claim update is overkill;
    // use foundation claim signal by re-claiming same owner is wrong. Keep adapter-local
    // memory is insufficient across restart. Use publish idempotency for lifecycle.
    return { mirrored: true, events: result.event ? [result.event] : [] };
  }

  async subscribe(homeId, generation, options) {
    const result = await this.stream.subscribe(homeId, generation, {
      ...options,
      consumerRoot: options.homeRoot || options.consumerRoot,
    });
    if (result.error === "invalid_consumer") return { error: "invalid_home" };
    return result;
  }

  async acknowledge(homeId, generation, eventIds) {
    const result = await this.stream.acknowledge(homeId, generation, eventIds);
    if (result.error === "invalid_consumer") return { error: "invalid_home" };
    return result;
  }

  async renewLease(homeId, generation) {
    const result = await this.stream.renewLease(homeId, generation);
    if (result.error === "invalid_consumer") return { error: "invalid_home" };
    if (result.error === "unknown_consumer") return { error: "invalid_home" };
    return result;
  }

  async sweepLeases() {
    return this.stream.sweepLeases();
  }

  async resumeDelivery(homeId) {
    return this.stream.resumeDelivery(homeId);
  }
}

async function artifactResolvesInsideHome(artifactPath, homeRoot) {
  try {
    const fileReal = await realpath(artifactPath);
    const rootReal = await realpath(homeRoot);
    if (fileReal === rootReal) return true;
    const prefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;
    return fileReal.startsWith(prefix);
  } catch {
    return false;
  }
}

export function payloadIdempotencyHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
