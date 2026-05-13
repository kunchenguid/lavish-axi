import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createChromeHtml, createSdkJs, resolveArtifactAsset, serve } from "../src/server.js";

async function chromeClientSource() {
  return readFile(new URL("../src/chrome-client.js", import.meta.url), "utf8");
}

async function chromeCssSource() {
  return normalizeCssForAssertions(await readFile(new URL("../src/chrome.css", import.meta.url), "utf8"));
}

function normalizeCssForAssertions(css) {
  return css
    .replace(/\s*([{}:;,])\s*/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/0\./g, ".");
}

async function startPresenceStream(base, key) {
  const controller = new AbortController();
  const res = await fetch(`${base}/events/${key}`, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async next() {
      const deadline = Date.now() + 500;
      while (true) {
        const match = buffer.match(/^event: agent-presence\ndata: (.+)\n\n/m);
        if (match) {
          buffer = buffer.replace(match[0], "");
          return JSON.parse(match[1]).state;
        }
        const remaining = Math.max(1, deadline - Date.now());
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("timed out waiting for agent presence event")), remaining),
          ),
        ]);
        if (done) throw new Error("presence stream closed before an agent presence event");
        buffer += decoder.decode(value, { stream: true });
      }
    },
    async close() {
      controller.abort();
      await reader.cancel().catch(() => {});
    },
  };
}

test("server delegates artifact SDK generation to a dedicated source module", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");

  assert.match(source, /from "\.\/artifact-sdk\.js"/);
});

test("server serves chrome browser behavior from a dedicated source file", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(source, /chrome-client\.js/);
  assert.match(html, /<script id="lavish-session" type="application\/json">/);
  assert.match(html, /<script src="\/chrome-client\.js"><\/script>/);
  assert.doesNotMatch(html, /<script>\s*const key=/);
});

test("server serves chrome styles from a dedicated source file", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(source, /chrome\.css/);
  assert.match(html, /<link rel="stylesheet" href="\/chrome\.css">/);
  assert.doesNotMatch(html, /<style>/);
});

test("artifact assets resolve within the artifact directory", () => {
  const root = path.resolve("/tmp/lavish-artifact");

  assert.equal(resolveArtifactAsset(root, "style.css"), path.join(root, "style.css"));
  assert.equal(resolveArtifactAsset(root, "../secret.txt"), null);
});

test("chrome sandbox does not grant modal prompts", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.doesNotMatch(html, /sandbox="[^"]*allow-modals/);
});

test("artifact SDK uses a custom annotation card instead of browser prompts", () => {
  const js = createSdkJs("abc");

  assert.doesNotMatch(js, /window\.prompt/);
  assert.match(js, /lavish-annotation-card/);
  assert.match(js, /textarea/);
});

test("artifact SDK script is valid JavaScript", () => {
  const js = createSdkJs("abc");

  assert.doesNotThrow(() => new Function(js));
});

