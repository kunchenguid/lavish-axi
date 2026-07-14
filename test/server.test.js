import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import {
  createChromeHtml,
  createSdkJs,
  displayPathParts,
  exportContentDisposition,
  extractArtifactHead,
  hasLiveReloadRootOptIn,
  resolveArtifactAsset,
  resolveDesignAssetPath,
  resolveIdleTimeoutMs,
  resolveWatchTarget,
  serve,
} from "../src/server.js";
import { canonicalFile, sessionKey } from "../src/session-store.js";

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

test("export content disposition uses a safe fallback and encoded UTF-8 filename", () => {
  assert.equal(
    exportContentDisposition('/tmp/résumé "draft"\n.html'),
    "attachment; filename=\"r_sum_ _draft__.export.html\"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22draft%22%0A.export.html",
  );
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
  assert.match(js, /if \(target === selected\) return/);
  assert.match(js, /if \(hovered && hovered !== selected\) clearHighlight\(hovered\)/);
});

test("artifact SDK injects every shared mermaid node helper as a same-scope const", () => {
  const js = createSdkJs("abc");

  for (const name of ["isMermaidSvg", "readNodeLabel", "mermaidNodeElement", "mermaidNodeFrom"]) {
    assert.match(js, new RegExp(`const ${name}=`));
  }
  // mermaidNodeFrom calls mermaidNodeElement, so the resolver must reach the
  // SDK's mermaidHelpers bundle or the browser would ReferenceError on click.
  assert.match(js, /const mermaidHelpers=\{[^}]*mermaidNodeElement[^}]*\}/);
});

test("annotation hover and click resolve to the same Mermaid node element", () => {
  const js = createSdkJs("abc");

  assert.match(js, /function annotationTargetEl/);
  assert.match(js, /mermaidNodeElement\(el\) \|\| el/);
  assert.match(js, /hovered = target/);
  assert.match(js, /anchor = annotationTargetEl\(target\)/);
});

test("annotation mode forces the artifact cursor to default", () => {
  const js = createSdkJs("abc");

  assert.match(js, /lavish-cursor-style/);
  assert.match(js, /cursor:default!important/);
  assert.match(js, /setAnnotationMode\(enabled\)/);
});

test("artifact SDK registers a capture-phase document keydown listener for the mode toggle hotkey", () => {
  const js = createSdkJs("abc");

  assert.match(js, /const MODE_TOGGLE_HOTKEY_KEY="i"/);
  assert.match(js, /function isModeToggleHotkeyEvent\(event\)/);
  assert.match(js, /if \(!isModeToggleHotkeyEvent\(event\)\) return;/);
  assert.match(js, /parent\.postMessage\(\{ type: "lavish:toggleAnnotationMode" \}, "\*"\);/);
  // Registered with the capture flag so it fires regardless of where focus is inside the
  // sandboxed artifact document, without a duplicate call sneaking in un-captured.
  assert.match(
    js,
    /document\.addEventListener\(\s*"keydown",\s*\(event\) => \{\s*if \(!isModeToggleHotkeyEvent\(event\)\) return;\s*event\.preventDefault\(\);\s*parent\.postMessage\(\{ type: "lavish:toggleAnnotationMode" \}, "\*"\);\s*\},\s*true,?\s*\);/,
  );
});

test("chrome client toggles annotation mode via Cmd/Ctrl+I and on request from the artifact SDK", async () => {
  const js = await chromeClientSource();

  assert.match(
    js,
    /const MODE_TOGGLE_HOTKEY_KEY = String\(sessionData\.modeToggleHotkeyKey \|\| ""\)\.toLowerCase\(\);/,
  );
  assert.doesNotMatch(js, /const MODE_TOGGLE_HOTKEY_KEY = "i";/);
  assert.match(js, /function isModeToggleHotkeyEvent\(event\)/);
  assert.match(js, /function toggleAnnotationMode\(\)/);
  assert.match(js, /annotationSwitch\.onclick = toggleAnnotationMode;/);
  assert.match(js, /if \(msg\.type === "lavish:toggleAnnotationMode"\) toggleAnnotationMode\(\);/);
  assert.match(
    js,
    /document\.addEventListener\(\s*"keydown",\s*\(event\) => \{\s*if \(!isModeToggleHotkeyEvent\(event\)\) return;\s*event\.preventDefault\(\);\s*toggleAnnotationMode\(\);\s*\},\s*true,?\s*\);/,
  );
});

test("the annotate switch exposes the mode toggle hotkey as a discoverable tooltip", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /"modeToggleHotkeyKey":"i"/);
  assert.match(html, /id="annotation"[^>]*title="Toggle annotate\/explore mode \(⌘I \/ Ctrl\+I\)"/);
});

