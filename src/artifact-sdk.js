/* global CSS, Element, document, parent, window */

export function createArtifactSdk() {
  let annotationMode = true;
  let hovered = null;
  let selected = null;
  let ignoreNextClick = false;
  let shadow = null;
  let counter = 0;
  const ids = new WeakMap();

  function uid(el) {
    if (!ids.has(el)) ids.set(el, String(++counter));
    return ids.get(el);
  }

  function selector(el) {
    if (!el || !el.tagName) return "";

    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += "#" + CSS.escape(node.id);
        parts.unshift(part);
        break;
      }

      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((x) => x.tagName === node.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }

    return parts.join(" > ");
  }

  function context(el) {
    return {
      uid: uid(el),
      selector: selector(el),
      tag: (el.tagName || "").toLowerCase(),
      text: (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 240),
    };
  }

  function closestElement(node) {
    if (!node) return document.body;
    if (node.nodeType === 1) return node;
    return node.parentElement || document.body;
  }

  function nodePath(node, root) {
    const path = [];
    let current = node;
    while (current && current !== root) {
      const parentNode = current.parentNode;
      if (!parentNode) break;
      path.unshift([...parentNode.childNodes].indexOf(current));
      current = parentNode;
    }
    return path;
  }

  function rangeBoundary(node, offset) {
    const el = closestElement(node);
    return {
      selector: selector(el),
      path: nodePath(node, el),
      offset: Number(offset) || 0,
    };
  }

  function textSelectionContext(selection) {
    if (!selection || selection.rangeCount === 0) return null;

    const range = selection.getRangeAt(0);
    const text = selection.toString().trim().replace(/\s+/g, " ");
    if (range.collapsed || !text) return null;

    const ancestor = closestElement(range.commonAncestorContainer);
    if (isLavishUi(ancestor) || isLavishAction(ancestor) || isInteractiveControl(ancestor)) return null;

    const commonAncestorSelector = selector(ancestor);
    const target = {
      type: "text-range",
      text,
      selector: commonAncestorSelector,
      commonAncestorSelector,
      start: rangeBoundary(range.startContainer, range.startOffset),
      end: rangeBoundary(range.endContainer, range.endOffset),
    };

    return {
      uid: "",
      selector: commonAncestorSelector,
      tag: "text",
      text: text.slice(0, 240),
      target,
      element: ancestor,
      range: range.cloneRange(),
    };
  }

  function isLavishUi(el) {
    return !!(el && el.closest && el.closest("[data-lavish-ui]"));
  }

  function isLavishAction(el) {
    return !!(el && el.closest && el.closest("[data-lavish-action]"));
  }

  // Native interactive controls (radios, checkboxes, inputs, selects, buttons,
  // labels, editable regions) should toggle/focus/type natively instead of
  // triggering annotation, just like elements marked with data-lavish-action.
  function isInteractiveControl(el) {
    return !!(
      el &&
      el.closest &&
      el.closest("button,input,select,textarea,option,optgroup,label,[contenteditable]:not([contenteditable='false'])")
    );
  }

  function highlightElement(el) {
    if (!el) return;
    el.style.outline = "var(--lavish-annotate-outline,2px solid #f4c95d)";
    el.style.outlineOffset = "var(--lavish-annotate-offset,2px)";
  }

  function clearHighlight(el) {
    if (el) el.style.outline = "";
  }

  function clearTextHighlight() {
    if (!shadow) return;
    for (const el of [...shadow.querySelectorAll(".lavish-text-highlight")]) el.remove();
  }

  function highlightTextRange(range) {
    clearTextHighlight();
    const root = ensureShadow();
    for (const rect of [...range.getClientRects()]) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      const mark = document.createElement("div");
      mark.className = "lavish-text-highlight";
      mark.style.left = rect.left + "px";
      mark.style.top = rect.top + "px";
      mark.style.width = rect.width + "px";
      mark.style.height = rect.height + "px";
      root.appendChild(mark);
    }
  }

  function setAnnotationMode(enabled) {
    annotationMode = !!enabled;
    let style = document.getElementById("lavish-cursor-style");
    if (annotationMode && !style) {
      style = document.createElement("style");
      style.id = "lavish-cursor-style";
      style.textContent =
        ":root{--lavish-accent:#f4c95d;--lavish-annotate-outline:2px solid var(--lavish-accent);--lavish-annotate-offset:2px}*{cursor:default!important}[data-lavish-action],[data-lavish-action] *{cursor:pointer!important}input,textarea,[contenteditable]:not([contenteditable='false']){cursor:text!important}button,select,label,option,input[type='button'],input[type='submit'],input[type='reset'],input[type='checkbox'],input[type='radio'],input[type='file'],input[type='color'],input[type='range'],input[type='image']{cursor:pointer!important}";
      document.head.appendChild(style);
    }
    if (!annotationMode && style) style.remove();
    if (!annotationMode) closeCard();
  }

  function queuePrompt(prompt, options = {}) {
    /** @type {{ uid: string, prompt: string, selector: string, tag: string, text: string, target?: unknown }} */
    const item = {
      ...context(options.element || document.activeElement || document.body),
      prompt: String(prompt || ""),
    };

    if (options.uid) item.uid = String(options.uid);
    if (options.selector) item.selector = String(options.selector);
    if (options.tag) item.tag = String(options.tag);
    if (options.text) item.text = String(options.text);
    if (options.target) item.target = options.target;
    if (options.data) item.prompt += "\n\nContext data:\n" + JSON.stringify(options.data, null, 2);

    parent.postMessage({ type: "lavish:queuePrompt", prompt: item }, "*");
  }

  function sendQueuedPrompts() {
    parent.postMessage({ type: "lavish:sendQueuedPrompts" }, "*");
  }

  function endSession() {
    parent.postMessage({ type: "lavish:endSession" }, "*");
  }

  function snapshot() {
    const lines = [];

    function walk(el, depth) {
      if (!(el instanceof Element) || depth > 6 || isLavishUi(el)) return;

      const c = context(el);
      const name = c.text ? ' "' + c.text.slice(0, 80).replace(/"/g, "'") + '"' : "";
      lines.push("  ".repeat(depth) + "uid=" + c.uid + " " + c.tag + name);
      for (const child of el.children) walk(child, depth + 1);
    }

    walk(document.body, 0);
    return lines.join("\n");
  }

  function ensureShadow() {
    if (shadow) return shadow;

    const host = document.createElement("div");
    host.className = "lavish-annotation-root";
    host.setAttribute("data-lavish-ui", "annotation-root");
    document.documentElement.appendChild(host);

    shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `:host{all:initial;position:fixed;z-index:2147483647;left:0;top:0;color-scheme:dark;--ink-900:#0f1115;--ink-800:#11141a;--ink-700:#171a21;--ink-600:#1c212b;--steel-700:#2a2f3a;--steel-600:#303745;--steel-500:#3c4557;--steel-400:#8c96aa;--steel-300:#aeb6c6;--steel-200:#b9c0cf;--steel-100:#d8deea;--cream-50:#fffbf3;--cream-100:#f7f3ea;--cream-200:#e8e1cf;--brass-500:#f4c95d;--brass-400:#ffd877;--brass-ink:#17130a;--bg:var(--ink-900);--bg-panel:var(--ink-800);--bg-elevated:var(--ink-600);--fg:var(--cream-100);--fg-faint:var(--steel-300);--border:var(--steel-600);--accent:#f4c95d;--accent-hover:#ffd877;--font-sans:Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--font-mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--radius-md:10px;--radius-xl:14px;--shadow-floating:0 20px 70px rgba(0,0,0,.35);font-family:var(--font-sans)}*{box-sizing:border-box}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.lavish-text-highlight{position:fixed;pointer-events:none;background:rgba(244,201,93,.28);border-radius:2px;box-shadow:0 0 0 1px rgba(244,201,93,.45)}.lavish-annotation-card{position:fixed;width:min(320px,calc(100vw - 24px));padding:12px;border-radius:var(--radius-xl);background:var(--bg-panel);color:var(--fg);border:1px solid var(--accent);box-shadow:var(--shadow-floating);font:14px/1.4 var(--font-sans)}.lavish-heading{font-weight:700;margin-bottom:6px}.lavish-annotation-card textarea{width:100%;min-height:86px;resize:vertical;border-radius:var(--radius-md);border:1px solid var(--border);background:var(--bg);color:var(--fg);padding:9px;font:inherit;font-family:var(--font-sans)}.lavish-annotation-card textarea::placeholder{color:var(--fg-faint)}.lavish-annotation-card .lavish-row{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}.lavish-annotation-card button{border:0;border-radius:var(--radius-md);padding:8px 10px;font-family:var(--font-sans);font-size:13px;font-weight:700;cursor:pointer}.lavish-annotation-card button:active{opacity:.85}.lavish-annotation-card .lavish-send{background:var(--accent);color:var(--brass-ink)}.lavish-annotation-card .lavish-send:hover{background:var(--accent-hover)}.lavish-annotation-card .lavish-cancel{background:var(--steel-700);color:var(--fg)}`;
    shadow.appendChild(style);
    return shadow;
  }

  function closeCard() {
    if (shadow) {
      for (const el of [...shadow.querySelectorAll(".lavish-annotation-card")]) el.remove();
    }
    clearHighlight(hovered);
    clearHighlight(selected);
    hovered = null;
    clearTextHighlight();
    selected = null;
  }

  function showAnnotationCard(target, options = {}) {
    const root = ensureShadow();
    closeCard();

    const c = options.context || context(target);
    if (options.range) {
      highlightTextRange(options.range);
    } else {
      selected = target;
      highlightElement(selected);
    }

    const rect = options.range ? options.range.getBoundingClientRect() : target.getBoundingClientRect();
    const card = document.createElement("div");
    card.className = "lavish-annotation-card";
    const heading = c.tag === "text" ? "Annotate text" : "Annotate &lt;" + c.tag + "&gt;";
    const placeholder =
      c.tag === "text"
        ? "Tell the agent what to change about this text..."
        : "Tell the agent what to change about this element...";
    card.innerHTML =
      '<div class="lavish-heading">' +
      heading +
      '</div><textarea placeholder="' +
      placeholder +
      '"></textarea><div class="lavish-row"><button class="lavish-cancel" type="button">Cancel</button><button class="lavish-send" type="button">Queue</button></div>';
    root.appendChild(card);

    const left = Math.min(Math.max(12, rect.left), window.innerWidth - card.offsetWidth - 12);
    const top = Math.min(Math.max(12, rect.bottom + 8), window.innerHeight - card.offsetHeight - 12);
    card.style.left = left + "px";
    card.style.top = top + "px";

    const textarea = /** @type {HTMLTextAreaElement | null} */ (card.querySelector("textarea"));
    const cancelButton = /** @type {HTMLButtonElement | null} */ (card.querySelector(".lavish-cancel"));
    const sendButton = /** @type {HTMLButtonElement | null} */ (card.querySelector(".lavish-send"));
    if (!textarea || !cancelButton || !sendButton) return;

    cancelButton.onclick = closeCard;
    sendButton.onclick = () => {
      const prompt = textarea.value.trim();
      if (prompt) queuePrompt(prompt, c);
      closeCard();
    };
    setTimeout(() => textarea.focus(), 0);
  }

  /** @type {Window & { lavish?: unknown }} */ (window).lavish = {
    queuePrompt,
    sendQueuedPrompts,
    endSession,
    getQueuedPrompts: () => [],
    setStatus: (message) => parent.postMessage({ type: "lavish:status", message: String(message) }, "*"),
    snapshot,
  };

  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "lavish:setAnnotationMode") setAnnotationMode(msg.enabled);
    if (msg.type === "lavish:requestSnapshot") {
      parent.postMessage({ type: "lavish:snapshot", snapshot: snapshot() }, "*");
    }
    if (msg.type === "lavish:restoreScroll") {
      window.scrollTo(Number(msg.x) || 0, Number(msg.y) || 0);
    }
  });

  // Report scroll position to the chrome so it can be restored across hot reloads.
  // The iframe is sandboxed without same-origin, so the chrome can't read scrollY directly.
  let scrollFrame = 0;
  window.addEventListener(
    "scroll",
    () => {
      if (scrollFrame) return;
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = 0;
        parent.postMessage({ type: "lavish:scroll", x: window.scrollX, y: window.scrollY }, "*");
      });
    },
    { passive: true },
  );

  document.addEventListener(
    "mouseover",
    (event) => {
      if (
        !annotationMode ||
        isLavishUi(event.target) ||
        isLavishAction(event.target) ||
        isInteractiveControl(event.target)
      )
        return;
      if (event.target === selected) return;
      if (hovered && hovered !== selected) clearHighlight(hovered);
      hovered = event.target;
      highlightElement(hovered);
    },
    true,
  );

  document.addEventListener(
    "mouseout",
    () => {
      if (hovered && hovered !== selected) {
        clearHighlight(hovered);
        hovered = null;
      }
    },
    true,
  );

  document.addEventListener(
    "mouseup",
    (event) => {
      if (
        !annotationMode ||
        isLavishUi(event.target) ||
        isLavishAction(event.target) ||
        isInteractiveControl(event.target)
      )
        return;

      const c = textSelectionContext(document.getSelection());
      if (!c) return;

      ignoreNextClick = true;
      showAnnotationCard(c.element, { context: c, range: c.range });
    },
    true,
  );

  document.addEventListener(
    "click",
    (event) => {
      if (
        !annotationMode ||
        isLavishUi(event.target) ||
        isLavishAction(event.target) ||
        isInteractiveControl(event.target)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (ignoreNextClick) {
        ignoreNextClick = false;
        return;
      }
      showAnnotationCard(event.target);
    },
    true,
  );

  setAnnotationMode(annotationMode);
}
