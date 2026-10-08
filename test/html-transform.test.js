import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "parse5";

import { injectLavishSdk, injectSessionLinkNavigation } from "../src/html-transform.js";

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

test("injects sibling-document navigation support once before the closing body tag", () => {
  const html = "<!doctype html><html><body><h1>Sibling</h1></body></html>";
  const transformed = injectSessionLinkNavigation(html);

  assert.equal(
    transformed,
    '<!doctype html><html><body><h1>Sibling</h1><script src="/session-link-navigation.js"></script></body></html>',
  );
  assert.equal(injectSessionLinkNavigation(transformed), transformed);
});

for (const content of [
  "<!-- </body> -->",
  '<script>const closingTag = "</body>";</script>',
  "<textarea></body></textarea>",
  '<!-- <script src="/session-link-navigation.js"></script> -->',
  "<script>const markup = '<script src=\"/session-link-navigation.js\">';</script>",
  '<template><script src="/session-link-navigation.js"></script></template>',
  '<script type="application/json" src="/session-link-navigation.js"></script>',
  '<script data-src="/session-link-navigation.js"></script>',
]) {
  test(`sibling navigation ignores inert markup: ${content}`, () => {
    const prefix = `<!doctype html><html><body>${content}<p>Sibling</p>`;
    const suffix = "</BODY ></html>";
    const script = '<script src="/session-link-navigation.js"></script>';
    const transformed = injectSessionLinkNavigation(prefix + suffix);
    assert.equal(transformed, prefix + script + suffix);
    const document = parse(transformed);
    const html = document.childNodes.find((node) => node.nodeName === "html");
    assert.ok(html && "childNodes" in html);
    const body = html.childNodes.find((node) => node.nodeName === "body");
    assert.ok(body && "childNodes" in body);
    const injected = body.childNodes.at(-1);
    assert.ok(injected && "tagName" in injected);
    assert.equal(injected.tagName, "script");
    assert.deepEqual(injected.attrs, [{ name: "src", value: "/session-link-navigation.js" }]);
    assert.equal(injectSessionLinkNavigation(transformed), transformed);
  });
}

for (const script of [
  "<SCRIPT SRC=/session-link-navigation.js></SCRIPT>",
  '<script type="text/javascript" src="&#47;session-link-navigation.js"></script>',
  '<script type="module" src="/session-link-navigation.js"></script>',
]) {
  test(`sibling navigation recognizes existing executable markup: ${script}`, () => {
    const html = `<body>${script}</body>`;
    assert.equal(injectSessionLinkNavigation(html), html);
  });
}