test("artifact SDK lets marked feedback controls handle their own clicks", () => {
  const js = createSdkJs("abc");

  assert.match(js, /function isLavishAction/);
  assert.match(js, /closest\(["']\[data-lavish-action\]["']\)/);
  assert.match(js, /isLavishAction\(event\.target\)/);
  assert.match(js, /\[data-lavish-action\],[^{}]*\[data-lavish-action\] \*\{cursor:pointer!important\}/);
});

test("artifact SDK lets native form controls handle their own clicks", () => {
  const js = createSdkJs("abc");

  assert.match(js, /function isInteractiveControl/);
  assert.match(js, /button,input,select,textarea/);
  assert.match(js, /isInteractiveControl\(event\.target\)/);
});

test("artifact SDK lets disclosure controls handle their own clicks", () => {
  const js = createSdkJs("abc");
  const nativeInteractive = js.slice(
    js.indexOf("function isNativeInteractiveControl"),
    js.indexOf("function createArtifactSdk"),
  );
  const clickHandler = js.slice(js.indexOf('"click"'), js.indexOf("setAnnotationMode", js.indexOf('"click"')));

  assert.match(js, /button,input,select,textarea,option,optgroup,label,summary,\[contenteditable\]/);
  assert.doesNotMatch(js, /summary,details,\[contenteditable\]/);
  assert.doesNotMatch(nativeInteractive, /matches\(["']details["']\)/);
  assert.match(js, /isInteractiveControl\(event\.target\)/);
  assert.doesNotMatch(clickHandler, /isDirectDetailsElement\(event\.target\)/);
  assert.doesNotMatch(js, /function isDirectDetailsElement/);
});

test("artifact SDK does not annotate text selected inside native controls", () => {
  const js = createSdkJs("abc");

  assert.match(js, /isInteractiveControl\(ancestor\)/);
});

test("artifact SDK shows native cursors on form controls in annotation mode", () => {
  const js = createSdkJs("abc");

  assert.match(js, /input,textarea,\[contenteditable\][^{]*\{cursor:text!important\}/);
  assert.match(js, /input\[type='checkbox'\]/);
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

test("chrome top bar uses an Annotate switch instead of a labeled toggle button", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /class="annotate-switch" id="annotation"[^>]*aria-pressed="true"/);
  assert.match(html, /class="switch-track"/);
  assert.match(html, />Annotate</);
  assert.doesNotMatch(html, /Annotation: On/);
  assert.doesNotMatch(html, /Inspect/);
});

test("annotate switch shows a brass track and ink knob when enabled", async () => {
  const js = await chromeClientSource();
  const css = await chromeCssSource();

  assert.match(css, /\.annotate-switch\[aria-pressed="true"\] \.switch-track\{background:var\(--accent\)/);
  assert.match(css, /\.annotate-switch\[aria-pressed="true"\] \.switch-knob\{[^}]*background:var\(--accent-ink\)/);
  assert.match(js, /annotationSwitch\.setAttribute\("aria-pressed", String\(annotation\)\)/);
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

test("chrome top bar follows the design mock wordmark and overflow menu treatment", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const css = await chromeCssSource();

  assert.match(html, /class="brand-mark">Lavish/);
  assert.match(html, /class="brand-support">Editor/);
  assert.match(css, /font-family:var\(--font-serif\)/);
  assert.match(css, /letter-spacing:\.18em/);
  assert.match(html, /class="more-button" id="moreButton"/);
  assert.match(html, /class="menu more-menu" id="moreMenu" hidden/);
  assert.doesNotMatch(html, /class="file-input"/);
  assert.doesNotMatch(html, /class="divider"/);
  assert.doesNotMatch(html, /class="file-icon"/);
});

test("overflow menu shows the artifact path with a copy affordance", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact/index.html" });
  const css = await chromeCssSource();

  assert.match(html, /class="menu-label">Editing</);
  assert.match(html, /class="menu-file" id="copyPath"[^>]*title="Copy path · \/tmp\/artifact\/index\.html"/);
  assert.match(html, /class="copy-hint"/);
  assert.match(css, /\.menu-file\{[^}]*font-family:var\(--font-mono\)/);
  assert.match(css, /\.copy-hint\.copied\{color:var\(--accent-hover\)/);
});

test("overflow menu path keeps the file name visible and elides the directories", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact/index.html" });
  const css = await chromeCssSource();

  assert.match(html, /class="path-head">\/tmp\/artifact\/</);
  assert.match(html, /class="path-tail">index\.html</);
  assert.match(css, /\.path-head\{[^}]*text-overflow:ellipsis/);
  assert.match(css, /\.path-head\{[^}]*min-width:0/);
  assert.match(css, /\.path-tail\{[^}]*flex:0 0 auto/);
  assert.match(css, /\.path-tail\{[^}]*max-width:100%/);
});

test("overflow menu path shortens the home directory to a tilde", () => {
  const home = homedir();
  const file = path.join(home, "projects", "demo", "artifact.html");
  const html = createChromeHtml({ key: "abc", file });

  assert.match(html, /class="path-head">~\/projects\/demo\/</);
  assert.match(html, /class="path-tail">artifact\.html</);
  // The copy affordance still carries the absolute path.
  assert.ok(html.includes(`title="Copy path · ${file}"`));
});

test("overflow menu path display tolerates Windows separators", () => {
  assert.deepEqual(
    displayPathParts("C:\\Users\\runneradmin\\projects\\demo\\artifact.html", "C:\\Users\\runneradmin"),
    { head: "~/projects/demo/", tail: "artifact.html" },
  );
});

test("chrome can copy the full file path from the overflow menu", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const js = await chromeClientSource();

  assert.match(html, /"file":"\/tmp\/artifact\.html"/);
  assert.match(js, /const filePath = String\(sessionData\.file \|\| ""\)/);
  assert.match(js, /copyText\(filePath\)/);
  assert.match(js, /copyHintText\.textContent = "Copied"/);
  assert.match(js, /copyHintText\.textContent = "Copy"/);
});

test("overflow menu offers reload, snapshot copy, and end session actions", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const js = await chromeClientSource();

  assert.match(html, /id="reloadArtifact"[^<]*>.*Reload artifact/);
  assert.match(html, /id="copySnapshot"[^<]*>.*Copy DOM snapshot/);
  assert.match(html, /class="menu-item danger" id="end"[^<]*>.*End session/);
  assert.doesNotMatch(html, /End Session</);
  assert.match(js, /event\.key === "Escape"/);
});

test("overflow menu offers a standalone HTML export that downloads a portable file", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const js = await chromeClientSource();

  assert.match(html, /id="exportArtifact"[^<]*>.*Export standalone HTML/);
  assert.match(js, /const exportArtifactButton/);
  assert.match(js, /async function exportArtifact/);
  assert.match(js, /fetch\("\/api\/" \+ key \+ "\/export"\)/);
  assert.match(js, /link\.download = exportFileName\(\)/);
  assert.match(js, /exportArtifactButton\.onclick = exportArtifact/);
});

test("overflow menu offers publishing an ht-ml.app link via a share dialog", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const js = await chromeClientSource();
  const css = await chromeCssSource();

  assert.match(html, /id="shareArtifact"[^<]*>.*Publish link/);
  assert.match(html, /id="shareDialog"/);
  assert.match(
    html,
    /Publish to <a class="share-link" href="https:\/\/ht-ml\.app" target="_blank" rel="noopener noreferrer">ht-ml\.app<\/a>/,
  );
  assert.match(html, /third-party hosting service, not part of Lavish/);
  assert.match(html, /id="sharePassword"/);
  assert.match(html, /id="shareUpdateKey"/);
  assert.match(html, /Without a password, the page is PUBLIC/);
  assert.match(html, /With a password, the page is PRIVATE/);
  assert.doesNotMatch(html, /Everything published is public/);
  assert.doesNotMatch(html, /Get a public link/);
  assert.match(css, /\.share-overlay/);
  assert.match(css, /\.share-overlay\{[^}]*z-index:80;/);
  assert.match(css, /\.share-card/);
  assert.match(css, /\.share-link/);
  assert.match(css, /box-shadow:var\(--shadow-floating\)/);
  // The codebase has no global [hidden] rule, so display-setting overlays need explicit
  // [hidden] rules or they show through before they should (e.g. the result block).
  assert.match(css, /\.share-overlay\[hidden\]\{display:none;?\}/);
  assert.match(css, /\.share-result\[hidden\]\{display:none;?\}/);
  assert.match(js, /const shareArtifactButton/);
  assert.match(js, /async function publishShare/);
  assert.match(js, /fetch\("\/api\/" \+ key \+ "\/share"/);
  assert.match(js, /shareUrlInput\.value = data\.url/);
  assert.match(js, /shareUpdateKeyInput\.value = data\.update_key/);
});

test("copy DOM snapshot requests a fresh snapshot and copies it to the clipboard", async () => {
  const js = await chromeClientSource();

  assert.match(js, /const snapshotRequests = \[\]/);
  assert.match(js, /requestSnapshot\("copy"\)/);
  assert.match(js, /const snapshotAction = snapshotRequests\.shift\(\) \|\| "submit"/);
  assert.match(js, /if \(snapshotAction === "copy"\)/);
  assert.match(js, /copyText\(msg\.snapshot \|\| ""\)/);
});

test("clipboard copy falls back when navigator clipboard rejects", async () => {
  const js = await chromeClientSource();

  assert.match(js, /async function copyText\(text\)/);
  assert.match(js, /await navigator\.clipboard\.writeText\(text\)/);
  assert.match(js, /document\.execCommand\("copy"\)/);
  assert.doesNotMatch(js, /navigator\.clipboard\.writeText\(text\)\.catch/);
});

test("chrome centers the top bar row while bottom-aligning the identity cluster", async () => {
  const css = await chromeCssSource();

  assert.match(css, /\.bar\{[^}]*align-items:center/);
  assert.match(css, /\.brand\{[^}]*height:22px/);
  assert.match(css, /\.brand\{[^}]*align-items:flex-end/);
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
  const css = await chromeCssSource();
  assert.match(css, /\.chat:empty::before\{/);
  assert.match(css, /Agent hasn't sent a message yet/);
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

test("chrome disables sending only while working or ended", async () => {
  const js = await chromeClientSource();

  assert.match(js, /let agentPresence = "waiting"/);
  assert.match(js, /function updateSendState\(\)/);
  assert.match(js, /sendButton\.disabled = ended \|\| agentPresence === "working"/);
  assert.match(js, /sendAndEndButton\.disabled = sendButton\.disabled/);
  assert.doesNotMatch(js, /hasContent/);
});

test("sending with an empty composer nudges instead of blocking", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const js = await chromeClientSource();
  const css = await chromeCssSource();

  assert.match(html, /class="send-hint" id="sendHint" hidden>Write a message or annotate an element first\.<\/div>/);
  assert.match(js, /function showSendHint\(\)/);
  assert.match(js, /sendHint\.hidden = false/);
  assert.match(js, /chatInput\.focus\(\)/);
  assert.match(css, /\.send-hint\{/);
});

test("composer offers two always-visible top-level send actions", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const css = await chromeCssSource();

  assert.match(html, /class="button" id="send">Send to Agent</);
  assert.match(html, /class="button button-danger" id="sendAndEnd"[^<]*>.*Send &amp; End</);
  assert.match(
    html,
    /<div class="send-hint" id="sendHint" hidden>Write a message or annotate an element first\.<\/div><div class="actions" id="sendActions"><button class="button button-danger" id="sendAndEnd" type="button">.*<button class="button" id="send">Send to Agent<\/button><\/div>/,
  );
  assert.doesNotMatch(html, /id="sendCaret"/);
  assert.doesNotMatch(html, /id="sendMenu"/);
  assert.doesNotMatch(html, /id="sendFromMenu"/);
  assert.match(css, /\.button-danger\{[^}]*color:var\(--danger\)/);
  assert.match(css, /\.actions\{[^}]*min-width:0/);
});

test("send and end submits queued prompts before ending the session", async () => {
  const js = await chromeClientSource();

  assert.match(js, /let endAfterSubmit = false/);
  assert.match(js, /sendQueued\(true\)/);
  assert.match(js, /if \(shouldEndSession\) body\.endSession = true/);
  assert.match(js, /if \(shouldEndSession\) \{\n {4}endAfterSubmit = false;\n {4}markSessionEnded\(\)/);
  assert.match(js, /if \(!succeeded\) \{\n {6}endAfterSubmit = false/);
  assert.doesNotMatch(js, /await endSession\(\)/);
});

test("chrome only marks session ended after the end request succeeds", async () => {
  const js = await chromeClientSource();

  assert.match(js, /const response = await fetch\("\/api\/" \+ key \+ "\/end", \{ method: "POST" \}\)/);
  assert.match(js, /if \(!response\.ok\) throw new Error\("failed to end session"\)/);
  assert.match(js, /if \(!response\.ok\) throw new Error\("failed to end session"\);\n {2}markSessionEnded\(\)/);
});

test("chrome shows a waiting banner when no agent has attached", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const js = await chromeClientSource();
  const css = await chromeCssSource();

  assert.match(html, /id="presenceBanner"/);
  assert.match(html, /Your agent is not listening/);
  assert.match(js, /presenceBanner\.hidden = ended \|\| agentPresence !== "waiting"/);
  assert.match(css, /\.presence-banner\{/);
});

test("chrome puts queued annotations above the chat composer as preview pills", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const js = await chromeClientSource();
  const css = await chromeCssSource();

  assert.match(html, /id="annotationPills"/);
  assert.match(
    html,
    /<div class="panel-scroll" id="panelScroll"><div class="chat" id="chatLog"><\/div><div class="annotation-pills" id="annotationPills"><\/div><\/div><div class="composer">/,
  );
  assert.match(js, /class="pill/);
  assert.match(js, /pill-preview/);
  assert.match(js, /removeQueuedPrompt/);
  assert.match(js, /pill-tooltip/);
  assert.match(css, /text-overflow:ellipsis/);
  assert.doesNotMatch(js, /togglePill/);
  assert.doesNotMatch(js, /pill-detail/);
  assert.doesNotMatch(html, /<h2>Queued Annotations<\/h2>/);
});

test("chrome scrolls queued prompts above a sticky composer footer", async () => {
  const css = await chromeCssSource();

  assert.match(css, /\.panel-scroll\{[^}]*flex:1 1 auto/);
  assert.match(css, /\.panel-scroll\{[^}]*min-height:0/);
  assert.match(css, /\.panel-scroll\{[^}]*overflow-y:auto/);
  assert.match(css, /\.chat\{[^}]*overflow:visible/);
  assert.match(css, /\.annotation-pills\{[^}]*flex:0 0 auto/);
  assert.match(css, /\.composer\{[^}]*position:sticky/);
  assert.match(css, /\.composer\{[^}]*bottom:0/);
  assert.match(css, /\.composer\{[^}]*flex-shrink:0/);
});

test("chrome omits clear queue button because pills can be removed individually", async () => {
  const js = await chromeClientSource();

  assert.match(js, /removeQueuedPrompt/);
  assert.doesNotMatch(js, /Clear Queue/);
  assert.doesNotMatch(js, /id="clear"/);
});

test("annotation pill tooltip separates target and prompt details", async () => {
  const js = await chromeClientSource();
  const css = await chromeCssSource();

  assert.match(js, /tooltip-label/);
  assert.match(js, /Target/);
  assert.match(js, /Prompt/);
  assert.match(js, /pill-tooltip-target/);
  assert.match(js, /pill-tooltip-prompt/);
  assert.match(css, /\.pill-wrap\{[^}]*width:min\(320px,100%\)/);
  assert.match(css, /\.pill-tooltip\{[^}]*position:static/);
  assert.match(css, /\.pill-tooltip\{[^}]*width:100%/);
  assert.doesNotMatch(css, /\.pill-tooltip\{[^}]*position:absolute/);
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
  assert.match(css, /\.panel-scroll\{[^}]*min-height:0/);
  assert.match(css, /\.chat\{[^}]*min-height:0/);
  assert.match(css, /\.composer\{[^}]*min-width:0/);
  assert.match(css, /\.composer\{[^}]*flex-shrink:0/);
  assert.match(css, /\.composer textarea\{[^}]*box-sizing:border-box/);
});

test("hot reload resets iframe src instead of crossing sandbox location", async () => {
  const js = await chromeClientSource();

  assert.doesNotMatch(js, /contentWindow\.location\.reload/);
  assert.match(js, /frame\.src\s*=\s*artifactSrc \|\| frame\.src/);
});

test("artifact SDK reports only stable severe layout failures after fonts, resize, and animations settle", () => {
  const js = createSdkJs("abc");

  assert.match(js, /document\.fonts\?\.ready/);
  assert.match(js, /new ResizeObserver\(scheduleFinish\)/);
  assert.match(js, /document\.getAnimations/);
  assert.match(js, /activeAnimationTargets/);
  assert.match(js, /isAnimationAssociatedWithElement/);
  assert.match(js, /findStableLayoutFindings/);
  assert.match(js, /type:\s*["']lavish:layoutWarnings["']/);
  assert.match(js, /page-horizontal-overflow/);
  assert.match(js, /clipped-text/);
  assert.match(js, /overlapping-text/);
  assert.doesNotMatch(js, /element-scroll-overflow/);
  assert.doesNotMatch(js, /element-parent-overflow/);
});

test("artifact SDK verifies severe clipping from direct rendered text fragments", () => {
  const js = createSdkJs("abc");

  assert.match(js, /function textFragmentsForAudit/);
  assert.match(js, /document\.createRange\(\)/);
  assert.match(js, /range\.getClientRects\(\)/);
  assert.match(js, /classifySevereTextOverflow/);
  assert.match(js, /isSemanticTextBoundary/);
  assert.match(js, /isStandardVisuallyHidden/);
  assert.match(js, /isIntentionalTextTruncation/);
  assert.match(js, /clippingBoundariesFor/);
  assert.match(js, /auditRequiredControlBounds/);
  assert.match(js, /viewport-unreachable-control/);
  assert.match(js, /auditUnreachableLeftText/);
  assert.match(js, /viewport-unreachable-content/);
  assert.match(js, /hasStandardVisuallyHiddenAncestor/);
  assert.match(js, /rootVerticalScrollLocked/);
  assert.match(js, /hasReachableVerticalScrollerAncestor/);
});

test("artifact SDK reports only near-total occlusion by an opaque sibling", () => {
  const js = createSdkJs("abc");

  assert.match(js, /function opaqueSiblingBlocker/);
  assert.match(js, /backgroundIsOpaque/);
  assert.match(js, /filter\(\(el\) => !isExcludedLayoutAuditElement\(el\)\)/);
  assert.match(js, /hasStandardVisuallyHiddenAncestor/);
  assert.match(js, /hasVisualMaskAncestor/);
  assert.match(js, /isDiagramLayoutElement/);
  assert.match(js, /isNearTotalOcclusion/);
  assert.match(js, /minRatio = 0\.9/);
});

test("artifact SDK reports its scroll position and restores it on request", () => {
  const js = createSdkJs("abc");

  assert.match(js, /addEventListener\(\s*["']scroll["']/);
  assert.match(js, /type:\s*["']lavish:scroll["']/);
  assert.match(js, /window\.scrollX/);
  assert.match(js, /window\.scrollY/);
  assert.match(js, /msg\.type === ["']lavish:restoreScroll["']/);
  assert.match(js, /window\.scrollTo\(/);
});

test("chrome remembers the artifact scroll position across reloads", async () => {
  const js = await chromeClientSource();

  assert.match(js, /let lastScroll = \{ x: 0, y: 0 \}/);
  assert.match(js, /msg\.type === ["']lavish:scroll["']/);
  assert.match(js, /type:\s*["']lavish:restoreScroll["']/);
  assert.match(js, /x:\s*lastScroll\.x,\s*y:\s*lastScroll\.y/);
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

test("chrome restores queued prompts from tab storage after reload", async () => {
  const js = await chromeClientSource();

  assert.match(js, /lavish-axi:queued:/);
  assert.match(js, /function loadQueuedPrompts\(\)/);
  assert.match(js, /const queued = loadQueuedPrompts\(\)/);
  assert.match(js, /sessionStorage\.getItem\(queueStorageKey\)/);
});

test("chrome keeps queued prompts persisted until submit succeeds", async () => {
  const js = await chromeClientSource();

  assert.doesNotMatch(js, /const prompts = queued\.splice\(0, queued\.length\)/);
  assert.match(js, /await fetch\("\/api\/" \+ key \+ "\/prompts", \{/);
  assert.doesNotMatch(js, /queued\.splice\(0, prompts\.length\)/);
  assert.match(js, /for \(const prompt of prompts\) \{/);
  assert.match(js, /const index = queued\.indexOf\(prompt\)/);
  assert.match(js, /if \(index !== -1\) queued\.splice\(index, 1\)/);
});

test("chrome ignores concurrent queued prompt submits", async () => {
  const js = await chromeClientSource();

  assert.match(js, /let submitQueuedPromise = null/);
  assert.match(js, /if \(submitQueuedPromise\) \{/);
  assert.match(js, /return submitQueuedPromise/);
  assert.match(js, /submitQueuedPromise = null/);
});

test("chrome submits prompts queued during an in-flight submit", async () => {
  const js = await chromeClientSource();

  assert.match(js, /let submitQueuedAgain = false/);
  assert.match(js, /submitQueuedAgain = true/);
  assert.match(js, /const shouldSubmitAgain = submitQueuedAgain/);
  assert.match(js, /else if \(!ended && shouldSubmitAgain\) \{\n {6}if \(queued\.length\) \{\n {8}submitQueued\(\)/);
  assert.match(js, /else if \(endAfterSubmit\) \{\n {8}endAfterSubmit = false;\n {8}endSession\(\)/);
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

test("session URLs use the same IPv4 loopback host the server binds", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const body = await res.json();

    assert.match(body.url, /^http:\/\/127\.0\.0\.1:/);
    assert.doesNotMatch(body.url, /localhost/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("session URLs use the configured linkHost while binding to loopback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    host: "127.0.0.1",
    linkHost: "host.example",
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const body = await res.json();

    assert.match(body.url, new RegExp(`^http://host\\.example:${server.port}/session/`));
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("session URLs can disable the layout gate for one open", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact, noGate: true }),
    });
    const body = await res.json();

    assert.match(body.url, /[?&]no-gate=1/);
    const chrome = await (await fetch(body.url)).text();
    assert.match(chrome, /<body class="lavish">/);
    assert.match(chrome, /id="layoutGateOverlay" hidden/);
    assert.match(chrome, /"layoutGateEnabled":false/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("serve rejects fast when the bind host is unavailable", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  try {
    await assert.rejects(
      serve({
        port: 0,
        stateFile: path.join(dir, "state.json"),
        version: "9.9.9-test",
        host: "192.0.2.1",
      }),
      (error) => {
        const code = /** @type {NodeJS.ErrnoException} */ (error).code;
        return code === "EADDRNOTAVAIL" || code === "EADDRINUSE";
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/artifact serves files copied under the artifact directory", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const dir = path.join(parent, ".lavish");
  const assetDir = path.join(dir, "assets");
  const artifact = path.join(dir, "artifact.html");
  await mkdir(dir);
  await mkdir(assetDir);
  await writeFile(
    artifact,
    '<!doctype html><html><head><link rel="stylesheet" href="assets/style.css"></head><body><img src="./assets/icon.svg"></body></html>',
  );
  await writeFile(path.join(assetDir, "style.css"), "body { color: rgb(1 2 3); }\n");
  await writeFile(path.join(assetDir, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>');
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const sessionRes = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const session = await sessionRes.json();
    const css = await fetch(`${base}/artifact/${session.key}/assets/style.css`);
    const svg = await fetch(`${base}/artifact/${session.key}/assets/icon.svg`);

    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") || "", /text\/css/);
    assert.equal(await css.text(), "body { color: rgb(1 2 3); }\n");
    assert.equal(svg.status, 200);
    assert.match(svg.headers.get("content-type") || "", /image\/svg\+xml/);
    assert.match(await svg.text(), /<svg/);
  } finally {
    await server.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("layout warnings wake the same long-poll feedback channel as human prompts", async () => {
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

    const pollPromise = fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=5000`).then((res) =>
      res.json(),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const warningResponse = await fetch(`${base}/api/${key}/layout-warnings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        layout_warnings: [
          {
            selector: "html",
            kind: "page-horizontal-overflow",
            overflowPx: 12,
            viewportWidth: 720,
            severity: "error",
          },
        ],
      }),
    });
    assert.equal(warningResponse.status, 200);

    assert.deepEqual(await pollPromise, {
      status: "feedback",
      dom_snapshot: "",
      prompts: [],
      layout_warnings: [
        {
          selector: "html",
          kind: "page-horizontal-overflow",
          overflowPx: 12,
          viewportWidth: 720,
          severity: "error",
          persistent: false,
        },
      ],
    });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("warning-only layout observations do not wake the long-poll feedback channel", async () => {
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

    const response = await fetch(`${base}/api/${key}/layout-warnings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        layout_warnings: [
          {
            selector: ".accent",
            kind: "element-parent-overflow",
            overflowPx: 20,
            viewportWidth: 720,
            severity: "warning",
          },
        ],
      }),
    });

    assert.deepEqual(await response.json(), { status: "recorded", layout_warnings: 0 });
    const poll = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=25`).then((res) =>
      res.json(),
    );
    assert.deepEqual(poll, { status: "waiting" });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("long-poll sends heartbeat bytes before feedback arrives", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    pollHeartbeatMs: 10,
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });

    const controller = new AbortController();
    const res = await Promise.race([
      fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}`, { signal: controller.signal }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("poll did not send headers")), 500)),
    ]);
    const reader = res.body.getReader();
    try {
      const decoder = new TextDecoder();
      const first = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("poll did not send initial heartbeat")), 500)),
      ]);
      const second = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("poll did not repeat heartbeat")), 500)),
      ]);

      assert.equal(decoder.decode(first.value), " ");
      assert.equal(decoder.decode(second.value), " ");
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
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

test("design asset resolver only trusts exact packaged design asset paths", () => {
  assert.equal(resolveDesignAssetPath("/design/daisyui.css/extra"), null);
  assert.equal(resolveDesignAssetPath("/design/tailwindcss-browser.js/extra"), null);
});

test("GET /api/:key/export inlines local assets and leaves remote references intact", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(
    artifact,
    `<!doctype html><html><head><link rel="stylesheet" href="local.css">` +
      `<link rel="stylesheet" href="https://cdn.example/app.css"></head>` +
      `<body><img src="pic.png"><h1>Hi</h1><script src="/sdk.js?key=stale"></script></body></html>`,
  );
  await writeFile(path.join(dir, "local.css"), ".btn{color:green}");
  await writeFile(path.join(dir, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const sessionRes = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const session = await sessionRes.json();

    const exportRes = await fetch(`${base}/api/${session.key}/export`);
    assert.equal(exportRes.status, 200);
    assert.match(exportRes.headers.get("content-disposition") || "", /attachment; filename="artifact\.export\.html"/);
    const body = await exportRes.text();
    // local stylesheet + image inlined
    assert.match(body, /<style>\.btn\{color:green\}<\/style>/);
    assert.match(body, /<img src="data:image\/png;base64,iVBORw==">/);
    // injected SDK stripped
    assert.doesNotMatch(body, /sdk\.js/);
    // remote stylesheet left intact (not fetched/inlined)
    assert.match(body, /<link rel="stylesheet" href="https:\/\/cdn\.example\/app\.css">/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /api/:key/export sends a safe download filename header", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "résumé draft.html");
  await writeFile(artifact, "<!doctype html><html><body><h1>Hi</h1></body></html>");

  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const sessionRes = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const session = await sessionRes.json();

    const exportRes = await fetch(`${base}/api/${session.key}/export`);

    assert.equal(exportRes.status, 200);
    assert.equal(
      exportRes.headers.get("content-disposition"),
      "attachment; filename=\"r_sum_ draft.export.html\"; filename*=UTF-8''r%C3%A9sum%C3%A9%20draft.export.html",
    );
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /api/:key/export reports unresolved local asset warning count", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, '<!doctype html><html><body><img src="missing.png"></body></html>');

  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const sessionRes = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const session = await sessionRes.json();

    const exportRes = await fetch(`${base}/api/${session.key}/export`);
    const body = await exportRes.text();

    assert.equal(exportRes.status, 200);
    assert.equal(exportRes.headers.get("x-lavish-export-warning-count"), "1");
    assert.equal(exportRes.headers.get("x-lavish-export-notice-count"), "0");
    assert.equal(exportRes.headers.get("x-lavish-export-warnings"), null);
    assert.match(body, /<img src="missing\.png">/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /api/:key/export counts notices separately from unresolved assets", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(
    artifact,
    '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src \'self\'"></head><body><h1>Ship</h1></body></html>',
  );

  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const sessionRes = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const session = await sessionRes.json();

    const exportRes = await fetch(`${base}/api/${session.key}/export`);
    const body = await exportRes.text();

    assert.equal(exportRes.status, 200);
    assert.equal(exportRes.headers.get("x-lavish-export-warning-count"), "0");
    assert.equal(exportRes.headers.get("x-lavish-export-notice-count"), "1");
    assert.match(body, /Content-Security-Policy/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /api/:key/export returns 404 for an unknown session", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/does-not-exist/export`);
    assert.equal(res.status, 404);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /api/:key/share publishes the local-inlined artifact to ht-ml.app", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(
    artifact,
    '<!doctype html><html><head><link rel="stylesheet" href="local.css">' +
      '<link rel="stylesheet" href="https://cdn.example/app.css"></head>' +
      '<body><h1>Ship</h1><script src="/sdk.js?key=x"></script></body></html>',
  );
  await writeFile(path.join(dir, "local.css"), ".btn{color:red}");

  const requests = [];
  const htmlApp = await startFakeHtmlApp(requests);
  const previousApiUrl = process.env.LAVISH_AXI_HTML_APP_API_URL;
  process.env.LAVISH_AXI_HTML_APP_API_URL = `http://127.0.0.1:${htmlApp.port}`;

  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const sessionRes = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const session = await sessionRes.json();

    const shareRes = await fetch(`${base}/api/${session.key}/share`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ password: "pw" }),
    });
    const body = await shareRes.json();

    assert.equal(shareRes.status, 200);
    assert.deepEqual(body, {
      url: "https://abc123.ht-ml.app/",
      site_id: "abc123",
      update_key: "uk_secret",
      status: "active",
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url, "/v1/sites");
    // local stylesheet inlined, SDK stripped, remote stylesheet left intact (never fetched)
    assert.match(requests[0].body.html_content, /<style>\.btn\{color:red\}<\/style>/);
    assert.doesNotMatch(requests[0].body.html_content, /sdk\.js/);
    assert.match(requests[0].body.html_content, /<link rel="stylesheet" href="https:\/\/cdn\.example\/app\.css">/);
    assert.equal(requests[0].body.password, "pw");
  } finally {
    await server.close();
    await htmlApp.close();
    restoreEnv("LAVISH_AXI_HTML_APP_API_URL", previousApiUrl);
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /api/:key/share returns unresolved local asset warnings", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, '<!doctype html><html><body><img src="missing.png"><h1>Ship</h1></body></html>');

  const requests = [];
  const htmlApp = await startFakeHtmlApp(requests);
  const previousApiUrl = process.env.LAVISH_AXI_HTML_APP_API_URL;
  process.env.LAVISH_AXI_HTML_APP_API_URL = `http://127.0.0.1:${htmlApp.port}`;

  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const sessionRes = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const session = await sessionRes.json();

    const shareRes = await fetch(`${base}/api/${session.key}/share`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({}),
    });
    const body = await shareRes.json();

    assert.equal(shareRes.status, 200);
    assert.equal(body.url, "https://abc123.ht-ml.app/");
    assert.equal(body.warnings.length, 1);
    assert.equal(body.unresolved_local_assets.length, 1);
    assert.equal("notices" in body, false);
    assert.equal(body.warnings[0].kind, "load-failed");
    assert.equal(body.warnings[0].ref, "missing.png");
    assert.match(body.warnings[0].reason || "", /ENOENT/);
    assert.equal(requests.length, 1);
    assert.match(requests[0].body.html_content, /<img src="missing\.png">/);
  } finally {
    await server.close();
    await htmlApp.close();
    restoreEnv("LAVISH_AXI_HTML_APP_API_URL", previousApiUrl);
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /api/:key/share rejects cross-origin browser requests", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><title>x</title><h1>Private</h1>\n");

  const requests = [];
  const htmlApp = await startFakeHtmlApp(requests);
  const previousApiUrl = process.env.LAVISH_AXI_HTML_APP_API_URL;
  process.env.LAVISH_AXI_HTML_APP_API_URL = `http://127.0.0.1:${htmlApp.port}`;

  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const sessionRes = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const session = await sessionRes.json();

    const shareRes = await fetch(`${base}/api/${session.key}/share`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({}),
    });
    const body = await shareRes.json();

    assert.equal(shareRes.status, 403);
    assert.deepEqual(body, { error: "cross-origin share request rejected" });
    assert.equal(requests.length, 0);
  } finally {
    await server.close();
    await htmlApp.close();
    restoreEnv("LAVISH_AXI_HTML_APP_API_URL", previousApiUrl);
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /api/:key/share rejects requests without provenance headers", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><title>x</title><h1>Private</h1>\n");

  const requests = [];
  const htmlApp = await startFakeHtmlApp(requests);
  const previousApiUrl = process.env.LAVISH_AXI_HTML_APP_API_URL;
  process.env.LAVISH_AXI_HTML_APP_API_URL = `http://127.0.0.1:${htmlApp.port}`;

  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const sessionRes = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const session = await sessionRes.json();

    const shareRes = await fetch(`${base}/api/${session.key}/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await shareRes.json();

    assert.equal(shareRes.status, 403);
    assert.deepEqual(body, { error: "cross-origin share request rejected" });
    assert.equal(requests.length, 0);
  } finally {
    await server.close();
    await htmlApp.close();
    restoreEnv("LAVISH_AXI_HTML_APP_API_URL", previousApiUrl);
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

test("resolveIdleTimeoutMs defaults, parses, and only explicit opt-outs disable", () => {
  assert.equal(resolveIdleTimeoutMs({}), 30 * 60_000);
  assert.equal(resolveIdleTimeoutMs({ LAVISH_AXI_IDLE_TIMEOUT_MS: "" }), 30 * 60_000);
  assert.equal(resolveIdleTimeoutMs({ LAVISH_AXI_IDLE_TIMEOUT_MS: "5000" }), 5000);
  assert.equal(resolveIdleTimeoutMs({ LAVISH_AXI_IDLE_TIMEOUT_MS: "0" }), null);
  assert.equal(resolveIdleTimeoutMs({ LAVISH_AXI_IDLE_TIMEOUT_MS: "off" }), null);
  assert.equal(resolveIdleTimeoutMs({ LAVISH_AXI_IDLE_TIMEOUT_MS: "-1" }), 30 * 60_000);
  assert.equal(resolveIdleTimeoutMs({ LAVISH_AXI_IDLE_TIMEOUT_MS: "30000ms" }), 30 * 60_000);
  assert.equal(resolveIdleTimeoutMs({ LAVISH_AXI_IDLE_TIMEOUT_MS: "later" }), 30 * 60_000);
});

async function expectDoneWithin(server, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`server did not shut down within ${ms}ms`)), ms);
  });
  try {
    await Promise.race([server.done, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

test("server shuts itself down after the idle timeout with no connections", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    idleTimeoutMs: 150,
  });
  try {
    await expectDoneWithin(server, 2000);
    await assert.rejects(() => fetch(`http://127.0.0.1:${server.port}/health`), /fetch failed|ECONNREFUSED/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an open SSE connection keeps the server alive past the idle timeout", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    idleTimeoutMs: 500,
  });
  const controller = new AbortController();
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const open = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const { key } = await open.json();
    // Hold an SSE connection open so the server is never idle.
    const sse = fetch(`${base}/events/${key}`, { signal: controller.signal });
    sse.catch(() => {});
    await sse;
    await new Promise((resolve) => setTimeout(resolve, 750));
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    // Dropping the connection lets the idle timer fire and shut the server down.
    controller.abort();
    await expectDoneWithin(server, 2000);
  } finally {
    controller.abort();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ending the last open session shuts the server down", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const end = await fetch(`${base}/api/end`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    assert.equal(end.status, 200);
    await expectDoneWithin(server, 2000);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ending one of several sessions keeps the server running", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const first = path.join(dir, "first.html");
  const second = path.join(dir, "second.html");
  await writeFile(first, "<!doctype html><html><body>1</body></html>");
  await writeFile(second, "<!doctype html><html><body>2</body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    for (const file of [first, second]) {
      await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file }),
      });
    }
    await fetch(`${base}/api/end`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: first }),
    });
    // Give any erroneous shutdown a chance to fire before asserting the server is still up.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a user-initiated end via the keyed route blocks a plain reopen but honors reopen: true", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  // A second, never-ended session keeps the server from self-shutting-down once the first
  // session ends with nothing connected, so the later fetches below have a server to hit.
  const keepAlive = path.join(dir, "keep-alive.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  await writeFile(keepAlive, "<!doctype html><html><body></body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: keepAlive }),
    });
    const open = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const { key, url: originalUrl } = await open.json();

    // The browser chrome's plain "End session" hits this keyed route.
    await fetch(`${base}/api/${key}/end`, { method: "POST" });

    const blocked = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const blockedBody = await blocked.json();
    assert.equal(blocked.status, 200);
    assert.equal(blockedBody.status, "user-ended");
    assert.equal(blockedBody.key, key);
    assert.equal(blockedBody.url, originalUrl);

    // A blocked open must not resurrect the session or wake a poll.
    const stillEnded = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`);
    assert.equal((await stillEnded.json()).status, "ended");

    const reopened = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact, reopen: true }),
    });
    const reopenedBody = await reopened.json();
    assert.equal(reopenedBody.status, "opened");

    const afterReopen = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`);
    assert.equal((await afterReopen.json()).status, "waiting");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an agent cleanup after a user end still blocks a plain reopen", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  const keepAlive = path.join(dir, "keep-alive.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  await writeFile(keepAlive, "<!doctype html><html><body></body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: keepAlive }),
    });
    const open = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const { key, url: originalUrl } = await open.json();

    await fetch(`${base}/api/${key}/end`, { method: "POST" });
    await fetch(`${base}/api/end`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });

    const blocked = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const blockedBody = await blocked.json();
    assert.equal(blocked.status, 200);
    assert.equal(blockedBody.status, "user-ended");
    assert.equal(blockedBody.key, key);
    assert.equal(blockedBody.url, originalUrl);

    const ended = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`);
    const endedBody = await ended.json();
    assert.equal(endedBody.status, "ended");
    assert.equal(endedBody.ended_by, "user");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an agent-initiated end via the file-based route reopens normally without the reopen flag", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  // A second, never-ended session keeps the server from self-shutting-down once the first
  // session ends with nothing connected, so the later fetches below have a server to hit.
  const keepAlive = path.join(dir, "keep-alive.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  await writeFile(keepAlive, "<!doctype html><html><body></body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: keepAlive }),
    });
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });

    // `lavish-axi end <file>` uses the file-based route - agent-initiated.
    await fetch(`${base}/api/end`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });

    const reopened = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const reopenedBody = await reopened.json();
    assert.equal(reopenedBody.status, "opened");

    const afterReopen = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`);
    assert.equal((await afterReopen.json()).status, "waiting");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("poll on an ended session reports who ended it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  // A second, never-ended session keeps the server from self-shutting-down once the first
  // session ends with nothing connected, so the poll below has a server to hit.
  const keepAlive = path.join(dir, "keep-alive.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  await writeFile(keepAlive, "<!doctype html><html><body></body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: keepAlive }),
    });
    const open = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const { key } = await open.json();

    await fetch(`${base}/api/${key}/end`, { method: "POST" });

    const polled = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`);
    const body = await polled.json();
    assert.equal(body.status, "ended");
    assert.equal(body.ended_by, "user");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("send-and-end prompt submissions wake active polls with ended attribution", async () => {
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
      const poll = fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}`).then((res) => res.json());
      assert.equal(await presence.next(), "listening");

      const submitted = await fetch(`${base}/api/${key}/prompts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          domSnapshot: 'uid=1 h1 "Hello"',
          endSession: true,
          prompts: [{ prompt: "bye", tag: "message" }],
        }),
      });
      assert.equal(submitted.status, 200);

      const feedback = await poll;
      assert.equal(feedback.status, "feedback");
      assert.equal(feedback.session_ended, true);
      assert.equal(feedback.ended_by, "user");
      assert.equal(feedback.prompts.length, 1);

      const ended = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`);
      const endedBody = await ended.json();
      assert.equal(endedBody.status, "ended");
      assert.equal(endedBody.ended_by, "user");
    } finally {
      await presence.close();
    }
  } finally {
    await server.close();
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

    const pollPromise = fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}`).then((res) => res.json());
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
      const poll = fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}`, {
        signal: pollController.signal,
      }).then((res) => res.text());
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

test("heartbeat long-poll errors close the stream without Express error handling", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");

  assert.match(source, /function handleRespondError\(error\) \{/);
  assert.match(source, /if \(streamHeartbeat\) \{/);
  assert.match(source, /res\.destroy\(error\)/);
  assert.match(source, /respond\(\)\.catch\(handleRespondError\)/);
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
      // The browser end above is user-initiated, so reopening requires the explicit opt-in.
      await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: artifact, reopen: true }),
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

test("hasLiveReloadRootOptIn detects the data attribute and meta opt-in", () => {
  assert.equal(hasLiveReloadRootOptIn("<html><body></body></html>"), false);
  assert.equal(hasLiveReloadRootOptIn(`<html data-lavish-live-reload-root><body></body></html>`), true);
  assert.equal(
    hasLiveReloadRootOptIn(`<html><head><meta name="lavish-live-reload" content="root"></head></html>`),
    true,
  );
});

test("hasLiveReloadRootOptIn ignores commented and text data attribute mentions", () => {
  assert.equal(hasLiveReloadRootOptIn(`<!-- <html data-lavish-live-reload-root> -->`), false);
  assert.equal(hasLiveReloadRootOptIn(`<html><body><code>data-lavish-live-reload-root</code></body></html>`), false);
});

test("resolveWatchTarget defaults to the artifact file so large sibling trees aren't scanned", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-watch-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  try {
    const target = await resolveWatchTarget({ file: artifact, key: "abc" });
    assert.equal(target.path, artifact);
    assert.equal(target.scope, "file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveWatchTarget upgrades to the artifact directory when data-lavish-live-reload-root opts in", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-watch-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, `<!doctype html><html data-lavish-live-reload-root><body></body></html>`);
  try {
    const target = await resolveWatchTarget({ file: artifact, key: "abc" });
    assert.equal(target.path, dir);
    assert.equal(target.scope, "directory");
    assert.ok(target.options.ignored, "directory watch should ignore default noise");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveWatchTarget falls back to file-only when the artifact can't be read", async () => {
  const target = await resolveWatchTarget({
    file: path.join(tmpdir(), `lavish-missing-artifact-${process.hrtime.bigint()}.html`),
    key: "abc",
  });
  assert.equal(target.scope, "file");
});

test("concurrent same-session opens create only one file watcher", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-watch-race-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body>race</body></html>");
  const key = sessionKey(artifact);
  const stateFile = path.join(dir, "state.json");
  await writeFile(
    stateFile,
    `${JSON.stringify({
      sessions: {
        [key]: {
          key,
          file: artifact,
          url: `http://localhost:0/session/${key}`,
          status: "open",
          pending_prompts: 0,
          prompts: [],
          dom_snapshot: "",
          chat: [],
          updated_at: new Date().toISOString(),
        },
      },
    })}\n`,
  );
  const logs = [];
  const server = await serve({
    port: 0,
    stateFile,
    version: "9.9.9-test",
    debug: true,
    log: (line) => logs.push(line),
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const responses = await Promise.all([fetch(`${base}/session/${key}`), fetch(`${base}/session/${key}`)]);
    for (const response of responses) {
      assert.equal(response.status, 200);
    }
    assert.equal(logs.filter((line) => line.includes("watch session=")).length, 1);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("/health and / stay responsive after opening two back-to-back sessions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-back-to-back-"));
  const a = path.join(dir, "a.html");
  const b = path.join(dir, "b.html");
  await writeFile(a, "<!doctype html><html><body>a</body></html>");
  await writeFile(b, "<!doctype html><html><body>b</body></html>");
  // Add a sibling tree so a recursive watcher would have to scan it.
  const big = path.join(dir, "big");
  await mkdir(big, { recursive: true });
  await Promise.all(Array.from({ length: 40 }, (_, i) => writeFile(path.join(big, `file-${i}.txt`), "x".repeat(64))));
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: a }),
    });
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: b }),
    });

    const start = Date.now();
    const healthRes = await Promise.race([
      fetch(`${base}/health`),
      new Promise((_, reject) => setTimeout(() => reject(new Error("/health timed out")), 1000)),
    ]);
    assert.equal(healthRes.status, 200);
    assert.equal((await healthRes.json()).ok, true);

    const rootRes = await Promise.race([
      fetch(`${base}/`),
      new Promise((_, reject) => setTimeout(() => reject(new Error("/ timed out")), 1000)),
    ]);
    assert.equal(rootRes.status, 404);
    await rootRes.text().catch(() => {});

    assert.ok(Date.now() - start < 1000, "both probes should return well under one second");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("server debug logger receives session and watcher lifecycle events", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-debug-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  const loggedArtifact = await canonicalFile(artifact);
  const logs = [];
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    debug: true,
    log: (line) => logs.push(line),
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    assert.ok(
      logs.some((line) => /session/i.test(line) && line.includes(loggedArtifact)),
      `expected a session-opened log line, got: ${JSON.stringify(logs)}`,
    );
    assert.ok(
      logs.some((line) => /watch/i.test(line)),
      `expected a watcher log line, got: ${JSON.stringify(logs)}`,
    );
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ended session shows an overlay card over the dimmed chrome", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const js = await chromeClientSource();
  const css = await chromeCssSource();

  assert.match(html, /class="ended-overlay" id="endedOverlay" hidden/);
  assert.match(html, /class="ended-card"/);
  assert.match(html, /Session ended\./);
  assert.match(html, /Return to your agent to continue\./);
  assert.match(html, /class="ended-copy">\/tmp\/artifact\.html</);
  assert.doesNotMatch(html, /The agent polling loop can stop\./);
  assert.match(css, /\.ended-overlay\{[^}]*inset:var\(--bar-h\) 0 0 0/);
  assert.match(css, /\.ended-overlay\{[^}]*background:rgba\(15,17,21,.86\)/);
  assert.match(css, /\.ended-title\{[^}]*font-family:var\(--font-serif\)/);
  assert.match(js, /endedOverlay\.hidden = false/);
  assert.match(js, /annotationSwitch\.disabled = true/);
  assert.match(js, /moreButton\.disabled = true/);
});

test("layout gate curtain reuses the ended overlay card styling", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const noGateHtml = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" }, { layoutGateEnabled: false });
  const js = await chromeClientSource();
  const css = await chromeCssSource();

  assert.match(html, /<body class="lavish layout-gate-active">/);
  assert.match(
    html,
    /<iframe id="artifact" sandbox="allow-scripts allow-forms allow-popups allow-downloads" data-artifact-src="\/artifact\/abc\/index\.html"><\/iframe>/,
  );
  assert.doesNotMatch(html, /<iframe id="artifact"[^>]* src=/);
  assert.match(html, /class="ended-overlay layout-gate-overlay" id="layoutGateOverlay"/);
  assert.match(html, /<div class="ended-card"><div class="ended-title" id="layoutGateTitle">Checking layout/);
  assert.match(html, /class="ended-copy" id="layoutGateCopy"/);
  assert.match(html, /class="button ended-action" id="layoutGateAction" type="button">Show anyway/);
  assert.match(css, /body\.layout-gate-active iframe#artifact\{[^}]*opacity:0/);
  assert.match(css, /\.ended-action\{[^}]*margin-top:var\(--space-8\)/);
  assert.match(js, /layoutGateAction\.onclick = \(\) => forceRevealLayoutGate\("manual"\)/);
  assert.match(noGateHtml, /<body class="lavish">/);
  assert.match(noGateHtml, /id="layoutGateOverlay" hidden/);
  assert.match(noGateHtml, /"layoutGateEnabled":false/);
});

test("annotation card queues prompt on Enter and inserts newline on Shift+Enter", () => {
  const js = createSdkJs("abc");

  assert.match(js, /textarea\.addEventListener\(["']keydown["']/);
  assert.match(js, /event\.key === ["']Enter["'] && !event\.shiftKey/);
  assert.match(js, /event\.preventDefault\(\)/);
  assert.match(js, /sendButton\.click\(\)/);
});

test("annotation card queues and sends immediately on Ctrl+Enter or Cmd+Enter", () => {
  const js = createSdkJs("abc");

  assert.match(js, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(js, /sendQueuedPrompts\(\)/);
  assert.match(js, /class="lavish-hint"/);
  assert.match(js, /\+Enter to send now/);
  assert.match(js, /\.lavish-annotation-card \.lavish-hint\{/);
});

test("chrome client chat input sends on Enter and inserts newline on Shift+Enter", async () => {
  const js = await chromeClientSource();

  assert.match(js, /chatInput\.addEventListener\(["']keydown["']/);
  assert.match(js, /event\.key === ["']Enter["'] && !event\.shiftKey/);
  assert.match(js, /event\.preventDefault\(\)/);
  assert.match(js, /sendQueued\(\)/);
});

async function startFakeHtmlApp(requests, responseBody = null) {
  const body = responseBody ?? {
    site_id: "abc123",
    url: "https://abc123.ht-ml.app/",
    update_key: "uk_secret",
    status: "active",
  };
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test("chrome falls back to a default favicon and title when none are provided", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/);
  assert.match(html, /<title>Lavish Editor<\/title>/);
});

test("chrome adopts a favicon tag and tab title passed from the artifact", () => {
  const faviconTag =
    '<link rel="icon" href="data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\'><text>🗂️</text></svg>">';
  const html = createChromeHtml(
    { key: "abc", file: "/tmp/artifact.html" },
    { faviconTag, title: "Project Board · Lavish" },
  );

  assert.ok(html.includes(faviconTag), "artifact favicon tag is injected verbatim");
  assert.match(html, /<title>Project Board · Lavish<\/title>/);
});

test("chrome tab title from the artifact is HTML-escaped", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" }, { title: "<script>alert(1)</script>" });

  assert.doesNotMatch(html, /<title><script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("extractArtifactHead pulls a data-URI favicon and title from the artifact head", () => {
  const artifact = `<!doctype html><html><head>
    <title>  Weekly   Board  </title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🗂️</text></svg>">
    </head><body></body></html>`;
  const { faviconTag, title } = extractArtifactHead(artifact);

  assert.match(faviconTag, /rel="icon"/);
  assert.match(faviconTag, /viewBox='0 0 100 100'/, "data-URI '>' chars must not truncate the tag");
  assert.match(faviconTag, /<\/svg>">$/, "the full link tag is captured");
  assert.equal(title, "Weekly Board");
});

test("extractArtifactHead handles shortcut icon and absolute hrefs", () => {
  const artifact = `<head><link rel="shortcut icon" href="https://example.com/fav.ico"></head>`;
  const { faviconTag } = extractArtifactHead(artifact);

  assert.match(faviconTag, /href="https:\/\/example\.com\/fav\.ico"/);
});

test("extractArtifactHead reconstructs a clean tag and drops artifact-supplied attributes", () => {
  const hostile = extractArtifactHead(
    '<head><link rel="stylesheet icon" href="data:text/css,x" onload="steal()" onerror="steal()"></head>',
  );
  assert.equal(hostile.faviconTag, '<link rel="icon" href="data:text/css,x">');
  assert.doesNotMatch(hostile.faviconTag, /onload|onerror|steal|stylesheet/i);

  const breakout = extractArtifactHead(`<head><link rel='icon' href='data:image/png,x" onload="steal()'></head>`);
  assert.doesNotMatch(breakout.faviconTag, /onload="/i);
  assert.match(breakout.faviconTag, /^<link rel="icon" href="[^"]*">$/);
  assert.match(breakout.faviconTag, /&quot;/);
});

test("extractArtifactHead falls back to the default for missing or relative favicons", () => {
  const none = extractArtifactHead("<head><title>No icon</title></head>");
  assert.match(none.faviconTag, /data:image\/svg\+xml/);
  assert.equal(none.title, "No icon");

  // Relative hrefs would not resolve against the chrome page, so they fall back.
  const relative = extractArtifactHead('<head><link rel="icon" href="favicon.png"></head>');
  assert.match(relative.faviconTag, /data:image\/svg\+xml/);
});

test("extractArtifactHead does not hang on an unterminated link tag", () => {
  const start = process.hrtime.bigint();
  const result = extractArtifactHead("<head><link " + '"'.repeat(60000));
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(elapsedMs < 1000, `expected linear scan, took ${elapsedMs}ms`);
  assert.match(result.faviconTag, /data:image\/svg\+xml/);
});

test("extractArtifactHead reads the real href, not one hidden in another attribute", () => {
  // A `data-href` (longer attribute name) must not be mistaken for `href`; the
  // real, relative href should win and fall back to the default favicon.
  const dataHref = extractArtifactHead(
    '<head><link rel="icon" data-href="data:image/png,decoy" href="favicon.png"></head>',
  );
  assert.match(dataHref.faviconTag, /data:image\/svg\+xml/, "data-href decoy must not be adopted");

  // A `href=` sequence inside another attribute's quoted value must not be
  // adopted either; the genuine absolute href should be used.
  const inValue = extractArtifactHead(
    '<head><link rel="icon" title="see href=data:image/png,decoy" href="https://cdn.example.com/logo.png"></head>',
  );
  assert.equal(inValue.faviconTag, '<link rel="icon" href="https://cdn.example.com/logo.png">');
});
