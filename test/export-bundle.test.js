import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildSelfContainedHtml, exportFileName } from "../src/export-bundle.js";

function localReader(files) {
  return async (absPath) => {
    if (!(absPath in files)) {
      const error = new Error(`ENOENT: ${absPath}`);
      // @ts-expect-error attach a node-style code for parity with fs errors
      error.code = "ENOENT";
      throw error;
    }
    const value = files[absPath];
    return typeof value === "string" ? Buffer.from(value) : value;
  };
}

test("inlines a local stylesheet link as a <style> block", async () => {
  const html =
    '<!doctype html><html><head><link rel="stylesheet" href="theme.css"></head><body><p>Hi</p></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/theme.css": "body{color:red}" }),
  });

  assert.match(out, /<style>body\{color:red\}<\/style>/);
  assert.doesNotMatch(out, /<link\b/);
  assert.equal(warnings.length, 0);
});

test("leaves inactive stylesheet links external with warnings", async () => {
  const html =
    '<!doctype html><html><head><link rel="stylesheet" disabled href="disabled.css">' +
    '<link rel="alternate stylesheet" href="alternate.css"><link rel="stylesheet" href="active.css"></head></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({
      "/art/disabled.css": ".disabled{color:red}",
      "/art/alternate.css": ".alternate{color:blue}",
      "/art/active.css": ".active{color:green}",
    }),
  });

  assert.match(out, /<link rel="stylesheet" disabled href="disabled\.css">/);
  assert.match(out, /<link rel="alternate stylesheet" href="alternate\.css">/);
  assert.match(out, /<style>\.active\{color:green\}<\/style>/);
  assert.doesNotMatch(out, /\.disabled\{color:red\}/);
  assert.doesNotMatch(out, /\.alternate\{color:blue\}/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "inactive-stylesheet", ref: "disabled.css" },
      { kind: "inactive-stylesheet", ref: "alternate.css" },
    ],
  );
});

test("inlines a local script src as an inline script and escapes closing tags", async () => {
  const html = '<!doctype html><html><body><script src="app.js"></script></body></html>';
  const { html: out } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/app.js": "const a = '</script>';" }),
  });

  assert.match(out, /<script>const a = '<\\\/script>';<\/script>/);
  assert.doesNotMatch(out, /src=/);
});

test("leaves deferred local scripts as references with a warning", async () => {
  const html = '<!doctype html><html><head><script defer src="app.js"></script></head><body></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/app.js": "document.body.dataset.ready = 'true';" }),
  });

  assert.match(out, /<script defer src="app\.js"><\/script>/);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, "unsupported-script-timing");
  assert.equal(warnings[0].ref, "app.js");
});

test("leaves local module scripts as references with a warning", async () => {
  const html = '<!doctype html><html><head><script type="module" src="js/main.js"></script></head></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/js/main.js": 'import "./dep.js";\nwindow.ready = true;' }),
  });

  assert.match(out, /<script type="module" src="js\/main\.js"><\/script>/);
  assert.doesNotMatch(out, /window\.ready/);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, "module-external");
  assert.equal(warnings[0].ref, "js/main.js");
});

test("leaves non-classic script src references unchanged with a warning", async () => {
  const html =
    '<!doctype html><html><head><script type="application/json" src="data.json"></script>' +
    '<script type="importmap" src="map.json"></script><script type="text/javascript" src="app.js"></script></head></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({
      "/art/data.json": '{"secret":true}',
      "/art/map.json": '{"imports":{}}',
      "/art/app.js": "window.ready = true;",
    }),
  });

  assert.match(out, /<script type="application\/json" src="data\.json"><\/script>/);
  assert.match(out, /<script type="importmap" src="map\.json"><\/script>/);
  assert.match(out, /<script type="text\/javascript">window\.ready = true;<\/script>/);
  assert.doesNotMatch(out, /"secret":true|"imports"/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "unsupported-script-type", ref: "data.json" },
      { kind: "unsupported-script-type", ref: "map.json" },
    ],
  );
});

test("warns when inline module scripts reference local imports", async () => {
  const html =
    '<!doctype html><html><head><script type="module">' +
    'import "./dep.js";\nimport value from "../shared.js";\nconst lazy = () => import("./lazy.js");\n' +
    'import { import as imported } from "./keywords.js";\nconst regex = /import from ".\\/regex.js"/;\n' +
    'import remote from "https://cdn.example/remote.js";\nimport pkg from "pkg";\n' +
    'const text = "import \\"./string.js\\"";\n// import "./comment.js"\n' +
    "</script></head></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art/components",
    readLocalFile: localReader({}),
  });

  assert.match(out, /<script type="module">/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "inline-module-import", ref: "./dep.js" },
      { kind: "inline-module-import", ref: "../shared.js" },
      { kind: "inline-module-import", ref: "./lazy.js" },
      { kind: "inline-module-import", ref: "./keywords.js" },
    ],
  );
});

test("warns when inline module scripts reference local re-exports", async () => {
  const html =
    '<!doctype html><html><head><script type="module">' +
    'export * from "./dep.js";\nexport { value } from "../shared.js";\n' +
    'export { remote } from "https://cdn.example/remote.js";\nexport { pkg } from "pkg";\n' +
    "</script></head></html>";
  const { warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art/components",
    readLocalFile: localReader({}),
  });

  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "inline-module-import", ref: "./dep.js" },
      { kind: "inline-module-import", ref: "../shared.js" },
    ],
  );
});

test("warns when inline module scripts reference local template dynamic imports", async () => {
  const html =
    '<!doctype html><html><head><script type="module">' +
    "const staticLocal = () => import(`./templated.js`);\n" +
    "const interpolatedLocal = (name) => import(`../${name}.js`);\n" +
    "const remote = () => import(`https://cdn.example/remote.js`);\n" +
    "const pkg = () => import(`pkg`);\n" +
    "</script></head></html>";
  const { warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art/components",
    readLocalFile: localReader({}),
  });

  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "inline-module-import", ref: "./templated.js" },
      { kind: "inline-module-import", ref: "../${name}.js" },
    ],
  );
});

