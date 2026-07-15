import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import * as esbuild from "esbuild";
import { parse } from "parse5";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

async function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return "";
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function resultFromDump(html) {
  const document = parse(html);
  const stack = /** @type {import("parse5").DefaultTreeAdapterMap["node"][]} */ ([document]);
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.nodeName === "body") {
      const element = /** @type {import("parse5").DefaultTreeAdapterMap["element"]} */ (node);
      const attribute = element.attrs.find((item) => item.name === "data-result");
      if (attribute) return JSON.parse(attribute.value);
    }
    if ("childNodes" in node) stack.push(...node.childNodes);
  }
  return null;
}

test("real Excalidraw rendering keeps loaded-font labels inside their text bounds", { timeout: 30_000 }, async (t) => {
  const chrome = await chromePath();
  if (!chrome) {
    t.skip("Chrome or Chromium is required for the real-render regression");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "lavish-excalidraw-render-"));
  try {
    await esbuild.build({
      entryPoints: [path.join(projectRoot, "test/fixtures/excalidraw-label-clipping.browser.jsx")],
      outdir: root,
      entryNames: "fixture",
      assetNames: "assets/[name]-[hash]",
      bundle: true,
      format: "iife",
      platform: "browser",
      conditions: ["production"],
      loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
      define: {
        "process.env.NODE_ENV": '"production"',
        "process.env.IS_PREACT": '"false"',
      },
    });
    await cp(
      path.join(projectRoot, "node_modules/@excalidraw/excalidraw/dist/prod/fonts"),
      path.join(root, "whiteboard-assets/fonts"),
      { recursive: true },
    );
    await writeFile(
      path.join(root, "index.html"),
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><script src="/fixture.js"></script></body></html>',
    );
    const server = http.createServer(async (request, response) => {
      try {
        const pathname = new URL(request.url, "http://127.0.0.1").pathname;
        const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
        const file = path.resolve(root, relative);
        if (file !== root && !file.startsWith(`${root}${path.sep}`)) throw new Error("outside fixture root");
        const body = await readFile(file);
        response.writeHead(200, { "content-type": contentType(file), "cache-control": "no-store" });
        response.end(body);
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind to a TCP port");
      const port = address.port;
      const profile = path.join(root, "chrome-profile");
      const { stdout } = await execFileAsync(
        chrome,
        [
          "--headless=new",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--no-sandbox",
          `--user-data-dir=${profile}`,
          "--run-all-compositor-stages-before-draw",
          "--virtual-time-budget=8000",
          "--dump-dom",
          `http://127.0.0.1:${port}/`,
        ],
        { maxBuffer: 8 * 1024 * 1024, timeout: 18_000 },
      );
      const result = resultFromDump(stdout);
      assert.ok(result, "browser fixture did not report a result");
      assert.equal(result.pass, true, result.error);
      assert.equal(result.fontReady, true);
      assert.equal(result.edgeLabels, 4);
      assert.ok(result.multilineLines >= 2);
      assert.ok(result.repaired >= 5);
      assert.ok(result.opaquePixels >= 1000);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
