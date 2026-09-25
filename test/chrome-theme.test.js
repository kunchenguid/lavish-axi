import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CHROME_THEME_STORAGE_KEY,
  CHROME_THEMES,
  DEFAULT_CHROME_THEME,
  createChromeThemeBootJs,
  createChromeThemeCss,
  resolveChromeTheme,
  serializeChromeThemes,
} from "../src/chrome-theme.js";

const chromeCss = await readFile(new URL("../src/chrome.css", import.meta.url), "utf8");

const PALETTE = /^--(ink|steel|brass|cream|sage|amber|rust)-/;

function rootTokens(css) {
  const start = css.indexOf(":root {");
  const block = css.slice(start, css.indexOf("\n}", start));
  const raw = new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
  const resolve = (value) => value.replace(/var\((--[\w-]+)\)/g, (_, name) => resolve(raw.get(name) ?? ""));
  return { raw, resolved: new Map([...raw].map(([name, value]) => [name, resolve(value)])) };
}

const { raw: rawDefaults, resolved: defaults } = rootTokens(chromeCss);

// Every token the chrome's rules read color from, straight off the palette. A theme that forgot
// one would inherit the dark default for that surface - a dark hover row inside a light panel.
// Tokens composed from other role tokens (`--hairline: 1px solid var(--border)`) follow on
// their own, so a theme never restates them.
const ROLE_TOKENS = [...rawDefaults.keys()].filter(
  (name) =>
    !PALETTE.test(name) &&
    /#|rgba|dark|light/.test(defaults.get(name) ?? "") &&
    [...(rawDefaults.get(name) ?? "").matchAll(/var\((--[\w-]+)\)/g)].every(([, ref]) => PALETTE.test(ref)),
);

function channels(color) {
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1);
  const rgba = color.match(/^rgba?\(([^)]+)\)$/);
  assert.ok(rgba, `unparseable color ${color}`);
  const [r, g, b, a = 1] = rgba[1].split(",").map(Number);
  return [r, g, b, a];
}

function over(top, bottom) {
  const [r, g, b, a] = channels(top);
  const [br, bg, bb] = channels(bottom);
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];
}