test("escapes a closing style tag when inlining external CSS into a <style> block", async () => {
  const html = '<!doctype html><html><head><link rel="stylesheet" href="x.css"></head><body></body></html>';
  const { html: out } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/x.css": '.a{content:"</style>"}' }),
  });

  assert.match(out, /content:"<\\\/style>"/);
  assert.doesNotMatch(out, /content:"<\/style>"/);
});

test("inlines local images referenced by src into data URIs", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const html = '<!doctype html><html><body><img src="pic.png" alt="x"></body></html>';
  const { html: out } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/pic.png": png }),
  });

  assert.match(out, /<img src="data:image\/png;base64,iVBORw==" alt="x">/);
});

test("handles quoted greater-than characters in asset tags", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const html =
    '<!doctype html><html><head><link title="A > B" rel="stylesheet" href="theme.css">' +
    '<style data-note="A > B">.hero{background:url(bg.png)}</style>' +
    '<script data-note="A > B" src="app.js"></script></head><body>' +
    '<img alt="A > B" src="pic.png"><svg><use data-note="A > B" href="icons.svg#check"/></svg>' +
    "</body></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({
      "/art/theme.css": "body{color:red}",
      "/art/bg.png": png,
      "/art/app.js": "window.ready = true;",
      "/art/pic.png": png,
      "/art/icons.svg": '<svg><symbol id="check"></symbol></svg>',
    }),
  });

  assert.match(out, /<style>body\{color:red\}<\/style>/);
  assert.match(out, /<style data-note="A > B">\.hero\{background:url\(data:image\/png;base64,iVBORw==\)\}<\/style>/);
  assert.match(out, /<script data-note="A > B">window\.ready = true;<\/script>/);
  assert.match(out, /<img alt="A > B" src="data:image\/png;base64,iVBORw==">/);
  assert.match(out, /<use data-note="A > B" href="data:image\/svg\+xml;base64,[^"]+#check" \/>/);
  assert.equal(warnings.length, 0);
});

test("parses srcset without splitting data URI candidates", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const html =
    '<!doctype html><html><body><img srcset="data:image/png;base64,AAAA 1x, pic.png 2x, https://cdn.example/pic.png?a=1&amp;b=2 3x"></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/pic.png": png }),
  });

  assert.match(
    out,
    /srcset="data:image\/png;base64,AAAA 1x, data:image\/png;base64,iVBORw== 2x, https:\/\/cdn\.example\/pic\.png\?a=1&amp;b=2 3x"/,
  );
  assert.doesNotMatch(out, /base64, AAAA/);
  assert.doesNotMatch(out, /&amp;amp;/);
  assert.equal(warnings.length, 0);
});

test("parses srcset candidates without descriptors", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const html = '<!doctype html><html><body><img srcset="small.png, large.png 2x"></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/small.png": png, "/art/large.png": png }),
  });

  assert.match(out, /srcset="data:image\/png;base64,iVBORw==, data:image\/png;base64,iVBORw== 2x"/);
  assert.doesNotMatch(out, /small\.png|large\.png/);
  assert.equal(warnings.length, 0);
});

test("leaves unchanged srcset values byte-for-byte when no candidate is inlined", async () => {
  const html =
    '<!doctype html><html><body><img srcset="https://cdn.example/pic.png?a=1&amp;b=2 1x, data:image/png;base64,AAAA 2x"></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({}),
  });

  assert.equal(out, html);
  assert.equal(warnings.length, 0);
});

test("inlines local track captions and warns on missing track assets", async () => {
  const html =
    '<!doctype html><html><body><video controls><track kind="captions" src="captions.vtt">' +
    '<track kind="subtitles" src="missing.vtt"></video></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/captions.vtt": "WEBVTT\n" }),
  });

  assert.match(out, /<track kind="captions" src="data:text\/vtt;base64,V0VCVlRUCg==">/);
  assert.match(out, /<track kind="subtitles" src="missing\.vtt">/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "load-failed", ref: "missing.vtt" }],
  );
});

test("preserves self-closing syntax when rewriting asset tags", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const html =
    '<!doctype html><html><body><picture><source src="pic.png" /></picture>' +
    '<img src="pic.png"/><video><track src="captions.vtt" /></video></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/pic.png": png, "/art/captions.vtt": "WEBVTT\n" }),
  });

  assert.match(out, /<source src="data:image\/png;base64,iVBORw==" \/>/);
  assert.match(out, /<img src="data:image\/png;base64,iVBORw==" \/>/);
  assert.match(out, /<track src="data:text\/vtt;base64,V0VCVlRUCg==" \/>/);
  assert.doesNotMatch(out, /\/>>/);
  assert.equal(warnings.length, 0);
});

test("does not treat hyphenated custom elements as native asset tags", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const html =
    '<!doctype html><html><body><source-code src="example.js"></source-code>' +
    '<video-player src="clip.mp4"></video-player><image-card href="icon.svg"></image-card>' +
    '<img src="pic.png" alt="real"></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/pic.png": png }),
  });

  assert.match(out, /<source-code src="example\.js"><\/source-code>/);
  assert.match(out, /<video-player src="clip\.mp4"><\/video-player>/);
  assert.match(out, /<image-card href="icon\.svg"><\/image-card>/);
  assert.match(out, /<img src="data:image\/png;base64,iVBORw==" alt="real">/);
  assert.equal(warnings.length, 0);
});

test("does not treat hyphenated custom link elements as stylesheet links", async () => {
  const html =
    '<!doctype html><html><head><link-preview rel="stylesheet" href="preview.css"></link-preview>' +
    '<link rel="stylesheet" href="theme.css"></head></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/theme.css": "body{color:red}" }),
  });

  assert.match(out, /<link-preview rel="stylesheet" href="preview\.css"><\/link-preview>/);
  assert.match(out, /<style>body\{color:red\}<\/style>/);
  assert.equal(warnings.length, 0);
});

