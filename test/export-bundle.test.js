import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { buildSelfContainedHtml, exportFileName, splitExportWarnings } from "../src/export-bundle.js";

function portablePathKey(absPath) {
  return String(absPath)
    .replace(/\\/g, "/")
    .replace(/^[A-Za-z]:(?=\/)/, "");
}

function portableFileUrl(absPath) {
  const href = pathToFileURL(path.resolve(absPath)).href;
  return /[/\\]$/.test(String(absPath)) && !href.endsWith("/") ? `${href}/` : href;
}

function cssEscapedFileUrl(absPath) {
  return portableFileUrl(absPath).replace(/^file:/i, "file\\3a");
}

function singleSlashFileUrl(absPath) {
  return portableFileUrl(absPath).replace(/^file:\/\/\//i, "file:/");
}

function htmlSlashEscapedFileUrl(absPath) {
  return portableFileUrl(absPath).replaceAll("/", "&#x2f;");
}

function namedEntityFileUrl(absPath) {
  return portableFileUrl(absPath)
    .replace(/^file:/i, "file&colon;")
    .replaceAll("/", "&sol;");
}

function localReader(files) {
  const entries = new Map(Object.entries(files).map(([key, value]) => [portablePathKey(key), value]));
  return async (absPath) => {
    const key = portablePathKey(absPath);
    if (!entries.has(key)) {
      const error = new Error(`ENOENT: ${key}`);
      // @ts-expect-error attach a node-style code for parity with fs errors
      error.code = "ENOENT";
      throw error;
    }
    const value = entries.get(key);
    return typeof value === "string" ? Buffer.from(value) : value;
  };
}

function decodeFirstSvgDataUri(html) {
  const match = html.match(/data:image\/svg\+xml;base64,([^"'>\s#]+)/);
  assert.ok(match);
  return Buffer.from(match[1], "base64").toString("utf8");
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

test("scrubs file URLs from generated stylesheet media attributes", async () => {
  const html =
    '<!doctype html><html><head><link rel="stylesheet" href="theme.css" media="file:///Users/kun/secret"></head></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/theme.css": "body{color:red}" }),
  });

  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.match(out, /<style media="about:blank">body\{color:red\}<\/style>/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "file-url-redacted", ref: "file:///Users/kun/secret" }],
  );
});

test("decodes control attributes before stylesheet decisions", async () => {
  const html =
    '<!doctype html><html><head><link rel="style&#115;heet" href="theme.css"></head><body><p>Hi</p></body></html>';
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

test("leaves eventful stylesheet links external with warnings", async () => {
  const html =
    '<!doctype html><html><head><link rel="stylesheet" media="print" onload="this.media=\'all\'" href="async.css">' +
    '<link rel="stylesheet" onerror="this.remove()" href="fallback.css">' +
    '<link rel="stylesheet" media="screen" href="active.css"></head></html>';
  const readPaths = [];
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return localReader({ "/art/active.css": ".active{color:green}" })(absPath);
    },
  });

  assert.match(out, /<link rel="stylesheet" media="print" onload="this\.media='all'" href="async\.css">/);
  assert.match(out, /<link rel="stylesheet" onerror="this\.remove\(\)" href="fallback\.css">/);
  assert.match(out, /<style media="screen">\.active\{color:green\}<\/style>/);
  assert.deepEqual(readPaths, ["/art/active.css"]);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "behavioral-stylesheet", ref: "async.css" },
      { kind: "behavioral-stylesheet", ref: "fallback.css" },
    ],
  );
});

test("leaves preload-as-style links external with warnings", async () => {
  const html =
    '<!doctype html><html><head><link rel="preload" as="style" href="preload.css" onload="this.rel=\'stylesheet\'">' +
    '<link rel="stylesheet" href="active.css"></head></html>';
  const readPaths = [];
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return localReader({ "/art/active.css": ".active{color:green}" })(absPath);
    },
  });

  assert.match(out, /<link rel="preload" as="style" href="preload\.css" onload="this\.rel='stylesheet'">/);
  assert.match(out, /<style>\.active\{color:green\}<\/style>/);
  assert.deepEqual(readPaths, ["/art/active.css"]);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "preload-stylesheet", ref: "preload.css" }],
  );
});

test("warns for local fetchable link hints left external", async () => {
  const html =
    '<!doctype html><html><head><link rel="preload" as="font" href="font.woff2">' +
    '<link rel="modulepreload" href="app.js"><link rel="prefetch" href="next.html">' +
    '<link rel="manifest" href="manifest.webmanifest"><link rel="preload" as="script" href="https://cdn.example/app.js"></head></html>';
  const readPaths = [];
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      throw new Error(`unexpected read: ${absPath}`);
    },
  });

  assert.match(out, /<link rel="preload" as="font" href="font\.woff2">/);
  assert.match(out, /<link rel="modulepreload" href="app\.js">/);
  assert.match(out, /<link rel="prefetch" href="next\.html">/);
  assert.match(out, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(out, /<link rel="preload" as="script" href="https:\/\/cdn\.example\/app\.js">/);
  assert.deepEqual(readPaths, []);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "fetchable-link", ref: "font.woff2" },
      { kind: "fetchable-link", ref: "app.js" },
      { kind: "fetchable-link", ref: "next.html" },
      { kind: "fetchable-link", ref: "manifest.webmanifest" },
    ],
  );
  assert.equal(splitExportWarnings(warnings).unresolved.length, 4);
});

test("classifies unsupported local references left external as unresolved assets", () => {
  const warnings = [
    { kind: "unsupported-stylesheet-type", ref: "theme.txt" },
    { kind: "unsupported-script-type", ref: "data.json" },
    { kind: "unsupported-style-type", ref: "theme.png" },
    { kind: "file-url-redacted", ref: "file:///Users/kun/secret.png" },
    { kind: "csp-meta", ref: "script-src 'self'" },
  ];

  const { unresolved, notices } = splitExportWarnings(warnings);

  assert.deepEqual(
    unresolved.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "unsupported-stylesheet-type", ref: "theme.txt" },
      { kind: "unsupported-script-type", ref: "data.json" },
      { kind: "unsupported-style-type", ref: "theme.png" },
    ],
  );
  assert.deepEqual(
    notices.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "file-url-redacted", ref: "file:///Users/kun/secret.png" },
      { kind: "csp-meta", ref: "script-src 'self'" },
    ],
  );
});

test("leaves non-CSS stylesheet links external with warnings", async () => {
  const html =
    '<!doctype html><html><head><link rel="stylesheet" type="application/json" href="secrets.json">' +
    '<link rel="stylesheet" type="text/tailwindcss" href="tailwind.css">' +
    '<link rel="stylesheet" type="text/css" href="theme.css"></head></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({
      "/art/secrets.json": '{"secret":true}',
      "/art/tailwind.css": "@tailwind utilities;",
      "/art/theme.css": "body{color:red}",
    }),
  });

  assert.match(out, /<link rel="stylesheet" type="application\/json" href="secrets\.json">/);
  assert.match(out, /<link rel="stylesheet" type="text\/tailwindcss" href="tailwind\.css">/);
  assert.match(out, /<style>body\{color:red\}<\/style>/);
  assert.doesNotMatch(out, /"secret":true|@tailwind utilities/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "unsupported-stylesheet-type", ref: "secrets.json" },
      { kind: "unsupported-stylesheet-type", ref: "tailwind.css" },
    ],
  );
});

test("leaves non-CSS style elements unchanged with warnings for local refs", async () => {
  const html =
    '<!doctype html><html><head><style type="application/json">.json{background:url(pic.png)}</style>' +
    '<style type="text/tailwindcss">.tw{background:image-set("tailwind.png" 1x)}</style>' +
    '<style type="text/css">.css{background:url(ok.png)}</style></head></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({
      "/art/pic.png": Buffer.from("pic"),
      "/art/tailwind.png": Buffer.from("tailwind"),
      "/art/ok.png": Buffer.from("ok"),
    }),
  });

  assert.match(out, /<style type="application\/json">\.json\{background:url\(pic\.png\)\}<\/style>/);
  assert.match(out, /<style type="text\/tailwindcss">\.tw\{background:image-set\("tailwind\.png" 1x\)\}<\/style>/);
  assert.match(out, /<style type="text\/css">\.css\{background:url\(data:image\/png;base64,b2s=\)\}<\/style>/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "unsupported-style-type", ref: "pic.png" },
      { kind: "unsupported-style-type", ref: "tailwind.png" },
    ],
  );
});

