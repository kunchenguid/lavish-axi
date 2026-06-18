import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import chokidar from "chokidar";
import express from "express";

import { createArtifactSdk } from "./artifact-sdk.js";
import { injectLavishSdk } from "./html-transform.js";
import { bindHost, hostForUrl, linkHost } from "./paths.js";
import { canonicalFile, SessionStore, sessionKey } from "./session-store.js";
import { createShinyProxy, proxyWebSocket } from "./shiny-proxy.js";
import { launchShiny, findFreePort } from "./shiny-process.js";
import {
  detectQuarto,
  renderQuarto,
  quartoOutputFile,
  isQuartoShinyFile,
  launchQuartoShiny,
} from "./quarto-process.js";

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
// `lavish-axi <file>` invocation re-spawns a fresh server and adopts the session from
// state.json. Set LAVISH_AXI_IDLE_TIMEOUT_MS to 0/off to disable, or to a custom millisecond
// budget.
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
  const shinyProcesses = new Map();
  const quartoRenders = new Map();
  const proxies = new Map();
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
      const url = `http://${hostForUrl(linkHostName)}:${publicPort}/session/${key}`;
      const existing = await store.findByKey(key);
      if (shinyProcesses.has(key)) {
        const shinyApp = shinyProcesses.get(key);
        shinyApp.kill();
        shinyProcesses.delete(key);
      }
      const session = await store.upsertSession(file, url);
      if (existing?.status === "ended") {
        clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
      }
      logEvent?.(`session opened key=${key} file=${file}`);
      await watchSession(session, watchers, events, logEvent, quartoRenders, shinyProcesses, store);
      res.json({ key, file, url, status: "opened" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/shiny-sessions", async (req, res, next) => {
    try {
      const appDir = await canonicalFile(req.body.appDir);
      const key = sessionKey(appDir);
      const existing = await store.findByKey(key);

      let shinyUrl = req.body.url || null;
      let shinyPid = null;

      if (!shinyUrl) {
        if (shinyProcesses.has(key)) {
          const oldProc = shinyProcesses.get(key);
          oldProc.kill();
          shinyProcesses.delete(key);
        }

        const freePort = await findFreePort();
        const shinyApp = await launchShiny(appDir, {
          port: freePort,
          host: "127.0.0.1",
          log: logEvent ? (line) => logEvent(`[shiny] ${line}`) : null,
        });

        shinyUrl = shinyApp.url;
        shinyPid = shinyApp.process.pid;
        shinyProcesses.set(key, shinyApp);
      }

      const url = `http://${hostForUrl(linkHostName)}:${publicPort}/session/${key}`;
      const session = await store.upsertSession(appDir, url, {
        type: "shiny",
        shinyUrl,
        shinyPid,
      });

      if (existing?.status === "ended") {
        clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
      }

      logEvent?.(`shiny session opened key=${key} appDir=${appDir} url=${shinyUrl}`);
      await watchSession(session, watchers, events, logEvent, quartoRenders, shinyProcesses, store);
      res.json({ key, file: appDir, url, status: "opened" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quarto-sessions", async (req, res, next) => {
    try {
      const qmdFile = await canonicalFile(req.body.qmdFile);
      const key = sessionKey(qmdFile);
      const existing = await store.findByKey(key);

      const detect = await detectQuarto();
      if (!detect.ok) {
        res.status(500).json({ error: `Quarto not found: ${detect.error}` });
        return;
      }

      if (await isQuartoShinyFile(qmdFile)) {
        if (shinyProcesses.has(key)) {
          const oldApp = shinyProcesses.get(key);
          oldApp.kill();
          shinyProcesses.delete(key);
        }
        const freePort = await findFreePort();
        const logFn = logEvent ? (line) => logEvent(`[quarto-shiny] ${line}`) : null;
        const quartoShinyApp = await launchQuartoShiny(qmdFile, {
          port: freePort,
          host: "127.0.0.1",
          log: logFn,
        });
        shinyProcesses.set(key, quartoShinyApp);

        const url = `http://${hostForUrl(linkHostName)}:${publicPort}/session/${key}`;
        const session = await store.upsertSession(qmdFile, url, {
          type: "quarto-shiny",
          qmdFile,
          shinyUrl: quartoShinyApp.url,
          shinyPid: quartoShinyApp.process.pid,
        });

        if (existing?.status === "ended") {
          clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
        }

        logEvent?.(`quarto-shiny session opened key=${key} qmdFile=${qmdFile} url=${quartoShinyApp.url}`);
        await watchSession(session, watchers, events, logEvent, quartoRenders, shinyProcesses, store);
        res.json({ key, file: qmdFile, url, status: "opened", type: session.type });
        return;
      }

      if (quartoRenders.has(key)) {
        const oldController = quartoRenders.get(key);
        oldController.abort();
        quartoRenders.delete(key);
      }

      const controller = new AbortController();
      quartoRenders.set(key, controller);

      const logFn = logEvent ? (line) => logEvent(`[quarto] ${line}`) : null;
      const renderResult = await renderQuarto(qmdFile, {
        signal: controller.signal,
        log: logFn,
      });

      quartoRenders.delete(key);

      if (!renderResult.ok) {
        res.status(500).json({ error: `Quarto render failed: ${renderResult.error}` });
        return;
      }

      const htmlFile = renderResult.outputFile;
      const url = `http://${hostForUrl(linkHostName)}:${publicPort}/session/${key}`;
      const session = await store.upsertSession(qmdFile, url, {
        type: "quarto",
        qmdFile,
      });

      if (existing?.status === "ended") {
        clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
      }

      logEvent?.(`quarto session opened key=${key} qmdFile=${qmdFile} htmlFile=${htmlFile}`);
      await watchSession(session, watchers, events, logEvent, quartoRenders, shinyProcesses, store);
      res.json({ key, file: qmdFile, url, status: "opened", type: session.type });
    } catch (error) {
      next(error);
    }
  });

  app.use("/shiny/:key", async (req, res, next) => {
    try {
      const session = await store.findByKey(req.params.key);
      if (!session || (session.type !== "shiny" && session.type !== "quarto-shiny") || !session.shinyUrl) {
        res.status(404).send("Shiny session not found");
        return;
      }
      res.set("cache-control", "no-store, no-cache, must-revalidate, private");
      let cached = proxies.get(session.key);
      if (!cached || cached.shinyUrl !== session.shinyUrl) {
        const proxy = createShinyProxy(session.shinyUrl, session.key);
        cached = { proxy, shinyUrl: session.shinyUrl };
        proxies.set(session.key, cached);
      }
      cached.proxy(req, res, next);
    } catch (err) {
      next(err);
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
      const session = await store.queuePrompts(req.params.key, req.body || {});
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      events.emit("feedback", req.params.key);
      res.json({ status: "queued", pending_prompts: session.pending_prompts });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/end", async (req, res, next) => {
    try {
      const key = req.params.key;
      await store.endSession(key);
      if (shinyProcesses.has(key)) {
        const shinyApp = shinyProcesses.get(key);
        shinyApp.kill();
        shinyProcesses.delete(key);
      }
      if (quartoRenders.has(key)) {
        const controller = quartoRenders.get(key);
        controller.abort();
        quartoRenders.delete(key);
      }
      clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
      events.emit("ended", key);
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

  app.post("/api/end", async (req, res, next) => {
    try {
      const file = await canonicalFile(req.body.file);
      const key = sessionKey(file);
      await store.endSession(key);
      if (shinyProcesses.has(key)) {
        const shinyApp = shinyProcesses.get(key);
        shinyApp.kill();
        shinyProcesses.delete(key);
      }
      if (quartoRenders.has(key)) {
        const controller = quartoRenders.get(key);
        controller.abort();
        quartoRenders.delete(key);
      }
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
      await watchSession(session, watchers, events, logEvent, quartoRenders, shinyProcesses, store);
      res.type("html").send(createChromeHtml(session));
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
      const fileToRead = session.type === "quarto" ? quartoOutputFile(session.file) : session.file;
      const html = await readFile(fileToRead, "utf8");
      res.set("cache-control", "no-store, no-cache, must-revalidate, private");
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

  httpServer.on("upgrade", async (req, socket, head) => {
    const match = req.url.match(/^\/shiny\/([^/]+)/);
    if (match) {
      const key = match[1];
      try {
        const session = await store.findByKey(key);
        if (session && (session.type === "shiny" || session.type === "quarto-shiny") && session.shinyUrl) {
          proxyWebSocket(req, socket, head, session.shinyUrl);
          return;
        }
      } catch {
        // ignore
      }
    }
    socket.destroy();
  });

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const shinyApp of shinyProcesses.values()) {
      try {
        shinyApp.kill();
      } catch {
        // best effort
      }
    }
    shinyProcesses.clear();
    for (const controller of quartoRenders.values()) {
      try {
        controller.abort();
      } catch {
        // best effort
      }
    }
    quartoRenders.clear();
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

export function resolveArtifactAsset(root, assetPath) {
  const file = path.resolve(root, assetPath);
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return file;
}

async function watchSession(
  session,
  watchers,
  events,
  logEvent,
  quartoRenders = null,
  shinyProcesses = null,
  store = null,
) {
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
  let quartoRenderInProgress = false;
  let quartoRenderPending = false;
  let quartoRenderTimer = null;
  let shinyRestartInProgress = false;
  let shinyRestartPending = false;
  let shinyRestartTimer = null;

  async function runQuartoRender() {
    if (quartoRenderInProgress) {
      quartoRenderPending = true;
      return;
    }
    quartoRenderInProgress = true;
    quartoRenderPending = false;
    logEvent?.(`auto-re-rendering quarto for key=${session.key}`);
    const controller = new AbortController();
    quartoRenders.set(session.key, controller);
    try {
      const logFn = logEvent ? (line) => logEvent(`[quarto] ${line}`) : null;
      const renderResult = await renderQuarto(session.qmdFile, {
        signal: controller.signal,
        log: logFn,
      });
      if (renderResult.ok) {
        events.emit("reload", session.key);
      } else {
        logEvent?.(`quarto render failed on watch: ${renderResult.error}`);
      }
    } catch (error) {
      logEvent?.(`quarto render threw on watch: ${error}`);
    } finally {
      quartoRenders.delete(session.key);
      quartoRenderInProgress = false;
      if (quartoRenderPending) {
        clearTimeout(quartoRenderTimer);
        quartoRenderTimer = setTimeout(runQuartoRender, 100);
      }
    }
  }

  async function runShinyRestart() {
    if (shinyRestartInProgress) {
      shinyRestartPending = true;
      return;
    }
    shinyRestartInProgress = true;
    shinyRestartPending = false;
    logEvent?.(`auto-restarting quarto-shiny for key=${session.key}`);
    const oldApp = shinyProcesses.get(session.key);
    const controller = new AbortController();
    if (quartoRenders) {
      quartoRenders.set(session.key, controller);
    }
    try {
      if (oldApp) {
        oldApp.kill();
        shinyProcesses.delete(session.key);
      }
      const logFn = logEvent ? (line) => logEvent(`[quarto-shiny] ${line}`) : null;
      const quartoShinyApp = await launchQuartoShiny(session.qmdFile || session.file, {
        port: oldApp ? oldApp.port : await findFreePort(),
        host: "127.0.0.1",
        log: logFn,
      });
      shinyProcesses.set(session.key, quartoShinyApp);
      if (store) {
        await store.upsertSession(session.file, session.url, {
          type: session.type,
          qmdFile: session.qmdFile,
          shinyUrl: quartoShinyApp.url,
          shinyPid: quartoShinyApp.process.pid,
        });
      }
      events.emit("reload", session.key);
    } catch (error) {
      logEvent?.(`quarto-shiny restart failed: ${error}`);
    } finally {
      if (quartoRenders) {
        quartoRenders.delete(session.key);
      }
      shinyRestartInProgress = false;
      if (shinyRestartPending) {
        clearTimeout(shinyRestartTimer);
        shinyRestartTimer = setTimeout(runShinyRestart, 100);
      }
    }
  }

  watcher.on("all", (event, file) => {
    logEvent?.(`watch event=${event} session=${session.key} file=${file ?? ""}`);
    if (session.type === "quarto" && quartoRenders) {
      clearTimeout(quartoRenderTimer);
      quartoRenderTimer = setTimeout(runQuartoRender, 100);
    } else if (session.type === "quarto-shiny" && shinyProcesses) {
      clearTimeout(shinyRestartTimer);
      shinyRestartTimer = setTimeout(runShinyRestart, 100);
    } else {
      clearTimeout(timer);
      timer = setTimeout(() => events.emit("reload", session.key), 100);
    }
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
  if (session.type === "shiny" || session.type === "quarto-shiny") {
    return {
      path: session.type === "shiny" ? session.file : path.dirname(session.file),
      scope: "directory",
      options: {
        ...baseOptions,
        ignored: (filePath) => {
          if (
            /(^|[/\\])(\.git|node_modules|dist|build|\.lavish-axi|\.Rproj\.user|rsconnect|\.Rhistory|_freeze|_site|.*_files)([/\\]|$)/.test(
              filePath,
            )
          ) {
            return true;
          }
          if (/\.knit\.md$|\.utf8\.md$/.test(filePath)) {
            return true;
          }
          if (session.type === "quarto-shiny") {
            try {
              if (path.resolve(filePath) === quartoOutputFile(session.qmdFile || session.file)) {
                return true;
              }
            } catch {
              // ignore resolve error
            }
          }
          return false;
        },
      },
    };
  }
  if (session.type === "quarto") {
    const qmdDir = path.dirname(session.qmdFile);
    return {
      path: qmdDir,
      scope: "directory",
      options: {
        ...baseOptions,
        ignored: (filePath) => {
          if (/(^|[/\\])(\.git|node_modules|dist|build|\.lavish-axi|_freeze|_site|.*_files)([/\\]|$)/.test(filePath)) {
            return true;
          }
          if (/\.knit\.md$|\.utf8\.md$/.test(filePath)) {
            return true;
          }
          try {
            if (path.resolve(filePath) === quartoOutputFile(session.qmdFile || session.file)) {
              return true;
            }
          } catch {
            // ignore resolve error
          }
          return false;
        },
      },
    };
  }
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

export function createChromeHtml(session) {
  const sessionJson = jsonScript({ key: session.key, file: session.file, initialChat: session.chat || [] });
  const { head: pathHead, tail: pathTail } = displayPathParts(session.file);
  const isShiny = session.type === "shiny";
  const isQuartoShiny = session.type === "quarto-shiny";
  const isQuarto = session.type === "quarto";
  const iframeSrc = isShiny || isQuartoShiny ? `/shiny/${session.key}/` : `/artifact/${session.key}/index.html`;
  const sandbox =
    isShiny || isQuartoShiny
      ? "allow-scripts allow-forms allow-popups allow-downloads allow-same-origin"
      : "allow-scripts allow-forms allow-popups allow-downloads";
  const reloadText = isShiny || isQuartoShiny ? "Reload app" : isQuarto ? "Re-render & reload" : "Reload artifact";
  let badge = "";
  if (isShiny) {
    badge =
      '<span class="brand-support" style="margin-left:8px;background:rgba(244,201,93,0.15);color:#f4c95d;border:1px solid rgba(244,201,93,0.3);padding:2px 6px;border-radius:4px;font-size:10px;text-transform:uppercase;font-weight:700">Shiny App</span>';
  } else if (isQuartoShiny) {
    badge =
      '<span class="brand-support" style="margin-left:8px;background:rgba(79,191,169,0.15);color:#4fbfad;border:1px solid rgba(79,191,169,0.3);padding:2px 6px;border-radius:4px;font-size:10px;text-transform:uppercase;font-weight:700">Quarto Shiny</span>';
  } else if (isQuarto) {
    badge =
      '<span class="brand-support" style="margin-left:8px;background:rgba(79,191,169,0.15);color:#4fbfad;border:1px solid rgba(79,191,169,0.3);padding:2px 6px;border-radius:4px;font-size:10px;text-transform:uppercase;font-weight:700">Quarto Doc</span>';
  }

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lavish Editor</title>
<link rel="stylesheet" href="/chrome.css">
</head>
<body class="lavish">
<div class="bar"><div class="brand"><span class="brand-mark">Lavish</span><span class="brand-support">Editor</span>${badge}</div><div class="spacer" aria-hidden="true"></div><button class="annotate-switch" id="annotation" type="button" aria-pressed="true"><span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span><span>Annotate</span></button><div class="more-wrap" id="moreWrap"><button class="more-button" id="moreButton" type="button" title="More" aria-haspopup="menu" aria-expanded="false">${chromeIcons.more}</button><div class="menu more-menu" id="moreMenu" hidden><div class="menu-head"><div class="menu-label">Editing</div><button class="menu-file" id="copyPath" type="button" title="Copy path · ${escapeHtml(session.file)}">${chromeIcons.file}<span class="menu-file-text"><span class="path-head">${escapeHtml(pathHead)}</span><span class="path-tail">${escapeHtml(pathTail)}</span></span><span class="copy-hint" id="copyHint"><span class="icon-copy">${chromeIcons.copy}</span><span class="icon-check">${chromeIcons.check}</span><span id="copyHintText">Copy</span></span></button></div><div class="menu-rule"></div><button class="menu-item" id="reloadArtifact" type="button">${chromeIcons.refresh}<span>${reloadText}</span></button><button class="menu-item" id="copySnapshot" type="button">${chromeIcons.camera}<span>Copy DOM snapshot</span></button><div class="menu-rule"></div><button class="menu-item danger" id="end" type="button">${chromeIcons.exit}<span>End session</span></button></div></div></div>
<div class="layout"><div class="frame"><iframe id="artifact" sandbox="${sandbox}" src="${iframeSrc}"></iframe></div><aside class="panel"><h2>Conversation</h2><div class="chat" id="chatLog"></div><div class="composer"><div class="presence-banner" id="presenceBanner" hidden>Your agent is not listening. If this persists, ask your agent to poll for updates from Lavish.</div><div class="annotation-pills" id="annotationPills"></div><textarea id="chatInput" placeholder="Write a message for the agent..."></textarea><div class="actions" id="sendActions"><span class="send-hint" id="sendHint" hidden>Write a message or annotate an element first.</span><div class="split"><button class="button send-main" id="send">Send to Agent</button><button class="button send-caret" id="sendCaret" type="button" title="Send options" aria-haspopup="menu" aria-expanded="false">${chromeIcons.caret}</button></div><div class="menu send-menu" id="sendMenu" hidden><button class="menu-item" id="sendFromMenu" type="button">${chromeIcons.send}<span>Send to Agent</span></button><button class="menu-item danger" id="sendAndEnd" type="button">${chromeIcons.exit}<span>Send &amp; end session</span></button></div></div></div></aside></div>
<div class="ended-overlay" id="endedOverlay" hidden><div class="ended-card"><div class="ended-title">Session ended.<br>Return to your agent to continue.</div><p class="ended-copy">${escapeHtml(session.file)}</p></div></div>
<script id="lavish-session" type="application/json">${sessionJson}</script>
<script src="/chrome-client.js"></script>
</body>
</html>`;
}

export function createSdkJs(key) {
  return `(() => {
const key=${JSON.stringify(key)};
void key;
(${createArtifactSdk.toString()})();
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
