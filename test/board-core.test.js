import assert from "node:assert/strict";
import test from "node:test";

import {
  applyHtmlCardMeasurements,
  buildHtmlCardSrcdoc,
  cardElementId,
  codeBodyTop,
  codeColumns,
  codeChromeWidth,
  codeLineSpan,
  codeLinesUnder,
  codeNoteHeight,
  codeRows,
  CODE_CARD_LAYOUT,
  createCardElement,
  createLinkElements,
  diffCodeLines,
  FLOW_COLORS,
  HTML_CARD_LAYOUT,
  HTML_CARD_THEMES,
  linkLandings,
  noteRows,
  normalizeBoardCanvasTarget,
  normalizeBoardCardTarget,
  parseEndpoint,
  parseLinkToken,
  placeLevelCards,
  reconcileLevelElements,
  canScrollBy,
  freshSince,
  knownAfter,
  stepSignature,
  stackTopFloaters,
  summarizeBoardMarks,
  WHEEL,
  wheelIntent,
  usableSavedView,
  zoomAround,
} from "../src/board-core.js";

const cli = { id: "cli", level: "", kind: "html", title: "CLI", x: 0, y: 0, w: 300, h: 200 };
const server = {
  id: "server",
  level: "",
  kind: "code",
  title: "Artifact route",
  x: 500,
  y: 0,
  w: 500,
  h: 400,
  note: "",
  code: { path: "src/server.js", start: 100, end: 119, lines: Array.from({ length: 20 }, (_, i) => `line ${i}`) },
};
const deep = { id: "deep", level: "inside", kind: "html", title: "Deep", x: 0, y: 0, w: 300, h: 200 };
const board = {
  levels: [
    { id: "", title: "Architecture", parent: null },
    { id: "inside", title: "Inside", parent: "" },
  ],
  cards: [cli, server, { id: "inside", level: "", kind: "board", title: "Inside", x: 0, y: 500, w: 300, h: 200 }, deep],
};

function arrow(id, from, to, points, extra = {}) {
  return {
    id,
    type: "arrow",
    x: points[0][0],
    y: points[0][1],
    points: points.map(([x, y]) => [x - points[0][0], y - points[0][1]]),
    startBinding: from ? { elementId: cardElementId(from) } : null,
    endBinding: to ? { elementId: cardElementId(to) } : null,
    customData: { boardLevel: "" },
    ...extra,
  };
}

test("reconcileLevelElements keeps a reviewer's move until the file moves the card", () => {
  const moved = { ...createCardElement(cli), x: 40, y: 60 };
  const link = arrow("a1", "cli", "server", [
    [340, 160],
    [500, 100],
  ]);
  const kept = reconcileLevelElements([cli, server], [moved, link]);
  const keptCli = kept.find((element) => element.id === cardElementId("cli"));
  assert.deepEqual([keptCli.x, keptCli.y], [40, 60]);
  assert.deepEqual(keptCli.boundElements, [{ id: "a1", type: "arrow" }]);

  // The agent moved the card in the file: the file wins and the arrow's start follows.
  const relocated = { ...cli, x: 100, y: 20 };
  const next = reconcileLevelElements([relocated, server], [moved, link]);
  const nextCli = next.find((element) => element.id === cardElementId("cli"));
  assert.deepEqual([nextCli.x, nextCli.y], [100, 20]);
  const nextArrow = next.find((element) => element.id === "a1");
  assert.deepEqual([nextArrow.x, nextArrow.y], [340 + 60, 160 - 40]);
  assert.deepEqual(nextArrow.points.at(-1), [500 - 400, 100 - 120]);
});

test("reconcileLevelElements drops cards the file removed and unbinds their arrows", () => {
  const link = arrow("a1", "cli", "server", [
    [340, 160],
    [500, 100],
  ]);
  const next = reconcileLevelElements([server], [createCardElement(cli), createCardElement(server), link]);
  assert.equal(
    next.some((element) => element.id === cardElementId("cli")),
    false,
  );
  assert.equal(next.find((element) => element.id === "a1").startBinding, null);
});