test("redacts file URLs in non-CSS style element bodies without bundling", async () => {
  const html =
    '<!doctype html><html><head><style type="text/plain">.x{background:url(file:///Users/kun/secret.png)}.y{background:url(pic.png)}</style></head></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
    readLocalFile: localReader({ "/art/pic.png": Buffer.from("pic") }),
  });

  assert.doesNotMatch(out, /file:/i);
  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.match(
    out,
    /<style type="text\/plain">\.x\{background:url\(about:blank\)\}\.y\{background:url\(pic\.png\)\}<\/style>/,
  );
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "file-url-redacted", ref: "file:///Users/kun/secret.png" },
      { kind: "unsupported-style-type", ref: "pic.png" },
    ],
  );
});

test("leaves CSP meta unchanged and warns it may block inlined export assets", async () => {
  const html =
    '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src \'self\'; img-src file:///Users/kun/policy">' +
    '<script src="app.js"></script></head><body><img src="logo.png"></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({
      "/art/app.js": "window.ready = true;",
      "/art/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    }),
  });

  assert.match(
    out,
    /<meta http-equiv="Content-Security-Policy" content="script-src 'self'; img-src file:\/\/\/Users\/kun\/policy">/,
  );
  assert.match(out, /<script>window\.ready = true;<\/script>/);
  assert.match(out, /<img src="data:image\/png;base64,iVBORw==">/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "csp-meta", ref: "script-src 'self'; img-src file:///Users/kun/policy" }],
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

test("warns when inline import maps reference local module URLs", async () => {
  const importMap = {
    imports: {
      app: "./app.js",
      shared: "shared.js",
      remote: "https://cdn.example/remote.js",
      data: "data:application/javascript,export{}",
    },
    scopes: {
      "./scope/": {
        scoped: "../scoped.js",
        remoteScoped: "https://cdn.example/scoped.js",
      },
    },
  };
  const html = `<!doctype html><html><head><script type="importmap">${JSON.stringify(
    importMap,
  )}</script></head></html>`;
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art/components",
    readLocalFile: localReader({}),
  });

  assert.match(out, /<script type="importmap">/);
  assert.match(out, /"app":"\.\/app\.js"/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "inline-importmap-local-ref", ref: "./app.js" },
      { kind: "inline-importmap-local-ref", ref: "shared.js" },
      { kind: "inline-importmap-local-ref", ref: "./scope/" },
      { kind: "inline-importmap-local-ref", ref: "../scoped.js" },
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

test("warns on root-absolute and escaped inline module local specifiers", async () => {
  const html =
    '<!doctype html><html><head><script type="module">' +
    'import "/assets/app.js";\nimport escaped from ".\\/dep.js";\n' +
    'import remote from "https://cdn.example/remote.js";\nimport pkg from "pkg";\n' +
    "</script></head></html>";
  const { warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art/components",
    readLocalFile: localReader({}),
  });

  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "unmapped-root-absolute", ref: "/assets/app.js" },
      { kind: "inline-module-import", ref: "./dep.js" },
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

test("warns when classic scripts reference local dynamic imports", async () => {
  const html =
    "<!doctype html><html><head><script>" +
    'const local = () => import("./lazy.js");\n' +
    "const templated = () => import(`./templated.js`);\n" +
    'const remote = () => import("https://cdn.example/remote.js");\n' +
    'loader.import("./property.js");\n' +
    'import "./static.js";\n' +
    "</script>" +
    '<script src="js/app.js"></script></head><body><svg><script href="svg/app.js"></script>' +
    '<script>const svgLocal = () => import("./svg-lazy.js");</script></svg></body></html>';
  const { warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({
      "/art/js/app.js":
        'const externalLocal = () => import("./external-lazy.js");\nconst externalPkg = () => import("pkg");',
      "/art/svg/app.js": 'const svgExternalLocal = () => import("./svg-external-lazy.js");',
    }),
  });

  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "inline-module-import", ref: "./lazy.js" },
      { kind: "inline-module-import", ref: "./templated.js" },
      { kind: "inline-module-import", ref: "./external-lazy.js" },
      { kind: "inline-module-import", ref: "./svg-external-lazy.js" },
      { kind: "inline-module-import", ref: "./svg-lazy.js" },
    ],
  );
});

test("redacts file URLs from inline module and import-map specifiers", async () => {
  const html =
    '<!doctype html><html><head><script type="module">' +
    'import "file:///Users/kun/secret-module.js";\n' +
    "export * from 'file:/Users/kun/secret-export.js';\n" +
    "const lazy = () => import(`file:///Users/kun/secret-lazy.js`);\n" +
    'import "./dep.js";\n' +
    "</script>" +
    '<script type="importmap">{"imports":{"secret":"file:///Users/kun/secret-map.js","app":"./app.js"},"scopes":{"file:///Users/kun/secret-scope/":{"x":"./x.js"},"./local-scope/":{"y":"./y.js"}}}</script>' +
    "</head></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
    readLocalFile: localReader({}),
  });

  assert.doesNotMatch(out, /file:/i);
  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.match(out, /import "about:blank"/);
  assert.match(out, /export \* from 'about:blank'/);
  assert.match(out, /import\(`about:blank`\)/);
  assert.match(out, /"secret":"about:blank"/);
  assert.match(out, /"app":"\.\/app\.js"/);
  assert.match(out, /"about:blank":\{"x":"\.\/x\.js"\}/);
  assert.match(out, /"\.\/local-scope\/":\{"y":"\.\/y\.js"\}/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "inline-module-import", ref: "file:///Users/kun/secret-module.js" },
      { kind: "file-url-redacted", ref: "file:///Users/kun/secret-module.js" },
      { kind: "inline-module-import", ref: "file:/Users/kun/secret-export.js" },
      { kind: "file-url-redacted", ref: "file:/Users/kun/secret-export.js" },
      { kind: "inline-module-import", ref: "file:///Users/kun/secret-lazy.js" },
      { kind: "file-url-redacted", ref: "file:///Users/kun/secret-lazy.js" },
      { kind: "inline-module-import", ref: "./dep.js" },
      { kind: "inline-importmap-local-ref", ref: "file:///Users/kun/secret-map.js" },
      { kind: "file-url-redacted", ref: "file:///Users/kun/secret-map.js" },
      { kind: "inline-importmap-local-ref", ref: "file:///Users/kun/secret-scope/" },
      { kind: "file-url-redacted", ref: "file:///Users/kun/secret-scope/" },
      { kind: "inline-importmap-local-ref", ref: "./app.js" },
      { kind: "inline-importmap-local-ref", ref: "./x.js" },
      { kind: "inline-importmap-local-ref", ref: "./local-scope/" },
      { kind: "inline-importmap-local-ref", ref: "./y.js" },
    ],
  );
  assert.deepEqual(
    splitExportWarnings(warnings).unresolved.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "inline-module-import", ref: "file:///Users/kun/secret-module.js" },
      { kind: "inline-module-import", ref: "file:/Users/kun/secret-export.js" },
      { kind: "inline-module-import", ref: "file:///Users/kun/secret-lazy.js" },
      { kind: "inline-module-import", ref: "./dep.js" },
      { kind: "inline-importmap-local-ref", ref: "file:///Users/kun/secret-map.js" },
      { kind: "inline-importmap-local-ref", ref: "file:///Users/kun/secret-scope/" },
      { kind: "inline-importmap-local-ref", ref: "./app.js" },
      { kind: "inline-importmap-local-ref", ref: "./x.js" },
      { kind: "inline-importmap-local-ref", ref: "./local-scope/" },
      { kind: "inline-importmap-local-ref", ref: "./y.js" },
    ],
  );
});

test("redacts file URL import-map import keys", async () => {
  const html =
    '<!doctype html><html><head><script type="importmap">' +
    '{"imports":{"file:///Users/kun/secret-key.js":"./app.js","ok":"./ok.js"}}' +
    "</script></head></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
    readLocalFile: localReader({}),
  });

  assert.doesNotMatch(out, /file:/i);
  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.match(out, /"about:blank":"\.\/app\.js"/);
  assert.match(out, /"ok":"\.\/ok\.js"/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "inline-importmap-local-ref", ref: "file:///Users/kun/secret-key.js" },
      { kind: "file-url-redacted", ref: "file:///Users/kun/secret-key.js" },
      { kind: "inline-importmap-local-ref", ref: "./app.js" },
      { kind: "inline-importmap-local-ref", ref: "./ok.js" },
    ],
  );
});