test("does not rewrite markup-like text inside scripts, styles, or comments", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const html =
    "<!doctype html><html><head><style>.before{content:\"<img src='pic.png'>\"}</style></head><body>" +
    "<script>const template = \"<img src='pic.png'>\";</script>" +
    '<!-- <img src="pic.png"> -->' +
    '<img src="pic.png" alt="x">' +
    "</body></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/pic.png": png }),
  });

  assert.match(out, /\.before\{content:"<img src='pic\.png'>"\}/);
  assert.match(out, /const template = "<img src='pic\.png'>";/);
  assert.match(out, /<!-- <img src="pic\.png"> -->/);
  assert.match(out, /<img src="data:image\/png;base64,iVBORw==" alt="x">/);
  assert.equal(warnings.length, 0);
});

test("does not rewrite markup-like text inside textarea or title", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const html =
    '<!doctype html><html><head><title><img src="missing-title.png"></title></head><body>' +
    '<textarea><img src="missing-textarea.png"></textarea><img src="pic.png" alt="real">' +
    "</body></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/pic.png": png }),
  });

  assert.match(out, /<title><img src="missing-title\.png"><\/title>/);
  assert.match(out, /<textarea><img src="missing-textarea\.png"><\/textarea>/);
  assert.match(out, /<img src="data:image\/png;base64,iVBORw==" alt="real">/);
  assert.equal(warnings.length, 0);
});

test("does not rewrite markup-like text inside inlined stylesheet links", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const html =
    '<!doctype html><html><head><link rel="stylesheet" href="theme.css"></head><body>' +
    '<img src="pic.png" alt="real">' +
    "</body></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({
      "/art/theme.css": '.badge{content:"<img src=\'pic.png\'>"}/* <img src="missing.png"> */',
      "/art/pic.png": png,
    }),
  });

  assert.match(out, /<style>\.badge\{content:"<img src='pic\.png'>"\}\/\* <img src="missing\.png"> \*\/<\/style>/);
  assert.match(out, /<img src="data:image\/png;base64,iVBORw==" alt="real">/);
  assert.equal(warnings.length, 0);
});

test("decodes percent-encoded local asset paths before resolving them", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const html = '<!doctype html><html><body><img src="my%20image.png?v=1#crop"></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/my image.png": png }),
  });

  assert.match(out, /<img src="data:image\/png;base64,iVBORw==">/);
  assert.equal(warnings.length, 0);
});

test("decodes HTML entities in local asset refs before resolving them", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const html =
    '<!doctype html><html><body><img src="logo&amp;dark.png">' +
    '<img src="numeric&#38;dark.png"><img src="hex&#x26;dark.png">' +
    '<img src="missing&amp;dark.png"></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({
      "/art/logo&dark.png": png,
      "/art/numeric&dark.png": png,
      "/art/hex&dark.png": png,
    }),
  });

  assert.match(out, /<img src="data:image\/png;base64,iVBORw==">/);
  assert.doesNotMatch(out, /numeric&#38;dark\.png|hex&#x26;dark\.png/);
  assert.match(out, /<img src="missing&amp;dark\.png">/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "load-failed", ref: "missing&amp;dark.png" }],
  );
});

test("resolves HTML asset references against the first document base href", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const html =
    '<!doctype html><html><head><template><base href="wrong/"></template><base href="assets/">' +
    '<link rel="stylesheet" href="css/app.css"><link rel="icon" href="icon.svg">' +
    '<style>.inline{background:url(style.png)}</style><script src="app.js"></script></head><body>' +
    '<img src="pic.png"><div style="background:url(inline.png)"></div></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({
      "/art/assets/css/app.css": ".hero{background:url(bg.png)}",
      "/art/assets/css/bg.png": png,
      "/art/assets/icon.svg": "<svg/>",
      "/art/assets/style.png": png,
      "/art/assets/app.js": "window.ready = true;",
      "/art/assets/pic.png": png,
      "/art/assets/inline.png": png,
    }),
  });

  assert.match(out, /<base href="assets\/">/);
  assert.match(out, /url\(data:image\/png;base64,iVBORw==\)/);
  assert.match(out, /<link rel="icon" href="data:image\/svg\+xml;base64,/);
  assert.match(out, /<script>window\.ready = true;<\/script>/);
  assert.match(out, /<img src="data:image\/png;base64,iVBORw==">/);
  assert.match(out, /style="background:url\(data:image\/png;base64,iVBORw==\)"/);
  assert.equal(warnings.length, 0);
});

test("leaves HTML asset references unchanged when the document base href is remote", async () => {
  const html =
    '<!doctype html><html><head><base href="https://cdn.example/assets/">' +
    '<link rel="stylesheet" href="app.css"><style>.x{background:url(bg.png)}</style>' +
    '<script src="app.js"></script></head><body><img src="pic.png">' +
    '<div style="background:url(inline.png)"></div></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({
      "/art/app.css": "body{color:red}",
      "/art/bg.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      "/art/app.js": "window.ready = true;",
      "/art/pic.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      "/art/inline.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    }),
  });

  assert.match(out, /<link rel="stylesheet" href="app\.css">/);
  assert.match(out, /background:url\(bg\.png\)/);
  assert.match(out, /<script src="app\.js"><\/script>/);
  assert.match(out, /<img src="pic\.png">/);
  assert.match(out, /style="background:url\(inline\.png\)"/);
  assert.equal(warnings.length, 0);
});

test("rewrites url() and @import inside local CSS, resolving relative to the stylesheet", async () => {
  const woff = Buffer.from([0x77, 0x4f, 0x46, 0x32]);
  const html = '<!doctype html><html><head><link rel="stylesheet" href="css/app.css"></head><body></body></html>';
  const files = {
    "/art/css/app.css": '@import "tokens.css";\n.logo{background:url(../img/logo.svg)}',
    "/art/css/tokens.css": "@font-face{font-family:F;src:url(./f.woff2) format('woff2')}",
    "/art/css/f.woff2": woff,
    "/art/img/logo.svg": "<svg/>",
  };
  const { html: out } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader(files),
  });

  assert.match(out, /url\(data:font\/woff2;base64,/);
  assert.match(out, /url\(data:image\/svg\+xml;base64,/);
  assert.doesNotMatch(out, /@import/);
});

