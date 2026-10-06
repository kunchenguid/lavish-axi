import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { serve } from "../src/server.js";
import { SessionStore, sessionKey } from "../src/session-store.js";

const exec = promisify(execFile);

test(
  "session cards open usable top-level editors across two navigations",
  { skip: process.env.LAVISH_AXI_BROWSER_E2E !== "1", timeout: 180_000 },
  async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-session-navigation-")));
    const env = {
      ...process.env,
      LAVISH_AXI_STATE_DIR: root,
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
      CHROME_DEVTOOLS_AXI_AUTO_CONNECT: "0",
      CHROME_DEVTOOLS_AXI_BROWSER_URL: "",
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-navigation-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(root, "chrome"),
    };
    const server = await serve({ env, port: 0, stateFile: path.join(root, "state.json") });
    const base = `http://127.0.0.1:${server.port}`;
    const store = new SessionStore(path.join(root, "state.json"));
    const files = ["A", "B", "C"].map((name) => path.join(root, `${name}.html`));
    const urls = files.map((file) => `${base}/session/${sessionKey(file)}`);

    async function chrome(...args) {
      const { stdout } = await exec("chrome-devtools-axi", args, { env, timeout: 45_000, maxBuffer: 2 ** 20 });
      return stdout;
    }
    function decode(output) {
      const raw = output.match(/result:\s*("(?:[^"\\]|\\.)*")/s)?.[1];
      assert.ok(raw, output);
      let value = JSON.parse(raw);
      while (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          break;
        }
      }
      return value;
    }
    async function clickLink(label) {
      const snapshot = await chrome("snapshot");
      const uid = snapshot.match(new RegExp(`uid=(\\S+) link "${label}"`))?.[1];
      assert.ok(uid, snapshot);
      await chrome("click", `@${uid}`);
    }
    async function editorState() {
      return decode(
        await chrome(
          "eval",
          `() => JSON.stringify({
        url: location.href, ready: !!window.__lavishChromeReady,
        editors: document.querySelectorAll('#artifact').length,
        artifact: document.getElementById('artifact')?.src,
        sandbox: document.getElementById('artifact')?.getAttribute('sandbox'),
        opener: !!window.opener
      })`,
        ),
      );
    }
    async function selectNewPage(previousPages) {
      const pages = await chrome("pages");
      const ids = [...pages.matchAll(/^\s+(\d+),/gm)].map((match) => match[1]);
      const next = ids.find((id) => !previousPages.includes(id));
      assert.ok(next, `a session link must open a new tab; pages were:\n${pages}\n${await chrome("console")}`);
      await chrome("selectpage", next);
    }
    async function pageIds() {
      return [...(await chrome("pages")).matchAll(/^\s+(\d+),/gm)].map((match) => match[1]);
    }

    try {
      for (let i = 0; i < files.length; i++) {
        const name = ["A", "B", "C"][i];
        const next = ["B", "C"][i];
        await writeFile(
          files[i],
          `<!doctype html><html><head><title>Review ${name}</title><base target="_self"></head><body>
          <h1>Artifact ${name}</h1>
          ${next ? `<a href="${urls[i + 1]}"><span>Session ${next}</span></a>` : ""}
          <a href="#section">Jump to section</a><h2 id="section">Section ${name}</h2>
          <a href="sibling.html">Local sibling</a>
          </body></html>`,
        );
        await store.upsertSession(files[i], urls[i]);
      }
      await writeFile(path.join(root, "sibling.html"), "<h1>Local sibling content</h1>");
      await chrome("open", urls[0]);
      await chrome("wait", "Artifact A");
      // Real user input toggles mode through the production chrome/SDK exchange.
      await chrome("press", "Meta+i");
      await clickLink("Jump to section");
      assert.equal((await editorState()).url, urls[0]);
      for (const index of [1, 2]) {
        const label = index === 1 ? "Session B" : "Session C";
        const previousPages = await pageIds();
        await clickLink(label);
        assert.equal((await editorState()).url, urls[index - 1], "the source review stays open");
        assert.match(await chrome("snapshot"), new RegExp(`Artifact ${index === 1 ? "A" : "B"}`));
        await selectNewPage(previousPages);
        await chrome("wait", `Artifact ${index === 1 ? "B" : "C"}`);
        const state = await editorState();
        assert.equal(state.url, urls[index]);
        assert.equal(state.ready, true);
        assert.equal(state.editors, 1);
        assert.match(state.artifact, /\/artifact\/[^/]+\/index\.html\?/);
        assert.equal(state.opener, false);
        assert.doesNotMatch(state.sandbox, /allow-same-origin|allow-top-navigation/);
        await chrome("press", "Meta+i");
      }
      const previousPages = await pageIds();
      await clickLink("Local sibling");
      await chrome("wait", "Local sibling content");
      assert.deepEqual(await pageIds(), previousPages, "local documents stay in the artifact frame");
      assert.equal((await editorState()).url, urls[2]);
    } finally {
      await chrome("stop").catch(() => {});
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
