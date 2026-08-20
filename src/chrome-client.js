/* global EventSource, document, location, window */

const sessionDataElement = document.getElementById("lavish-session");
const sessionData = JSON.parse(sessionDataElement?.textContent || "{}");
const key = String(sessionData.key || "");
const filePath = String(sessionData.file || "");
const queueStorageKey = "lavish-axi:queued:" + key;
// Review-chrome state that must survive a browser refresh. Keyed per session so one review's
// triage can never leak into another artifact's.
const warningSelectionStorageKey = "lavish-axi:warning-selection:" + key;
const internalQueueKeyField = "_lavishQueueKey";
const initialChat = Array.isArray(sessionData.initialChat) ? sessionData.initialChat : [];
const MODE_TOGGLE_HOTKEY_KEY = String(sessionData.modeToggleHotkeyKey || "").toLowerCase();
const attachmentMaxBytes = Number(sessionData.attachmentMaxBytes) || 0;
const attachmentMaxCount = Number(sessionData.attachmentMaxCount) || 4;
// Threaded from the server's single accepted-image list, which also drives the
// file picker's accept attribute, so the two can never disagree. An unwired
// list falls back to the same defaults as the SDK's acceptedImageTypes - an
// empty Set would refuse every image while the card in the same session
// accepts them, the exact divergence the single list exists to prevent.
const CHAT_ATTACHMENT_MIME = new Set(
  (Array.isArray(sessionData.attachmentAcceptedMime) && sessionData.attachmentAcceptedMime.length
    ? sessionData.attachmentAcceptedMime
    : ["image/png", "image/jpeg", "image/webp"]
  ).map(String),
);
// Named in the rejection copy, so the message can never tell the user to use a
// format this build does not accept.
const CHAT_ATTACHMENT_LABELS = (() => {
  const labels = [...CHAT_ATTACHMENT_MIME].map((mime) => mime.replace(/^image\//, "").toUpperCase());
  if (labels.length < 2) return labels.join("");
  return labels.slice(0, -1).join(", ") + (labels.length > 2 ? ", or " : " or ") + labels[labels.length - 1];
})();

// The chrome is the only path from the sandboxed (opaque-origin) artifact iframe to
// the loopback server, so it is the sole place a same-origin confused-deputy can be
// mediated: the frame's postMessage source check proves a message came from the
// artifact frame but NOT that a user gesture (paste/drop/pick) drove it, so hostile
// artifact script could otherwise drive unbounded uploads. Bound both the rate and
// the cumulative bytes per chrome session here; the server keeps a bounded disk
// quota as the durable backstop.
const UPLOAD_RATE_WINDOW_MS = 60_000;
const UPLOAD_RATE_MAX = 30;
const UPLOAD_SESSION_BYTE_QUOTA = 256 * 1024 * 1024; // 256 MiB per chrome session
// The rate and cumulative-byte guards bound uploads over time, but not how many run
// AT ONCE: each accepted message starts fetch() immediately, so a hostile artifact
// could post ~30 large bodies in one tick and hold hundreds of MiB of structured
// clones + server body buffers concurrently before the cumulative quota trips (D8).
// Cap the number in flight; the over-cap ones are refused with a retry hint (like the
// rate guard) and a freed slot admits the next.
const UPLOAD_MAX_IN_FLIGHT = 4;
const uploadTimestamps = [];
let uploadedBytesTotal = 0;
let uploadsInFlight = 0;

function formatByteLimit(bytes) {
  if (bytes >= 1024 * 1024) return Math.round(bytes / (1024 * 1024)) + " MB";
  if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
  return bytes + " bytes";
}

// Turn the server's atomic-reject detail (C4) into one human line naming the cap
// that was hit, so the user knows what to fix. Nothing was delivered - the queue is
// preserved - so the wording is about correcting, not about a partial send.
function describeAttachmentRejection(rejected, caps) {
  const reasons = new Set(rejected.map((ref) => ref && ref.reason));
  const parts = [];
  if (reasons.has("prompt-bytes-exceeded") && caps && caps.maxPromptBytes) {
    parts.push("images exceed the " + formatByteLimit(caps.maxPromptBytes) + " per-prompt limit");
  }
  if (reasons.has("too-many") && caps && caps.maxPerPrompt) {
    parts.push("more than " + caps.maxPerPrompt + " images on one prompt");
  }
  if (reasons.has("too-many-in-request")) {
    parts.push("too many images queued at once");
  }
  if (reasons.has("malformed")) {
    parts.push("an image attachment was malformed");
  }
  if (reasons.has("not-found")) {
    parts.push("an image is no longer available");
  }
  const detail = parts.length ? parts.join("; ") : "some attachments could not be delivered";
  return "Not sent — " + detail + ". Remove or fix the image, then send again.";
}

function isModeToggleHotkeyEvent(event) {
  if (event.shiftKey || event.altKey) return false;
  return Boolean(event.metaKey || event.ctrlKey) && String(event.key || "").toLowerCase() === MODE_TOGGLE_HOTKEY_KEY;
}

const frame = /** @type {HTMLIFrameElement} */ (document.getElementById("artifact"));
const panelScroll = /** @type {HTMLDivElement} */ (document.getElementById("panelScroll"));
const annotationPills = /** @type {HTMLDivElement} */ (document.getElementById("annotationPills"));
const chatLog = /** @type {HTMLDivElement} */ (document.getElementById("chatLog"));
const chatComposer = /** @type {HTMLDivElement} */ (document.getElementById("chatComposer"));
const chatInput = /** @type {HTMLTextAreaElement} */ (document.getElementById("chatInput"));
const chatAttachments = /** @type {HTMLDivElement} */ (document.getElementById("chatAttachments"));
const chatAttachButton = /** @type {HTMLButtonElement} */ (document.getElementById("chatAttach"));
const chatAttachInput = /** @type {HTMLInputElement} */ (document.getElementById("chatAttachInput"));
const chatAttachmentNotice = /** @type {HTMLSpanElement} */ (document.getElementById("chatAttachmentNotice"));
const sendButton = /** @type {HTMLButtonElement} */ (document.getElementById("send"));
const sendAndEndButton = /** @type {HTMLButtonElement} */ (document.getElementById("sendAndEnd"));
const annotationSwitch = /** @type {HTMLButtonElement} */ (document.getElementById("annotation"));
const moreWrap = /** @type {HTMLDivElement} */ (document.getElementById("moreWrap"));
const moreButton = /** @type {HTMLButtonElement} */ (document.getElementById("moreButton"));
const moreMenu = /** @type {HTMLDivElement} */ (document.getElementById("moreMenu"));
const reloadArtifactButton = /** @type {HTMLButtonElement} */ (document.getElementById("reloadArtifact"));
const copySnapshotButton = /** @type {HTMLButtonElement} */ (document.getElementById("copySnapshot"));
const exportArtifactButton = /** @type {HTMLButtonElement} */ (document.getElementById("exportArtifact"));
const shareArtifactButton = /** @type {HTMLButtonElement} */ (document.getElementById("shareArtifact"));
const shareDialog = /** @type {HTMLDivElement} */ (document.getElementById("shareDialog"));
const shareForm = /** @type {HTMLFormElement} */ (document.getElementById("shareForm"));
const shareCloseButton = /** @type {HTMLButtonElement} */ (document.getElementById("shareClose"));
const shareCancelButton = /** @type {HTMLButtonElement} */ (document.getElementById("shareCancel"));
const sharePublishButton = /** @type {HTMLButtonElement} */ (document.getElementById("sharePublish"));
const sharePasswordInput = /** @type {HTMLInputElement} */ (document.getElementById("sharePassword"));
const shareStatus = /** @type {HTMLDivElement} */ (document.getElementById("shareStatus"));
const shareResult = /** @type {HTMLDivElement} */ (document.getElementById("shareResult"));
const shareUrlInput = /** @type {HTMLInputElement} */ (document.getElementById("shareUrl"));
const shareUpdateKeyInput = /** @type {HTMLInputElement} */ (document.getElementById("shareUpdateKey"));
const copyShareUrlButton = /** @type {HTMLButtonElement} */ (document.getElementById("copyShareUrl"));
const copyUpdateKeyButton = /** @type {HTMLButtonElement} */ (document.getElementById("copyUpdateKey"));
const endButton = /** @type {HTMLButtonElement} */ (document.getElementById("end"));
const copyPathButton = /** @type {HTMLButtonElement} */ (document.getElementById("copyPath"));
const copyHint = /** @type {HTMLSpanElement} */ (document.getElementById("copyHint"));
const copyHintText = /** @type {HTMLSpanElement} */ (document.getElementById("copyHintText"));
const presenceBanner = /** @type {HTMLDivElement} */ (document.getElementById("presenceBanner"));
const handoffBanner = /** @type {HTMLDivElement} */ (document.getElementById("handoffBanner"));
const handoffTakeoverButton = /** @type {HTMLButtonElement} */ (document.getElementById("handoffTakeover"));
const endedOverlay = /** @type {HTMLDivElement} */ (document.getElementById("endedOverlay"));
const layoutGateOverlay = /** @type {HTMLDivElement} */ (document.getElementById("layoutGateOverlay"));
const layoutGateTitle = /** @type {HTMLDivElement} */ (document.getElementById("layoutGateTitle"));
const layoutGateCopy = /** @type {HTMLParagraphElement} */ (document.getElementById("layoutGateCopy"));
const layoutGateAction = /** @type {HTMLButtonElement} */ (document.getElementById("layoutGateAction"));
const warningsWrap = /** @type {HTMLDivElement} */ (document.getElementById("warningsWrap"));
const warningsButton = /** @type {HTMLButtonElement} */ (document.getElementById("warningsButton"));
const warningsCount = /** @type {HTMLSpanElement} */ (document.getElementById("warningsCount"));
const warningsDrawer = /** @type {HTMLDivElement} */ (document.getElementById("warningsDrawer"));
const warningsSummary = /** @type {HTMLParagraphElement} */ (document.getElementById("warningsSummary"));
const warningsSelectAll = /** @type {HTMLInputElement} */ (document.getElementById("warningsSelectAll"));
const warningsSelected = /** @type {HTMLSpanElement} */ (document.getElementById("warningsSelected"));
const warningsList = /** @type {HTMLDivElement} */ (document.getElementById("warningsList"));
const warningsQueueButton = /** @type {HTMLButtonElement} */ (document.getElementById("warningsQueueButton"));
const sendHint = /** @type {HTMLDivElement} */ (document.getElementById("sendHint"));
const whiteboardOverlay = /** @type {HTMLDivElement} */ (document.getElementById("whiteboardOverlay"));
const whiteboardFrame = /** @type {HTMLIFrameElement} */ (document.getElementById("whiteboardFrame"));
const whiteboardCloseButton = /** @type {HTMLButtonElement} */ (document.getElementById("whiteboardClose"));
const whiteboardError = /** @type {HTMLDivElement} */ (document.getElementById("whiteboardError"));
const artifactSrc = frame.dataset.artifactSrc || frame.getAttribute?.("data-artifact-src") || frame.src || "";

const queued = loadQueuedPrompts();
let annotation = true;
let ended = false;
let agentPresence = "waiting";
let pendingSnapshot = "";
const layoutGateEnabled = sessionData.layoutGateEnabled !== false;
const configuredLayoutGateMaxHoldMs = Number(sessionData.layoutGateMaxHoldMs);
const layoutGateMaxHoldMs =
  Number.isFinite(configuredLayoutGateMaxHoldMs) && configuredLayoutGateMaxHoldMs > 0
    ? Math.min(configuredLayoutGateMaxHoldMs, 60_000)
    : 12_000;
let layoutGateVisible = false;
let layoutGateArmed = false;
let layoutGateManuallyBypassed = !layoutGateEnabled;
let layoutGateFailureActive = false;
let layoutGateCycle = 0;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let layoutGateTimer;
// The warning inbox is server-owned review state. The chrome renders it and posts triage
// actions; it never decides on its own that a warning went away.
let layoutWarnings = Array.isArray(sessionData.initialLayoutWarnings) ? sessionData.initialLayoutWarnings : [];
const selectedWarningIds = new Set(loadJsonState(warningSelectionStorageKey, []));
let warningsDrawerOpen = false;
const snapshotRequests = [];
let endAfterSubmit = false;
let workingBubble = null;
let submitQueuedPromise = null;
let submitQueuedAgain = false;
let lastScroll = { x: 0, y: 0 };
// In-iframe review context (an open annotation card's unsent text, Lavish-owned question
// answers). The sandbox means the chrome cannot read it back after a reload, so the SDK reports
// it as it changes and the chrome replays it once the new document is up.
let lastReviewState = null;
const ARTIFACT_SILENCE_PROBE_MS = 8000;
const ARTIFACT_LOAD_BEGIN_RETRY_DELAYS_MS = [100, 300];
// Backoff for retrying a whole begin-load attempt after its in-call retries ran out. The
// in-call retries span 400ms, which only covers a slow response - not the multi-second window
// where the server is being replaced (a version-driven restart, or another `lavish-axi <file>`
// invocation restarting the shared server). Without these the chrome abandons the artifact for
// good: the frame is never navigated, `artifact_revision` never advances, and the page sits on
// the layout gate and then on an empty frame with nothing to click.
const ARTIFACT_LOAD_RECOVERY_DELAYS_MS = [1000, 3000, 8000, 20000];
// How long a chrome told to reload after a server restart keeps probing /health before giving
// up, and how long it waits for an outage to appear at all before treating a healthy answer as
// "the server never went away".
const CHROME_RESTART_SETTLE_MS = 5000;
const CHROME_RESTART_WAIT_MS = 60000;
// Probe fast while the replacement is expected to bind, then back off: a server that never comes
// back would otherwise spend the whole wait filling the network log with refused connections.
const CHROME_RESTART_PROBE_MS = 100;
const CHROME_RESTART_SLOW_PROBE_MS = 500;
let artifactLoadToken = "";
let artifactLoadRevision = Number(sessionData.initialArtifactRevision) || 0;
let artifactLoadRequestSequence = Number(sessionData.initialArtifactLoadSequence) || 0;
let chromeLoadToken = String(sessionData.chromeLoadToken || "");
artifactLoadToken = String(sessionData.initialArtifactLoadToken || "");
let artifactSpokeToken = "";
let artifactMessageSequence = 0;
let layoutDiagnosticSequence = 0;
let artifactLoadRecoveryAttempt = 0;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let artifactLoadRecoveryTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let artifactSilenceTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let copyHintTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let sendHintTimer;

function artifactFrameSrcForLoad(load) {
  const separator = artifactSrc.includes("?") ? "&" : "?";
  return (
    artifactSrc +
    separator +
    "artifact_revision=" +
    encodeURIComponent(load.revision) +
    "&artifact_load_token=" +
    encodeURIComponent(load.token)
  );
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

function loadJsonState(storageKey, fallback) {
  try {
    const raw = sessionStorage.getItem(storageKey);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveJsonState(storageKey, value) {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // The in-memory state still works if browser storage is unavailable.
  }
}

// A queued prompt is authored by the untrusted artifact iframe, so its attachment
// refs are validated at the single boundary every prompt crosses before it is
// persisted or rendered. Anything that is not a well-formed `{id}` object is
// dropped: the queue is written to sessionStorage BEFORE it renders, so one bad
// entry would throw out of render(), stay on disk, and throw again on every
// reload - wedging the tab permanently instead of failing once. The card's own
// flow only ever produces `{id, name}`, so a malformed entry is fabricated and
// there is no user image to preserve. The server re-validates independently.
// Each surviving ref is PROJECTED onto a fresh primitives-only object rather than
// kept by reference: postMessage delivers a structured clone, which faithfully
// preserves BigInt values and cycles that `JSON.stringify` then refuses. Passing
// the artifact's own object through would carry that junk into sessionStorage and
// the POST body, where the throw makes the queue unsendable - the same wedge as a
// poisoned entry, just one step later.
function sanitizeAttachmentRefs(value) {
  if (!Array.isArray(value)) return [];
  const refs = [];
  for (const ref of value) {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) continue;
    if (typeof ref.id !== "string" || !ref.id) continue;
    const projected = { id: ref.id };
    if (typeof ref.name === "string" && ref.name) projected.name = ref.name;
    refs.push(projected);
  }
  return refs;
}

function sanitizeQueuedPrompt(prompt) {
  if (!prompt || typeof prompt !== "object") return null;
  if (!("attachments" in prompt)) return prompt;
  const clean = { ...prompt };
  const refs = sanitizeAttachmentRefs(clean.attachments);
  if (refs.length) clean.attachments = refs;
  else delete clean.attachments;
  return clean;
}

function loadQueuedPrompts() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(queueStorageKey) || "[]");
    // Also sanitize on restore: a tab poisoned before this guard existed still has
    // the bad prompt on disk and would otherwise stay wedged after an upgrade.
    return Array.isArray(parsed) ? parsed.map(sanitizeQueuedPrompt).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function persistQueuedPrompts() {
  try {
    if (queued.length) {
      sessionStorage.setItem(queueStorageKey, JSON.stringify(queued));
    } else {
      sessionStorage.removeItem(queueStorageKey);
    }
  } catch {
    // The in-memory queue still works if browser storage is unavailable.
  }
}

function promptTargetLabel(prompt) {
  if (prompt?.target?.type === "table-cell") {
    const semantic = [prompt.target.rowLabel, prompt.target.columnLabel].filter(Boolean).join(" → ");
    if (semantic) return semantic;
  }
  return String(prompt?.selector || "");
}

function render() {
  annotationPills.innerHTML = queued
    .map((prompt, index) => {
      const targetLabel = promptTargetLabel(prompt);
      const showLocator = targetLabel && prompt.selector && targetLabel !== prompt.selector;
      return (
        '<div class="pill-wrap"><div class="pill"><span class="pill-preview">' +
        escapeHtml(
          prompt.prompt ||
            (attachmentCount(prompt) ? (prompt.tag === "message" ? "Image message" : "Image annotation") : ""),
        ) +
        "</span>" +
        pillAttachmentsHtml(prompt) +
        '<button class="pill-close" type="button" aria-label="Remove queued prompt" data-index="' +
        index +
        '"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div><div class="pill-tooltip">' +
        (targetLabel
          ? '<div class="tooltip-label">Target</div><div class="pill-tooltip-target">' +
            escapeHtml(targetLabel) +
            "</div>"
          : "") +
        (showLocator
          ? '<div class="tooltip-label">Locator</div><div class="pill-tooltip-target">' +
            escapeHtml(prompt.selector) +
            "</div>"
          : "") +
        '<div class="tooltip-label">Prompt</div><div class="pill-tooltip-prompt">' +
        escapeHtml(prompt.prompt) +
        "</div></div></div>"
      );
    })
    .join("");

  for (const button of annotationPills.querySelectorAll(".pill-close")) {
    const closeButton = /** @type {HTMLButtonElement} */ (button);
    closeButton.addEventListener("click", (event) => removeQueuedPrompt(Number(closeButton.dataset.index), event));
  }
  updateSendState();
  scrollPanelToBottom();
}

function updateSendState() {
  sendButton.disabled = ended || agentPresence === "working";
  sendAndEndButton.disabled = sendButton.disabled;
  if (warningsQueueButton) updateWarningSelectionState();
}

function attachmentCount(prompt) {
  return Array.isArray(prompt.attachments) ? prompt.attachments.length : 0;
}

// How many thumbnails the compact pill shows before the rest collapse into a badge.
const PILL_THUMBNAIL_LIMIT = 4;

// Thumbnails for a queued prompt's images, served straight from the same-origin
// attachment endpoint (the ids are already server-vetted at upload time). The pill
// has room for only a few, but the per-prompt cap is configurable
// (LAVISH_AXI_MAX_ATTACHMENTS_PER_PROMPT), so a prompt can legitimately carry more
// than fit: the remainder collapses into a +N badge rather than being dropped from
// the preview, which would make the queue look like it lost the extra images (W-A).
function pillAttachmentsHtml(prompt) {
  const count = attachmentCount(prompt);
  if (!count) return "";
  const hidden = count - PILL_THUMBNAIL_LIMIT;
  return (
    '<span class="pill-attachments">' +
    prompt.attachments
      .slice(0, PILL_THUMBNAIL_LIMIT)
      .map((attachment) => {
        const alt = escapeHtml(attachment.name || "image");
        return (
          '<img class="pill-attachment" src="/api/' +
          encodeURIComponent(key) +
          "/attachments/" +
          encodeURIComponent(attachment.id) +
          '" alt="' +
          alt +
          '" title="' +
          alt +
          '">'
        );
      })
      .join("") +
    (hidden > 0
      ? '<span class="pill-attachment-more" title="' +
        hidden +
        " more image" +
        (hidden === 1 ? "" : "s") +
        '">+' +
        hidden +
        "</span>"
      : "") +
    "</span>"
  );
}

const DEFAULT_SEND_HINT = "Write a message or annotate an element first.";

function showSendHint(message = DEFAULT_SEND_HINT, holdMs = 2600) {
  sendHint.textContent = message;
  sendHint.hidden = false;
  clearTimeout(sendHintTimer);
  sendHintTimer = setTimeout(() => {
    sendHint.hidden = true;
    sendHint.textContent = DEFAULT_SEND_HINT;
  }, holdMs);
  chatInput.focus();
}

function hideSendHint() {
  clearTimeout(sendHintTimer);
  sendHint.hidden = true;
}

function setMenuOpen(button, menu, open) {
  menu.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
}

function closeMenus() {
  setMenuOpen(moreButton, moreMenu, false);
}

function toggleMenu(button, menu) {
  const open = menu.hidden;
  closeMenus();
  setMenuOpen(button, menu, open);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea-based fallback below.
  }
  const helper = document.createElement("textarea");
  helper.value = text;
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.appendChild(helper);
  helper.select();
  document.execCommand("copy");
  helper.remove();
  return true;
}

function addChat(role, text, shouldScroll = true) {
  if (!text) return;

  const el = document.createElement("div");
  el.className = "bubble " + role;
  el.innerHTML = "<small>" + (role === "agent" ? "Agent" : "You") + "</small><div>" + escapeHtml(text) + "</div>";
  chatLog.appendChild(el);
  if (shouldScroll) scrollElementIntoView(el);
  return el;
}

function syncChat(chat) {
  for (const el of [...chatLog.querySelectorAll(".bubble.user,.bubble.agent:not(.agent-working)")]) {
    el.remove();
  }

  let lastChatBubble = null;
  for (const item of chat) lastChatBubble = addChat(item.role, item.text, false) || lastChatBubble;
  if (workingBubble) {
    chatLog.appendChild(workingBubble);
    scrollElementIntoView(workingBubble);
  } else if (lastChatBubble) {
    scrollElementIntoView(lastChatBubble);
  }
}

function setAgentPresence(state) {
  agentPresence = state === "listening" || state === "working" ? state : "waiting";
  updateSendState();
  if (presenceBanner) presenceBanner.hidden = ended || agentPresence !== "waiting";

  if (agentPresence !== "working") {
    if (workingBubble) workingBubble.remove();
    workingBubble = null;
    return;
  }

  if (!workingBubble) {
    workingBubble = document.createElement("div");
    workingBubble.className = "bubble agent agent-working";
    workingBubble.innerHTML = '<span class="spinner"></span><span>Working...</span>';
    chatLog.appendChild(workingBubble);
  }
  scrollElementIntoView(workingBubble);
}

function setHandoffSuperseded(visible) {
  if (handoffBanner) handoffBanner.hidden = ended || !visible;
}

async function refreshChromeLoadHandoff(requestSequence) {
  const response = await fetch("/api/" + key + "/chrome-loads/begin", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  const data = await response.json().catch(() => ({}));
  const token = String(data?.chrome_load_token || "");
  if (!response.ok || !token) throw new Error("failed to refresh chrome handoff");
  if (requestSequence !== artifactLoadRequestSequence || ended) return false;
  chromeLoadToken = token;
  const revision = Number(data?.artifact_revision);
  const loadToken = String(data?.artifact_load_token || "");
  if (Number.isSafeInteger(revision) && revision >= 0) artifactLoadRevision = revision;
  if (loadToken) artifactLoadToken = loadToken;
  return true;
}

function scrollPanelToBottom() {
  panelScroll.scrollTop = panelScroll.scrollHeight;
}

function scrollElementIntoView(el) {
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function removeQueuedPrompt(index, event) {
  if (event) event.stopPropagation();
  queued.splice(index, 1);
  persistQueuedPrompts();
  render();
}

function promptQueueKey(prompt) {
  return prompt && typeof prompt[internalQueueKeyField] === "string" ? prompt[internalQueueKeyField].trim() : "";
}

function enqueuePrompt(rawPrompt) {
  const prompt = sanitizeQueuedPrompt(rawPrompt);
  if (!prompt) return;

  const queueKey = promptQueueKey(prompt);
  if (queueKey) {
    const index = queued.findIndex((item) => promptQueueKey(item) === queueKey);
    if (index !== -1) {
      queued[index] = prompt;
    } else {
      queued.push(prompt);
    }
  } else {
    queued.push(prompt);
  }

  persistQueuedPrompts();
  render();
}

function stripInternalPromptFields(prompt) {
  if (!prompt || typeof prompt !== "object") return prompt;
  const clean = { ...prompt };
  delete clean[internalQueueKeyField];
  return clean;
}

function postToFrame(message) {
  if (frame.contentWindow) frame.contentWindow.postMessage(message, "*");
}

function requestSnapshot(action) {
  snapshotRequests.push(action);
  postToFrame({ type: "lavish:requestSnapshot" });
}

function createChatAttachmentsController() {
  const items = [];
  let nextId = 0;
  let capRejected = false;
  let sendBlocked = false;

  function currentImageCount() {
    return items.filter((item) => item.file && CHAT_ATTACHMENT_MIME.has(item.file.type)).length;
  }

  function renderAttachments() {
    chatAttachments.innerHTML = items
      .map((item) => {
        const status = item.status === "uploading" ? "Uploading…" : item.status === "error" ? item.error : "";
        const preview = item.preview
          ? '<img class="chat-attachment-thumb" src="' + escapeHtml(item.preview) + '" alt="">'
          : "";
        const retry =
          item.status === "error" && item.file
            ? '<button type="button" aria-label="Retry ' +
              escapeHtml(item.name) +
              '" data-chat-attachment-retry="' +
              item.localId +
              '">Retry</button>'
            : "";
        const errorData = item.errorCode ? ' data-error="' + escapeHtml(item.errorCode) + '"' : "";
        return (
          '<div class="chat-attachment-chip chat-attachment-' +
          item.status +
          '"' +
          errorData +
          ">" +
          preview +
          '<span class="chat-attachment-copy"><strong>' +
          escapeHtml(item.name) +
          "</strong>" +
          (status ? '<span class="chat-attachment-status" aria-live="polite">' + escapeHtml(status) + "</span>" : "") +
          "</span>" +
          retry +
          '<button type="button" aria-label="Remove ' +
          escapeHtml(item.name) +
          '" title="Remove ' +
          escapeHtml(item.name) +
          '" data-chat-attachment-remove="' +
          item.localId +
          '">×</button></div>'
        );
      })
      .join("");
    syncNotice();
  }

  // The notice is DERIVED from the current item states on every render, never
  // written imperatively by a caller: a blocked send that only stamped a string
  // went stale the moment the pending upload it described failed, leaving the
  // user waiting on an upload that was already over.
  function syncNotice() {
    if (currentImageCount() < attachmentMaxCount) capRejected = false;
    const pending = items.some((item) => item.status === "uploading");
    const errored = items.some((item) => item.status === "error");
    if (!pending && !errored) sendBlocked = false;
    chatAttachmentNotice.textContent =
      sendBlocked && pending
        ? "Waiting for an image to finish uploading…"
        : sendBlocked && errored
          ? "An image couldn't be attached. Retry or remove it before sending."
          : capRejected
            ? "You can attach up to " + attachmentMaxCount + " image" + (attachmentMaxCount === 1 ? "" : "s") + "."
            : "";
  }

  async function startUpload(item) {
    const abortController = new AbortController();
    item.abortController = abortController;
    item.status = "uploading";
    item.error = "";
    renderAttachments();
    try {
      const bytes = await item.file.arrayBuffer();
      if (!items.includes(item)) return;
      await uploadAttachment(
        { localId: item.localId, bytes, mime: item.file.type },
        (result) => {
          if (!items.includes(item)) return;
          if (result.ok && result.id) {
            item.status = "ready";
            item.id = result.id;
          } else {
            item.status = "error";
            item.error = String(result.error || "Upload failed");
          }
          renderAttachments();
        },
        abortController.signal,
      );
    } catch (error) {
      if (!items.includes(item)) return;
      item.status = "error";
      item.error = error instanceof Error ? error.message : String(error);
      renderAttachments();
    }
  }

  function addFiles(files) {
    let added = false;
    let imageCount = currentImageCount();
    for (const file of Array.from(files || [])) {
      if (!CHAT_ATTACHMENT_MIME.has(String(file.type || ""))) continue;
      const tooLarge = attachmentMaxBytes > 0 && Number(file.size) > attachmentMaxBytes;
      // The cap counts only chips that can upload, mirroring currentImageCount:
      // if a size-refused chip (file: null) consumed a slot here, syncNotice
      // would clear the cap notice on the same render tick and a valid image
      // later in the batch would vanish with no chip and no explanation.
      if (!tooLarge && imageCount >= attachmentMaxCount) {
        capRejected = true;
        continue;
      }
      const localId = String(nextId++);
      const item = {
        localId,
        file: tooLarge ? null : file,
        name: String(file.name || "image"),
        preview: tooLarge ? "" : URL.createObjectURL(file),
        status: tooLarge ? "error" : "uploading",
        error: tooLarge ? "Image is larger than the " + formatByteLimit(attachmentMaxBytes) + " limit" : "",
        errorCode: "",
        id: "",
        abortController: /** @type {AbortController | null} */ (null),
      };
      items.push(item);
      if (!tooLarge) imageCount += 1;
      added = true;
      if (!tooLarge) startUpload(item);
    }
    renderAttachments();
    return added;
  }

  function rejectUnsupported(files) {
    for (const file of Array.from(files || [])) {
      if (CHAT_ATTACHMENT_MIME.has(String(file.type || ""))) continue;
      items.push({
        localId: String(nextId++),
        file: null,
        name: String(file.name || "file"),
        preview: "",
        status: "error",
        error: "Unsupported file type. Use " + CHAT_ATTACHMENT_LABELS + ".",
        errorCode: "UNSUPPORTED_TYPE",
        id: "",
        abortController: /** @type {AbortController | null} */ (null),
      });
    }
    renderAttachments();
  }

  function remove(localId) {
    const index = items.findIndex((item) => item.localId === localId);
    if (index < 0) return;
    const [item] = items.splice(index, 1);
    item.abortController?.abort();
    if (item.preview) URL.revokeObjectURL(item.preview);
    renderAttachments();
  }

  function reset() {
    for (const item of items) {
      item.abortController?.abort();
      if (item.preview) URL.revokeObjectURL(item.preview);
    }
    items.length = 0;
    capRejected = false;
    sendBlocked = false;
    renderAttachments();
  }

  return {
    addFiles,
    rejectUnsupported,
    remove,
    retry(localId) {
      const item = items.find((candidate) => candidate.localId === localId);
      if (item?.file) startUpload(item);
    },
    hasPending: () => items.some((item) => item.status === "uploading"),
    hasErrors: () => items.some((item) => item.status === "error"),
    noteSendBlocked() {
      sendBlocked = true;
      syncNotice();
    },
    collectReady: () =>
      items.filter((item) => item.status === "ready").map((item) => ({ id: item.id, name: item.name })),
    reset,
  };
}

const chatAttachmentController = createChatAttachmentsController();

function sendQueued(endAfter) {
  if (ended || agentPresence === "working") return;
  closeMenus();

  // A pending or failed chip holds back only the COMPOSER message (and an
  // explicit end, which would strand the chips) - queued annotation prompts
  // still deliver, mirroring how the annotation card holds only its own card
  // open. Gating the whole pipeline here made Send and Send & End silently
  // deliver nothing while the only signal sat in the composer toolbar.
  const chipsBlocked = chatAttachmentController.hasPending() || chatAttachmentController.hasErrors();
  if (chipsBlocked) chatAttachmentController.noteSendBlocked();

  if (!chipsBlocked) {
    const text = chatInput.value.trim();
    const attachments = chatAttachmentController.collectReady();
    if (text || attachments.length) {
      const prompt = { uid: "", prompt: text, selector: "", tag: "message", text: "Freeform message" };
      if (attachments.length) prompt.attachments = attachments;
      queued.push(prompt);
      persistQueuedPrompts();
      addChat("user", text || "Image message");
      chatInput.value = "";
      chatAttachmentController.reset();
      render();
    }
  }
  if (!queued.length) {
    if (!chipsBlocked) showSendHint();
    return;
  }
  hideSendHint();

  if (endAfter && !chipsBlocked) endAfterSubmit = true;
  requestSnapshot("submit");
}

async function submitQueued() {
  if (submitQueuedPromise) {
    submitQueuedAgain = true;
    return submitQueuedPromise;
  }

  let succeeded = false;
  submitQueuedPromise = submitQueuedOnce();
  try {
    const result = await submitQueuedPromise;
    succeeded = result !== false;
    return result;
  } finally {
    submitQueuedPromise = null;
    const shouldSubmitAgain = submitQueuedAgain;
    submitQueuedAgain = false;
    if (!succeeded) {
      endAfterSubmit = false;
    } else if (!ended && shouldSubmitAgain) {
      if (queued.length) {
        submitQueued().catch(() => {});
      } else if (endAfterSubmit) {
        endAfterSubmit = false;
        endSession();
      }
    }
  }
}

async function submitQueuedOnce() {
  const prompts = queued.slice();
  const shouldEndSession = endAfterSubmit;
  const body = { prompts: prompts.map(stripInternalPromptFields), domSnapshot: pendingSnapshot };
  if (shouldEndSession) body.endSession = true;
  const response = await fetch("/api/" + key + "/prompts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    if (response.status === 409) {
      const data = await response.json().catch(() => null);
      if (Array.isArray(data?.warnings)) setLayoutWarnings(data.warnings);
      endAfterSubmit = false;
      return false;
    }
    // C4: the server persisted nothing (atomic reject) - the queue below is left
    // intact because the splice only runs on success. Surface exactly what failed
    // so the user can fix the offending attachment(s) rather than losing them.
    if (response.status === 400) {
      const detail = await response.json().catch(() => ({}));
      if (Array.isArray(detail.rejected) && detail.rejected.length) {
        showSendHint(describeAttachmentRejection(detail.rejected, detail.caps), 6000);
      }
    }
    throw new Error("failed to submit queued prompts");
  }
  for (const prompt of prompts) {
    const index = queued.indexOf(prompt);
    if (index !== -1) queued.splice(index, 1);
  }
  persistQueuedPrompts();
  render();
  if (shouldEndSession) {
    endAfterSubmit = false;
    markSessionEnded();
    return;
  }
  if (agentPresence === "listening") setAgentPresence("working");
}

function normalizeLayoutFindings(value) {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === "object" && String(item.severity || "").toLowerCase() === "error")
    : [];
}

function clearLayoutGateTimer() {
  if (layoutGateTimer) clearTimeout(layoutGateTimer);
  layoutGateTimer = undefined;
}

function setLayoutGateCard(state) {
  if (!layoutGateTitle || !layoutGateCopy) return;

  if (state === "held") {
    layoutGateTitle.innerHTML = "Fixing a layout issue...";
    layoutGateCopy.textContent =
      "The browser found inaccessible or unusable content. Your agent has been notified and this will reveal after the next clean reload.";
    return;
  }

  layoutGateTitle.innerHTML = "Checking layout.<br>One moment.";
  layoutGateCopy.textContent = "Lavish is waiting for fonts and final geometry before revealing this artifact.";
}

function setLayoutGateActive(active) {
  layoutGateVisible = active;
  if (layoutGateOverlay) layoutGateOverlay.hidden = !active;
  document.body?.classList?.toggle("layout-gate-active", active);
}

// Terminal, user-recoverable failure state for the one thing the chrome cannot work around on
// its own: the artifact never loaded and retrying stopped helping. The overlay is reused because
// it already covers the empty artifact area; without this the user is left looking at either a
// spinner that never resolves or a blank frame, with nothing explaining it and nothing to click.
// Bumping the cycle retires any pending reveal timer so a stale one cannot hide this card.
function setLayoutGateFailure(title, copy, actionLabel = "Reload") {
  if (ended) return;
  layoutGateFailureActive = true;
  layoutGateCycle += 1;
  clearLayoutGateTimer();
  layoutGateArmed = false;
  if (layoutGateTitle) layoutGateTitle.textContent = title;
  if (layoutGateCopy) layoutGateCopy.textContent = copy;
  if (layoutGateAction) {
    layoutGateAction.textContent = actionLabel;
    layoutGateAction.onclick = () => location.reload();
  }
  setLayoutGateActive(true);
}

// A load attempt that gets going again retires the failure card. This runs even when the gate is
// disabled or the user already bypassed it, because otherwise the card would keep covering an
// artifact that has since loaded.
function clearLayoutGateFailure() {
  if (!layoutGateFailureActive) return;
  layoutGateFailureActive = false;
  if (layoutGateAction) {
    layoutGateAction.textContent = "Show anyway";
    layoutGateAction.onclick = () => forceRevealLayoutGate("manual");
  }
  revealLayoutGate();
}

function revealLayoutGate() {
  clearLayoutGateTimer();
  layoutGateArmed = false;
  setLayoutGateActive(false);
}

function forceRevealLayoutGate(reason) {
  if (!layoutGateEnabled || ended) return;
  if (reason === "manual") layoutGateManuallyBypassed = true;
  revealLayoutGate();
}

function startLayoutGateCycle() {
  clearLayoutGateFailure();
  if (!layoutGateEnabled || layoutGateManuallyBypassed || ended) return;

  layoutGateCycle += 1;
  layoutGateArmed = true;
  setLayoutGateCard("checking");
  setLayoutGateActive(true);
  clearLayoutGateTimer();

  const cycle = layoutGateCycle;
  layoutGateTimer = setTimeout(() => {
    if (cycle !== layoutGateCycle || !layoutGateVisible || ended) return;
    forceRevealLayoutGate("timeout");
  }, layoutGateMaxHoldMs);
  layoutGateTimer?.unref?.();
}

// The gate only waits for fonts and final geometry now. It never holds the artifact hostage
// pending an agent repair: findings are the user's to triage, so a completed pass always reveals
// and hands the result to the passive inbox.
function handleLayoutGatePass() {
  if (!layoutGateEnabled || layoutGateManuallyBypassed) return;
  if (!layoutGateArmed && !layoutGateVisible) return;
  revealLayoutGate();
}

function initializeLayoutGate() {
  if (!layoutGateEnabled) {
    setLayoutGateActive(false);
    return;
  }

  if (layoutGateAction) layoutGateAction.onclick = () => forceRevealLayoutGate("manual");
  startLayoutGateCycle();
}

// ---------------------------------------------------------------------------
// Passive layout-warning inbox
// ---------------------------------------------------------------------------

async function submitLayoutDiagnostics(pass) {
  const response = await fetch("/api/" + key + "/layout-diagnostics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      complete: pass?.complete !== false,
      target_presence_complete: pass?.targetPresenceComplete === true,
      artifact_revision: Number(pass?.artifactRevision) || 0,
      artifact_load_token: String(pass?.artifactLoadToken || artifactLoadToken),
      artifact_pass_sequence: Number(pass?.artifactPassSequence) || 0,
      viewport_width: Number(pass?.viewportWidth) || 0,
      findings: normalizeLayoutFindings(pass?.findings),
    }),
  });
  if (!response.ok) throw new Error("failed to submit layout diagnostics");
  return response.json();
}

