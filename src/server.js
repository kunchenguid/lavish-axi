import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";

import chokidar from "chokidar";
import express from "express";

import { injectLavishSdk } from "./html-transform.js";
import { canonicalFile, SessionStore, sessionKey } from "./session-store.js";

export async function serve({ port, stateFile, version = "" }) {
  const app = express();
  const store = new SessionStore(stateFile);
  const events = new EventEmitter();
  const watchers = new Map();
  const activePolls = new Map();
  const sseClients = new Set();

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
      const url = `http://localhost:${port}/session/${key}`;
      const session = await store.upsertSession(file, url);
      watchSession(session, watchers, events);
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
        res.json(immediate);
        return;
      }
      setPollActive(key, activePolls, events, true);
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(async () => {
              cleanup();
              res.json(await store.takeFeedback(key));
            }, timeoutMs);
      const onFeedback = async (changedKey) => {
        if (changedKey !== key || res.headersSent) {
          return;
        }
        cleanup();
        res.json(await store.takeFeedback(key));
      };
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (timer) clearTimeout(timer);
        events.off("feedback", onFeedback);
        events.off("ended", onFeedback);
        setPollActive(key, activePolls, events, false);
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
      await store.endSession(req.params.key);
      events.emit("ended", req.params.key);
      res.json({ status: "ended" });
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
      events.emit("ended", key);
      res.json({ status: "ended" });
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
      watchSession(session, watchers, events);
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
      res.sendFile(file);
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
      const sendWorking = (key, working) => {
        if (key === req.params.key) {
          res.write(`event: agent-working\ndata: ${JSON.stringify({ working })}\n\n`);
        }
      };
      res.write(`event: chat-sync\ndata: ${JSON.stringify({ chat: session?.chat || [] })}\n\n`);
      res.write(`event: agent-working\ndata: ${JSON.stringify({ working: !activePolls.has(req.params.key) })}\n\n`);
      events.on("reload", sendReload);
      events.on("agent-reply", sendAgentReply);
      events.on("agent-working", sendWorking);
      req.on("close", () => {
        sseClients.delete(res);
        events.off("reload", sendReload);
        events.off("agent-reply", sendAgentReply);
        events.off("agent-working", sendWorking);
      });
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

  const httpServer = await new Promise((resolve) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
  });

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
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

  return {
    port: httpServer.address().port,
    close: async () => {
      shutdown();
      await done;
    },
    done,
  };
}

export function resolveArtifactAsset(root, assetPath) {
  const file = path.resolve(root, assetPath);
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return file;
}

function watchSession(session, watchers, events) {
  if (watchers.has(session.key)) {
    return;
  }
  const root = path.dirname(session.file);
  const watcher = chokidar.watch(root, {
    ignored: /(^|[/\\])(\.git|node_modules|dist|build|\.lavish-axi)([/\\]|$)/,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });
  let timer = null;
  watcher.on("all", () => {
    clearTimeout(timer);
    timer = setTimeout(() => events.emit("reload", session.key), 100);
  });
  watchers.set(session.key, watcher);
}

function setPollActive(key, activePolls, events, active) {
  const count = activePolls.get(key) || 0;
  const nextCount = active ? count + 1 : Math.max(0, count - 1);
  if (nextCount === count) return;
  if (nextCount === 0) {
    activePolls.delete(key);
  } else {
    activePolls.set(key, nextCount);
  }
  if (count > 0 === nextCount > 0) return;
  events.emit("agent-working", key, nextCount === 0);
}