test("records a warning when CSS import recursion reaches the max depth", async () => {
  const html = '<!doctype html><html><head><link rel="stylesheet" href="css/app.css"></head></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    maxDepth: 0,
    readLocalFile: localReader({
      "/art/css/app.css": '@import "theme.css";.app{color:red}',
      "/art/css/theme.css": ".theme{color:blue}",
    }),
  });

  assert.match(out, /@import "css\/theme\.css";/);
  assert.doesNotMatch(out, /\.theme\{color:blue\}/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "css-import-depth", ref: "theme.css" }],
  );
});

test("inlines media-query CSS imports with parenthesized features", async () => {
  const html =
    '<!doctype html><html><head><style>@import "mobile.css" screen and (max-width: 600px);</style></head></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/mobile.css": ".mobile{color:red}" }),
  });

  assert.match(out, /@media screen and \(max-width: 600px\)\{\.mobile\{color:red\}\}/);
  assert.doesNotMatch(out, /@import/);
  assert.equal(warnings.length, 0);
});

test("inlines not media-condition CSS imports with parenthesized features", async () => {
  const html = '<!doctype html><html><head><style>@import "narrow.css" not (hover);</style></head></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/narrow.css": ".narrow{color:red}" }),
  });

  assert.match(out, /@media not \(hover\)\{\.narrow\{color:red\}\}/);
  assert.doesNotMatch(out, /@import/);
  assert.equal(warnings.length, 0);
});

test("removes empty CSS imports that were successfully inlined", async () => {
  const html = '<!doctype html><html><head><style>@import "empty.css";.app{color:red}</style></head></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/empty.css": "" }),
  });

  assert.doesNotMatch(out, /@import/);
  assert.match(out, /\.app\{color:red\}/);
  assert.equal(warnings.length, 0);
});

test("only inlines CSS imports from the valid top-level import prelude", async () => {
  const readPaths = [];
  const html =
    '<!doctype html><html><head><style>@charset "utf-8";@layer reset;@import "tokens.css";' +
    '.app{color:red}@import "late.css";@media screen{@import "nested.css";}</style></head></html>';
  const files = {
    "/art/tokens.css": ".tokens{color:blue}",
    "/art/late.css": ".late{color:purple}",
    "/art/nested.css": ".nested{color:green}",
  };
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(absPath);
      return Buffer.from(files[absPath]);
    },
  });

  assert.deepEqual(readPaths, ["/art/tokens.css"]);
  assert.match(out, /@charset "utf-8";@layer reset;\.tokens\{color:blue\}\.app\{color:red\}/);
  assert.match(out, /@import "late\.css";/);
  assert.match(out, /@media screen\{@import "nested\.css";\}/);
  assert.doesNotMatch(out, /\.late\{color:purple\}/);
  assert.doesNotMatch(out, /\.nested\{color:green\}/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "late-css-import", ref: "late.css" },
      { kind: "late-css-import", ref: "nested.css" },
    ],
  );
});

test("preserves inlined CSS import order before later layer statements", async () => {
  const html =
    '<!doctype html><html><head><style>@import "a.css";@layer reset;@import "b.css";' +
    ".app{color:red}</style></head></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({
      "/art/a.css": ".a{color:blue}",
      "/art/b.css": ".b{color:green}",
    }),
  });

  assert.match(out, /\.a\{color:blue\}@layer reset;\.b\{color:green\}\.app\{color:red\}/);
  assert.equal(warnings.length, 0);
});

test("keeps earlier CSS imports external when a later remote import remains", async () => {
  const html =
    '<!doctype html><html><head><style>@import "a.css";@layer reset;' +
    '@import "https://cdn.example/x.css";.app{color:red}</style></head></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/a.css": ".a{color:blue}" }),
  });

  assert.match(out, /@import "a\.css";@layer reset;@import "https:\/\/cdn\.example\/x\.css";\.app\{color:red\}/);
  assert.doesNotMatch(out, /\.a\{color:blue\}/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "css-import-order", ref: "a.css" }],
  );
});

test("keeps CSS imports external before namespace declarations", async () => {
  const html =
    '<!doctype html><html><head><style>@import "a.css";@namespace svg url(http://www.w3.org/2000/svg);' +
    "svg|a{fill:red}</style></head></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/a.css": ".a{color:blue}" }),
  });

  assert.match(out, /@import "a\.css";@namespace svg url\(http:\/\/www\.w3\.org\/2000\/svg\);svg\|a\{fill:red\}/);
  assert.doesNotMatch(out, /\.a\{color:blue\}/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "css-import-order", ref: "a.css" }],
  );
});

test("leaves namespace url identifiers unchanged", async () => {
  const html =
    "<!doctype html><html><head><style>@namespace icon url(ns.xml);icon|glyph{fill:red}</style></head></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/ns.xml": "namespace" }),
  });

  assert.match(out, /@namespace icon url\(ns\.xml\);icon\|glyph\{fill:red\}/);
  assert.doesNotMatch(out, /data:application\/octet-stream/);
  assert.equal(warnings.length, 0);
});

test("leaves non-media CSS imports unchanged with a warning", async () => {
  const html =
    '<!doctype html><html><head><style>@import "theme.css" layer(theme);' +
    '@import url("supported.css") supports(display: grid);@import "bare.css" layer;' +
    '@import "print.css" print;</style></head></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({
      "/art/theme.css": ".theme{color:red}",
      "/art/supported.css": ".supported{display:grid}",
      "/art/bare.css": ".bare{color:purple}",
      "/art/print.css": ".print{color:black}",
    }),
  });

  assert.match(out, /@import "theme\.css" layer\(theme\);/);
  assert.match(out, /@import url\("supported\.css"\) supports\(display: grid\);/);
  assert.match(out, /@import "bare\.css" layer;/);
  assert.match(out, /@import "print\.css" print;/);
  assert.doesNotMatch(out, /\.theme\{color:red\}/);
  assert.doesNotMatch(out, /\.supported\{display:grid\}/);
  assert.doesNotMatch(out, /\.bare\{color:purple\}/);
  assert.doesNotMatch(out, /\.print\{color:black\}/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "unsupported-css-import", ref: "theme.css" },
      { kind: "unsupported-css-import", ref: "supported.css" },
      { kind: "unsupported-css-import", ref: "bare.css" },
      { kind: "css-import-order", ref: "print.css" },
    ],
  );
});