async function reportArtifactFailures(failures, loadToken = artifactLoadToken) {
  if (loadToken !== artifactLoadToken) return;
  await fetch("/api/" + key + "/artifact-failures", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ failures, artifact_load_token: loadToken, artifact_revision: artifactLoadRevision }),
  });
}

// The narrow fatal probe. A healthy artifact boots its SDK and starts talking within seconds; if
// nothing ever arrives we ask the server whether the document is servable at all. Probing only on
// silence keeps the normal path to a single artifact request, and a non-OK answer is the one
// signal that separates "the review is unusable" from "the review has layout problems".
function armArtifactAvailabilityProbe(loadToken = artifactLoadToken) {
  clearTimeout(artifactSilenceTimer);
  artifactSilenceTimer = setTimeout(() => {
    if (loadToken !== artifactLoadToken) return;
    probeArtifactAvailability(loadToken).catch(() => {});
  }, ARTIFACT_SILENCE_PROBE_MS);
  artifactSilenceTimer?.unref?.();
}

function artifactProbeSrc() {
  const separator = artifactSrc.includes("?") ? "&" : "?";
  return (
    artifactSrc +
    separator +
    "probe=1&artifact_revision=" +
    encodeURIComponent(artifactLoadRevision) +
    "&artifact_load_token=" +
    encodeURIComponent(artifactLoadToken)
  );
}

