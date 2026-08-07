/* global EventSource, document, location, window */

const sessionDataElement = document.getElementById("lavish-session");
const sessionData = JSON.parse(sessionDataElement?.textContent || "{}");
// dealernet: texto de interface vem do bootstrap da sessao (src/i18n-ptbr.js). O cliente e
// servido cru e nao pode importar modulos, por isso o servidor injeta os textos aqui.
const t = sessionData.i18n || {};
const key = String(sessionData.key || "");
const filePath = String(sessionData.file || "");
const queueStorageKey = "lavish-axi:queued:" + key;
// Review-chrome state that must survive a browser refresh. Keyed per session so one review's
// triage can never leak into another artifact's.
const warningSelectionStorageKey = "lavish-axi:warning-selection:" + key;
const warningAckStorageKey = "lavish-axi:warning-ack:" + key;
const internalQueueKeyField = "_lavishQueueKey";
const initialChat = Array.isArray(sessionData.initialChat) ? sessionData.initialChat : [];
const MODE_TOGGLE_HOTKEY_KEY = String(sessionData.modeToggleHotkeyKey || "").toLowerCase();

function isModeToggleHotkeyEvent(event) {
  if (event.shiftKey || event.altKey) return false;
  return Boolean(event.metaKey || event.ctrlKey) && String(event.key || "").toLowerCase() === MODE_TOGGLE_HOTKEY_KEY;
}

const frame = /** @type {HTMLIFrameElement} */ (document.getElementById("artifact"));
const panelScroll = /** @type {HTMLDivElement} */ (document.getElementById("panelScroll"));
const annotationPills = /** @type {HTMLDivElement} */ (document.getElementById("annotationPills"));
const chatLog = /** @type {HTMLDivElement} */ (document.getElementById("chatLog"));
const chatInput = /** @type {HTMLTextAreaElement} */ (document.getElementById("chatInput"));
const sendButton = /** @type {HTMLButtonElement} */ (document.getElementById("send"));
const sendAndEndButton = /** @type {HTMLButtonElement} */ (document.getElementById("sendAndEnd"));
const annotationSwitch = /** @type {HTMLButtonElement} */ (document.getElementById("annotation"));
const moreWrap = /** @type {HTMLDivElement} */ (document.getElementById("moreWrap"));
const moreButton = /** @type {HTMLButtonElement} */ (document.getElementById("moreButton"));
const moreMenu = /** @type {HTMLDivElement} */ (document.getElementById("moreMenu"));
const reloadArtifactButton = /** @type {HTMLButtonElement} */ (document.getElementById("reloadArtifact"));
const copySnapshotButton = /** @type {HTMLButtonElement} */ (document.getElementById("copySnapshot"));
const exportArtifactButton = /** @type {HTMLButtonElement} */ (document.getElementById("exportArtifact"));
// dealernet: os elementos do fluxo de publicacao (share*) foram removidos junto com o item de menu,
// o dialogo e a rota do servidor. Publicar mandava o artefato para ht-ml.app, host de terceiro.
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
const layoutIssueBanner = /** @type {HTMLDivElement} */ (document.getElementById("layoutIssueBanner"));
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
const artifactSrc = frame.dataset.artifactSrc || frame.getAttribute?.("data-artifact-src") || frame.src || "";

