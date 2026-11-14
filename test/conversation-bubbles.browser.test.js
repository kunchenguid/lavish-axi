import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// What the Conversation panel shows, measured in a real browser. The panel hides horizontal
// overflow, so a word that cannot wrap loses its tail: a reviewer's long URL, an agent's long path,
// or a fenced command that the renderer failed to recognize inside a list item. The README promises
// that fenced and inline code render and that the reviewer's own messages are kept, so every
// assertion here is something a reader of the panel would see.
const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, env, timeout = 45_000) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a TCP port");
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return address.port;
}

const ARTIFACT = `<!doctype html>
<html><head><meta charset="utf-8"><title>Bubble fixture</title></head>
<body><h1>Search rollback</h1><p>Runbook draft.</p></body></html>`;

// Each has a segment with no break opportunity at all, wider than the bubble: a browser may break
// at a slash or a hyphen, never inside a run of letters and digits.
const LONG_PATH = "/Users/reviewer/search/config/productsV2RollbackAliasesForTheBlackFridayCutoverWindow.json";
const LONG_URL = "https://cdn.example.test/exports/" + "9f8e7d6c5b4a3210".repeat(6) + ".csv";
// Short spans with a space inside, enough of them that some reach the end of a line.
const WINDOWS = Array.from({ length: 12 }, (_, index) => "`2026-12-" + String(index + 1).padStart(2, "0") + " 09:30`");
const REPLY = [
  "## Rollback plan",
  "The alias file is `" + LONG_PATH + "`, and the windows are " + WINDOWS.join(", ") + ".",
  "",
  "1. Swap the alias back:",
  "   ```sh",
  "   curl -X POST https://search.internal/_aliases -H 'Content-Type: application/json' -d @" + LONG_PATH,
  "   ```",
  "2. Check the document counts.",
].join("\n");
// A reply that ends with a heading keeps the heading's own bottom margin, as it always has.
const TRAILING_HEADING_REPLY = "Rolled back.\n\n## Next steps";
// A short span, three lists deep: at the narrowest supported width it is wider than its line.
const DEEP_SPAN = "2026-12-03 09:30:00 UTC";
const DEEP_REPLY = "- Cutover\n  - Search\n    - Window: `" + DEEP_SPAN + "`";

const GROWING_NOTE = Array.from({ length: 8 }, (_, index) => `Line ${index + 1} of the note about the intro.`).join(
  "\n",
);
const CAPPED_NOTE = Array.from({ length: 80 }, (_, index) => `Line ${index + 1} of a very long note.`).join("\n");
const QUEUED = [GROWING_NOTE, CAPPED_NOTE, `Please link ${LONG_URL} in the summary.`].map((prompt) => ({
  uid: "",
  prompt,
  selector: "",
  tag: "message",
  text: "Freeform message",
}));
const RETIRED_DRAFT = `Use ${LONG_URL} here.`;

const SEED = `() => {
  const key = location.pathname.split("/").pop();
  sessionStorage.setItem("lavish-axi:queued:" + key, ${JSON.stringify(JSON.stringify(QUEUED))});
  sessionStorage.setItem("lavish-axi:retired-drafts:" + key, ${JSON.stringify(JSON.stringify([RETIRED_DRAFT]))});
  return "ok";
}`;

// How many lines a code span's own text sits on, whether its chip is inline or a block.
const TEXT_LINES = `(el) => {
  const range = document.createRange();
  range.selectNodeContents(el.firstChild);
  return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
}`;