test("escapes import-map JSON after redacting file refs", async () => {
  const html =
    '<!doctype html><html><head><script type="importmap">' +
    '{"imports":{"leak":"file:///Users/kun/secret.js","safe":"<\\/script><img src=\\"secret.png\\">"}}' +
    "</script></head></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
    readLocalFile: localReader({}),
  });

  assert.doesNotMatch(out, /file:\/\//i);
  assert.doesNotMatch(out, /<\/script><img src=/);
  assert.match(out, /<\\\/script><img src=\\"secret\.png\\">/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "inline-importmap-local-ref", ref: "file:///Users/kun/secret.js" },
      { kind: "file-url-redacted", ref: "file:///Users/kun/secret.js" },
      { kind: "inline-importmap-local-ref", ref: '</script><img src="secret.png">' },
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

test("does not rewrite markup-like text inside attribute values", async () => {
  const html =
    "<!doctype html><html><body><div data-template=\"<img src='secret.json'>\"></div>" +
    '<img alt="debug src=secret.json"></body></html>';
  const reads = [];
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      reads.push(absPath);
      return Buffer.from("secret");
    },
  });

  assert.equal(out, html);
  assert.deepEqual(reads, []);
  assert.deepEqual(warnings, []);
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

test("only inlines media attributes that the element can fetch", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const html =
    '<!doctype html><html><body><img poster="poster.png" srcset="small.png 1x">' +
    '<audio src="audio.mp3" poster="audio-poster.png" srcset="audio-srcset.png 1x"></audio>' +
    '<video poster="poster.png" src="video.mp4"></video>' +
    '<picture><source src="ignored-picture.png" srcset="small.png 1x"></picture>' +
    '<video><source src="video-source.mp4" srcset="ignored-video.png 1x"></video></body></html>';
  const readPaths = [];
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return localReader({
        "/art/audio.mp3": Buffer.from("audio"),
        "/art/poster.png": png,
        "/art/small.png": png,
        "/art/video.mp4": Buffer.from("video"),
        "/art/video-source.mp4": Buffer.from("source"),
      })(absPath);
    },
  });

  assert.deepEqual(readPaths, [
    "/art/small.png",
    "/art/audio.mp3",
    "/art/video.mp4",
    "/art/poster.png",
    "/art/small.png",
    "/art/video-source.mp4",
  ]);
  assert.match(out, /<img poster="poster\.png" srcset="data:image\/png;base64,iVBORw== 1x">/);
  assert.match(
    out,
    /<audio src="data:audio\/mpeg;base64,YXVkaW8=" poster="audio-poster\.png" srcset="audio-srcset\.png 1x"><\/audio>/,
  );
  assert.match(out, /<video poster="data:image\/png;base64,iVBORw==" src="data:video\/mp4;base64,dmlkZW8="><\/video>/);
  assert.match(
    out,
    /<picture><source src="ignored-picture\.png" srcset="data:image\/png;base64,iVBORw== 1x"><\/picture>/,
  );
  assert.match(out, /<video><source src="data:video\/mp4;base64,c291cmNl" srcset="ignored-video\.png 1x"><\/video>/);
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

test("leaves standalone track captions unchanged", async () => {
  const readPaths = [];
  const html = '<!doctype html><html><body><track kind="captions" src="captions.vtt"></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return localReader({ "/art/captions.vtt": "WEBVTT\n" })(absPath);
    },
  });

  assert.deepEqual(readPaths, []);
  assert.match(out, /<track kind="captions" src="captions\.vtt">/);
  assert.equal(warnings.length, 0);
});

test("preserves self-closing syntax when rewriting asset tags", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const html =
    '<!doctype html><html><body><picture><source srcset="pic.png 1x" /></picture>' +
    '<img src="pic.png"/><video><track src="captions.vtt" /></video></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/pic.png": png, "/art/captions.vtt": "WEBVTT\n" }),
  });

  assert.match(out, /<source srcset="data:image\/png;base64,iVBORw== 1x" \/>/);
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

test("redacts file URLs inside HTML and CSS comments", async () => {
  const html =
    "<!doctype html><html><head><!-- local file:///Users/kun/comment.png -->" +
    "<style>/* css file:///Users/kun/style.css */.x{color:red}</style></head></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
    readLocalFile: localReader({}),
  });

  assert.doesNotMatch(out, /file:/i);
  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.match(out, /<!-- local about:blank -->/);
  assert.match(out, /\/\* css about:blank \*\//);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "file-url-redacted", ref: "file:///Users/kun/comment.png" },
      { kind: "file-url-redacted", ref: "file:///Users/kun/style.css" },
    ],
  );
});

test("redacts normalized file URLs inside text regions", async () => {
  const html =
    "<!doctype html><html><head><!-- local file&#58///Users/kun/comment.png -->" +
    "<style>/* css file\\3a///Users/kun/style.css */.x{color:red}</style></head></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
    readLocalFile: localReader({}),
  });

  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.doesNotMatch(out, /file&#58|file\\3a/i);
  assert.match(out, /<!-- local about:blank -->/);
  assert.match(out, /\/\* css about:blank \*\//);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "file-url-redacted", ref: "file&#58///Users/kun/comment.png" },
      { kind: "file-url-redacted", ref: "file\\3a///Users/kun/style.css" },
    ],
  );
});

test("redacts file URLs inside special HTML tokens", async () => {
  const html =
    '<!doctype html SYSTEM "file:///Users/kun/secret.dtd"><html><body>' +
    '<?xml-stylesheet href="file:///Users/kun/secret.css"?></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
    readLocalFile: localReader({}),
  });

  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.match(out, /<!doctype html SYSTEM "about:blank">/);
  assert.match(out, /<\?xml-stylesheet href="about:blank"\?>/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "file-url-redacted", ref: "file:///Users/kun/secret.dtd" },
      { kind: "file-url-redacted", ref: "file:///Users/kun/secret.css" },
    ],
  );
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

test("does not rewrite markup-like text inside legacy raw-text elements", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const html =
    '<!doctype html><html><body><xmp><img src="missing-xmp.png"></xmp>' +
    '<noembed><img src="missing-noembed.png"></noembed>' +
    '<noframes><img src="missing-noframes.png"></noframes>' +
    '<iframe><img src="missing-frame.png"></iframe><img src="pic.png" alt="real"></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/pic.png": png }),
  });

  assert.match(out, /<xmp><img src="missing-xmp\.png"><\/xmp>/);
  assert.match(out, /<noembed><img src="missing-noembed\.png"><\/noembed>/);
  assert.match(out, /<noframes><img src="missing-noframes\.png"><\/noframes>/);
  assert.match(out, /<iframe><img src="missing-frame\.png"><\/iframe>/);
  assert.match(out, /<img src="data:image\/png;base64,iVBORw==" alt="real">/);
  assert.equal(warnings.length, 0);
});

test("redacts file URLs in closed raw-text bodies without tokenizing", async () => {
  const readPaths = [];
  const html =
    "<!doctype html><html><head><title>file:///Users/kun/title.txt</title></head><body>" +
    '<textarea>file:///Users/kun/text.txt <img src="local.png"></textarea>' +
    '<xmp>file:///Users/kun/xmp.txt <img src="local.png"></xmp></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return Buffer.from("unexpected");
    },
  });

  assert.deepEqual(readPaths, []);
  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.match(out, /<title>about:blank<\/title>/);
  assert.match(out, /<textarea>about:blank <img src="local\.png"><\/textarea>/);
  assert.match(out, /<xmp>about:blank <img src="local\.png"><\/xmp>/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "file-url-redacted", ref: "file:///Users/kun/title.txt" },
      { kind: "file-url-redacted", ref: "file:///Users/kun/text.txt" },
      { kind: "file-url-redacted", ref: "file:///Users/kun/xmp.txt" },
    ],
  );
});

test("treats self-closing non-void raw-text and inert tags as open HTML elements", async () => {
  const readPaths = [];
  const html =
    '<!doctype html><html><body><textarea/><img src="text-secret.png"></textarea>' +
    '<template/><img src="template-secret.png"></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return localReader({
        "/art/text-secret.png": Buffer.from("text-secret"),
        "/art/template-secret.png": Buffer.from("template-secret"),
      })(absPath);
    },
  });

  assert.deepEqual(readPaths, []);
  assert.doesNotMatch(out, /data:/);
  assert.match(out, /<textarea><img src="text-secret\.png"><\/textarea><template><img src="template-secret\.png">/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "unterminated-raw-text", ref: "template" },
      { kind: "inert-resource", ref: "template-secret.png" },
    ],
  );
});

test("treats unterminated raw-text content as inert through EOF", async () => {
  const html =
    '<!doctype html><html><body><textarea><img src="local.png"><img src="file:///Users/kun/secret.png"><img src="live.png">';
  const readPaths = [];
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return localReader({
        "/art/local.png": Buffer.from("local"),
        "/art/live.png": Buffer.from("live"),
      })(absPath);
    },
  });

  assert.deepEqual(readPaths, []);
  assert.doesNotMatch(out, /file:/i);
  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.match(out, /<textarea><img src="local\.png"><img src="about:blank"><img src="live\.png">$/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "unterminated-raw-text", ref: "textarea" },
      { kind: "file-url-redacted", ref: "file:///Users/kun/secret.png" },
    ],
  );
});

