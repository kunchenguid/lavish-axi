import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const chromeCss = await readFile(new URL("../src/chrome.css", import.meta.url), "utf8");

// The first `:root { ... }` block owns the palette and the role tokens built on it.
function splitRootBlock(css) {
  const start = css.indexOf(":root {");
  assert.notEqual(start, -1, "chrome.css must open with a :root token block");
  const end = css.indexOf("\n}", start);
  return { root: css.slice(start, end + 2), rules: css.slice(end + 2) };
}

test("chrome.css rules read colors from role tokens, never the raw palette", () => {
  const { rules } = splitRootBlock(chromeCss);
  const offenders = [];
  rules.split("\n").forEach((line, index) => {
    if (/^\s*\/?\*/.test(line)) return;
    if (/rgba?\(|#[0-9a-f]{3,8}\b|var\(--(ink|steel|brass|cream|sage|amber|rust)-/i.test(line)) {
      offenders.push(`${index + 1}: ${line.trim()}`);
    }
  });
  // The artifact frame shows the browser's default page color until the artifact paints its
  // own; that is the artifact's canvas, not chrome styling, so it stays literal.
  const artifactCanvas = (line) => line.endsWith("background: #fff;");
  assert.equal(offenders.filter(artifactCanvas).length, 1);
  assert.deepEqual(
    offenders.filter((line) => !artifactCanvas(line)),
    [],
  );
});

test("color-scheme follows the role token so a light theme gets light native controls", () => {
  const { root, rules } = splitRootBlock(chromeCss);
  assert.match(root, /--color-scheme:\s*dark;/);
  assert.match(rules, /body\.lavish\s*\{\s*color-scheme:\s*var\(--color-scheme\);/);
});