const MEASURE = `() => {
  const textLines = ${TEXT_LINES};
  const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
  const fit = (el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
  const agent = document.querySelector("#chatLog .bubble.agent");
  const md = agent.querySelector(".chat-md");
  const codes = [...md.querySelectorAll("p code")];
  const longCode = codes.find((el) => el.textContent === ${JSON.stringify(LONG_PATH)});
  const range = document.createRange();
  range.selectNodeContents(longCode.firstChild);
  const textRects = [...range.getClientRects()];
  const chips = [...longCode.getClientRects()].map((chip) => {
    const text = textRects.find((rect) => rect.top < chip.bottom && rect.bottom > chip.top);
    return { left: chip.left, right: chip.right, before: text ? text.left - chip.left : null, after: text ? chip.right - text.right : null };
  });
  const item = md.querySelector("li > pre")?.parentElement || null;
  const fenced = item ? item.querySelector(":scope > pre") : null;
  const queuedUrl = [...document.querySelectorAll("#queuedLog .bubble.queued .bubble-text")].find((el) => el.textContent.includes(${JSON.stringify(LONG_URL)}));
  const draft = document.querySelector("#chatLog .bubble.note .note-draft");
  return JSON.stringify({
    bubble: box(agent),
    firstBlock: { text: md.firstElementChild.textContent, marginTop: getComputedStyle(md.firstElementChild).marginTop },
    md: fit(md),
    chips,
    shortCodeLines: codes.filter((el) => el.textContent.endsWith(" 09:30")).map(textLines),
    fenced: fenced ? { ...box(fenced), ...fit(fenced), text: fenced.textContent, emptyCodes: item.querySelectorAll("code:empty").length } : null,
    queuedUrl: queuedUrl ? fit(queuedUrl) : null,
    draft: draft ? { ...fit(draft), text: draft.textContent } : null,
    takeoverWeight: getComputedStyle(document.getElementById("handoffTakeover")).fontWeight,
    lastBlock: (() => {
      const block = document.querySelectorAll("#chatLog .bubble.agent .chat-md")[1].lastElementChild;
      return { text: block.textContent, marginBottom: getComputedStyle(block).marginBottom };
    })(),
  });
}`;

const NARROW = `() => {
  const textLines = ${TEXT_LINES};
  const code = [...document.querySelectorAll("#chatLog .chat-md li li li code")].find((el) => el.textContent === ${JSON.stringify(DEEP_SPAN)});
  const md = code.closest(".chat-md");
  const bubble = code.closest(".bubble").getBoundingClientRect();
  const chip = code.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(code.firstChild);
  const text = [...range.getClientRects()];
  return JSON.stringify({
    viewport: innerWidth,
    bubble: { left: bubble.left, right: bubble.right },
    chip: { left: chip.left, right: chip.right },
    textLeft: Math.min(...text.map((rect) => rect.left)),
    textRight: Math.max(...text.map((rect) => rect.right)),
    lines: textLines(code),
    md: { scrollWidth: md.scrollWidth, clientWidth: md.clientWidth },
    shortCodeLines: [...document.querySelectorAll("#chatLog .chat-md p code")].filter((el) => el.textContent.endsWith(" 09:30")).map(textLines),
  });
}`;

function editorMeasure(index) {
  return `() => {
    document.querySelector('#queuedLog .queued-edit[data-index="${index}"]').click();
    const input = document.querySelector("#queuedLog .queued-edit-input");
    return JSON.stringify({
      fieldSizing: CSS.supports("field-sizing", "content"),
      value: input.value,
      height: input.getBoundingClientRect().height,
      clientHeight: input.clientHeight,
      scrollHeight: input.scrollHeight,
      cap: innerHeight * 0.4,
    });
  }`;
}