export function createChromeHtml(session) {
  const initialChat = JSON.stringify(session.chat || []);
  const fileInputSize = Math.max(1, session.file.length);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lavish Editor</title>
<style>
:root{--ink-900:#0f1115;--ink-800:#11141a;--ink-700:#171a21;--ink-600:#1c212b;--steel-700:#2a2f3a;--steel-600:#303745;--steel-500:#3c4557;--steel-400:#8c96aa;--steel-300:#aeb6c6;--steel-200:#b9c0cf;--steel-100:#d8deea;--cream-50:#fffbf3;--cream-100:#f7f3ea;--cream-200:#e8e1cf;--brass-500:#f4c95d;--brass-400:#ffd877;--brass-ink:#17130a;--sage-900:#172419;--sage-700:#315f3a;--sage-300:#8fe39e;--amber-900:#25230f;--amber-700:#5d4d1b;--rust-500:#f06464;--bg:var(--ink-900);--bg-panel:var(--ink-800);--bg-bar:var(--ink-700);--bg-elevated:var(--ink-600);--fg:var(--cream-100);--fg-muted:var(--steel-100);--fg-dim:var(--steel-200);--fg-faint:var(--steel-300);--fg-label:var(--steel-400);--border:var(--steel-600);--border-subtle:var(--steel-700);--border-strong:var(--steel-500);--accent:var(--brass-500);--accent-hover:var(--brass-400);--accent-ink:var(--brass-ink);--danger:var(--rust-500);--font-serif:"EB Garamond","Iowan Old Style",Georgia,serif;--font-sans:Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--font-mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--text-xs:12px;--lh-xs:1.35;--text-sm:13px;--lh-sm:1.4;--text-base:14px;--lh-base:1.45;--text-md:16px;--lh-md:1.5;--text-lg:18px;--lh-lg:1.45;--text-xl:22px;--lh-xl:1.3;--text-2xl:28px;--lh-2xl:1.25;--text-3xl:36px;--lh-3xl:1.18;--text-4xl:48px;--lh-4xl:1.1;--text-5xl:64px;--lh-5xl:1.05;--text-display:92px;--lh-display:1;--w-regular:400;--w-medium:500;--w-semi:600;--w-bold:700;--w-brand:750;--track-tight:-.01em;--track-normal:0;--track-brand:.02em;--track-label:.08em;--track-caps:.12em;--space-1:2px;--space-2:4px;--space-3:6px;--space-4:8px;--space-5:10px;--space-6:12px;--space-8:16px;--space-10:20px;--space-12:24px;--space-16:32px;--space-20:40px;--space-24:48px;--space-32:64px;--radius-sm:8px;--radius-md:10px;--radius-lg:12px;--radius-xl:14px;--radius-pill:999px;--hairline:1px solid var(--border);--hairline-subtle:1px solid var(--border-subtle);--shadow-tooltip:0 16px 44px rgba(0,0,0,.35);--shadow-floating:0 20px 70px rgba(0,0,0,.35);--bar-h:56px;--panel-w:360px;--ease:cubic-bezier(.2,.6,.2,1);--dur-fast:120ms;--dur:180ms;--dur-slow:320ms;--annotate-outline:2px solid var(--accent);--annotate-offset:2px}
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%}body{background:var(--bg);color:var(--fg);font-family:var(--font-sans);font-size:var(--text-base);line-height:var(--lh-base);overflow:hidden;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}body.lavish{color-scheme:dark}:focus-visible{outline:var(--annotate-outline);outline-offset:var(--annotate-offset)}.bar{height:var(--bar-h);display:flex;align-items:center;gap:14px;padding:0 var(--space-8);background:var(--bg-bar);border-bottom:var(--hairline-subtle);box-sizing:border-box}.brand{display:flex;align-items:flex-end;height:22px;gap:8px;white-space:nowrap;flex-shrink:0}.brand-mark{font-family:var(--font-serif);font-style:italic;font-size:22px;line-height:1;color:var(--fg)}.brand-support{font-family:var(--font-sans);font-size:10px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:var(--fg-muted);position:relative;top:1px}.divider{width:1px;height:22px;background:var(--border);flex:0 0 auto}.file-wrap{display:flex;align-items:center;height:22px;gap:8px;flex:1 1 auto;min-width:0;color:var(--fg-muted);font-family:var(--font-mono);font-size:12px}.file-input{display:block;min-width:0;width:auto;max-width:100%;border:1px solid var(--border-subtle);border-radius:var(--radius-sm);background:transparent;color:var(--fg-muted);font:inherit;font-family:var(--font-mono);font-size:12px;line-height:1;padding:4px 7px;text-overflow:ellipsis}.copy-button{border:1px solid var(--border);border-radius:var(--radius-sm);background:transparent;color:var(--fg-faint);font:inherit;font-family:var(--font-sans);font-size:11px;font-weight:600;line-height:1;padding:4px 7px;white-space:nowrap;cursor:pointer}.copy-button:hover{color:var(--fg);border-color:var(--border-strong)}.button{border:0;border-radius:var(--radius-md);padding:9px 14px;background:var(--accent);color:var(--accent-ink);font-family:inherit;font-size:var(--text-sm);font-weight:var(--w-bold);white-space:nowrap;cursor:pointer;transition:background 120ms ease-out,color 120ms ease-out,opacity 120ms ease-out,border-color 120ms ease-out}.button:hover:not(:disabled){background:var(--accent-hover)}.button:active:not(:disabled){opacity:.85}.button:disabled{opacity:.55;cursor:not-allowed}.button.secondary{background:var(--border-subtle);color:var(--fg);border:1px solid transparent;font-weight:var(--w-semi)}.button.secondary:hover:not(:disabled){background:var(--border)}.button.annotation-on{border:1px solid var(--accent)}.button.danger{background:transparent;color:var(--danger);border:1px solid var(--danger);font-weight:var(--w-semi)}.button.danger:hover:not(:disabled){background:rgba(240,100,100,.1)}.layout{height:calc(100vh - var(--bar-h));min-height:0;display:grid;grid-template-columns:minmax(0,1fr) var(--panel-w)}.frame{min-width:0;min-height:0;background:#fff}.panel{width:var(--panel-w);border-left:var(--hairline-subtle);background:var(--bg-panel);display:flex;flex-direction:column;min-width:0;min-height:0}.panel h2{font-size:15px;line-height:1.3;margin:16px 16px 8px;font-weight:var(--w-semi);letter-spacing:0}.chat{flex:1;min-height:0;overflow:auto;padding:0 16px 12px;display:flex;flex-direction:column;gap:10px}.bubble{max-width:85%;border-radius:var(--radius-xl);padding:10px 12px;background:var(--bg-elevated);border:var(--hairline);color:var(--fg)}.bubble.user{align-self:flex-end;background:var(--bg-elevated);border-color:var(--border-strong)}.bubble.agent{align-self:flex-start;background:transparent;border-color:var(--border-subtle)}.bubble.agent-working{display:flex;align-items:center;gap:8px;color:var(--fg-muted)}.spinner{width:14px;height:14px;border-radius:var(--radius-pill);border:2px solid var(--border);border-top-color:var(--accent);animation:spin .8s linear infinite;flex:0 0 auto}.bubble small{display:block;color:var(--fg-faint);margin-bottom:4px;font-size:10px;font-weight:var(--w-bold);letter-spacing:var(--track-label);text-transform:uppercase}.bubble.user small{text-align:right}@keyframes spin{to{transform:rotate(360deg)}}.composer{display:grid;gap:8px;padding:12px 16px;border-top:var(--hairline-subtle);min-width:0;flex-shrink:0;box-sizing:border-box}.annotation-pills{display:flex;flex-wrap:wrap;gap:6px;min-width:0}.pill-wrap{position:relative;max-width:100%}.pill{display:flex;align-items:center;gap:6px;max-width:100%;border:1px solid var(--border-strong);border-radius:var(--radius-pill);background:var(--bg-elevated);color:var(--fg-muted);padding:5px 7px 5px 11px;font-size:12px;font-weight:var(--w-bold)}.pill-preview{display:block;max-width:220px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.pill-close{width:18px;height:18px;border:0;border-radius:var(--radius-pill);padding:0;background:var(--border);color:var(--fg-muted);line-height:18px;font-size:14px;cursor:pointer}.pill-tooltip{display:none;position:absolute;z-index:5;left:0;bottom:calc(100% + 8px);width:min(320px,80vw);border:1px solid var(--border-strong);border-radius:var(--radius-lg);background:var(--bg-bar);color:var(--fg-muted);padding:10px;font-size:12px;font-weight:500;box-shadow:var(--shadow-tooltip)}.tooltip-label{color:var(--fg-label);font-size:10px;font-weight:900;letter-spacing:var(--track-label);text-transform:uppercase;margin:0 0 4px}.pill-tooltip-target{font-family:var(--font-mono);background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px;margin-bottom:8px;overflow-wrap:anywhere}.pill-tooltip-prompt{white-space:pre-wrap;overflow-wrap:anywhere}.pill-wrap:hover .pill-tooltip,.pill-wrap:focus-within .pill-tooltip{display:block}.composer textarea{width:100%;max-width:100%;min-width:0;min-height:82px;resize:vertical;border-radius:var(--radius-lg);border:1px solid var(--border);background:var(--bg);color:var(--fg);padding:10px;font:inherit;font-family:var(--font-sans);box-sizing:border-box}.composer textarea::placeholder{color:var(--fg-label)}.actions{display:flex;gap:8px;justify-content:flex-end}.ended-view{height:calc(100vh - var(--bar-h));display:grid;place-items:center;padding:24px;background:var(--bg)}.ended-card{width:min(360px,100%);border:1px solid var(--border);border-radius:var(--radius-xl);background:var(--bg-panel);padding:20px 24px;text-align:center}.ended-title{font-family:var(--font-serif);font-style:italic;font-size:26px;line-height:1.2;color:var(--fg);margin-bottom:8px}.ended-copy{margin:0;color:var(--fg-faint);font-family:var(--font-mono);font-size:12px;line-height:1.45}iframe{width:100%;height:100%;border:0;background:white}
@media (max-width:860px){body{overflow:auto}.bar{min-height:var(--bar-h);height:auto;align-items:flex-start;flex-wrap:wrap;padding:10px 12px}.divider{display:none}.file-wrap{order:3;flex-basis:100%;font-size:11px}.layout{height:calc(100vh - var(--bar-h));grid-template-columns:1fr;grid-template-rows:minmax(0,1fr) min(42vh,360px)}.panel{width:100%;border-left:0;border-top:var(--hairline-subtle)}.chat{padding-bottom:10px}.pill-preview{max-width:min(220px,70vw)}}
</style>
</head>
<body class="lavish">
<div class="bar"><div class="brand"><span class="brand-mark">Lavish</span><span class="brand-support">Editor</span></div><div class="divider" aria-hidden="true"></div><div class="file-wrap" title="${escapeHtml(session.file)}"><input class="file-input" id="filePath" readonly size="${fileInputSize}" value="${escapeHtml(session.file)}"><button class="copy-button" id="copyPath" type="button">Copy Path</button></div><button class="button secondary annotation-on" id="annotation">Annotation: On</button><button class="button danger" id="end">End Session</button></div>
<div class="layout"><div class="frame"><iframe id="artifact" sandbox="allow-scripts allow-forms allow-popups allow-downloads" src="/artifact/${session.key}/index.html"></iframe></div><aside class="panel"><h2>Conversation</h2><div class="chat" id="chatLog"></div><div class="composer"><div class="annotation-pills" id="annotationPills"></div><textarea id="chatInput" placeholder="Write a message for the agent..."></textarea><div class="actions"><button class="button" id="send">Send to Agent</button></div></div></aside></div>
<script>
const key=${JSON.stringify(session.key)};
const initialChat=${initialChat};
const frame=document.getElementById('artifact');
const annotationPills=document.getElementById('annotationPills');
const chatLog=document.getElementById('chatLog');
const chatInput=document.getElementById('chatInput');
const sendButton=document.getElementById('send');
const filePathInput=document.getElementById('filePath');
const copyPathButton=document.getElementById('copyPath');
const queued=[];
let annotation=true;
let agentPolling=false;
let pendingSnapshot='';
let workingBubble=null;
function render(){annotationPills.innerHTML=queued.map((p,i)=>'<div class="pill-wrap"><div class="pill"><span class="pill-preview">'+escapeHtml(p.prompt)+'</span><button class="pill-close" type="button" aria-label="Remove queued prompt" onclick="removeQueuedPrompt('+i+',event)">×</button></div><div class="pill-tooltip">'+(p.selector?'<div class="tooltip-label">Target</div><div class="pill-tooltip-target">'+escapeHtml(p.selector)+'</div>':'')+'<div class="tooltip-label">Prompt</div><div class="pill-tooltip-prompt">'+escapeHtml(p.prompt)+'</div></div></div>').join('')}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function addChat(role,text){if(!text)return;const el=document.createElement('div');el.className='bubble '+role;el.innerHTML='<small>'+(role==='agent'?'Agent':'You')+'</small><div>'+escapeHtml(text)+'</div>';chatLog.appendChild(el);chatLog.scrollTop=chatLog.scrollHeight}
function syncChat(chat){for(const el of [...chatLog.querySelectorAll('.bubble.user,.bubble.agent:not(.agent-working)')])el.remove();for(const item of chat)addChat(item.role,item.text);if(workingBubble)chatLog.appendChild(workingBubble);chatLog.scrollTop=chatLog.scrollHeight}
function setAgentPolling(active){agentPolling=!!active;sendButton.disabled=!agentPolling;if(agentPolling){if(workingBubble)workingBubble.remove();workingBubble=null;return}if(!workingBubble){workingBubble=document.createElement('div');workingBubble.className='bubble agent agent-working';workingBubble.innerHTML='<span class="spinner"></span><span>Working...</span>';chatLog.appendChild(workingBubble)}chatLog.scrollTop=chatLog.scrollHeight}
function removeQueuedPrompt(index,event){if(event)event.stopPropagation();queued.splice(index,1);render()}
function postToFrame(message){frame.contentWindow&&frame.contentWindow.postMessage(message,'*')}
window.addEventListener('message',event=>{if(event.source!==frame.contentWindow)return;const msg=event.data||{};if(msg.type==='lavish:queuePrompt'){queued.push(msg.prompt);render()}if(msg.type==='lavish:snapshot'){pendingSnapshot=msg.snapshot||'';submitQueued()}if(msg.type==='lavish:sendQueuedPrompts'){sendQueued()}if(msg.type==='lavish:endSession'){endSession()}});
document.getElementById('annotation').onclick=()=>{annotation=!annotation;document.getElementById('annotation').textContent='Annotation: '+(annotation?'On':'Off');document.getElementById('annotation').classList.toggle('annotation-on',annotation);postToFrame({type:'lavish:setAnnotationMode',enabled:annotation})};
async function copyFilePath(){try{await navigator.clipboard.writeText(filePathInput.value)}catch{filePathInput.select();document.execCommand('copy')}copyPathButton.textContent='Copied';setTimeout(()=>{copyPathButton.textContent='Copy Path'},1200)}
sendButton.onclick=sendQueued;copyPathButton.onclick=copyFilePath;document.getElementById('end').onclick=endSession;
frame.addEventListener('load',()=>postToFrame({type:'lavish:setAnnotationMode',enabled:annotation}));
function sendQueued(){if(!agentPolling)return;const text=chatInput.value.trim();if(text){queued.push({uid:'',prompt:text,selector:'',tag:'message',text:'Freeform message'});addChat('user',text);chatInput.value='';render()}if(!queued.length)return;postToFrame({type:'lavish:requestSnapshot'})}
async function submitQueued(){const prompts=queued.splice(0,queued.length);render();setAgentPolling(false);await fetch('/api/'+key+'/prompts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompts,domSnapshot:pendingSnapshot})})}
async function endSession(){await fetch('/api/'+key+'/end',{method:'POST'});document.body.innerHTML='<div class="bar"><div class="brand"><span class="brand-mark">Lavish</span><span class="brand-support">Editor</span></div></div><main class="ended-view"><section class="ended-card"><div class="ended-title">Session ended.</div><p class="ended-copy">Return to your agent to continue.</p></section></main>'}
async function reloadAfterServerRestart(){let sawOutage=false;const deadline=Date.now()+5000;while(Date.now()<deadline){try{const res=await fetch('/health',{cache:'no-store'});if(sawOutage&&res.ok){location.reload();return}}catch{sawOutage=true}await new Promise(resolve=>setTimeout(resolve,100))}location.reload()}
const events=new EventSource('/events/'+key);events.addEventListener('reload',()=>{frame.src=frame.src});events.addEventListener('chrome-reload',()=>{reloadAfterServerRestart()});events.addEventListener('agent-reply',event=>addChat('agent',JSON.parse(event.data).text));events.addEventListener('chat-sync',event=>syncChat(JSON.parse(event.data).chat||[]));events.addEventListener('agent-working',event=>setAgentPolling(!JSON.parse(event.data).working));render();initialChat.forEach(item=>addChat(item.role,item.text));setAgentPolling(false);
</script>
</body>
</html>`;
}

export function createSdkJs(key) {
  return `(() => {
const key=${JSON.stringify(key)};
let annotationMode=true;
let hovered=null;
let selected=null;
let host=null;
let shadow=null;
let counter=0;
const ids=new WeakMap();
function uid(el){if(!ids.has(el))ids.set(el,String(++counter));return ids.get(el)}
function selector(el){if(!el||!el.tagName)return'';const parts=[];let node=el;while(node&&node.nodeType===1&&parts.length<5){let part=node.tagName.toLowerCase();if(node.id){part+='#'+CSS.escape(node.id);parts.unshift(part);break}const parent=node.parentElement;if(parent){const same=[...parent.children].filter(x=>x.tagName===node.tagName);if(same.length>1)part+=':nth-of-type('+(same.indexOf(node)+1)+')'}parts.unshift(part);node=parent}return parts.join(' > ')}
function context(el){return{uid:uid(el),selector:selector(el),tag:(el.tagName||'').toLowerCase(),text:(el.innerText||el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,240)}}
function isLavishUi(el){return !!(el&&el.closest&&el.closest('[data-lavish-ui]'))}
function highlightElement(el){if(el){el.style.outline='var(--lavish-annotate-outline,2px solid #f4c95d)';el.style.outlineOffset='var(--lavish-annotate-offset,2px)'}}
function clearHighlight(el){if(el)el.style.outline=''}
function setAnnotationMode(enabled){annotationMode=!!enabled;let style=document.getElementById('lavish-cursor-style');if(annotationMode&&!style){style=document.createElement('style');style.id='lavish-cursor-style';style.textContent=':root{--lavish-accent:#f4c95d;--lavish-annotate-outline:2px solid var(--lavish-accent);--lavish-annotate-offset:2px}*{cursor:default!important}';document.head.appendChild(style)}if(!annotationMode&&style)style.remove();if(!annotationMode)closeCard()}
function queuePrompt(prompt,options={}){const item={...context(options.element||document.activeElement||document.body),prompt:String(prompt||'')};if(options.uid)item.uid=String(options.uid);if(options.selector)item.selector=String(options.selector);if(options.tag)item.tag=String(options.tag);if(options.text)item.text=String(options.text);if(options.data)item.prompt+='\\n\\nContext data:\\n'+JSON.stringify(options.data,null,2);parent.postMessage({type:'lavish:queuePrompt',prompt:item},'*')}
function sendQueuedPrompts(){parent.postMessage({type:'lavish:sendQueuedPrompts'},'*')}
function endSession(){parent.postMessage({type:'lavish:endSession'},'*')}
function snapshot(){const lines=[];function walk(el,depth){if(!(el instanceof Element)||depth>6||isLavishUi(el))return;const c=context(el);const name=c.text?' "'+c.text.slice(0,80).replace(/"/g,"'")+'"':'';lines.push('  '.repeat(depth)+'uid='+c.uid+' '+c.tag+name);for(const child of el.children)walk(child,depth+1)}walk(document.body,0);return lines.join('\\n')}
function ensureShadow(){if(shadow)return shadow;host=document.createElement('div');host.className='lavish-annotation-root';host.setAttribute('data-lavish-ui','annotation-root');document.documentElement.appendChild(host);shadow=host.attachShadow({mode:'open'});const style=document.createElement('style');style.textContent=':host{all:initial;position:fixed;z-index:2147483647;left:0;top:0;color-scheme:dark;--ink-900:#0f1115;--ink-800:#11141a;--ink-700:#171a21;--ink-600:#1c212b;--steel-700:#2a2f3a;--steel-600:#303745;--steel-500:#3c4557;--steel-400:#8c96aa;--steel-300:#aeb6c6;--steel-200:#b9c0cf;--steel-100:#d8deea;--cream-50:#fffbf3;--cream-100:#f7f3ea;--cream-200:#e8e1cf;--brass-500:#f4c95d;--brass-400:#ffd877;--brass-ink:#17130a;--bg:var(--ink-900);--bg-panel:var(--ink-800);--bg-elevated:var(--ink-600);--fg:var(--cream-100);--fg-faint:var(--steel-300);--border:var(--steel-600);--accent:#f4c95d;--accent-hover:#ffd877;--font-sans:Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--font-mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--radius-md:10px;--radius-xl:14px;--shadow-floating:0 20px 70px rgba(0,0,0,.35);font-family:var(--font-sans)}*{box-sizing:border-box}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.lavish-annotation-card{position:fixed;width:min(320px,calc(100vw - 24px));padding:12px;border-radius:var(--radius-xl);background:var(--bg-panel);color:var(--fg);border:1px solid var(--accent);box-shadow:var(--shadow-floating);font:14px/1.4 var(--font-sans)}.lavish-heading{font-weight:700;margin-bottom:6px}.lavish-annotation-card textarea{width:100%;min-height:86px;resize:vertical;border-radius:var(--radius-md);border:1px solid var(--border);background:var(--bg);color:var(--fg);padding:9px;font:inherit;font-family:var(--font-sans)}.lavish-annotation-card textarea::placeholder{color:var(--fg-faint)}.lavish-annotation-card .lavish-row{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}.lavish-annotation-card button{border:0;border-radius:var(--radius-md);padding:8px 10px;font-family:var(--font-sans);font-size:13px;font-weight:700;cursor:pointer}.lavish-annotation-card button:active{opacity:.85}.lavish-annotation-card .lavish-send{background:var(--accent);color:var(--brass-ink)}.lavish-annotation-card .lavish-send:hover{background:var(--accent-hover)}.lavish-annotation-card .lavish-cancel{background:var(--steel-700);color:var(--fg)}';shadow.appendChild(style);return shadow}
function closeCard(){if(shadow){for(const el of [...shadow.querySelectorAll('.lavish-annotation-card')])el.remove()}clearHighlight(selected);selected=null}
function showAnnotationCard(target){const root=ensureShadow();closeCard();selected=target;highlightElement(selected);const c=context(target);const rect=target.getBoundingClientRect();const card=document.createElement('div');card.className='lavish-annotation-card';card.innerHTML='<div class="lavish-heading">Annotate &lt;'+c.tag+'&gt;</div><textarea placeholder="Tell the agent what to change about this element..."></textarea><div class="lavish-row"><button class="lavish-cancel" type="button">Cancel</button><button class="lavish-send" type="button">Queue</button></div>';root.appendChild(card);const left=Math.min(Math.max(12,rect.left),window.innerWidth-card.offsetWidth-12);const top=Math.min(Math.max(12,rect.bottom+8),window.innerHeight-card.offsetHeight-12);card.style.left=left+'px';card.style.top=top+'px';const textarea=card.querySelector('textarea');card.querySelector('.lavish-cancel').onclick=closeCard;card.querySelector('.lavish-send').onclick=()=>{const prompt=textarea.value.trim();if(prompt)queuePrompt(prompt,c);closeCard()};setTimeout(()=>textarea.focus(),0)}
window.lavish={queuePrompt,sendQueuedPrompts,endSession,getQueuedPrompts:()=>[],setStatus:message=>parent.postMessage({type:'lavish:status',message:String(message)},'*'),snapshot};
window.addEventListener('message',event=>{const msg=event.data||{};if(msg.type==='lavish:setAnnotationMode')setAnnotationMode(msg.enabled);if(msg.type==='lavish:requestSnapshot')parent.postMessage({type:'lavish:snapshot',snapshot:snapshot()},'*')});
document.addEventListener('mouseover',event=>{if(!annotationMode||isLavishUi(event.target))return;if(event.target===selected)return;if(hovered&&hovered!==selected)clearHighlight(hovered);hovered=event.target;highlightElement(hovered)},true);
document.addEventListener('mouseout',()=>{if(hovered&&hovered!==selected){clearHighlight(hovered);hovered=null}},true);
document.addEventListener('click',event=>{if(!annotationMode||isLavishUi(event.target))return;event.preventDefault();event.stopPropagation();showAnnotationCard(event.target)},true);
setAnnotationMode(annotationMode);
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