test("reports unterminated active script src while leaving following markup inert", async () => {
  const readPaths = [];
  const html = '<!doctype html><html><body><script src="app.js" /><img src="secret.png"></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return localReader({
        "/art/app.js": "console.log(1);",
        "/art/secret.png": Buffer.from("secret"),
      })(absPath);
    },
  });

  assert.deepEqual(readPaths, []);
  assert.doesNotMatch(out, /data:/);
  assert.match(out, /<script src="app\.js" ><img src="secret\.png">/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "unterminated-raw-text", ref: "script" },
      { kind: "unterminated-script-src", ref: "app.js" },
    ],
  );
  assert.deepEqual(
    splitExportWarnings(warnings).unresolved.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "unterminated-script-src", ref: "app.js" }],
  );
});

test("treats plaintext content as inert through EOF", async () => {
  const readPaths = [];
  const html =
    '<!doctype html><html><body><plaintext><img src="local.png"><img src="file:///Users/kun/secret.png"><img src="live.png">';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return localReader({
        "/art/local.png": Buffer.from("local"),
        "/art/live.png": Buffer.from("live"),
      })(absPath);
    },
  });

  assert.deepEqual(readPaths, []);
  assert.doesNotMatch(out, /data:/);
  assert.doesNotMatch(out, /file:/i);
  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.match(out, /<plaintext><img src="local\.png"><img src="about:blank"><img src="live\.png">$/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "file-url-redacted", ref: "file:///Users/kun/secret.png" }],
  );
});

test("leaves template and noscript resources inert while warning on local refs", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const readPaths = [];
  const html =
    '<!doctype html><html><body><template><img src="local.png"><link rel="stylesheet" href="theme.css"></template>' +
    '<noscript><img src="noscript.png"></noscript><img src="live.png"></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return localReader({
        "/art/local.png": Buffer.from("local"),
        "/art/theme.css": "body{color:red}",
        "/art/noscript.png": Buffer.from("noscript"),
        "/art/live.png": png,
      })(absPath);
    },
  });

  assert.match(out, /<template><img src="local\.png"><link rel="stylesheet" href="theme\.css"><\/template>/);
  assert.match(out, /<noscript><img src="noscript\.png"><\/noscript>/);
  assert.match(out, /<img src="data:image\/png;base64,iVBORw==">/);
  assert.deepEqual(readPaths, ["/art/live.png"]);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "inert-resource", ref: "local.png" },
      { kind: "inert-resource", ref: "theme.css" },
      { kind: "inert-resource", ref: "noscript.png" },
    ],
  );
});

test("keeps nested and quoted template content inert until the matching close", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const readPaths = [];
  const html =
    '<!doctype html><html><body><template><template><img src="inner.png"></template>' +
    '<div data-close="</template>"><img src="outer.png"></div></template><img src="live.png"></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return localReader({
        "/art/inner.png": Buffer.from("inner"),
        "/art/outer.png": Buffer.from("outer"),
        "/art/live.png": png,
      })(absPath);
    },
  });

  assert.deepEqual(readPaths, ["/art/live.png"]);
  assert.match(
    out,
    /<template><template><img src="inner\.png"><\/template><div data-close="<\/template>"><img src="outer\.png"><\/div><\/template>/,
  );
  assert.match(out, /<img src="data:image\/png;base64,iVBORw==">/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "inert-resource", ref: "inner.png" },
      { kind: "inert-resource", ref: "outer.png" },
    ],
  );
});

test("redacts file URLs inside inert template content", async () => {
  const html =
    '<!doctype html><html><body><template><img src="file:///Users/kun/secret.png">' +
    '<a href="file:/Users/kun/secret.txt">secret</a></template></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
  });

  assert.doesNotMatch(out, /file:/i);
  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.match(out, /<template><img src="about:blank"><a href="about:blank">secret<\/a><\/template>/);
  assert.deepEqual(
    warnings.map((warning) => warning.kind),
    ["file-url-redacted", "file-url-redacted"],
  );
});

test("redacts inert module file refs without counting rendered unresolved assets", async () => {
  const html =
    '<!doctype html><html><body><template><script type="module">import "file:///Users/kun/secret.js";</script></template></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
  });

  assert.doesNotMatch(out, /file:/i);
  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.match(out, /<template><script type="module">import "about:blank";<\/script><\/template>/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "file-url-redacted", ref: "file:///Users/kun/secret.js" }],
  );
  assert.deepEqual(splitExportWarnings(warnings).unresolved, []);
});

test("redacts file URLs in inert text chunks without tokenizing", async () => {
  const readPaths = [];
  const html =
    '<!doctype html><html><body><template>before file:///Users/kun/secret.txt after <img src="local.png"></template></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return Buffer.from("unexpected");
    },
  });

  assert.deepEqual(readPaths, []);
  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.match(out, /<template>before about:blank after <img src="local\.png"><\/template>/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "file-url-redacted", ref: "file:///Users/kun/secret.txt" },
      { kind: "inert-resource", ref: "local.png" },
    ],
  );
});

test("scrubs CSS-aware style attributes inside inert content without inlining", async () => {
  const readPaths = [];
  const html =
    '<!doctype html><html><body><template style="background:u\\72l(file\\3a///Users/kun/template.png)">' +
    "<div style='background:image-set(\"local.png\" 1x)'></div></template></body></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return localReader({ "/art/local.png": Buffer.from("local") })(absPath);
    },
  });

  assert.deepEqual(readPaths, []);
  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.doesNotMatch(out, /file\\3a/i);
  assert.match(out, /<template style="background:url\(about:blank\)">/);
  assert.match(out, /<div style='background:image-set\("local\.png" 1x\)'><\/div>/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "file-url-redacted", ref: "file\\3a///Users/kun/template.png" },
      { kind: "inert-resource", ref: "local.png" },
    ],
  );
});

test("scrubs and warns on CSS resources inside inert content without inlining", async () => {
  const html =
    '<!doctype html><html><body><template><style>.x{background:url(file:///Users/kun/secret.png)}.y{background:image-set("local.png" 1x)}</style></template></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
    readLocalFile: localReader({ "/art/local.png": Buffer.from("local") }),
  });

  assert.doesNotMatch(out, /file:/i);
  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.match(
    out,
    /<template><style>\.x\{background:url\(about:blank\)\}\.y\{background:image-set\("local\.png" 1x\)\}<\/style><\/template>/,
  );
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "file-url-redacted", ref: "file:///Users/kun/secret.png" },
      { kind: "inert-resource", ref: "local.png" },
    ],
  );
});

test("treats unterminated inert content as inert through EOF", async () => {
  const html =
    '<!doctype html><html><body><template><img src="local.png"><style>.x{background:url(file:///Users/kun/secret.png)}</style><img src="live.png">';
  const readPaths = [];
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return localReader({
        "/art/local.png": Buffer.from("local"),
        "/art/live.png": Buffer.from("live"),
      })(absPath);
    },
  });

  assert.deepEqual(readPaths, []);
  assert.doesNotMatch(out, /file:/i);
  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.match(
    out,
    /<template><img src="local\.png"><style>\.x\{background:url\(about:blank\)\}<\/style><img src="live\.png">$/,
  );
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "unterminated-raw-text", ref: "template" },
      { kind: "inert-resource", ref: "local.png" },
      { kind: "file-url-redacted", ref: "file:///Users/kun/secret.png" },
      { kind: "inert-resource", ref: "live.png" },
    ],
  );
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
    '<!doctype html><html><head><template><base href="wrong/"></template>' +
    '<noscript><base href="wrong-noscript/"></noscript><base href="assets/">' +
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

test("keeps trailing slashes in unquoted attribute values before tag close", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const readPaths = [];
  const html = "<!doctype html><html><head><base href=assets/></head><body><img src=pic.png></body></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return localReader({
        "/art/assets/pic.png": png,
        "/art/pic.png": Buffer.from("wrong"),
      })(absPath);
    },
  });

  assert.deepEqual(readPaths, ["/art/assets/pic.png"]);
  assert.match(out, /<base href=assets\/>/);
  assert.match(out, /<img src="data:image\/png;base64,iVBORw==">/);
  assert.equal(warnings.length, 0);

  const trailingImage = "<!doctype html><html><body><img src=pic.png/></body></html>";
  const trailing = await buildSelfContainedHtml(trailingImage, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/pic.png": png }),
  });

  assert.match(trailing.html, /<img src=pic\.png\/>/);
  assert.deepEqual(
    trailing.warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "load-failed", ref: "pic.png/" }],
  );
});

test("ignores base href inside unterminated raw text", async () => {
  const readPaths = [];
  const html = '<!doctype html><html><body><img src="pic.png"><script><base href="assets/">';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return localReader({
        "/art/pic.png": Buffer.from("root"),
        "/art/assets/pic.png": Buffer.from("wrong"),
      })(absPath);
    },
  });

  assert.deepEqual(readPaths, ["/art/pic.png"]);
  assert.match(out, /<img src="data:image\/png;base64,cm9vdA==">/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "unterminated-raw-text", ref: "script" }],
  );
});

