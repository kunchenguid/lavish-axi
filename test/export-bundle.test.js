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
