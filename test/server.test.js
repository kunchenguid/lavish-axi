import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createChromeHtml, createSdkJs, resolveArtifactAsset, serve } from "../src/server.js";

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

test("artifact SDK ignores Lavish-owned annotation UI", () => {
  const js = createSdkJs("abc");

  assert.match(js, /function isLavishUi/);
  assert.match(js, /closest\('\[data-lavish-ui\]'/);
  assert.match(js, /data-lavish-ui/);
});

test("artifact SDK isolates Lavish annotation UI in Shadow DOM", () => {
  const js = createSdkJs("abc");

  assert.match(js, /attachShadow\(\{mode:'open'\}\)/);
  assert.match(js, /:host\{all:initial/);
  assert.match(js, /lavish-annotation-root/);
});

test("annotation card does not block its own Queue button", () => {
  const js = createSdkJs("abc");

  assert.match(js, /\.lavish-send'\)\.onclick=\(\)=>/);
  assert.doesNotMatch(js, /card\.addEventListener\('click',event=>event\.stopPropagation\(\),true\)/);
});

test("annotation card labels its submit action as Queue", () => {
  const js = createSdkJs("abc");

  assert.match(js, />Queue<\/button>/);
  assert.doesNotMatch(js, /Queue Prompt/);
});

test("annotation card keeps the selected element highlighted while open", () => {
  const js = createSdkJs("abc");

  assert.match(js, /let selected=null/);
  assert.match(js, /function highlightElement/);
  assert.match(js, /if\(hovered&&hovered!==selected\)/);
});

test("annotation hover remains active while another element is selected", () => {
  const js = createSdkJs("abc");

  assert.doesNotMatch(js, /\|\|selected\)return/);
  assert.match(js, /if\(event\.target===selected\)return/);
  assert.match(js, /if\(hovered&&hovered!==selected\)clearHighlight\(hovered\)/);
});

test("annotation mode forces the artifact cursor to default", () => {
  const js = createSdkJs("abc");

  assert.match(js, /lavish-cursor-style/);
  assert.match(js, /cursor:default!important/);
  assert.match(js, /setAnnotationMode\(enabled\)/);
});

test("turning annotation mode off clears selection and floating card", () => {
  const js = createSdkJs("abc");

  assert.match(js, /if\(!annotationMode\)closeCard\(\)/);
});

test("annotation card title renders selected tag as an html element name", () => {
  const js = createSdkJs("abc");

  assert.match(js, /Annotate &lt;'/);
  assert.match(js, /'&gt;/);
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

test("annotation toggle uses a brass border when enabled", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /class="button secondary annotation-on" id="annotation"/);
  assert.match(html, /\.button\.annotation-on\{[^}]*border:1px solid var\(--accent\)/);
  assert.match(html, /classList\.toggle\('annotation-on',annotation\)/);
});

test("chrome declares the Lavish design-system tokens", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /--ink-900:#0f1115/);
  assert.match(html, /--cream-100:#f7f3ea/);
  assert.match(html, /--brass-500:#f4c95d/);
  assert.match(html, /--font-serif:/);
  assert.match(html, /--font-sans:/);
  assert.match(html, /--text-display:92px/);
  assert.match(html, /--lh-display:1/);
  assert.match(html, /--space-32:64px/);
  assert.match(html, /--shadow-floating:0 20px 70px rgba\(0,0,0,.35\)/);
  assert.match(html, /--ease:cubic-bezier\(.2,.6,.2,1\)/);
  assert.match(html, /--dur-slow:320ms/);
  assert.match(html, /--bar-h:56px/);
  assert.match(html, /--panel-w:360px/);
});

test("artifact SDK uses design-token aliases for annotation highlight and shadow UI", () => {
  const js = createSdkJs("abc");

  assert.match(js, /--lavish-accent:#f4c95d/);
  assert.match(js, /--lavish-annotate-outline:2px solid var\(--lavish-accent\)/);
  assert.match(js, /el\.style\.outline='var\(--lavish-annotate-outline,2px solid #f4c95d\)'/);
  assert.match(js, /el\.style\.outlineOffset='var\(--lavish-annotate-offset,2px\)'/);
  assert.match(js, /--fg-faint:var\(--steel-300\)/);
  assert.match(js, /textarea::placeholder\{color:var\(--fg-faint\)\}/);
  assert.doesNotMatch(js, /placeholder\{color:#aeb6c6\}/);
});

test("chrome uses the annotation outline as the keyboard focus outline", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /:focus-visible\{outline:var\(--annotate-outline\);outline-offset:var\(--annotate-offset\)/);
  assert.match(html, /--annotate-outline:2px solid var\(--accent\)/);
  assert.match(html, /--annotate-offset:2px/);
});

test("chrome keeps the editor usable on narrow screens", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /@media \(max-width:860px\)/);
  assert.match(html, /grid-template-columns:1fr/);
  assert.match(html, /grid-template-rows:minmax\(0,1fr\) min\(42vh,360px\)/);
});

test("chrome top bar follows the design mock wordmark and file treatment", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /class="brand-mark">Lavish/);
  assert.match(html, /class="brand-support">Editor/);
  assert.match(html, /font-family:var\(--font-serif\)/);
  assert.match(html, /letter-spacing:\.18em/);
  assert.match(html, /<input class="file-input" id="filePath"/);
  assert.match(html, /readonly/);
  assert.match(html, /size="18"/);
  assert.match(html, /value="\/tmp\/artifact\.html"/);
  assert.doesNotMatch(html, /class="file-icon"/);
});

test("chrome file path controls shrink-wrap and align together", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /\.file-wrap\{[^}]*align-items:center/);
  assert.match(html, /\.file-wrap\{[^}]*flex:1 1 auto/);
  assert.match(html, /\.file-input\{[^}]*width:auto/);
  assert.match(html, /\.file-input\{[^}]*max-width:100%/);
  assert.match(html, /\.file-input\{[^}]*border:1px solid var\(--border-subtle\)/);
  assert.match(html, /\.file-input\{[^}]*border-radius:var\(--radius-sm\)/);
  assert.doesNotMatch(html, /44vw/);
  assert.doesNotMatch(html, /52vw/);
});

test("chrome can copy the file path from the top bar", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /id="copyPath"/);
  assert.match(html, /Copy Path/);
  assert.match(html, /navigator\.clipboard\.writeText\(filePathInput\.value\)/);
  assert.match(html, /copyPathButton\.textContent='Copied'/);
  assert.match(html, /setTimeout\(\(\)=>\{copyPathButton\.textContent='Copy Path'\}/);
});