async function probeArtifactAvailability(loadToken) {
  if (loadToken !== artifactLoadToken) return;
  try {
    const response = await fetch(artifactProbeSrc(), { cache: "no-store" });
    if (loadToken !== artifactLoadToken) return;
    if (response.status === 409) return;
    if (response.ok) return;
    await reportArtifactFailures(
      [{ kind: "artifact-unavailable", detail: "the artifact document responded with HTTP " + response.status }],
      loadToken,
    );
  } catch {
    // A transient fetch failure is uncertainty, not proof - stay silent.
  }
}

function activeWarnings() {
  return layoutWarnings.filter((warning) => warning && warning.active);
}

function pendingLayoutWarningIds() {
  const ids = new Set();
  for (const prompt of queued) {
    if (prompt?.tag !== "layout-warnings" || prompt.target?.type !== "layout-warnings") continue;
    for (const warning of Array.isArray(prompt.target.warnings) ? prompt.target.warnings : []) {
      if (warning?.id) ids.add(String(warning.id));
    }
  }
  return ids;
}

function setLayoutWarnings(next) {
  layoutWarnings = Array.isArray(next) ? next : [];
  // Selections only ever reference warnings the user may still act on.
  const pending = pendingLayoutWarningIds();
  const selectable = new Set(
    layoutWarnings.filter((warning) => warning.selectable && !pending.has(warning.id)).map((warning) => warning.id),
  );
  for (const id of [...selectedWarningIds]) {
    if (!selectable.has(id)) selectedWarningIds.delete(id);
  }
  persistWarningSelection();
  renderWarnings();
}

