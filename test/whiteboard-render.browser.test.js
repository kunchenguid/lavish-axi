import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import * as esbuild from "esbuild";
import { parse } from "parse5";

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

function dumpChromeDom(chrome, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(chrome, args, { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    const stop = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      if (error) reject(error);
      else resolve(stdout);
    };
    const timer = setTimeout(() => finish(new Error("Chrome did not dump the fixture DOM in time")), timeoutMs);
    child.on("error", finish);
    child.on("exit", (code) => {
      if (!settled) finish(new Error(`Chrome exited before dumping the fixture DOM (${code})`));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 8 * 1024 * 1024) {
        finish(new Error("Chrome fixture DOM exceeded 8 MB"));
      } else if (stdout.includes("</html>")) {
        finish();
      }
    });
  });
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

async function runBrowserFixture(t, fixtureName) {
  const chrome = await chromePath();
  if (!chrome) {
    t.skip("Chrome or Chromium is required for the real-render regression");
    return null;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "lavish-excalidraw-render-"));
  try {
    await esbuild.build({
      entryPoints: [path.join(projectRoot, `test/fixtures/${fixtureName}.browser.jsx`)],
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
        const url = new URL(request.url, "http://127.0.0.1");
        const pathname = url.pathname;
        if (pathname === "/result") {
          const value = String(url.searchParams.get("value") || "")
            .replaceAll("&", "&amp;")
            .replaceAll('"', "&quot;");
          response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          response.end(`<!doctype html><html><body data-result="${value}"></body></html>`);
          return;
        }
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
      const profile = path.join(root, "chrome-profile");
      const stdout = await dumpChromeDom(
        chrome,
        [
          "--headless=new",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--no-sandbox",
          `--user-data-dir=${profile}`,
          "--run-all-compositor-stages-before-draw",
          "--virtual-time-budget=20000",
          "--dump-dom",
          `http://127.0.0.1:${address.port}/`,
        ],
        75_000,
      );
      const result = resultFromDump(stdout);
      assert.ok(result, "browser fixture did not report a result");
      assert.equal(result.pass, true, result.error);
      return result;
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("real Excalidraw rendering keeps loaded-font labels inside their text bounds", { timeout: 90_000 }, async (t) => {
  const result = await runBrowserFixture(t, "excalidraw-label-clipping");
  if (!result) return;
  assert.equal(result.fontReady, true);
  assert.equal(result.edgeLabels, 4);
  assert.ok(result.multilineLines >= 2);
  assert.ok(result.repaired >= 5);
  assert.ok(result.opaquePixels >= 1000);
});

test("mounted Excalidraw autosaves prompt only after genuine edits", { timeout: 90_000 }, async (t) => {
  const result = await runBrowserFixture(t, "excalidraw-autosave-conflict");
  if (!result) return;
  assert.equal(result.preMountBaselineAction, "prompt");
  assert.equal(result.viewOnlyAction, "convert");
  assert.equal(result.editedAction, "prompt");
});