/** @param {number[]} rgb */
function luminance(rgb) {
  const [r, g, b] = rgb;
  const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// A translucent surface (the warnings button's wash) is judged composited over the opaque
// surface it actually sits on.
function contrast(fg, bg, base = bg) {
  const ground = over(bg, base);
  const text = over(fg, `rgb(${ground.join(",")})`);
  const [a, b] = [luminance(text), luminance(ground)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("the default theme is brass and its tokens are exactly the stylesheet's defaults", () => {
  assert.equal(DEFAULT_CHROME_THEME, "brass");
  const brass = CHROME_THEMES.find((theme) => theme.id === "brass");
  assert.ok(brass);
  for (const name of ROLE_TOKENS) assert.equal(brass.tokens[name], defaults.get(name), name);
});

test("every theme defines every role token the chrome reads", () => {
  assert.ok(ROLE_TOKENS.length >= 40, `expected the full role layer, found ${ROLE_TOKENS.length}`);
  assert.deepEqual(
    CHROME_THEMES.map((theme) => theme.id),
    ["brass", "paper", "daylight", "graphite", "fjord"],
  );
  for (const theme of CHROME_THEMES) {
    assert.deepEqual(Object.keys(theme.tokens).sort(), [...ROLE_TOKENS].sort(), theme.id);
    assert.match(theme.tokens["--color-scheme"], /^(light|dark)$/, theme.id);
  }
});

test("every theme keeps chrome text at WCAG AA on every surface it sits on", () => {
  for (const { id, tokens: t } of CHROME_THEMES) {
    const text = ["--fg", "--fg-muted", "--fg-dim", "--fg-faint", "--fg-label"];
    const surfaces = ["--bg", "--bg-panel", "--bg-bar", "--bg-elevated"];
    for (const fg of text) {
      for (const bg of surfaces) {
        const ratio = contrast(t[fg], t[bg]);
        assert.ok(ratio >= 4.5, `${id}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
      }
    }
    const pairs = [
      ["--accent-ink", "--accent"],
      ["--warn-badge-ink", "--warn-badge"],
      ["--accent", "--bg-panel"],
      ["--danger", "--bg-panel"],
      ["--fg-code", "--bg"],
    ];
    for (const [fg, bg] of pairs) {
      const ratio = contrast(t[fg], t[bg]);
      assert.ok(ratio >= 4.5, `${id}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
    }
    const warn = contrast(t["--warn-fg"], t["--warn-bg"], t["--bg-bar"]);
    assert.ok(warn >= 4.5, `${id}: --warn-fg on --warn-bg is ${warn.toFixed(2)}:1`);
  }
});

test("resolveChromeTheme accepts only known theme ids", () => {
  assert.equal(resolveChromeTheme("paper"), "paper");
  assert.equal(resolveChromeTheme("brass"), "brass");
  assert.equal(resolveChromeTheme("PAPER"), DEFAULT_CHROME_THEME);
  assert.equal(resolveChromeTheme("javascript:alert(1)"), DEFAULT_CHROME_THEME);
  assert.equal(resolveChromeTheme(null), DEFAULT_CHROME_THEME);
});

test("the theme stylesheet overrides the role layer for every non-default theme only", () => {
  const css = createChromeThemeCss();
  assert.doesNotMatch(css, /data-lavish-theme="brass"/);
  for (const theme of CHROME_THEMES.filter((entry) => entry.id !== DEFAULT_CHROME_THEME)) {
    const block = css.match(new RegExp(`:root\\[data-lavish-theme="${theme.id}"\\]\\s*\\{([^}]*)\\}`));
    assert.ok(block, theme.id);
    for (const name of ROLE_TOKENS) assert.match(block[1], new RegExp(`${name}:\\s*[^;]+;`), `${theme.id} ${name}`);
  }
  assert.doesNotMatch(css, /<\/?style/i);
});

test("the boot script applies a stored theme before first paint and ignores anything else", () => {
  const boot = createChromeThemeBootJs();
  const run = (stored, { throwOnRead = false } = {}) => {
    const attributes = new Map();
    const document = {
      documentElement: {
        setAttribute: (name, value) => attributes.set(name, value),
      },
    };
    const localStorage = {
      getItem(key) {
        if (throwOnRead) throw new Error("storage disabled");
        return key === CHROME_THEME_STORAGE_KEY ? stored : null;
      },
    };
    new Function("document", "localStorage", boot)(document, localStorage);
    return attributes.get("data-lavish-theme") ?? null;
  };
  assert.equal(run("paper"), "paper");
  assert.equal(run("fjord"), "fjord");
  assert.equal(run("brass"), null);
  assert.equal(run('paper"><script>'), null);
  assert.equal(run(null), null);
  assert.equal(run("paper", { throwOnRead: true }), null);
});

test("serialized themes carry what the picker and the annotation card need, nothing executable", () => {
  const serialized = serializeChromeThemes();
  assert.deepEqual(
    serialized.map((theme) => theme.id),
    CHROME_THEMES.map((theme) => theme.id),
  );
  for (const theme of serialized) {
    assert.equal(typeof theme.name, "string");
    assert.equal(typeof theme.description, "string");
    assert.match(theme.swatch.ground, /^#[0-9a-f]{6}$/i);
    assert.match(theme.swatch.accent, /^#[0-9a-f]{6}$/i);
    if (theme.id === DEFAULT_CHROME_THEME) {
      assert.equal(theme.sdk, null);
      continue;
    }
    for (const [name, value] of Object.entries(theme.sdk)) {
      assert.match(name, /^--[a-z-]+$/);
      assert.doesNotMatch(String(value), /[;{}<>]/);
    }
  }
});
