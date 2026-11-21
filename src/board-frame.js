/* global document, window, location, FileReader, CSS, HTMLElement */

// Board canvas inside the whiteboard frame. The artifact SDK mounts this frame
// over a board file (`[data-hilight-board]`) with diagramIndex
// BOARD_SCENE_INDEX; the chrome authenticates it like any inline whiteboard and
// sends `lavish-whiteboard:init` with a `board` model instead of a Mermaid
// source. Every card is an Excalidraw `embeddable` whose content this module
// renders; everything else on the canvas is the reviewer's marks.
//
// Layering: the cards render beneath a transparent Excalidraw canvas, so a mark
// drawn over a card stays visible. A card comes to the front only while the
// reviewer interacts with it (Excalidraw's "active" embeddable).
//
// The frame talks to two windows. The chrome (window.top) owns persistence and
// prompts, exactly as for Mermaid whiteboards. The artifact SDK (window.parent)
// gets card geometry and comment requests so margin threads and the annotation
// card work over the canvas; it may send view-only commands back (reveal a
// card, thread counts).

import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
  exportToBlob,
  getCommonBounds,
  restore,
  restoreElements,
  sceneCoordsToViewportCoords,
} from "@excalidraw/excalidraw";
import React from "react";
import { createRoot } from "react-dom/client";
import "./board-frame.css";

import {
  CARD_LINK_PREFIX,
  CODE_CARD_LAYOUT,
  HTML_CARD_LAYOUT,
  NOTE_LAYOUT,
  applyHtmlCardMeasurements,
  buildHtmlCardSrcdoc,
  cardGeometryKey,
  codeNoteHeight,
  codeRows,
  cardElementId,
  cardIdOfElement,
  canScrollBy,
  createLinkElements,
  diffCodeLines,
  elementLevel,
  flowSteps,
  freshSince,
  isCardElement,
  isLinkElement,
  isSmallCanvas,
  knownAfter,
  linkLandings,
  reconcileLevelElements,
  similarCanvasSize,
  stackTopFloaters,
  stepSignature,
  summarizeBoardMarks,
  tagLevel,
  usableSavedView,
  wheelIntent,
  zoomAround,
} from "./board-core.js";
import { sanitizeSceneLink } from "./whiteboard-core.js";

const h = React.createElement;
const SAVE_DEBOUNCE_MS = 800;
const AUTO_REVEAL_DELAY_MS = 1500;
const AUTO_REVEAL_FALLBACK_MS = 15000;
// Excalidraw tools that only look or point; any other tool means the reviewer is drawing.
const VIEW_TOOLS = new Set(["selection", "hand", "laser"]);
const INK = "#1f6fe0";
const EXCALIFONT = 5;

const STATUS_LABEL = {
  fresh: "Live",
  unpinned: "Unpinned",
  moved: "Moved",
  stale: "Stale",
  missing: "Missing",
  invalid: "Bad reference",
};

const KEYWORDS = new Set(
  (
    "async await break case catch class const continue default delete do else export extends false finally for " +
    "from function if import in instanceof let new null of return static super switch this throw true try typeof " +
    "undefined var void while yield def elif except lambda None True False pass raise with as fn pub mut impl " +
    "struct enum match use type interface package func go defer chan map range nil self"
  ).split(" "),
);
const HASH_COMMENT_LANGS = new Set(["py", "sh", "yaml", "rb"]);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function tokenize(line, lang) {
  const hash = HASH_COMMENT_LANGS.has(lang) ? "|#.*$" : "";
  const pattern = new RegExp(
    `(\\/\\/.*$${hash}|\\/\\*.*?\\*\\/|"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`|\\b\\d[\\d_.]*\\b|[A-Za-z_$][\\w$]*)`,
    "g",
  );
  const parts = [];
  let last = 0;
  let match;
  while ((match = pattern.exec(line))) {
    if (match.index > last) parts.push(["", line.slice(last, match.index)]);
    const token = match[0];
    let cls = "";
    if (token.startsWith("//") || token.startsWith("/*") || (hash && token.startsWith("#"))) cls = "c";
    else if (/^["'`]/.test(token)) cls = "s";
    else if (/^\d/.test(token)) cls = "n";
    else if (KEYWORDS.has(token)) cls = "k";
    else if (line[match.index + token.length] === "(") cls = "f";
    parts.push([cls, token]);
    last = match.index + token.length;
  }
  if (last < line.length) parts.push(["", line.slice(last)]);
  return parts;
}