test("codeLinesUnder maps a vertical span of a code card to source lines", () => {
  const top = CODE_CARD_LAYOUT.header + CODE_CARD_LAYOUT.padTop;
  const rect = { y: 0, h: 400 };
  assert.deepEqual(codeLinesUnder(server, rect, top + 2 * CODE_CARD_LAYOUT.line, top + 4 * CODE_CARD_LAYOUT.line + 3), {
    start: 102,
    end: 104,
    path: "src/server.js",
  });
  assert.deepEqual(codeLinesUnder(server, rect, top, top + 1, CODE_CARD_LAYOUT.line * 5)?.start, 105);
});

test("summarizeBoardMarks describes marks in terms of cards and code lines", () => {
  const top = CODE_CARD_LAYOUT.header + CODE_CARD_LAYOUT.padTop;
  const elements = [
    createCardElement(cli),
    { ...createCardElement(server), x: 520 },
    createCardElement(board.cards[2]),
    { ...createCardElement(deep), isDeleted: true },
    arrow("a1", "cli", "server", [
      [300, 100],
      [520, 100],
    ]),
    { id: "t1", type: "text", containerId: "a1", text: "why not direct?", customData: { boardLevel: "" } },
    {
      id: "e1",
      type: "ellipse",
      x: 540,
      y: top + 3 * CODE_CARD_LAYOUT.line,
      width: 200,
      height: 2 * CODE_CARD_LAYOUT.line - 2,
      customData: { boardLevel: "" },
    },
    {
      id: "n1",
      type: "text",
      x: 10,
      y: 220,
      width: 100,
      height: 20,
      text: "too vague",
      customData: { boardLevel: "" },
    },
    { id: "r1", type: "rectangle", x: -10, y: -10, width: 320, height: 220, customData: { boardLevel: "" } },
    {
      id: "f1",
      type: "freedraw",
      x: 20,
      y: 20,
      points: [
        [0, 0],
        [10, 10],
      ],
      customData: { boardLevel: "" },
    },
  ];
  const { lines, stats } = summarizeBoardMarks(board, elements);
  assert.deepEqual(lines, [
    'Moved card #server "Artifact route" to x=520 y=0',
    'Arrow from card #cli "CLI" to line 102 of src/server.js in card #server "Artifact route", labeled "why not direct?"',
    'Circled lines 103-104 of src/server.js in card #server "Artifact route"',
    'Note "too vague" next to card #cli "CLI"',
    'Boxed card #cli "CLI"',
    'Freehand mark on card #cli "CLI"',
    '[in board #inside "Inside"] Removed card #deep "Deep" from the board',
  ]);
  assert.equal(stats.arrows, 1);
  assert.equal(stats.shapes, 2);
  assert.equal(stats.removed, 1);
});

test("board prompt targets are normalized to a fixed shape", () => {
  assert.deepEqual(
    normalizeBoardCanvasTarget({ type: "board-canvas", scenePath: "/x", evil: 1, stats: { arrows: 2.4 } }),
    {
      type: "board-canvas",
      revision: "",
      scenePath: "/x",
      previewPath: "",
      stats: { arrows: 2, notes: 0, shapes: 0, freehand: 0, images: 0, moved: 0, removed: 0 },
    },
  );
  assert.deepEqual(
    normalizeBoardCardTarget({ card: "srv", kind: "code", title: "S", code: "src/a.js:1-2", status: "stale", x: 1 }),
    { type: "board-card", card: "srv", kind: "code", title: "S", code: "src/a.js:1-2", status: "stale" },
  );
  assert.equal(normalizeBoardCardTarget({ kind: "bogus" }).kind, "html");
});

test("diffCodeLines marks the live lines that are not in the pinned copy", () => {
  assert.deepEqual(diffCodeLines(["a", "b", "c", "d"], ["a", "B", "c", "d", "e"]), { changed: [1, 4], removed: 1 });
  assert.deepEqual(diffCodeLines(["a", "b"], ["a", "b  "]), { changed: [], removed: 0 });
});

function flow(steps, extra = {}) {
  return {
    id: "f1",
    name: "Request",
    level: "",
    color: FLOW_COLORS[0],
    steps: steps.map(([from, to]) => ({ from: end(from), to: end(to), text: "" })),
    ...extra,
  };
}

function end(text) {
  const [card, lines] = text.split(":");
  if (!lines) return { card, lines: null };
  const [a, b] = lines.split("-").map(Number);
  return { card, lines: { start: a, end: b || a } };
}

function absolute(link) {
  return link.points.map(([x, y]) => [link.x + x, link.y + y]);
}