test("leaves bare layer CSS imports with media unchanged with a warning", async () => {
  const html = '<!doctype html><html><head><style>@import "theme.css" layer screen;</style></head></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/theme.css": ".theme{color:red}" }),
  });

  assert.match(out, /@import "theme\.css" layer screen;/);
  assert.doesNotMatch(out, /@media layer screen/);
  assert.doesNotMatch(out, /\.theme\{color:red\}/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "unsupported-css-import", ref: "theme.css" }],
  );
});

test("does not treat CSS strings or comments as url or import assets", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const html =
    "<!doctype html><html><head>" +
    '<style>.label{content:"url(missing-string.png)"}/* url(missing-comment.png) */' +
    '/* @import "missing-comment.css"; */.icon{background:url(icon.png)}</style>' +
    "</head><body></body></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/icon.png": png }),
  });

  assert.match(out, /content:"url\(missing-string\.png\)"/);
  assert.match(out, /\/\* url\(missing-comment\.png\) \*\//);
  assert.match(out, /\/\* @import "missing-comment\.css"; \*\//);
  assert.match(out, /background:url\(data:image\/png;base64,iVBORw==\)/);
  assert.equal(warnings.length, 0);
});

test("redacts file URLs inside CSS url tokens with comments", async () => {
  const html =
    '<!doctype html><html><head><style>@import url(/*x*/"file:///Users/kun/import.css");' +
    ".x{background:url(/*x*/file:///Users/kun/secret.png/*y*/)}</style></head></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
  });

  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.match(out, /@import url\(\/\*x\*\/"about:blank"\);/);
  assert.match(out, /background:url\(about:blank\)/);
  assert.deepEqual(
    warnings.map((warning) => warning.kind),
    ["outside-root", "outside-root"],
  );
});

test("handles fetchable CSS image-set string operands", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const html =
    '<!doctype html><html><head><style>.hero{content:"file:///Users/kun/text.png";' +
    'background:image-set("local.png" 1x, "file:///Users/kun/secret.png" 2x);' +
    'border-image:-webkit-image-set("local.png" 1x)}</style></head></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
    readLocalFile: localReader({ "/art/local.png": png }),
  });

  assert.match(out, /content:"file:\/\/\/Users\/kun\/text\.png"/);
  assert.match(out, /image-set\("data:image\/png;base64,iVBORw==" 1x, "about:blank" 2x\)/);
  assert.match(out, /-webkit-image-set\("data:image\/png;base64,iVBORw==" 1x\)/);
  assert.doesNotMatch(out, /secret\.png/);
  assert.deepEqual(
    warnings.map((warning) => warning.kind),
    ["outside-root"],
  );
});

test("handles escaped urls and image-set operands inside inline styles", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const html =
    '<!doctype html><html><body><div style="background:u\\72l(file\\3a///Users/kun/secret.png)"></div>' +
    "<div style='background:image-set(\"local.png\" 1x)'></div></body></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
    readLocalFile: localReader({ "/art/local.png": png }),
  });

  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.doesNotMatch(out, /file\\3a/i);
  assert.match(out, /style="background:url\(about:blank\)"/);
  assert.match(out, /style='background:image-set\("data:image\/png;base64,iVBORw==" 1x\)'/);
  assert.deepEqual(
    warnings.map((warning) => warning.kind),
    ["outside-root"],
  );
});

test("only rewrites url references inside real style attributes", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const html =
    '<!doctype html><html><body><div data-style="url(missing-data.png)" x-style="url(missing-x.png)">' +
    'literal style="url(missing-text.png)"</div><div style="background:url(pic.png)"></div></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/pic.png": png }),
  });

  assert.match(out, /data-style="url\(missing-data\.png\)"/);
  assert.match(out, /x-style="url\(missing-x\.png\)"/);
  assert.match(out, /literal style="url\(missing-text\.png\)"/);
  assert.match(out, /style="background:url\(data:image\/png;base64,iVBORw==\)"/);
  assert.equal(warnings.length, 0);
});

test("rewrites url references inside unquoted style attributes", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const html =
    "<!doctype html><html><body><div style=background:url(pic.png)></div>" +
    "<div data-style=background:url(missing-data.png)></div></body></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/pic.png": png }),
  });

  assert.match(out, /style="background:url\(data:image\/png;base64,iVBORw==\)"/);
  assert.match(out, /data-style=background:url\(missing-data\.png\)/);
  assert.equal(warnings.length, 0);
});

test("processes RCDATA start tag attributes while leaving text content inert", async () => {
  const html =
    '<!doctype html><html><head><title style="background:url(file:///Users/kun/title.png)">' +
    '<img src="missing-title.png"></title></head><body>' +
    '<textarea style="background:url(file:///Users/kun/textarea.png)"><img src="missing-textarea.png"></textarea>' +
    "</body></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
  });

  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.match(out, /<title style="background:url\(about:blank\)"><img src="missing-title\.png"><\/title>/);
  assert.match(out, /<textarea style="background:url\(about:blank\)"><img src="missing-textarea\.png"><\/textarea>/);
  assert.deepEqual(
    warnings.map((warning) => warning.kind),
    ["outside-root", "outside-root"],
  );
});

