import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import chokidar from "chokidar";
import express from "express";

import {
  classifyHorizontalOverflow,
  classifyVerticalOverflow,
  createArtifactSdk,
  deriveLavishQueueKey,
  fragmentsSignificantlyOverlap,
  isModeToggleHotkeyEvent,
  isNativeInteractiveControl,
  MODE_TOGGLE_HOTKEY_KEY,
  resolveVisibleSpillCandidates,
} from "./artifact-sdk.js";
import * as mermaidNode from "./mermaid-node.js";
import {
  buildSelfContainedHtml,
  exportFileName,
  exportWarningSummaries,
  splitExportWarnings,
} from "./export-bundle.js";
import { publishToHtmlApp } from "./html-app.js";
import { injectLavishSdk } from "./html-transform.js";
import { bindHost, hostForUrl, linkHost } from "./paths.js";
import { canonicalFile, SessionStore, sessionKey } from "./session-store.js";

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
}) {
  const app = express();
  const store = new SessionStore(stateFile);
  const events = new EventEmitter();
  const watchers = new Map();
  const activePolls = new Map();
  const deliveredFeedback = new Set();
  const sseClients = new Set();
  const verbose = debug || process.env.LAVISH_AXI_DEBUG === "1";
  const writeLog = typeof log === "function" ? log : (line) => process.stderr.write(`${line}\n`);
  const logEvent = verbose ? (line) => writeLog(`[lavish] ${line}`) : null;
  let publicPort = port;

  app.use(express.json({ limit: "2mb" }));

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
      // A user-initiated end (browser "End session"/"Send & end session") means the human
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
      await watchSession(session, watchers, events, logEvent);
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

  app.post("/api/:key/prompts", async (req, res, next) => {
    try {
      const shouldEndSession = Boolean(req.body?.endSession || req.body?.end_session);
      const session = await store.queuePrompts(req.params.key, req.body || {});
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (shouldEndSession) clearFeedbackDelivery(req.params.key, activePolls, deliveredFeedback, events);
      events.emit(shouldEndSession ? "ended" : "feedback", req.params.key);
      res.json({ status: "queued", pending_prompts: session.pending_prompts });
      if (shouldEndSession) await shutdownIfNoLiveSessions();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/layout-warnings", async (req, res, next) => {
    try {
      const result = await store.recordLayoutWarnings(req.params.key, req.body || {});
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (result.changed && result.hasWarnings) {
        events.emit("feedback", req.params.key);
      }
      res.json({ status: "recorded", layout_warnings: result.session.layout_warnings?.length || 0 });
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
      if (!isSameOriginRequest(req)) {
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
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).send("Session not found");
        return;
      }
      await watchSession(session, watchers, events, logEvent);
      const artifactHtml = await readFile(session.file, "utf8").catch(() => "");
      const { faviconTag, title } = extractArtifactHead(artifactHtml);
      res.type("html").send(
        createChromeHtml(session, {
          layoutGateEnabled: shouldEnableLayoutGate(req.query || {}),
          faviconTag,
          title: title ? `${title} · Lavish` : "Lavish Editor",
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/artifact/:key", (req, res) => {
    res.redirect(`/artifact/${req.params.key}/index.html`);
  });

  app.get(/^\/artifact\/([^/]+)\/index\.html$/, async (req, res, next) => {
    try {
      const key = req.params[0];
      const session = await store.findByKey(key);
      if (!session) {
        res.status(404).send("Session not found");
        return;
      }
      const html = await readFile(session.file, "utf8");
      res.type("html").send(injectLavishSdk(html, key));
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
      const file = resolveArtifactAsset(root, assetPath);
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
      res.write(`event: chat-sync\ndata: ${JSON.stringify({ chat: session?.chat || [] })}\n\n`);
      res.write(
        `event: agent-presence\ndata: ${JSON.stringify({ state: computePresence(req.params.key, activePolls, deliveredFeedback) })}\n\n`,
      );
      events.on("reload", sendReload);
      events.on("agent-reply", sendAgentReply);
      events.on("agent-presence", sendPresence);
      req.on("close", () => {
        sseClients.delete(res);
        events.off("reload", sendReload);
        events.off("agent-reply", sendAgentReply);
        events.off("agent-presence", sendPresence);
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

  app.get("/sdk.js", (req, res) => {
    res.type("application/javascript").send(createSdkJs(String(req.query.key || "")));
  });

  app.use((error, req, res, _next) => {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
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

// Guard state-changing, outward-facing routes (publishing to a third-party host) against CSRF: a
// browser attaches an Origin/Referer that must match this server's own origin.
function isSameOriginRequest(req) {
  const expectedOrigin = `${req.protocol}://${req.get("host")}`;
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

export function resolveArtifactAsset(root, assetPath) {
  const file = path.resolve(root, assetPath);
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return file;
}

async function watchSession(session, watchers, events, logEvent) {
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
    timer = setTimeout(() => events.emit("reload", session.key), 100);
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
  send: chromeIcon('<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/>', 14),
  caret: chromeIcon('<path d="m6 9 6 6 6-6"/>', 13, 2),
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
  { layoutGateEnabled = true, faviconTag = LAVISH_DEFAULT_FAVICON, title = "Lavish Editor" } = {},
) {
  const sessionJson = jsonScript({
    key: session.key,
    file: session.file,
    initialChat: session.chat || [],
    layoutGateEnabled,
    modeToggleHotkeyKey: MODE_TOGGLE_HOTKEY_KEY,
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
<div class="bar"><div class="brand"><span class="brand-mark">Lavish</span><span class="brand-support">Editor</span></div><div class="spacer" aria-hidden="true"></div><button class="annotate-switch" id="annotation" type="button" aria-pressed="true" title="${escapeHtml(modeToggleHint)}"><span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span><span>Annotate</span></button><div class="more-wrap" id="moreWrap"><button class="more-button" id="moreButton" type="button" title="More" aria-haspopup="menu" aria-expanded="false">${chromeIcons.more}</button><div class="menu more-menu" id="moreMenu" hidden><div class="menu-head"><div class="menu-label">Editing</div><button class="menu-file" id="copyPath" type="button" title="Copy path · ${escapeHtml(session.file)}">${chromeIcons.file}<span class="menu-file-text"><span class="path-head">${escapeHtml(pathHead)}</span><span class="path-tail">${escapeHtml(pathTail)}</span></span><span class="copy-hint" id="copyHint"><span class="icon-copy">${chromeIcons.copy}</span><span class="icon-check">${chromeIcons.check}</span><span id="copyHintText">Copy</span></span></button></div><div class="menu-rule"></div><button class="menu-item" id="reloadArtifact" type="button">${chromeIcons.refresh}<span>Reload artifact</span></button><button class="menu-item" id="copySnapshot" type="button">${chromeIcons.camera}<span>Copy DOM snapshot</span></button><button class="menu-item" id="exportArtifact" type="button">${chromeIcons.download}<span>Export standalone HTML</span></button><button class="menu-item" id="shareArtifact" type="button">${chromeIcons.globe}<span>Publish link</span></button><div class="menu-rule"></div><button class="menu-item danger" id="end" type="button">${chromeIcons.exit}<span>End session</span></button></div></div></div>
<div class="layout"><div class="frame"><iframe id="artifact" sandbox="allow-scripts allow-forms allow-popups allow-downloads" data-artifact-src="/artifact/${session.key}/index.html"></iframe><div class="layout-issue-banner" id="layoutIssueBanner" hidden>This surface may have layout issues. Your agent has been notified.</div></div><aside class="panel"><h2>Conversation</h2><div class="panel-scroll" id="panelScroll"><div class="chat" id="chatLog"></div><div class="annotation-pills" id="annotationPills"></div></div><div class="composer"><div class="presence-banner" id="presenceBanner" hidden>Your agent is not listening. If this persists, ask your agent to poll for updates from Lavish.</div><textarea id="chatInput" placeholder="Write a message for the agent..."></textarea><div class="actions" id="sendActions"><span class="send-hint" id="sendHint" hidden>Write a message or annotate an element first.</span><div class="split"><button class="button send-main" id="send">Send to Agent</button><button class="button send-caret" id="sendCaret" type="button" title="Send options" aria-haspopup="menu" aria-expanded="false">${chromeIcons.caret}</button></div><div class="menu send-menu" id="sendMenu" hidden><button class="menu-item" id="sendFromMenu" type="button">${chromeIcons.send}<span>Send to Agent</span></button><button class="menu-item danger" id="sendAndEnd" type="button">${chromeIcons.exit}<span>Send &amp; end session</span></button></div></div></div></aside></div>
<div class="share-overlay" id="shareDialog" role="dialog" aria-modal="true" aria-labelledby="shareTitleText" hidden><form class="share-card" id="shareForm"><div class="share-head"><div><div class="share-kicker">Publish to <a class="share-link" href="https://ht-ml.app" target="_blank" rel="noopener noreferrer">ht-ml.app</a></div><h2 id="shareTitleText">Publish artifact</h2></div><button class="share-close" id="shareClose" type="button" aria-label="Close publish dialog"><svg width="14" height="14" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div><p class="share-note">ht-ml.app is a separate, third-party hosting service, not part of Lavish. Publishing sends this artifact to its servers.</p><p class="share-copy">This uploads this artifact to ht-ml.app with local assets inlined. Without a password, the page is PUBLIC and anyone with the link can open it. With a password, the page is PRIVATE and viewers must supply the password to view.</p><p class="share-note">Do not publish secrets. The Lavish annotation SDK is not included.</p><div class="share-grid"><label>Password (optional)<input id="sharePassword" name="password" type="password" autocomplete="new-password" placeholder="Leave blank for a public page"></label></div><div class="share-status" id="shareStatus" role="status"></div><div class="share-result" id="shareResult" hidden><label>Share URL<div class="share-copy-row"><input id="shareUrl" readonly><button class="share-copy-btn" id="copyShareUrl" type="button">Copy URL</button></div></label><label>Update key (secret)<div class="share-copy-row"><input id="shareUpdateKey" readonly><button class="share-copy-btn" id="copyUpdateKey" type="button">Copy key</button></div></label><p class="share-note">Keep the update key private. ht-ml.app returns it once and it is the only way to update or delete this page later.</p></div><div class="share-actions"><button class="share-cancel" id="shareCancel" type="button">Cancel</button><button class="button" id="sharePublish" type="submit">Publish</button></div></form></div>
<div class="ended-overlay layout-gate-overlay" id="layoutGateOverlay"${layoutGateHidden}><div class="ended-card"><div class="ended-title" id="layoutGateTitle">Checking layout.<br>One moment.</div><p class="ended-copy" id="layoutGateCopy">Lavish is waiting for fonts and final geometry before revealing this artifact.</p><button class="button ended-action" id="layoutGateAction" type="button">Show anyway</button></div></div>
<div class="ended-overlay" id="endedOverlay" hidden><div class="ended-card"><div class="ended-title">Session ended.<br>Return to your agent to continue.</div><p class="ended-copy">${escapeHtml(session.file)}</p></div></div>
<script id="lavish-session" type="application/json">${sessionJson}</script>
<script src="/chrome-client.js"></script>
</body>
</html>`;
}

export function createSdkJs(key) {
  // Serialize every helper exported by mermaid-node.js as a same-scope const so
  // cross-helper calls (e.g. mermaidNodeFrom → mermaidNodeElement) resolve in the
  // browser. Deriving this from the module's exports — rather than a hand-kept
  // list — means adding a helper can never silently ReferenceError at runtime.
  const mermaidHelperEntries = Object.entries(mermaidNode).filter(([, value]) => typeof value === "function");
  const mermaidHelperDecls = mermaidHelperEntries.map(([name, fn]) => `const ${name}=${fn.toString()};`).join("\n");
  const mermaidHelperKeys = mermaidHelperEntries.map(([name]) => name).join(", ");
  return `(() => {
const key=${JSON.stringify(key)};
void key;
const deriveQueueKey=${deriveLavishQueueKey.toString()};
const isNativeInteractiveControl=${isNativeInteractiveControl.toString()};
const MODE_TOGGLE_HOTKEY_KEY=${JSON.stringify(MODE_TOGGLE_HOTKEY_KEY)};
const isModeToggleHotkeyEvent=${isModeToggleHotkeyEvent.toString()};
const fragmentsSignificantlyOverlap=${fragmentsSignificantlyOverlap.toString()};
const resolveVisibleSpillCandidates=${resolveVisibleSpillCandidates.toString()};
const classifyHorizontalOverflow=${classifyHorizontalOverflow.toString()};
const classifyVerticalOverflow=${classifyVerticalOverflow.toString()};
${mermaidHelperDecls}
const mermaidHelpers={ ${mermaidHelperKeys} };
(${createArtifactSdk.toString()})(deriveQueueKey, isNativeInteractiveControl, mermaidHelpers);
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