function linksFor(cards, flows) {
  return createLinkElements(cards, cards.map(createCardElement), flows);
}

function assertOrthogonal(points) {
  for (let index = 1; index < points.length; index += 1) {
    const [x1, y1] = points[index - 1];
    const [x2, y2] = points[index];
    assert.ok(x1 === x2 || y1 === y2, `segment ${index} is horizontal or vertical: ${JSON.stringify(points)}`);
  }
}

// True when the segment passes through the inside of the rect.
function crosses([x1, y1], [x2, y2], rect) {
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);
  return left < rect.x + rect.w && right > rect.x && top < rect.y + rect.h && bottom > rect.y;
}

test("flow arrows run edge to edge for whole cards, in the flow's colour, unbound, and are never reported as marks", () => {
  const elements = reconcileLevelElements(
    [cli, server],
    [
      {
        id: "link:old",
        type: "arrow",
        x: 0,
        y: 0,
        points: [
          [0, 0],
          [1, 1],
        ],
        customData: { hilightLink: "f1.1" },
      },
    ],
    [flow([["cli", "server"]], { color: FLOW_COLORS[2] })],
  );
  const links = elements.filter((element) => element.customData?.hilightLink);
  assert.equal(links.length, 1);
  assert.equal(links[0].strokeColor, FLOW_COLORS[2]);
  assert.equal(links[0].locked, true);
  assert.equal(links[0].startBinding, null);
  assert.equal(links[0].endBinding, null);
  assert.deepEqual(absolute(links[0]), [
    [300, 100],
    [500, 100],
  ]);
  assert.deepEqual(elements.find((element) => element.id === cardElementId("cli")).boundElements, []);
  assert.deepEqual(summarizeBoardMarks(board, elements).lines, []);
});

test("parseEndpoint and parseLinkToken read cards and line spans", () => {
  assert.deepEqual(parseEndpoint("server"), { card: "server", lines: null });
  assert.deepEqual(parseEndpoint("server:L10-L12"), { card: "server", lines: { start: 10, end: 12 } });
  assert.equal(parseEndpoint("server:12-3"), null);
  assert.equal(parseEndpoint("server:"), null);
  assert.deepEqual(parseLinkToken("88-90>server:120"), {
    card: "server",
    lines: { start: 120, end: 120 },
    from: { start: 88, end: 90 },
  });
  assert.equal(parseLinkToken("x>server"), null);
});

test("an arrow between code lines starts and ends inside the cards, on those lines, both highlighted", () => {
  const source = { ...server, id: "src", x: 0 };
  const target = { ...server, id: "dst", x: 700 };
  const flows = [flow([["src:104", "dst:110-112"]])];
  const [link] = linksFor([source, target], flows);
  const row = (n) => codeBodyTop(server) + n * CODE_CARD_LAYOUT.line;
  const points = absolute(link);
  assert.deepEqual(points[0], [488, row(4) + CODE_CARD_LAYOUT.line / 2], "starts inside src on line 104");
  assert.deepEqual(points.at(-1), [712, row(10) + (3 * CODE_CARD_LAYOUT.line) / 2], "ends inside dst on 110-112");
  assertOrthogonal(points);
  const landings = linkLandings([source, target], flows);
  assert.deepEqual([...landings.get("src")], [[4, FLOW_COLORS[0]]]);
  assert.deepEqual([...landings.get("dst").keys()], [10, 11, 12]);
});

test("line anchors use the pinned numbering, so they follow code that moved", () => {
  const moved = { ...server, code: { ...server.code, start: 110, end: 129, pinned_start: 100 } };
  assert.deepEqual(
    [
      ...linkLandings([cli, moved], [flow([["cli", "server:105"]])])
        .get("server")
        .keys(),
    ],
    [5],
  );
  assert.equal(codeLineSpan(moved, { start: 105, end: 105 })?.top, codeBodyTop(moved) + 5 * CODE_CARD_LAYOUT.line);
  // A line outside the card falls back to its edge and highlights nothing.
  const [outside] = linksFor([cli, server], [flow([["cli", "server:400"]])]);
  assert.equal(absolute(outside).at(-1)[0], 500);
  assert.equal(linkLandings([cli, server], [flow([["cli", "server:400"]])]).size, 0);
});

