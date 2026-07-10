import assert from "node:assert/strict";
import test from "node:test";

import {
  PANEL_DEFAULTS,
  PANEL_STORAGE_KEY,
  clampPanelWidth,
  loadStoredPanelWidth,
  savePanelWidth,
} from "../src/panel-width.js";

test("PANEL_DEFAULTS exposes a min, maxViewportFraction, and default width", () => {
  assert.equal(typeof PANEL_DEFAULTS.min, "number");
  assert.equal(typeof PANEL_DEFAULTS.maxViewportFraction, "number");
  assert.equal(typeof PANEL_DEFAULTS.default, "number");
  assert.ok(PANEL_DEFAULTS.min > 0);
  assert.ok(PANEL_DEFAULTS.maxViewportFraction > 0 && PANEL_DEFAULTS.maxViewportFraction < 1);
  assert.ok(PANEL_DEFAULTS.default >= PANEL_DEFAULTS.min);
});

test("PANEL_STORAGE_KEY is a stable namespaced localStorage key", () => {
  assert.equal(PANEL_STORAGE_KEY, "lavish-axi:panel-w");
});

test("clampPanelWidth returns the value when it sits in the allowed range", () => {
  assert.equal(clampPanelWidth("420", 1000), 420);
  assert.equal(clampPanelWidth(420, 1000), 420);
});

test("clampPanelWidth clamps below the minimum to the minimum", () => {
  assert.equal(clampPanelWidth("100", 1000), PANEL_DEFAULTS.min);
  assert.equal(clampPanelWidth(0, 1000), PANEL_DEFAULTS.min);
  assert.equal(clampPanelWidth(-50, 1000), PANEL_DEFAULTS.min);
});

test("clampPanelWidth clamps above the viewport-fraction maximum to that maximum", () => {
  // 60% of 1000 = 600
  assert.equal(clampPanelWidth("900", 1000), 600);
  assert.equal(clampPanelWidth(900, 1000), 600);
});

test("clampPanelWidth never lets max fall below the minimum for tiny viewports", () => {
  // 60% of 400 = 240, but min is 280; max must be 280 in that case
  assert.equal(clampPanelWidth("500", 400), PANEL_DEFAULTS.min);
  assert.equal(clampPanelWidth("280", 400), PANEL_DEFAULTS.min);
});

test("clampPanelWidth falls back to the default for nullish, empty, or non-numeric input", () => {
  assert.equal(clampPanelWidth(null, 1000), PANEL_DEFAULTS.default);
  assert.equal(clampPanelWidth(undefined, 1000), PANEL_DEFAULTS.default);
  assert.equal(clampPanelWidth("", 1000), PANEL_DEFAULTS.default);
  assert.equal(clampPanelWidth("not-a-number", 1000), PANEL_DEFAULTS.default);
  assert.equal(clampPanelWidth(NaN, 1000), PANEL_DEFAULTS.default);
});

test("clampPanelWidth parses decimal pixel values", () => {
  assert.equal(clampPanelWidth("420.7", 1000), 420.7);
});

test("clampPanelWidth strips trailing 'px' units when present", () => {
  assert.equal(clampPanelWidth("420px", 1000), 420);
});

test("clampPanelWidth returns the default when the viewport is non-positive or invalid", () => {
  assert.equal(clampPanelWidth("420", 0), PANEL_DEFAULTS.default);
  assert.equal(clampPanelWidth("420", -100), PANEL_DEFAULTS.default);
  assert.equal(clampPanelWidth("420", NaN), PANEL_DEFAULTS.default);
  assert.equal(clampPanelWidth("420", Infinity), PANEL_DEFAULTS.default);
});

test("clampPanelWidth honors a caller-provided defaults override", () => {
  const overrides = { min: 200, maxViewportFraction: 0.5, default: 300 };
  assert.equal(clampPanelWidth("210", 1000, overrides), 210);
  assert.equal(clampPanelWidth("150", 1000, overrides), 200);
  // 50% of 1000 = 500
  assert.equal(clampPanelWidth("600", 1000, overrides), 500);
  assert.equal(clampPanelWidth("not-a-number", 1000, overrides), 300);
});

test("loadStoredPanelWidth reads the stored value and clamps it", () => {
  const storage = {
    values: { [PANEL_STORAGE_KEY]: "500" },
    getItem(key) {
      return this.values[key] ?? null;
    },
  };
  assert.equal(loadStoredPanelWidth(storage, 1000), 500);
});

test("loadStoredPanelWidth returns the default when the key is missing or invalid", () => {
  const empty = { getItem: () => null };
  const corrupt = { getItem: () => "not-a-number" };
  assert.equal(loadStoredPanelWidth(empty, 1000), PANEL_DEFAULTS.default);
  assert.equal(loadStoredPanelWidth(corrupt, 1000), PANEL_DEFAULTS.default);
});

test("loadStoredPanelWidth swallows storage exceptions and returns the default", () => {
  const broken = {
    getItem: () => {
      throw new Error("storage blocked");
    },
  };
  assert.equal(loadStoredPanelWidth(broken, 1000), PANEL_DEFAULTS.default);
});

test("loadStoredPanelWidth accepts a nullish storage gracefully", () => {
  assert.equal(loadStoredPanelWidth(null, 1000), PANEL_DEFAULTS.default);
  assert.equal(loadStoredPanelWidth(undefined, 1000), PANEL_DEFAULTS.default);
});

test("savePanelWidth writes a numeric string to the storage key", () => {
  const writes = [];
  const storage = {
    setItem(key, value) {
      writes.push([key, value]);
    },
  };
  savePanelWidth(storage, 420);
  assert.deepEqual(writes, [[PANEL_STORAGE_KEY, "420"]]);
});

test("savePanelWidth ignores non-finite or non-positive widths", () => {
  const writes = [];
  const storage = {
    setItem(key, value) {
      writes.push([key, value]);
    },
  };
  savePanelWidth(storage, 0);
  savePanelWidth(storage, -10);
  savePanelWidth(storage, NaN);
  savePanelWidth(storage, "420");
  assert.deepEqual(writes, []);
});

test("savePanelWidth swallows storage exceptions", () => {
  const broken = {
    setItem: () => {
      throw new Error("quota exceeded");
    },
  };
  assert.doesNotThrow(() => savePanelWidth(broken, 420));
});

test("savePanelWidth accepts a nullish storage gracefully", () => {
  assert.doesNotThrow(() => savePanelWidth(null, 420));
  assert.doesNotThrow(() => savePanelWidth(undefined, 420));
});
