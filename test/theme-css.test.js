import assert from "node:assert/strict";
import test from "node:test";

import { parseThemeCustomProperties, resolveCustomProperty, serializeCustomProperties } from "../src/theme-css.js";

test("parseThemeCustomProperties collects custom properties declared on root selectors", () => {
  const tokens = parseThemeCustomProperties(`
    :root { --bg: #2b0a3d; --accent: #00e5a0; }
    html { --fg: #ffe9c7; }
    :host { --border: #7a3fa8; }
  `);

  assert.deepEqual(tokens, {
    "--bg": "#2b0a3d",
    "--accent": "#00e5a0",
    "--fg": "#ffe9c7",
    "--border": "#7a3fa8",
  });
});

test("parseThemeCustomProperties keeps the last declaration, matching the cascade", () => {
  const tokens = parseThemeCustomProperties(":root{--accent:#111}\n:root{--accent:#222}");

  assert.equal(tokens["--accent"], "#222");
});

test("parseThemeCustomProperties forwards only custom properties, never ordinary rules", () => {
  const tokens = parseThemeCustomProperties(`
    :root { --accent: #00e5a0; background: red; color: blue; }
    .bar { --accent: #ffffff; }
    #send { --accent: #000000; }
  `);

  assert.deepEqual(tokens, { "--accent": "#00e5a0" });
});

test("parseThemeCustomProperties skips at-rules, whose tokens are conditional", () => {
  const tokens = parseThemeCustomProperties(`
    :root { --accent: #00e5a0; }
    @media (prefers-color-scheme: dark) { :root { --accent: #ff0000; } }
  `);

  assert.deepEqual(tokens, { "--accent": "#00e5a0" });
});

test("parseThemeCustomProperties ignores comments", () => {
  const tokens = parseThemeCustomProperties(":root{/* --accent: #bad; */ --fg: #fff;}");

  assert.deepEqual(tokens, { "--fg": "#fff" });
});

test("parseThemeCustomProperties drops values that could fetch or inject syntax", () => {
  const tokens = parseThemeCustomProperties(`
    :root {
      --safe: #00e5a0;
      --fetch: url(https://example.test/x.png);
      --imageset: image-set("a.png" 1x);
      --markup: </style><script>;
      --at: red @import "x";
      --unbalanced: rgb(0,0,0;
      --empty: ;
    }
  `);

  assert.deepEqual(Object.keys(tokens), ["--safe"]);
});

test("parseThemeCustomProperties cannot be used to smuggle a rule past the root-selector gate", () => {
  // A stray `}` ends the rule during the brace scan rather than landing inside a
  // value, so the smuggled rule is simply parsed as its own - and dropped, because
  // `body` is not a root selector. Only the (harmless) truncated value survives.
  const tokens = parseThemeCustomProperties(":root{--accent:red}body{display:none;--accent:blue}");

  assert.deepEqual(tokens, { "--accent": "red" });
});

test("parseThemeCustomProperties bounds value length and validates names", () => {
  const tokens = parseThemeCustomProperties(
    `:root{--long:${"a".repeat(600)};--bad name:#fff;--ok:#fff;-not-custom:#fff;}`,
  );

  assert.deepEqual(tokens, { "--ok": "#fff" });
});

test("parseThemeCustomProperties tolerates empty, non-string, and truncated input", () => {
  assert.deepEqual(parseThemeCustomProperties(""), {});
  assert.deepEqual(parseThemeCustomProperties(undefined), {});
  assert.deepEqual(parseThemeCustomProperties(":root{--accent:#00e5a0"), { "--accent": "#00e5a0" });
});

test("parseThemeCustomProperties keeps values whose parentheses and commas are balanced", () => {
  const tokens = parseThemeCustomProperties(
    ':root{--accent:rgb(0 229 160 / 60%);--font-sans:"Courier New", monospace;--fallback:var(--brand, #fff);}',
  );

  assert.deepEqual(tokens, {
    "--accent": "rgb(0 229 160 / 60%)",
    "--font-sans": '"Courier New", monospace',
    "--fallback": "var(--brand, #fff)",
  });
});

test("serializeCustomProperties renders declarations for a single block", () => {
  assert.equal(serializeCustomProperties({ "--bg": "#000", "--fg": "#fff" }), "--bg:#000;--fg:#fff;");
  assert.equal(serializeCustomProperties({}), "");
  assert.equal(serializeCustomProperties(undefined), "");
});

test("resolveCustomProperty reduces a var() chain to a literal", () => {
  const tokens = { "--brand": "#00e5a0", "--accent": "var(--brand)", "--alias": "var(--accent)" };

  assert.equal(resolveCustomProperty(tokens, "--alias"), "#00e5a0");
  assert.equal(resolveCustomProperty(tokens, "--brand"), "#00e5a0");
});

test("resolveCustomProperty returns nothing when the token is absent or unresolvable", () => {
  assert.equal(resolveCustomProperty({}, "--accent"), "");
  assert.equal(resolveCustomProperty({ "--accent": "var(--missing)" }, "--accent"), "");
  assert.equal(resolveCustomProperty({ "--a": "var(--b)", "--b": "var(--a)" }, "--a"), "");
  // A partial reference cannot stand alone outside the block that declares the tokens.
  assert.equal(resolveCustomProperty({ "--accent": "var(--brand, #fff)" }, "--accent"), "");
});
