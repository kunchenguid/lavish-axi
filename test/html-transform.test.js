import assert from "node:assert/strict";
import test from "node:test";

import { injectLavishSdk } from "../src/html-transform.js";

test("injects the Lavish SDK before the closing body tag", () => {
  const html = "<!doctype html><html><body><h1>Hi</h1></body></html>";
  const result = injectLavishSdk(html, "abc123");

  assert.match(result, /<script src="\/sdk\.js\?key=abc123"><\/script><\/body>/);
});

test("injects DaisyUI and Tailwind design assets into the head", () => {
  const html = '<!doctype html><html><head><title>Hi</title></head><body><h1 class="btn">Hi</h1></body></html>';
  const result = injectLavishSdk(html, "abc123");

  assert.match(result, /<head><link rel="stylesheet" href="\/design\/daisyui\.css" data-lavish-design>/);
  assert.match(result, /<script src="\/design\/tailwindcss-browser\.js" data-lavish-design><\/script>/);
  assert.match(result, /<link rel="stylesheet" href="\/design\/daisyui-themes\.css" data-lavish-design>/);
  assert.match(result, /data-lavish-design>[\s\S]*<title>Hi<\/title>/);
});

test("does not inject DaisyUI design assets when artifact opts out", () => {
  const html = '<!doctype html><html><head><meta name="lavish-design" content="off"></head><body></body></html>';
  const result = injectLavishSdk(html, "abc123");

  assert.doesNotMatch(result, /\/design\/daisyui\.css/);
  assert.match(result, /<script src="\/sdk\.js\?key=abc123"><\/script><\/body>/);
});

test("does not inject DaisyUI design assets when opt-out meta attributes are reversed", () => {
  const html = '<!doctype html><html><head><meta content="off" name="lavish-design"></head><body></body></html>';
  const result = injectLavishSdk(html, "abc123");

  assert.doesNotMatch(result, /\/design\/daisyui\.css/);
  assert.match(result, /<script src="\/sdk\.js\?key=abc123"><\/script><\/body>/);
});

test("does not duplicate DaisyUI design assets when already present", () => {
  const html =
    '<!doctype html><html><head><link rel="stylesheet" href="/custom.css" data-lavish-design></head><body></body></html>';
  const result = injectLavishSdk(html, "abc123");

  assert.equal((result.match(/data-lavish-design/g) || []).length, 1);
  assert.doesNotMatch(result, /\/design\/daisyui\.css/);
});

test("appends the Lavish SDK when the artifact has no body tag", () => {
  const result = injectLavishSdk("<h1>Hi</h1>", "abc123");

  assert.match(result, /<h1>Hi<\/h1>\n<link rel="stylesheet" href="\/design\/daisyui\.css" data-lavish-design>/);
  assert.match(result, /<script src="\/sdk\.js\?key=abc123"><\/script>$/);
});