test("chrome centers the top bar row while bottom-aligning the identity cluster", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /\.bar\{[^}]*align-items:center/);
  assert.match(html, /\.brand\{[^}]*height:22px/);
  assert.match(html, /\.brand\{[^}]*align-items:flex-end/);
  assert.match(html, /\.file-wrap\{[^}]*height:22px/);
  assert.match(html, /\.file-wrap\{[^}]*align-items:center/);
  assert.match(html, /\.file-input\{[^}]*line-height:1/);
  assert.match(html, /\.divider\{[^}]*height:22px/);
});

test("chrome chat bubbles follow the preview mock shades", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /\.bubble\.user\{[^}]*background:var\(--bg-elevated\)/);
  assert.match(html, /\.bubble\.user\{[^}]*border-color:var\(--border-strong\)/);
  assert.match(html, /\.bubble\.agent\{[^}]*background:transparent/);
  assert.match(html, /\.bubble\.agent\{[^}]*border-color:var\(--border-subtle\)/);
  assert.match(html, /border-top-color:var\(--accent\)/);
});

test("chrome queued-prompt pills use the preview mock steel treatment", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /\.pill\{[^}]*border:1px solid var\(--border-strong\)/);
  assert.match(html, /\.pill\{[^}]*background:var\(--bg-elevated\)/);
  assert.doesNotMatch(html, /\.pill\{[^}]*var\(--amber/);
});

test("chrome includes a chat-like prompt composer and agent reply listener", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /id="chatLog"/);
  assert.match(html, /id="chatInput"/);
  assert.match(html, /agent-reply/);
});

