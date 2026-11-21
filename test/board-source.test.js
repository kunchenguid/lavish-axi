import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkCodeCard,
  codeCardHeight,
  codeRangeHash,
  layoutLevel,
  parseBoardHtml,
  parseCodeRef,
  parseFlowStep,
  readBoard,
  stampBoardFile,
} from "../src/board-source.js";
import { CODE_CARD_LAYOUT, codeCardWidth, codeRows } from "../src/board-core.js";

const SOURCE = ["export function a() {", "  return 1;", "}", "", "export function b() {", "  return 2;", "}"].join(
  "\n",
);

function board(cards) {
  return `<!doctype html><html><head><title>Arch</title><style>body{color:#111}</style></head><body>
<main data-hilight-board="Architecture">
${cards}
</main>
</body></html>`;
}

async function repo(t, files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hilight-board-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, ".git"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

test("parseCodeRef accepts colon and #L forms and rejects nonsense", () => {
  assert.deepEqual(parseCodeRef("src/server.js:120-180"), { path: "src/server.js", start: 120, end: 180 });
  assert.deepEqual(parseCodeRef("src/a.js#L5-L9"), { path: "src/a.js", start: 5, end: 9 });
  assert.deepEqual(parseCodeRef("src/a.js:7"), { path: "src/a.js", start: 7, end: 7 });
  assert.equal(parseCodeRef("src/a.js"), null);
  assert.equal(parseCodeRef("src/a.js:9-3"), null);
  assert.equal(parseCodeRef("src/a.js:0-3"), null);
});

test("parseBoardHtml returns null for an ordinary page", () => {
  assert.equal(parseBoardHtml("<html><body><main><section data-card>x</section></main></body></html>"), null);
});

test("parseBoardHtml reads cards, kinds, titles, nesting and layout", () => {
  const model = parseBoardHtml(
    board(`
  <section id="cli" data-card data-x="0" data-y="0" data-w="300" data-h="200"><h2>CLI</h2><p>Spawns <b>the server</b>.</p></section>
  <section id="srv" data-card data-code="src/a.js:1-3" data-hash="abc"><h3>Server</h3><p>Routes live here.</p><pre data-snapshot><code>old</code></pre></section>
  <section id="inside" data-card="board" data-title="Inside">
    <p>Zoom in.</p>
    <section id="deep" data-card><h4>Deep</h4><p>Nested card</p></section>
  </section>`),
  );
  assert.ok(model);
  assert.equal(model.title, "Architecture");
  assert.match(model.head, /<style>body\{color:#111\}<\/style>/);
  assert.doesNotMatch(model.head, /<title>/);
  assert.deepEqual(
    model.levels.map((level) => [level.id, level.title, level.parent]),
    [
      ["", "Architecture", null],
      ["inside", "Inside", ""],
    ],
  );
  const byId = Object.fromEntries(model.cards.map((card) => [card.id, card]));
  assert.equal(byId.cli.kind, "html");
  assert.equal(byId.cli.title, "CLI");
  // The heading becomes the title, so the body does not repeat it.
  assert.equal(byId.cli.html, "<p>Spawns <b>the server</b>.</p>");
  assert.deepEqual([byId.cli.x, byId.cli.y, byId.cli.w, byId.cli.h], [0, 0, 300, 200]);
  assert.equal(byId.srv.kind, "code");
  assert.equal(byId.srv.note, "Routes live here.");
  assert.deepEqual(byId.srv.code.snapshot, ["old"]);
  assert.equal(byId.srv.code.pinned, "abc");
  assert.equal(byId.inside.kind, "board");
  assert.equal(byId.inside.note, "Zoom in.");
  assert.equal(byId.inside.board.count, 1);
  assert.equal(byId.deep.level, "inside");
  // Unplaced cards flow below the placed ones instead of overlapping them.
  assert.ok(byId.srv.y >= 200);
});

test("checkCodeCard reports fresh, unpinned, stale, moved and missing", () => {
  const lines = SOURCE.split("\n");
  const pinnedLines = lines.slice(0, 3);
  const pin = codeRangeHash(pinnedLines);
  const code = { path: "a.js", start: 1, end: 3, pinned: pin, snapshot: pinnedLines };
  assert.equal(checkCodeCard(code, { lines }).status, "fresh");
  assert.equal(checkCodeCard({ ...code, pinned: null }, { lines }).status, "unpinned");
  const edited = ["export function a() {", "  return 42;", "}", ...lines.slice(3)];
  const stale = checkCodeCard(code, { lines: edited });
  assert.equal(stale.status, "stale");
  assert.deepEqual(stale.snapshot, pinnedLines);
  const shifted = ["// header", "// more", ...lines];
  const moved = checkCodeCard(code, { lines: shifted });
  assert.equal(moved.status, "moved");
  assert.deepEqual(moved.moved_to, { start: 3, end: 5 });
  assert.equal(checkCodeCard(code, { error: "file not found" }).status, "missing");
  assert.equal(checkCodeCard({ ...code, start: 50, end: 60, snapshot: null }, { lines }).status, "missing");
  // A range past the end whose pinned lines still exist elsewhere has moved, not vanished.
  assert.equal(checkCodeCard({ ...code, start: 50, end: 52 }, { lines }).status, "moved");
  // Trailing whitespace is not a change.
  assert.equal(checkCodeCard(code, { lines: lines.map((line) => line + "  ") }).status, "fresh");
});

test("readBoard reads pinned code from the repository root and flags stale ranges", async (t) => {
  const pin = codeRangeHash(SOURCE.split("\n").slice(4, 7));
  const dir = await repo(t, {
    "src/a.js": SOURCE,
    ".hilight/board.html": board(`
  <section id="b" data-card data-code="src/a.js:5-7" data-hash="${pin}"><h3>b()</h3></section>
  <section id="a" data-card data-code="src/a.js:1-3" data-hash="000000000000"><h3>a()</h3></section>
  <section id="gone" data-card data-code="src/missing.js:1-2"><h3>gone</h3></section>
  <section id="escape" data-card data-code="../outside.js:1-2"><h3>escape</h3></section>`),
  });
  await writeFile(path.join(path.dirname(dir), "outside.js"), "secret\nsecret\n").catch(() => {});
  const model = await readBoard(path.join(dir, ".hilight/board.html"));
  assert.ok(model);
  const byId = Object.fromEntries(model.cards.map((card) => [card.id, card]));
  assert.equal(byId.b.code.status, "fresh");
  assert.deepEqual(byId.b.code.lines, ["export function b() {", "  return 2;", "}"]);
  assert.equal(byId.a.code.status, "stale");
  assert.equal(byId.gone.code.status, "missing");
  assert.equal(byId.escape.code.status, "missing");
  assert.equal(byId.escape.code.lines.length, 0);
  assert.match(byId.escape.code.error, /outside the repository/);
  assert.match(model.revision, /^[0-9a-f]{16}$/);
});

test("readBoard never follows a symlink out of the repository", async (t) => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "hilight-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "secret.txt"), "top secret\n");
  const dir = await repo(t, {
    "board.html": board(`<section id="s" data-card data-code="link/secret.txt:1"><h3>s</h3></section>`),
  });
  await symlink(outside, path.join(dir, "link"));
  const model = await readBoard(path.join(dir, "board.html"));
  assert.equal(model?.cards[0].code.status, "missing");
  assert.deepEqual(model?.cards[0].code.lines, []);
});

test("stampBoardFile pins unpinned cards, writes a snapshot, and leaves stale pins alone", async (t) => {
  const dir = await repo(t, {
    "src/a.js": SOURCE,
    "board.html": board(`  <section id="a" data-card data-code="src/a.js:1-3">
    <h3>a()</h3>
  </section>
  <section id="b" data-card data-code="src/a.js:5-7" data-hash="000000000000"><h3>b()</h3></section>`),
  });
  const file = path.join(dir, "board.html");
  const first = await stampBoardFile(file);
  assert.ok(first);
  assert.deepEqual(
    first.cards.map((card) => [card.card, card.status]),
    [
      ["a", "pinned"],
      ["b", "stale"],
    ],
  );
  const written = await readFile(file, "utf8");
  const pin = codeRangeHash(SOURCE.split("\n").slice(0, 3));
  assert.match(written, new RegExp(`data-code="src/a.js:1-3" data-hash="${pin}"`));
  assert.match(written, /<pre data-snapshot><code>export function a\(\) \{\n {2}return 1;\n\}<\/code><\/pre>/);
  assert.match(written, /data-hash="000000000000"/);
  const model = await readBoard(file);
  assert.equal(model?.cards.find((card) => card.id === "a")?.code.status, "fresh");

  // Stamping again changes nothing.
  const second = await stampBoardFile(file);
  assert.equal(second?.changed, false);
  assert.equal(second?.cards[0].status, "ok");

  // --repin accepts the current lines.
  const repinned = await stampBoardFile(file, { repin: true });
  assert.equal(repinned?.cards.find((card) => card.card === "b")?.status, "repinned");
  const after = await readBoard(file);
  assert.equal(after?.cards.find((card) => card.id === "b")?.code.status, "fresh");
});

test("stampBoardFile reports a moved range and --repin follows it", async (t) => {
  const dir = await repo(t, {
    "src/a.js": SOURCE,
    "board.html": board(`<section id="a" data-card data-code="src/a.js:1-3"><h3>a()</h3></section>`),
  });
  const file = path.join(dir, "board.html");
  await stampBoardFile(file);
  await writeFile(path.join(dir, "src/a.js"), `// one\n// two\n${SOURCE}`);
  const report = await stampBoardFile(file);
  assert.equal(report?.cards[0].status, "moved");
  assert.equal(report?.cards[0].moved_to, "src/a.js:3-5");
  assert.equal(report?.changed, false);
  const repinned = await stampBoardFile(file, { repin: true });
  assert.equal(repinned?.cards[0].status, "repinned");
  assert.match(await readFile(file, "utf8"), /data-code="src\/a.js:3-5"/);
});

test("readBoard sizes code cards to their longest line and wraps past the column limit", async (t) => {
  const long = `  const message = "${"x".repeat(150)}";`;
  const dir = await repo(t, {
    "src/wide.js": ["function wide() {", long, "}"].join("\n"),
    ".hilight/board.html": board(`
  <section id="narrow" data-card data-code="src/a.js:1-3" data-x="0" data-y="0"><h3>a()</h3></section>
  <section id="wide" data-card data-code="src/wide.js:1-3" data-x="0" data-y="400"><h3>wide()</h3></section>
  <section id="capped" data-card data-code="src/wide.js:1-3" data-x="900" data-y="400" data-w="420"><h3>capped</h3></section>`),
    "src/a.js": SOURCE,
  });
  const model = await readBoard(path.join(dir, ".hilight/board.html"));
  assert.ok(model);
  const byId = Object.fromEntries(model.cards.map((card) => [card.id, card]));
  const { char, line, maxCols, minCols } = CODE_CARD_LAYOUT;
  // Short code takes the minimum width; long code stops at the column limit and wraps.
  assert.equal(byId.narrow.code.cols, minCols);
  assert.equal(byId.narrow.w, codeCardWidth(minCols));
  assert.equal(byId.wide.code.cols, maxCols);
  const wideRows = codeRows(byId.wide.code.lines, maxCols);
  assert.equal(wideRows.length, 4);
  assert.equal(byId.wide.h, codeCardHeight(byId.wide));
  assert.ok(byId.wide.h > codeCardHeight(byId.narrow));
  // A data-w is a ceiling: the card keeps within it and wraps sooner.
  assert.ok(byId.capped.w <= 420);
  assert.equal(byId.capped.code.cols, Math.floor((420 - (byId.capped.w - byId.capped.code.cols * char)) / char));
  assert.ok(
    codeRows(byId.capped.code.lines, byId.capped.code.cols).every((row) => row.text.length <= byId.capped.code.cols),
  );
  assert.equal(line, 20);
});

const MINIMAL = `<main data-hilight-board="Checkout">
  <p>How a payment request becomes a charge, and where it can fail twice.</p>
  <section id="intro"><h2>Start here</h2><p>Read the two flows left to right.</p></section>
  <section id="api" data-code="src/api.js:1-3"><h2>API</h2><p>Takes the request and checks the key.</p></section>
  <section id="charge" data-code="src/charge.js:1-3"><h2>Charge</h2><p>Calls the processor once.</p></section>
  <section id="store" data-code="src/store.js:1-3"><h2>Store</h2><p>Remembers the key.</p></section>
  <ol data-flow="Pay">
    <li>api:2 -> charge:1-2 hands the request on</li>
    <li>charge:3 → store:2</li>
  </ol>
  <ol data-flow="Retry"><li>store:1 -> api:3 a retry finds the key</li></ol>
</main>`;

test("parseFlowStep reads chained steps and their words, and explains a bad step", () => {
  assert.deepEqual(parseFlowStep("a:1-2 -> b:3 → c then it ends").steps, [
    {
      from: { card: "a", lines: { start: 1, end: 2 } },
      to: { card: "b", lines: { start: 3, end: 3 } },
      text: "then it ends",
    },
    { from: { card: "b", lines: { start: 3, end: 3 } }, to: { card: "c", lines: null }, text: "then it ends" },
  ]);
  assert.match(parseFlowStep("api calls charge").error, /write it as cardA:12-18 -> cardB:40-44/);
});

test("a minimal board needs only sections, flows and text; the app lays it out by flow", () => {
  const model = parseBoardHtml(MINIMAL);
  assert.ok(model);
  assert.deepEqual(
    model.cards.map((card) => [card.id, card.kind]),
    [
      ["intro", "html"],
      ["api", "code"],
      ["charge", "code"],
      ["store", "code"],
    ],
  );
  assert.equal(model.levels[0].summary, "How a payment request becomes a charge, and where it can fail twice.");
  assert.deepEqual(
    model.flows.map((flow) => [flow.name, flow.steps.length, flow.color]),
    [
      ["Pay", 2, model.flows[0].color],
      ["Retry", 1, model.flows[1].color],
    ],
  );
  assert.notEqual(model.flows[0].color, model.flows[1].color);
  assert.deepEqual(model.problems, []);
  const byId = Object.fromEntries(model.cards.map((card) => [card.id, card]));
  // Text cards sit above the flow; each step's target is right of its source.
  assert.ok(byId.intro.y + byId.intro.h < byId.api.y);
  assert.ok(byId.charge.x > byId.api.x + byId.api.w);
  assert.ok(byId.store.x > byId.charge.x + byId.charge.w);
  for (const a of model.cards) {
    for (const b of model.cards) {
      if (a === b) continue;
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, `${a.id} and ${b.id} do not overlap`);
    }
  }
  // The flow list is not part of the summary or any card.
  assert.doesNotMatch(model.levels[0].summary, /->/);
});

test("board problems say what is wrong and what to write instead", () => {
  const model = parseBoardHtml(
    MINIMAL.replace("charge:3 → store:2", "charge:3 → stor:2")
      .replace("store:1 -> api:3", "store:1 -> api:30")
      .replace("<li>api:2", "<li>api calls charge</li><li>intro:4 -> api:2</li><li>api:2"),
  );
  assert.ok(model);
  const text = model.problems.join("\n");
  assert.match(text, /Flow "Pay": "api calls charge" is not a step: write it as cardA:12-18 -> cardB:40-44/);
  assert.match(text, /no card "stor"\. Cards here: intro, api, charge, store\./);
  assert.match(text, /api:30-30 is outside its lines 1-3/);
  assert.match(text, /"intro" is not a code card, so drop the :4 lines/);
});

test("each flow gets its own band, in the order the flows are written", () => {
  const model = parseBoardHtml(`<main data-hilight-board="Two flows">
<section id="a" data-code="a.js:1-3"><h2>A</h2></section>
<section id="b" data-code="b.js:1-3"><h2>B</h2></section>
<section id="c" data-code="c.js:1-3"><h2>C</h2></section>
<section id="d" data-code="d.js:1-3"><h2>D</h2></section>
<ol data-flow="First"><li>a:1 -> b:2 calls</li></ol>
<ol data-flow="Second"><li>c:1 -> d:2 calls</li><li>d:3 -> b:1 reuses</li></ol>
</main>`);
  assert.ok(model);
  const byId = Object.fromEntries(model.cards.map((card) => [card.id, card]));
  const firstBottom = Math.max(byId.a.y + byId.a.h, byId.b.y + byId.b.h);
  assert.ok(byId.c.y >= firstBottom, "the second flow sits below the first");
  assert.ok(byId.d.y >= firstBottom);
  assert.ok(byId.d.x > byId.c.x + byId.c.w, "each band still reads left to right");
});

test("the board playbook's copyable example parses with no problems", async () => {
  const { findPlaybook } = await import("../src/playbooks.js");
  const playbook = findPlaybook("board");
  assert.ok(playbook && typeof playbook.example === "string");
  const model = parseBoardHtml(playbook.example);
  assert.ok(model, "the example is a board");
  assert.deepEqual(model.problems, []);
  assert.ok(model.flows.length >= 2, "the example shows more than one flow");
});

test("loose cards stay three to a row for small boards and grow with the square root for large ones", () => {
  const cards = (n) =>
    Array.from({ length: n }, (_, index) => ({
      id: `t${index}`,
      kind: "html",
      w: 300,
      h: 160,
      placed: false,
      html: "",
    }));
  const rowsOf = (list) => new Set(list.map((card) => card.y)).size;
  const small = cards(9);
  layoutLevel(small);
  assert.equal(rowsOf(small), 3);
  const large = cards(144);
  layoutLevel(large);
  assert.equal(rowsOf(large), 12, "144 loose cards make a 12 by 12 grid, not 48 rows of three");
});

test("parseBoardHtml marks HTML cards auto_h only when data-h is absent and preserves html/body attrs", () => {
  const model = parseBoardHtml(`<!doctype html>
<html lang="en" data-theme="luxury">
  <head><title>Board</title></head>
  <body class="app-body">
    <main data-hilight-board="Board">
      <section id="auto"><h2>Auto</h2><p>No explicit height.</p><pre>a\nb\nc\nd\ne\nf\ng\nh</pre></section>
      <section id="fixed" data-h="310"><h2>Fixed</h2><p>Explicit height.</p></section>
    </main>
  </body>
</html>`);
  assert.ok(model);
  assert.deepEqual(model.html_attrs, [
    ["lang", "en"],
    ["data-theme", "luxury"],
  ]);
  assert.deepEqual(model.body_attrs, [["class", "app-body"]]);
  const byId = Object.fromEntries(model.cards.map((card) => [card.id, card]));
  assert.equal(byId.auto.auto_h, true);
  assert.equal(byId.fixed.auto_h, false);
  assert.equal(byId.fixed.h, 310);
  // Preformatted multiline blocks increase the initial height estimate.
  assert.ok(byId.auto.h > 260, `expected multiline <pre> card estimate > 260, got ${byId.auto.h}`);
});