function persistWarningSelection() {
  saveJsonState(warningSelectionStorageKey, [...selectedWarningIds]);
}

function warningRelativeTime(value) {
  const at = Date.parse(String(value || ""));
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + "h ago";
  return Math.round(hours / 24) + "d ago";
}

function createWarningChip(text, extraClass) {
  const chip = document.createElement("span");
  chip.className = "warning-chip" + (extraClass ? " " + extraClass : "");
  chip.textContent = text;
  return chip;
}

function createWarningRow(warning) {
  const row = document.createElement("div");
  row.className = "warning-row" + (warning.outstanding ? " is-outstanding" : "");
  row.dataset.warningId = warning.id;
  const pending = pendingLayoutWarningIds().has(warning.id);
  const selectable = warning.selectable && !pending;
  const unavailableLabel = pending ? "is queued to send" : "is already queued for a fix";
  const statusLabel = pending ? "Queued for send" : warning.status_label;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "warning-select";
  checkbox.checked = selectable && selectedWarningIds.has(warning.id);
  checkbox.disabled = !selectable;
  checkbox.setAttribute(
    "aria-label",
    selectable
      ? "Select " + warning.title + " on " + warning.viewport_label
      : warning.title + " on " + warning.viewport_label + " " + unavailableLabel,
  );
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) selectedWarningIds.add(warning.id);
    else selectedWarningIds.delete(warning.id);
    persistWarningSelection();
    updateWarningSelectionState();
  });
  row.appendChild(checkbox);

  const body = document.createElement("div");
  body.className = "warning-body";

  const title = document.createElement("div");
  title.className = "warning-title";
  title.textContent = warning.title;
  body.appendChild(title);

  const explanation = document.createElement("p");
  explanation.className = "warning-explanation";
  explanation.textContent = warning.explanation;
  body.appendChild(explanation);

  const meta = document.createElement("div");
  meta.className = "warning-meta";
  meta.appendChild(createWarningChip("Severe", "severity"));
  meta.appendChild(createWarningChip(statusLabel, "status-" + warning.status));
  meta.appendChild(createWarningChip(warning.viewport_label + " · " + warning.viewport_width + "px"));
  const seen = warningRelativeTime(warning.last_seen_at);
  if (seen) meta.appendChild(createWarningChip("Seen " + seen));
  body.appendChild(meta);

  const target = document.createElement("code");
  target.className = "warning-target";
  target.textContent = warning.selector || "(whole page)";
  body.appendChild(target);

  const actions = document.createElement("div");
  actions.className = "warning-actions";
  if (warning.selector) {
    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.className = "warning-action";
    reveal.textContent = "Reveal";
    reveal.setAttribute("aria-label", "Reveal " + warning.title + " in the artifact");
    reveal.addEventListener("click", () => revealWarning(warning));
    actions.appendChild(reveal);
  }
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "warning-action";
  dismiss.textContent = "Dismiss";
  dismiss.disabled = !selectable;
  dismiss.setAttribute(
    "aria-label",
    selectable
      ? "Dismiss " + warning.title + " for this artifact revision"
      : warning.title + " cannot be dismissed while " + (pending ? "queued to send" : "a fix is queued"),
  );
  dismiss.addEventListener("click", () => dismissWarning(warning.id));
  actions.appendChild(dismiss);
  body.appendChild(actions);

  row.appendChild(body);
  return row;
}

function renderWarnings() {
  if (!warningsWrap) return;
  const pending = pendingLayoutWarningIds();
  let selectionChanged = false;
  for (const id of [...selectedWarningIds]) {
    if (pending.has(id)) {
      selectedWarningIds.delete(id);
      selectionChanged = true;
    }
  }
  if (selectionChanged) persistWarningSelection();
  const active = activeWarnings();
  const count = active.length;

  warningsWrap.hidden = count === 0 || ended;
  if (warningsWrap.hidden && warningsDrawerOpen) setWarningsDrawerOpen(false);
  warningsCount.textContent = String(count);
  warningsButton.setAttribute(
    "aria-label",
    count === 1 ? "1 unresolved layout issue" : count + " unresolved layout issues",
  );

  const outstanding = active.filter((warning) => warning.outstanding).length;
  warningsSummary.textContent =
    (count === 1 ? "1 unresolved issue" : count + " unresolved issues") +
    (outstanding > 0 ? " · " + outstanding + " already queued for a fix" : "");

  warningsList.replaceChildren();
  if (count === 0) {
    const empty = document.createElement("p");
    empty.className = "warnings-empty";
    empty.textContent = "No unresolved layout issues.";
    warningsList.appendChild(empty);
  } else {
    for (const warning of active) warningsList.appendChild(createWarningRow(warning));
  }
  updateWarningSelectionState();
}

function updateWarningSelectionState() {
  const pending = pendingLayoutWarningIds();
  const selectable = activeWarnings().filter((warning) => warning.selectable && !pending.has(warning.id));
  const selectedCount = selectable.filter((warning) => selectedWarningIds.has(warning.id)).length;
  warningsSelectAll.disabled = selectable.length === 0;
  // Default selection is never "everything": Select all is an explicit action.
  warningsSelectAll.checked = selectable.length > 0 && selectedCount === selectable.length;
  warningsSelectAll.indeterminate = selectedCount > 0 && selectedCount < selectable.length;
  warningsSelected.textContent = selectedCount === 0 ? "None selected" : selectedCount + " selected";
  warningsQueueButton.disabled = selectedCount === 0 || ended || agentPresence === "working";
}

function toggleSelectAllWarnings() {
  const pending = pendingLayoutWarningIds();
  const selectable = activeWarnings().filter((warning) => warning.selectable && !pending.has(warning.id));
  const shouldSelect = warningsSelectAll.checked;
  for (const warning of selectable) {
    if (shouldSelect) selectedWarningIds.add(warning.id);
    else selectedWarningIds.delete(warning.id);
  }
  persistWarningSelection();
  renderWarnings();
}

function setWarningsDrawerOpen(open) {
  warningsDrawerOpen = open && !ended;
  warningsDrawer.hidden = !warningsDrawerOpen;
  warningsButton.setAttribute("aria-expanded", String(warningsDrawerOpen));
  if (warningsDrawerOpen) {
    closeMenus();
    warningsSelectAll.focus();
  }
}

function toggleWarningsDrawer() {
  setWarningsDrawerOpen(warningsDrawer.hidden);
}

function closeWarningsDrawer({ restoreFocus = false } = {}) {
  if (!warningsDrawerOpen) return;
  setWarningsDrawerOpen(false);
  if (restoreFocus) warningsButton.focus();
}

function revealWarning(warning) {
  postToFrame({ type: "lavish:revealElement", selector: warning.selector });
}