test("an arrow routes around every card it does not connect", () => {
  const a = { ...cli, id: "a", x: 0, y: 0 };
  const wall = { ...cli, id: "wall", x: 400, y: -100, w: 200, h: 420 };
  const b = { ...cli, id: "b", x: 700, y: 0 };
  const [link] = linksFor([a, wall, b], [flow([["a", "b"]])]);
  const points = absolute(link);
  assertOrthogonal(points);
  const onEdge = ([x, y], r) =>
    ((x === r.x || x === r.x + r.w) && y >= r.y && y <= r.y + r.h) ||
    ((y === r.y || y === r.y + r.h) && x >= r.x && x <= r.x + r.w);
  assert.ok(onEdge(points[0], a), "starts on a's edge");
  assert.ok(onEdge(points.at(-1), b), "ends on b's edge");
  for (let index = 1; index < points.length; index += 1) {
    assert.ok(!crosses(points[index - 1], points[index], wall), `segment ${index} stays clear of the wall`);
  }
  // Stacked code cards with a line anchor still never cross a third card.
  const above = { ...cli, id: "above", x: 0, y: 0 };
  const middle = { ...cli, id: "middle", x: 0, y: 260, w: 600, h: 100 };
  const below = { ...server, id: "below", x: 0, y: 420 };
  const [down] = linksFor([above, middle, below], [flow([["above", "below:103"]])]);
  const route = absolute(down);
  assertOrthogonal(route);
  for (let index = 1; index < route.length; index += 1) {
    assert.ok(!crosses(route[index - 1], route[index], middle), `segment ${index} stays clear of the middle card`);
  }
});

test("overlapping segments of different flows are nudged apart", () => {
  const a = { ...cli, id: "a", x: 0, y: 0, w: 300, h: 100 };
  const b = { ...cli, id: "b", x: 600, y: 300, w: 300, h: 100 };
  const links = linksFor(
    [a, b],
    [flow([["a", "b"]]), flow([["a", "b"]], { id: "f2", name: "Reply", color: FLOW_COLORS[1] })],
  );
  assert.equal(links.length, 2);
  assert.notEqual(links[0].strokeColor, links[1].strokeColor);
  const vertical = (link) => {
    const points = absolute(link);
    const index = points.findIndex((point, i) => i > 0 && point[0] === points[i - 1][0]);
    return points[index][0];
  };
  assert.equal(Math.abs(vertical(links[0]) - vertical(links[1])), 6);
});

test("a code card's note wraps to the rows its width allows, and the code starts below it", () => {
  assert.equal(noteRows("", 500), 0);
  assert.equal(noteRows("Short note.", 500), 1);
  const long = "Why these lines matter in the flow and what would break without them. ".repeat(4);
  assert.equal(noteRows(long, 500), 4, "capped at four rows");
  assert.ok(noteRows(long.slice(0, 120), 500) >= 2);
  const noted = { ...server, note: long.slice(0, 120) };
  assert.equal(codeBodyTop(noted), CODE_CARD_LAYOUT.header + codeNoteHeight(noted) + CODE_CARD_LAYOUT.padTop);
  assert.ok(codeNoteHeight(noted) >= 2 * CODE_CARD_LAYOUT.line);
  const rect = { y: 0, h: 400 };
  assert.equal(codeLinesUnder(noted, rect, codeBodyTop(noted) + 1, codeBodyTop(noted) + 2)?.start, 100);
});

test("codeRows wraps a long line at a word boundary, keeps its indent, and marks continuations", () => {
  const rows = codeRows(["short", "    return someFunction(alpha, beta, gamma) + another(delta);"], 40);
  assert.deepEqual(
    rows.map((row) => [row.index, row.cont, row.text]),
    [
      [0, false, "short"],
      [1, false, "    return someFunction(alpha, beta, "],
      [1, true, "      gamma) + another(delta);"],
    ],
  );
  assert.ok(rows.every((row) => row.text.length <= 40));
  // Tabs expand before measuring, so a tabbed line wraps where it is drawn.
  assert.equal(codeRows(["\tx"], 40)[0].text, "    x");
});