test("artifact SDK ignores Lavish-owned annotation UI", () => {
  const js = createSdkJs("abc");

  assert.match(js, /function isLavishUi/);
  assert.match(js, /closest\(["']\[data-lavish-ui\]["']\)/);
  assert.match(js, /data-lavish-ui/);
});

test("artifact SDK isolates Lavish annotation UI in Shadow DOM", () => {
  const js = createSdkJs("abc");

  assert.match(js, /attachShadow\(\{\s*mode:\s*["']open["'],?\s*\}\)/);
  assert.match(js, /:host\{all:initial/);
  assert.match(js, /lavish-annotation-root/);
});

test("annotation card does not block its own Queue button", () => {
  const js = createSdkJs("abc");

  assert.match(js, /sendButton\.onclick\s*=\s*\(\)\s*=>/);
  assert.doesNotMatch(js, /card\.addEventListener\('click',event=>event\.stopPropagation\(\),true\)/);
});

test("annotation card labels its submit action as Queue", () => {
  const js = createSdkJs("abc");

  assert.match(js, />Queue<\/button>/);
  assert.doesNotMatch(js, /Queue Prompt/);
});

test("annotation card keeps the selected element highlighted while open", () => {
  const js = createSdkJs("abc");

  assert.match(js, /let selected\s*=\s*null/);
  assert.match(js, /function highlightElement/);
  assert.match(js, /if \(hovered && hovered !== selected\)/);
});

test("artifact SDK can annotate selected text ranges with stable anchors", () => {
  const js = createSdkJs("abc");

  assert.match(js, /document\.getSelection\(\)/);
  assert.match(js, /function textSelectionContext/);
  assert.match(js, /type:\s*["']text-range["']/);
  assert.match(js, /start:\s*rangeBoundary\(range\.startContainer, range\.startOffset\)/);
  assert.match(js, /end:\s*rangeBoundary\(range\.endContainer, range\.endOffset\)/);
  assert.match(js, /commonAncestorSelector/);
});

test("annotation hover remains active while another element is selected", () => {
  const js = createSdkJs("abc");

  assert.doesNotMatch(js, /\|\|selected\)return/);
  assert.match(js, /if \(event\.target === selected\) return/);
  assert.match(js, /if \(hovered && hovered !== selected\) clearHighlight\(hovered\)/);
});

test("annotation mode forces the artifact cursor to default", () => {
  const js = createSdkJs("abc");

  assert.match(js, /lavish-cursor-style/);
  assert.match(js, /cursor:default!important/);
  assert.match(js, /setAnnotationMode\(enabled\)/);
});

test("artifact SDK lets marked feedback controls handle their own clicks", () => {
  const js = createSdkJs("abc");

  assert.match(js, /function isLavishAction/);
  assert.match(js, /closest\(["']\[data-lavish-action\]["']\)/);
  assert.match(js, /isLavishAction\(event\.target\)/);
  assert.match(js, /\[data-lavish-action\],[^{}]*\[data-lavish-action\] \*\{cursor:pointer!important\}/);
});

test("turning annotation mode off clears selection and floating card", () => {
  const js = createSdkJs("abc");

  assert.match(js, /if \(!annotationMode\) closeCard\(\)/);
});

test("annotation card title renders selected tag as an html element name", () => {
  const js = createSdkJs("abc");

  assert.match(js, /"Annotate &lt;" \+ c\.tag \+ "&gt;"/);
});

test("annotation card shadow styles use Lavish design-system variables", () => {
  const js = createSdkJs("abc");

  assert.match(js, /--ink-900:#0f1115/);
  assert.match(js, /--accent:#f4c95d/);
  assert.match(js, /--font-sans:/);
  assert.match(js, /font-family:var\(--font-sans\)/);
  assert.match(js, /:focus-visible\{outline:2px solid var\(--accent\);outline-offset:2px/);
});

test("chrome labels the mode as annotation instead of inspect", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /Annotation: On/);
  assert.doesNotMatch(html, /Inspect/);
});

test("annotation toggle uses a brass border when enabled", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const js = await chromeClientSource();
  const css = await chromeCssSource();

  assert.match(html, /class="button secondary annotation-on" id="annotation"/);
  assert.match(css, /\.button\.annotation-on\{[^}]*border:1px solid var\(--accent\)/);
  assert.match(js, /classList\.toggle\("annotation-on", annotation\)/);
});

test("chrome declares the Lavish design-system tokens", async () => {
  const css = await chromeCssSource();

  assert.match(css, /--ink-900:#0f1115/);
  assert.match(css, /--cream-100:#f7f3ea/);
  assert.match(css, /--brass-500:#f4c95d/);
  assert.match(css, /--font-serif:/);
  assert.match(css, /--font-sans:/);
  assert.match(css, /--text-display:92px/);
  assert.match(css, /--lh-display:1/);
  assert.match(css, /--space-32:64px/);
  assert.match(css, /--shadow-floating:0 20px 70px rgba\(0,0,0,.35\)/);
  assert.match(css, /--ease:cubic-bezier\(.2,.6,.2,1\)/);
  assert.match(css, /--dur-slow:320ms/);
  assert.match(css, /--bar-h:56px/);
  assert.match(css, /--panel-w:360px/);
});

test("artifact SDK uses design-token aliases for annotation highlight and shadow UI", () => {
  const js = createSdkJs("abc");

  assert.match(js, /--lavish-accent:#f4c95d/);
  assert.match(js, /--lavish-annotate-outline:2px solid var\(--lavish-accent\)/);
  assert.match(js, /el\.style\.outline\s*=\s*["']var\(--lavish-annotate-outline,2px solid #f4c95d\)["']/);
  assert.match(js, /el\.style\.outlineOffset\s*=\s*["']var\(--lavish-annotate-offset,2px\)["']/);
  assert.match(js, /--fg-faint:var\(--steel-300\)/);
  assert.match(js, /textarea::placeholder\{color:var\(--fg-faint\)\}/);
  assert.doesNotMatch(js, /placeholder\{color:#aeb6c6\}/);
});

test("chrome uses the annotation outline as the keyboard focus outline", async () => {
  const css = await chromeCssSource();

  assert.match(css, /:focus-visible\{outline:var\(--annotate-outline\);outline-offset:var\(--annotate-offset\)/);
  assert.match(css, /--annotate-outline:2px solid var\(--accent\)/);
  assert.match(css, /--annotate-offset:2px/);
});

test("chrome keeps the editor usable on narrow screens", async () => {
  const css = await chromeCssSource();

  assert.match(css, /@media \(max-width:860px\)/);
  assert.match(css, /grid-template-columns:1fr/);
  assert.match(css, /grid-template-rows:minmax\(0,1fr\) min\(42vh,360px\)/);
});

test("chrome top bar follows the design mock wordmark and file treatment", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const css = await chromeCssSource();

  assert.match(html, /class="brand-mark">Lavish/);
  assert.match(html, /class="brand-support">Editor/);
  assert.match(css, /font-family:var\(--font-serif\)/);
  assert.match(css, /letter-spacing:\.18em/);
  assert.match(html, /<input class="file-input" id="filePath"/);
  assert.match(html, /readonly/);
  assert.match(html, /size="18"/);
  assert.match(html, /value="\/tmp\/artifact\.html"/);
  assert.doesNotMatch(html, /class="file-icon"/);
});

test("chrome file path controls shrink-wrap and align together", async () => {
  const css = await chromeCssSource();

  assert.match(css, /\.file-wrap\{[^}]*align-items:center/);
  assert.match(css, /\.file-wrap\{[^}]*flex:1 1 auto/);
  assert.match(css, /\.file-input\{[^}]*width:auto/);
  assert.match(css, /\.file-input\{[^}]*max-width:100%/);
  assert.match(css, /\.file-input\{[^}]*border:1px solid var\(--border-subtle\)/);
  assert.match(css, /\.file-input\{[^}]*border-radius:var\(--radius-sm\)/);
  assert.doesNotMatch(css, /44vw/);
  assert.doesNotMatch(css, /52vw/);
});

test("chrome can copy the file path from the top bar", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const js = await chromeClientSource();

  assert.match(html, /id="copyPath"/);
  assert.match(html, /Copy Path/);
  assert.match(js, /navigator\.clipboard\.writeText\(filePathInput\.value\)/);
  assert.match(js, /copyPathButton\.textContent = "Copied"/);
  assert.match(js, /copyPathButton\.textContent = "Copy Path"/);
});

test("chrome centers the top bar row while bottom-aligning the identity cluster", async () => {
  const css = await chromeCssSource();

  assert.match(css, /\.bar\{[^}]*align-items:center/);
  assert.match(css, /\.brand\{[^}]*height:22px/);
  assert.match(css, /\.brand\{[^}]*align-items:flex-end/);
  assert.match(css, /\.file-wrap\{[^}]*height:22px/);
  assert.match(css, /\.file-wrap\{[^}]*align-items:center/);
  assert.match(css, /\.file-input\{[^}]*line-height:1/);
  assert.match(css, /\.divider\{[^}]*height:22px/);
});

test("chrome chat bubbles follow the preview mock shades", async () => {
  const css = await chromeCssSource();

  assert.match(css, /\.bubble\.user\{[^}]*background:var\(--bg-elevated\)/);
  assert.match(css, /\.bubble\.user\{[^}]*border-color:var\(--border-strong\)/);
  assert.match(css, /\.bubble\.agent\{[^}]*background:transparent/);
  assert.match(css, /\.bubble\.agent\{[^}]*border-color:var\(--border-subtle\)/);
  assert.match(css, /border-top-color:var\(--accent\)/);
});

test("chrome queued-prompt pills use the preview mock steel treatment", async () => {
  const css = await chromeCssSource();

  assert.match(css, /\.pill\{[^}]*border:1px solid var\(--border-strong\)/);
  assert.match(css, /\.pill\{[^}]*background:var\(--bg-elevated\)/);
  assert.doesNotMatch(css, /\.pill\{[^}]*var\(--amber/);
});

test("chrome includes a chat-like prompt composer and agent reply listener", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const js = await chromeClientSource();

  assert.match(html, /id="chatLog"/);
  assert.match(html, /id="chatInput"/);
  assert.match(js, /agent-reply/);
});

test("chrome bootstraps persisted chat history so missed replies still appear", () => {
  const html = createChromeHtml({
    key: "abc",
    file: "/tmp/artifact.html",
    chat: [{ role: "agent", text: "Persisted reply", at: "2026-05-11T00:00:00.000Z" }],
  });

  assert.match(html, /"initialChat":/);
  assert.match(html, /Persisted reply/);
});

test("chrome client renders persisted chat history", async () => {
  const js = await chromeClientSource();

  assert.match(js, /initialChat\.forEach/);
});

test("chrome can sync persisted chat after the event stream reconnects", async () => {
  const js = await chromeClientSource();

  assert.match(js, /chat-sync/);
  assert.match(js, /function syncChat/);
});

test("chrome shows agent working state when a previous poll has released", async () => {
  const js = await chromeClientSource();

  assert.match(js, /agent-presence/);
  assert.match(js, /Working\.\.\./);
  assert.match(js, /spinner/);
});

test("chrome disables sending while agent is working but allows it while waiting or listening", async () => {
  const js = await chromeClientSource();

  assert.match(js, /let agentPresence = "waiting"/);
  assert.match(js, /sendButton\.disabled = agentPresence === "working"/);
  assert.match(js, /if \(agentPresence === "working"\) return/);
});

test("chrome shows a waiting banner when no agent has attached", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const js = await chromeClientSource();
  const css = await chromeCssSource();

  assert.match(html, /id="presenceBanner"/);
  assert.match(html, /Your agent is not listening/);
  assert.match(js, /presenceBanner\.hidden = agentPresence !== "waiting"/);
  assert.match(css, /\.presence-banner\{/);
});

test("chrome puts queued annotations inside the chat composer as preview pills", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const js = await chromeClientSource();
  const css = await chromeCssSource();

  assert.match(html, /id="annotationPills"/);
  assert.match(js, /class="pill/);
  assert.match(js, /pill-preview/);
  assert.match(js, /removeQueuedPrompt/);
  assert.match(js, /pill-tooltip/);
  assert.match(css, /text-overflow:ellipsis/);
  assert.doesNotMatch(js, /togglePill/);
  assert.doesNotMatch(js, /pill-detail/);
  assert.doesNotMatch(html, /<h2>Queued Annotations<\/h2>/);
});

test("chrome omits clear queue button because pills can be removed individually", async () => {
  const js = await chromeClientSource();

  assert.match(js, /removeQueuedPrompt/);
  assert.doesNotMatch(js, /Clear Queue/);
  assert.doesNotMatch(js, /id="clear"/);
});

test("annotation pill tooltip separates target and prompt details", async () => {
  const js = await chromeClientSource();

  assert.match(js, /tooltip-label/);
  assert.match(js, /Target/);
  assert.match(js, /Prompt/);
  assert.match(js, /pill-tooltip-target/);
  assert.match(js, /pill-tooltip-prompt/);
});

test("chrome client script is valid JavaScript", async () => {
  const js = await chromeClientSource();

  assert.doesNotThrow(() => new Function(js));
});

test("chrome omits the extra conversation description copy", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.doesNotMatch(html, /Annotate elements in the artifact, or write a freeform message below/);
});

test("composer textarea is sized within the right panel", async () => {
  const css = await chromeCssSource();

  assert.match(css, /\.layout\{[^}]*min-height:0/);
  assert.match(css, /\.panel\{[^}]*min-height:0/);
  assert.match(css, /\.chat\{[^}]*min-height:0/);
  assert.match(css, /\.composer\{[^}]*min-width:0/);
  assert.match(css, /\.composer\{[^}]*flex-shrink:0/);
  assert.match(css, /\.composer textarea\{[^}]*box-sizing:border-box/);
});

test("hot reload resets iframe src instead of crossing sandbox location", async () => {
  const js = await chromeClientSource();

  assert.doesNotMatch(js, /contentWindow\.location\.reload/);
  assert.match(js, /frame\.src\s*=\s*frame\.src/);
});

test("chrome ignores Lavish postMessages not sent by the artifact iframe", async () => {
  const js = await chromeClientSource();

  assert.match(js, /event\.source\s*!==\s*frame\.contentWindow/);
});

test("chrome waits for the replacement server before version-driven reload", async () => {
  const js = await chromeClientSource();

  assert.match(js, /async function reloadAfterServerRestart\(\)/);
  assert.match(js, /let sawOutage = false/);
  assert.match(js, /if \(sawOutage && res\.ok\) \{/);
  assert.match(js, /addEventListener\("chrome-reload", \(\) => reloadAfterServerRestart\(\)\)/);
});

test("/health reports the server version so clients can detect upgrades", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.version, "9.9.9-test");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("/chrome-client.js serves the extracted chrome client script", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/chrome-client.js`);
    const body = await res.text();

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/javascript/);
    assert.match(body, /const sessionData/);
    assert.match(body, /new EventSource\("\/events\/" \+ key\)/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("/chrome.css serves the extracted chrome stylesheet", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/chrome.css`);
    const body = await res.text();

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/css/);
    assert.match(normalizeCssForAssertions(body), /--ink-900:#0f1115/);
    assert.match(
      normalizeCssForAssertions(body),
      /\.layout\{[^}]*grid-template-columns:minmax\(0,1fr\) ?var\(--panel-w\)/,
    );
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("/design serves local Tailwind and DaisyUI artifact assets", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const daisy = await fetch(`${base}/design/daisyui.css`);
    const tailwind = await fetch(`${base}/design/tailwindcss-browser.js`);
    const themes = await fetch(`${base}/design/daisyui-themes.css`);

    assert.equal(daisy.status, 200);
    assert.match(daisy.headers.get("content-type") || "", /text\/css/);
    assert.match(await daisy.text(), /\.btn/);
    assert.equal(tailwind.status, 200);
    assert.match(tailwind.headers.get("content-type") || "", /application\/javascript/);
    assert.match(await tailwind.text(), /tailwind/i);
    assert.equal(themes.status, 200);
    assert.match(themes.headers.get("content-type") || "", /text\/css/);
    assert.match(await themes.text(), /luxury/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /shutdown stops the listener so the client can spawn a fresh server", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/shutdown`, { method: "POST" });
    assert.equal(res.status, 200);
    await server.done;
    await assert.rejects(() => fetch(`http://127.0.0.1:${server.port}/health`), /fetch failed|ECONNREFUSED/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SSE agent-presence reflects waiting, listening, and working transitions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await (await import("node:fs/promises")).writeFile(artifact, "<!doctype html><html><body></body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const open = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const { key } = await open.json();

    const presenceEvents = [];
    const presenceWaiters = [];
    const presenceController = new AbortController();
    const presenceFetch = fetch(`${base}/events/${key}`, { signal: presenceController.signal }).then(async (res) => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let lines;
        while ((lines = buffer.match(/^event: agent-presence\ndata: (.+)\n\n/m))) {
          const data = JSON.parse(lines[1]);
          presenceEvents.push(data.state);
          buffer = buffer.replace(lines[0], "");
          const waiter = presenceWaiters.shift();
          if (waiter) waiter(data.state);
        }
      }
    });
    presenceFetch.catch(() => {});

    const waitForPresence = () =>
      new Promise((resolve) => {
        if (presenceEvents.length > waitForPresence.lastIndex) {
          waitForPresence.lastIndex++;
          resolve(presenceEvents[waitForPresence.lastIndex - 1]);
          return;
        }
        presenceWaiters.push((state) => {
          waitForPresence.lastIndex = presenceEvents.length;
          resolve(state);
        });
      });
    waitForPresence.lastIndex = 0;

    const initial = await waitForPresence();
    assert.equal(initial, "waiting", "first SSE handshake should report waiting before any poll");

    const pollPromise = fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}`);
    const listening = await waitForPresence();
    assert.equal(listening, "listening", "should switch to listening when poll attaches");

    await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompts: [{ prompt: "hello", tag: "message" }] }),
    });
    await pollPromise;

    const working = await waitForPresence();
    assert.equal(working, "working", "should switch to working when poll releases after at least one attach");

    presenceController.abort();
    await presenceFetch.catch(() => {});
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SSE handshake reports waiting on a fresh session that never had a poll", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await (await import("node:fs/promises")).writeFile(artifact, "<!doctype html><html><body></body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const open = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const { key } = await open.json();

    const controller = new AbortController();
    const res = await fetch(`${base}/events/${key}`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let state = null;
    while (state === null) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const match = buffer.match(/^event: agent-presence\ndata: (.+)\n\n/m);
      if (match) state = JSON.parse(match[1]).state;
    }
    controller.abort();
    assert.equal(state, "waiting");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SSE agent-presence returns to waiting when a poll times out without feedback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const open = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const { key } = await open.json();
    const presence = await startPresenceStream(base, key);
    try {
      assert.equal(await presence.next(), "waiting");

      const poll = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=1`);
      assert.deepEqual(await poll.json(), { status: "waiting" });

      assert.equal(await presence.next(), "listening");
      assert.equal(await presence.next(), "waiting");
    } finally {
      await presence.close();
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SSE agent-presence returns to waiting when a poll disconnects without feedback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const open = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const { key } = await open.json();
    const presence = await startPresenceStream(base, key);
    try {
      assert.equal(await presence.next(), "waiting");

      const pollController = new AbortController();
      const poll = fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}`, { signal: pollController.signal });
      assert.equal(await presence.next(), "listening");
      pollController.abort();
      await poll.catch(() => {});

      assert.equal(await presence.next(), "waiting");
    } finally {
      await presence.close();
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SSE agent-presence returns to waiting when poll feedback storage fails", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  const stateFile = path.join(dir, "state.json");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  const server = await serve({ port: 0, stateFile, version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const open = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const { key } = await open.json();
    const presence = await startPresenceStream(base, key);
    try {
      assert.equal(await presence.next(), "waiting");

      const poll = fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=10`);
      assert.equal(await presence.next(), "listening");

      await writeFile(stateFile, "not json");
      const pollResult = await poll;
      assert.equal(pollResult.status, 500);

      assert.equal(await presence.next(), "waiting");
    } finally {
      await presence.close();
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("long-poll response cleanup is guarded against storage failures", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");

  assert.match(source, /try \{\s*const result = await store\.takeFeedback\(key\)/);
  assert.match(source, /finally \{\s*cleanup\(\);\s*\}/);
});

test("SSE agent-presence switches to working when poll immediately takes queued feedback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await (await import("node:fs/promises")).writeFile(artifact, "<!doctype html><html><body></body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const open = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const { key } = await open.json();

    const presenceEvents = [];
    const presenceWaiters = [];
    const presenceController = new AbortController();
    const presenceFetch = fetch(`${base}/events/${key}`, { signal: presenceController.signal }).then(async (res) => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let lines;
        while ((lines = buffer.match(/^event: agent-presence\ndata: (.+)\n\n/m))) {
          const data = JSON.parse(lines[1]);
          presenceEvents.push(data.state);
          buffer = buffer.replace(lines[0], "");
          const waiter = presenceWaiters.shift();
          if (waiter) waiter(data.state);
        }
      }
    });
    presenceFetch.catch(() => {});

    const waitForPresence = () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for agent presence event")), 500);
        if (presenceEvents.length > waitForPresence.lastIndex) {
          waitForPresence.lastIndex++;
          clearTimeout(timer);
          resolve(presenceEvents[waitForPresence.lastIndex - 1]);
          return;
        }
        presenceWaiters.push((state) => {
          waitForPresence.lastIndex = presenceEvents.length;
          clearTimeout(timer);
          resolve(state);
        });
      });
    waitForPresence.lastIndex = 0;

    const initial = await waitForPresence();
    assert.equal(initial, "waiting");

    await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompts: [{ prompt: "hello", tag: "message" }] }),
    });
    await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}`);

    const working = await waitForPresence();
    assert.equal(working, "working");

    presenceController.abort();
    await presenceFetch.catch(() => {});
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SSE agent-presence resets to waiting after ending and reopening a session", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const open = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const { key } = await open.json();
    const presence = await startPresenceStream(base, key);
    try {
      assert.equal(await presence.next(), "waiting");

      await fetch(`${base}/api/${key}/prompts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompts: [{ prompt: "hello", tag: "message" }] }),
      });
      await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}`);
      assert.equal(await presence.next(), "working");

      await fetch(`${base}/api/${key}/end`, { method: "POST" });
      await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: artifact }),
      });
    } finally {
      await presence.close();
    }

    const reopenedPresence = await startPresenceStream(base, key);
    try {
      assert.equal(await reopenedPresence.next(), "waiting");
    } finally {
      await reopenedPresence.close();
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SSE agent-presence stays working when resuming an open session", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const open = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const { key } = await open.json();

    await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompts: [{ prompt: "hello", tag: "message" }] }),
    });
    await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}`);

    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });

    const presence = await startPresenceStream(base, key);
    try {
      assert.equal(await presence.next(), "working");
    } finally {
      await presence.close();
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ended session message renders centered in the main content area", async () => {
  const js = await chromeClientSource();
  const css = await chromeCssSource();

  assert.match(js, /class="ended-view"/);
  assert.match(js, /class="ended-card"/);
  assert.match(css, /\.ended-view\{[^}]*height:calc\(100vh - var\(--bar-h\)\)/);
  assert.match(css, /\.ended-view\{[^}]*place-items:center/);
  assert.match(js, /Session ended\./);
  assert.match(js, /Return to your agent to continue\./);
  assert.doesNotMatch(js, /The agent polling loop can stop\./);
  assert.doesNotMatch(js, /<span class="file">Session ended\. The agent polling loop can stop\.<\/span>/);
});