async function dismissWarning(id) {
  try {
    const response = await fetch("/api/" + key + "/layout-warnings/dismiss", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!response.ok) throw new Error("failed to dismiss layout warning");
    const data = await response.json();
    if (Array.isArray(data.warnings)) setLayoutWarnings(data.warnings);
  } catch {
    // Leave the warning in place - a failed dismissal must never look like a resolution.
  }
}

// One queued batch = one ordinary queued prompt. The CLI cannot tell it apart from any other
// feedback, which is exactly the point: no parallel agent protocol.
async function queueSelectedWarningFixes() {
  if (ended || agentPresence === "working") return;
  const ids = [...selectedWarningIds];
  if (ids.length === 0) return;
  warningsQueueButton.disabled = true;
  try {
    const response = await fetch("/api/" + key + "/layout-warnings/queue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!response.ok) throw new Error("failed to queue layout warning fixes");
    const data = await response.json();
    if (data.prompt) {
      enqueuePrompt({
        uid: "",
        prompt: data.prompt.prompt,
        selector: "",
        tag: "layout-warnings",
        text: data.prompt.text,
        target: data.prompt.target,
      });
    }
    selectedWarningIds.clear();
    persistWarningSelection();
    if (Array.isArray(data.warnings)) setLayoutWarnings(data.warnings);
    closeWarningsDrawer({ restoreFocus: true });
  } catch {
    updateWarningSelectionState();
  }
}

async function refreshLayoutWarnings() {
  try {
    const response = await fetch("/api/" + key + "/layout-warnings");
    if (!response.ok) return;
    const data = await response.json();
    if (Array.isArray(data.warnings)) setLayoutWarnings(data.warnings);
  } catch {
    // Keep whatever the chrome already has; never clear on a failed refresh.
  }
}

async function endSession() {
  if (ended) return;
  const response = await fetch("/api/" + key + "/end", { method: "POST" });
  if (!response.ok) throw new Error("failed to end session");
  markSessionEnded();
}

function markSessionEnded() {
  if (ended) return;
  ended = true;
  cancelArtifactLoadRecovery();
  closeMenus();
  closeWarningsDrawer();
  renderWarnings();
  closeWhiteboard();
  annotationSwitch.disabled = true;
  moreButton.disabled = true;
  chatInput.disabled = true;
  updateSendState();
  if (presenceBanner) presenceBanner.hidden = true;
  if (handoffBanner) handoffBanner.hidden = true;
  layoutGateManuallyBypassed = true;
  revealLayoutGate();
  postToFrame({ type: "lavish:setAnnotationMode", enabled: false });
  endedOverlay.hidden = false;
}

function copyFilePath() {
  copyText(filePath);
  copyHint.classList.add("copied");
  copyHintText.textContent = "Copied";
  clearTimeout(copyHintTimer);
  copyHintTimer = setTimeout(() => {
    copyHint.classList.remove("copied");
    copyHintText.textContent = "Copy";
  }, 1600);
}

function copyDomSnapshot() {
  closeMenus();
  requestSnapshot("copy");
}

function exportFileName() {
  const base = (filePath.split(/[\\/]/).pop() || "artifact.html").replace(/\.html?$/i, "");
  return (base || "artifact") + ".export.html";
}

function setExportLabel(text) {
  const label = exportArtifactButton.querySelector("span");
  if (label) label.textContent = text;
}

function unresolvedAssetText(count) {
  return count === 1 ? "1 unresolved asset" : `${count} unresolved assets`;
}

function noticeText(count) {
  return count === 1 ? "1 notice" : `${count} notices`;
}

function exportWarningText(unresolvedCount, noticeCount) {
  if (unresolvedCount > 0 && noticeCount > 0) {
    return `${unresolvedAssetText(unresolvedCount)} and ${noticeText(noticeCount)}`;
  }
  if (unresolvedCount > 0) return unresolvedAssetText(unresolvedCount);
  return noticeText(noticeCount);
}

async function exportArtifact() {
  // The bundle inlines local assets server-side, so it can take a moment - keep the menu open
  // and narrate progress in place instead of closing it and leaving the user with no feedback.
  exportArtifactButton.disabled = true;
  setExportLabel("Exporting...");
  try {
    const response = await fetch("/api/" + key + "/export");
    if (!response.ok) throw new Error("export failed");
    const warningCount = Number(response.headers.get("x-lavish-export-warning-count") || "0");
    const noticeCount = Number(response.headers.get("x-lavish-export-notice-count") || "0");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFileName();
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    if (warningCount > 0 || noticeCount > 0) {
      setExportLabel(`Exported with ${exportWarningText(warningCount, noticeCount)}`);
    } else {
      setExportLabel("Export standalone HTML");
      closeMenus();
    }
  } catch {
    setExportLabel("Export failed - retry");
  } finally {
    exportArtifactButton.disabled = false;
  }
}

function openShareDialog() {
  closeMenus();
  shareDialog.hidden = false;
  shareStatus.textContent = "";
  shareStatus.classList.remove("error");
  shareResult.hidden = true;
  sharePasswordInput.value = "";
  sharePasswordInput.focus();
}

function closeShareDialog() {
  shareDialog.hidden = true;
}

async function copyToButton(value, button, label) {
  await copyText(value);
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = label;
  }, 1200);
}

async function publishShare(event) {
  event.preventDefault();
  sharePublishButton.disabled = true;
  shareStatus.classList.remove("error");
  shareStatus.textContent = "Publishing to ht-ml.app...";
  shareResult.hidden = true;
  const password = sharePasswordInput.value.trim();
  const passwordProtected = Boolean(password);
  try {
    const response = await fetch("/api/" + key + "/share", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(password ? { password } : {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "publish failed");
    shareUrlInput.value = data.url || "";
    shareUpdateKeyInput.value = data.update_key || "";
    const unresolvedAssets = Array.isArray(data.unresolved_local_assets) ? data.unresolved_local_assets : [];
    const notices = Array.isArray(data.notices) ? data.notices : [];
    const warningCount = unresolvedAssets.length;
    const noticeCount = notices.length;
    const noticeSummary = noticeCount ? noticeText(noticeCount) : "";
    shareStatus.textContent =
      warningCount > 0
        ? `Published with ${warningCount === 1 ? "1 unresolved local asset" : `${warningCount} unresolved local assets`}${noticeSummary ? ` and ${noticeSummary}` : ""}.${passwordProtected ? " This page is PASSWORD-PROTECTED; viewers also need the password." : ""}`
        : noticeCount > 0
          ? `Published with ${noticeSummary}.${passwordProtected ? " This page is PASSWORD-PROTECTED; viewers also need the password." : ""}`
          : passwordProtected
            ? "Published. This page is PASSWORD-PROTECTED; viewers also need the password."
            : "Published. Anyone with the link can view this page.";
    shareResult.hidden = false;
    shareUrlInput.focus();
    shareUrlInput.select();
  } catch (error) {
    shareStatus.classList.add("error");
    shareStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    sharePublishButton.disabled = false;
  }
}

function cancelArtifactLoadRecovery() {
  if (artifactLoadRecoveryTimer) clearTimeout(artifactLoadRecoveryTimer);
  artifactLoadRecoveryTimer = undefined;
}

// Retry a begin-load attempt that failed for a recoverable reason. Returns false once the
// backoff is exhausted so the caller can surface the terminal failure. A `superseded` or
// `out-of-order` outcome never lands here: another reviewer or a newer request in this same
// chrome owns the artifact, and retrying would fight it.
function scheduleArtifactLoadRecovery() {
  if (ended) return false;
  const delay = ARTIFACT_LOAD_RECOVERY_DELAYS_MS[artifactLoadRecoveryAttempt];
  if (delay === undefined) return false;
  artifactLoadRecoveryAttempt += 1;
  const sequence = artifactLoadRequestSequence;
  cancelArtifactLoadRecovery();
  artifactLoadRecoveryTimer = setTimeout(() => {
    artifactLoadRecoveryTimer = undefined;
    if (ended || sequence !== artifactLoadRequestSequence) return;
    replaceArtifactFrame({ recoveryRetry: true }).catch(() => {});
  }, delay);
  artifactLoadRecoveryTimer?.unref?.();
  return true;
}

// The backoff budget belongs to the load attempt that started it, not to the page: anything
// asking for a fresh load - a live reload, Reload artifact, a takeover - gets the whole budget
// again, and only the recovery timer's own retries spend it down. A page that carried an
// exhausted counter forward would have no retries left at all for the next outage.
async function replaceArtifactFrame({ recoveryRetry = false } = {}) {
  cancelArtifactLoadRecovery();
  if (!recoveryRetry) artifactLoadRecoveryAttempt = 0;
  clearTimeout(artifactSilenceTimer);
  // The iframe is sandboxed, so reload by resetting the iframe URL from chrome.
  if (!artifactSrc) {
    startLayoutGateCycle();
    const currentSrc = frame.src || "about:blank";
    frame.src = currentSrc + (currentSrc.includes("?") ? "&" : "?") + "lavish_reload=" + Date.now();
    return true;
  }
  const requestSequence = ++artifactLoadRequestSequence;
  const requestId = `lavish-load-${Date.now().toString(36)}-${requestSequence}-${Math.random().toString(36).slice(2)}`;
  const previousToken = artifactLoadToken;
  const preservePreviousLoad = () => {
    if (
      requestSequence === artifactLoadRequestSequence &&
      !ended &&
      previousToken &&
      artifactSpokeToken !== previousToken
    ) {
      armArtifactAvailabilityProbe(previousToken);
    }
    return false;
  };
  // Keep whatever is on screen, then try again later. A begin-load can fail for reasons that
  // clear on their own - the shared server is mid-restart, or its handoff map was reset by that
  // restart and this chrome's one re-handshake landed in the same outage window. Giving up here
  // is what leaves the review permanently unloaded.
  const recoverLater = () => {
    preservePreviousLoad();
    if (requestSequence !== artifactLoadRequestSequence || ended) return false;
    if (scheduleArtifactLoadRecovery()) return false;
    // Out of retries. Only say so when there is nothing on screen to say it over: a chrome that
    // already shows an artifact keeps showing it rather than losing a usable review.
    if (!artifactLoadToken) {
      setLayoutGateFailure(
        "Lavish could not load this artifact.",
        "The Lavish server did not answer this review's load request. It usually restarted while this page was opening. Reload to reconnect.",
      );
    }
    return false;
  };
  let load;
  let transportAttempt = 0;
  let handoffRefreshAttempted = false;
  while (true) {
    if (requestSequence !== artifactLoadRequestSequence || ended) return false;
    try {
      const response = await fetch("/api/" + key + "/artifact-loads/begin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: requestId,
          request_sequence: requestSequence,
          chrome_load_token: chromeLoadToken,
        }),
      });
      const candidate = await response.json().catch(() => ({}));
      if (!response.ok) {
        const status = String(candidate?.status || "");
        if (status === "no-handoff") {
          // One re-handshake per attempt keeps a live reviewer from being ping-ponged; the
          // retry that follows is a whole fresh attempt, so the rule still holds.
          if (handoffRefreshAttempted) return recoverLater();
          handoffRefreshAttempted = true;
          try {
            const refreshed = await refreshChromeLoadHandoff(requestSequence);
            if (!refreshed) return false;
          } catch {
            return recoverLater();
          }
          continue;
        }
        if (status === "superseded") {
          setHandoffSuperseded(true);
          // The takeover banner sits in the conversation panel, which the layout gate overlay
          // covers whenever the gate is enabled. A chrome that never loaded the artifact would
          // otherwise show the checking spinner until the gate's max hold expires and then
          // reveal an empty frame, with the only recovery control hidden the whole time. Say it
          // on the overlay instead. Still no background retry: the reload is the user's to make.
          if (!artifactLoadToken) {
            setLayoutGateFailure(
              "This review is already open in another tab.",
              "Lavish loads an artifact in one tab at a time. Take over here to move the review into this tab, or switch back to the tab that already has it.",
              "Take over here",
            );
          }
          return preservePreviousLoad();
        }
        if (status === "out-of-order") return preservePreviousLoad();
        throw new Error("failed to begin artifact load");
      }
      const candidateRevision = Number(candidate?.artifact_revision);
      const candidateToken = String(candidate?.artifact_load_token || "");
      if (!Number.isSafeInteger(candidateRevision) || candidateRevision < 0 || !candidateToken) {
        throw new Error("invalid artifact load");
      }
      load = { artifact_revision: candidateRevision, artifact_load_token: candidateToken };
      break;
    } catch {
      const delay = ARTIFACT_LOAD_BEGIN_RETRY_DELAYS_MS[transportAttempt++];
      if (delay === undefined) return recoverLater();
      await new Promise((resolve) => window.setTimeout(resolve, delay));
    }
  }
  if (requestSequence !== artifactLoadRequestSequence || ended) return false;
  const revision = Number(load?.artifact_revision);
  const token = String(load?.artifact_load_token || "");
  if (!Number.isSafeInteger(revision) || revision < 0 || !token) return recoverLater();
  artifactLoadRecoveryAttempt = 0;
  artifactLoadRevision = revision;
  artifactLoadToken = token;
  artifactSpokeToken = "";
  inlineWhiteboardChannels.clear();
  setHandoffSuperseded(false);
  startLayoutGateCycle();
  frame.src = artifactFrameSrcForLoad({ revision, token });
  return true;
}