test("codeColumns sizes a card to its longest line within the column limits", () => {
  assert.equal(codeColumns(["a".repeat(30)]), CODE_CARD_LAYOUT.minCols);
  assert.equal(codeColumns(["a".repeat(70)]), 70);
  assert.equal(codeColumns(["a".repeat(300)]), CODE_CARD_LAYOUT.maxCols);
  // A width from the file is a ceiling, never a reason to grow.
  assert.equal(codeColumns(["a".repeat(70)], 400), Math.floor((400 - codeChromeWidth()) / CODE_CARD_LAYOUT.char));
  assert.equal(codeColumns(["a".repeat(50)], 2000), 50);
});

test("codeLinesUnder maps wrapped rows back to their source line", () => {
  const card = {
    note: "",
    code: { path: "src/a.js", start: 10, end: 12, cols: 40, lines: ["one", "x".repeat(100), "three"] },
  };
  const top = CODE_CARD_LAYOUT.header + CODE_CARD_LAYOUT.padTop;
  const rect = { y: 0, h: 1000 };
  // Rows: 0 -> line 10, 1..3 -> line 11 (wrapped), 4 -> line 12.
  assert.deepEqual(
    codeLinesUnder(card, rect, top + 3 * CODE_CARD_LAYOUT.line + 2, top + 4 * CODE_CARD_LAYOUT.line + 5),
    {
      start: 11,
      end: 12,
      path: "src/a.js",
    },
  );
});

test("an arrow follows scrolled code and stops at the edge of the code when its line scrolls away", () => {
  const source = { ...server, id: "src", x: 0 };
  const target = { ...server, id: "dst", x: 700 };
  const flows = [flow([["src:104", "dst:110"]])];
  const elements = [source, target].map(createCardElement);
  const row = (n) => codeBodyTop(server) + n * CODE_CARD_LAYOUT.line + CODE_CARD_LAYOUT.line / 2;
  const scrolled = (scrollOf) => absolute(createLinkElements([source, target], elements, flows, { scrollOf })[0]);
  assert.equal(scrolled(() => 0)[0][1], row(4));
  assert.equal(scrolled((id) => (id === "src" ? 40 : 0))[0][1], row(4) - 40, "two rows up with the code");
  assert.equal(
    scrolled((id) => (id === "src" ? 400 : 0))[0][1],
    codeBodyTop(server) + 10,
    "pinned to the top of the code",
  );
  assert.equal(scrolled((id) => (id === "src" ? 400 : 0)).at(-1)[1], row(10), "the other end does not move");
});

test("a step the reviewer has not seen is drawn heavier, and keeps its identity across edits", () => {
  const flows = [flow([["cli", "server"]])];
  const [step] = flows[0].steps.map((item) => ({ ...item, flowName: "Request" }));
  const signature = stepSignature(step);
  assert.equal(signature, "Request|cli>server");
  // Re-pinning to moved lines keeps the identity; a different card does not.
  assert.equal(stepSignature({ ...step, from: end("cli:3-4") }), signature);
  assert.notEqual(stepSignature({ ...step, to: end("restore") }), signature);
  const elements = [cli, server].map(createCardElement);
  const [plain] = createLinkElements([cli, server], elements, flows);
  const [heavy] = createLinkElements([cli, server], elements, flows, { emphasis: new Set([signature]) });
  assert.ok(heavy.strokeWidth > plain.strokeWidth);
});

