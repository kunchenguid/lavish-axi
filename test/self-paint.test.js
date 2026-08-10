import assert from "node:assert/strict";
import test from "node:test";

import { analyzeSelfPaint, SELF_PAINT_WARNING } from "../src/self-paint.js";

function page(bodyAttrs, head = "", body = "<p>Report text</p>") {
  return `<!doctype html><html><head>${head}</head><body${bodyAttrs ? ` ${bodyAttrs}` : ""}>${body}</body></html>`;
}

test("an artifact with no styling at all is unpainted", () => {
  assert.equal(analyzeSelfPaint(page("")).painted, false);
});

test("the incident shape - element text colors but no page background - is unpainted", () => {
  // The real failure: light text styled on elements, dark surface assumed, page never painted.
  const html = page(
    "",
    `<style>
      h1 { color: #f8fafc; font-size: 2rem; }
      p { color: #e2e8f0; }
      .caption { color: rgba(255, 255, 255, 0.7); }
    </style>`,
    "<h1>Before / After</h1><p>Almost invisible</p>",
  );
  assert.equal(analyzeSelfPaint(html).painted, false);
});

test("a background on a non-root wrapper does not count as painting the page", () => {
  const html = page("", "<style>.board { background: #0b1020; color: #eee; }</style>");
  assert.equal(analyzeSelfPaint(html).painted, false);
});

test("selector tokens that merely contain body or html do not count", () => {
  const html = page("", "<style>.body-card { background: #fff; } #html-view { background: #000; }</style>");
  assert.equal(analyzeSelfPaint(html).painted, false);
});

test("a body background rule paints the page", () => {
  const html = page("", "<style>body { background: #0b1020; color: #e2e8f0; }</style>");
  const result = analyzeSelfPaint(html);
  assert.equal(result.painted, true);
  assert.equal(result.signal, "root-background-rule");
});

test(":root and html background rules paint the page", () => {
  assert.equal(analyzeSelfPaint(page("", "<style>:root { background-color: #fff; }</style>")).painted, true);
  assert.equal(analyzeSelfPaint(page("", "<style>html { background: canvas; }</style>")).painted, true);
  assert.equal(analyzeSelfPaint(page("", "<style>* { background: #fff; }</style>")).painted, true);
});

test("a root background rule nested in a media query paints the page", () => {
  const html = page(
    "",
    "<style>@media (prefers-color-scheme: dark) { body { background: #020617; color: #f8fafc; } }</style>",
  );
  assert.equal(analyzeSelfPaint(html).painted, true);
});

test("minified and grouped selectors still count", () => {
  assert.equal(
    analyzeSelfPaint(page("", "<style>html,body{margin:0;background:#111;color:#eee}</style>")).painted,
    true,
  );
  assert.equal(analyzeSelfPaint(page("", "<style>body.dark{background:var(--bg)}</style>")).painted, true);
});

test("a data-theme attribute on html or body paints the page", () => {
  const html = `<!doctype html><html data-theme="luxury"><body><p>x</p></body></html>`;
  const result = analyzeSelfPaint(html);
  assert.equal(result.painted, true);
  assert.equal(result.signal, "data-theme");
  assert.equal(analyzeSelfPaint(page(`data-theme="night"`)).painted, true);
});

test("a background utility class on html or body paints the page", () => {
  assert.equal(analyzeSelfPaint(page(`class="bg-base-100 text-base-content"`)).painted, true);
  assert.equal(analyzeSelfPaint(page(`class="min-h-screen dark:bg-slate-900"`)).painted, true);
  assert.equal(analyzeSelfPaint(page(`class="bg-[#0b1020]"`)).painted, true);
});

test("non-background classes on body do not count", () => {
  assert.equal(analyzeSelfPaint(page(`class="prose max-w-3xl no-bg-here"`)).painted, false);
});

test("an inline background style on html or body paints the page", () => {
  assert.equal(analyzeSelfPaint(page(`style="background: linear-gradient(#111, #333); color: #eee"`)).painted, true);
  assert.equal(analyzeSelfPaint(page(`STYLE="BACKGROUND:#111"`)).painted, true);
});

test("an inline background on a wrapper element does not count", () => {
  assert.equal(analyzeSelfPaint(page("", "", `<div style="background:#111"><p>x</p></div>`)).painted, false);
});

test("any stylesheet link fails open as painted", () => {
  const html = page("", `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/daisyui@5/daisyui.css">`);
  const result = analyzeSelfPaint(html);
  assert.equal(result.painted, true);
  assert.equal(result.signal, "stylesheet-link");
  assert.equal(analyzeSelfPaint(page("", `<link href="./local.css" rel="stylesheet">`)).painted, true);
});

test("a CSS @import fails open as painted", () => {
  assert.equal(analyzeSelfPaint(page("", `<style>@import url("theme.css");</style>`)).painted, true);
});

test("the Tailwind browser runtime script fails open as painted", () => {
  const html = page(
    "",
    `<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.2.4/dist/index.global.js"></script>`,
  );
  assert.equal(analyzeSelfPaint(html).painted, true);
});

test("an explicit color-scheme paints the page with UA default colors", () => {
  assert.equal(analyzeSelfPaint(page("", `<meta name="color-scheme" content="light dark">`)).painted, true);
  assert.equal(analyzeSelfPaint(page("", `<style>:root { color-scheme: dark; }</style>`)).painted, true);
});

test("CSS comments cannot fake a paint signal", () => {
  const html = page("", "<style>/* body { background: #fff } */ h1 { color: #eee }</style>");
  assert.equal(analyzeSelfPaint(html).painted, false);
});

test("the warning names the failure and the fix in one line", () => {
  assert.match(SELF_PAINT_WARNING, /never paints its own page surface/);
  assert.match(SELF_PAINT_WARNING, /injects no design system/);
  assert.match(SELF_PAINT_WARNING, /invisible/);
  assert.match(SELF_PAINT_WARNING, /background/);
  assert.match(SELF_PAINT_WARNING, /readable text/);
  assert.ok(!SELF_PAINT_WARNING.includes("\n"), "stays a single line for AXI output");
});