test("keeps earlier CSS imports external when a later local import cannot inline", async () => {
  const html = '<!doctype html><html><head><link rel="stylesheet" href="css/app.css"></head><body></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({
      "/art/css/app.css": '@import "tokens.css";@import "missing.css";.app{color:red}',
      "/art/css/tokens.css": ".tokens{color:blue}",
    }),
  });

  assert.match(out, /@import "css\/tokens\.css";@import "css\/missing\.css";\.app\{color:red\}/);
  assert.doesNotMatch(out, /\.tokens\{color:blue\}/);
  assert.deepEqual(warnings.map((warning) => `${warning.kind}:${warning.ref}`).sort(), [
    "css-import-order:tokens.css",
    "load-failed:missing.css",
  ]);
});

test("keeps parent CSS imports external when nested imports cannot inline", async () => {
  const html =
    '<!doctype html><html><head><style>@import "a.css";@import "b.css" screen;' +
    ".app{color:red}</style></head></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({
      "/art/a.css": ".a{color:blue}",
      "/art/b.css": '@import "missing.css";.b{color:green}',
    }),
  });

  assert.match(out, /@import "a\.css";@import "b\.css" screen;\.app\{color:red\}/);
  assert.doesNotMatch(out, /\.a\{color:blue\}/);
  assert.doesNotMatch(out, /\.b\{color:green\}/);
  assert.doesNotMatch(out, /@media screen\{@import/);
  assert.deepEqual(warnings.map((warning) => `${warning.kind}:${warning.ref}`).sort(), [
    "css-import-order:a.css",
    "css-import-order:b.css",
    "load-failed:missing.css",
  ]);
});

test("stops reading consecutive CSS imports once the bundle cap is exhausted", async () => {
  const files = {
    "/art/a.css": "a".repeat(10),
    "/art/b.css": "b".repeat(10),
    "/art/c.css": "c".repeat(10),
  };
  const readPaths = [];
  const html =
    '<!doctype html><html><head><style>@import "a.css";@import "b.css";' +
    '@import "c.css";.app{color:red}</style></head></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    maxBundleBytes: 15,
    readLocalFile: async (absPath, options = {}) => {
      readPaths.push(absPath);
      const value = Buffer.from(files[absPath]);
      if (value.length > options.maxBundleRemaining) {
        const error = new Error(`would exceed per-bundle cap ${options.maxBundleBytes}`);
        // @ts-expect-error attach a node-style code for parity with fs errors
        error.code = "TOO_LARGE";
        throw error;
      }
      return value;
    },
  });

  assert.deepEqual(readPaths, ["/art/a.css", "/art/b.css"]);
  assert.match(out, /@import "a\.css";@import "b\.css";@import "c\.css";\.app\{color:red\}/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "too-large", ref: "b.css" },
      { kind: "css-import-order", ref: "a.css" },
      { kind: "css-import-order", ref: "c.css" },
    ],
  );
});

test("rebases unresolved local refs from linked CSS to the HTML base", async () => {
  const big = Buffer.alloc(2048, 1);
  const html = '<!doctype html><html><head><link rel="stylesheet" href="css/app.css"></head><body></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    maxAssetBytes: 1024,
    readLocalFile: localReader({
      "/art/css/app.css":
        '@import "theme.css" layer(theme);@import "missing.css";' +
        ".hero{background:url(bg.png)}.missing{background:url(missing.png)}" +
        ".remote{background:url(https://cdn.example/bg.png)}.frag{filter:url(#mask)}",
      "/art/css/theme.css": ".theme{color:green}",
      "/art/css/bg.png": big,
    }),
  });

  assert.match(out, /@import "css\/theme\.css" layer\(theme\);/);
  assert.match(out, /@import "css\/missing\.css";/);
  assert.match(out, /background:url\(css\/bg\.png\)/);
  assert.match(out, /background:url\(css\/missing\.png\)/);
  assert.match(out, /background:url\(https:\/\/cdn\.example\/bg\.png\)/);
  assert.match(out, /filter:url\(#mask\)/);
  assert.doesNotMatch(out, /file:\/\//);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "unsupported-css-import", ref: "theme.css" },
      { kind: "css-import-order", ref: "missing.css" },
      { kind: "too-large", ref: "bg.png" },
      { kind: "load-failed", ref: "missing.png" },
    ],
  );
});

test("leaves remote http(s) and protocol-relative references intact without fetching them", async () => {
  const html =
    "<!doctype html><html><head>" +
    '<link rel="stylesheet" href="https://cdn.example/app.css">' +
    '<link rel="stylesheet" href="//cdn.example/proto.css">' +
    '<style>@import "https://cdn.example/import.css";.x{background:url(https://cdn.example/bg.png)}</style>' +
    "</head><body>" +
    '<script src="https://cdn.example/app.js"></script>' +
    '<img src="https://cdn.example/pic.png">' +
    "</body></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({}),
  });

  assert.match(out, /<link rel="stylesheet" href="https:\/\/cdn\.example\/app\.css">/);
  assert.match(out, /<link rel="stylesheet" href="\/\/cdn\.example\/proto\.css">/);
  assert.match(out, /@import "https:\/\/cdn\.example\/import\.css";/);
  assert.match(out, /url\(https:\/\/cdn\.example\/bg\.png\)/);
  assert.match(out, /<script src="https:\/\/cdn\.example\/app\.js"><\/script>/);
  assert.match(out, /<img src="https:\/\/cdn\.example\/pic\.png">/);
  assert.equal(warnings.length, 0);
});

test("records a warning and leaves the reference when a local resource cannot be loaded", async () => {
  const html = '<!doctype html><html><body><img src="missing.png"></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({}),
  });

  assert.match(out, /<img src="missing\.png">/);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, "load-failed");
});

test("strips the injected Lavish SDK script so exports do not phone home to the server", async () => {
  const html = '<!doctype html><html><body><h1>Hi</h1><script src="/sdk.js?key=abc"></script></body></html>';
  const { html: out } = await buildSelfContainedHtml(html, { baseDir: "/art", readLocalFile: localReader({}) });

  assert.doesNotMatch(out, /sdk\.js/);
  assert.match(out, /<h1>Hi<\/h1>/);
});

