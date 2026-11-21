/* global document, location, window, requestAnimationFrame */

// Real-Chrome fixture for HTML board cards: exercises dark & light themes,
// plain HTML cards, author light-mode CSS, dark-text-only CSS, light-bg-only
// CSS, auto-sizing multi-block cards without scrollbars, row reflow, and
// explicit data-h preservation.

import "@excalidraw/excalidraw/index.css";
import "../../src/whiteboard-frame.css";

import { placeLevelCards, summarizeBoardMarks } from "../../src/board-core.js";
import { startBoard } from "../../src/board-frame.js";

window.EXCALIDRAW_ASSET_PATH = `${location.origin}/whiteboard-assets/`;

const params = new URLSearchParams(location.search);
const initialTheme = params.get("theme") === "light" ? "light" : "dark";
const styleMode = params.get("style") || "plain";

const HEAD_BY_MODE = {
  plain: "",
  "light-author": `<style>
    body { background: #ffffff; color: #18181b; font-family: system-ui, sans-serif; }
    .box { background: #f4f4f5; border: 1px solid #d4d4d8; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
  </style>`,
  "dark-text-only": `<style>
    body { color: #18181b; }
    p, li { color: #27272a; }
  </style>`,
  "light-bg-only": `<style>
    body { background: #ffffff; }
  </style>`,
};

const TALL_HTML = `
  <p>This multi-block card intentionally starts with a tiny initial height (180px) so auto-sizing must grow it to fit every block cleanly without clipping or scrollbars.</p>
  <div class="box" style="padding:10px 12px;margin:10px 0;border:1px solid currentColor;border-radius:8px;">
    <strong>Block 1 — Architecture</strong>
    <p style="margin:4px 0 0;">Cards measure their own rendered height after stylesheets and fonts apply.</p>
  </div>
  <div class="box" style="padding:10px 12px;margin:10px 0;border:1px solid currentColor;border-radius:8px;">
    <strong>Block 2 — Layout Reflow</strong>
    <p style="margin:4px 0 0;">Cards in lower rows shift smoothly downward so nothing overlaps.</p>
  </div>
  <div class="box" style="padding:10px 12px;margin:10px 0;border:1px solid currentColor;border-radius:8px;">
    <strong>Block 3 — Theme Contrast</strong>
    <p style="margin:4px 0 0;">Plain HTML and author-styled light cards remain crisp in dark and light mode.</p>
  </div>
  <div class="box" style="padding:10px 12px;margin:10px 0;border:1px solid currentColor;border-radius:8px;">
    <strong>Block 4 — Verification</strong>
    <p style="margin:4px 0 0;">Zero scrollbars, zero clipped bottom lines, zero phantom canvas marks.</p>
  </div>
`;

const cards = [
  {
    id: "plain",
    level: "",
    kind: "html",
    title: "Plain HTML Card",
    x: 0,
    y: 0,
    w: 460,
    h: 180,
    placed: false,
    auto_h: true,
    html: `<p>Plain text paragraph inside a board card.</p><ul><li>First bullet point with <code>inline code</code></li><li>Second bullet point with <a href="https://example.com">a link</a></li></ul>`,
    attrs: [["id", "plain"]],
  },
  {
    id: "tall",
    level: "",
    kind: "html",
    title: "Multi-block Auto-Sized Card",
    x: 0,
    y: 0,
    w: 460,
    h: 180,
    placed: false,
    auto_h: true,
    html: TALL_HTML,
    attrs: [["id", "tall"]],
  },
  {
    id: "fixed",
    level: "",
    kind: "html",
    title: "Explicit Height Card",
    x: 0,
    y: 0,
    w: 460,
    h: 220,
    placed: false,
    auto_h: false,
    html: TALL_HTML,
    attrs: [["id", "fixed"]],
  },
  {
    id: "below",
    level: "",
    kind: "html",
    title: "Row 2 Card",
    x: 0,
    y: 0,
    w: 460,
    h: 180,
    placed: false,
    auto_h: true,
    html: `<p>Sits in row 2 and must reflow below the tallest card in row 1 with no overlap.</p>`,
    attrs: [["id", "below"]],
  },
];

placeLevelCards(cards, []);

const model = {
  title: "HTML Cards Test",
  head: HEAD_BY_MODE[styleMode] || "",
  html_attrs: [["lang", "en"]],
  body_attrs: [],
  main_attrs: [["data-hilight-board", "HTML Cards Test"]],
  revision: `rev-${styleMode}`,
  root: "repo",
  levels: [{ id: "", title: "HTML Cards Test", parent: null, summary: "" }],
  cards,
  flows: [],
  problems: [],
};

// Simulate an older saved scene with stale tiny heights when `?stale=1` is passed.
const saved = params.has("stale")
  ? {
      scene: {
        elements: cards.map((card) => ({
          id: `card:${card.id}`,
          type: "embeddable",
          x: card.x,
          y: card.y,
          width: card.w,
          height: card.h,
          angle: 0,
          strokeColor: "transparent",
          backgroundColor: "transparent",
          fillStyle: "solid",
          strokeWidth: 1,
          strokeStyle: "solid",
          roughness: 0,
          opacity: 100,
          roundness: { type: 3 },
          locked: false,
          link: `https://hilight.invalid/card/${card.id}`,
          boundElements: [],
          groupIds: [],
          frameId: null,
          isDeleted: false,
          customData: {
            hilightCard: card.id,
            boardLevel: "",
            fileRect: { x: card.x, y: card.y, w: card.w, h: card.h },
          },
        })),
        appState: {},
        files: {},
      },
    }
  : null;

const posts = [];
const board = startBoard({ board: model, saved, theme: initialTheme }, { post: (m) => posts.push(m) });

const rect = (node) => {
  const box = node.getBoundingClientRect();
  return { x: box.left, y: box.top, w: box.width, h: box.height };
};

window.probe = {
  ready: () => document.querySelectorAll(".bd-card").length > 0,
  fit: () => document.querySelector("button[title='Fit the board to the screen']")?.click(),
  setTheme: (nextTheme) => board.onTopMessage({ type: "hilight-board:theme", theme: nextTheme }),
  cards: () =>
    Object.fromEntries(
      [...document.querySelectorAll(".bd-card")].map((node) => [
        node.dataset.card,
        {
          ...rect(node),
          offsetHeight: node.offsetHeight,
          offsetWidth: node.offsetWidth,
          surface: node.dataset.surface || "",
        },
      ]),
    ),
  savedElements: () => {
    const save = posts.filter((m) => m.type === "lavish-whiteboard:save").at(-1);
    return save?.scene?.elements || null;
  },
  flush: () => board.onTopMessage({ type: "lavish-whiteboard:flush", flushId: `f-${Date.now()}` }),
  marks: () => {
    const elements = window.probe.savedElements();
    return elements ? summarizeBoardMarks(model, elements) : null;
  },
  frames: (count = 2) =>
    new Promise((resolve) => {
      const step = (left) => (left <= 0 ? resolve(true) : requestAnimationFrame(() => step(left - 1)));
      step(count);
    }),
};