test("wheel intent: two-finger scroll pans, pinch and ctrl or cmd + wheel zoom, spikes are clamped", () => {
  // macOS / Windows precision trackpad two-finger scroll: pixel deltas, no modifier.
  assert.deepEqual(wheelIntent({ deltaX: 12, deltaY: -30, deltaMode: 0 }), { kind: "pan", dx: 12, dy: -30 });
  // A momentum or wheel-delta spike never jumps the board.
  assert.deepEqual(wheelIntent({ deltaX: 0, deltaY: 5000, deltaMode: 0 }), { kind: "pan", dx: 0, dy: WHEEL.maxPan });
  // Firefox reports lines; a page delta is one page.
  assert.deepEqual(wheelIntent({ deltaY: 3, deltaMode: 1 }), { kind: "pan", dx: 0, dy: 48 });
  assert.deepEqual(wheelIntent({ deltaY: 1, deltaMode: 2 }, { pageHeight: 300 }), { kind: "pan", dx: 0, dy: 300 });
  // Shift turns a mouse wheel sideways; a trackpad's own sideways delta is kept.
  assert.deepEqual(wheelIntent({ deltaY: 100, shiftKey: true }), { kind: "pan", dx: 100, dy: 0 });
  assert.deepEqual(wheelIntent({ deltaX: 20, deltaY: 4, shiftKey: true }), { kind: "pan", dx: 20, dy: 4 });
  // Pinch arrives as ctrl + wheel in Chrome, Edge and Firefox on macOS and Windows.
  const pinchIn = wheelIntent({ deltaY: -4, ctrlKey: true });
  assert.equal(pinchIn.kind, "zoom");
  assert.ok(pinchIn.kind === "zoom" && pinchIn.factor > 1 && pinchIn.factor < 1.05, "a small pinch is a small zoom");
  const cmd = wheelIntent({ deltaY: 4, metaKey: true });
  assert.ok(cmd.kind === "zoom" && cmd.factor < 1);
  // A mouse notch with ctrl (deltaY 100) and a spike zoom the same bounded step.
  const notch = wheelIntent({ deltaY: 100, ctrlKey: true });
  const spike = wheelIntent({ deltaY: 4000, ctrlKey: true });
  assert.ok(notch.kind === "zoom" && spike.kind === "zoom");
  assert.equal(notch.factor, spike.factor);
  assert.ok(notch.factor > 0.75, "one step never more than a quarter");
  // Zoom steps are proportional: the same pinch is the same feel at 20% and 200%.
  const at = (zoom) => zoomAround({ zoom, scrollX: 0, scrollY: 0 }, pinchIn.factor, { x: 0, y: 0 }).zoom / zoom;
  assert.ok(Math.abs(at(0.2) - at(2)) < 1e-9);
  // Garbage deltas do nothing.
  assert.deepEqual(wheelIntent({ deltaX: Number.NaN, deltaY: undefined }), { kind: "pan", dx: 0, dy: 0 });
});

test("zoomAround keeps the scene point under the pointer still and stays within the zoom limits", () => {
  const view = { zoom: 0.5, scrollX: -100, scrollY: 40 };
  const point = { x: 300, y: 200 };
  const scene = (v) => [point.x / v.zoom - v.scrollX, point.y / v.zoom - v.scrollY];
  const next = zoomAround(view, 1.6, point);
  assert.equal(next.zoom, 0.8);
  assert.deepEqual(scene(next).map(Math.round), scene(view).map(Math.round));
  assert.equal(zoomAround(view, 0.0001, point).zoom, WHEEL.minZoom);
  assert.equal(zoomAround(view, 1e6, point).zoom, WHEEL.maxZoom);
});

test("canScrollBy lets code scroll only while it has room in that direction", () => {
  const box = { scrollTop: 0, scrollLeft: 0, scrollHeight: 600, scrollWidth: 300, clientHeight: 200, clientWidth: 300 };
  assert.equal(canScrollBy(box, 0, 30), true, "down: room below");
  assert.equal(canScrollBy(box, 0, -30), false, "up: already at the top, so the board pans");
  assert.equal(canScrollBy({ ...box, scrollTop: 400 }, 0, 30), false, "down: at the bottom");
  assert.equal(canScrollBy(box, 30, 2), false, "sideways: nothing to scroll");
  const fits = { ...box, scrollHeight: 200 };
  assert.equal(canScrollBy(fits, 0, 30), false, "a card sized to its lines never scrolls");
});

test("freshSince finds the cards and steps the agent added since the reviewer last looked", () => {
  const before = { cards: [cli, server], flows: [flow([["cli", "server"]])] };
  const after = {
    cards: [cli, server, { ...cli, id: "restore" }],
    flows: [
      flow([
        ["cli", "server"],
        ["server", "restore"],
      ]),
    ],
  };
  // A first open, or a scene saved before this existed, has nothing new.
  assert.deepEqual(freshSince(after, undefined), { cards: new Set(), steps: new Set() });
  const known = knownAfter(before, freshSince(before, undefined));
  const fresh = freshSince(after, known);
  assert.deepEqual([...fresh.cards], ["restore"]);
  assert.deepEqual([...fresh.steps], ["Request|server>restore"]);
  // Until the reviewer acknowledges it, it is saved as not known, so it is new again after a reload.
  assert.deepEqual(freshSince(after, knownAfter(after, fresh)), fresh);
  // Acknowledged: nothing is new.
  const seen = knownAfter(after, { cards: new Set(), steps: new Set() });
  assert.deepEqual(freshSince(after, seen), { cards: new Set(), steps: new Set() });
});

