import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import chokidar from "chokidar";
import express from "express";

import {
  classifySevereTextOverflow,
  classifyMaterialRectEscape,
  createArtifactSdk,
  deriveAttachmentNoticeState,
  deriveLavishQueueKey,
  findStableLayoutFindings,
  isMaterialPageOverflow,
  isModeToggleHotkeyEvent,
  isNativeInteractiveControl,
  isNearTotalOcclusion,
  isTrustedAttachmentResult,
  attachmentSizeError,
  classifyAttachmentBatch,
  partitionDroppedFiles,
  MODE_TOGGLE_HOTKEY_KEY,
} from "./artifact-sdk.js";
import {
  activeLayoutWarningCount,
  resolveDiagnosticViewportClasses,
  serializeLayoutWarnings,
} from "./layout-warnings.js";
import * as mermaidNode from "./mermaid-node.js";
import { extractMermaidSources, mermaidSourceHash } from "./mermaid-source.js";
import {
  isValidDiagramIndex,
  isValidWhiteboardKey,
  loadWhiteboard,
  saveWhiteboard,
  writeWhiteboardFeedbackFiles,
} from "./whiteboard-store.js";
import {
  buildSelfContainedHtml,
  exportFileName,
  exportWarningSummaries,
  splitExportWarnings,
} from "./export-bundle.js";
import { publishToHtmlApp } from "./html-app.js";
import { injectLavishSdk } from "./html-transform.js";
import { bindHost, extraAllowedHosts, hostForUrl, IPV6_LOOPBACK_HOST, linkHost, LOOPBACK_HOST } from "./paths.js";
import { canonicalFile, SessionStore, sessionKey } from "./session-store.js";
import {
  isValidAttachmentKey,
  removeAttachment,
  resolveAttachment,
  resolveAttachmentConfig,
  statAttachmentForServe,
  sweepAttachments,
  writeAttachment,
} from "./attachment-store.js";

const chromeClientUrl = new URL("./chrome-client.js", import.meta.url);
const chromeCssUrl = new URL("./chrome.css", import.meta.url);
const designAssetUrls = {
  "daisyui.css": {
    packaged: new URL("./design/daisyui.css", import.meta.url),
    source: new URL("../node_modules/daisyui/daisyui.css", import.meta.url),
    type: "text/css",
  },
  "daisyui-themes.css": {
    packaged: new URL("./design/daisyui-themes.css", import.meta.url),
    source: new URL("../node_modules/daisyui/themes.css", import.meta.url),
    type: "text/css",
  },
  "tailwindcss-browser.js": {
    packaged: new URL("./design/tailwindcss-browser.js", import.meta.url),
    source: new URL("../node_modules/@tailwindcss/browser/dist/index.global.js", import.meta.url),
    type: "application/javascript",
  },
};

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const WHITEBOARD_CHANNEL_TOKEN_TTL_MS = 5 * 60_000;
// Sweep orphaned/expired attachments periodically, not just at startup: a
// detached server can run for days, and an upload whose /prompts follow-up never
// arrived would otherwise linger until the next restart.
const ATTACHMENT_SWEEP_INTERVAL_MS = 60 * 60_000;

// Live-reload coalescing. A normal save is one reload after a short debounce. While a queued
// layout-warning batch is outstanding, the agent is applying several related edits, so widen the
// window: the user asked for one group of fixes and should get one artifact refresh for it.
export const RELOAD_DEBOUNCE_MS = 100;
export const BATCH_RELOAD_DEBOUNCE_MS = 900;

// The whiteboard frame bundle (Excalidraw + Mermaid converter + React) is
// produced by `scripts/build.js` into dist/whiteboard. Packaged runs find it
// next to the served bundle; source runs (node bin/lavish-axi.js) fall back to
// the repo's dist output, so `pnpm run build` must have run at least once.
export function defaultWhiteboardAssetsDir() {
  const packaged = fileURLToPath(new URL("./whiteboard", import.meta.url));
  if (existsSync(packaged)) return packaged;
  return fileURLToPath(new URL("../dist/whiteboard", import.meta.url));
}

// Whiteboard scene saves carry full Excalidraw scenes (and, at queue time, a
// PNG preview data URL), which outgrow the default 2 MB JSON cap. Only the
// whiteboard write routes get the larger limit.
export function isWhiteboardWriteApiPath(pathname) {
  return /^\/api\/[0-9a-f]{16}\/whiteboard\/\d{1,3}(\/feedback-files)?$/.test(String(pathname || ""));
}

// The attachment upload carries raw image bytes, not JSON, so it bypasses both
// JSON body parsers and is read straight from the request stream by the route.
export function isAttachmentUploadApiPath(pathname) {
  return /^\/api\/[0-9a-f]{16}\/attachments$/.test(String(pathname || ""));
}

// Read the raw upload body, buffering at most `maxBytes` but always draining the
// stream to its end. If the body exceeds the cap it resolves `{ tooLarge: true }`
// (bytes discarded) rather than aborting mid-stream, so the caller can send a clean
// 413 the browser reliably receives even while it is still uploading a large file.
export function readAttachmentUploadBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let overCap = false;
    let settled = false;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      req.off("close", onClose);
    };
    const onData = (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        // Stop buffering but keep consuming so the response is not sent while the
        // request body is still in flight.
        overCap = true;
        chunks.length = 0;
      } else {
        chunks.push(chunk);
      }
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(overCap ? { tooLarge: true, buffer: null } : { tooLarge: false, buffer: Buffer.concat(chunks) });
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAborted = () => onError(new Error("attachment upload aborted"));
    // Safety net: if the socket closes before "end" (client aborted mid-upload),
    // reject rather than leaving the route awaiting a promise that never settles.
    const onClose = () => {
      if (!settled) onError(new Error("attachment upload connection closed"));
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
    req.on("close", onClose);
  });
}

// The signed payload carries the session key, so a token is a capability for
// exactly one session. Without that binding any token - including one minted by
// a request that named no session - authenticated an arbitrary session's
// whiteboard channel. The wire format stays `${issuedAt}.${nonce}.${signature}`;
// the key is signed over, never transmitted in the token.
function whiteboardChannelPayload(issuedAt, nonce, sessionKey) {
  return `${issuedAt}.${nonce}.${sessionKey}`;
}

export function createWhiteboardChannelToken(secret, sessionKey, now = Date.now()) {
  const nonce = crypto.randomBytes(24).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(whiteboardChannelPayload(now, nonce, String(sessionKey || "")))
    .digest("base64url");
  return `${now}.${nonce}.${signature}`;
}