function resetFrame() {
  if (artifactResetPromise) return artifactResetPromise;
  const hasLiveInlineWhiteboard = [...inlineWhiteboardChannels].some(
    ([index, channel]) => channel.initialized && index !== overlayIndex,
  );
  if (!hasLiveInlineWhiteboard) {
    return replaceArtifactFrame();
  }
  artifactResetPromise = flushInlineWhiteboards()
    .then((flushed) => {
      if (!flushed) return false;
      return replaceArtifactFrame();
    })
    .finally(() => {
      artifactResetPromise = null;
    });
  return artifactResetPromise;
}

// ---------------------------------------------------------------------------
// Whiteboards. The artifact SDK embeds one sandboxed whiteboard frame in place
// of each rendered Mermaid diagram. The chrome owns every server round trip
// and serves all frames concurrently. The overlay hosts the same frame page
// fullscreen when an inline frame asks to maximize - the inline frame is
// suspended while the overlay owns that diagram so two editors never autosave
// one sidecar.
// ---------------------------------------------------------------------------

/** @type {Map<number, { diagramId: string, source: string, sourceHash: string }>} */
const whiteboards = new Map();
/** @type {number | null} */
let overlayIndex = null;
let overlayFrameReady = false;
let overlayChannelId = "";
let overlayOpeningIndex = null;
let nextWhiteboardFlushId = 0;
let artifactResetPromise = null;
let chromeRestartReloadPromise = null;
const whiteboardTeardowns = new Map();
const whiteboardFlushes = new Map();
const whiteboardSaveChains = new Map();
const inlineWhiteboardChannels = new Map();

function whiteboardTheme() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function postToWhiteboardOverlay(message) {
  if (whiteboardFrame.contentWindow && overlayChannelId) {
    whiteboardFrame.contentWindow.postMessage({ ...message, channelId: overlayChannelId }, "*");
  }
}

function postToInlineWhiteboard(index, message) {
  const channel = inlineWhiteboardChannels.get(index);
  if (channel?.window) channel.window.postMessage({ ...message, channelId: channel.channelId }, "*");
}

function postToWhiteboard(index, placement, message) {
  if (placement === "overlay") postToWhiteboardOverlay(message);
  else postToInlineWhiteboard(index, message);
}

async function fetchMermaidSources() {
  const response = await fetch("/api/" + key + "/mermaid-sources");
  if (!response.ok) throw new Error("could not read the artifact's Mermaid sources");
  const data = await response.json();
  return Array.isArray(data.sources) ? data.sources : [];
}

async function authenticateWhiteboardChannel(token) {
  const response = await fetch("/api/" + key + "/whiteboard-channel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  return response.ok;
}

function showWhiteboardError(text) {
  whiteboardError.textContent = text;
  whiteboardError.hidden = false;
  whiteboardOverlay.hidden = false;
}

function whiteboardRecord(index) {
  let record = whiteboards.get(index);
  if (!record) {
    record = { diagramId: "", source: "", sourceHash: "" };
    whiteboards.set(index, record);
  }
  return record;
}

async function handleWhiteboardReady(index, mode, isCurrent) {
  try {
    const sources = await fetchMermaidSources();
    const source = sources.find((item) => item.index === index);
    if (!source) throw new Error("this diagram's Mermaid source was not found in the artifact file");
    const savedResponse = await fetch("/api/" + key + "/whiteboard/" + index);
    const saved = savedResponse.ok ? (await savedResponse.json()).whiteboard : null;
    const record = whiteboardRecord(index);
    record.source = String(source.source || "");
    record.sourceHash = String(source.hash || "");
    if (!isCurrent()) return false;
    postToWhiteboard(index, mode, {
      type: "lavish-whiteboard:init",
      mode,
      diagramIndex: index,
      diagramId: record.diagramId,
      source: record.source,
      sourceHash: record.sourceHash,
      saved,
      theme: whiteboardTheme(),
    });
    return true;
  } catch (error) {
    if (mode === "overlay") {
      showWhiteboardError("Could not open the whiteboard: " + (error instanceof Error ? error.message : String(error)));
    }
    return false;
  }
}

function showWhiteboardOverlay(index) {
  if (ended) return;
  overlayIndex = index;
  overlayFrameReady = false;
  overlayChannelId = "";
  inlineWhiteboardChannels.delete(index);
  whiteboardError.hidden = true;
  whiteboardOverlay.hidden = false;
  postToFrame({ type: "lavish:suspendWhiteboard", diagramIndex: index });
  // A fresh document per open: the frame boots, posts ready, and receives its
  // init - no stale editor state can leak between opens.
  whiteboardFrame.src =
    "/whiteboard-frame?diagramIndex=" + encodeURIComponent(String(index)) + "&key=" + encodeURIComponent(key);
}

function finishWhiteboardClose(index) {
  whiteboardOverlay.hidden = true;
  whiteboardError.hidden = true;
  whiteboardFrame.src = "about:blank";
  overlayIndex = null;
  overlayFrameReady = false;
  overlayChannelId = "";
  inlineWhiteboardChannels.delete(index);
  if (!ended) postToFrame({ type: "lavish:resumeWhiteboard", diagramIndex: index });
}

function whiteboardTeardownKey(index, placement) {
  return placement + ":" + index;
}

function beginWhiteboardTeardown(index, placement, onComplete) {
  const key = whiteboardTeardownKey(index, placement);
  const pending = whiteboardTeardowns.get(key);
  if (pending) {
    if (onComplete) pending.promise.then(onComplete);
    return pending.promise;
  }
  const flushId = `whiteboard-${++nextWhiteboardFlushId}`;
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  const teardown = { index, placement, flushId, promise, resolve, onComplete };
  whiteboardTeardowns.set(key, teardown);
  const message = { type: "lavish-whiteboard:prepareTeardown", flushId };
  postToWhiteboard(index, placement, message);
  return promise;
}

function finishWhiteboardTeardown(index, message, placement) {
  const flushId = String(message.flushId || "");
  const key = whiteboardTeardownKey(index, placement);
  const teardown = whiteboardTeardowns.get(key);
  if (!teardown || teardown.index !== index || teardown.placement !== placement || teardown.flushId !== flushId) return;
  whiteboardTeardowns.delete(key);
  teardown.onComplete?.(true);
  teardown.resolve(true);
}

function failWhiteboardTeardown(index, message, placement) {
  const flushId = String(message.flushId || "");
  const key = whiteboardTeardownKey(index, placement);
  const teardown = whiteboardTeardowns.get(key);
  if (!teardown || teardown.index !== index || teardown.placement !== placement || teardown.flushId !== flushId) return;
  whiteboardTeardowns.delete(key);
  teardown.onComplete?.(false);
  teardown.resolve(false);
}

function whiteboardFlushKey(index, placement) {
  return placement + ":" + index;
}

function beginWhiteboardFlush(index, placement) {
  const flushKey = whiteboardFlushKey(index, placement);
  const pending = whiteboardFlushes.get(flushKey);
  if (pending) return pending.promise;
  const flushId = `whiteboard-flush-${++nextWhiteboardFlushId}`;
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  whiteboardFlushes.set(flushKey, { index, placement, flushId, promise, resolve });
  postToWhiteboard(index, placement, { type: "lavish-whiteboard:flush", flushId });
  return promise;
}

function finishWhiteboardFlush(index, message, placement) {
  const flushId = String(message.flushId || "");
  const flushKey = whiteboardFlushKey(index, placement);
  const flush = whiteboardFlushes.get(flushKey);
  if (!flush || flush.index !== index || flush.placement !== placement || flush.flushId !== flushId) return;
  whiteboardFlushes.delete(flushKey);
  flush.resolve(Boolean(message.ok));
}

async function flushWhiteboardsBeforeChromeReload() {
  const flushes = [];
  for (const [index, channel] of inlineWhiteboardChannels) {
    if (channel.initialized && index !== overlayIndex) flushes.push(beginWhiteboardFlush(index, "inline"));
  }
  if (overlayIndex !== null && overlayFrameReady) flushes.push(beginWhiteboardFlush(overlayIndex, "overlay"));
  if (flushes.length === 0) return;
  let timeout;
  await Promise.race([
    Promise.all(flushes),
    new Promise((resolve) => {
      timeout = setTimeout(resolve, 1500);
    }),
  ]);
  clearTimeout(timeout);
}

async function flushInlineWhiteboards() {
  for (const [index, channel] of [...inlineWhiteboardChannels]) {
    if (!channel.initialized || index === overlayIndex) continue;
    if (!(await beginWhiteboardTeardown(index, "inline"))) return false;
  }
  return true;
}

function openWhiteboardOverlay(index) {
  if (ended || overlayIndex !== null || overlayOpeningIndex !== null) return;
  overlayOpeningIndex = index;
  beginWhiteboardTeardown(index, "inline", (flushed) => {
    if (overlayOpeningIndex !== index) return;
    overlayOpeningIndex = null;
    if (flushed && !ended && overlayIndex === null) showWhiteboardOverlay(index);
  });
}

function closeWhiteboard() {
  const index = overlayIndex;
  if (index === null) return;
  if (!overlayFrameReady) {
    finishWhiteboardClose(index);
    return;
  }
  beginWhiteboardTeardown(index, "overlay", (flushed) => {
    if (flushed && overlayIndex === index) finishWhiteboardClose(index);
  });
}

async function persistWhiteboardScene(index, message) {
  const response = await fetch("/api/" + key + "/whiteboard/" + index, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source_hash: String(message.sourceHash || ""),
      text_metrics_version: Number(message.textMetricsVersion) || 0,
      scene: message.scene || null,
      baseline: message.baseline || null,
    }),
  });
  if (!response.ok) throw new Error("failed to save whiteboard scene");
}

function saveWhiteboardScene(index, message) {
  const previous = whiteboardSaveChains.get(index) || Promise.resolve();
  const result = previous.catch(() => {}).then(() => persistWhiteboardScene(index, message));
  const tail = result.catch(() => {});
  whiteboardSaveChains.set(index, tail);
  tail.finally(() => {
    if (whiteboardSaveChains.get(index) === tail) whiteboardSaveChains.delete(index);
  });
  return result;
}