test("closes raw-text elements on end tags with attributes", async () => {
  const readPaths = [];
  const html = '<!doctype html><html><body><script>console.log(1)</script type=x><img src="pic.png"></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return localReader({ "/art/pic.png": Buffer.from("pic") })(absPath);
    },
  });

  assert.deepEqual(readPaths, ["/art/pic.png"]);
  assert.match(out, /<\/script type=x><img src="data:image\/png;base64,cGlj">/);
  assert.equal(warnings.length, 0);
});

test("scrubs file URLs from close-tag raw text", async () => {
  const html =
    '<!doctype html><html><body><script>console.log(1)</script data-path="file:///Users/kun/script.map">' +
    "<div></div data-path='file:///Users/kun/div.txt'></body></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, { baseDir: "/art" });

  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.match(out, /<\/script data-path="about:blank">/);
  assert.match(out, /<\/div data-path='about:blank'>/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "file-url-redacted", ref: "file:///Users/kun/script.map" },
      { kind: "file-url-redacted", ref: "file:///Users/kun/div.txt" },
    ],
  );
});

test("keeps inert raw-text bodies text-only while scrubbing file URLs", async () => {
  const html =
    "<!doctype html><html><body><template><script>const html = \"<a href='file:///Users/kun/secret.txt'><img src='local.png'>\";</script></template></body></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/local.png": Buffer.from("local") }),
  });

  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.match(
    out,
    /<template><script>const html = "<a href='about:blank'><img src='local\.png'>";<\/script><\/template>/,
  );
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "file-url-redacted", ref: "file:///Users/kun/secret.txt" }],
  );
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
      readPaths.push(portablePathKey(absPath));
      return Buffer.from(files[portablePathKey(absPath)]);
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

test("keeps CSS imports external when imported stylesheets contain namespaces", async () => {
  const html = '<!doctype html><html><head><style>@import "ns.css";.app{color:red}</style></head></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({
      "/art/ns.css": "@namespace svg url(http://www.w3.org/2000/svg);svg|a{fill:red}",
    }),
  });

  assert.match(out, /@import "ns\.css";\.app\{color:red\}/);
  assert.doesNotMatch(out, /@namespace svg/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "css-import-order", ref: "ns.css" }],
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

test("rebases namespace url identifiers when hoisting linked CSS", async () => {
  const html = '<!doctype html><html><head><link rel="stylesheet" href="css/app.css"></head></html>';
  const readPaths = [];
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return localReader({
        "/art/css/app.css": "@namespace icon url(ns.xml);icon|glyph{fill:red}",
      })(absPath);
    },
  });

  assert.deepEqual(readPaths, ["/art/css/app.css"]);
  assert.match(out, /<style>@namespace icon url\(css\/ns\.xml\);icon\|glyph\{fill:red\}<\/style>/);
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
  const importRef = portableFileUrl("/Users/kun/import.css");
  const secretRef = portableFileUrl("/Users/kun/secret.png");
  const html =
    `<!doctype html><html><head><style>@import url(/*x*/"${importRef}");` +
    `.x{background:url(/*x*/${secretRef}/*y*/)}</style></head></html>`;
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
  const secretRef = portableFileUrl("/Users/kun/secret.png");
  const html =
    '<!doctype html><html><head><style>.hero{content:"file:///Users/kun/text.png";' +
    `background:image-set("local.png" 1x, "${secretRef}" 2x);` +
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

test("does not rewrite CSS URLs in conditional at-rule preludes", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const readPaths = [];
  const html =
    "<!doctype html><html><head><style>@supports (background:url(secret.png)){" +
    ".supports{background:url(ok.png)}}" +
    '@media (background:image-set("secret.png" 1x)){.media{background:image-set("ok.png" 1x)}}' +
    "@container (background:url(secret.png)){.container{background:url(ok.png)}}</style></head></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return localReader({
        "/art/ok.png": png,
        "/art/secret.png": Buffer.from("secret"),
      })(absPath);
    },
  });

  assert.deepEqual(readPaths, ["/art/ok.png", "/art/ok.png", "/art/ok.png"]);
  assert.match(out, /@supports \(background:url\(secret\.png\)\)/);
  assert.match(out, /@media \(background:image-set\("secret\.png" 1x\)\)/);
  assert.match(out, /@container \(background:url\(secret\.png\)\)/);
  assert.match(out, /\.supports\{background:url\(data:image\/png;base64,iVBORw==\)\}/);
  assert.match(out, /\.media\{background:image-set\("data:image\/png;base64,iVBORw==" 1x\)\}/);
  assert.match(out, /\.container\{background:url\(data:image\/png;base64,iVBORw==\)\}/);
  assert.equal(warnings.length, 0);
});

test("redacts file URLs in conditional CSS at-rule preludes", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const html =
    "<!doctype html><html><head><style>@supports (background:url(file:///Users/kun/supports.png)){" +
    ".supports{background:url(ok.png)}}" +
    '@media (background:image-set("file:///Users/kun/media.png" 1x)){.media{background:url(ok.png)}}' +
    "@container (background:u\\72l(file\\3a///Users/kun/container.png)){.container{background:url(ok.png)}}" +
    "</style></head></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
    readLocalFile: localReader({ "/art/ok.png": png }),
  });

  assert.doesNotMatch(out, /file:/i);
  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.match(out, /@supports \(background:url\(about:blank\)\)/);
  assert.match(out, /@media \(background:image-set\("about:blank" 1x\)\)/);
  assert.match(out, /@container \(background:url\(about:blank\)\)/);
  assert.match(out, /\.supports\{background:url\(data:image\/png;base64,iVBORw==\)\}/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "file-url-redacted", ref: "file:///Users/kun/supports.png" },
      { kind: "file-url-redacted", ref: "file:///Users/kun/media.png" },
      { kind: "file-url-redacted", ref: "file\\3a///Users/kun/container.png" },
    ],
  );
});

test("handles escaped urls and image-set operands inside inline styles", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const secretRef = cssEscapedFileUrl("/Users/kun/secret.png");
  const html =
    `<!doctype html><html><body><div style="background:u\\72l(${secretRef})"></div>` +
    "<div style='background:image-set(\"local.png\" 1x)'></div>" +
    '<div style="background:image-set(&quot;local.png&quot; 1x)"></div></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
    readLocalFile: localReader({ "/art/local.png": png }),
  });

  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.doesNotMatch(out, /file\\3a/i);
  assert.match(out, /style="background:url\(about:blank\)"/);
  assert.match(out, /style='background:image-set\("data:image\/png;base64,iVBORw==" 1x\)'/);
  assert.match(out, /style="background:image-set\(&quot;data:image\/png;base64,iVBORw==&quot; 1x\)"/);
  assert.deepEqual(
    warnings.map((warning) => warning.kind),
    ["outside-root"],
  );
});

test("scrubs file URLs from copied CSS import rules in inline styles", async () => {
  const html =
    '<!doctype html><html><body><div style="@im\\70ort url(file\\3a///Users/kun/secret.css); color:red"></div></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
  });

  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.doesNotMatch(out, /file\\3a/i);
  assert.match(out, /style="@im\\70ort url\(about:blank\); color:red"/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "file-url-redacted", ref: "file\\3a///Users/kun/secret.css" }],
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
  const titleRef = portableFileUrl("/Users/kun/title.png");
  const textareaRef = portableFileUrl("/Users/kun/textarea.png");
  const html =
    `<!doctype html><html><head><title style="background:url(${titleRef})">` +
    '<img src="missing-title.png"></title></head><body>' +
    `<textarea style="background:url(${textareaRef})"><img src="missing-textarea.png"></textarea>` +
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