test("keeps artifact dependencies that happen to be named sdk.js", async () => {
  const html = '<!doctype html><html><body><script src="vendor/sdk.js"></script></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/vendor/sdk.js": "window.vendorSdk = true;" }),
  });

  assert.match(out, /<script>window\.vendorSdk = true;<\/script>/);
  assert.equal(warnings.length, 0);
});

test("resolves root-absolute references through resolveAbsolute (e.g. legacy /design assets)", async () => {
  const html =
    '<!doctype html><html><head><link rel="stylesheet" href="/design/daisyui.css"></head><body></body></html>';
  const { html: out } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/pkg/design/daisyui.css": ".btn{color:blue}" }),
    resolveAbsolute: (refPath) => (refPath === "/design/daisyui.css" ? "/pkg/design/daisyui.css" : null),
  });

  assert.match(out, /<style>\.btn\{color:blue\}<\/style>/);
});

test("default reader allows trusted root-absolute mapped design assets outside the artifact root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lavish-export-"));
  try {
    const artDir = path.join(root, "art");
    const designDir = path.join(root, "pkg", "design");
    await mkdir(artDir, { recursive: true });
    await mkdir(designDir, { recursive: true });
    const designAsset = path.join(designDir, "daisyui.css");
    await writeFile(designAsset, ".btn{color:blue}");

    const html =
      '<!doctype html><html><head><link rel="stylesheet" href="/design/daisyui.css"></head><body></body></html>';
    const { html: out, warnings } = await buildSelfContainedHtml(html, {
      baseDir: artDir,
      confineDir: artDir,
      resolveAbsolute: (refPath) => (refPath === "/design/daisyui.css" ? designAsset : null),
    });

    assert.match(out, /<style>\.btn\{color:blue\}<\/style>/);
    assert.equal(warnings.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leaves in-document fragment references (including encoded %23) untouched", async () => {
  const html =
    "<!doctype html><html><head><style>.a{fill:url(%23grad)}.b{mask:url(#m)}</style></head><body></body></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({}),
  });

  assert.match(out, /url\(%23grad\)/);
  assert.match(out, /url\(#m\)/);
  assert.equal(warnings.length, 0);
});

test("preserves external SVG fragments when inlining local references", async () => {
  const html = '<!doctype html><html><body><svg><use href="icons.svg#check"></use></svg></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/icons.svg": '<svg><symbol id="check"></symbol></svg>' }),
  });

  assert.match(out, /<use href="data:image\/svg\+xml;base64,[^"]+#check">/);
  assert.equal(warnings.length, 0);
});

test("preserves self-closing SVG use and image tags when inlining references", async () => {
  const html =
    '<!doctype html><html><body><svg><use href="icons.svg#check"/><image href="icon.svg" /></svg></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({
      "/art/icons.svg": '<svg><symbol id="check"></symbol></svg>',
      "/art/icon.svg": "<svg></svg>",
    }),
  });

  assert.match(out, /<use href="data:image\/svg\+xml;base64,[^"]+#check" \/>/);
  assert.match(out, /<image href="data:image\/svg\+xml;base64,[^"]+" \/>/);
  assert.doesNotMatch(out, /\/>>/);
  assert.equal(warnings.length, 0);
});

test("confineDir refuses to inline references that lexically escape the artifact directory", async () => {
  const html = '<!doctype html><html><head><link rel="stylesheet" href="../secret.css"></head><body></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art/pages",
    confineDir: "/art/pages",
    readLocalFile: localReader({ "/art/secret.css": "body{color:red}" }),
  });

  assert.match(out, /<link rel="stylesheet" href="\.\.\/secret\.css">/);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, "outside-root");
});

test("redacts unresolved file URLs instead of leaking local paths", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const secret = "file:///Users/kun/secret.png";
  const html =
    `<!doctype html><html><head><link rel="icon" href="${secret}">` +
    `<script defer src="${secret}"></script><style>@import "${secret}";` +
    `.x{background:url("${secret}")}</style></head><body>` +
    `<img src="${secret}" srcset="${secret} 1x, pic.png 2x"></body></html>`;
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
    readLocalFile: localReader({ "/art/pic.png": png }),
  });

  assert.doesNotMatch(out, /file:\/\//);
  assert.doesNotMatch(out, /\/Users\/kun\/secret\.png/);
  assert.match(out, /<link rel="icon" href="about:blank">/);
  assert.match(out, /<script defer src="about:blank"><\/script>/);
  assert.match(out, /@import "about:blank";/);
  assert.match(out, /background:url\("about:blank"\)/);
  assert.match(out, /<img src="about:blank" srcset="about:blank 1x, data:image\/png;base64,iVBORw== 2x">/);
  assert.equal(warnings.length, 6);
  assert.ok(warnings.every((warning) => warning.kind === "outside-root"));
});

test("redacts remaining file URLs from arbitrary HTML attributes", async () => {
  const secret = "file:///Users/kun/secret.png";
  const escaped = "file:&#x2f;&#x2f;/Users/kun/escaped.png";
  const singleSlash = "file:/Users/kun/single-slash.png";
  const namedEntities = "file&colon;&sol;&sol;&sol;Users/kun/named-entity.png";
  const html =
    `<!doctype html><html><body><a href="${secret}">Download</a>` +
    `<form action='${secret}'></form><object data=${secret}></object><embed src=${singleSlash}>` +
    `<iframe src="${escaped}"></iframe><area href='${namedEntities}'>` +
    `<div data-note="prefix ${secret} suffix"></div></body></html>`;
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
  });

  assert.doesNotMatch(out, /file:/i);
  assert.doesNotMatch(out, /file&colon;/i);
  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.match(out, /<a href="about:blank">Download<\/a>/);
  assert.match(out, /<form action='about:blank'><\/form>/);
  assert.match(out, /<object data="about:blank"><\/object>/);
  assert.match(out, /<embed src="about:blank">/);
  assert.match(out, /<iframe src="about:blank"><\/iframe>/);
  assert.match(out, /<area href='about:blank'>/);
  assert.match(out, /<div data-note="about:blank"><\/div>/);
  assert.deepEqual(
    warnings.map((warning) => warning.kind),
    [
      "file-url-redacted",
      "file-url-redacted",
      "file-url-redacted",
      "file-url-redacted",
      "file-url-redacted",
      "file-url-redacted",
      "file-url-redacted",
    ],
  );
});

