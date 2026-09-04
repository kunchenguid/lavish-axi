import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, env, timeout = 20_000) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
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
  "seven sessions on one origin can all reload and deliver prompts",
  { skip: !runBrowserE2e, timeout: 300_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-event-transport-"));
    const port = await freePort();
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

    try {
      for (let index = 0; index < 7; index += 1) {
        const file = path.join(temp, `board-${index + 1}.html`);
        await writeFile(file, `<!doctype html><title>Board ${index + 1}</title><main>Board ${index + 1}</main>`);
        const output = run(process.execPath, ["bin/lavish-axi.js", file, "--no-open", "--no-gate"], lavishEnv);
        const url = output.match(/url:\s*"([^"]+)"/)?.[1];
        assert.ok(url, output);
        sessions.push({ file, url, key: new URL(url).pathname.split("/").pop() });
      }

      const initialPages = pageRows(run("chrome-devtools-axi", ["pages"], chromeEnv));
      if (initialPages.length > 0) {
        run("chrome-devtools-axi", ["selectpage", String(initialPages[0].id)], chromeEnv);
      }
      run("chrome-devtools-axi", ["open", sessions[0].url], chromeEnv);
      for (const session of sessions.slice(1)) {
        run("chrome-devtools-axi", ["newpage", session.url, "--background"], chromeEnv);
      }

      const sessionUrls = new Set(sessions.map((session) => session.url));
      const pages = pageRows(run("chrome-devtools-axi", ["pages"], chromeEnv)).filter((page) =>
        sessionUrls.has(page.url),
      );
      assert.equal(pages.length, 7, "all seven same-origin board tabs loaded");
      const pageByUrl = new Map(pages.map((page) => [page.url, page]));

      for (let index = 0; index < sessions.length; index += 1) {
        const session = sessions[index];
        const page = pageByUrl.get(session.url);
        assert.ok(page, `missing browser tab for ${session.url}`);
        run("chrome-devtools-axi", ["selectpage", String(page.id)], chromeEnv);

        // Re-navigating the selected tab exercises the same full-page reload that stalled while
        // six EventSource requests occupied Chromium's normal HTTP/1.1 connection pool.
        run("chrome-devtools-axi", ["open", session.url], chromeEnv);
        const ready = run(
          "chrome-devtools-axi",
          [
            "eval",
            '() => new Promise((resolve, reject) => { const deadline = Date.now() + 8000; const check = () => { if (window.__lavishChromeReady && document.getElementById("artifact")?.src) return resolve(true); if (Date.now() >= deadline) return reject(new Error("Lavish reload did not complete")); setTimeout(check, 25); }; check(); })',
          ],
          chromeEnv,
          10_000,
        );
        assert.match(ready, /result:\s*"?true"?/);

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
      }
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv, 15_000);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