export function isValidWhiteboardChannelToken(token, secret, sessionKey, now = Date.now()) {
  if (!isValidWhiteboardKey(sessionKey)) return false;
  const [issuedAtText, nonce, signature, extra] = String(token || "").split(".");
  if (extra !== undefined || !/^\d{13}$/.test(issuedAtText) || !/^[A-Za-z0-9_-]{32}$/.test(nonce)) return false;
  const issuedAt = Number(issuedAtText);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now || now - issuedAt > WHITEBOARD_CHANNEL_TOKEN_TTL_MS)
    return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(whiteboardChannelPayload(issuedAtText, nonce, String(sessionKey)))
    .digest("base64url");
  const actualBuffer = Buffer.from(signature || "", "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

// A detached server should not live forever. When no browser chrome (SSE) and no agent poll
// are connected for this long, the server shuts itself down so it stops dangling. The next
// `lavish-axi <file>` invocation re-spawns a fresh server and adopts resumable sessions from
// state.json. Browser-ended sessions still require the explicit --reopen opt-in. Set
// LAVISH_AXI_IDLE_TIMEOUT_MS to 0/off to disable, or to a custom millisecond budget.
export function resolveIdleTimeoutMs(env = process.env) {
  const raw = env.LAVISH_AXI_IDLE_TIMEOUT_MS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_IDLE_TIMEOUT_MS;
  if (raw === "0" || raw.toLowerCase() === "off") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_IDLE_TIMEOUT_MS;
  return value;
}

export async function serve({
  port,
  stateFile,
  version = "",
  debug = false,
  log = null,
  pollHeartbeatMs = 15_000,
  idleTimeoutMs = resolveIdleTimeoutMs(),
  host = bindHost(),
  linkHost: linkHostName = linkHost(),
  allowedHosts = extraAllowedHosts(),
  whiteboardAssetsDir = defaultWhiteboardAssetsDir(),
}) {
  const app = express();
  const store = new SessionStore(stateFile);
  const events = new EventEmitter();
  const watchers = new Map();
  const activePolls = new Map();
  const deliveredFeedback = new Set();
  const sseClients = new Set();
  const whiteboardChannelSecret = crypto.randomBytes(32);
  // Sessions with at least one warning the user queued that has not been re-checked yet.
  const outstandingRepairBatches = new Set();
  const diagnosticViewportClasses = resolveDiagnosticViewportClasses();
  const verbose = debug || process.env.LAVISH_AXI_DEBUG === "1";
  const writeLog = typeof log === "function" ? log : (line) => process.stderr.write(`${line}\n`);
  const logEvent = verbose ? (line) => writeLog(`[lavish] ${line}`) : null;
  let publicPort = port;

  // Whiteboard sidecar files live next to state.json, keyed by session + diagram.
  const whiteboardStateRoot = path.dirname(stateFile);

  // DNS-rebinding guard. isSameOriginRequest (used on /share and the whiteboard
  // write routes) stops classic cross-origin CSRF but NOT DNS rebinding: a page
  // that rebinds its own domain to this loopback port sends that domain in both
  // Origin and Host, so the two still match. The robust defense is a Host-header
  // allowlist - a rebound browser carries the attacker's domain in Host, which is
  // never one of the hostnames this server answers to.
  //
  // Loopback names are always accepted. Binding to a concrete interface
  // (LAVISH_AXI_HOST) or naming a link host (LAVISH_AXI_LINK_HOST) adds that host,
  // so an operator who intentionally exposes the server on a specific interface
  // keeps rebinding protection while their chosen hostname works. Additional
  // names (a reverse-proxy hostname, extra interfaces) are an explicit opt-in via
  // LAVISH_AXI_ALLOWED_HOSTS; a lone "*" there disables the guard for operators
  // who front the server with their own authentication. When a reverse proxy sits
  // in front, X-Forwarded-Host is validated too (see isAllowedRequestHost).
  //
  // This guard is installed as the first middleware so every route - including the
  // attachment upload/fetch/remove endpoints below - is behind the Host allowlist.
  const allowedHostnames = buildAllowedHostnames({ host, linkHost: linkHostName, allowedHosts });
  const allowAnyHostname = allowsAllHosts(allowedHosts);
  if (!allowAnyHostname) {
    app.use((req, res, next) => {
      const requestHost = { host: req.headers.host, forwardedHost: req.headers["x-forwarded-host"] };
      if (isAllowedRequestHost(requestHost, allowedHostnames)) {
        next();
        return;
      }
      logEvent?.(
        `rejected request with disallowed host host=${req.headers.host ?? ""} x-forwarded-host=${req.headers["x-forwarded-host"] ?? ""} path=${req.path}`,
      );
      res.status(403).json({ error: "forbidden host" });
    });
  }

  const attachmentConfig = resolveAttachmentConfig();
  // Attachment bytes are content-addressed on disk alongside the whiteboard sidecars.
  const attachmentStateRoot = path.dirname(stateFile);
  // The store owns the ONE shared lock covering BOTH state consistency AND the
  // attachment lifecycle. It serializes every state.json read-modify-write
  // internally (E1); the server routes its attachment disk sections - upload
  // finalize, delete, the reference-aware sweep - through the same lock via
  // `store.runExclusive`, so a reference can never be acquired in the window between
  // the sweeper's reference snapshot and its delete (D5), and `queuePrompts` cannot
  // interleave with a concurrent poll.

  const defaultJsonParser = express.json({ limit: "2mb" });
  const whiteboardJsonParser = express.json({ limit: "20mb" });
  app.use((req, res, next) => {
    // The attachment upload reads the raw request stream itself (see the route),
    // so no body parser runs for it - express.raw's limit aborts on Content-Length
    // WITHOUT draining the body, which leaves the browser's in-flight upload to be
    // reset mid-stream instead of receiving the 413.
    if (req.method === "POST" && isAttachmentUploadApiPath(req.path)) return next();
    if (isWhiteboardWriteApiPath(req.path)) return whiteboardJsonParser(req, res, next);
    return defaultJsonParser(req, res, next);
  });

  app.get("/health", (req, res) => {
    res.json({ ok: true, app: "lavish-axi", version });
  });

  let shutdownResolve;
  const done = new Promise((resolve) => {
    shutdownResolve = resolve;
  });

  app.post("/shutdown", (req, res) => {
    res.json({ status: "shutting-down" });
    // Defer until after the response flushes so the client gets confirmation.
    setImmediate(shutdown);
  });

  app.post("/api/sessions", async (req, res, next) => {
    try {
      const file = await canonicalFile(req.body.file);
      const key = sessionKey(file);
      const reopen = Boolean(req.body.reopen);
      const existing = await store.findByKey(key);
      // A user-initiated end (ending or send-and-ending from the browser) means the human
      // deliberately closed the review surface. Silently reopening it on the next
      // `lavish-axi <file>` is the exact behavior this route exists to prevent - require an
      // explicit `reopen` opt-in instead of reviving it automatically. Agent-initiated ends
      // (`lavish-axi end`) keep reviving on the next open, same as before this change.
      if (existing?.status === "ended" && existing.ended_by === "user" && !reopen) {
        logEvent?.(`session open blocked (user-ended) key=${key} file=${file}`);
        res.json({ key, file, url: existing.url, status: "user-ended" });
        return;
      }
      const sessionUrl = `http://${hostForUrl(linkHostName)}:${publicPort}/session/${key}`;
      const url = shouldDisableLayoutGateOpen(req.body || {}) ? appendNoGateParam(sessionUrl) : sessionUrl;
      const session = await store.upsertSession(file, sessionUrl);
      if (existing?.status === "ended") {
        clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
      }
      logEvent?.(`session opened key=${key} file=${file}`);
      await syncOutstandingRepairs(key);
      await watchSession(session, watchers, events, logEvent, reloadDebounceMs);
      res.json({ key, file, url, status: "opened" });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/poll", async (req, res, next) => {
    try {
      const file = await canonicalFile(String(req.query.file || ""));
      const key = sessionKey(file);
      const timeoutMs =
        req.query.timeoutMs === undefined ? null : Math.max(0, Math.min(Number(req.query.timeoutMs || 0), 2147483647));
      const immediate = await store.takeFeedback(key);
      if (immediate.status !== "waiting") {
        if (immediate.status === "feedback") markFeedbackDelivered(key, activePolls, deliveredFeedback, events);
        res.json(immediate);
        return;
      }
      const streamHeartbeat = timeoutMs === null;
      let heartbeat = null;
      if (streamHeartbeat) {
        res.status(200).type("application/json");
        res.write(" ");
        heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(" ");
        }, pollHeartbeatMs);
        heartbeat.unref?.();
      }
      setPollActive(key, activePolls, deliveredFeedback, events, true);
      refreshIdleTimer();
      const timer = timeoutMs === null ? null : setTimeout(() => respond().catch(handleRespondError), timeoutMs);
      let cleaned = false;
      let responding = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (timer) clearTimeout(timer);
        if (heartbeat) clearInterval(heartbeat);
        events.off("feedback", onFeedback);
        events.off("ended", onFeedback);
        setPollActive(key, activePolls, deliveredFeedback, events, false);
        refreshIdleTimer();
      };
      const respond = async () => {
        if (responding || res.writableEnded) return;
        responding = true;
        try {
          const result = await store.takeFeedback(key);
          if (result.status === "feedback") markFeedbackDelivered(key, activePolls, deliveredFeedback, events);
          if (streamHeartbeat) {
            res.end(JSON.stringify(result));
          } else {
            res.json(result);
          }
        } finally {
          cleanup();
        }
      };
      function handleRespondError(error) {
        if (streamHeartbeat) {
          cleanup();
          if (!res.writableEnded) res.destroy(error);
          return;
        }
        next(error);
      }
      const onFeedback = (changedKey) => {
        if (changedKey !== key || res.writableEnded) {
          return;
        }
        respond().catch(handleRespondError);
      };
      events.on("feedback", onFeedback);
      events.on("ended", onFeedback);
      req.on("close", cleanup);
    } catch (error) {
      next(error);
    }
  });

  // The one route that puts words in the reviewer's mouth: whatever lands here
  // reaches the agent as the user's own instructions. The session key is derived
  // from the artifact path, not a secret, so knowing it must not be enough -
  // only this server's own chrome may queue prompts.
  app.post("/api/:key/prompts", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin prompt submission rejected" });
        return;
      }
      const shouldEndSession = Boolean(req.body?.endSession || req.body?.end_session);
      const hasLayoutWarningPrompt = Array.isArray(req.body?.prompts)
        ? req.body.prompts.some((prompt) => prompt?.tag === "layout-warnings")
        : false;
      const result = await store.queuePrompts(req.params.key, req.body || {}, {
        resolveAttachment: (sessionKeyValue, id) => resolveAttachment(attachmentStateRoot, sessionKeyValue, id),
        maxPerPrompt: attachmentConfig.maxPerPrompt,
        maxPromptBytes: attachmentConfig.maxPromptBytes,
      });
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      // Atomic attachment rejection (C4): the batch resolved-and-persisted nothing
      // because one or more images could not be honored. Return 400 with the
      // rejected refs and the caps so the chrome keeps its queue and can surface
      // exactly what to fix, instead of silently dropping the images.
      if (result.rejected) {
        res.status(400).json({
          error: "some attachments could not be delivered",
          rejected: result.rejected,
          caps: result.caps,
        });
        return;
      }
      const session = result;
      if (session.conflict) {
        res.status(409).json({
          status: "conflict",
          error: "a layout warning changed before it was sent; review the warning again",
          warning_ids: session.warning_ids,
          warnings: session.warnings,
        });
        return;
      }
      if (shouldEndSession) clearFeedbackDelivery(req.params.key, activePolls, deliveredFeedback, events);
      if (hasLayoutWarningPrompt) {
        await syncOutstandingRepairs(req.params.key);
        events.emit("layout-warnings", req.params.key, serializeLayoutWarnings(session.layout_warnings));
      }
      events.emit(shouldEndSession ? "ended" : "feedback", req.params.key);
      res.json({ status: "queued", pending_prompts: session.pending_prompts });
      if (shouldEndSession) await shutdownIfNoLiveSessions();
    } catch (error) {
      next(error);
    }
  });

  // Passive detection. A diagnostic pass updates the warning inbox and notifies open browser
  // chromes - it never emits "feedback", so it can never make `lavish-axi poll` return and can
  // never wake an agent. Only the user's explicit "Queue selected fixes" does that, through the
  // ordinary prompt queue.
  app.post("/api/:key/layout-diagnostics", async (req, res, next) => {
    try {
      const result = await store.recordLayoutDiagnostics(req.params.key, req.body || {}, {
        viewportClasses: diagnosticViewportClasses,
      });
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      const activeCount = activeLayoutWarningCount(result.session.layout_warnings);
      if (!result.stale) {
        await syncOutstandingRepairs(req.params.key);
        if (result.changed) events.emit("layout-warnings", req.params.key, result.warnings);
      }
      res.json({ status: result.stale ? "stale" : "recorded", active_count: activeCount, warnings: result.warnings });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/:key/layout-warnings", async (req, res, next) => {
    try {
      const result = await store.listLayoutWarnings(req.params.key);
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      res.json({ warnings: result.warnings, revision: result.revision });
    } catch (error) {
      next(error);
    }
  });

  // Prepare the user's selected warnings. The prompt commits the repair request through
  // /api/:key/prompts with the rest of the ordinary feedback queue.
  app.post("/api/:key/layout-warnings/queue", async (req, res, next) => {
    try {
      const result = await store.prepareLayoutWarningFixes(req.params.key, req.body?.ids);
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      res.json({
        status: result.queued.length > 0 ? "prepared" : "unchanged",
        queued_count: result.queued.length,
        prompt: result.prompt,
        warnings: result.warnings,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/layout-warnings/dismiss", async (req, res, next) => {
    try {
      const result = await store.dismissLayoutWarning(req.params.key, req.body?.id);
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (result.changed) events.emit("layout-warnings", req.params.key, result.warnings);
      res.json({ status: result.changed ? "dismissed" : "unchanged", warnings: result.warnings });
    } catch (error) {
      next(error);
    }
  });

  // The narrow fatal path: the artifact cannot be served, or one of its own local assets failed
  // to load. There is no usable review to triage from, so this still reaches the agent directly.
  app.post("/api/:key/artifact-failures", async (req, res, next) => {
    try {
      const result = await store.recordArtifactFailures(req.params.key, req.body || {});
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (result.stale) {
        res.status(409).json({ status: "stale" });
        return;
      }
      if (result.changed) events.emit("feedback", req.params.key);
      res.json({ status: "recorded" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/end", async (req, res, next) => {
    try {
      await store.endSession(req.params.key, "user");
      clearFeedbackDelivery(req.params.key, activePolls, deliveredFeedback, events);
      events.emit("ended", req.params.key);
      res.json({ status: "ended" });
      await shutdownIfNoLiveSessions();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/agent-reply", async (req, res, next) => {
    try {
      const text = String(req.body?.text || "");
      const session = await store.addAgentReply(req.params.key, text);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      events.emit("agent-reply", req.params.key, text);
      // The reply concludes the delivered-feedback "working" state. Without this, a poll that
      // drains feedback and then releases leaves presence stuck on "working" — the chrome keeps
      // Send disabled — until some future poll happens to attach, even though the agent already
      // answered. See "SSE agent-presence returns to waiting after an agent reply".
      clearFeedbackDelivery(req.params.key, activePolls, deliveredFeedback, events);
      res.json({ status: "sent" });
    } catch (error) {
      next(error);
    }
  });

  // Static export: inline the artifact's local assets into one portable HTML file the user can
  // open from disk or host anywhere, with no dependency on this server. Remote CDN/font URLs are
  // left as references for the browser to load, so the export needs network to render those.
  app.get("/api/:key/export", async (req, res, next) => {
    try {
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      const source = await readFile(session.file, "utf8");
      const root = path.dirname(session.file);
      const { html, warnings } = await buildSelfContainedHtml(source, {
        baseDir: root,
        confineDir: root,
        resolveAbsolute: resolveDesignAssetPath,
      });
      const { unresolved, notices } = splitExportWarnings(warnings);
      res.setHeader("content-disposition", exportContentDisposition(session.file));
      res.setHeader("x-lavish-export-warning-count", String(unresolved.length));
      res.setHeader("x-lavish-export-notice-count", String(notices.length));
      res.type("html").send(html);
    } catch (error) {
      next(error);
    }
  });

  // Hosted share: build the local-inlined artifact and publish it to ht-ml.app, a third-party
  // hosting service not part of Lavish, returning the share URL. Publishing sends the artifact
  // to ht-ml.app's servers. Remote CDN/font references are left intact for the viewer's browser
  // to load.
  // Publishing creates a public third-party page unless a password is supplied, so this is gated
  // behind a same-origin check - a cross-origin page must not be able to drive a publish via the
  // loopback server.
  app.post("/api/:key/share", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin share request rejected" });
        return;
      }
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      const body = req.body || {};
      const source = await readFile(session.file, "utf8");
      const root = path.dirname(session.file);
      const { html, warnings } = await buildSelfContainedHtml(source, {
        baseDir: root,
        confineDir: root,
        resolveAbsolute: resolveDesignAssetPath,
      });
      let site;
      try {
        site = await publishToHtmlApp(html, { password: optionalBodyString(body.password) });
      } catch (error) {
        res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
      const { unresolved, notices } = splitExportWarnings(warnings);
      res.json({
        ...site,
        ...(warnings.length ? { warnings: exportWarningSummaries(warnings) } : {}),
        ...(unresolved.length ? { unresolved_local_assets: exportWarningSummaries(unresolved) } : {}),
        ...(notices.length ? { notices: exportWarningSummaries(notices) } : {}),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/end", async (req, res, next) => {
    try {
      const file = await canonicalFile(req.body.file);
      const key = sessionKey(file);
      await store.endSession(key, "agent");
      clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
      events.emit("ended", key);
      res.json({ status: "ended" });
      await shutdownIfNoLiveSessions();
    } catch (error) {
      next(error);
    }
  });

  app.get("/session/:key", async (req, res, next) => {
    try {
      const chromeLoad = await store.issueReviewerHandoff(req.params.key);
      if (!chromeLoad) {
        res.status(404).send("Session not found");
        return;
      }
      const session = chromeLoad.session;
      await watchSession(session, watchers, events, logEvent, reloadDebounceMs);
      const artifactHtml = await readFile(session.file, "utf8").catch(() => "");
      const { faviconTag, title } = extractArtifactHead(artifactHtml);
      // Nothing legitimately frames the review chrome - it is the top-level
      // page, and shares/exports ship standalone HTML rather than embedding it.
      // Refusing to be framed denies an attacker page both a window handle to
      // this chrome and a clickjacking surface over Send. Scoped to this route:
      // /artifact/* is framed by this page and /whiteboard-frame is framed by
      // that artifact document, whose sandbox gives it an opaque origin no
      // frame-ancestors expression can name.
      res.setHeader("x-frame-options", "DENY");
      res.setHeader("content-security-policy", "frame-ancestors 'none'");
      res.type("html").send(
        createChromeHtml(session, {
          layoutGateEnabled: shouldEnableLayoutGate(req.query || {}),
          faviconTag,
          title: title ? `${title} · Lavish` : "Lavish Editor",
          artifactRevision: chromeLoad.artifact_revision,
          artifactLoadToken: chromeLoad.artifact_load_token,
          artifactLoadSequence: chromeLoad.artifact_load_sequence,
          chromeLoadToken: chromeLoad.chrome_load_token,
          attachmentMaxBytes: attachmentConfig.maxBytes,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/artifact/:key", (req, res) => {
    res.redirect(`/artifact/${req.params.key}/index.html`);
  });

  app.post("/api/:key/chrome-loads/begin", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin chrome handoff rejected" });
        return;
      }
      const handoff = await store.issueReviewerHandoff(req.params.key);
      if (!handoff) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      res.json({
        chrome_load_token: handoff.chrome_load_token,
        artifact_revision: handoff.artifact_revision,
        artifact_load_token: handoff.artifact_load_token,
        artifact_load_sequence: handoff.artifact_load_sequence,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/artifact-loads/begin", async (req, res, next) => {
    try {
      const result = await store.beginArtifactLoad(req.params.key, {
        requestId: req.body?.request_id,
        requestSequence: req.body?.request_sequence,
        handoffToken: req.body?.chrome_load_token,
      });
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (result.stale) {
        res.status(409).json({ status: result.stale });
        return;
      }
      res.json({ artifact_revision: result.artifact_revision, artifact_load_token: result.artifact_load_token });
    } catch (error) {
      next(error);
    }
  });

  app.get(/^\/artifact\/([^/]+)\/index\.html$/, async (req, res, next) => {
    try {
      const key = req.params[0];
      const token = String(req.query.artifact_load_token || "");
      const revision = req.query.artifact_revision;
      const beforeRead = await store.verifyArtifactLoad(key, token, revision);
      if (!beforeRead) {
        res.status(404).send("Session not found");
        return;
      }
      if (!beforeRead.valid) {
        res
          .status(409)
          .type("html")
          .send(
            "<!doctype html><title>Artifact load expired</title><p>This artifact load is no longer current. Reload Lavish to continue.</p>",
          );
        return;
      }
      const html = await readFile(beforeRead.session.file, "utf8");
      const verified = await store.verifyArtifactLoad(key, token, revision);
      if (!verified?.valid) {
        res
          .status(409)
          .type("html")
          .send(
            "<!doctype html><title>Artifact load expired</title><p>This artifact load is no longer current. Reload Lavish to continue.</p>",
          );
        return;
      }
      res.type("html").send(injectLavishSdk(html, key, verified.artifact_revision, verified.artifact_load_token));
    } catch (error) {
      next(error);
    }
  });

  app.get(/^\/artifact\/([^/]+)\/(.+)$/, async (req, res, next) => {
    try {
      const key = req.params[0];
      const assetPath = req.params[1];
      const session = await store.findByKey(key);
      if (!session) {
        res.status(404).send("Session not found");
        return;
      }
      const root = path.dirname(session.file);
      const file = await resolveArtifactAsset(root, assetPath);
      if (!file) {
        res.status(403).send("Forbidden");
        return;
      }
      res.sendFile(file, { dotfiles: "allow" });
    } catch (error) {
      next(error);
    }
  });

  app.get("/events/:key", async (req, res, next) => {
    try {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      sseClients.add(res);
      refreshIdleTimer();
      const session = await store.findByKey(req.params.key);
      const sendReload = (key) => {
        if (key === req.params.key) {
          res.write("event: reload\ndata: {}\n\n");
        }
      };
      const sendAgentReply = (key, text) => {
        if (key === req.params.key) {
          res.write(`event: agent-reply\ndata: ${JSON.stringify({ text })}\n\n`);
        }
      };
      const sendPresence = (key, state) => {
        if (key === req.params.key) {
          res.write(`event: agent-presence\ndata: ${JSON.stringify({ state })}\n\n`);
        }
      };
      // Warning-inbox state lives on the server, so every attached chrome - including one that
      // just reconnected after a browser refresh - converges on the same list.
      const sendLayoutWarnings = (key, warnings) => {
        if (key === req.params.key) {
          res.write(`event: layout-warnings\ndata: ${JSON.stringify({ warnings })}\n\n`);
        }
      };
      res.write(`event: chat-sync\ndata: ${JSON.stringify({ chat: session?.chat || [] })}\n\n`);
      res.write(
        `event: agent-presence\ndata: ${JSON.stringify({ state: computePresence(req.params.key, activePolls, deliveredFeedback) })}\n\n`,
      );
      events.on("reload", sendReload);
      events.on("agent-reply", sendAgentReply);
      events.on("agent-presence", sendPresence);
      events.on("layout-warnings", sendLayoutWarnings);
      req.on("close", () => {
        sseClients.delete(res);
        events.off("reload", sendReload);
        events.off("agent-reply", sendAgentReply);
        events.off("agent-presence", sendPresence);
        events.off("layout-warnings", sendLayoutWarnings);
        refreshIdleTimer();
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/chrome-client.js", async (req, res, next) => {
    try {
      res.type("application/javascript").send(await readFile(chromeClientUrl, "utf8"));
    } catch (error) {
      next(error);
    }
  });

  app.get("/chrome.css", async (req, res, next) => {
    try {
      res.type("text/css").send(await readFile(chromeCssUrl, "utf8"));
    } catch (error) {
      next(error);
    }
  });

  app.get("/design/:asset", async (req, res, next) => {
    try {
      const asset = designAssetUrls[req.params.asset];
      if (!asset) {
        res.status(404).send("Not found");
        return;
      }
      res.type(asset.type).send(await readDesignAsset(asset));
    } catch (error) {
      next(error);
    }
  });

  app.get("/sdk.js", async (req, res, next) => {
    try {
      const verified = await store.verifyArtifactLoad(
        String(req.query.key || ""),
        req.query.artifact_load_token,
        req.query.artifact_revision,
      );
      if (!verified) {
        res.status(404).send("Session not found");
        return;
      }
      if (!verified.valid) {
        res.status(409).json({ status: "stale" });
        return;
      }
      res.type("application/javascript").send(
        createSdkJs(String(req.query.key || ""), verified.artifact_revision, verified.artifact_load_token, {
          maxAttachmentCount: attachmentConfig.maxPerPrompt,
          maxAttachmentBytes: attachmentConfig.maxBytes,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  // The whiteboard frame page. Hosted by the chrome in a dedicated sandboxed
  // iframe (allow-scripts allow-popups, no allow-same-origin) so untrusted
  // Mermaid text renders - and the Excalidraw editor runs - inside an opaque
  // origin, matching the artifact iframe's trust posture. The chrome passes
  // the diagram source and saved scene over postMessage after the frame
  // reports ready.
  app.get("/whiteboard-frame", (req, res) => {
    res.setHeader("cache-control", "no-store");
    // The frame's channel token is minted for one session, so the caller must
    // name it. Both call sites (the chrome overlay and the artifact SDK's
    // inline embed) know their own key; a request without one could only
    // produce a token that authenticates nothing, so reject it outright.
    const sessionKey = String(req.query.key || "");
    if (!isValidWhiteboardKey(sessionKey)) {
      res.status(400).type("text/plain").send("Missing session key");
      return;
    }
    res.type("html").send(createWhiteboardFrameHtml(createWhiteboardChannelToken(whiteboardChannelSecret, sessionKey)));
  });

  // Whiteboard bundle, stylesheet, and vendored Excalidraw fonts. The frame
  // runs in an opaque origin, and font fetches from an opaque origin are
  // CORS-gated, so this static, public-content route must answer with
  // Access-Control-Allow-Origin: * or every canvas font falls back.
  app.get(/^\/whiteboard-assets\/(.+)$/, async (req, res, next) => {
    try {
      const file = await resolveArtifactAsset(whiteboardAssetsDir, req.params[0]);
      if (!file) {
        res.status(403).send("Forbidden");
        return;
      }
      if (!existsSync(file)) {
        res
          .status(404)
          .send(existsSync(whiteboardAssetsDir) ? "Not found" : "Whiteboard bundle missing - run `pnpm run build`");
        return;
      }
      res.setHeader("access-control-allow-origin", "*");
      // Revalidate on every use (304 via Last-Modified/ETag): the bundle URL
      // is unversioned, and a memory-cached stale bundle after an upgrade or
      // local rebuild is far worse than cheap loopback revalidations.
      res.setHeader("cache-control", "no-cache");
      // Traversal is already rejected by resolveArtifactAsset; "allow" keeps
      // dot components in the assets dir's own absolute path (e.g. a checkout
      // under a dot-directory) from 403ing every asset.
      res.sendFile(file, { dotfiles: "allow" });
    } catch (error) {
      next(error);
    }
  });

  // Mermaid sources for a session's artifact, extracted from the HTML on disk
  // in document order so `index` matches the browser's `.mermaid` element
  // order. The hash feeds whiteboard staleness detection.
  app.get("/api/:key/mermaid-sources", async (req, res, next) => {
    try {
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      const html = await readFile(session.file, "utf8").catch(() => "");
      const sources = extractMermaidSources(html).map(({ index, source }) => ({
        index,
        source,
        hash: mermaidSourceHash(source),
      }));
      res.json({ sources });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/:key/whiteboard/:index", async (req, res, next) => {
    try {
      const session = await store.findByKey(req.params.key);
      if (!session || !isValidDiagramIndex(req.params.index)) {
        res.status(404).json({ error: "whiteboard not found" });
        return;
      }
      const whiteboard = await loadWhiteboard(whiteboardStateRoot, req.params.key, Number(req.params.index));
      res.json({ whiteboard });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/whiteboard-channel", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin whiteboard channel request rejected" });
        return;
      }
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (!isValidWhiteboardChannelToken(req.body?.token, whiteboardChannelSecret, req.params.key)) {
        res.status(403).json({ error: "invalid whiteboard channel" });
        return;
      }
      res.json({ status: "authenticated" });
    } catch (error) {
      next(error);
    }
  });

  // Writing to the local state directory is a state-changing action, so both
  // whiteboard write routes are same-origin guarded like /share - a hostile
  // cross-origin page must not be able to fill the state dir through the
  // loopback server.
  app.put("/api/:key/whiteboard/:index", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin whiteboard write rejected" });
        return;
      }
      const session = await store.findByKey(req.params.key);
      if (!session || !isValidWhiteboardKey(req.params.key) || !isValidDiagramIndex(req.params.index)) {
        res.status(404).json({ error: "whiteboard not found" });
        return;
      }
      const body = req.body || {};
      await saveWhiteboard(whiteboardStateRoot, req.params.key, Number(req.params.index), {
        sourceHash: String(body.source_hash || body.sourceHash || ""),
        textMetricsVersion: Number(body.text_metrics_version || body.textMetricsVersion) || 0,
        scene: body.scene ?? null,
        baseline: body.baseline ?? null,
      });
      res.json({ status: "saved" });
    } catch (error) {
      next(error);
    }
  });

  // Publish the agent-facing feedback files (.excalidraw scene + PNG preview)
  // for a diagram, returning their absolute paths for the queued prompt's
  // target. Files stay on this machine; the prompt carries only the paths.
  app.post("/api/:key/whiteboard/:index/feedback-files", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin whiteboard write rejected" });
        return;
      }
      const session = await store.findByKey(req.params.key);
      if (!session || !isValidWhiteboardKey(req.params.key) || !isValidDiagramIndex(req.params.index)) {
        res.status(404).json({ error: "whiteboard not found" });
        return;
      }
      const body = req.body || {};
      const { scenePath, previewPath } = await writeWhiteboardFeedbackFiles(
        whiteboardStateRoot,
        req.params.key,
        Number(req.params.index),
        { scene: body.scene ?? null, pngDataUrl: String(body.pngDataUrl || body.png_data_url || "") },
      );
      res.json({ scene_path: scenePath, preview_path: previewPath });
    } catch (error) {
      next(error);
    }
  });

  // Annotation image attachments. Upload writes raw bytes to the state dir and
  // returns server-vetted metadata (content-hash id + absolute path); the prompt
  // later references the id and the server re-resolves it (see queuePrompts).
  // Upload and delete write/remove local files, so they are same-origin guarded
  // like the whiteboard writes - a hostile cross-origin page must not drive them.
  app.post("/api/:key/attachments", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req)) {
        res.status(403).json({ error: "cross-origin attachment upload rejected" });
        return;
      }
      if (!isValidAttachmentKey(req.params.key) || !(await store.findByKey(req.params.key))) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      // Read the raw stream ourselves, draining past the cap to end-of-body before
      // responding. That guarantees the browser receives the 413 for an over-cap
      // upload instead of a mid-stream connection reset (only the same-origin chrome
      // can reach this route, so draining a rejected body is bounded and trusted).
      const { tooLarge, buffer } = await readAttachmentUploadBody(req, attachmentConfig.maxBytes);
      if (tooLarge) {
        res.status(413).json({ error: `attachment exceeds the ${attachmentConfig.maxBytes} byte limit` });
        return;
      }
      // Finalize under the lifecycle lock so the dedup mtime refresh (B3), the dims
      // sidecar write, AND the disk-cap admission (reference snapshot + reclaim +
      // write) are one atomic critical section. Admission is a HARD cap: a new object
      // that can't fit after reclaiming unreferenced files is refused with 507, so
      // concurrent pages can never push committed storage past `maxDiskBytes` via
      // queued references (the sweep alone never evicts referenced files). The
      // eviction grace keeps a just-uploaded ready card off the reclaim list so it
      // survives until the user sends it.
      const attachment = await store.runExclusive(async () => {
        const referenced = await store.referencedAttachmentIds();
        return writeAttachment(attachmentStateRoot, req.params.key, buffer, {
          maxBytes: attachmentConfig.maxBytes,
          maxDiskBytes: attachmentConfig.maxDiskBytes,
          maxObjects: attachmentConfig.maxObjects,
          ttlMs: attachmentConfig.ttlMs,
          referenced,
          evictionGraceMs: attachmentConfig.evictionGraceMs,
        });
      });
      res.json({ status: "stored", attachment });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/:key/attachments/:id", async (req, res, next) => {
    try {
      // D6: a render is one stat + one streamed read. `statAttachmentForServe`
      // confirms existence and derives the mime from the validated id extension
      // WITHOUT re-parsing the image to recover dimensions the route never uses.
      const serve = await statAttachmentForServe(attachmentStateRoot, req.params.key, req.params.id);
      if (!serve) {
        res.status(404).json({ error: "attachment not found" });
        return;
      }
      res.setHeader("cache-control", "private, max-age=300");
      res.type(serve.mime);
      res.sendFile(serve.file, { dotfiles: "allow" });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/:key/attachments/:id", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req)) {
        res.status(403).json({ error: "cross-origin attachment delete rejected" });
        return;
      }
      // Reference-counted delete under the lifecycle lock: a content-addressed file
      // shared by an already-queued prompt (the same image attached twice, deduped
      // to one id) must survive a chip removal, or the queued prompt's thumbnail and
      // path break. `referencedAttachmentIds` also covers attachments delivered
      // within the read grace, so a poll's images are not deletable out from under
      // the agent. The chrome never drives this route (see chrome-client's note on
      // the removed eager delete); it remains a same-origin-guarded server API.
      const status = await store.runExclusive(async () => {
        const referenced = await store.referencedAttachmentIds();
        if (referenced.has(`${req.params.key}/${req.params.id}`)) return "referenced";
        return (await removeAttachment(attachmentStateRoot, req.params.key, req.params.id)) ? "removed" : "absent";
      });
      res.json({ status });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, req, res, _next) => {
    // Body-parser errors carry a meaningful HTTP status (413 payload-too-large,
    // 400 malformed JSON); surface it instead of flattening everything to 500.
    const status = Number(error?.statusCode || error?.status) || 500;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  });

  const httpServer = await new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => {
      if (s.address()) resolve(s);
    });
    s.once("error", reject);
  });
  publicPort = httpServer.address().port;

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (attachmentSweepTimer) {
      clearInterval(attachmentSweepTimer);
      attachmentSweepTimer = null;
    }
    // Tell open browser chromes to reload before we drop their SSE connection. The new
    // server adopts the session via state.json once it binds, so the reloaded chrome
    // immediately gets the upgraded HTML/CSS/JS.
    for (const res of sseClients) {
      try {
        res.write("event: chrome-reload\ndata: {}\n\n");
        res.end();
      } catch {
        // best effort
      }
    }
    sseClients.clear();
    for (const w of watchers.values()) {
      w.close().catch(() => {});
    }
    watchers.clear();
    httpServer.close(() => shutdownResolve());
    // Force-close keep-alive sockets so SSE / long-polls don't keep us alive.
    if (typeof httpServer.closeAllConnections === "function") {
      httpServer.closeAllConnections();
    }
  }

  // Idle self-shutdown: the timer only runs while nothing is connected. Any live SSE chrome or
  // active long-poll cancels it; losing the last connection (re)arms it.
  let idleTimer = null;
  function refreshIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (shuttingDown || idleTimeoutMs == null) return;
    if (sseClients.size > 0 || activePolls.size > 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!shuttingDown && sseClients.size === 0 && activePolls.size === 0) {
        logEvent?.(`idle for ${idleTimeoutMs}ms with no connections, shutting down`);
        shutdown();
      }
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }

  // When the final open session ends with nothing connected, there is nothing left to serve,
  // so step down immediately rather than waiting out the idle timeout. If a browser chrome or
  // poll is still attached (e.g. the user is about to reopen), leave the server up and let the
  // idle timer reap it once those connections drop. Best-effort: never let a read failure
  // block the end response.
  async function shutdownIfNoLiveSessions() {
    if (sseClients.size > 0 || activePolls.size > 0) return;
    try {
      const sessions = await store.listSessions();
      if (sessions.every((session) => session.status === "ended")) {
        logEvent?.("last open session ended with no live connections, shutting down");
        setImmediate(shutdown);
      }
    } catch {
      // ignore - the idle timer remains as a backstop
    }
  }

  // A queued repair batch is outstanding until a diagnostic pass re-checks it. While it is, the
  // agent's related saves coalesce into one artifact refresh for that group.
  async function syncOutstandingRepairs(key) {
    try {
      if (await store.hasOutstandingLayoutRepairs(key)) {
        outstandingRepairBatches.add(key);
      } else {
        outstandingRepairBatches.delete(key);
      }
    } catch {
      // Best effort - the normal debounce still applies.
    }
  }

  function reloadDebounceMs(key) {
    return outstandingRepairBatches.has(key) ? BATCH_RELOAD_DEBOUNCE_MS : RELOAD_DEBOUNCE_MS;
  }

  // Reference-aware attachment cleanup: reap files that are both past their TTL
  // and unreferenced, plus the optional disk-cap backstop. Runs once at startup
  // and then on a fixed interval; skipped entirely when neither a TTL nor a disk
  // cap is configured. Never touches attachments referenced by pending prompts.
  const attachmentSweepEnabled = attachmentConfig.ttlMs != null || attachmentConfig.maxDiskBytes != null;
  let attachmentSweepTimer = null;
  async function sweepAttachmentsNow() {
    try {
      // The reference snapshot AND the enumerate/delete run as one critical section
      // so a reference acquired mid-sweep (a concurrent upload finalize or /prompts
      // resolve) can never point at a file this sweep is about to remove (D5).
      const result = await store.runExclusive(async () => {
        const referenced = await store.referencedAttachmentIds();
        return sweepAttachments(attachmentStateRoot, {
          ttlMs: attachmentConfig.ttlMs,
          maxDiskBytes: attachmentConfig.maxDiskBytes,
          maxObjects: attachmentConfig.maxObjects,
          referenced,
          evictionGraceMs: attachmentConfig.evictionGraceMs,
        });
      });
      if (result.deleted > 0) {
        logEvent?.(`attachment sweep removed ${result.deleted} file(s), freed ${result.freedBytes} bytes`);
      }
    } catch (error) {
      logEvent?.(`attachment sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (attachmentSweepEnabled) {
    sweepAttachmentsNow();
    attachmentSweepTimer = setInterval(() => {
      sweepAttachmentsNow();
    }, ATTACHMENT_SWEEP_INTERVAL_MS);
    attachmentSweepTimer.unref?.();
  }

  // Arm the idle timer for a server that is spawned but never opens a session.
  refreshIdleTimer();

  return {
    port: httpServer.address().port,
    close: async () => {
      shutdown();
      await done;
    },
    done,
  };
}

async function readDesignAsset(asset) {
  try {
    return await readFile(asset.packaged, "utf8");
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
    return readFile(asset.source, "utf8");
  }
}

// Map a legacy root-absolute `/design/<asset>` reference to the packaged design file on disk
// (falling back to the node_modules source for source runs) so an export can inline it instead
// of pointing back at this server's `/design` route.
export function resolveDesignAssetPath(refPath) {
  const match = /^\/design\/([^/?#]+)(?:[?#].*)?$/.exec(refPath);
  if (!match) return null;
  const asset = designAssetUrls[match[1]];
  if (!asset) return null;
  const packaged = fileURLToPath(asset.packaged);
  if (existsSync(packaged)) return packaged;
  const source = fileURLToPath(asset.source);
  return existsSync(source) ? source : null;
}

export function exportContentDisposition(file) {
  const filename = exportFileName(file);
  return `attachment; filename="${sanitizeDispositionFilename(filename)}"; filename*=UTF-8''${encodeRfc5987Value(filename)}`;
}

function sanitizeDispositionFilename(filename) {
  const fallback = Array.from(String(filename || ""), (char) => {
    const codePoint = char.codePointAt(0) || 0;
    if (codePoint < 0x20 || codePoint > 0x7e || char === '"' || char === "\\") return "_";
    return char;
  }).join("");
  return fallback || "artifact.export.html";
}

function encodeRfc5987Value(value) {
  return encodeURIComponent(String(value)).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// Wildcard bind addresses ("all interfaces") are not connectable hostnames, so
// they never belong in the Host allowlist - and "0.0.0.0" as a Host is a known
// loopback-reach trick, so it must stay rejected.
const WILDCARD_BIND_HOSTS = new Set(["0.0.0.0", "::"]);

// The set of Host header hostnames this server answers to: loopback names plus
// the resolved bind and link host and any explicit LAVISH_AXI_ALLOWED_HOSTS
// extras, minus wildcard binds and the "*" sentinel. Lowercased for
// case-insensitive comparison against the incoming Host.
export function buildAllowedHostnames({ host, linkHost: linkHostName, allowedHosts = [] }) {
  return new Set(
    [LOOPBACK_HOST, IPV6_LOOPBACK_HOST, "localhost", host, linkHostName, ...allowedHosts]
      .map((value) =>
        String(value || "")
          .trim()
          .toLowerCase(),
      )
      .filter((value) => value && value !== "*" && !WILDCARD_BIND_HOSTS.has(value)),
  );
}

// A lone "*" in LAVISH_AXI_ALLOWED_HOSTS is an explicit opt-out of the Host
// allowlist, for operators who front the server with their own auth/proxy.
export function allowsAllHosts(allowedHosts = []) {
  return allowedHosts.some((value) => String(value).trim() === "*");
}

function parseHostAuthority(value) {
  const raw = String(value).trim();
  if (!raw || /[@/\\?#\s]/.test(raw)) return null;

  let hostname;
  let port;
  let bracketed = false;
  if (raw.startsWith("[")) {
    const match = /^\[([0-9A-Fa-f:.]+)\](?::(\d+))?$/.exec(raw);
    if (!match || isIP(match[1]) !== 6) return null;
    [, hostname, port = ""] = match;
    bracketed = true;
  } else {
    const match = /^([A-Za-z0-9._-]+)(?::(\d+))?$/.exec(raw);
    if (!match) return null;
    [, hostname, port = ""] = match;
  }
  if (port && Number(port) > 65535) return null;

  hostname = hostname.toLowerCase();
  const authority = `${bracketed ? `[${hostname}]` : hostname}${port ? `:${port}` : ""}`;
  try {
    const parsed = new URL(`http://${authority}`);
    if (!parsed.origin || parsed.origin === "null") return null;
  } catch {
    return null;
  }
  return { hostname, port, authority };
}

// Extract the hostname (without port) from a Host header value, honoring
// bracketed IPv6 literals ("[::1]:4387"). Returns null for a malformed authority.
export function hostnameFromHostHeader(value) {
  return parseHostAuthority(value)?.hostname ?? null;
}

// DNS-rebinding defense: a loopback-bound server answers only to its own known
// hostnames. A rebound browser carries the attacker's domain in Host and is
// rejected. Host is mandatory in HTTP/1.1 and every browser sends it, so a
// missing or blank value is never a legitimate client - reject it rather than
// fail open.
export function isAllowedHostHeader(hostHeader, allowedHostnames) {
  if (hostHeader === undefined || hostHeader === null) return false;
  const authority = parseHostAuthority(hostHeader);
  return authority !== null && allowedHostnames.has(authority.hostname);
}

// Validate a request's effective host for DNS-rebinding protection. The Host
// header is required and must be allowlisted. When an X-Forwarded-Host is present
// - a reverse proxy in front of the loopback server - its outermost (last) value
// must ALSO be allowlisted, so a proxy works once its public hostname is added to
// LAVISH_AXI_ALLOWED_HOSTS. This is an AND check: a client-spoofed forwarded host
// can only narrow access (Host is still checked), never widen it into a bypass. A
// blank forwarded host is treated as absent, matching how proxies omit it.
/**
 * @param {{ host?: string|undefined|null, forwardedHost?: string|undefined|null }} headers
 * @param {Set<string>} allowedHostnames
 */
export function isAllowedRequestHost({ host, forwardedHost }, allowedHostnames) {
  if (!isAllowedHostHeader(host, allowedHostnames)) return false;
  const forwarded = forwardedHost === undefined || forwardedHost === null ? "" : String(forwardedHost).trim();
  if (forwarded === "") return true;
  return isAllowedHostHeader(forwarded.split(",").pop(), allowedHostnames);
}

// Guard state-changing, outward-facing routes (publishing to a third-party host) against CSRF: a
// browser attaches an Origin/Referer that must match this server's own origin.
function isSameOriginRequest(req, allowedHostnames, allowAnyHostname = false) {
  const host = parseHostAuthority(req.headers.host);
  if (!host) return false;

  let protocol = req.protocol;
  let authority = host;
  const forwardedHost = String(req.get("x-forwarded-host") || "")
    .split(",")
    .pop()
    .trim();
  if (forwardedHost) {
    const forwardedAuthority = parseHostAuthority(forwardedHost);
    if (
      !forwardedAuthority ||
      (!allowAnyHostname &&
        (!allowedHostnames.has(host.hostname) || !allowedHostnames.has(forwardedAuthority.hostname)))
    )
      return false;
    protocol = String(req.get("x-forwarded-proto") || req.protocol)
      .split(",")
      .pop()
      .trim()
      .toLowerCase();
    if (protocol !== "http" && protocol !== "https") return false;
    authority = forwardedAuthority;
  }
  const expectedOrigin = normalizeOrigin(`${protocol}://${authority.authority}`);
  if (!expectedOrigin) return false;
  const origin = req.get("origin");
  if (origin) {
    return normalizeOrigin(origin) === expectedOrigin;
  }
  const referer = req.get("referer");
  return Boolean(referer) && normalizeOrigin(referer) === expectedOrigin;
}

function normalizeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function optionalBodyString(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || undefined;
}

// Confines an asset request lexically first, then - like export-bundle.js's guardedRead -
// resolves the real (symlink-followed) path and refuses anything that escapes the artifact
// directory, so a symlink placed beside the artifact can't make this route serve an outside
// file (e.g. ~/.ssh/id_rsa).
export async function resolveArtifactAsset(root, assetPath) {
  const file = path.resolve(root, assetPath);
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  let real;
  try {
    real = await realpath(file);
  } catch (error) {
    // Nonexistent path (e.g. an asset that hasn't been built yet): nothing to read, so the
    // lexical confinement above is enough - the caller's existsSync/sendFile handles the 404.
    // Every other realpath failure fails closed, like guardedRead.
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return file;
    }
    throw error;
  }
  let realRoot;
  try {
    realRoot = await realpath(root);
  } catch {
    realRoot = path.resolve(root);
  }
  const relativeReal = path.relative(realRoot, real);
  if (relativeReal === ".." || relativeReal.startsWith(`..${path.sep}`) || path.isAbsolute(relativeReal)) {
    return null;
  }
  // Hand back the resolved path, not the requested one: a real path contains no symlinks, so
  // sendFile re-opening it cannot be redirected by a link swapped in after this check.
  return real;
}

/**
 * @param {(key: string) => number} reloadDebounceMs
 */
async function watchSession(session, watchers, events, logEvent, reloadDebounceMs = () => RELOAD_DEBOUNCE_MS) {
  if (watchers.has(session.key)) {
    return;
  }
  const target = await resolveWatchTarget(session);
  if (watchers.has(session.key)) {
    return;
  }
  logEvent?.(`watch session=${session.key} scope=${target.scope} path=${target.path}`);
  const watcher = chokidar.watch(target.path, target.options);
  let timer = null;
  watcher.on("all", (event, file) => {
    logEvent?.(`watch event=${event} session=${session.key} file=${file ?? ""}`);
    clearTimeout(timer);
    timer = setTimeout(() => events.emit("reload", session.key), reloadDebounceMs(session.key));
  });
  watcher.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    logEvent?.(`watch error session=${session.key} message=${message}`);
  });
  watchers.set(session.key, watcher);
}

// Watching the artifact's parent directory recursively can stall the event loop when the
// artifact lives in a large tree (e.g. ~/Downloads). Default to watching only the artifact
// itself; an artifact opts back into directory-wide live reload via either a
// `data-lavish-live-reload-root` attribute on its root element or
// `<meta name="lavish-live-reload" content="root">`.
export async function resolveWatchTarget(session) {
  const baseOptions = {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  };
  try {
    const html = await readFile(session.file, "utf8");
    if (hasLiveReloadRootOptIn(html)) {
      return {
        path: path.dirname(session.file),
        scope: "directory",
        options: {
          ...baseOptions,
          ignored: /(^|[/\\])(\.git|node_modules|dist|build|\.lavish-axi)([/\\]|$)/,
        },
      };
    }
  } catch {
    // Fall through to file-only watching when the artifact can't be read.
  }
  return { path: session.file, scope: "file", options: baseOptions };
}

export function hasLiveReloadRootOptIn(html) {
  if (typeof html !== "string") return false;
  const searchableHtml = html.replace(/<!--[\s\S]*?-->/g, "");
  if (/<html\b[^>]*\sdata-lavish-live-reload-root(?:[\s=>/]|$)[^>]*>/i.test(searchableHtml)) return true;
  return /<meta\b(?=[^>]*name=["']lavish-live-reload["'])(?=[^>]*content=["']root["'])[^>]*>/i.test(searchableHtml);
}

function setPollActive(key, activePolls, deliveredFeedback, events, active) {
  const previousPresence = computePresence(key, activePolls, deliveredFeedback);
  const count = activePolls.get(key) || 0;
  const nextCount = active ? count + 1 : Math.max(0, count - 1);
  if (nextCount === count) return;
  if (nextCount === 0) {
    activePolls.delete(key);
  } else {
    activePolls.set(key, nextCount);
    deliveredFeedback.delete(key);
  }
  const nextPresence = computePresence(key, activePolls, deliveredFeedback);
  if (nextPresence !== previousPresence) events.emit("agent-presence", key, nextPresence);
}

function markFeedbackDelivered(key, activePolls, deliveredFeedback, events) {
  const previousPresence = computePresence(key, activePolls, deliveredFeedback);
  deliveredFeedback.add(key);
  const nextPresence = computePresence(key, activePolls, deliveredFeedback);
  if (nextPresence !== previousPresence) {
    events.emit("agent-presence", key, nextPresence);
  }
}

function clearFeedbackDelivery(key, activePolls, deliveredFeedback, events) {
  const previousPresence = computePresence(key, activePolls, deliveredFeedback);
  deliveredFeedback.delete(key);
  const nextPresence = computePresence(key, activePolls, deliveredFeedback);
  if (nextPresence !== previousPresence) {
    events.emit("agent-presence", key, nextPresence);
  }
}

export function computePresence(key, activePolls, deliveredFeedback) {
  if (activePolls.has(key)) return "listening";
  if (deliveredFeedback.has(key)) return "working";
  return "waiting";
}

function chromeIcon(paths, size = 16, strokeWidth = 1.7) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

const chromeIcons = {
  more: chromeIcon(
    '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
  ),
  file: chromeIcon(
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    13,
  ),
  copy: chromeIcon(
    '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    12,
  ),
  check: chromeIcon('<polyline points="20 6 9 17 4 12"/>', 12),
  refresh: chromeIcon(
    '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    15,
  ),
  camera: chromeIcon(
    '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
    15,
  ),
  download: chromeIcon(
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    15,
  ),
  globe: chromeIcon(
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14.5 14.5 0 0 1 0 18a14.5 14.5 0 0 1 0-18z"/>',
    15,
  ),
  exit: chromeIcon(
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    15,
  ),
  warning: chromeIcon(
    '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    16,
  ),
  reveal: chromeIcon('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>', 13),
  dismiss: chromeIcon('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 13),
};

// Display the path with the home directory shortened to "~", split so the directory part can
// ellipsize in the menu while the file name itself always stays visible.
export function displayPathParts(file, home = homedir()) {
  const normalizedFile = file.replaceAll("\\", "/");
  const normalizedHome = home.replaceAll("\\", "/");
  const display =
    normalizedHome && normalizedFile.startsWith(`${normalizedHome}/`)
      ? `~/${normalizedFile.slice(normalizedHome.length + 1)}`
      : normalizedFile;
  const tailStart = display.lastIndexOf("/") + 1;
  return { head: display.slice(0, tailStart), tail: display.slice(tailStart) };
}

export function shouldEnableLayoutGate(query = {}) {
  const noGate = query["no-gate"] ?? query.noGate ?? query.no_gate;
  if (isTruthyFlag(noGate)) return false;

  const gate = query.gate ?? query.layoutGate ?? query.layout_gate;
  if (isFalseyFlag(gate)) return false;

  return true;
}

function shouldDisableLayoutGateOpen(body = {}) {
  const noGate = body["no-gate"] ?? body.noGate ?? body.no_gate;
  if (isTruthyFlag(noGate)) return true;

  const gate = body.gate ?? body.layoutGate ?? body.layout_gate;
  return isFalseyFlag(gate);
}

function appendNoGateParam(url) {
  const parsed = new URL(url);
  parsed.searchParams.set("no-gate", "1");
  return parsed.toString();
}

function isTruthyFlag(value) {
  const normalized = normalizeFlagValue(value);
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isFalseyFlag(value) {
  const normalized = normalizeFlagValue(value);
  return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}

function normalizeFlagValue(value) {
  if (Array.isArray(value)) return normalizeFlagValue(value[0]);
  return value === undefined || value === null ? "" : String(value).trim().toLowerCase();
}

const LAVISH_DEFAULT_FAVICON =
  "<link rel=\"icon\" href=\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u{1F48E}</text></svg>\">";

function readTagAttr(tag, name) {
  // Tokenize real attributes rather than searching for the bare name anywhere in
  // the tag: a `\b`-anchored name matches attribute-name suffixes (e.g. `href`
  // inside `data-href`) and names that appear inside another attribute's quoted
  // value (e.g. `href=` inside a `title="... href=x"`), both of which would make
  // us adopt the wrong href. Walking whole `name="value"` pairs consumes each
  // value as one unit, so only genuine attribute names are matched.
  const attrRe = /([a-z][\w:-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  const target = name.toLowerCase();
  let match;
  while ((match = attrRe.exec(tag)) !== null) {
    if (match[1].toLowerCase() === target) {
      return (match[3] ?? match[4] ?? match[5] ?? "").trim();
    }
  }
  return "";
}

// Pull a tab favicon + title out of the artifact's own <head>. Lavish renders the
// artifact in a sandboxed iframe, so the artifact's own <link rel="icon"> and
// <title> never reach the browser tab; surfacing them here makes a wall of Lavish
// tabs identifiable. Falls back to the Lavish default favicon. Only data: and
// absolute (http/https/protocol-relative) icon hrefs are adopted verbatim;
// artifact-relative hrefs would not resolve against the chrome page, so they fall
// back to the default.
export function extractArtifactHead(html) {
  const head = String(html || "").slice(0, 10000);
  let faviconTag = LAVISH_DEFAULT_FAVICON;
  const linkTags = head.match(/<link\b(?:"[^"]*"|'[^']*'|[^"'>])*>/gi) || [];
  const iconTag = linkTags.find((tag) => /(^|\s)icon(\s|$)/i.test(readTagAttr(tag, "rel")));
  const iconHref = iconTag ? readTagAttr(iconTag, "href") : "";
  if (iconHref && /^(data:|https?:|\/\/)/i.test(iconHref)) {
    const safeHref = iconHref.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    faviconTag = `<link rel="icon" href="${safeHref}">`;
  }
  let title = "";
  const titleMatch = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) title = titleMatch[1].replace(/\s+/g, " ").trim();
  return { faviconTag, title };
}

export function createChromeHtml(
  session,
  {
    layoutGateEnabled = true,
    faviconTag = LAVISH_DEFAULT_FAVICON,
    title = "Lavish Editor",
    artifactRevision = 0,
    artifactLoadToken = "",
    artifactLoadSequence = 0,
    chromeLoadToken = "",
    attachmentMaxBytes = 0,
  } = {},
) {
  const sessionJson = jsonScript({
    key: session.key,
    file: session.file,
    initialChat: session.chat || [],
    // Bootstrapping the inbox from the server is what makes it survive a browser refresh or a
    // reconnect: the chrome never owns warning state, it only renders it.
    initialLayoutWarnings: serializeLayoutWarnings(session.layout_warnings),
    initialArtifactRevision: artifactRevision,
    initialArtifactLoadToken: artifactLoadToken,
    initialArtifactLoadSequence: artifactLoadSequence,
    chromeLoadToken,
    layoutGateEnabled,
    modeToggleHotkeyKey: MODE_TOGGLE_HOTKEY_KEY,
    attachmentMaxBytes,
  });
  const { head: pathHead, tail: pathTail } = displayPathParts(session.file);
  const bodyClass = layoutGateEnabled ? "lavish layout-gate-active" : "lavish";
  const layoutGateHidden = layoutGateEnabled ? "" : " hidden";
  const modeHotkeyUpper = MODE_TOGGLE_HOTKEY_KEY.toUpperCase();
  const modeToggleHint = `Toggle annotate/explore mode (⌘${modeHotkeyUpper} / Ctrl+${modeHotkeyUpper})`;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${faviconTag}
<link rel="stylesheet" href="/chrome.css">
</head>
<body class="${bodyClass}">
<div class="bar"><div class="brand"><span class="brand-mark">Lavish</span><span class="brand-support">Editor</span></div><div class="spacer" aria-hidden="true"></div><div class="warnings-wrap" id="warningsWrap" hidden><button class="warnings-button" id="warningsButton" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="warningsDrawer">${chromeIcons.warning}<span class="warnings-count" id="warningsCount">0</span></button><div class="menu warnings-drawer" id="warningsDrawer" role="dialog" aria-labelledby="warningsTitle" aria-describedby="warningsSummary" hidden><div class="warnings-head"><h2 class="warnings-title" id="warningsTitle">Layout issues</h2><p class="warnings-summary" id="warningsSummary"></p></div><div class="warnings-toolbar"><label class="warnings-selectall"><input type="checkbox" id="warningsSelectAll"><span>Select all</span></label><span class="warnings-selected" id="warningsSelected" role="status" aria-live="polite"></span></div><div class="warnings-list" id="warningsList"></div><div class="warnings-foot"><p class="warnings-note">Queueing sends a repair request with your next feedback. An issue is marked resolved only after a newer artifact load and a complete check at the same viewport no longer finds it.</p><button class="button" id="warningsQueueButton" type="button" disabled>Queue selected fixes</button></div></div></div><button class="annotate-switch" id="annotation" type="button" aria-pressed="true" title="${escapeHtml(modeToggleHint)}"><span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span><span>Annotate</span></button><div class="more-wrap" id="moreWrap"><button class="more-button" id="moreButton" type="button" title="More" aria-haspopup="menu" aria-expanded="false">${chromeIcons.more}</button><div class="menu more-menu" id="moreMenu" hidden><div class="menu-head"><div class="menu-label">Editing</div><button class="menu-file" id="copyPath" type="button" title="Copy path · ${escapeHtml(session.file)}">${chromeIcons.file}<span class="menu-file-text"><span class="path-head">${escapeHtml(pathHead)}</span><span class="path-tail">${escapeHtml(pathTail)}</span></span><span class="copy-hint" id="copyHint"><span class="icon-copy">${chromeIcons.copy}</span><span class="icon-check">${chromeIcons.check}</span><span id="copyHintText">Copy</span></span></button></div><div class="menu-rule"></div><button class="menu-item" id="reloadArtifact" type="button">${chromeIcons.refresh}<span>Reload artifact</span></button><button class="menu-item" id="copySnapshot" type="button">${chromeIcons.camera}<span>Copy DOM snapshot</span></button><button class="menu-item" id="exportArtifact" type="button">${chromeIcons.download}<span>Export standalone HTML</span></button><button class="menu-item" id="shareArtifact" type="button">${chromeIcons.globe}<span>Publish link</span></button><div class="menu-rule"></div><button class="menu-item danger" id="end" type="button">${chromeIcons.exit}<span>End session</span></button></div></div></div>
<div class="layout"><div class="frame"><iframe id="artifact" sandbox="allow-scripts allow-forms allow-popups allow-downloads" data-artifact-src="/artifact/${session.key}/index.html"></iframe></div><aside class="panel"><h2>Conversation</h2><div class="panel-scroll" id="panelScroll"><div class="chat" id="chatLog"></div><div class="annotation-pills" id="annotationPills"></div></div><div class="composer"><div class="presence-banner handoff-banner" id="handoffBanner" hidden><span>This review is open in another Lavish tab.</span><button class="handoff-takeover" id="handoffTakeover" type="button">Take over here</button></div><div class="presence-banner" id="presenceBanner" hidden>Your agent is not listening. If this persists, ask your agent to poll for updates from Lavish.</div><textarea id="chatInput" placeholder="Write a message for the agent..."></textarea><div class="send-hint" id="sendHint" hidden>Write a message or annotate an element first.</div><div class="actions" id="sendActions"><button class="button button-danger" id="sendAndEnd" type="button">${chromeIcons.exit}<span>Send &amp; End</span></button><button class="button" id="send">Send to Agent</button></div></div></aside></div>
<div class="share-overlay" id="shareDialog" role="dialog" aria-modal="true" aria-labelledby="shareTitleText" hidden><form class="share-card" id="shareForm"><div class="share-head"><div><div class="share-kicker">Publish to <a class="share-link" href="https://ht-ml.app" target="_blank" rel="noopener noreferrer">ht-ml.app</a></div><h2 id="shareTitleText">Publish artifact</h2></div><button class="share-close" id="shareClose" type="button" aria-label="Close publish dialog"><svg width="14" height="14" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div><p class="share-note">ht-ml.app is a separate, third-party hosting service, not part of Lavish. Publishing sends this artifact to its servers.</p><p class="share-copy">This uploads this artifact to ht-ml.app with local assets inlined. Without a password, the page is PUBLIC and anyone with the link can open it. With a password, the page is PRIVATE and viewers must supply the password to view.</p><p class="share-note">Do not publish secrets. The Lavish annotation SDK is not included.</p><div class="share-grid"><label>Password (optional)<input id="sharePassword" name="password" type="password" autocomplete="new-password" placeholder="Leave blank for a public page"></label></div><div class="share-status" id="shareStatus" role="status"></div><div class="share-result" id="shareResult" hidden><label>Share URL<div class="share-copy-row"><input id="shareUrl" readonly><button class="share-copy-btn" id="copyShareUrl" type="button">Copy URL</button></div></label><label>Update key (secret)<div class="share-copy-row"><input id="shareUpdateKey" readonly><button class="share-copy-btn" id="copyUpdateKey" type="button">Copy key</button></div></label><p class="share-note">Keep the update key private. ht-ml.app returns it once and it is the only way to update or delete this page later.</p></div><div class="share-actions"><button class="share-cancel" id="shareCancel" type="button">Cancel</button><button class="button" id="sharePublish" type="submit">Publish</button></div></form></div>
<div class="ended-overlay layout-gate-overlay" id="layoutGateOverlay"${layoutGateHidden}><div class="ended-card"><div class="ended-title" id="layoutGateTitle">Checking layout.<br>One moment.</div><p class="ended-copy" id="layoutGateCopy">Lavish is waiting for fonts and final geometry before revealing this artifact.</p><button class="button ended-action" id="layoutGateAction" type="button">Show anyway</button></div></div>
<div class="ended-overlay" id="endedOverlay" hidden><div class="ended-card"><div class="ended-title">Session ended.<br>Return to your agent to continue.</div><p class="ended-copy">${escapeHtml(session.file)}</p></div></div>
<div class="whiteboard-overlay" id="whiteboardOverlay" hidden><div class="whiteboard-shell"><div class="whiteboard-error" id="whiteboardError" hidden></div><button class="whiteboard-close" id="whiteboardClose" type="button" aria-label="Close whiteboard"><svg width="14" height="14" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button><iframe id="whiteboardFrame" title="Excalidraw whiteboard" sandbox="allow-scripts allow-popups"></iframe></div></div>
<script id="lavish-session" type="application/json">${sessionJson}</script>
<script src="/chrome-client.js"></script>
</body>
</html>`;
}

export function createWhiteboardFrameHtml(channelToken = "") {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lavish Whiteboard</title>
<link rel="stylesheet" href="/whiteboard-assets/whiteboard.css">
</head>
<body>
<script>window.__lavishWhiteboardChannelToken=${JSON.stringify(channelToken)};</script>
<script src="/whiteboard-assets/whiteboard.js"></script>
</body>
</html>`;
}

/**
 * @param {string} key
 * @param {number} [artifactRevision]
 * @param {string} [artifactLoadToken]
 * @param {{ maxAttachmentCount?: number, maxAttachmentBytes?: number }} [options]
 */
export function createSdkJs(
  key,
  artifactRevision = 0,
  artifactLoadToken = "",
  { maxAttachmentCount, maxAttachmentBytes } = {},
) {
  // Serialize every helper exported by mermaid-node.js as a same-scope const so
  // cross-helper calls (e.g. mermaidNodeFrom → mermaidNodeElement) resolve in the
  // browser. Deriving this from the module's exports — rather than a hand-kept
  // list — means adding a helper can never silently ReferenceError at runtime.
  const mermaidHelperEntries = Object.entries(mermaidNode).filter(([, value]) => typeof value === "function");
  const mermaidHelperDecls = mermaidHelperEntries.map(([name, fn]) => `const ${name}=${fn.toString()};`).join("\n");
  const mermaidHelperKeys = mermaidHelperEntries.map(([name]) => name).join(", ");
  const revisionNumber = Number(artifactRevision);
  const revision = Number.isFinite(revisionNumber) && revisionNumber >= 0 ? Math.trunc(revisionNumber) : 0;
  const loadToken = String(artifactLoadToken || "").slice(0, 200);
  // The per-prompt attachment cap is authoritative on the server (attachment-store.js);
  // pass it to the SDK so the annotation card's local count guard matches the server
  // limit instead of a hardcoded literal (W1). The card is still only a UX guide - the
  // server re-enforces the cap on /prompts and rejects the whole batch on a mismatch.
  const sdkOptions = {
    maxAttachmentCount: Number.isFinite(maxAttachmentCount) ? maxAttachmentCount : undefined,
    maxAttachmentBytes: Number.isFinite(maxAttachmentBytes) ? maxAttachmentBytes : undefined,
  };
  return `(() => {
const key=${JSON.stringify(key)};
const artifactRevision=${revision};
const artifactLoadToken=${JSON.stringify(loadToken)};
const deriveQueueKey=${deriveLavishQueueKey.toString()};
const isNativeInteractiveControl=${isNativeInteractiveControl.toString()};
const MODE_TOGGLE_HOTKEY_KEY=${JSON.stringify(MODE_TOGGLE_HOTKEY_KEY)};
const isModeToggleHotkeyEvent=${isModeToggleHotkeyEvent.toString()};
const classifySevereTextOverflow=${classifySevereTextOverflow.toString()};
const classifyMaterialRectEscape=${classifyMaterialRectEscape.toString()};
const isMaterialPageOverflow=${isMaterialPageOverflow.toString()};
const findStableLayoutFindings=${findStableLayoutFindings.toString()};
const isNearTotalOcclusion=${isNearTotalOcclusion.toString()};
const attachmentSizeError=${attachmentSizeError.toString()};
const classifyAttachmentBatch=${classifyAttachmentBatch.toString()};
const partitionDroppedFiles=${partitionDroppedFiles.toString()};
const isTrustedAttachmentResult=${isTrustedAttachmentResult.toString()};
const deriveAttachmentNoticeState=${deriveAttachmentNoticeState.toString()};
${mermaidHelperDecls}
const mermaidHelpers={ ${mermaidHelperKeys} };
(${createArtifactSdk.toString()})(deriveQueueKey, isNativeInteractiveControl, mermaidHelpers, artifactRevision, artifactLoadToken, key, ${JSON.stringify(sdkOptions)});
})();`;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

function jsonScript(value) {
  return JSON.stringify(value)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