test("decodes CSS escapes when resolving local url and import refs", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const html =
    '<!doctype html><html><head><style>@import "theme\\000020dark.css";' +
    ".hero{background:url(my\\ image.png)}</style></head></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({
      "/art/theme dark.css": ".theme{color:red}",
      "/art/my image.png": png,
    }),
  });

  assert.doesNotMatch(out, /@import/);
  assert.match(out, /\.theme\{color:red\}/);
  assert.match(out, /background:url\(data:image\/png;base64,iVBORw==\)/);
  assert.equal(warnings.length, 0);
});

test("preserves original CSS escape tokens when unresolved refs remain external", async () => {
  const html = "<!doctype html><html><head><style>.hero{background:url(my\\ image.png)}</style></head></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({}),
  });

  assert.match(out, /background:url\(my\\ image\.png\)/);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, "load-failed");
  assert.equal(warnings[0].ref, "my\\ image.png");
});

test("redacts browser-normalized file schemes in attributes and CSS urls", async () => {
  const html =
    "<!doctype html><html><head><style>.x{background:url(file\\3a///Users/kun/css-secret.png)}</style></head>" +
    '<body><a href="fi&#x09;le:///Users/kun/attr-secret.png">Download</a></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
  });

  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.doesNotMatch(out, /file\\3a/i);
  assert.doesNotMatch(out, /fi&#x09;le/i);
  assert.match(out, /background:url\(about:blank\)/);
  assert.match(out, /<a href="about:blank">Download<\/a>/);
  assert.deepEqual(
    warnings.map((warning) => warning.kind),
    ["outside-root", "file-url-redacted"],
  );
});

test("redacts escaped CSS resource identifiers and numeric file entities without semicolons", async () => {
  const html =
    '<!doctype html><html><head><style>@im\\70ort "file:///Users/kun/import.css";' +
    ".x{background:u\\72l(file\\3a///Users/kun/css-secret.png)}</style></head>" +
    '<body><a href="file&#58///Users/kun/attr-secret.png">Download</a></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
  });

  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.doesNotMatch(out, /file&#58/i);
  assert.doesNotMatch(out, /file\\3a/i);
  assert.match(out, /@im\\70ort "about:blank";/);
  assert.match(out, /background:url\(about:blank\)/);
  assert.match(out, /<a href="about:blank">Download<\/a>/);
  assert.deepEqual(
    warnings.map((warning) => warning.kind),
    ["outside-root", "outside-root", "file-url-redacted"],
  );
});

test("inlines local object embed and image input resources while warning for iframes", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const svg = "<svg></svg>";
  const html =
    '<!doctype html><html><body><object data="diagram.svg"></object><embed src="doc.pdf">' +
    '<input type="image" src="button.png"><input type="text" src="ignored.png">' +
    '<iframe src="panel.html"></iframe></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({
      "/art/diagram.svg": svg,
      "/art/doc.pdf": Buffer.from("%PDF"),
      "/art/button.png": png,
      "/art/panel.html": "<p>Nested</p>",
    }),
  });

  assert.match(out, /<object data="data:image\/svg\+xml;base64,[^"]+"><\/object>/);
  assert.match(out, /<embed src="data:application\/pdf;base64,JVBERg==">/);
  assert.match(out, /<input type="image" src="data:image\/png;base64,iVBORw==">/);
  assert.match(out, /<input type="text" src="ignored\.png">/);
  assert.match(out, /<iframe src="panel\.html"><\/iframe>/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "unsupported-frame", ref: "panel.html" }],
  );
});

test("refuses to inline a local symlink that escapes the artifact directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lavish-export-"));
  try {
    const artDir = path.join(root, "art");
    const outsideDir = path.join(root, "outside");
    await mkdir(artDir);
    await mkdir(outsideDir);
    const secret = path.join(outsideDir, "secret.txt");
    await writeFile(secret, "TOP SECRET");
    await symlink(secret, path.join(artDir, "leak.css"));

    const html = '<!doctype html><html><head><link rel="stylesheet" href="leak.css"></head><body></body></html>';
    const { html: out, warnings } = await buildSelfContainedHtml(html, { baseDir: artDir, confineDir: artDir });

    assert.doesNotMatch(out, /TOP SECRET/);
    assert.match(out, /<link rel="stylesheet" href="leak\.css">/);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].kind, "outside-root");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skips a local asset that exceeds the per-asset size cap and leaves it as a reference", async () => {
  const big = Buffer.alloc(2048, 1);
  const html = '<!doctype html><html><body><img src="big.png"></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    maxAssetBytes: 1024,
    readLocalFile: localReader({ "/art/big.png": big }),
  });

  assert.match(out, /<img src="big\.png">/);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, "too-large");
});

test("default reader rejects oversized assets before attempting to read them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lavish-export-"));
  const big = path.join(root, "big.png");
  try {
    await writeFile(big, Buffer.alloc(2048, 1));
    await chmod(big, 0);

    const html = '<!doctype html><html><body><img src="big.png"></body></html>';
    const { html: out, warnings } = await buildSelfContainedHtml(html, {
      baseDir: root,
      confineDir: root,
      maxAssetBytes: 1024,
    });

    assert.match(out, /<img src="big\.png">/);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].kind, "too-large");
    assert.match(warnings[0].reason || "", /per-asset cap/);
  } finally {
    await chmod(big, 0o600).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("exportFileName derives a portable .export.html name", () => {
  assert.equal(exportFileName("/a/b/report.html"), "report.export.html");
  assert.equal(exportFileName("/a/b/plan.htm"), "plan.export.html");
  assert.equal(exportFileName("/a/b/index.html"), "index.export.html");
});
