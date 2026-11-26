import assert from "node:assert/strict";
import test from "node:test";

import { injectLavishSdk } from "../src/html-transform.js";

test("injects the Lavish SDK before the closing body tag", () => {
  const html = "<!doctype html><html><body><h1>Hi</h1></body></html>";
  const result = injectLavishSdk(html, "abc123");

  assert.match(result, /<script src="\/sdk\.js\?key=abc123"><\/script><\/body>/);
});

test("does not inject Tailwind or DaisyUI design assets so the saved file stays portable", () => {
  const html = '<!doctype html><html><head><title>Hi</title></head><body><h1 class="btn">Hi</h1></body></html>';
  const result = injectLavishSdk(html, "abc123");

  assert.doesNotMatch(result, /\/design\/daisyui\.css/);
  assert.doesNotMatch(result, /\/design\/daisyui-themes\.css/);
  assert.doesNotMatch(result, /\/design\/tailwindcss-browser\.js/);
  assert.doesNotMatch(result, /data-lavish-design/);
});

test("leaves the <head> untouched - only the SDK script is appended at end of body", () => {
  const html = "<!doctype html><html><head><title>Hi</title></head><body><h1>Hi</h1></body></html>";
  const result = injectLavishSdk(html, "abc123");

  assert.equal(
    result,
    '<!doctype html><html><head><title>Hi</title></head><body><h1>Hi</h1><script src="/sdk.js?key=abc123"></script></body></html>',
  );
});

test("appends the Lavish SDK when the artifact has no body tag", () => {
  const result = injectLavishSdk("<h1>Hi</h1>", "abc123");

  assert.equal(result, '<h1>Hi</h1>\n<script src="/sdk.js?key=abc123"></script>');
});

test("carries the per-load token into the SDK request", () => {
  const result = injectLavishSdk("<body></body>", "abc123", 7, "load token/7");

  assert.match(result, /sdk\.js\?key=abc123&artifact_revision=7&artifact_load_token=load%20token%2F7/);
});

test("ignores a literal '</body>' inside an inline script and injects before the real closing tag", () => {
  const html =
    "<!doctype html><html><body>\n<p>content</p>\n<script>\n  const end = html.toLowerCase().lastIndexOf('</body>');\n  frame.srcdoc = end < 0 ? html : html.slice(0, end);\n</script>\n</body></html>";
  const result = injectLavishSdk(html, "abc123");

  assert.equal(
    result,
    "<!doctype html><html><body>\n<p>content</p>\n<script>\n  const end = html.toLowerCase().lastIndexOf('</body>');\n  frame.srcdoc = end < 0 ? html : html.slice(0, end);\n</script>\n" +
      '<script src="/sdk.js?key=abc123"></script></body></html>',
  );
});

test("ignores a case-variant '</BODY>' inside an inline script", () => {
  const html = "<body><script>const s = '</BODY>';</script></body>";
  const result = injectLavishSdk(html, "abc123");

  assert.equal(
    result,
    "<body><script>const s = '</BODY>';</script><script src=\"/sdk.js?key=abc123\"></script></body>",
  );
});

test("ignores a literal '</body>' inside style and textarea raw-text elements", () => {
  const html =
    "<html><head><style>a::after{content:'</body>'}</style></head><body><textarea>example: </body></textarea><p>hi</p></body></html>";
  const result = injectLavishSdk(html, "abc123");

  assert.equal(
    result,
    "<html><head><style>a::after{content:'</body>'}</style></head><body><textarea>example: </body></textarea><p>hi</p>" +
      '<script src="/sdk.js?key=abc123"></script></body></html>',
  );
});

test("falls back to appending when the only '</body>' sits inside an unclosed script", () => {
  const html = "<body><p>hi</p><script>const s = '</body>';";
  const result = injectLavishSdk(html, "abc123");

  assert.equal(result, "<body><p>hi</p><script>const s = '</body>';\n" + '<script src="/sdk.js?key=abc123"></script>');
});

test("injects before the real closing tag when a later HTML comment mentions '</body>'", () => {
  const html = "<html><body>hello</body></html><!-- example: </body> -->";
  const result = injectLavishSdk(html, "abc123");

  assert.equal(
    result,
    '<html><body>hello<script src="/sdk.js?key=abc123"></script></body></html><!-- example: </body> -->',
  );
});

test("ignores a '</body>' inside a tag attribute value", () => {
  const html = '<body><div data-t="</body>">x</div></body>';
  const result = injectLavishSdk(html, "abc123");

  assert.equal(result, '<body><div data-t="</body>">x</div><script src="/sdk.js?key=abc123"></script></body>');
});

test("appends when the only '</body>' sits inside a quoted attribute value", () => {
  const html = '<body><div title="> </body>">hello</div>';
  const result = injectLavishSdk(html, "abc123");

  assert.equal(result, '<body><div title="> </body>">hello</div>\n' + '<script src="/sdk.js?key=abc123"></script>');
});

test("ignores a '</body>' inside inert template content after the real closing tag", () => {
  const html = "<body>hello</body><template></body></template>";
  const result = injectLavishSdk(html, "abc123");

  assert.equal(result, '<body>hello<script src="/sdk.js?key=abc123"></script></body><template></body></template>');
});

test("ignores a '</body>' inside template content before the real closing tag", () => {
  const html = "<body><template></body></template>hi</body>";
  const result = injectLavishSdk(html, "abc123");

  assert.equal(result, '<body><template></body></template>hi<script src="/sdk.js?key=abc123"></script></body>');
});

// Accepted edge: an implicit <body> carries no source location even when
// "</body>" is explicit, so the SDK is appended. After the closing tag it
// still loads and runs; only a trailing unclosed raw-text element would
// swallow it, and the old first-match regex broke on far more common inputs.
test("appends after an explicit closing tag when the body element is implicit", () => {
  const html = "<!doctype html><p>hello</p></body>";
  const result = injectLavishSdk(html, "abc123");

  assert.equal(result, "<!doctype html><p>hello</p></body>\n" + '<script src="/sdk.js?key=abc123"></script>');
});