test("chrome bootstraps persisted chat history so missed replies still appear", () => {
  const html = createChromeHtml({
    key: "abc",
    file: "/tmp/artifact.html",
    chat: [{ role: "agent", text: "Persisted reply", at: "2026-05-11T00:00:00.000Z" }],
  });

  assert.match(html, /const initialChat=/);
  assert.match(html, /Persisted reply/);
  assert.match(html, /initialChat\.forEach/);
});

test("chrome can sync persisted chat after the event stream reconnects", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /chat-sync/);
  assert.match(html, /function syncChat/);
});

test("chrome shows agent working state when no poll is active", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /agent-working/);
  assert.match(html, /Working\.\.\./);
  assert.match(html, /spinner/);
});

test("chrome disables sending while agent is working", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /let agentPolling=false/);
  assert.match(html, /sendButton\.disabled=!agentPolling/);
  assert.match(html, /if\(!agentPolling\)return/);
});

test("chrome puts queued annotations inside the chat composer as preview pills", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /id="annotationPills"/);
  assert.match(html, /class="pill/);
  assert.match(html, /pill-preview/);
  assert.match(html, /removeQueuedPrompt/);
  assert.match(html, /pill-tooltip/);
  assert.match(html, /text-overflow:ellipsis/);
  assert.doesNotMatch(html, /togglePill/);
  assert.doesNotMatch(html, /pill-detail/);
  assert.doesNotMatch(html, /<h2>Queued Annotations<\/h2>/);
});

test("chrome omits clear queue button because pills can be removed individually", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /removeQueuedPrompt/);
  assert.doesNotMatch(html, /Clear Queue/);
  assert.doesNotMatch(html, /id="clear"/);
});

test("annotation pill tooltip separates target and prompt details", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /tooltip-label/);
  assert.match(html, /Target/);
  assert.match(html, /Prompt/);
  assert.match(html, /pill-tooltip-target/);
  assert.match(html, /pill-tooltip-prompt/);
});

test("chrome inline script is valid JavaScript", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const match = html.match(/<script>([\s\S]*)<\/script>/);

  assert.ok(match);
  assert.doesNotThrow(() => new Function(match[1]));
});

test("chrome omits the extra conversation description copy", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.doesNotMatch(html, /Annotate elements in the artifact, or write a freeform message below/);
});

test("composer textarea is sized within the right panel", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /\.layout\{[^}]*min-height:0/);
  assert.match(html, /\.panel\{[^}]*min-height:0/);
  assert.match(html, /\.chat\{[^}]*min-height:0/);
  assert.match(html, /\.composer\{[^}]*min-width:0/);
  assert.match(html, /\.composer\{[^}]*flex-shrink:0/);
  assert.match(html, /\.composer textarea\{[^}]*box-sizing:border-box/);
});

test("hot reload resets iframe src instead of crossing sandbox location", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.doesNotMatch(html, /contentWindow\.location\.reload/);
  assert.match(html, /frame\.src\s*=\s*frame\.src/);
});

test("chrome ignores Lavish postMessages not sent by the artifact iframe", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /event\.source\s*!==\s*frame\.contentWindow/);
});

test("chrome waits for the replacement server before version-driven reload", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  assert.match(html, /async function reloadAfterServerRestart\(\)/);
  assert.match(html, /let sawOutage=false/);
  assert.match(html, /if\(sawOutage&&res\.ok\)\{location\.reload\(\);return\}/);
  assert.match(html, /addEventListener\('chrome-reload',\(\)=>\{reloadAfterServerRestart\(\)\}\)/);
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

test("ended session message renders centered in the main content area", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /class="ended-view"/);
  assert.match(html, /class="ended-card"/);
  assert.match(html, /\.ended-view\{[^}]*height:calc\(100vh - var\(--bar-h\)\)/);
  assert.match(html, /\.ended-view\{[^}]*place-items:center/);
  assert.match(html, /Session ended\./);
  assert.match(html, /Return to your agent to continue\./);
  assert.doesNotMatch(html, /The agent polling loop can stop\./);
  assert.doesNotMatch(html, /<span class="file">Session ended\. The agent polling loop can stop\.<\/span>/);
});