function mintCardToken() {
  if (typeof window.crypto?.randomUUID === "function") return window.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * @param {any} init the chrome's init message
 * @param {{ post: (message: any) => void }} context
 */
export function startBoard(init, { post }) {
  const s = {
    model: init.board,
    cardsById: new Map(),
    levelsById: new Map(),
    level: "",
    elementsByLevel: new Map(),
    viewByLevel: new Map(),
    files: {},
    api: /** @type {any} */ (null),
    saveTimer: 0,
    teardownFlushId: "",
    flushIds: new Set(),
    queueBusy: false,
    geometryFrame: 0,
    lastGeometry: "",
    selectedCard: "",
    threadCounts: /** @type {Record<string, number>} */ ({}),
    theme: /** @type {"light" | "dark"} */ (init.theme === "dark" ? "dark" : "light"),
    base: `${location.origin}/artifact/${encodeURIComponent(new URL(location.href).searchParams.get("key") || "")}/`,
    switching: false,
    linkStripPending: false,
    admittedCards: new Set(),
    // How far each code card's code is scrolled, so its arrows follow.
    codeScroll: /** @type {Map<string, number>} */ (new Map()),
    // Cards and flow steps the agent added since the reviewer last looked.
    fresh: { cards: /** @type {Set<string>} */ (new Set()), steps: /** @type {Set<string>} */ (new Set()) },
    // Where the reviewer was before the camera went to new cards.
    revealFrom: /** @type {null | { level: string, zoom: number, scrollX: number, scrollY: number }} */ (null),
    // The last view Hilight chose (Fit, the opening view, or a saved view it restored), so a resize can redo it.
    autoView:
      /** @type {null | { kind: "fit" | "opening" | "restored", zoom: number, scrollX: number, scrollY: number, width?: number, height?: number }} */ (
        null
      ),
    lastSetView: /** @type {null | { zoom: number, scrollX: number, scrollY: number }} */ (null),
    revealView: /** @type {null | { zoom: number, scrollX: number, scrollY: number }} */ (null),
    lastSize: { width: 0, height: 0 },
    // The chrome has shown the page, and where the automatic move to new cards is.
    shown: false,
    autoReveal: /** @type {"" | "armed" | "started"} */ (""),
    wheelFrame: 0,
    wheelPending: /** @type {null | { dx: number, dy: number, factor: number, point: { x: number, y: number } }} */ (
      null
    ),
    cardToken: mintCardToken(),
    cardFrames: /** @type {Map<string, any>} */ (new Map()),
    cardSurfaces: /** @type {Map<string, "inherit" | "light" | "dark">} */ (new Map()),
    measuredHeights: /** @type {Map<string, number>} */ (new Map()),
    growGuard: /** @type {Map<string, { count: number, lastHeight: number, at: number }>} */ (new Map()),
    autoLayoutFrame: 0,
  };
  const listeners = new Set();
  let version = 0;
  const notifyCards = () => {
    version++;
    for (const listener of listeners) listener();
  };
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const getVersion = () => version;

  function indexModel(model) {
    s.model = model;
    s.cardsById = new Map(model.cards.map((card) => [card.id, card]));
    s.levelsById = new Map(model.levels.map((level) => [level.id, level]));
    s.landings = linkLandings(model.cards, model.flows);
    s.modelVersion = (s.modelVersion || 0) + 1;
  }
  indexModel(init.board);

  function postParent(message) {
    if (window.parent && window.parent !== window) window.parent.postMessage(message, "*");
  }

  // ---------------------------------------------------------------------------
  // Shell
  document.body.dataset.lavishWhiteboardTheme = s.theme;
  document.body.dataset.hilightBoard = "";
  // The board has no bar of its own. Its title, summary and code-card health
  // go up to the review page's one top bar (postHeader), the note and Queue
  // marks live in the comments panel, and everything else floats on the canvas.
  const iconButton = (title, path) => {
    const button = el("button", { className: "bd-button bd-icon", type: "button", title });
    button.setAttribute("aria-label", title);
    button.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
    return button;
  };
  const drawButton = el("button", { className: "bd-button bd-draw", type: "button", title: "Show the drawing tools" });
  drawButton.setAttribute("aria-pressed", "false");
  drawButton.innerHTML =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg><span>Draw</span>';
  const undoButton = iconButton(
    "Undo (Ctrl+Z)",
    '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  );
  const redoButton = iconButton(
    "Redo (Ctrl+Shift+Z)",
    '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  );
  const zoomOutButton = iconButton("Zoom out", '<path d="M5 12h14"/>');
  const zoomInButton = iconButton("Zoom in", '<path d="M12 5v14M5 12h14"/>');
  const zoomLabel = el("button", { className: "bd-button bd-zoom", type: "button", title: "Reset zoom to 100%" });
  zoomLabel.textContent = "100%";
  const fit = iconButton(
    "Fit the board to the screen",
    '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/>',
  );
  const dockRule = () => el("span", { className: "bd-dock-rule", ariaHidden: "true" });
  // One floating cluster in the bottom-left corner, like Figma's and Excalidraw's own.
  const dock = el(
    "div",
    { className: "bd-dock", role: "toolbar", ariaLabel: "Canvas" },
    drawButton,
    dockRule(),
    undoButton,
    redoButton,
    dockRule(),
    zoomOutButton,
    zoomLabel,
    zoomInButton,
    fit,
  );
  const legend = el("ul", { className: "bd-legend", ariaLabel: "Flows", hidden: true });
  const editor = el("div", { className: "bd-editor" });
  const toolbar = el("div", { className: "bd-cardbar", hidden: true });
  const commentButton = el("button", { type: "button", className: "bd-chip" });
  commentButton.innerHTML =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg><span>Comment</span>';
  const openButton = el("button", { type: "button", className: "bd-chip", textContent: "Open board →" });
  toolbar.append(commentButton, openButton);
  const status = el("div", { className: "bd-status", hidden: true, role: "status" });
  // A small toast on the canvas when the agent added cards or arrows since the reviewer last looked.
  const reveal = el("div", { className: "bd-reveal", hidden: true, role: "status" });
  const revealText = el("p", { className: "bd-reveal-text" });
  const revealShow = el("button", { className: "bd-button bd-primary", type: "button", textContent: "Show me" });
  const revealBack = el("button", { className: "bd-button", type: "button", textContent: "Back to where I was" });
  const revealDone = el("button", { className: "bd-button", type: "button", textContent: "Got it" });
  reveal.append(revealText, revealShow, revealBack, revealDone);
  const shell = el("div", { className: "bd-shell" }, editor, reveal, legend, dock, toolbar, status);
  document.body.append(shell);

  let statusTimer = 0;
  function showStatus(text, { transient = true } = {}) {
    status.textContent = text;
    status.hidden = !text;
    window.clearTimeout(statusTimer);
    if (transient && text) statusTimer = window.setTimeout(() => (status.hidden = true), 4500);
  }

  function levelPath(levelId) {
    const path = [];
    let current = s.levelsById.get(levelId);
    while (current) {
      path.unshift(current);
      current = current.parent === null ? null : s.levelsById.get(current.parent);
    }
    return path;
  }

  // Code-card health in one line, for the review page's status pill.
  function boardHealth() {
    const problems = (Array.isArray(s.model.problems) ? s.model.problems : []).map(String);
    const code = s.model.cards.filter((card) => card.kind === "code" && card.code);
    const drifted = code.filter((card) => ["stale", "moved", "missing", "invalid"].includes(card.code.status));
    const unpinned = code.filter((card) => card.code.status === "unpinned");
    const text = !code.length
      ? ""
      : drifted.length
        ? `${drifted.length} of ${code.length} code cards changed`
        : unpinned.length
          ? `${code.length} code cards · ${unpinned.length} unpinned`
          : `${code.length} code cards match`;
    const detail = !code.length
      ? ""
      : drifted.length
        ? `${drifted.length} of ${code.length} code cards changed since the agent pinned them.`
        : unpinned.length
          ? `${unpinned.length} of ${code.length} code cards show live lines the agent has not pinned yet.`
          : `All ${code.length} code cards still match the code. Every pinned range was re-read from disk when this board opened.`;
    return { text, detail, warn: drifted.length > 0, drifted: drifted[0]?.id || "", problems };
  }

  // The board's title, summary and health live in the review page's top bar.
  function postHeader() {
    const path = levelPath(s.level).map((level) => ({ id: level.id, title: String(level.title || "Board") }));
    const summary = String(s.levelsById.get(s.level)?.summary || "").trim();
    post({ type: "hilight-board:header", path, summary, health: boardHealth() });
  }

  function renderLegend() {
    legend.replaceChildren();
    for (const flow of (s.model.flows || []).filter((item) => item.level === s.level && item.name)) {
      const item = el("li", { className: "bd-legend-item", textContent: flow.name });
      item.style.setProperty("--bd-flow", flow.color);
      legend.append(item);
    }
    legend.hidden = !legend.childElementCount;
  }

  function renderCrumbs() {
    renderLegend();
    postHeader();
  }

  // ---------------------------------------------------------------------------
  // Cards

  function StatusPill({ code }) {
    const label =
      code.status === "moved" && code.moved_to
        ? `Moved to L${code.moved_to.start}–${code.moved_to.end}`
        : STATUS_LABEL[code.status] || code.status;
    return h("span", { className: `bd-pill is-${code.status}`, title: statusTitle(code) }, label);
  }

  function statusTitle(code) {
    if (code.status === "fresh") return "These lines still match what the agent pinned";
    if (code.status === "unpinned") return "Showing live lines; the agent has not pinned them yet";
    if (code.status === "moved") return `The pinned lines now sit at L${code.moved_to.start}-${code.moved_to.end}`;
    if (code.status === "stale") return "These lines changed after the agent wrote this card";
    return code.error || "";
  }

  function ThreadBadge({ id }) {
    const count = s.threadCounts[id] || 0;
    if (!count) return null;
    return h(
      "span",
      { className: "bd-threads", title: `${count} comment thread${count === 1 ? "" : "s"}` },
      h(
        "svg",
        { width: 11, height: 11, viewBox: "0 0 24 24", fill: "currentColor", "aria-hidden": "true" },
        h("path", { d: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" }),
      ),
      String(count),
    );
  }

  function CodeBody({ card }) {
    const code = card.code;
    if (!code.lines?.length) {
      return h("div", { className: "bd-code-empty" }, code.error || "No lines to show.");
    }
    const changed =
      code.status === "stale" && code.snapshot ? new Set(diffCodeLines(code.snapshot, code.lines).changed) : null;
    const landed = s.landings.get(card.id);
    // Rows come from codeRows, the same split the server sized the card with, so
    // long lines wrap (marked with a hook) instead of being clipped at the edge.
    return h(
      "div",
      { className: "bd-code", style: { paddingTop: CODE_CARD_LAYOUT.padTop + "px" } },
      codeRows(code.lines, code.cols).map((row, index) =>
        h(
          "div",
          {
            key: index,
            className:
              "bd-line" +
              (changed?.has(row.index) ? " is-changed" : "") +
              (landed?.has(row.index) ? " is-landing" : "") +
              (row.cont ? " is-cont" : ""),
            style: landed?.has(row.index) ? { "--bd-flow": landed.get(row.index) } : undefined,
          },
          h(
            "span",
            { className: "bd-ln", style: { width: CODE_CARD_LAYOUT.gutter + "px" } },
            row.cont ? "\u21aa" : String(code.start + row.index),
          ),
          h(
            "span",
            { className: "bd-src" },
            tokenize(row.text, code.lang).map(([cls, text], part) =>
              cls ? h("span", { key: part, className: "t" + cls }, text) : text,
            ),
          ),
        ),
      ),
    );
  }

  function BoardBody({ card }) {
    const preview = card.board?.preview || [];
    return h(
      "div",
      { className: "bd-sub" },
      card.note ? h("p", { className: "bd-sub-note" }, card.note) : null,
      h(
        "div",
        { className: "bd-mini" },
        h(
          "svg",
          { viewBox: "0 0 100 62", preserveAspectRatio: "xMidYMid meet", "aria-hidden": "true" },
          preview.map((rect, index) =>
            h("rect", {
              key: index,
              x: 2 + rect.x * 96,
              y: 2 + rect.y * 58,
              width: Math.max(1.5, rect.w * 96),
              height: Math.max(1.5, rect.h * 58),
              rx: 1.4,
              className: "k-" + rect.kind,
            }),
          ),
        ),
      ),
      h("div", { className: "bd-sub-hint" }, "Double-click to open"),
    );
  }

  function HtmlBody({ card }) {
    const srcDoc = React.useMemo(
      () => buildHtmlCardSrcdoc(card, s.model, s.base, { theme: s.theme, token: s.cardToken }),
      [s.model.revision, card.id],
    );
    const bindFrame = React.useCallback(
      (node) => {
        if (node) s.cardFrames.set(card.id, node);
        else s.cardFrames.delete(card.id);
      },
      [card.id],
    );
    return h("iframe", {
      ref: bindFrame,
      className: "bd-html",
      title: card.title || card.id,
      sandbox: "allow-scripts allow-popups",
      srcDoc,
      scrolling: "auto",
      onLoad: () => {
        const frame = s.cardFrames.get(card.id);
        frame?.contentWindow?.postMessage({ type: "hilight-board:cardTheme", token: s.cardToken, theme: s.theme }, "*");
      },
    });
  }

  function CardView({ id, active }) {
    React.useSyncExternalStore(subscribe, getVersion);
    const card = s.cardsById.get(id);
    if (!card) return h("div", { className: "bd-card is-gone" }, "This card is no longer in the board file.");
    const code = card.kind === "code" ? card.code : null;
    const surface = card.kind === "html" ? s.cardSurfaces.get(id) || "inherit" : undefined;
    const meta =
      card.kind === "code" && code
        ? h(
            "div",
            { className: "bd-meta" },
            h(
              "span",
              { className: "bd-ref", title: code.ref },
              code.path,
              h("span", { className: "bd-range" }, ` L${code.start}–${code.end}`),
            ),
            h(StatusPill, { code }),
          )
        : card.kind === "board"
          ? h(
              "div",
              { className: "bd-meta" },
              h(
                "span",
                { className: "bd-pill is-board" },
                `Board · ${card.board?.count || 0} card${card.board?.count === 1 ? "" : "s"}`,
              ),
            )
          : null;
    return h(
      "div",
      {
        className:
          `bd-card k-${card.kind}` +
          (code ? ` is-${code.status}` : "") +
          (active ? " is-active" : "") +
          (s.fresh.cards.has(id) ? " is-new" : "") +
          (s.selectedCard === id ? " is-selected" : ""),
        "data-card": id,
        ...(surface && surface !== "inherit" && surface !== s.theme ? { "data-surface": surface } : {}),
      },
      h(
        "div",
        {
          className: "bd-head" + (meta ? "" : " is-compact"),
          style: meta ? { height: CODE_CARD_LAYOUT.header + "px" } : null,
        },
        h(
          "div",
          { className: "bd-title-row" },
          h("span", { className: "bd-title" }, card.title || card.id),
          s.fresh.cards.has(id) ? h("span", { className: "bd-new-pill" }, "New") : null,
          h(ThreadBadge, { id }),
        ),
        meta,
      ),
      card.kind === "code" && card.note
        ? h(
            "div",
            {
              className: "bd-note-line",
              style: {
                height: codeNoteHeight(card) + "px",
                padding: `${NOTE_LAYOUT.padTop}px ${NOTE_LAYOUT.padX}px 0`,
                WebkitLineClamp: Math.round(
                  (codeNoteHeight(card) - NOTE_LAYOUT.padTop - NOTE_LAYOUT.padBottom) / NOTE_LAYOUT.line,
                ),
              },
              title: card.note,
            },
            card.note,
          )
        : null,
      card.kind === "code"
        ? h(CodeBody, { card })
        : card.kind === "board"
          ? h(BoardBody, { card })
          : h(HtmlBody, { card }),
    );
  }

  function renderEmbeddable(element, appState) {
    const id = cardIdOfElement(element);
    if (!id) return null;
    const active =
      appState?.activeEmbeddable?.element?.id === element.id && appState.activeEmbeddable.state === "active";
    return h(CardView, { id, active });
  }

  // ---------------------------------------------------------------------------
  // Scene

  const savedScene = init.saved?.scene && typeof init.saved.scene === "object" ? init.saved.scene : null;
  const savedElements = Array.isArray(savedScene?.elements) ? savedScene.elements : [];
  s.files = savedScene?.files && typeof savedScene.files === "object" ? savedScene.files : {};
  const savedBoardState = savedScene?.appState?.hilightBoard || {};
  for (const level of s.model.levels) {
    const cards = s.model.cards.filter((card) => card.level === level.id);
    const saved = savedElements.filter((element) => elementLevel(element) === level.id);
    s.elementsByLevel.set(level.id, reconcileLevelElements(cards, saved, s.model.flows));
  }
  // Marks on a nested board the file no longer has are kept, unseen, rather
  // than silently discarded.
  for (const element of savedElements) {
    const level = elementLevel(element);
    if (s.levelsById.has(level)) continue;
    if (!s.elementsByLevel.has(level)) s.elementsByLevel.set(level, []);
    s.elementsByLevel.get(level).push(element);
  }
  if (savedBoardState.views && typeof savedBoardState.views === "object") {
    for (const [level, view] of Object.entries(savedBoardState.views)) {
      if (s.levelsById.has(level) && view && typeof view === "object") s.viewByLevel.set(level, view);
    }
  }
  if (typeof savedBoardState.level === "string" && s.levelsById.has(savedBoardState.level)) {
    s.level = savedBoardState.level;
  }

  // New since the reviewer last looked: cards and flow steps the saved scene
  // did not know about. Unacknowledged items stay new across reloads.
  s.fresh = freshSince(s.model, savedBoardState.known);

  const knownState = () => knownAfter(s.model, s.fresh);

  function restored(elements) {
    return restore({ elements, appState: null, files: s.files }, null, null, { repairBindings: true }).elements;
  }

  function stashLevel() {
    if (!s.api) return;
    const current = s.api
      .getSceneElementsIncludingDeleted()
      .filter((element) => (!element.isDeleted || isCardElement(element)) && !isLinkElement(element))
      .map((element) => JSON.parse(JSON.stringify(element)))
      .map((element) => (isCardElement(element) ? { ...element, link: cardLink(element) } : element));
    s.elementsByLevel.set(s.level, tagLevel(current, s.level));
    // The opening view is not saved: it depends on the window, so the next load works it out
    // again for whatever size that window is. A view the reviewer chose (or Fit) is kept.
    if (s.autoView?.kind === "opening" && onAutoView()) {
      s.viewByLevel.delete(s.level);
      return;
    }
    // A restored view the reviewer has not touched keeps the window size it was saved for.
    if (s.autoView?.kind === "restored" && onAutoView()) return;
    const appState = s.api.getAppState();
    const { width, height } = canvasSize();
    s.viewByLevel.set(s.level, {
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      zoom: appState.zoom,
      width,
      height,
    });
  }

  const savedViewFor = (levelId) => usableSavedView(s.viewByLevel.get(levelId), canvasSize());

  function restoreView(view) {
    s.autoView = { kind: "restored", ...view };
    s.lastSetView = { zoom: view.zoom, scrollX: view.scrollX, scrollY: view.scrollY };
  }

  function allElements() {
    stashLevel();
    return [...s.elementsByLevel.values()].flat();
  }

  function persistencePayload() {
    const elements = allElements();
    const views = Object.fromEntries(s.viewByLevel);
    const view = s.viewByLevel.get(s.level) || {};
    return {
      sourceHash: s.model.revision,
      textMetricsVersion: 0,
      scene: {
        elements,
        appState: { ...view, hilightBoard: { level: s.level, views, known: knownState() } },
        files: s.api?.getFiles() || s.files,
      },
      baseline: null,
    };
  }

  function postSave(flushId = "") {
    if (!s.api) return false;
    post({ type: "lavish-whiteboard:save", ...persistencePayload(), ...(flushId ? { flushId } : {}) });
    return true;
  }

  function scheduleSave() {
    if (s.teardownFlushId || s.switching) return;
    window.clearTimeout(s.saveTimer);
    s.saveTimer = window.setTimeout(() => postSave(), SAVE_DEBOUNCE_MS);
  }

  // ---------------------------------------------------------------------------
  // Geometry for the SDK: viewport rects of the visible level's cards, so margin
  // threads and the annotation card follow cards as the reviewer pans.

  function scheduleGeometry() {
    if (s.geometryFrame) return;
    s.geometryFrame = window.requestAnimationFrame(sendGeometry);
    // The page holds its layout gate until the first geometry arrives, and a window that is not
    // painting (minimised, covered, still behind the gate) runs no animation frames and slows its
    // timers to once a second. So the first one also goes out on a message-channel task, which
    // neither waits for a frame nor gets throttled.
    if (!s.lastGeometry && s.api && s.cardsById.size) {
      afterThisTask(() => {
        if (!s.geometryFrame || s.lastGeometry) return;
        window.cancelAnimationFrame(s.geometryFrame);
        sendGeometry();
      });
    }
  }

  // Runs `run` in a task of its own, like setTimeout(run, 0), but on a message channel: a page
  // that is not painting holds every timer to the next whole second, and a board's first view and
  // geometry are what lift the page's layout gate.
  function afterThisTask(run) {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      run();
    };
    channel.port2.postMessage(null);
  }

  function cardRects() {
    if (!s.api) return {};
    const appState = s.api.getAppState();
    const zoom = appState.zoom.value;
    /** @type {Record<string, number[]>} */
    const rects = {};
    for (const element of s.api.getSceneElements()) {
      const id = cardIdOfElement(element);
      if (!id) continue;
      const { x, y } = sceneCoordsToViewportCoords({ sceneX: element.x, sceneY: element.y }, appState);
      rects[id] = [Math.round(x), Math.round(y), Math.round(element.width * zoom), Math.round(element.height * zoom)];
    }
    return rects;
  }

  // A code or board card cut by the canvas edge or slid under a floating
  // control keeps its header and overview in the part that is still in view.
  function pinHeads(rects) {
    if (!s.api) return;
    const zoom = s.api.getAppState().zoom.value;
    const box = editor.getBoundingClientRect();
    const insets = controlInsets();
    const safe = {
      left: box.left + 8,
      right: box.right - 8,
      top: box.top + insets.top - VIEW_MARGIN + 6,
    };
    for (const node of editor.querySelectorAll(".bd-card.k-code, .bd-card.k-board")) {
      const card = /** @type {HTMLElement} */ (node);
      const rect = rects[card.dataset.card || ""];
      let x = 0;
      let y = 0;
      let w = 0;
      if (rect) {
        const [left, top, width, height] = rect;
        const shownLeft = Math.max(left, safe.left);
        const shownRight = Math.min(left + width, safe.right);
        if ((shownLeft > left || shownRight < left + width) && shownRight - shownLeft >= 180) {
          x = (shownLeft - left) / zoom;
          w = (shownRight - shownLeft) / zoom;
        }
        if (top < safe.top && top + height > safe.top + 120) {
          y = Math.min((safe.top - top) / zoom, height / zoom - 140);
        }
      }
      card.style.setProperty("--bd-pin-x", x + "px");
      card.style.setProperty("--bd-pin-y", Math.max(0, y) + "px");
      if (w) card.style.setProperty("--bd-pin-w", w + "px");
      else card.style.removeProperty("--bd-pin-w");
      // A data attribute, not a class: React owns the card's className.
      if (x || w || y > 0) card.dataset.pinned = y > 0 ? "y" : "x";
      else delete card.dataset.pinned;
    }
  }

  function sendGeometry() {
    s.geometryFrame = 0;
    const rects = cardRects();
    placeToolbar(rects);
    pinHeads(rects);
    // The page only sees the part of each card inside the canvas, so a thread
    // highlight or the comment card never paints over the bar or summary.
    const box = editor.getBoundingClientRect();
    /** @type {Record<string, number[]>} */
    const visible = {};
    for (const [id, [x, y, w, h]] of Object.entries(rects)) {
      const left = Math.max(x, Math.round(box.left));
      const top = Math.max(y, Math.round(box.top));
      const right = Math.min(x + w, Math.round(box.right));
      const bottom = Math.min(y + h, Math.round(box.bottom));
      visible[id] = [left, top, Math.max(0, right - left), Math.max(0, bottom - top)];
    }
    const serialized = JSON.stringify(visible);
    if (serialized === s.lastGeometry) return;
    s.lastGeometry = serialized;
    postParent({ type: "hilight-board:geometry", cards: visible });
  }

  function placeToolbar(rects) {
    const rect = s.selectedCard ? rects[s.selectedCard] : null;
    const card = s.selectedCard ? s.cardsById.get(s.selectedCard) : null;
    if (!rect || !card || s.switching) {
      toolbar.hidden = true;
      return;
    }
    openButton.hidden = card.kind !== "board";
    toolbar.hidden = false;
    const width = toolbar.offsetWidth || 180;
    const left = Math.max(8, Math.min(rect[0] + rect[2] - width, window.innerWidth - width - 8));
    const above = rect[1] - 44;
    toolbar.style.left = left + "px";
    toolbar.style.top = (above < 48 ? rect[1] + 8 : above) + "px";
  }

  function selectedCardId(appState) {
    const ids = Object.keys(appState.selectedElementIds || {}).filter((id) => appState.selectedElementIds[id]);
    if (ids.length !== 1 || !ids[0].startsWith("card:")) return "";
    const element = s.api?.getSceneElements().find((item) => item.id === ids[0]);
    return element ? cardIdOfElement(element) || "" : "";
  }

  function cardLink(element) {
    return CARD_LINK_PREFIX + encodeURIComponent(cardIdOfElement(element) || "");
  }

  // Excalidraw needs a card's link once, to admit it as an embeddable, and then
  // caches that verdict by element id. A linked element also gets a link icon
  // drawn beside it, so the live scene drops the link after that first check.
  // Only cards seen by onChange are stripped: Excalidraw calls onChange after its
  // validation pass, while an element read straight after updateScene may not be
  // validated yet, and stripping it then would leave an empty embed.
  // Stashed and saved copies get the link back (stashLevel), so a reload validates again.
  function stripAdmittedLinks(elements) {
    for (const element of elements) {
      if (isCardElement(element) && element.link) s.admittedCards.add(element.id);
    }
    if (s.linkStripPending || !s.admittedCards.size) return;
    s.linkStripPending = true;
    window.requestAnimationFrame(() => {
      s.linkStripPending = false;
      if (!s.api) return;
      const current = s.api.getSceneElementsIncludingDeleted();
      const strip = (element) => element.link && s.admittedCards.has(element.id);
      if (!current.some(strip)) return;
      s.api.updateScene({
        elements: current.map((element) => (strip(element) ? { ...element, link: null } : element)),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    });
  }

  function onChange(elements, appState) {
    stripAdmittedLinks(elements);
    if (s.switching) return;
    // A tool picked by its keyboard shortcut brings the drawing tools out.
    if (!VIEW_TOOLS.has(appState.activeTool?.type)) setDrawing(true);
    const selected = selectedCardId(appState);
    if (selected !== s.selectedCard) {
      s.selectedCard = selected;
      // A card has no stroke or fill to style, so its selection hides Excalidraw's style panel.
      editor.classList.toggle("is-card-selected", Boolean(selected));
      notifyCards();
      postParent({ type: "hilight-board:select", card: selected });
    }
    scheduleLinks();
    scheduleGeometry();
    scheduleSave();
  }

  // ---------------------------------------------------------------------------
  // Connectors: redrawn from the file whenever a card moves or resizes, or the
  // code under a line anchor changes. Zoom and pan need nothing: the arrows live
  // in scene coordinates with the cards.

  function scheduleLinks() {
    if (s.linkFrame) return;
    s.linkFrame = window.requestAnimationFrame(syncLinks);
  }

  function syncLinks() {
    s.linkFrame = 0;
    if (!s.api || s.switching) return;
    const elements = s.api.getSceneElementsIncludingDeleted();
    const cardElements = elements.filter((element) => isCardElement(element) && elementLevel(element) === s.level);
    const scrolls = [...s.codeScroll].filter(([, top]) => top).join(",");
    const key = `${s.level}#${s.modelVersion}#${s.fresh.steps.size}#${scrolls}#${cardGeometryKey(cardElements)}`;
    if (key === s.linkKey) return;
    s.linkKey = key;
    const cards = s.model.cards.filter((card) => card.level === s.level);
    s.linkVersion = (s.linkVersion || 1) + 1;
    const links = restoreElements(
      createLinkElements(cards, cardElements, s.model.flows, {
        scrollOf: (id) => s.codeScroll.get(id) || 0,
        emphasis: s.fresh.steps,
      }).map((link) => ({ ...link, version: s.linkVersion })),
      null,
    );
    s.api.updateScene({
      elements: [...elements.filter((element) => !isLinkElement(element)), ...links],
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }

  // ---------------------------------------------------------------------------
  // Levels

  async function openLevel(levelId, { animate = true } = {}) {
    if (!s.api || levelId === s.level || !s.levelsById.has(levelId) || s.switching) return;
    const target = s.levelsById.get(levelId);
    const goingIn = target.parent === s.level;
    stashLevel();
    s.switching = true;
    toolbar.hidden = true;
    if (goingIn && animate) {
      const card = s.api.getSceneElements().find((element) => element.id === cardElementId(levelId));
      if (card) {
        s.api.scrollToContent(card, { fitToViewport: true, viewportZoomFactor: 0.9, animate: true, duration: 320 });
        await sleep(300);
      }
    }
    editor.classList.add("is-switching");
    await sleep(120);
    s.level = levelId;
    s.selectedCard = "";
    editor.classList.remove("is-card-selected");
    const view = savedViewFor(levelId);
    s.api.updateScene({
      elements: restored(s.elementsByLevel.get(levelId) || []),
      appState: {
        selectedElementIds: {},
        activeEmbeddable: null,
        ...(view ? { zoom: { value: view.zoom }, scrollX: view.scrollX, scrollY: view.scrollY } : {}),
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    s.api.history?.clear?.();
    if (view) {
      restoreView(view);
      renderZoom(view.zoom);
    } else openingView();
    s.linkKey = "";
    syncLinks();
    renderCrumbs();
    notifyCards();
    editor.classList.remove("is-switching");
    s.switching = false;
    s.lastGeometry = "";
    if (s.measuredHeights.size) scheduleAutoLayout();
    scheduleGeometry();
    scheduleSave();
  }

  // The smallest zoom where card text stays readable (13px body text renders at
  // about 12px), used for the first view of a level.
  const READABLE_ZOOM = 0.93;
  const VIEW_MARGIN = 20;

  // Excalidraw's floating controls (tools, menu, library, zoom and undo, help),
  // measured, so views and pinned card headers keep clear of them.
  // The drawing tools (only while Draw is on), the new-card toast, and the floating dock and legend.
  const TOP_CONTROLS = ".App-toolbar, .bd-reveal";
  const BOTTOM_CONTROLS = ".bd-dock, .bd-legend";

  // The board's own top floaters (the new-card toast) never sit on Excalidraw's top bars: each
  // goes 8px below any bar it would overlap and back to rest when the bar goes (Draw off).
  const TOP_BARS = ".App-toolbar";
  const TOP_FLOAT_REST = 12;
  function placeTopFloaters() {
    const box = shell.getBoundingClientRect();
    const local = (rect) => ({
      left: rect.left - box.left,
      right: rect.right - box.left,
      top: rect.top - box.top,
      bottom: rect.bottom - box.top,
    });
    const floaters = [reveal].filter((node) => !node.hidden);
    if (!floaters.length) return;
    const bars = [...shell.querySelectorAll(TOP_BARS)]
      .filter((node) => !node.closest(".mobile-misc-tools-container"))
      .map((node) => node.getBoundingClientRect())
      .filter((rect) => rect.width && rect.height && rect.top < box.top + box.height / 2)
      .map(local);
    const tops = stackTopFloaters(
      floaters.map((node) => local(node.getBoundingClientRect())),
      bars,
      { rest: TOP_FLOAT_REST, gap: 8 },
    );
    floaters.forEach((node, index) => (node.style.top = `${tops[index]}px`));
  }
  // Excalidraw lays its bars out on its own schedule (a resize, the small-screen layout), so
  // follow its size as well as our own toggles.
  new window.ResizeObserver(() => placeTopFloaters()).observe(editor);

  function controlInsets() {
    const box = editor.getBoundingClientRect();
    let top = 8;
    let bottom = 8;
    for (const node of shell.querySelectorAll(TOP_CONTROLS)) {
      // The small-screen side column (library, lock, hand) runs down the right edge, not across.
      if (node.closest(".mobile-misc-tools-container")) continue;
      const rect = node.getBoundingClientRect();
      if (rect.height && rect.top < box.top + box.height / 2) top = Math.max(top, rect.bottom - box.top);
    }
    for (const node of shell.querySelectorAll(BOTTOM_CONTROLS)) {
      const rect = node.getBoundingClientRect();
      if (rect.height && rect.bottom > box.top + box.height / 2) bottom = Math.max(bottom, box.bottom - rect.top);
    }
    return { top: top + VIEW_MARGIN, bottom: bottom + VIEW_MARGIN, left: VIEW_MARGIN + 4, right: VIEW_MARGIN + 4 };
  }

  // The canvas's own box, read live: Excalidraw's appState size lags a resize.
  function canvasSize() {
    const box = editor.getBoundingClientRect();
    return { width: box.width, height: box.height };
  }

  function fitZoom([minX, minY, maxX, maxY], insets = controlInsets()) {
    const { width, height } = canvasSize();
    return Math.max(
      0.1,
      Math.min(
        1,
        ((width - insets.left - insets.right) / Math.max(1, maxX - minX)) * 0.97,
        ((height - insets.top - insets.bottom) / Math.max(1, maxY - minY)) * 0.97,
      ),
    );
  }

  function setView(zoom, scrollX, scrollY) {
    s.lastSetView = { zoom, scrollX, scrollY };
    s.api.updateScene({
      appState: { zoom: { value: zoom }, scrollX, scrollY },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    renderZoom(zoom);
  }

  function currentView() {
    const appState = s.api.getAppState();
    return { zoom: appState.zoom.value, scrollX: appState.scrollX, scrollY: appState.scrollY };
  }

  // Records the view setView just asked for: Excalidraw's appState still holds the previous view
  // until React commits the update, so reading it back here would remember the wrong one.
  function rememberAutoView(kind) {
    s.autoView = { kind, ...(s.lastSetView || currentView()) };
  }

  // Whether the reviewer is still looking at the view Hilight picked.
  function onAutoView() {
    return onView(s.autoView);
  }

  // Whether the camera is still exactly where Hilight put it (the reviewer has not moved it since).
  function onView(target) {
    if (!target || !s.api) return false;
    const view = currentView();
    return (
      Math.abs(view.zoom - target.zoom) < 1e-4 &&
      Math.abs(view.scrollX - target.scrollX) < 0.5 &&
      Math.abs(view.scrollY - target.scrollY) < 0.5
    );
  }

  function renderZoom(zoom = s.api ? s.api.getAppState().zoom.value : 1) {
    const text = `${Math.round(zoom * 100)}%`;
    if (zoomLabel.textContent !== text) zoomLabel.textContent = text;
  }

  // Glide the camera to a view; a reviewer who prefers reduced motion jumps.
  function animateView(target, duration = 650) {
    if (!s.api) return Promise.resolve();
    window.cancelAnimationFrame(s.cameraFrame || 0);
    const from = currentView();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || duration <= 0) {
      setView(target.zoom, target.scrollX, target.scrollY);
      return Promise.resolve();
    }
    const { width, height } = canvasSize();
    // Interpolate the scene point at the centre, so the camera moves in a straight line.
    const centre = (view) => ({ x: width / 2 / view.zoom - view.scrollX, y: height / 2 / view.zoom - view.scrollY });
    const a = centre(from);
    const b = centre(target);
    const start = window.performance.now();
    return new Promise((resolve) => {
      const step = (now) => {
        const t = Math.min(1, (now - start) / duration);
        const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        const zoom = Math.exp(Math.log(from.zoom) + (Math.log(target.zoom) - Math.log(from.zoom)) * ease);
        const x = a.x + (b.x - a.x) * ease;
        const y = a.y + (b.y - a.y) * ease;
        setView(zoom, width / 2 / zoom - x, height / 2 / zoom - y);
        if (t < 1) s.cameraFrame = window.requestAnimationFrame(step);
        else {
          s.cameraFrame = 0;
          scheduleGeometry();
          resolve(undefined);
        }
      };
      s.cameraFrame = window.requestAnimationFrame(step);
    });
  }

  // Fit the whole level inside the area the floating controls leave free, never
  // past 100%. Computed in one update: scrollToContent applies its state later,
  // so it cannot be adjusted afterwards.
  function fitAll() {
    if (!s.api) return;
    const elements = s.api.getSceneElements();
    if (!elements.length) return;
    const bounds = getCommonBounds(elements);
    const [minX, minY, maxX, maxY] = bounds;
    const { width, height } = canvasSize();
    const insets = controlInsets();
    const zoom = fitZoom(bounds, insets);
    const centerX = insets.left + (width - insets.left - insets.right) / 2;
    const centerY = insets.top + (height - insets.top - insets.bottom) / 2;
    setView(zoom, centerX / zoom - (minX + maxX) / 2, centerY / zoom - (minY + maxY) / 2);
    rememberAutoView("fit");
  }

  // The first view of a level is one a person can read: the whole level when it
  // fits at a readable zoom, otherwise its top row of cards at a readable zoom,
  // starting from the left. Fit still shows everything.
  // Where a reviewer should start on this level: the first card of its first flow, else the
  // top-left card (the intro, in the usual layout).
  function startCard(cards) {
    const ids = new Set(cards.map((card) => card.id));
    for (const flow of (s.model.flows || []).filter((item) => item.level === s.level)) {
      const first = flowSteps([flow])[0];
      if (first && ids.has(cardElementId(first.from.card)))
        return cards.find((card) => card.id === cardElementId(first.from.card));
    }
    return [...cards].sort((a, b) => a.y - b.y || a.x - b.x)[0];
  }

  function startView(cards, insets) {
    const view = cardView(startCard(cards), insets);
    setView(view.zoom, view.scrollX, view.scrollY);
  }

  // One card at a readable zoom: centred when it fits, otherwise its top-left corner in view so its
  // title and first lines can be read.
  function cardView(card, insets) {
    const { width, height } = canvasSize();
    const room = width - insets.left - insets.right;
    const zoom = Math.min(READABLE_ZOOM, Math.max(0.6, room / card.width));
    const scrollX =
      card.width * zoom <= room
        ? (insets.left + room / 2) / zoom - (card.x + card.width / 2)
        : insets.left / zoom - card.x;
    const roomY = height - insets.top - insets.bottom;
    const scrollY =
      card.height * zoom <= roomY
        ? (insets.top + roomY / 2) / zoom - (card.y + card.height / 2)
        : insets.top / zoom - card.y;
    return { zoom, scrollX, scrollY };
  }

  function openingView() {
    if (!s.api) return;
    const elements = s.api.getSceneElements();
    const cards = elements.filter(isCardElement);
    const insets = controlInsets();
    const size = canvasSize();
    if (cards.length && isSmallCanvas(size)) {
      startView(cards, insets);
      rememberAutoView("opening");
      return;
    }
    if (!cards.length || fitZoom(getCommonBounds(elements), insets) >= READABLE_ZOOM) {
      fitAll();
      rememberAutoView("opening");
      return;
    }
    const top = Math.min(...cards.map((card) => card.y));
    const row = cards.filter((card) => card.y < top + 80);
    const [minX, minY, maxX] = getCommonBounds(row);
    const { width } = canvasSize();
    const room = width - insets.left - insets.right;
    const zoom = Math.min(1, Math.max(READABLE_ZOOM, room / Math.max(1, maxX - minX)));
    const scrollX =
      (maxX - minX) * zoom <= room ? (insets.left + room / 2) / zoom - (minX + maxX) / 2 : insets.left / zoom - minX;
    setView(zoom, scrollX, insets.top / zoom - minY);
    rememberAutoView("opening");
  }

  async function revealCard(cardId) {
    const card = s.cardsById.get(cardId);
    if (!card || !s.api) return;
    if (card.level !== s.level) await openLevel(card.level, { animate: false });
    const element = s.api.getSceneElements().find((item) => item.id === cardElementId(cardId));
    if (!element) return;
    s.api.updateScene({
      appState: { selectedElementIds: { [element.id]: true } },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    s.api.scrollToContent(element, { fitToViewport: true, viewportZoomFactor: 0.55, animate: true, duration: 360 });
  }

  // ---------------------------------------------------------------------------
  // New cards: when the agent adds cards or flow steps, the camera goes to them,
  // they are marked New, and the reviewer can go back to where they were.

  const hasFresh = () => s.fresh.cards.size > 0 || s.fresh.steps.size > 0;
  const freshSteps = () => flowSteps(s.model.flows).filter((step) => s.fresh.steps.has(stepSignature(step)));

  function freshLevel() {
    const first = [...s.fresh.cards][0] || freshSteps()[0]?.to.card;
    return s.cardsById.get(first)?.level ?? s.level;
  }

  // The new cards plus both ends of every new step, so a new arrow is seen
  // with the card it comes from.
  function freshFocus() {
    const ids = new Set(s.fresh.cards);
    for (const step of freshSteps()) ids.add(step.from.card).add(step.to.card);
    const cards = s.api
      .getSceneElements()
      .filter((element) => isCardElement(element) && ids.has(cardIdOfElement(element)));
    const fresh = cards.filter((element) => s.fresh.cards.has(cardIdOfElement(element)));
    return { all: cards, fresh: fresh.length ? fresh : cards };
  }

  function revealSummary() {
    const cards = [...s.fresh.cards].map((id) => s.cardsById.get(id)).filter(Boolean);
    const steps = freshSteps();
    const parts = [];
    if (cards.length === 1) parts.push(`a card, “${cards[0].title || cards[0].id}”`);
    else if (cards.length) parts.push(`${cards.length} cards`);
    const flows = [...new Set(steps.map((step) => step.flowName).filter(Boolean))];
    if (steps.length) {
      const arrows = steps.length === 1 ? "an arrow" : `${steps.length} arrows`;
      parts.push(flows.length === 1 ? `${arrows} in ${flows[0]}` : arrows);
    }
    return `The agent added ${parts.join(" and ")}.`;
  }

  // Let the reviewer see where they were for a moment, then go to what is new. The moment starts
  // when the chrome reports the page shown, not at mount: its layout gate can cover the board for
  // seconds, and a camera move behind it would be missed.
  function startAutoReveal() {
    if (s.autoReveal !== "armed") return;
    s.autoReveal = "started";
    window.setTimeout(() => {
      if (reveal.dataset.stage === "pending") showFresh({ duration: 900 });
    }, AUTO_REVEAL_DELAY_MS);
  }

  function renderReveal(stage) {
    reveal.hidden = !hasFresh();
    if (reveal.hidden) return;
    reveal.dataset.stage = stage;
    revealText.replaceChildren(el("strong", { textContent: "New " }), document.createTextNode(revealSummary()));
    revealShow.hidden = stage === "shown";
    revealShow.textContent = stage === "back" ? "Show the new card again" : "Show me";
    revealBack.hidden = stage !== "shown" || !s.revealFrom;
    placeTopFloaters();
  }

  async function showFresh({ duration = 650 } = {}) {
    if (!s.api || !hasFresh()) return;
    if (!s.revealFrom) s.revealFrom = { level: s.level, ...currentView() };
    const level = freshLevel();
    if (level !== s.level) await openLevel(level, { animate: false });
    const focus = freshFocus();
    if (!focus.all.length) return;
    const insets = controlInsets();
    let bounds = getCommonBounds(focus.all);
    let zoom = Math.min(1, fitZoom(bounds, insets));
    // Too far apart to read together: frame the new cards alone.
    if (zoom < 0.5) {
      bounds = getCommonBounds(focus.fresh);
      zoom = Math.min(1, fitZoom(bounds, insets));
    }
    const [minX, minY, maxX, maxY] = bounds;
    const { width, height } = canvasSize();
    const centreX = insets.left + (width - insets.left - insets.right) / 2;
    const centreY = insets.top + (height - insets.top - insets.bottom) / 2;
    renderReveal("shown");
    // Still unreadable (a small window, a tall card): go to the first new card at a readable zoom.
    const target =
      zoom < 0.5
        ? cardView(focus.fresh[0], insets)
        : { zoom, scrollX: centreX / zoom - (minX + maxX) / 2, scrollY: centreY / zoom - (minY + maxY) / 2 };
    s.revealView = target;
    await animateView(target, duration);
  }

  async function backToWhereIWas() {
    const from = s.revealFrom;
    if (!from || !s.api) return;
    if (from.level !== s.level) await openLevel(from.level, { animate: false });
    renderReveal("back");
    await animateView(from);
  }

  function acknowledgeFresh() {
    s.fresh.cards.clear();
    s.fresh.steps.clear();
    s.revealFrom = null;
    renderReveal("done");
    notifyCards();
    scheduleLinks();
    scheduleSave();
  }

  revealShow.onclick = () => showFresh();
  revealBack.onclick = () => backToWhereIWas();
  revealDone.onclick = () => acknowledgeFresh();

  // ---------------------------------------------------------------------------
  // Trackpad and wheel. One handler for every input: two-finger scroll pans,
  // pinch (and ctrl or cmd + wheel) zooms around the pointer, spikes are
  // clamped, and events are applied once per frame so momentum stays smooth.
  // Scrolling over code that can still scroll moves the code instead.

  function codeScrollerAt(x, y, dx, dy) {
    const card = cardAtPoint(x, y);
    if (card?.kind !== "code") return null;
    const code = editor.querySelector(`.bd-card[data-card="${CSS.escape(card.id)}"] .bd-code`);
    if (!(code instanceof HTMLElement)) return null;
    const box = code.getBoundingClientRect();
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) return null;
    return canScrollBy(code, dx, dy) ? code : null;
  }

  function applyWheel() {
    s.wheelFrame = 0;
    const pending = s.wheelPending;
    s.wheelPending = null;
    if (!pending || !s.api) return;
    let view = currentView();
    if (pending.factor !== 1) view = zoomAround(view, pending.factor, pending.point);
    setView(view.zoom, view.scrollX - pending.dx / view.zoom, view.scrollY - pending.dy / view.zoom);
    scheduleGeometry();
  }

  function onWheel(event) {
    if (!s.api || s.switching) return;
    const box = editor.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)
      return;
    const target = /** @type {Element | null} */ (event.target);
    // Excalidraw's own text editor and dialogs keep their wheel.
    if (target?.closest?.(".excalidraw-wysiwyg, .Modal, .Island, .dropdown-menu, .sidebar")) return;
    const intent = wheelIntent(event, { pageHeight: box.height });
    event.preventDefault();
    event.stopImmediatePropagation();
    window.cancelAnimationFrame(s.cameraFrame || 0);
    if (intent.kind === "pan") {
      const code = codeScrollerAt(event.clientX, event.clientY, intent.dx, intent.dy);
      if (code) {
        const zoom = s.api.getAppState().zoom.value;
        code.scrollTop += intent.dy / zoom;
        code.scrollLeft += intent.dx / zoom;
        return;
      }
    }
    const pending = (s.wheelPending ||= { dx: 0, dy: 0, factor: 1, point: { x: 0, y: 0 } });
    if (intent.kind === "zoom") {
      pending.factor *= intent.factor;
      pending.point = { x: event.clientX - box.left, y: event.clientY - box.top };
    } else {
      pending.dx += intent.dx;
      pending.dy += intent.dy;
    }
    if (!s.wheelFrame) s.wheelFrame = window.requestAnimationFrame(applyWheel);
  }
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });

  // Code that scrolls carries its arrows' ends with it.
  editor.addEventListener(
    "scroll",
    (event) => {
      const code = /** @type {Element | null} */ (event.target);
      if (!(code instanceof HTMLElement) || !code.classList.contains("bd-code")) return;
      const id = code.closest(".bd-card")?.getAttribute("data-card");
      if (!id) return;
      s.codeScroll.set(id, code.scrollTop);
      scheduleLinks();
    },
    true,
  );

  // A resize (the comments margin opening or folding, a window resize) redoes
  // the view Hilight picked, or keeps the centre of a view the reviewer chose,
  // so cards near the right edge do not slide under the margin.
  function onResize() {
    window.requestAnimationFrame(() => {
      if (!s.api) return;
      const size = canvasSize();
      const before = s.lastSize;
      s.lastSize = size;
      if (!before.width || (before.width === size.width && before.height === size.height)) return;
      const auto = onAutoView() ? s.autoView : null;
      if (auto?.kind === "fit") fitAll();
      else if (auto?.kind === "opening" || (auto?.kind === "restored" && !similarCanvasSize(size, auto))) {
        // A saved view no longer suits a window this different: start again as on a fresh load.
        openingView();
      } else if (reveal.dataset.stage === "shown" && onView(s.revealView)) {
        // Still on the new cards Hilight showed: frame them again for the new size.
        void showFresh({ duration: 0 });
      } else {
        const view = currentView();
        setView(
          view.zoom,
          view.scrollX + (size.width - before.width) / 2 / view.zoom,
          view.scrollY + (size.height - before.height) / 2 / view.zoom,
        );
        if (auto?.kind === "restored") s.autoView = { ...auto, ...s.lastSetView };
      }
      scheduleGeometry();
    });
  }

  function zoomBy(factor) {
    if (!s.api) return;
    const { width, height } = canvasSize();
    const view = zoomAround(currentView(), factor, { x: width / 2, y: height / 2 });
    setView(view.zoom, view.scrollX, view.scrollY);
    scheduleGeometry();
  }

  // Undo and redo stay Excalidraw's own (its history knows the reviewer's
  // marks); the bar buttons press its hidden ones.
  const pressHidden = (selector) => /** @type {HTMLElement | null} */ (editor.querySelector(selector))?.click();
  undoButton.onclick = () => pressHidden(".undo-button-container button");
  redoButton.onclick = () => pressHidden(".redo-button-container button");
  zoomInButton.onclick = () => zoomBy(1.25);
  zoomOutButton.onclick = () => zoomBy(1 / 1.25);
  zoomLabel.onclick = () => zoomBy(1 / (s.api ? s.api.getAppState().zoom.value : 1));

  // ---------------------------------------------------------------------------
  // Feedback: the marks, in words, as one page comment.

  function exportElements(elements) {
    const marks = elements.filter((element) => !isCardElement(element) && !element.isDeleted);
    // Agent connectors stay in the preview; they are part of the board.
    const skeletons = elements
      .filter((element) => isCardElement(element) && !element.isDeleted)
      .map((element) => {
        const card = s.cardsById.get(cardIdOfElement(element));
        const sub = card?.kind === "code" ? card.code?.ref || "" : card?.kind === "board" ? "board" : "";
        return {
          type: "rectangle",
          id: element.id,
          x: element.x,
          y: element.y,
          width: element.width,
          height: element.height,
          strokeColor: "#a3a39e",
          backgroundColor: "#ffffff",
          fillStyle: "solid",
          strokeWidth: 1,
          roughness: 0,
          roundness: { type: 3 },
          label: {
            text: [card?.title || card?.id || "", sub].filter(Boolean).join("\n"),
            fontSize: 18,
            textAlign: "left",
            verticalAlign: "top",
            strokeColor: "#1c1c1a",
          },
        };
      });
    return [...convertToExcalidrawElements(skeletons, { regenerateIds: false }), ...marks];
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("could not encode PNG preview"));
      reader.readAsDataURL(blob);
    });
  }

  // The note and the Queue marks button live in the review page's comments
  // panel; it asks for the marks here, where the scene is.
  async function queueMarks(text) {
    if (!s.api || s.queueBusy) return;
    const payload = persistencePayload();
    const summary = summarizeBoardMarks(s.model, payload.scene.elements);
    if (!summary.lines.length && !text) {
      post({ type: "hilight-board:queueSkipped" });
      showStatus("Nothing to send yet: press Draw, then draw an arrow, write a note, or circle something.");
      return;
    }
    s.queueBusy = true;
    try {
      const blob = await exportToBlob({
        elements: exportElements(s.elementsByLevel.get(s.level) || []),
        appState: { exportBackground: true, viewBackgroundColor: "#f6f6f3" },
        files: s.api.getFiles() || null,
        mimeType: "image/png",
      });
      post({
        type: "lavish-whiteboard:queueFeedback",
        board: true,
        ...payload,
        note: text,
        summaryLines: summary.lines,
        stats: summary.stats,
        pngDataUrl: await blobToDataUrl(blob),
      });
    } catch (error) {
      s.queueBusy = false;
      const message = `Queue failed: ${error instanceof Error ? error.message : String(error)}`;
      post({ type: "hilight-board:queueSkipped", error: message });
      showStatus(message, { transient: false });
    }
  }

  // Drawing tools stay out of the way until the reviewer asks for them: review comes first.
  function setDrawing(on) {
    const drawing = Boolean(on);
    if (document.body.hasAttribute("data-drawing") === drawing) return;
    document.body.toggleAttribute("data-drawing", drawing);
    drawButton.setAttribute("aria-pressed", String(drawing));
    drawButton.title = drawing ? "Hide the drawing tools" : "Show the drawing tools";
    placeTopFloaters();
    window.requestAnimationFrame(placeTopFloaters);
    if (!drawing && s.api && !VIEW_TOOLS.has(s.api.getAppState().activeTool?.type)) {
      s.api.setActiveTool({ type: "selection" });
    }
  }
  drawButton.onclick = () => setDrawing(!document.body.hasAttribute("data-drawing"));

  fit.onclick = () => fitAll();
  commentButton.onclick = () => {
    const card = s.cardsById.get(s.selectedCard);
    if (!card) return;
    postParent({
      type: "hilight-board:comment",
      card: card.id,
      kind: card.kind,
      title: card.title || card.id,
      ...(card.kind === "code" && card.code ? { code: card.code.ref, status: card.code.status } : {}),
    });
  };
  openButton.onclick = () => {
    if (s.selectedCard) openLevel(s.selectedCard);
  };
  // Double-click opens a nested board. Capture phase, so Excalidraw does not
  // also start a text element there.
  editor.addEventListener(
    "dblclick",
    (event) => {
      const target = /** @type {Element | null} */ (event.target);
      const hit = cardAtPoint(event.clientX, event.clientY);
      if (hit?.kind === "board" && !target?.closest?.(".bd-cardbar")) {
        event.preventDefault();
        event.stopPropagation();
        openLevel(hit.id);
      }
    },
    true,
  );

  function cardAtPoint(x, y) {
    const rects = cardRects();
    let found = null;
    for (const [id, rect] of Object.entries(rects)) {
      if (x >= rect[0] && x <= rect[0] + rect[2] && y >= rect[1] && y <= rect[1] + rect[3]) found = s.cardsById.get(id);
    }
    return found;
  }

  function onLinkOpen(element, event) {
    event.preventDefault();
    const link = String(element?.link || "");
    if (link.startsWith(CARD_LINK_PREFIX)) return;
    const safe = sanitizeSceneLink(link);
    if (safe) window.open(safe, "_blank", "noopener,noreferrer");
  }

  // ---------------------------------------------------------------------------
  // HTML card auto-sizing & contrast surface reporting: each sandboxed card
  // iframe measures its rendered content height and posts it here (never to the
  // chrome). Verified against the iframe's own contentWindow and our per-board
  // token so no untrusted card can resize another card.

  function applyAutoLayout() {
    s.autoLayoutFrame = 0;
    if (!s.api || s.switching || !s.measuredHeights.size) return;
    const elements = s.api.getSceneElementsIncludingDeleted();
    const levelCards = s.model.cards.filter((card) => card.level === s.level);
    const { elements: nextElements, changed } = applyHtmlCardMeasurements(
      levelCards,
      elements,
      s.model.flows,
      s.measuredHeights,
    );
    if (!changed) return;
    const wasAuto = onAutoView();
    const autoKind = s.autoView?.kind;
    s.api.updateScene({
      elements: nextElements,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    s.linkKey = "";
    syncLinks();
    if (wasAuto && autoKind === "opening") openingView();
    else if (wasAuto && autoKind === "fit") fitAll();
    scheduleGeometry();
    scheduleSave();
  }

  function scheduleAutoLayout() {
    if (s.autoLayoutFrame || !s.api || s.switching) return;
    s.autoLayoutFrame = window.requestAnimationFrame(applyAutoLayout);
    afterThisTask(() => {
      if (!s.autoLayoutFrame) return;
      window.cancelAnimationFrame(s.autoLayoutFrame);
      applyAutoLayout();
    });
  }

  function setBoardTheme(nextTheme) {
    const normalized = nextTheme === "dark" ? "dark" : "light";
    if (normalized === s.theme) return;
    s.theme = normalized;
    document.body.dataset.lavishWhiteboardTheme = normalized;
    for (const frame of s.cardFrames.values()) {
      frame?.contentWindow?.postMessage(
        { type: "hilight-board:cardTheme", token: s.cardToken, theme: normalized },
        "*",
      );
    }
    notifyCards();
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object" || msg.type !== "hilight-board:cardMetrics") return;
    if (msg.token !== s.cardToken) return;
    const cardId = typeof msg.cardId === "string" ? msg.cardId : "";
    if (!cardId) return;
    const frame = s.cardFrames.get(cardId);
    if (!frame || frame.contentWindow !== event.source) return;
    const card = s.cardsById.get(cardId);
    if (!card || card.kind !== "html") return;
    const surface = msg.surface === "light" || msg.surface === "dark" ? msg.surface : "inherit";
    if (s.cardSurfaces.get(cardId) !== surface) {
      s.cardSurfaces.set(cardId, surface);
      notifyCards();
    }
    if (card.auto_h !== true) return;
    const contentHeight = Number(msg.height);
    if (!Number.isFinite(contentHeight) || contentHeight <= 0) return;
    const head = editor.querySelector(`.bd-card[data-card="${CSS.escape(cardId)}"] .bd-head`);
    const headHeight =
      head instanceof HTMLElement && head.offsetHeight > 0
        ? Math.ceil(head.offsetHeight)
        : HTML_CARD_LAYOUT.headerHeight;
    const totalHeight = Math.min(
      Math.max(Math.ceil(headHeight + HTML_CARD_LAYOUT.borderHeight + contentHeight), HTML_CARD_LAYOUT.minHeight),
      HTML_CARD_LAYOUT.maxHeight,
    );
    const now = Date.now();
    const guard = s.growGuard.get(cardId);
    if (guard && totalHeight > guard.lastHeight && now - guard.at < 1500) {
      if (guard.count >= 4) return;
      s.growGuard.set(cardId, { count: guard.count + 1, lastHeight: totalHeight, at: now });
    } else if (!guard || totalHeight !== guard.lastHeight) {
      s.growGuard.set(cardId, { count: 1, lastHeight: totalHeight, at: now });
    }
    if (s.measuredHeights.get(cardId) === totalHeight) return;
    s.measuredHeights.set(cardId, totalHeight);
    scheduleAutoLayout();
  });

  // ---------------------------------------------------------------------------
  // Mount

  const view = savedViewFor(s.level);
  function BoardApp() {
    const theme = React.useSyncExternalStore(subscribe, () => s.theme);
    return h(Excalidraw, {
      initialData: {
        elements: restored(s.elementsByLevel.get(s.level) || []),
        appState: {
          viewBackgroundColor: "transparent",
          currentItemStrokeColor: INK,
          currentItemFontFamily: EXCALIFONT,
          currentItemRoughness: 1,
          ...(view ? { zoom: { value: view.zoom }, scrollX: view.scrollX, scrollY: view.scrollY } : {}),
        },
        files: s.files,
        scrollToContent: !view,
      },
      theme,
      onChange,
      onScrollChange: (_x, _y, zoom) => {
        renderZoom(zoom?.value);
        scheduleGeometry();
      },
      onLinkOpen,
      validateEmbeddable: (link) => (String(link).startsWith(CARD_LINK_PREFIX) ? true : undefined),
      renderEmbeddable,
      excalidrawAPI: (api) => {
        s.api = api;
        if (view) {
          restoreView(view);
          afterThisTask(scheduleGeometry);
        } else {
          afterThisTask(() => {
            try {
              openingView();
            } catch (error) {
              // Cosmetic: the canvas still works at Excalidraw's own view.
              console.warn("hilight board: opening view failed", error);
            }
            scheduleGeometry();
          });
        }
        if (s.measuredHeights.size) scheduleAutoLayout();
        window.setTimeout(() => {
          syncLinks();
          scheduleGeometry();
          renderZoom();
          s.lastSize = canvasSize();
        }, 50);
        if (hasFresh()) {
          renderReveal("pending");
          s.autoReveal = "armed";
          // A chrome that never says the page is shown must not leave the reveal waiting forever.
          window.setTimeout(() => startAutoReveal(), AUTO_REVEAL_FALLBACK_MS);
          if (s.shown) startAutoReveal();
        }
      },
      UIOptions: {
        canvasActions: {
          loadScene: false,
          saveToActiveFile: false,
          toggleTheme: false,
          export: false,
          saveAsImage: false,
          clearCanvas: false,
          changeViewBackgroundColor: false,
        },
      },
    });
  }
  createRoot(editor).render(h(BoardApp));
  renderCrumbs();
  window.addEventListener("resize", () => {
    placeTopFloaters();
    scheduleGeometry();
    onResize();
  });

  // ---------------------------------------------------------------------------
  // Messages

  function handleSaveResult(message) {
    const flushId = String(message.flushId || "");
    if (!flushId) return;
    if (flushId === s.teardownFlushId) {
      s.teardownFlushId = "";
      if (message.ok) post({ type: "lavish-whiteboard:teardownReady", flushId });
      else {
        const error = String(message.error || "failed to save the board");
        showStatus(`Could not save before reloading: ${error}`, { transient: false });
        post({ type: "lavish-whiteboard:teardownFailed", flushId, error });
      }
      return;
    }
    if (s.flushIds.delete(flushId)) post({ type: "lavish-whiteboard:flushComplete", flushId, ok: Boolean(message.ok) });
  }

  function onTopMessage(message) {
    if (message.type === "lavish-whiteboard:prepareTeardown") {
      const flushId = String(message.flushId || "");
      if (!flushId) return;
      s.teardownFlushId = flushId;
      window.clearTimeout(s.saveTimer);
      if (!postSave(flushId)) {
        s.teardownFlushId = "";
        post({ type: "lavish-whiteboard:teardownReady", flushId });
      }
    }
    if (message.type === "lavish-whiteboard:flush") {
      const flushId = String(message.flushId || "");
      if (!flushId || s.flushIds.has(flushId)) return;
      s.flushIds.add(flushId);
      window.clearTimeout(s.saveTimer);
      if (!postSave(flushId)) {
        s.flushIds.delete(flushId);
        post({ type: "lavish-whiteboard:flushComplete", flushId, ok: true });
      }
    }
    if (message.type === "lavish-whiteboard:saveResult") handleSaveResult(message);
    if (message.type === "lavish-whiteboard:queueResult") {
      s.queueBusy = false;
      if (message.ok) showStatus("Queued as a page comment. Press Send to agent when you are ready.");
      else showStatus(`Queue failed: ${String(message.error || "unknown error")}`, { transient: false });
    }
    if (message.type === "hilight-board:queueMarks") void queueMarks(String(message.note || "").trim());
    if (message.type === "hilight-board:openLevel") {
      const level = String(message.level || "");
      if (s.levelsById.has(level) && level !== s.level) void openLevel(level);
    }
    if (message.type === "hilight-board:revealCard") revealCard(String(message.card || ""));
    if (message.type === "hilight-board:theme") setBoardTheme(message.theme);
    // The chrome re-reads the board (code ranges included) while it is open, so
    // a card flips to stale when its file changes on disk.
    if (message.type === "hilight-board:update" && message.board && message.board.revision === s.model.revision) {
      indexModel(message.board);
      renderCrumbs();
      notifyCards();
      scheduleLinks();
    }
  }

  function onParentMessage(message) {
    if (message.type === "hilight-board:reveal") revealCard(String(message.card || ""));
    if (message.type === "hilight-board:shown") {
      s.shown = true;
      startAutoReveal();
    }
    if (message.type === "hilight-board:threads") {
      const counts = message.counts && typeof message.counts === "object" ? message.counts : {};
      s.threadCounts = Object.fromEntries(
        Object.entries(counts).filter(([, count]) => Number.isInteger(count) && count > 0),
      );
      notifyCards();
    }
  }

  return { onTopMessage, onParentMessage };
}