test("processes raw-text start tag attributes while leaving content inert", async () => {
  const html =
    '<!doctype html><html><head><style data-path="file:///Users/kun/style-secret.css">' +
    '.x{content:"<img src=\\"missing-style.png\\">"}</style>' +
    '<script data-path="file:///Users/kun/script-secret.txt">const html = "<img src=\\"missing-script.png\\">";</script>' +
    "</head></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
  });

  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.match(out, /<style data-path="about:blank">\.x\{content:"<img src=\\"missing-style\.png\\">"\}<\/style>/);
  assert.match(out, /<script data-path="about:blank">const html = "<img src=\\"missing-script\.png\\">";<\/script>/);
  assert.deepEqual(
    warnings.map((warning) => warning.kind),
    ["file-url-redacted", "file-url-redacted"],
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
      readPaths.push(portablePathKey(absPath));
      const value = Buffer.from(files[portablePathKey(absPath)]);
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

test("scrubs file URLs from classic script comments without touching string literals", async () => {
  const inlineComment = "file:///Users/kun/inline.map";
  const externalComment = "file:///Users/kun/external.map";
  const inlineString = "file:///Users/kun/inline-string.txt";
  const externalString = "file:///Users/kun/external-string.txt";
  const html =
    "<!doctype html><html><body><script>//# sourceMappingURL=" +
    inlineComment +
    '\nconst inlinePath = "' +
    inlineString +
    '";</script><script src="app.js"></script></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({
      "/art/app.js": `/* ${externalComment} */\nconst externalPath = "${externalString}";`,
    }),
  });

  assert.doesNotMatch(out, /sourceMappingURL=file:\/\/\/Users/);
  assert.doesNotMatch(out, /\/Users\/kun\/external\.map/);
  assert.ok(out.includes(inlineString));
  assert.ok(out.includes(externalString));
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "file-url-redacted", ref: inlineComment },
      { kind: "file-url-redacted", ref: externalComment },
    ],
  );
});

test("scrubs file URLs from classic script HTML-like comments", async () => {
  const inlineComment = "file:///Users/kun/inline-html-comment.map";
  const externalComment = "file:///Users/kun/external-html-comment.map";
  const stringRef = "file:///Users/kun/string.txt";
  const html =
    "<!doctype html><html><body><script><!-- " +
    inlineComment +
    ' -->\nconst path = "' +
    stringRef +
    '";\n--> file:///Users/kun/close-comment.map\n</script><script src="app.js"></script></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({
      "/art/app.js": `<!-- ${externalComment} -->\nconst externalPath = "${stringRef}";`,
    }),
  });

  assert.doesNotMatch(out, /inline-html-comment/);
  assert.doesNotMatch(out, /external-html-comment/);
  assert.doesNotMatch(out, /close-comment/);
  assert.ok(out.includes(stringRef));
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "file-url-redacted", ref: inlineComment },
      { kind: "file-url-redacted", ref: "file:///Users/kun/close-comment.map" },
      { kind: "file-url-redacted", ref: externalComment },
    ],
  );
});

test("scrubs file URLs from module script comments without touching string literals", async () => {
  const commentRef = "file:///Users/kun/module.map";
  const stringRef = "file:///Users/kun/module-string.txt";
  const html =
    '<!doctype html><html><body><script type="module">//# sourceMappingURL=' +
    commentRef +
    '\nconst path = "' +
    stringRef +
    '";</script></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({}),
  });

  assert.doesNotMatch(out, /sourceMappingURL=file:\/\/\/Users/);
  assert.ok(out.includes(stringRef));
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "file-url-redacted", ref: commentRef }],
  );
});

test("scrubs file URLs from non-executable and preserved script bodies", async () => {
  const html =
    '<!doctype html><html><body><script type="application/json">{"path":"file:///Users/kun/data.json"}</script>' +
    '<script type="speculationrules" src="rules.json">{"prefetch":["file:///Users/kun/prefetch.json"]}</script>' +
    '<script defer src="app.js">const ignored = "file:///Users/kun/ignored.js";</script>' +
    '<script src="missing.js">// file:///Users/kun/missing.map</script></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({}),
  });

  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.match(out, /<script type="application\/json">\{"path":"about:blank"\}<\/script>/);
  assert.match(out, /<script type="speculationrules" src="rules\.json">\{"prefetch":\["about:blank"\]\}<\/script>/);
  assert.match(out, /<script defer src="app\.js">const ignored = "about:blank";<\/script>/);
  assert.match(out, /<script src="missing\.js">\/\/ about:blank<\/script>/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "file-url-redacted", ref: "file:///Users/kun/data.json" },
      { kind: "unsupported-script-type", ref: "rules.json" },
      { kind: "file-url-redacted", ref: "file:///Users/kun/prefetch.json" },
      { kind: "unsupported-script-timing", ref: "app.js" },
      { kind: "file-url-redacted", ref: "file:///Users/kun/ignored.js" },
      { kind: "load-failed", ref: "missing.js" },
      { kind: "file-url-redacted", ref: "file:///Users/kun/missing.map" },
    ],
  );
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

test("resolves HTML asset references against a single-slash file base href", async () => {
  const baseHref = singleSlashFileUrl("/art/assets/");
  const html = `<!doctype html><html><head><base href="${baseHref}"></head><body><img src="logo.png"></body></html>`;
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/assets/logo.png": Buffer.from("logo") }),
  });

  assert.match(out, /<base href="about:blank">/);
  assert.match(out, /<img src="data:image\/png;base64,bG9nbw==">/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "file-url-redacted", ref: baseHref }],
  );
});

test("warns on unmapped root-absolute refs while leaving them unchanged", async () => {
  const readPaths = [];
  const html =
    '<!doctype html><html><head><base href="/assets/"><style>.x{background:url(/assets/bg.png)}</style></head>' +
    '<body><img src="/assets/logo.png"><img src="relative.png"></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return Buffer.from("unexpected");
    },
  });

  assert.deepEqual(readPaths, []);
  assert.match(out, /<base href="\/assets\/">/);
  assert.match(out, /url\(\/assets\/bg\.png\)/);
  assert.match(out, /<img src="\/assets\/logo\.png">/);
  assert.match(out, /<img src="relative\.png">/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "unmapped-root-absolute", ref: "/assets/" },
      { kind: "unmapped-root-absolute", ref: "/assets/bg.png" },
      { kind: "unmapped-root-absolute", ref: "/assets/logo.png" },
      { kind: "unmapped-root-absolute", ref: "/assets/relative.png" },
    ],
  );
});

test("warns on an unmapped root-absolute base href without other assets", async () => {
  const { html: out, warnings } = await buildSelfContainedHtml('<!doctype html><base href="/assets/">', {
    baseDir: "/art",
  });

  assert.match(out, /<base href="\/assets\/">/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "unmapped-root-absolute", ref: "/assets/" }],
  );
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

test("does not inline SVG ref tags outside an SVG ancestor", async () => {
  const html = '<!doctype html><html><body><use href="icons.svg#check"></use></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/icons.svg": '<svg><symbol id="check"></symbol></svg>' }),
  });

  assert.match(out, /<use href="icons\.svg#check"><\/use>/);
  assert.equal(warnings.length, 0);
});

test("does not inline HTML resource attributes in foreign namespaces", async () => {
  const readPaths = [];
  const html =
    '<!doctype html><html><body><svg><img src="secret.png"></svg>' +
    '<math><object data="secret.svg"></object></math><img src="active.png"></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return localReader({
        "/art/secret.png": Buffer.from("secret"),
        "/art/secret.svg": "<svg></svg>",
        "/art/active.png": Buffer.from("active"),
      })(absPath);
    },
  });

  assert.deepEqual(readPaths, ["/art/active.png"]);
  assert.match(out, /<svg><img src="secret\.png"><\/svg>/);
  assert.match(out, /<math><object data="secret\.svg"><\/object><\/math>/);
  assert.match(out, /<img src="data:image\/png;base64,YWN0aXZl">/);
  assert.equal(warnings.length, 0);
});

test("resumes HTML parsing inside SVG foreignObject", async () => {
  const readPaths = [];
  const html =
    '<!doctype html><html><body><svg><foreignObject><script src="app.js" />' +
    '<img src="secret.png"></script><img src="active.png"><use href="icon.svg"></use></foreignObject>' +
    '<use href="icon.svg"></use></svg></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return localReader({
        "/art/app.js": "window.app = true;",
        "/art/active.png": Buffer.from("active"),
        "/art/icon.svg": "<svg></svg>",
      })(absPath);
    },
  });

  assert.deepEqual(readPaths, ["/art/app.js", "/art/active.png", "/art/icon.svg"]);
  assert.doesNotMatch(out, /secret\.png/);
  assert.match(out, /<script>window\.app = true;<\/script><img src="data:image\/png;base64,YWN0aXZl">/);
  assert.match(out, /<foreignObject>.*<use href="icon\.svg"><\/use>/s);
  assert.match(out, /<svg>.*<use href="data:image\/svg\+xml;base64,[^"]+"><\/use><\/svg>/s);
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

