import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { link, mkdtemp, open, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

import { loadPageProofKey } from "../src/artifact-page.js";
import { serve } from "../src/server.js";
import { shareCommand } from "../src/cli.js";

const marker = "0123456789ABCDEF".repeat(2);
const execFileAsync = promisify(execFile);

// The server only accepts an owner-only key, which on Windows is a protected ACL a plain write
// cannot produce. Let production create the file, then replace its bytes in place.
async function seedPageProofKey(root, bytes) {
  await loadPageProofKey(root);
  await writeFile(path.join(root, "page-proof.key"), bytes, { flag: "r+" });
}
// A regression must never send test fixtures to the public hosting service.
const originalApiUrl = process.env.LAVISH_AXI_HTML_APP_API_URL;
process.env.LAVISH_AXI_HTML_APP_API_URL = "http://127.0.0.1:1";
test.after(() => {
  if (originalApiUrl === undefined) delete process.env.LAVISH_AXI_HTML_APP_API_URL;
  else process.env.LAVISH_AXI_HTML_APP_API_URL = originalApiUrl;
});

test("HTML serving and browser export/share protect the loaded key inode even after its pathname changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-protected-source-"));
  const keyFile = path.join(root, "page-proof.key");
  const entry = path.join(root, "entry.html");
  const alias = path.join(root, "leak.html");
  await seedPageProofKey(root, marker);
  await writeFile(entry, '<!doctype html><body><img src="old-key.png">NORMAL ENTRY</body>');
  const published = [];
  const host = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    published.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ url: "https://example.test/safe", site_id: "safe", update_key: "test" }));
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", () => resolve(undefined)));
  const previousHost = process.env.LAVISH_AXI_HTML_APP_API_URL;
  process.env.LAVISH_AXI_HTML_APP_API_URL = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (host.address()).port}`;
  const server = await serve({ port: 0, stateFile: path.join(root, "state.json"), version: "protected-test" });
  try {
    await link(keyFile, alias);
    await link(keyFile, path.join(root, "old-key.png"));
    await symlink(alias, path.join(root, "symlink.html"));
    const base = `http://127.0.0.1:${server.port}`;
    const sessionFor = (file) =>
      fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file }),
      }).then((r) => r.json());
    const normal = await sessionFor(entry);
    const secret = await sessionFor(alias);
    // The in-memory signer still uses the original inode. Looking up the pathname now
    // would protect a different file and expose the signer through its surviving links.
    await unlink(keyFile);
    await writeFile(keyFile, "R".repeat(32), { mode: 0o600 });
    for (const route of [
      `/artifact/${normal.key}/leak.html`,
      `/artifact/${normal.key}/symlink.html`,
      `/api/${secret.key}/export`,
    ]) {
      const response = await fetch(base + route);
      assert.equal(response.status, 403, route);
      assert.equal((await response.text()).includes(marker), false);
    }
    const shared = await fetch(`${base}/api/${secret.key}/share`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(shared.status, 403);
    assert.equal((await shared.text()).includes(marker), false);
    assert.equal(published.length, 0, "a protected top-level source must not reach the publisher");
    const exported = await fetch(`${base}/api/${normal.key}/export`);
    assert.equal(exported.status, 200);
    const html = await exported.text();
    assert.match(html, /NORMAL ENTRY/);
    assert.equal(html.includes(Buffer.from(marker).toString("base64")), false);
    assert.match(html, /src="old-key.png"/);
    const normalShare = await fetch(`${base}/api/${normal.key}/share`, { method: "POST", headers: { origin: base } });
    assert.equal(normalShare.status, 200);
    assert.equal(published.length, 1);
    assert.match(published[0].html_content, /NORMAL ENTRY/);
    assert.equal(published[0].html_content.includes(Buffer.from(marker).toString("base64")), false);
  } finally {
    await server.close();
    if (previousHost === undefined) delete process.env.LAVISH_AXI_HTML_APP_API_URL;
    else process.env.LAVISH_AXI_HTML_APP_API_URL = previousHost;
    await new Promise((resolve) => host.close(() => resolve(undefined)));
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI export/share reject a key used as the top-level HTML through hard and symbolic links", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-cli-protected-source-"));
  const keyFile = path.join(root, "page-proof.key");
  const requests = [];
  const host = createServer((req, res) => {
    requests.push(req.url);
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ url: "https://example.test/never", site_id: "test", update_key: "test" }));
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", () => resolve(undefined)));
  const previousState = process.env.LAVISH_AXI_STATE_DIR;
  const previousHost = process.env.LAVISH_AXI_HTML_APP_API_URL;
  process.env.LAVISH_AXI_STATE_DIR = root;
  process.env.LAVISH_AXI_HTML_APP_API_URL = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (host.address()).port}`;
  try {
    await writeFile(keyFile, marker, { mode: 0o600 });
    const hard = path.join(root, "hard.html");
    const soft = path.join(root, "soft.html");
    await link(keyFile, hard);
    await symlink(keyFile, soft);
    for (const source of [hard, soft]) {
      const output = path.join(root, path.basename(source) + ".export.html");
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)), "export", source, "--out", output],
        {
          env: { ...process.env, LAVISH_AXI_TELEMETRY: "0" },
          encoding: "utf8",
        },
      );
      assert.notEqual(result.status, 0);
      await assert.rejects(readFile(output), { code: "ENOENT" });
      await assert.rejects(shareCommand([source]), /protected local file/);
    }
    // Run the actual CLI source-read route with a filesystem swap at open(), after
    // canonicalization and after the protected inode has been captured.
    for (const command of ["export", "share"]) {
      for (const aliasKind of ["hard", "symbolic"]) {
        const source = path.join(root, `${command}-${aliasKind}.html`);
        await writeFile(source, "<!doctype html><p>BENIGN</p>");
        const bootstrap = `import fs from 'node:fs/promises';
          import {syncBuiltinESMExports} from 'node:module';
          const original = fs.open;
          fs.open = async function(file, ...args) {
            if (String(file) === process.env.LAVISH_TEST_SOURCE) {
              await fs.unlink(file);
              await fs[process.env.LAVISH_TEST_ALIAS === 'hard' ? 'link' : 'symlink'](process.env.LAVISH_TEST_KEY, file);
            }
            return original(file, ...args);
          };
          syncBuiltinESMExports();`;
        await assert.rejects(
          execFileAsync(
            process.execPath,
            [
              "--import",
              "data:text/javascript," + encodeURIComponent(bootstrap),
              fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)),
              command,
              source,
            ],
            {
              env: {
                ...process.env,
                LAVISH_AXI_TELEMETRY: "0",
                LAVISH_TEST_SOURCE: await realpath(source),
                LAVISH_TEST_KEY: keyFile,
                LAVISH_TEST_ALIAS: aliasKind,
              },
              timeout: 5000,
            },
          ),
          (error) => {
            const failure = /** @type {{stdout?: string, stderr?: string}} */ (error);
            return /protected local file/.test(String(failure.stdout) + String(failure.stderr));
          },
        );
      }
    }
    assert.equal(requests.length, 0);
  } finally {
    if (previousState === undefined) delete process.env.LAVISH_AXI_STATE_DIR;
    else process.env.LAVISH_AXI_STATE_DIR = previousState;
    if (previousHost === undefined) delete process.env.LAVISH_AXI_HTML_APP_API_URL;
    else process.env.LAVISH_AXI_HTML_APP_API_URL = previousHost;
    await new Promise((resolve) => host.close(() => resolve(undefined)));
    await rm(root, { recursive: true, force: true });
  }
});

test("document and export source swaps cannot read key bytes through the opened handle", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-source-swap-"));
  const keyFile = path.join(root, "page-proof.key");
  const entry = path.join(root, "entry.html");
  await seedPageProofKey(root, marker);
  await writeFile(entry, "<!doctype html><p>SAFE</p>");
  let attack = false;
  let reads = 0;
  const server = await serve({
    port: 0,
    stateFile: path.join(root, "state.json"),
    version: "source-swap",
    artifactPageOpen: async (file, flags) => {
      if (attack && path.basename(file) === "entry.html") {
        await unlink(file);
        await link(keyFile, file);
        attack = false;
      }
      const handle = await open(file, flags);
      const original = handle.readFile.bind(handle);
      handle.readFile = /** @type {typeof handle.readFile} */ (
        (...args) => {
          reads++;
          return original(...args);
        }
      );
      return handle;
    },
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const session = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: entry }),
    }).then((r) => r.json());
    for (const route of [
      `/artifact/${session.key}/entry.html`,
      `/api/${session.key}/export`,
      `/api/${session.key}/share`,
    ]) {
      await unlink(entry);
      await writeFile(entry, "<!doctype html><p>SAFE</p>");
      attack = true;
      reads = 0;
      const response = await fetch(
        base + route,
        route.endsWith("/share") ? { method: "POST", headers: { origin: base } } : {},
      );
      assert.equal(response.status, 403, route);
      assert.equal(reads, 0, "the verified handle must be rejected before any bytes are consumed");
      assert.equal((await response.text()).includes(marker), false);
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