test("freshSince does not call a step re-pinned to moved code a new arrow", () => {
  const pinned = (from, to) => ({
    cards: [cli, server],
    flows: [{ name: "Request", steps: [{ from: { card: "cli", lines: from }, to: { card: "server", lines: to } }] }],
  });
  const before = pinned({ start: 10, end: 12 }, { start: 40, end: 41 });
  const after = pinned({ start: 14, end: 16 }, { start: 44, end: 45 });
  const known = knownAfter(before, freshSince(before, undefined));
  assert.deepEqual(freshSince(after, known).steps, new Set());
  // A scene saved before signatures dropped line spans still knows its steps.
  assert.deepEqual(
    freshSince(after, { cards: ["cli", "server"], steps: ["Request|cli:10-12>server:40-41"] }).steps,
    new Set(),
  );
  assert.deepEqual(freshSince(after, { cards: ["cli", "server"], steps: ["Request|cli:>server:"] }).steps, new Set());
});

test("usableSavedView keeps a saved view only for a window of about the size it was saved in", () => {
  const big = { width: 1440, height: 780 };
  const half = { width: 760, height: 330 };
  const saved = { zoom: { value: 0.26 }, scrollX: 5, scrollY: 7, width: 1880, height: 1900 };
  // Saved full-screen, opened half-screen: work the opening view out again instead of opening at 26%.
  assert.equal(usableSavedView(saved, half), null);
  assert.equal(usableSavedView(saved, big), null);
  assert.deepEqual(usableSavedView(saved, { width: 1800, height: 1850 }), {
    zoom: 0.26,
    scrollX: 5,
    scrollY: 7,
    width: 1880,
    height: 1900,
  });
  // A view saved before sizes were kept is trusted only in a window that is not small.
  const legacy = { zoom: { value: 0.93 }, scrollX: 1, scrollY: 2 };
  assert.equal(usableSavedView(legacy, half), null);
  assert.deepEqual(usableSavedView(legacy, big), { zoom: 0.93, scrollX: 1, scrollY: 2, width: 1440, height: 780 });
  // Nothing usable.
  assert.equal(usableSavedView(undefined, big), null);
  assert.equal(usableSavedView({ zoom: { value: 0 }, scrollX: 0, scrollY: 0 }, big), null);
  assert.equal(usableSavedView({ zoom: 1, scrollX: Number.NaN, scrollY: 0 }, big), null);
});

test("stackTopFloaters puts a top floater 8px below a bar it would overlap, and at rest otherwise", () => {
  const toast = { left: 200, right: 900, top: 12, bottom: 56 };
  const toolbar = { left: 300, right: 850, top: 16, bottom: 60 };
  assert.deepEqual(stackTopFloaters([toast], [toolbar]), [68]);
  assert.deepEqual(stackTopFloaters([toast], []), [12], "no bar: back at rest");
  assert.deepEqual(
    stackTopFloaters([toast], [{ left: 950, right: 1100, top: 16, bottom: 60 }]),
    [12],
    "a bar off to the side leaves it alone",
  );
  // A second bar that the first move lands on pushes it again, and a second floater stacks under the first.
  const lower = { left: 100, right: 400, top: 64, bottom: 90 };
  assert.deepEqual(
    stackTopFloaters([toast, { left: 0, right: 2000, top: 0, bottom: 30 }], [toolbar, lower]),
    [98, 150],
  );
});