test("sanitizes local SVG text before encoding it as a data URI", async () => {
  const svg =
    '<svg><!-- file:///Users/kun/comment.txt --><image href="nested.png" />' +
    "<style>.a{background:url(file:///Users/kun/secret.png)}.b{background:url(local.png)}</style></svg>";
  const html = '<!doctype html><html><body><img src="icon.svg"></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
    readLocalFile: localReader({ "/art/icon.svg": svg }),
  });
  const decoded = decodeFirstSvgDataUri(out);

  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.doesNotMatch(decoded, /\/Users\/kun/);
  assert.match(decoded, /<!-- about:blank -->/);
  assert.match(decoded, /<image href="nested\.png" \/>/);
  assert.match(decoded, /background:url\(about:blank\)/);
  assert.match(decoded, /background:url\(local\.png\)/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "file-url-redacted", ref: "file:///Users/kun/comment.txt" },
      { kind: "nested-svg-resource", ref: "nested.png" },
      { kind: "nested-svg-resource", ref: "file:///Users/kun/secret.png" },
      { kind: "file-url-redacted", ref: "file:///Users/kun/secret.png" },
      { kind: "nested-svg-resource", ref: "local.png" },
    ],
  );
  assert.deepEqual(
    splitExportWarnings(warnings).unresolved.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "nested-svg-resource", ref: "nested.png" },
      { kind: "nested-svg-resource", ref: "file:///Users/kun/secret.png" },
      { kind: "nested-svg-resource", ref: "local.png" },
    ],
  );
});

test("warns for nested SVG script href dependencies in inlined SVG assets", async () => {
  const svg = '<svg><script href="local.js"></script><script xlink:href="legacy.js"></script></svg>';
  const html = '<!doctype html><html><body><img src="icon.svg"></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/icon.svg": svg }),
  });
  const decoded = decodeFirstSvgDataUri(out);

  assert.match(decoded, /<script href="local\.js"><\/script>/);
  assert.match(decoded, /<script xlink:href="legacy\.js"><\/script>/);
  assert.deepEqual(
    splitExportWarnings(warnings).unresolved.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "nested-svg-resource", ref: "local.js" },
      { kind: "nested-svg-resource", ref: "legacy.js" },
    ],
  );
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
  const secret = portableFileUrl("/Users/kun/secret.png");
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

test("reports unparseable file URLs before redacting active assets", async () => {
  const ref = "file:///%E0%A4%A";
  const readPaths = [];
  const { html: out, warnings } = await buildSelfContainedHtml(`<img src="${ref}">`, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      throw new Error(`unexpected read: ${absPath}`);
    },
  });

  assert.deepEqual(readPaths, []);
  assert.match(out, /<img src="about:blank">/);
  assert.doesNotMatch(out, /file:\/\/server/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "file-url-unresolved", ref },
      { kind: "file-url-redacted", ref },
    ],
  );
  assert.deepEqual(
    splitExportWarnings(warnings).unresolved.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "file-url-unresolved", ref }],
  );
});

test("redacts remaining file URLs from arbitrary HTML attributes", async () => {
  const secret = portableFileUrl("/Users/kun/secret.png");
  const escaped = htmlSlashEscapedFileUrl("/Users/kun/escaped.png");
  const singleSlash = singleSlashFileUrl("/Users/kun/single-slash.png");
  const namedEntities = namedEntityFileUrl("/Users/kun/named-entity.png");
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
      "outside-root",
      "outside-root",
      "outside-root",
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
  const cssSecret = cssEscapedFileUrl("/Users/kun/css-secret.png");
  const attrSecret = portableFileUrl("/Users/kun/attr-secret.png").replace(/^file/i, "fi&#x09;le");
  const html =
    `<!doctype html><html><head><style>.x{background:url(${cssSecret})}</style></head>` +
    `<body><a href="${attrSecret}">Download</a></body></html>`;
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
  const importSecret = portableFileUrl("/Users/kun/import.css");
  const cssSecret = cssEscapedFileUrl("/Users/kun/css-secret.png");
  const attrSecret = portableFileUrl("/Users/kun/attr-secret.png").replace(/^file:/i, "file&#58");
  const html =
    `<!doctype html><html><head><style>@im\\70ort "${importSecret}";` +
    `.x{background:u\\72l(${cssSecret})}</style></head>` +
    `<body><a href="${attrSecret}">Download</a></body></html>`;
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

test("leaves object and embed HTML nested documents unresolved", async () => {
  const readPaths = [];
  const html =
    '<!doctype html><html><body><object data="panel.html"></object>' +
    '<embed src="widget.htm"><object data="diagram.svg"></object></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return localReader({
        "/art/panel.html": "<p>Nested</p>",
        "/art/widget.htm": "<p>Nested</p>",
        "/art/diagram.svg": "<svg></svg>",
      })(absPath);
    },
  });

  assert.deepEqual(readPaths, ["/art/diagram.svg"]);
  assert.match(out, /<object data="panel\.html"><\/object>/);
  assert.match(out, /<embed src="widget\.htm">/);
  assert.match(out, /<object data="data:image\/svg\+xml;base64,[^"]+"><\/object>/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "unsupported-frame", ref: "panel.html" },
      { kind: "unsupported-frame", ref: "widget.htm" },
    ],
  );
});

test("leaves object and embed HTML MIME nested documents unresolved", async () => {
  const readPaths = [];
  const html =
    '<!doctype html><html><body><object type="text/html" data="panel"></object>' +
    '<embed type="application/xhtml+xml" src="widget">' +
    '<object type="image/svg+xml" data="diagram.svg"></object></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return localReader({
        "/art/panel": "<p>Nested</p>",
        "/art/widget": "<p>Nested</p>",
        "/art/diagram.svg": "<svg></svg>",
      })(absPath);
    },
  });

  assert.deepEqual(readPaths, ["/art/diagram.svg"]);
  assert.match(out, /<object type="text\/html" data="panel"><\/object>/);
  assert.match(out, /<embed type="application\/xhtml\+xml" src="widget">/);
  assert.match(out, /<object type="image\/svg\+xml" data="data:image\/svg\+xml;base64,[^"]+"><\/object>/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "unsupported-frame", ref: "panel" },
      { kind: "unsupported-frame", ref: "widget" },
    ],
  );
});

test("leaves percent-encoded object and embed HTML nested documents unresolved", async () => {
  const readPaths = [];
  const html =
    '<!doctype html><html><body><object data="panel%2Ehtml"></object>' +
    '<embed src="widget%2Ehtm"><object data="diagram.svg"></object></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return localReader({
        "/art/panel.html": "<p>Nested</p>",
        "/art/widget.htm": "<p>Nested</p>",
        "/art/diagram.svg": "<svg></svg>",
      })(absPath);
    },
  });

  assert.deepEqual(readPaths, ["/art/diagram.svg"]);
  assert.match(out, /<object data="panel%2Ehtml"><\/object>/);
  assert.match(out, /<embed src="widget%2Ehtm">/);
  assert.match(out, /<object data="data:image\/svg\+xml;base64,[^"]+"><\/object>/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "unsupported-frame", ref: "panel%2Ehtml" },
      { kind: "unsupported-frame", ref: "widget%2Ehtm" },
    ],
  );
});

test("records file iframe src as an unresolved frame before redacting it", async () => {
  const panelUrl = portableFileUrl("/art/panel.html");
  const html = `<!doctype html><html><body><iframe src="${panelUrl}"></iframe></body></html>`;
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
  });

  assert.match(out, /<iframe src="about:blank"><\/iframe>/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "unsupported-frame", ref: panelUrl }],
  );
});

test("inlines confined file URL render resources and redacts escaping ones", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const svg = "<svg></svg>";
  const readPaths = [];
  const diagramUrl = portableFileUrl("/art/diagram.svg");
  const docUrl = portableFileUrl("/art/doc.pdf");
  const buttonUrl = portableFileUrl("/art/button.png");
  const secretUrl = portableFileUrl("/Users/kun/secret.svg");
  const html =
    `<!doctype html><html><body><object data="${diagramUrl}"></object>` +
    `<embed src="${docUrl}"><input type="image" src="${buttonUrl}">` +
    `<object data="${secretUrl}"></object></body></html>`;
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return localReader({
        "/art/diagram.svg": svg,
        "/art/doc.pdf": Buffer.from("%PDF"),
        "/art/button.png": png,
      })(absPath);
    },
  });

  assert.deepEqual(readPaths, ["/art/diagram.svg", "/art/doc.pdf", "/art/button.png"]);
  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.match(out, /<object data="data:image\/svg\+xml;base64,[^"]+"><\/object>/);
  assert.match(out, /<embed src="data:application\/pdf;base64,JVBERg==">/);
  assert.match(out, /<input type="image" src="data:image\/png;base64,iVBORw==">/);
  assert.match(out, /<object data="about:blank"><\/object>/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "outside-root", ref: secretUrl }],
  );
});

test("scrubs iframe srcdoc refs without bundling nested HTML", async () => {
  const readPaths = [];
  const html =
    '<!doctype html><html><body><iframe srcdoc=\'<img src="local.png">' +
    "<style>.x{background:u\\72l(file\\3a///Users/kun/secret.png)}</style>'></iframe></body></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return localReader({ "/art/local.png": Buffer.from("local") })(absPath);
    },
  });

  assert.deepEqual(readPaths, []);
  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.doesNotMatch(out, /file\\3a/i);
  assert.match(out, /srcdoc='<img src="local\.png"><style>\.x\{background:url\(about:blank\)\}<\/style>'/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "srcdoc-resource", ref: "local.png" },
      { kind: "srcdoc-resource", ref: "file\\3a///Users/kun/secret.png" },
      { kind: "file-url-redacted", ref: "file\\3a///Users/kun/secret.png" },
    ],
  );
});

