import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The Mermaid-to-Excalidraw converter reaches into mermaid's rendered DOM and
// diagram.db internals, and versions past 11.13.0 silently degrade class/ER/
// state diagrams and subgraph flowcharts to non-editable image fallbacks
// (mermaid-to-excalidraw#108). The whiteboard bundle therefore pins mermaid
// EXACTLY - independent of the newer Mermaid CDN version artifacts use for
// rendering. If a bump is attempted, this test forces a deliberate re-probe of
// native conversion before it lands.

const REQUIRED_EXACT_PINS = {
  mermaid: "11.12.1",
  "@excalidraw/excalidraw": "0.18.1",
  "@excalidraw/mermaid-to-excalidraw": "2.2.2",
};

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

test("whiteboard dependencies are pinned exactly in package.json", () => {
  const pkg = readJson("../package.json");
  for (const [name, version] of Object.entries(REQUIRED_EXACT_PINS)) {
    assert.equal(pkg.devDependencies[name], version, `${name} must be pinned exactly to ${version}`);
  }
});

test("the installed mermaid the whiteboard bundles is the pinned version", () => {
  const installed = readJson("../node_modules/mermaid/package.json");
  assert.equal(installed.version, REQUIRED_EXACT_PINS.mermaid);
});

test("the converter and editor resolve to their pinned versions", () => {
  assert.equal(
    readJson("../node_modules/@excalidraw/mermaid-to-excalidraw/package.json").version,
    REQUIRED_EXACT_PINS["@excalidraw/mermaid-to-excalidraw"],
  );
  assert.equal(
    readJson("../node_modules/@excalidraw/excalidraw/package.json").version,
    REQUIRED_EXACT_PINS["@excalidraw/excalidraw"],
  );
});
