import test from "node:test";
import assert from "node:assert/strict";

import { buildThemeDirective, resolveSystemAppearance } from "../src/appearance.js";

function makeExec(stdout) {
  return async () => stdout;
}

function failingExec() {
  return async () => null;
}

test("resolveSystemAppearance parses macOS dark mode output", async () => {
  assert.equal(await resolveSystemAppearance("darwin", { exec: makeExec("true") }), "dark");
  assert.equal(await resolveSystemAppearance("darwin", { exec: makeExec("false") }), "light");
  assert.equal(await resolveSystemAppearance("darwin", { exec: makeExec("  TRUE  ") }), "dark");
  assert.equal(await resolveSystemAppearance("darwin", { exec: makeExec("unexpected") }), null);
});

test("resolveSystemAppearance parses Windows registry output", async () => {
  const lightReg =
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\n    AppsUseLightTheme    REG_DWORD    0x1\n";
  const darkReg =
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\n    AppsUseLightTheme    REG_DWORD    0x0\n";
  assert.equal(await resolveSystemAppearance("win32", { exec: makeExec(lightReg) }), "light");
  assert.equal(await resolveSystemAppearance("win32", { exec: makeExec(darkReg) }), "dark");
  assert.equal(await resolveSystemAppearance("win32", { exec: makeExec("no match here") }), null);
});

test("resolveSystemAppearance parses Linux gsettings color-scheme output", async () => {
  assert.equal(await resolveSystemAppearance("linux", { exec: makeExec("'prefer-dark'") }), "dark");
  assert.equal(await resolveSystemAppearance("linux", { exec: makeExec("'prefer-light'") }), "light");
  assert.equal(await resolveSystemAppearance("linux", { exec: makeExec("'default'") }), null);
});

test("resolveSystemAppearance returns null on missing binary or timeout", async () => {
  assert.equal(await resolveSystemAppearance("darwin", { exec: failingExec() }), null);
  assert.equal(await resolveSystemAppearance("win32", { exec: failingExec() }), null);
  assert.equal(await resolveSystemAppearance("linux", { exec: failingExec() }), null);
});

test("resolveSystemAppearance returns null on unsupported platforms", async () => {
  assert.equal(await resolveSystemAppearance("freebsd"), null);
  assert.equal(await resolveSystemAppearance("aix"), null);
});

test("buildThemeDirective returns null for unset preference (no nag)", async () => {
  assert.equal(await buildThemeDirective(null), null);
  assert.equal(await buildThemeDirective(undefined), null);
});

test("buildThemeDirective returns a light directive for explicit light preference", async () => {
  const directive = await buildThemeDirective("light");
  assert.match(directive, /light appearance/i);
  assert.match(directive, /do not pin a dark theme/i);
});

test("buildThemeDirective returns a dark directive for explicit dark preference", async () => {
  const directive = await buildThemeDirective("dark");
  assert.match(directive, /dark appearance/i);
  assert.match(directive, /do not pin a light theme/i);
});

test("buildThemeDirective resolves a concrete directive for system when OS appearance is provided", async () => {
  const light = await buildThemeDirective("system", { resolvedAppearance: "light" });
  const dark = await buildThemeDirective("system", { resolvedAppearance: "dark" });
  assert.match(light, /currently in light mode/i);
  assert.match(light, /will not track live OS toggles/i);
  assert.match(dark, /currently in dark mode/i);
  assert.match(dark, /will not track live OS toggles/i);
});

test("buildThemeDirective falls back to prefers-color-scheme guidance for system when OS cannot be resolved", async () => {
  const directive = await buildThemeDirective("system", { resolveSystemAppearance: failingExec() });
  assert.match(directive, /follows the OS appearance/i);
  assert.match(directive, /prefers-color-scheme/i);
  assert.match(directive, /will not live-track/i);
});

test("buildThemeDirective returns null for unknown preference values", async () => {
  assert.equal(await buildThemeDirective("sepia"), null);
  assert.equal(await buildThemeDirective("blue"), null);
});
