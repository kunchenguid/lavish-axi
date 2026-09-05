import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseCommit = "5b871af347444feda1d3002952ec5fc179248629";

function run(command, args, env, timeout = 20_000, cwd = repoRoot) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

async function waitForHealth(base, child, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited before health check\n${output.join("")}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {
      // The private server may still be binding. Retry until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not become healthy\n${output.join("")}`);
}

async function startServer(root, env, port) {
  const output = [];
  const child = spawn(process.execPath, [path.join(root, "bin/lavish-axi.js"), "server", "--port", String(port)], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  try {
    await waitForHealth(`http://127.0.0.1:${port}`, child, output);
    return { child, output };
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
}

async function stopServer(server, base, reason = "stop") {
  if (!server || server.child.exitCode !== null) return;
  await fetch(`${base}/shutdown`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason }),
    signal: AbortSignal.timeout(2000),
  }).catch(() => {});
  const exited = await Promise.race([
    once(server.child, "exit").then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  if (!exited) {
    server.child.kill("SIGTERM");
    await once(server.child, "exit");
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a TCP port");
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return address.port;
}

function pageRows(output) {
  return String(output)
    .split("\n")
    .map((line) => line.match(/^\s*(\d+),(https?:\/\/[^,]+),(true|false)$/))
    .filter(Boolean)
    .map((match) => ({ id: Number(match[1]), url: match[2] }));
}

test(
  "six legacy tabs migrate before seven sessions exercise live transport",
  { skip: !runBrowserE2e, timeout: 300_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-event-transport-"));
    const oldRoot = path.join(temp, "old-build");
    const archive = path.join(temp, "old-build.tar");
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const lavishEnv = {
      LAVISH_AXI_PORT: String(port),
      LAVISH_AXI_STATE_DIR: path.join(temp, "state"),
      LAVISH_AXI_NO_OPEN: "1",
      LAVISH_AXI_TELEMETRY: "0",
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
    };
    const chromeEnv = {
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-event-transport-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };
    const sessions = [];
    let oldServer;
    let currentServer;

    try {
      await mkdir(oldRoot);
      run("git", ["archive", "--format=tar", "--output", archive, baseCommit], lavishEnv);
      run("tar", ["-xf", archive, "-C", oldRoot], lavishEnv);
      await symlink(path.join(repoRoot, "node_modules"), path.join(oldRoot, "node_modules"), "dir");
      oldServer = await startServer(oldRoot, lavishEnv, port);

      for (let index = 0; index < 7; index += 1) {
        const file = path.join(temp, `board-${index + 1}.html`);
        await writeFile(
          file,
          `<!doctype html><title>Board ${index + 1}</title><main id="board-${index + 1}">Board ${index + 1}</main>`,
        );
        const output = run(
          process.execPath,
          ["bin/lavish-axi.js", file, "--no-open", "--no-gate"],
          lavishEnv,
          20_000,
          oldRoot,
        );
        const url = output.match(/url:\s*"([^"]+)"/)?.[1];
        assert.ok(url, output);
        sessions.push({ file, url, key: new URL(url).pathname.split("/").pop() });
      }

      const initialPages = pageRows(run("chrome-devtools-axi", ["pages"], chromeEnv));
      if (initialPages.length > 0) {
        run("chrome-devtools-axi", ["selectpage", String(initialPages[0].id)], chromeEnv);
      }
      run("chrome-devtools-axi", ["open", sessions[0].url], chromeEnv);
      for (const session of sessions.slice(1, 6)) {
        run("chrome-devtools-axi", ["newpage", session.url, "--background"], chromeEnv);
      }

      const legacyUrls = new Set(sessions.slice(0, 6).map((session) => session.url));
      const legacyPages = pageRows(run("chrome-devtools-axi", ["pages"], chromeEnv)).filter((page) =>
        legacyUrls.has(page.url),
      );
      assert.equal(legacyPages.length, 6, "all six affected legacy tabs loaded before replacement");
      let pageByUrl = new Map(legacyPages.map((page) => [page.url, page]));

      for (let index = 0; index < 6; index += 1) {
        const session = sessions[index];
        const page = pageByUrl.get(session.url);
        assert.ok(page, `missing browser tab for ${session.url}`);
        run("chrome-devtools-axi", ["selectpage", String(page.id)], chromeEnv);
        const queued = run(
          "chrome-devtools-axi",
          [
            "eval",
            `() => new Promise((resolve, reject) => { const deadline = Date.now() + 8000; const checkReady = () => { if (!window.__lavishChromeReady) { if (Date.now() >= deadline) return reject(new Error("old chrome did not load")); return setTimeout(checkReady, 25); } const input = document.getElementById("chatInput"); input.value = ${JSON.stringify(`queued-before-upgrade-${index + 1}`)}; input.dispatchEvent(new Event("input", { bubbles: true })); document.getElementById("send").click(); const queueKey = "lavish-axi:queued:${session.key}"; const checkQueue = () => { if (sessionStorage.getItem(queueKey)) return resolve(true); if (Date.now() >= deadline) return reject(new Error("old chrome did not persist its queue")); setTimeout(checkQueue, 25); }; checkQueue(); }; checkReady(); })`,
          ],
          chromeEnv,
          10_000,
        );
        assert.match(queued, /result:\s*"?true"?/);
      }

      const draftSession = sessions[0];
      const draftPage = pageByUrl.get(draftSession.url);
      run("chrome-devtools-axi", ["selectpage", String(draftPage.id)], chromeEnv);
      const draftStored = run(
        "chrome-devtools-axi",
        [
          "eval",
          `() => { const frame = document.getElementById("artifact"); const token = new URL(frame.src).searchParams.get("artifact_load_token"); window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { type: "lavish:reviewState", artifact_load_token: token, state: { card: { selector: "#board-1", text: "draft survives server replacement" }, fields: [] } } })); return sessionStorage.getItem("lavish-axi:review-state:${draftSession.key}"); }`,
        ],
        chromeEnv,
      );
      assert.match(draftStored, /draft survives server replacement/);

      await stopServer(oldServer, base, "stop");
      oldServer = undefined;
      currentServer = await startServer(repoRoot, lavishEnv, port);
      run("chrome-devtools-axi", ["newpage", sessions[6].url, "--background"], chromeEnv);

      const sessionUrls = new Set(sessions.map((session) => session.url));
      const pages = pageRows(run("chrome-devtools-axi", ["pages"], chromeEnv)).filter((page) =>
        sessionUrls.has(page.url),
      );
      assert.equal(pages.length, 7, "all seven same-origin board tabs loaded after replacement");
      pageByUrl = new Map(pages.map((page) => [page.url, page]));

      for (let index = 0; index < sessions.length; index += 1) {
        const session = sessions[index];
        const page = pageByUrl.get(session.url);
        assert.ok(page, `missing browser tab for ${session.url}`);
        run("chrome-devtools-axi", ["selectpage", String(page.id)], chromeEnv);

        if (index === 0) {
          const protectedDraft = run(
            "chrome-devtools-axi",
            [
              "eval",
              `() => new Promise((resolve, reject) => { const deadline = Date.now() + 10000; const check = () => { const draft = sessionStorage.getItem("lavish-axi:review-state:${session.key}") || ""; const banner = document.getElementById("outdatedBanner"); if (draft.includes("draft survives server replacement") && banner && !banner.hidden) return resolve(document.getElementById("outdatedText").textContent); if (Date.now() >= deadline) return reject(new Error("old chrome did not protect the draft")); setTimeout(check, 25); }; check(); })`,
            ],
            chromeEnv,
            12_000,
          );
          assert.match(protectedDraft, /no longer running/);
          assert.doesNotMatch(protectedDraft, /updated/);
          run("chrome-devtools-axi", ["eval", '() => document.getElementById("outdatedReload").click()'], chromeEnv);
        }

        const ready = run(
          "chrome-devtools-axi",
          [
            "eval",
            `() => new Promise((resolve, reject) => { const deadline = Date.now() + 10000; const expectedDraft = ${index === 0 ? '"draft survives server replacement"' : '""'}; const check = () => { const draft = sessionStorage.getItem("lavish-axi:review-state:${session.key}") || ""; if (window.__lavishChromeReady && document.getElementById("artifact")?.src && (!expectedDraft || draft.includes(expectedDraft))) return resolve(true); if (Date.now() >= deadline) return reject(new Error("real legacy chrome did not migrate")); setTimeout(check, 25); }; check(); })`,
          ],
          chromeEnv,
          12_000,
        );
        assert.match(ready, /result:\s*"?true"?/);

        const reloaded = run(
          "chrome-devtools-axi",
          [
            "eval",
            '() => new Promise((resolve, reject) => { const frame = document.getElementById("artifact"); const deadline = Date.now() + 8000; frame.addEventListener("load", () => resolve(true), { once: true }); document.getElementById("reloadArtifact").click(); setTimeout(() => reject(new Error("artifact reload did not complete")), Math.max(1, deadline - Date.now())); })',
          ],
          chromeEnv,
          10_000,
        );
        assert.match(reloaded, /result:\s*"?true"?/);

        const liveReply = `live-event-${index + 1}`;
        const reply = await fetch(`http://127.0.0.1:${port}/api/${session.key}/agent-reply`, {
          method: "POST",
          headers: { connection: "close", "content-type": "application/json" },
          body: JSON.stringify({ text: liveReply }),
        });
        assert.equal(reply.status, 200);
        const observed = run(
          "chrome-devtools-axi",
          [
            "eval",
            `() => new Promise((resolve, reject) => { const deadline = Date.now() + 8000; const check = () => { if (document.getElementById("chatLog").textContent.includes(${JSON.stringify(liveReply)})) return resolve(true); if (Date.now() >= deadline) return reject(new Error("live event did not arrive")); setTimeout(check, 25); }; check(); })`,
          ],
          chromeEnv,
          10_000,
        );
        assert.match(observed, /result:\s*"?true"?/, `board ${index + 1} live event channel stayed connected`);

        const message = `seven-tab-message-${index + 1}`;
        const delivered = run(
          "chrome-devtools-axi",
          [
            "eval",
            `() => new Promise((resolve, reject) => { const promptStatuses = []; const browserFetch = window.fetch.bind(window); window.fetch = async (...args) => { const response = await browserFetch(...args); if (String(args[0]).endsWith("/prompts")) promptStatuses.push(response.status); return response; }; const input = document.getElementById("chatInput"); input.value = ${JSON.stringify(message)}; input.dispatchEvent(new Event("input", { bubbles: true })); document.getElementById("send").click(); const deadline = Date.now() + 8000; const queueKey = "lavish-axi:queued:${session.key}"; const check = () => { if (!sessionStorage.getItem(queueKey) && promptStatuses.length > 0) return resolve(promptStatuses.at(-1)); if (Date.now() >= deadline) return reject(new Error("prompt acknowledgement did not arrive")); setTimeout(check, 25); }; check(); })`,
          ],
          chromeEnv,
          10_000,
        );
        assert.match(delivered, /result:\s*"?200"?/, `board ${index + 1} prompt POST returned 200 within the bound`);

        const poll = run(
          process.execPath,
          ["bin/lavish-axi.js", "poll", session.file, "--timeout-ms", "5000"],
          lavishEnv,
          10_000,
        );
        assert.match(poll, new RegExp(message), `board ${index + 1} poll received its exact prompt`);
        if (index < 6) {
          assert.match(
            poll,
            new RegExp(`queued-before-upgrade-${index + 1}`),
            `board ${index + 1} retained its old-client queue`,
          );
        }
      }
    } finally {
      await stopServer(oldServer, base);
      await stopServer(currentServer, base);
      const stopped = spawnSync("chrome-devtools-axi", ["stop"], {
        cwd: repoRoot,
        env: { ...process.env, ...chromeEnv },
        encoding: "utf8",
        timeout: 15_000,
      });
      assert.ifError(stopped.error);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