const queued = loadQueuedPrompts();
// dealernet: a sessao abre em modo EXPLORAR, nao anotar. O artefato de fase e primeiro um
// documento para ler — abrir anotando faz o primeiro clique virar anotacao acidental em vez de
// rolagem/interacao. Cmd/Ctrl+I (e o switch da barra) continuam alternando normalmente.
let annotation = false;
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
let layoutGateCycle = 0;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let layoutGateTimer;
// The warning inbox is server-owned review state. The chrome renders it and posts triage
// actions; it never decides on its own that a warning went away.
let layoutWarnings = Array.isArray(sessionData.initialLayoutWarnings) ? sessionData.initialLayoutWarnings : [];
const selectedWarningIds = new Set(loadJsonState(warningSelectionStorageKey, []));
let warningsDrawerOpen = false;
let warningsAcknowledged = loadJsonState(warningAckStorageKey, false) === true;
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
let artifactLoadToken = "";
let artifactLoadRevision = Number(sessionData.initialArtifactRevision) || 0;
let artifactLoadRequestSequence = Number(sessionData.initialArtifactLoadSequence) || 0;
let chromeLoadToken = String(sessionData.chromeLoadToken || "");
artifactLoadToken = String(sessionData.initialArtifactLoadToken || "");
let artifactSpokeToken = "";
let artifactMessageSequence = 0;
let layoutDiagnosticSequence = 0;
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

function loadQueuedPrompts() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(queueStorageKey) || "[]");
    return Array.isArray(parsed) ? parsed.filter((prompt) => prompt && typeof prompt === "object") : [];
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