test("reports raw-text script refs inside active iframe srcdoc as unresolved", async () => {
  const html =
    '<!doctype html><html><body><iframe srcdoc=\'<script src="local.js"></script>' +
    '<script type="module">import "./dep.js";</script>' +
    '<script>const lazy = () => import("./lazy.js");</script>\'></iframe></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({}),
  });

  assert.match(
    out,
    /srcdoc='<script src="local\.js"><\/script><script type="module">import "\.\/dep\.js";<\/script><script>const lazy = \(\) => import\("\.\/lazy\.js"\);<\/script>'/,
  );
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "srcdoc-resource", ref: "local.js" },
      { kind: "inline-module-import", ref: "./dep.js" },
      { kind: "inline-module-import", ref: "./lazy.js" },
    ],
  );
  assert.deepEqual(
    splitExportWarnings(warnings).unresolved.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "srcdoc-resource", ref: "local.js" },
      { kind: "inline-module-import", ref: "./dep.js" },
      { kind: "inline-module-import", ref: "./lazy.js" },
    ],
  );
});

test("reports fetchable links inside active iframe srcdoc as unresolved", async () => {
  const html =
    '<!doctype html><html><body><iframe srcdoc=\'<link rel="modulepreload" href="app.js">' +
    '<link rel="preload" as="font" href="font.woff2"><link rel="manifest" href="manifest.webmanifest">\'></iframe></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({}),
  });

  assert.match(out, /srcdoc='<link rel="modulepreload" href="app\.js">/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "srcdoc-resource", ref: "app.js" },
      { kind: "srcdoc-resource", ref: "font.woff2" },
      { kind: "srcdoc-resource", ref: "manifest.webmanifest" },
    ],
  );
  assert.deepEqual(
    splitExportWarnings(warnings).unresolved.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "srcdoc-resource", ref: "app.js" },
      { kind: "srcdoc-resource", ref: "font.woff2" },
      { kind: "srcdoc-resource", ref: "manifest.webmanifest" },
    ],
  );
});

test("preserves CSP meta content inside iframe srcdoc while warning", async () => {
  const html =
    '<!doctype html><html><body><iframe srcdoc=\'<meta http-equiv="Content-Security-Policy" ' +
    'content="img-src file:///Users/kun/policy"><img src="local.png">\'></iframe></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/local.png": Buffer.from("local") }),
  });

  assert.match(
    out,
    /srcdoc='<meta http-equiv="Content-Security-Policy" content="img-src file:\/\/\/Users\/kun\/policy"><img src="local\.png">'/,
  );
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "csp-meta", ref: "img-src file:///Users/kun/policy" },
      { kind: "srcdoc-resource", ref: "local.png" },
    ],
  );
});

test("counts active srcdoc file resources as unresolved before redacting them", async () => {
  const localUrl = portableFileUrl("/art/local.png");
  const secretUrl = portableFileUrl("/Users/kun/secret.png");
  const html =
    `<!doctype html><html><body><iframe srcdoc='<img src="${localUrl}">` +
    `<img src="${secretUrl}">'></iframe></body></html>`;
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
    readLocalFile: localReader({ "/art/local.png": Buffer.from("local") }),
  });

  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.match(out, /srcdoc='<img src="about:blank"><img src="about:blank">'/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "srcdoc-resource", ref: localUrl },
      { kind: "file-url-redacted", ref: localUrl },
      { kind: "srcdoc-resource", ref: secretUrl },
      { kind: "file-url-redacted", ref: secretUrl },
    ],
  );
});

test("scrubs inert iframe srcdoc refs without bundling nested HTML", async () => {
  const readPaths = [];
  const html =
    '<!doctype html><html><body><template><iframe srcdoc=\'<img src="local.png">' +
    "<style>.x{background:u\\72l(file\\3a///Users/kun/secret.png)}</style>'></iframe></template></body></html>";
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    confineDir: "/art",
    readLocalFile: async (absPath) => {
      readPaths.push(portablePathKey(absPath));
      return localReader({ "/art/local.png": Buffer.from("local") })(absPath);
    },
  });

  assert.deepEqual(readPaths, []);
  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.doesNotMatch(out, /file\\3a/i);
  assert.match(
    out,
    /<template><iframe srcdoc='<img src="local\.png"><style>\.x\{background:url\(about:blank\)\}<\/style>'><\/iframe><\/template>/,
  );
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [
      { kind: "inert-resource", ref: "local.png" },
      { kind: "file-url-redacted", ref: "file\\3a///Users/kun/secret.png" },
    ],
  );
});

test("inlines local SVG feImage href resources", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const html =
    '<!doctype html><html><body><svg><filter><feImage href="fx.png" />' +
    '<feImage xlink:href="fx2.png"></feImage></filter></svg></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({
      "/art/fx.png": png,
      "/art/fx2.png": png,
    }),
  });

  assert.match(out, /<feImage href="data:image\/png;base64,iVBORw==" \/>/);
  assert.match(out, /<feImage xlink:href="data:image\/png;base64,iVBORw=="><\/feImage>/);
  assert.equal(warnings.length, 0);
});

test("redacts file URLs hidden behind semicolonless named entities", async () => {
  const html = '<!doctype html><html><body><a href="file&colon///Users/kun/secret.png">secret</a></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, { baseDir: "/art" });

  assert.match(out, /<a href="about:blank">secret<\/a>/);
  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "file-url-redacted", ref: "file&colon///Users/kun/secret.png" }],
  );
});

test("scrubs CSS import URLs that contain semicolons", async () => {
  const secretUrl = `${portableFileUrl("/Users/kun/secret.css")};v`;
  const html = `<!doctype html><html><head><style>@import url(${secretUrl});.ok{color:red}</style></head></html>`;
  const { html: out, warnings } = await buildSelfContainedHtml(html, { baseDir: "/art", confineDir: "/art" });

  assert.match(out, /@import url\(about:blank\);\.ok\{color:red\}/);
  assert.doesNotMatch(out, /\/Users\/kun/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "outside-root", ref: secretUrl }],
  );
});

test("inlines SVG script href resources in SVG namespace", async () => {
  const html =
    '<!doctype html><html><body><svg><script href="app.js"></script><script xlink:href="app.js" /></svg></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/app.js": "console.log(1);" }),
  });

  assert.match(out, /<script href="data:text\/javascript;base64,Y29uc29sZS5sb2coMSk7"><\/script>/);
  assert.match(out, /<script xlink:href="data:text\/javascript;base64,Y29uc29sZS5sb2coMSk7" \/>/);
  assert.equal(warnings.length, 0);
});

test("scrubs file URLs from inlined SVG script href resources", async () => {
  const html = '<!doctype html><html><body><svg><script href="app.js"></script></svg></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({
      "/art/app.js": '//# sourceMappingURL=file:///Users/kun/app.map\nconst path = "file:///Users/kun/string.txt";',
    }),
  });
  const match = out.match(/href="data:text\/javascript;base64,([^"]+)"/);
  assert.ok(match);
  const script = Buffer.from(match[1], "base64").toString("utf8");

  assert.doesNotMatch(script, /sourceMappingURL=file:\/\/\/Users/);
  assert.match(script, /sourceMappingURL=about:blank/);
  assert.match(script, /"file:\/\/\/Users\/kun\/string\.txt"/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "file-url-redacted", ref: "file:///Users/kun/app.map" }],
  );
});

test("ignores SVG base elements during document base discovery", async () => {
  const html = '<!doctype html><html><body><svg><base href="assets/"></base></svg><img src="logo.png"></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, {
    baseDir: "/art",
    readLocalFile: localReader({ "/art/logo.png": Buffer.from("logo") }),
  });

  assert.match(out, /<img src="data:image\/png;base64,bG9nbw==">/);
  assert.equal(warnings.length, 0);
});

test("does not treat property import calls as module imports", async () => {
  const html =
    '<!doctype html><html><body><script type="module">loader.import("file:///Users/kun/config.json"); import "./dep.js";</script></body></html>';
  const { html: out, warnings } = await buildSelfContainedHtml(html, { baseDir: "/art" });

  assert.match(out, /loader\.import\("file:\/\/\/Users\/kun\/config\.json"\)/);
  assert.doesNotMatch(out, /loader\.import\("about:blank"\)/);
  assert.deepEqual(
    warnings.map((warning) => ({ kind: warning.kind, ref: warning.ref })),
    [{ kind: "inline-module-import", ref: "./dep.js" }],
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