function handleWhiteboardSave(index, message, mode) {
  const flushId = String(message.flushId || "");
  saveWhiteboardScene(index, message).then(
    () => {
      if (flushId) postToWhiteboard(index, mode, { type: "lavish-whiteboard:saveResult", flushId, ok: true });
    },
    (error) => {
      if (flushId) {
        postToWhiteboard(index, mode, {
          type: "lavish-whiteboard:saveResult",
          flushId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}

function whiteboardSummaryText(summaryLines) {
  return (Array.isArray(summaryLines) ? summaryLines : [])
    .filter((line) => typeof line === "string")
    .slice(0, 50)
    .map((line) => line.slice(0, 300))
    .join("\n");
}

async function queueWhiteboardFeedback(index, message, mode) {
  const diagramId = whiteboardRecord(index).diagramId;
  try {
    // Persist the exact reviewed state before queueing, so the paths in the
    // prompt point at what the user actually saw.
    await saveWhiteboardScene(index, message);
    const response = await fetch("/api/" + key + "/whiteboard/" + index + "/feedback-files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scene: message.scene || null, pngDataUrl: String(message.pngDataUrl || "") }),
    });
    if (!response.ok) throw new Error("failed to write whiteboard feedback files");
    const files = await response.json();
    const note = String(message.note || "").slice(0, 4000);
    const summary = whiteboardSummaryText(message.summaryLines);
    const promptText =
      (note ? note + "\n\n" : "") +
      "Whiteboard edits to diagram " +
      (index + 1) +
      (diagramId ? " (" + diagramId + ")" : "") +
      ":\n" +
      (summary || "(no summary)") +
      "\n\nEdited scene JSON: " +
      String(files.scene_path || "") +
      (files.preview_path ? "\nPNG preview: " + String(files.preview_path) : "");
    enqueuePrompt({
      uid: "",
      prompt: promptText,
      selector: "",
      tag: "whiteboard",
      text: "Whiteboard: diagram " + (index + 1),
      target: {
        type: "excalidraw-scene",
        diagramIndex: index,
        diagramId,
        sourceHash: String(message.sourceHash || ""),
        scenePath: String(files.scene_path || ""),
        previewPath: String(files.preview_path || ""),
        imageFallback: Boolean(message.imageFallback),
        stats: message.stats && typeof message.stats === "object" ? message.stats : {},
      },
      // Re-queueing the same diagram's whiteboard before sending replaces the
      // earlier unsent prompt instead of stacking duplicates.
      [internalQueueKeyField]: "whiteboard:" + index,
    });
    postToWhiteboard(index, mode, { type: "lavish-whiteboard:queueResult", ok: true });
    if (mode === "overlay") closeWhiteboard();
  } catch (error) {
    postToWhiteboard(index, mode, {
      type: "lavish-whiteboard:queueResult",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Inline frames live inside the artifact iframe, so a live reload replaces
// them wholesale and they re-init against fresh sources on their own. Only an
// open overlay outlives the reload; tell it when its diagram's source changed
// underneath it so the frame can surface staleness (never silently merge).
async function refreshWhiteboardSource() {
  if (overlayIndex === null) return;
  const index = overlayIndex;
  try {
    const sources = await fetchMermaidSources();
    const source = sources.find((item) => item.index === index);
    const nextHash = source ? String(source.hash || "") : "";
    const record = whiteboardRecord(index);
    if (nextHash !== record.sourceHash) {
      record.source = source ? String(source.source || "") : "";
      record.sourceHash = nextHash;
      postToWhiteboardOverlay({
        type: "lavish-whiteboard:sourceChanged",
        source: record.source,
        sourceHash: record.sourceHash,
      });
    }
  } catch {
    // Best effort - the staleness banner also re-arms on the next open.
  }
}

function validWhiteboardIndex(value) {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 && index <= 999 ? index : null;
}

function handleAuthenticatedWhiteboardMessage(index, message, mode) {
  if (message.type === "lavish-whiteboard:save") handleWhiteboardSave(index, message, mode);
  if (message.type === "lavish-whiteboard:queueFeedback") queueWhiteboardFeedback(index, message, mode);
  if (message.type === "lavish-whiteboard:maximize" && mode === "inline") openWhiteboardOverlay(index);
  if (message.type === "lavish-whiteboard:close" && mode === "overlay") closeWhiteboard();
  if (message.type === "lavish-whiteboard:teardownReady") finishWhiteboardTeardown(index, message, mode);
  if (message.type === "lavish-whiteboard:teardownFailed") failWhiteboardTeardown(index, message, mode);
  if (message.type === "lavish-whiteboard:flushComplete") finishWhiteboardFlush(index, message, mode);
}

// Inline whiteboard frames are created by the SDK inside the artifact document,
// so a genuine one is always a direct child of the *current* artifact window.
// Descent - not the channel token - is what proves the sender is ours: the
// frame page is framable by any origin, so a token is not a secret an attacker
// cannot obtain. Without this, any window that could postMessage to this chrome
// (a page that framed it, or one holding a window.open handle) could open a
// channel and queue a fabricated prompt. Mirrors the artifact-message handler's
// `event.source !== frame.contentWindow` guard.
function isArtifactChildWindow(source) {
  if (!source) return false;
  try {
    // Reading `parent` on a cross-origin WindowProxy is permitted; the frame's
    // sandbox makes everything else about it opaque.
    return source.parent === frame.contentWindow;
  } catch {
    return false;
  }
}

function handleInlineWhiteboardMessage(event, message) {
  if (ended) return;
  if (!isArtifactChildWindow(event.source)) return;
  const index = validWhiteboardIndex(message.diagramIndex);
  if (index === null) return;
  if (message.type === "lavish-whiteboard:ready") {
    if (inlineWhiteboardChannels.has(index)) return;
    const channelId = String(message.channelToken || "");
    if (!channelId) return;
    authenticateWhiteboardChannel(channelId).then((authenticated) => {
      if (!authenticated || ended || inlineWhiteboardChannels.has(index)) return;
      const channel = { window: event.source, channelId, initialized: false };
      inlineWhiteboardChannels.set(index, channel);
      whiteboardRecord(index).diagramId = String(message.diagramId || "");
      handleWhiteboardReady(index, "inline", () => inlineWhiteboardChannels.get(index) === channel).then(
        (initialized) => {
          if (inlineWhiteboardChannels.get(index) === channel) channel.initialized = initialized;
        },
      );
    });
    return;
  }
  const channel = inlineWhiteboardChannels.get(index);
  if (!channel || channel.window !== event.source || channel.channelId !== message.channelId) return;
  handleAuthenticatedWhiteboardMessage(index, message, "inline");
}

function handleOverlayWhiteboardMessage(event, message) {
  if (event.source !== whiteboardFrame.contentWindow || overlayIndex === null) return;
  const index = validWhiteboardIndex(message.diagramIndex);
  if (index === null || index !== overlayIndex) return;
  if (message.type === "lavish-whiteboard:ready") {
    if (overlayFrameReady || overlayChannelId) return;
    const channelId = String(message.channelToken || "");
    if (!channelId) return;
    overlayChannelId = channelId;
    authenticateWhiteboardChannel(channelId).then(async (authenticated) => {
      const isCurrent = () =>
        overlayIndex === index && overlayChannelId === channelId && event.source === whiteboardFrame.contentWindow;
      if (!authenticated) {
        if (isCurrent()) overlayChannelId = "";
        return;
      }
      if (!isCurrent()) return;
      const initialized = await handleWhiteboardReady(index, "overlay", isCurrent);
      if (initialized && isCurrent()) overlayFrameReady = true;
    });
    return;
  }
  if (!overlayFrameReady || message.channelId !== overlayChannelId) return;
  handleAuthenticatedWhiteboardMessage(index, message, "overlay");
}

window.addEventListener("message", (event) => {
  const message = event.data || {};
  if (event.source === whiteboardFrame.contentWindow) {
    handleOverlayWhiteboardMessage(event, message);
  } else if (event.source !== frame.contentWindow) {
    handleInlineWhiteboardMessage(event, message);
  }
});

function loadFrame() {
  if (artifactSrc) {
    if (artifactLoadToken) {
      frame.src = artifactFrameSrcForLoad({ revision: artifactLoadRevision, token: artifactLoadToken });
    }
    replaceArtifactFrame().catch(() => {});
  }
}

function reloadArtifact() {
  closeMenus();
  resetFrame().then((reloaded) => {
    if (reloaded) refreshWhiteboardSource();
  });
}

async function reloadAfterServerRestart() {
  if (chromeRestartReloadPromise) return chromeRestartReloadPromise;
  chromeRestartReloadPromise = reloadChromeAfterServerRestart();
  return chromeRestartReloadPromise;
}

// The replacement server usually binds within a second, but it is a fresh node process competing
// with whatever else the machine is doing, and several `lavish-axi` invocations can be racing for
// the same port. Reloading on a fixed short deadline regardless of whether anything is listening
// trades a recoverable page for the browser's connection-error page, which no Lavish code can
// recover from. So wait for the port to answer, and if it never does, say so instead.
async function reloadChromeAfterServerRestart() {
  let sawOutage = false;
  let healthy = false;
  // Keep the pre-outage behavior: a server that never actually went away is reloaded promptly.
  const settleDeadline = Date.now() + CHROME_RESTART_SETTLE_MS;
  const deadline = Date.now() + CHROME_RESTART_WAIT_MS;

  while (Date.now() < deadline) {
    try {
      const res = await fetch("/health", { cache: "no-store" });
      healthy = Boolean(res.ok);
      if (healthy && (sawOutage || Date.now() >= settleDeadline)) break;
    } catch {
      sawOutage = true;
      healthy = false;
    }

    const probeDelay = Date.now() < settleDeadline ? CHROME_RESTART_PROBE_MS : CHROME_RESTART_SLOW_PROBE_MS;
    await new Promise((resolve) => setTimeout(resolve, probeDelay));
  }

  if (!healthy) {
    chromeRestartReloadPromise = null;
    setLayoutGateFailure(
      "Lavish is not running.",
      "The Lavish server restarted and did not come back. Start it again with your agent, then reload this page.",
    );
    return;
  }

  await flushWhiteboardsBeforeChromeReload();
  location.reload();
}

window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow) return;

  const msg = event.data || {};
  const messageToken = String(msg.artifact_load_token || "");
  if (messageToken !== artifactLoadToken) return;
  const messageSequence = ++artifactMessageSequence;
  artifactSpokeToken = messageToken;
  clearTimeout(artifactSilenceTimer);
  if (msg.type === "lavish:layoutDiagnostics") {
    const diagnosticSequence = ++layoutDiagnosticSequence;
    submitLayoutDiagnostics({
      complete: msg.complete !== false,
      targetPresenceComplete: msg.target_presence_complete === true,
      artifactRevision: msg.artifact_revision,
      artifactLoadToken: msg.artifact_load_token,
      artifactPassSequence: msg.artifact_pass_sequence,
      viewportWidth: msg.viewport_width,
      findings: msg.findings,
    })
      .then((result) => {
        if (messageToken !== artifactLoadToken || diagnosticSequence !== layoutDiagnosticSequence) return;
        if (Array.isArray(result?.warnings)) setLayoutWarnings(result.warnings);
        if (result?.status === "stale") {
          if (messageSequence === artifactMessageSequence) armArtifactAvailabilityProbe(messageToken);
          return;
        }
        if (msg.complete !== false) handleLayoutGatePass();
      })
      .catch(() => {});
    return;
  }
  // The artifact spoke, so it rendered and ran its SDK - there is nothing fatal to probe for.
  if (msg.type === "lavish:queuePrompt") {
    enqueuePrompt(msg.prompt);
  }
  if (msg.type === "lavish:snapshot") {
    const snapshotAction = snapshotRequests.shift() || "submit";
    if (snapshotAction === "copy") {
      copyText(msg.snapshot || "");
    } else {
      pendingSnapshot = msg.snapshot || "";
      // submitQueuedOnce throws to signal "nothing was delivered" - its own
      // finally already reset the end intent and it left the queue intact for a
      // retry, so the rejection has no remaining consumer here.
      submitQueued().catch(() => {});
    }
  }
  if (msg.type === "lavish:scroll") {
    lastScroll = { x: Number(msg.x) || 0, y: Number(msg.y) || 0 };
  }
  if (msg.type === "lavish:reviewState") {
    lastReviewState = msg.state && typeof msg.state === "object" ? msg.state : null;
  }
  if (msg.type === "lavish:artifactAssetFailure") {
    reportArtifactFailures(
      [{ kind: "artifact-asset-unavailable", detail: String(msg.detail || "a local artifact asset failed to load") }],
      messageToken,
    ).catch(() => {});
  }
  if (msg.type === "lavish:uploadAttachment") uploadAttachment(msg);
  // There is deliberately no attachment-delete message. See removeAttachment's
  // removal note below: the iframe cannot be trusted to decide a delete, and the
  // chrome cannot see every live reference, so reclamation is the sweeper's job.
  if (msg.type === "lavish:sendQueuedPrompts") sendQueued();
  if (msg.type === "lavish:endSession") endSession();
  if (msg.type === "lavish:toggleAnnotationMode") toggleAnnotationMode();
});

// The sandboxed artifact iframe can't reach the loopback server (opaque origin),
// so it hands captured image bytes here and the chrome performs the same-origin
// upload, then reports the server-vetted id back to the card.
async function uploadAttachment(message, reportResult = postToFrame, signal) {
  const localId = String(message.localId || "");
  if (!localId) return;
  // Echoed verbatim on every result so the artifact can tell a reply to ITS upload
  // from one still in flight for a previous document (E1). The chrome never
  // interprets it; it only round-trips it.
  const nonce = message.nonce;
  const bytes = message.bytes;
  let size;
  if (ArrayBuffer.isView(bytes)) {
    size = bytes.byteLength;
  } else {
    try {
      const byteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
      size = byteLengthGetter ? byteLengthGetter.call(bytes) : NaN;
    } catch {
      size = NaN;
    }
  }
  if (!Number.isFinite(size) || size < 0) {
    reportResult({
      type: "lavish:attachmentResult",
      nonce,
      localId,
      ok: false,
      error: "invalid upload payload",
    });
    return;
  }
  // Reject over-cap images before they hit the network: an over-cap upload aborts
  // mid-stream, and the browser can hang or reset instead of surfacing the 413, so
  // the chip would never leave "uploading". Catching it here guarantees the card
  // reaches its error+retry state. The server still enforces the cap authoritatively.
  if (attachmentMaxBytes > 0 && size > attachmentMaxBytes) {
    reportResult({
      type: "lavish:attachmentResult",
      nonce,
      localId,
      ok: false,
      error: "Image is larger than the " + formatByteLimit(attachmentMaxBytes) + " limit",
    });
    return;
  }
  // Confused-deputy guard: rate + cumulative-byte ceiling before touching the network.
  const now = Date.now();
  while (uploadTimestamps.length && now - uploadTimestamps[0] > UPLOAD_RATE_WINDOW_MS) uploadTimestamps.shift();
  if (uploadTimestamps.length >= UPLOAD_RATE_MAX) {
    reportResult({
      type: "lavish:attachmentResult",
      nonce,
      localId,
      ok: false,
      error: "Too many uploads. Wait a moment and retry.",
    });
    return;
  }
  if (uploadedBytesTotal + size > UPLOAD_SESSION_BYTE_QUOTA) {
    reportResult({
      type: "lavish:attachmentResult",
      nonce,
      localId,
      ok: false,
      error: "Upload limit reached for this session (" + formatByteLimit(UPLOAD_SESSION_BYTE_QUOTA) + ").",
    });
    return;
  }
  // In-flight ceiling: refuse rather than pile another large body onto the network
  // while the bound is full. The card keeps its retry affordance, and a settled
  // upload (below) frees a slot for the next.
  if (uploadsInFlight >= UPLOAD_MAX_IN_FLIGHT) {
    reportResult({
      type: "lavish:attachmentResult",
      nonce,
      localId,
      ok: false,
      error: "Too many uploads in flight. Wait a moment and retry.",
    });
    return;
  }
  uploadTimestamps.push(now);
  uploadedBytesTotal += size;
  uploadsInFlight += 1;
  try {
    const response = await fetch("/api/" + key + "/attachments", {
      method: "POST",
      headers: { "content-type": String(message.mime || "application/octet-stream") },
      body: bytes,
      signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Upload failed");
    reportResult({
      type: "lavish:attachmentResult",
      nonce,
      localId,
      ok: true,
      id: (data.attachment && data.attachment.id) || "",
    });
  } catch (error) {
    reportResult({
      type: "lavish:attachmentResult",
      nonce,
      localId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    uploadsInFlight -= 1;
  }
}

// There is intentionally no eager attachment delete here. Removing a chip used to
// ask the chrome to DELETE the stored file once no queued prompt referenced it,
// but that check is not authoritative: attachments are content-addressed, so two
// tabs (or two cards) can hold the SAME id, and a chip that is ready but not yet
// queued in another tab is invisible from here. The delete was also driven by the
// untrusted iframe, making the chrome a confused deputy - a malicious artifact
// could destroy bytes a live card still needed, which then failed as `not-found`
// on send. Unreferenced files are reclaimed by the server's reference-aware TTL
// sweeper and the disk-cap backstop, which see every session's pending prompts
// at once. Deleting late is cheap; deleting bytes someone still needs is not.

loadFrame();

function toggleAnnotationMode() {
  if (ended) return;
  annotation = !annotation;
  annotationSwitch.setAttribute("aria-pressed", String(annotation));
  postToFrame({ type: "lavish:setAnnotationMode", enabled: annotation });
}

annotationSwitch.onclick = toggleAnnotationMode;

sendButton.onclick = () => sendQueued(false);
sendAndEndButton.onclick = () => sendQueued(true);
moreButton.onclick = () => {
  closeWarningsDrawer();
  toggleMenu(moreButton, moreMenu);
};
warningsButton.onclick = toggleWarningsDrawer;
warningsSelectAll.onchange = toggleSelectAllWarnings;
warningsQueueButton.onclick = queueSelectedWarningFixes;
chatAttachButton.onclick = () => chatAttachInput.click();
chatAttachInput.addEventListener("change", () => {
  chatAttachmentController.addFiles(chatAttachInput.files);
  chatAttachmentController.rejectUnsupported(chatAttachInput.files);
  chatAttachInput.value = "";
});
// The one place a paste or drop is turned into a file list, so both surfaces see
// the same payload. Pasted screenshots arrive as items, not files, in some
// browsers; `.files` alone silently attaches nothing there.
function transferredFiles(dataTransfer) {
  const files = Array.from(dataTransfer?.files || []).filter(Boolean);
  if (files.length) return files;
  return Array.from(dataTransfer?.items || [])
    .filter((item) => item && item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(Boolean);
}
// Finder/Explorer file copies put the copied file's name or path in text/plain;
// that placeholder must not land in the message beside the attached image. Real
// captions (any line that is not a pasted file's name) keep the default paste.
// Mirrors planClipboardPaste in artifact-sdk.js, which owns the same rule for
// the annotation card - this file is served raw and cannot import it.
function keepsClipboardText(text, files) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return false;
  const names = files.map((file) => String(file?.name || "")).filter(Boolean);
  if (!names.length) return true;
  return !lines.every((line) =>
    names.some((name) => line === name || line.endsWith("/" + name) || line.endsWith("\\" + name)),
  );
}
chatInput.addEventListener("paste", (event) => {
  const files = transferredFiles(event.clipboardData);
  // Images only: Office and macOS pastes expose stray non-image file flavors
  // beside their text, so unsupported entries raise no chip here (matching the
  // annotation card) - a chip would block sending for a perceived text paste.
  const added = chatAttachmentController.addFiles(files);
  if (added && !keepsClipboardText(event.clipboardData?.getData("text/plain") || "", files)) event.preventDefault();
});
chatComposer.addEventListener("dragover", (event) => {
  if (Array.from(event.dataTransfer?.types || []).includes("Files")) {
    event.preventDefault();
    chatComposer.classList.add("is-dropping");
  }
});
chatComposer.addEventListener("dragleave", (event) => {
  const entering = /** @type {Node | null} */ (event.relatedTarget);
  if (!chatComposer.contains(entering)) chatComposer.classList.remove("is-dropping");
});
chatComposer.addEventListener("drop", (event) => {
  chatComposer.classList.remove("is-dropping");
  if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
  event.preventDefault();
  const files = transferredFiles(event.dataTransfer);
  if (!files.length) {
    // A drag advertising Files with nothing enumerable: the default was already
    // consumed, so refuse visibly (like the card) instead of swallowing it.
    chatAttachmentController.rejectUnsupported([{ name: "file", type: "" }]);
    return;
  }
  chatAttachmentController.addFiles(files);
  chatAttachmentController.rejectUnsupported(files);
});
// A file drop that misses the composer must not navigate the chrome away from
// the session (losing chips, uploads, and the SSE connection). Text drags stay
// untouched so dropping text into the textarea keeps working.
document.addEventListener("dragover", (event) => {
  if (Array.from(event.dataTransfer?.types || []).includes("Files")) event.preventDefault();
});
document.addEventListener("drop", (event) => {
  if (Array.from(event.dataTransfer?.types || []).includes("Files")) event.preventDefault();
});
chatAttachments.addEventListener("click", (event) => {
  const target = /** @type {HTMLElement | null} */ (event.target);
  const remove = /** @type {HTMLElement | null} */ (target?.closest?.("[data-chat-attachment-remove]") || null);
  if (remove) chatAttachmentController.remove(String(remove.dataset.chatAttachmentRemove || ""));
  const retry = /** @type {HTMLElement | null} */ (target?.closest?.("[data-chat-attachment-retry]") || null);
  if (retry) chatAttachmentController.retry(String(retry.dataset.chatAttachmentRetry || ""));
});
chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendQueued(false);
  }
});
chatInput.addEventListener("input", hideSendHint);
copyPathButton.onclick = copyFilePath;
reloadArtifactButton.onclick = reloadArtifact;
copySnapshotButton.onclick = copyDomSnapshot;
exportArtifactButton.onclick = exportArtifact;
shareArtifactButton.onclick = openShareDialog;
shareCloseButton.onclick = closeShareDialog;
shareCancelButton.onclick = closeShareDialog;
shareForm.addEventListener("submit", publishShare);
shareDialog.addEventListener("click", (event) => {
  if (event.target === shareDialog) closeShareDialog();
});
copyShareUrlButton.onclick = () => copyToButton(shareUrlInput.value, copyShareUrlButton, "Copy URL");
copyUpdateKeyButton.onclick = () => copyToButton(shareUpdateKeyInput.value, copyUpdateKeyButton, "Copy key");
endButton.onclick = () => {
  closeMenus();
  endSession();
};
handoffTakeoverButton.onclick = () => location.reload();
document.addEventListener("mousedown", (event) => {
  const target = /** @type {Node} */ (event.target);
  if (!moreMenu.hidden && !moreWrap.contains(target)) setMenuOpen(moreButton, moreMenu, false);
  if (warningsDrawerOpen && !warningsWrap.contains(target)) closeWarningsDrawer();
});
// A non-modal popover closes when focus leaves it, so keyboard users are never stranded inside a
// panel they cannot see the end of.
warningsWrap.addEventListener("focusout", (event) => {
  const next = /** @type {Node | null} */ (event.relatedTarget);
  if (warningsDrawerOpen && next && !warningsWrap.contains(next)) closeWarningsDrawer();
});
whiteboardCloseButton.onclick = closeWhiteboard;
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!whiteboardOverlay.hidden) {
      closeWhiteboard();
    } else if (!shareDialog.hidden) {
      closeShareDialog();
    } else if (warningsDrawerOpen) {
      closeWarningsDrawer({ restoreFocus: true });
    } else {
      closeMenus();
    }
  }
});
// Capture phase so the mode hotkey fires no matter where focus is in the chrome - including
// mid-keystroke in chatInput or an annotation-card textarea - without disturbing normal typing.
document.addEventListener(
  "keydown",
  (event) => {
    if (!isModeToggleHotkeyEvent(event)) return;
    event.preventDefault();
    toggleAnnotationMode();
  },
  true,
);
frame.addEventListener("load", () => {
  if (artifactSpokeToken !== artifactLoadToken) armArtifactAvailabilityProbe(artifactLoadToken);
  postToFrame({ type: "lavish:setAnnotationMode", enabled: annotation && !ended });
  // Replay the pre-reload scroll position so hot reloads don't jump the artifact to the top.
  postToFrame({ type: "lavish:restoreScroll", x: lastScroll.x, y: lastScroll.y });
  if (lastReviewState) postToFrame({ type: "lavish:restoreReviewState", state: lastReviewState });
  if (overlayIndex !== null) {
    inlineWhiteboardChannels.delete(overlayIndex);
    postToFrame({ type: "lavish:suspendWhiteboard", diagramIndex: overlayIndex });
  }
});

initializeLayoutGate();

const events = new EventSource("/events/" + key);
events.addEventListener("reload", () => {
  resetFrame().then((reloaded) => {
    if (reloaded) refreshWhiteboardSource();
  });
});
events.addEventListener("chrome-reload", () => reloadAfterServerRestart());
events.addEventListener("agent-reply", (event) => addChat("agent", JSON.parse(event.data).text));
events.addEventListener("chat-sync", (event) => syncChat(JSON.parse(event.data).chat || []));
events.addEventListener("agent-presence", (event) => setAgentPresence(JSON.parse(event.data).state));
events.addEventListener("layout-warnings", (event) => setLayoutWarnings(JSON.parse(event.data).warnings || []));
// A reconnecting stream means this chrome may have missed updates while it was away.
events.addEventListener("open", () => refreshLayoutWarnings());

render();
setWarningsDrawerOpen(false);
renderWarnings();
initialChat.forEach((item) => addChat(item.role, item.text));
setAgentPresence("waiting");

// Reaching this line is the only proof that this file parsed and ran to completion. The page it
// bootstraps ships with the layout-gate overlay already covering the artifact, and only this
// script ever takes it down - so the inline failsafe in the page holds it up until here.
const chromeBootWindow = /** @type {Record<string, any>} */ (/** @type {unknown} */ (window));
chromeBootWindow.__lavishChromeReady = true;
chromeBootWindow.__lavishCancelChromeBootFailsafe?.();