function render() {
  annotationPills.innerHTML = queued
    .map(
      (prompt, index) =>
        '<div class="pill-wrap"><div class="pill"><span class="pill-preview">' +
        escapeHtml(prompt.prompt) +
        '</span><button class="pill-close" type="button" aria-label="' +
        escapeHtml(t.removerPromptDaFila) +
        '" data-index="' +
        index +
        '"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div><div class="pill-tooltip">' +
        (prompt.selector
          ? '<div class="tooltip-label">Target</div><div class="pill-tooltip-target">' +
            escapeHtml(prompt.selector) +
            "</div>"
          : "") +
        '<div class="tooltip-label">Prompt</div><div class="pill-tooltip-prompt">' +
        escapeHtml(prompt.prompt) +
        "</div></div></div>",
    )
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

function showSendHint() {
  sendHint.hidden = false;
  clearTimeout(sendHintTimer);
  sendHintTimer = setTimeout(() => {
    sendHint.hidden = true;
  }, 2600);
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

function enqueuePrompt(prompt) {
  if (!prompt || typeof prompt !== "object") return;

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

function sendQueued(endAfter) {
  if (ended || agentPresence === "working") return;
  closeMenus();

  const text = chatInput.value.trim();
  if (text) {
    queued.push({ uid: "", prompt: text, selector: "", tag: "message", text: "Freeform message" });
    persistQueuedPrompts();
    addChat("user", text);
    chatInput.value = "";
    render();
  }
  if (!queued.length) {
    showSendHint();
    return;
  }
  hideSendHint();

  if (endAfter) endAfterSubmit = true;
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
        submitQueued();
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

function setLayoutIssueBanner(visible) {
  if (!layoutIssueBanner) return;
  layoutIssueBanner.hidden = !visible;
}

// The banner is a one-time "there is unresolved work" cue for the top-bar inbox. Once the user
// has opened the drawer it stays out of the way; the badge remains the standing signal.
function refreshLayoutIssueBanner() {
  setLayoutIssueBanner(!ended && !warningsAcknowledged && !layoutGateVisible && activeWarnings().length > 0);
}

function clearLayoutGateTimer() {
  if (layoutGateTimer) clearTimeout(layoutGateTimer);
  layoutGateTimer = undefined;
}

function setLayoutGateCard(state) {
  if (!layoutGateTitle || !layoutGateCopy) return;

  if (state === "held") {
    layoutGateTitle.innerHTML = t.corrigindoProblemaLayout;
    layoutGateCopy.textContent =
      "The browser found inaccessible or unusable content. Your agent has been notified and this will reveal after the next clean reload.";
    return;
  }

  layoutGateTitle.innerHTML = t.verificandoLayout;
  layoutGateCopy.textContent = t.verificandoLayoutDetalhe;
}

function setLayoutGateActive(active) {
  layoutGateVisible = active;
  if (layoutGateOverlay) layoutGateOverlay.hidden = !active;
  document.body?.classList?.toggle("layout-gate-active", active);
}

function revealLayoutGate() {
  clearLayoutGateTimer();
  layoutGateArmed = false;
  setLayoutGateActive(false);
  refreshLayoutIssueBanner();
}

function forceRevealLayoutGate(reason) {
  if (!layoutGateEnabled || ended) return;
  if (reason === "manual") layoutGateManuallyBypassed = true;
  revealLayoutGate();
}

function startLayoutGateCycle() {
  if (!layoutGateEnabled || layoutGateManuallyBypassed || ended) return;

  layoutGateCycle += 1;
  layoutGateArmed = true;
  setLayoutIssueBanner(false);
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
  if (!layoutGateEnabled || layoutGateManuallyBypassed) {
    refreshLayoutIssueBanner();
    return;
  }
  if (!layoutGateArmed && !layoutGateVisible) {
    refreshLayoutIssueBanner();
    return;
  }
  revealLayoutGate();
}

function initializeLayoutGate() {
  if (!layoutGateEnabled) {
    setLayoutGateActive(false);
    setLayoutIssueBanner(false);
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
  const unavailableLabel = pending ? "esta na fila para envio" : "ja tem correcao pedida";
  const statusLabel = pending ? t.naFilaParaEnvio : warning.status_label;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "warning-select";
  checkbox.checked = selectable && selectedWarningIds.has(warning.id);
  checkbox.disabled = !selectable;
  checkbox.setAttribute(
    "aria-label",
    selectable
      ? "Selecionar " + warning.title + " em " + warning.viewport_label
      : warning.title + " em " + warning.viewport_label + " " + unavailableLabel,
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
    reveal.textContent = t.revelar;
    reveal.setAttribute("aria-label", t.revelarNoArtefato.replace("{titulo}", warning.title));
    reveal.addEventListener("click", () => revealWarning(warning));
    actions.appendChild(reveal);
  }
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "warning-action";
  dismiss.textContent = t.descartar;
  dismiss.disabled = !selectable;
  dismiss.setAttribute(
    "aria-label",
    selectable
      ? "Descartar " + warning.title + " nesta revisao do artefato"
      : warning.title +
          " nao pode ser descartado enquanto " +
          (pending ? "esta na fila para envio" : "ha correcao pedida"),
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
    count === 1 ? "1 problema de layout em aberto" : count + " problemas de layout em aberto",
  );

  const outstanding = active.filter((warning) => warning.outstanding).length;
  warningsSummary.textContent =
    (count === 1 ? "1 problema em aberto" : count + " problemas em aberto") +
    (outstanding > 0 ? " · " + outstanding + " ja com correcao pedida" : "");

  warningsList.replaceChildren();
  if (count === 0) {
    const empty = document.createElement("p");
    empty.className = "warnings-empty";
    empty.textContent = t.semProblemasLayout;
    warningsList.appendChild(empty);
  } else {
    for (const warning of active) warningsList.appendChild(createWarningRow(warning));
  }
  updateWarningSelectionState();
  refreshLayoutIssueBanner();
}

function updateWarningSelectionState() {
  const pending = pendingLayoutWarningIds();
  const selectable = activeWarnings().filter((warning) => warning.selectable && !pending.has(warning.id));
  const selectedCount = selectable.filter((warning) => selectedWarningIds.has(warning.id)).length;
  warningsSelectAll.disabled = selectable.length === 0;
  // Default selection is never "everything": Select all is an explicit action.
  warningsSelectAll.checked = selectable.length > 0 && selectedCount === selectable.length;
  warningsSelectAll.indeterminate = selectedCount > 0 && selectedCount < selectable.length;
  warningsSelected.textContent = selectedCount === 0 ? t.nenhumSelecionado : selectedCount + " selecionado(s)";
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
    warningsAcknowledged = true;
    saveJsonState(warningAckStorageKey, true);
    refreshLayoutIssueBanner();
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
  closeMenus();
  closeWarningsDrawer();
  renderWarnings();
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
  copyHintText.textContent = t.copiado;
  clearTimeout(copyHintTimer);
  copyHintTimer = setTimeout(() => {
    copyHint.classList.remove("copied");
    copyHintText.textContent = t.copiar;
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
  return count === 1 ? "1 asset nao resolvido" : `${count} assets nao resolvidos`;
}

function noticeText(count) {
  return count === 1 ? "1 aviso" : `${count} avisos`;
}

function exportWarningText(unresolvedCount, noticeCount) {
  if (unresolvedCount > 0 && noticeCount > 0) {
    return `${unresolvedAssetText(unresolvedCount)} e ${noticeText(noticeCount)}`;
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
    if (!response.ok) throw new Error(t.falhaExportar);
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
      setExportLabel(`Exportado com ${exportWarningText(warningCount, noticeCount)}`);
    } else {
      setExportLabel(t.exportarHtml);
      closeMenus();
    }
  } catch {
    setExportLabel(t.exportarFalhou);
  } finally {
    exportArtifactButton.disabled = false;
  }
}

async function replaceArtifactFrame() {
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
          if (handoffRefreshAttempted) return preservePreviousLoad();
          handoffRefreshAttempted = true;
          try {
            const refreshed = await refreshChromeLoadHandoff(requestSequence);
            if (!refreshed) return false;
          } catch {
            return preservePreviousLoad();
          }
          continue;
        }
        if (status === "superseded") {
          setHandoffSuperseded(true);
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
      if (delay === undefined) return preservePreviousLoad();
      await new Promise((resolve) => window.setTimeout(resolve, delay));
    }
  }
  if (requestSequence !== artifactLoadRequestSequence || ended) return false;
  const revision = Number(load?.artifact_revision);
  const token = String(load?.artifact_load_token || "");
  if (!Number.isSafeInteger(revision) || revision < 0 || !token) return preservePreviousLoad();
  artifactLoadRevision = revision;
  artifactLoadToken = token;
  artifactSpokeToken = "";
  setHandoffSuperseded(false);
  startLayoutGateCycle();
  frame.src = artifactFrameSrcForLoad({ revision, token });
  return true;
}

// dealernet: sem quadro branco nao ha cena pendente para descarregar antes de trocar a frame.
function resetFrame() {
  return replaceArtifactFrame();
}

// dealernet: todo o bloco de quadro branco (Excalidraw) foi REMOVIDO junto com o recurso:
// canais das frames embutidas, overlay em tela cheia, autosave de cena, deteccao de fonte
// Mermaid desatualizada e o envio de feedback com cena e preview. O Mermaid do artefato
// renderiza normalmente, como quando o SDK esta ausente.

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
  void resetFrame();
}

// dealernet: declarado aqui porque vivia no bloco de quadro branco removido. Serializa o reload
// do chrome apos o servidor reiniciar, para nao disparar varios ao mesmo tempo.
let chromeRestartReloadPromise = null;

async function reloadAfterServerRestart() {
  if (chromeRestartReloadPromise) return chromeRestartReloadPromise;
  chromeRestartReloadPromise = reloadChromeAfterServerRestart();
  return chromeRestartReloadPromise;
}

async function reloadChromeAfterServerRestart() {
  let sawOutage = false;
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    try {
      const res = await fetch("/health", { cache: "no-store" });
      if (sawOutage && res.ok) {
        location.reload();
        return;
      }
    } catch {
      sawOutage = true;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

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
      submitQueued();
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
  if (msg.type === "lavish:sendQueuedPrompts") sendQueued();
  if (msg.type === "lavish:endSession") endSession();
  if (msg.type === "lavish:toggleAnnotationMode") toggleAnnotationMode();
});

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
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (warningsDrawerOpen) {
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
});

initializeLayoutGate();

const events = new EventSource("/events/" + key);
events.addEventListener("reload", () => {
  void resetFrame();
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