test("buildHtmlCardSrcdoc passes theme, preserves author backgrounds and html attrs, and matches plain <section> cards", () => {
  const model = {
    head: "<style>body{background:#fff;color:#18181b}</style>",
    html_attrs: [
      ["lang", "en"],
      ["data-theme", "corporate"],
      ["style", "color:red"],
    ],
    body_attrs: [["class", "prose"]],
    main_attrs: [["data-hilight-board", "Demo"]],
  };
  const card = { id: "plain", html: "<p>Hello</p>", attrs: [["id", "plain"]] };
  const darkDoc = buildHtmlCardSrcdoc(card, model, "http://127.0.0.1:4387/artifact/k/", {
    theme: "dark",
    token: "tok-1",
  });
  assert.match(darkDoc, /<html lang="en" data-theme="corporate" data-hilight-theme="dark">/);
  assert.doesNotMatch(darkDoc, /style="color:red"/);
  assert.match(darkDoc, /<body class="prose">/);
  assert.match(darkDoc, new RegExp(`--hilight-card-ink:${HTML_CARD_THEMES.dark.ink}`));
  assert.match(darkDoc, /color-scheme:dark/);
  // Reset must not strip author backgrounds with background:transparent!important.
  assert.doesNotMatch(darkDoc, /background:transparent!important/);
  // Reset matches both plain <section> cards and [data-card] cards.
  assert.match(darkDoc, /\[data-hilight-board\]>section,\[data-hilight-board\]>\[data-card\]/);
  // Escapes </script> safely when embedding card ids.
  const hostile = buildHtmlCardSrcdoc({ id: "</script><img onerror=1>", html: "" }, model, "http://127.0.0.1/", {
    theme: "light",
    token: "tok-2",
  });
  assert.doesNotMatch(hostile, /<\/script><img/);
});

test("applyHtmlCardMeasurements grows auto-sized cards, reflows rows without overlap, and never reports phantom marks", () => {
  const cards = [
    { id: "c1", level: "", kind: "html", title: "One", x: 0, y: 0, w: 460, h: 200, placed: false, auto_h: true },
    { id: "c2", level: "", kind: "html", title: "Two", x: 516, y: 0, w: 460, h: 200, placed: false, auto_h: true },
    { id: "c3", level: "", kind: "html", title: "Three", x: 1032, y: 0, w: 460, h: 200, placed: false, auto_h: false },
    { id: "c4", level: "", kind: "html", title: "Four", x: 0, y: 256, w: 460, h: 200, placed: false, auto_h: true },
  ];
  placeLevelCards(cards, []);
  const initial = reconcileLevelElements(cards, [], []);
  const { elements, changed } = applyHtmlCardMeasurements(
    cards,
    initial,
    [],
    new Map([
      ["c1", 520],
      ["c3", 600], // explicit data-h (auto_h: false) must be ignored
    ]),
  );
  assert.equal(changed, true);
  const byId = Object.fromEntries(elements.map((el) => [el.id, el]));
  assert.equal(byId["card:c1"].height, 520);
  assert.equal(byId["card:c3"].height, 200, "explicit data-h card keeps its authored height");
  assert.equal(byId["card:c4"].y, 520 + 56, "row 2 reflows cleanly below the grown card");
  // fileRect is untouched while autoRect records the auto-sized geometry.
  assert.equal(byId["card:c1"].customData.fileRect.h, 200);
  assert.equal(byId["card:c1"].customData.autoRect.h, 520);
  // summarizeBoardMarks must not treat auto-sizing/reflow as reviewer marks.
  const summary = summarizeBoardMarks({ levels: [{ id: "", title: "" }], cards }, elements);
  assert.deepEqual(summary.lines, []);
  assert.equal(summary.stats.moved, 0);

  // Reloading the unchanged board preserves the saved autoRect height.
  const reloaded = reconcileLevelElements(cards, elements, []);
  assert.equal(reloaded.find((el) => el.id === "card:c1").height, 520);
  assert.equal(reloaded.find((el) => el.id === "card:c1").customData.autoRect.h, 520);

  // If the reviewer manually resizes or moves a card, auto-sizing respects it.
  const manual = elements.map((el) =>
    el.id === "card:c1" ? { ...el, height: 340 } : el.id === "card:c4" ? { ...el, x: 999, y: 888 } : el,
  );
  const afterManual = applyHtmlCardMeasurements(
    cards,
    manual,
    [],
    new Map([
      ["c1", 700],
      ["c2", 420],
    ]),
  );
  const afterById = Object.fromEntries(afterManual.elements.map((el) => [el.id, el]));
  assert.equal(afterById["card:c1"].height, 340, "reviewer manual resize is preserved");
  assert.deepEqual([afterById["card:c4"].x, afterById["card:c4"].y], [999, 888], "reviewer manual move is preserved");
  assert.equal(afterById["card:c2"].height, 420, "untouched card still auto-sizes");
  // Clamping to HTML_CARD_LAYOUT.maxHeight.
  const huge = applyHtmlCardMeasurements(cards, initial, [], new Map([["c1", 9999]]));
  assert.equal(huge.elements.find((el) => el.id === "card:c1").height, HTML_CARD_LAYOUT.maxHeight);
});