test(
  "conversation bubbles keep long text, inline code, list code, and the queued editor inside the panel",
  { skip: !runBrowserE2e, timeout: 300_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-bubbles-"));
    const port = await freePort();
    const lavishEnv = {
      LAVISH_AXI_PORT: String(port),
      LAVISH_AXI_STATE_DIR: path.join(temp, "state"),
      LAVISH_AXI_NO_OPEN: "1",
      LAVISH_AXI_TELEMETRY: "0",
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
    };
    const chromeEnv = {
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-bubbles-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };

    function evaluate(expression) {
      const output = run("chrome-devtools-axi", ["eval", expression], chromeEnv);
      const raw = output.match(/result:\s*("(?:[^"\\]|\\.)*")/s)?.[1];
      assert.ok(raw, output);
      let value = JSON.parse(raw);
      while (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          break;
        }
      }
      return value;
    }

    function wait(ms) {
      run("chrome-devtools-axi", ["wait", String(ms)], chromeEnv, ms + 45_000);
    }

    function open(url, settleMs = 4000) {
      run("chrome-devtools-axi", ["open", url], chromeEnv);
      wait(settleMs);
    }

    function assertFits(name, measured) {
      assert.ok(measured, `${name} is rendered`);
      assert.ok(
        measured.scrollWidth <= measured.clientWidth,
        `${name} keeps its text inside: ${JSON.stringify(measured)}`,
      );
    }

    try {
      const artifact = path.join(temp, "review.html");
      await writeFile(artifact, ARTIFACT);
      const output = run(process.execPath, ["bin/lavish-axi.js", artifact, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);
      for (const reply of [REPLY, TRAILING_HEADING_REPLY, DEEP_REPLY]) {
        run(
          process.execPath,
          ["bin/lavish-axi.js", "poll", artifact, "--agent-reply", reply, "--timeout-ms", "200"],
          lavishEnv,
          30_000,
        );
      }

      open(url);
      run("chrome-devtools-axi", ["emulate", "--viewport", "1440x1000x1"], chromeEnv);
      evaluate(SEED);
      open(url);

      const g = evaluate(MEASURE);
      const inside = (rect) => rect.left >= g.bubble.left - 0.5 && rect.right <= g.bubble.right + 0.5;

      assert.deepEqual(g.firstBlock, { text: "Rollback plan", marginTop: "0px" }, "a leading heading sits flush");
      assert.deepEqual(g.lastBlock, { text: "Next steps", marginBottom: "4px" }, "a trailing heading is unchanged");
      assertFits("agent reply", g.md);

      assert.ok(g.chips.length > 1, `the long path wraps: ${JSON.stringify(g.chips)}`);
      for (const chip of g.chips) {
        assert.ok(inside(chip), `every fragment of the long path is inside its bubble: ${JSON.stringify(g)}`);
        assert.ok(
          chip.before >= 4 && chip.after >= 4,
          `every fragment keeps the chip's padding on both sides: ${JSON.stringify(g.chips)}`,
        );
      }
      assert.equal(g.shortCodeLines.length, WINDOWS.length);
      assert.deepEqual(
        g.shortCodeLines,
        WINDOWS.map(() => 1),
        "a short span never breaks across lines",
      );

      assert.ok(g.fenced, "the fenced block inside the list item renders as code in that item");
      assert.match(g.fenced.text, /^curl -X POST /);
      assert.equal(g.fenced.emptyCodes, 0);
      assert.ok(inside(g.fenced), `the fenced block is inside its bubble: ${JSON.stringify(g)}`);
      assertFits("fenced block", g.fenced);

      assertFits("queued note with a long URL", g.queuedUrl);
      assertFits("retired draft with a long URL", g.draft);
      assert.equal(g.draft.text, RETIRED_DRAFT);

      assert.equal(g.takeoverWeight, "600", "the takeover button uses the semibold weight token");

      const growing = evaluate(editorMeasure(0));
      assert.equal(growing.value, GROWING_NOTE);
      if (growing.fieldSizing) {
        assert.ok(growing.height > 64, `the editor grows past its minimum: ${JSON.stringify(growing)}`);
        assert.ok(
          growing.scrollHeight <= growing.clientHeight,
          `the whole note is visible: ${JSON.stringify(growing)}`,
        );
      } else {
        assert.ok(growing.height >= 64, `the editor keeps its minimum: ${JSON.stringify(growing)}`);
      }

      const capped = evaluate(editorMeasure(1));
      assert.equal(capped.value, CAPPED_NOTE);
      if (capped.fieldSizing) {
        assert.ok(capped.height <= capped.cap + 1, `the editor stops at its cap: ${JSON.stringify(capped)}`);
        assert.ok(capped.height > growing.height, `a longer note gets a taller editor: ${JSON.stringify(capped)}`);
        assert.ok(capped.scrollHeight > capped.clientHeight, "the rest of a very long note scrolls inside the editor");
      }

      // At the narrowest supported width a short span may be wider than its line: it wraps inside
      // its chip instead of running past the bubble, and the spans that fit stay on one line.
      run("chrome-devtools-axi", ["emulate", "--viewport", "320x640x1"], chromeEnv);
      wait(1000);
      const narrow = evaluate(NARROW);
      assert.equal(narrow.viewport, 320);
      assert.ok(narrow.lines > 1, `the deep span is wider than its line and wraps: ${JSON.stringify(narrow)}`);
      assert.ok(
        narrow.chip.left >= narrow.bubble.left - 0.5 && narrow.chip.right <= narrow.bubble.right + 0.5,
        `the wrapped short span stays inside its bubble: ${JSON.stringify(narrow)}`,
      );
      assert.ok(
        narrow.textLeft - narrow.chip.left >= 4 && narrow.chip.right - narrow.textRight >= 4,
        `its text keeps the chip's padding on both sides: ${JSON.stringify(narrow)}`,
      );
      assertFits("narrow agent reply", narrow.md);
      assert.deepEqual(
        narrow.shortCodeLines,
        WINDOWS.map(() => 1),
        "a short span that fits its line stays on one line at the narrowest width",
      );
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
