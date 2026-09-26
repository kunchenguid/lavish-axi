/* global document, location, window */

const sessionDataElement = document.getElementById("lavish-session");
const sessionData = JSON.parse(sessionDataElement?.textContent || "{}");
const key = String(sessionData.key || "");
const filePath = String(sessionData.file || "");
const entryPage = typeof sessionData.entryPage === "string" ? sessionData.entryPage : "";
const queueStorageKey = "lavish-axi:queued:" + key;
const terminalStorageKey = "lavish-axi:terminal:" + key;
// Review-chrome state that must survive a browser refresh. Keyed per session so one review's
// triage can never leak into another artifact's.
const warningSelectionStorageKey = "lavish-axi:warning-selection:" + key;
// Unsent annotation-card text lives only in the sandboxed iframe, so a full page reload would
// destroy it unless the chrome persists what the SDK reports. Keyed per session like the queue,
// so a draft can never reappear over a different artifact.
const reviewStateStorageKey = "lavish-axi:review-state:" + key;
// Protocol-1 review state is an envelope of canonical page records. The array
// is intentional: page identities are data, not object-property names, so a
// page called "__proto__" (or any other special property) cannot collide with
// the registry itself. Legacy single-page chrome keeps using the value above
// directly; migration of an old object is deferred until the first page binds.
const pageReviewStateVersion = 1;
// The current artifact destination is chrome-owned navigation state. It is kept
// separately from the page identity/proof: query strings and fragments belong to
// the authored URL, while page/proof belong to the server-established document.
const destinationStorageKey = "lavish-axi:destination:" + key;
// Drafts Lavish could not replay. The text outlives the draft that carried it, so the user can
// still read and copy it after the anchor it was written against is gone for good.
const retiredDraftStorageKey = "lavish-axi:retired-drafts:" + key;
/** @type {any[]} */
const retiredDraftNodes = [];
const internalQueueKeyField = "_lavishQueueKey";
const promptIdentityField = "prompt_id";
const PROMPT_IDENTITY_MAX = 128;
const PROMPT_IDENTITY_RE = /^[A-Za-z0-9_-]+$/;
const initialChat = Array.isArray(sessionData.initialChat) ? sessionData.initialChat : [];
const initialChatAckIds = Array.isArray(sessionData.initialChatAckIds) ? sessionData.initialChatAckIds : [];
const initialChatRevision = parseChatRevision(sessionData.initialChatRevision) || 0;
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
const queuedLog = /** @type {HTMLDivElement} */ (document.getElementById("queuedLog"));
const chatLog = /** @type {HTMLDivElement} */ (document.getElementById("chatLog"));
const chatComposer = /** @type {HTMLDivElement} */ (document.getElementById("chatComposer"));
const chatInput = /** @type {HTMLTextAreaElement} */ (document.getElementById("chatInput"));
const chatAttachments = /** @type {HTMLDivElement} */ (document.getElementById("chatAttachments"));
const chatAttachButton = /** @type {HTMLButtonElement} */ (document.getElementById("chatAttach"));
const chatAttachInput = /** @type {HTMLInputElement} */ (document.getElementById("chatAttachInput"));
const chatAttachmentNotice = /** @type {HTMLSpanElement} */ (document.getElementById("chatAttachmentNotice"));
const panel = /** @type {HTMLElement} */ (document.getElementById("panel"));
const panelHead = /** @type {HTMLDivElement} */ (document.getElementById("panelHead"));
const panelSummary = /** @type {HTMLSpanElement} */ (document.getElementById("panelSummary"));
const panelToggle = /** @type {HTMLButtonElement} */ (document.getElementById("panelToggle"));
const panelScrim = /** @type {HTMLDivElement} */ (document.getElementById("panelScrim"));
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
const shareGenerateInput = /** @type {HTMLInputElement} */ (document.getElementById("shareGenerate"));
const sharePasswordResult = /** @type {HTMLLabelElement} */ (document.getElementById("sharePasswordResult"));
const shareUrlResult = /** @type {HTMLLabelElement} */ (document.getElementById("shareUrlResult"));
const shareUpdateKeyResult = /** @type {HTMLLabelElement} */ (document.getElementById("shareUpdateKeyResult"));
const shareUpdateKeyNote = /** @type {HTMLParagraphElement} */ (document.getElementById("shareUpdateKeyNote"));
const shareSiteIdResult = /** @type {HTMLLabelElement} */ (document.getElementById("shareSiteIdResult"));
const shareSiteIdInput = /** @type {HTMLInputElement} */ (document.getElementById("shareSiteId"));
const sharePasswordOutput = /** @type {HTMLInputElement} */ (document.getElementById("sharePasswordOut"));
const copySharePasswordButton = /** @type {HTMLButtonElement} */ (document.getElementById("copySharePassword"));
const copyShareUrlButton = /** @type {HTMLButtonElement} */ (document.getElementById("copyShareUrl"));
const copyUpdateKeyButton = /** @type {HTMLButtonElement} */ (document.getElementById("copyUpdateKey"));
const copyShareSiteIdButton = /** @type {HTMLButtonElement} */ (document.getElementById("copyShareSiteId"));
const endButton = /** @type {HTMLButtonElement} */ (document.getElementById("end"));
const copyPathButton = /** @type {HTMLButtonElement} */ (document.getElementById("copyPath"));
const copyHint = /** @type {HTMLSpanElement} */ (document.getElementById("copyHint"));
const copyHintText = /** @type {HTMLSpanElement} */ (document.getElementById("copyHintText"));
const presenceBanner = /** @type {HTMLDivElement} */ (document.getElementById("presenceBanner"));
const handoffBanner = /** @type {HTMLDivElement} */ (document.getElementById("handoffBanner"));
const handoffTakeoverButton = /** @type {HTMLButtonElement} */ (document.getElementById("handoffTakeover"));
const outdatedBanner = /** @type {HTMLDivElement} */ (document.getElementById("outdatedBanner"));
const outdatedText = /** @type {HTMLSpanElement} */ (document.getElementById("outdatedText"));
const outdatedReloadButton = /** @type {HTMLButtonElement} */ (document.getElementById("outdatedReload"));
const outdatedDismissButton = /** @type {HTMLButtonElement} */ (document.getElementById("outdatedDismiss"));
const endedOverlay = /** @type {HTMLDivElement} */ (document.getElementById("endedOverlay"));
const layoutGateOverlay = /** @type {HTMLDivElement} */ (document.getElementById("layoutGateOverlay"));
const layoutGateTitle = /** @type {HTMLDivElement} */ (document.getElementById("layoutGateTitle"));
const layoutGateCopy = /** @type {HTMLParagraphElement} */ (document.getElementById("layoutGateCopy"));
const layoutGateAction = /** @type {HTMLButtonElement} */ (document.getElementById("layoutGateAction"));
const layoutGateBypass = /** @type {HTMLButtonElement} */ (document.getElementById("layoutGateBypass"));
const layoutGateEscape = /** @type {any} */ (window).__lavishLayoutGateEscape;
const warningsWrap = /** @type {HTMLDivElement} */ (document.getElementById("warningsWrap"));
const warningsButton = /** @type {HTMLButtonElement} */ (document.getElementById("warningsButton"));
const warningsCount = /** @type {HTMLSpanElement} */ (document.getElementById("warningsCount"));
const warningsDrawer = /** @type {HTMLDivElement} */ (document.getElementById("warningsDrawer"));
const warningsSummary = /** @type {HTMLParagraphElement} */ (document.getElementById("warningsSummary"));
const warningsSelectAll = /** @type {HTMLInputElement} */ (document.getElementById("warningsSelectAll"));
const warningsSelected = /** @type {HTMLSpanElement} */ (document.getElementById("warningsSelected"));
const warningsList = /** @type {HTMLDivElement} */ (document.getElementById("warningsList"));
const warningsQueueButton = /** @type {HTMLButtonElement} */ (document.getElementById("warningsQueueButton"));
const revisionsWrap = /** @type {HTMLDivElement} */ (document.getElementById("revisionsWrap"));
const revisionsButton = /** @type {HTMLButtonElement} */ (document.getElementById("revisionsButton"));
const revisionsCount = /** @type {HTMLSpanElement} */ (document.getElementById("revisionsCount"));
const revisionsDrawer = /** @type {HTMLDivElement} */ (document.getElementById("revisionsDrawer"));
const revisionsSummary = /** @type {HTMLParagraphElement} */ (document.getElementById("revisionsSummary"));
const revisionsList = /** @type {HTMLDivElement} */ (document.getElementById("revisionsList"));
const sendHint = /** @type {HTMLDivElement} */ (document.getElementById("sendHint"));
const whiteboardOverlay = /** @type {HTMLDivElement} */ (document.getElementById("whiteboardOverlay"));
const whiteboardFrame = /** @type {HTMLIFrameElement} */ (document.getElementById("whiteboardFrame"));
const whiteboardCloseButton = /** @type {HTMLButtonElement} */ (document.getElementById("whiteboardClose"));
const whiteboardError = /** @type {HTMLDivElement} */ (document.getElementById("whiteboardError"));
const artifactSrc = frame.dataset.artifactSrc || frame.getAttribute?.("data-artifact-src") || frame.src || "";
// Protocol 1 keeps the generation in the injected SDK context rather than in
// the document URL.  In particular, a real user-authored `index.html` must not
// acquire the legacy revision/token query pair: that pair intentionally selects
// the historical virtual entry route on the server.
const modernArtifactProtocol = sessionData.pageProtocol === 1;
const legacyQueuedPageField = "_lavishLegacyQueuedPage";

const queued = loadQueuedPrompts();
let annotation = true;
let ended = false;
let agentPresence = "waiting";
const layoutGateEnabled = sessionData.layoutGateEnabled !== false;
const configuredLayoutGateMaxHoldMs = Number(sessionData.layoutGateMaxHoldMs);
const layoutGateMaxHoldMs =
  Number.isFinite(configuredLayoutGateMaxHoldMs) && configuredLayoutGateMaxHoldMs > 0
    ? Math.min(configuredLayoutGateMaxHoldMs, 60_000)
    : 12_000;
let chromeOutdatedReason = "";
let chromeOutdatedGeneration = 0;
let outdatedReloadInFlight = false;
// The live-event socket reconnects forever on a 5s cap. Silence there is indistinguishable from a
// healthy idle stream, so a page whose server has gone away keeps rendering its last state and
// tells the user nothing until they reload into a connection error. Past this many consecutive
// failures the banner says so, with the health-probed reload the banner already offers.
const LIVE_EVENT_UNREACHABLE_FAILURES = 5;
let liveEventFailures = 0;
// Only a banner this path raised may be hidden by this path: a `chrome-outdated` event means the
// server was replaced, which a reconnect does not disprove.
let unreachableBannerOwned = false;
let unreachableDismissed = false;
/** @type {{ selector: string, revision: number } | null} */
let unrestorableDraftMiss = null;
let retiredDrafts = loadRetiredDrafts();
let layoutGateVisible = false;
let layoutGateManuallyBypassed = !layoutGateEnabled;
let layoutGateFailureActive = false;
// A failure only the user can retire. The artifact-load card clears itself once a load succeeds;
// the server-replacement card must not, because the page is still running the pre-upgrade client
// against the replacement server and nothing else would tell the user that.
let layoutGateFailureSticky = false;
let layoutGateCycle = 0;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let layoutGateTimer;
// The warning inbox is server-owned review state. The chrome renders it and posts triage
// actions; it never decides on its own that a warning went away.
let layoutWarnings = Array.isArray(sessionData.initialLayoutWarnings) ? sessionData.initialLayoutWarnings : [];
const selectedWarningIds = new Set(loadJsonState(warningSelectionStorageKey, []));
let warningsDrawerOpen = false;
/** @typedef {{ page: string | null, done: Promise<boolean>, finish: (succeeded: boolean) => void }} FeedbackPreparation */
/** @typedef {{ page?: string | null, prompts: any[], inFlight: boolean, order: number }} TerminalSubmission */
/** @typedef {{ version: number, page: string | null, proof: string, route: string, destination: string, documentId: string, documentSequence: number, token: string, revision: number }} SnapshotBinding */
/** @type {Map<string, { action: "copy" | "submit", prompts?: any[], chatAtRequest?: any[], endAfter?: boolean, terminal?: TerminalSubmission | null, acknowledgement?: object, order?: number, timeout?: ReturnType<typeof setTimeout>, binding?: SnapshotBinding | null }>} */
const snapshotRequests = new Map();
let nextSnapshotRequestId = 0;
let nextSendOperationOrder = 0;
let workingBubble = null;
let displayedChat = initialChat.slice();
let chatRevision = initialChatRevision;
// Settlement is by per-submission identity, not displayed content: two tabs can queue notes
// whose chat projection is identical (same selected text under one container, different range
// boundaries) without settling each other, and a reload after a lost POST response still
// recognizes an already-accepted note.
let submitQueuedPromise = null;
const pendingSubmissions = [];
/** @type {{ prompts?: any[] } | null} */
let activeSubmission = null;
const deliveredPrompts = new WeakSet();
const pendingAcknowledgements = new Set();
/** @type {Set<FeedbackPreparation>} */
const feedbackPreparations = new Set();
/** @type {TerminalSubmission | null} */
let terminalSubmission = restoreTerminalReservation();
/** @type {ReturnType<typeof setTimeout> | undefined} */
let sendAcknowledgementTimer;
let lastScroll = { x: 0, y: 0 };
// In-iframe review context (an open annotation card's unsent text, Lavish-owned question
// answers). The sandbox means the chrome cannot read it back after a reload, so the SDK reports
// it as it changes and the chrome replays it once the new document is up. It is persisted per
// session so a full page reload replays it too.
const loadedPageReviewState = modernArtifactProtocol ? loadPageReviewState() : null;
/** @type {Map<string, { page: string | null, scroll: { x: number, y: number }, reviewState: any, unrestorableDraftMiss: { selector: string, revision: number } | null }>} */
const pageReviewStates = loadedPageReviewState?.records || new Map();
let legacyReviewState = loadedPageReviewState?.legacyReviewState || null;
let legacyReviewStateMigrated = false;
// The currently bound page is the only page whose state can be sent back into the iframe.
// `activeReviewPage` remains useful during the short no-binding gap between pagehide and the
// next challenge; stale messages are still rejected by the binding tuple before it is consulted.
let activeReviewPage = null;
let lastReviewState = modernArtifactProtocol ? null : loadJsonState(reviewStateStorageKey, null);
if (lastReviewState && typeof lastReviewState !== "object") lastReviewState = null;
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
// A probe must always settle, so the control that is waiting on it always comes back.
const HEALTH_PROBE_TIMEOUT_MS = 4000;
// A send starts before the artifact snapshot arrives and ends only when /prompts acknowledges the
// batch. Bound that whole wait so a missing SDK response or a browser/network stall can never look
// like a dead button while the user's queue remains safely stored in this tab.
const SEND_ACKNOWLEDGEMENT_WARNING_MS = 10_000;
const TERMINAL_PREPARATION_TIMEOUT_MS = 5000;
// A DOM snapshot adds useful context, but the reviewer's own words are the payload.
// If the artifact frame navigated away from the injected SDK (or otherwise stopped
// answering), deliver those words without a snapshot instead of waiting forever.
const SNAPSHOT_REQUEST_TIMEOUT_MS = 5000;
const SEND_STALLED_COPY =
  "Still trying to send. Your feedback is saved in this tab. Keep this tab open while Lavish catches up, and check that the server is running.";
const SEND_FAILED_COPY =
  "Could not send. Your feedback is still queued in this tab. Check that Lavish is running, then click Send to Agent to retry.";
const TERMINAL_SEND_FAILED_COPY =
  "Could not send. Your terminal feedback is still queued in this tab. Check that Lavish is running, then click Send & End to retry the same batch.";
const HEALTH_NO_ANSWER_TITLE = "Lavish did not answer.";
const HEALTH_NO_ANSWER_COPY =
  "Lavish did not answer the check, so this page cannot tell whether it is running. Try again in a moment.";
let artifactLoadToken = "";
let artifactLoadRevision = Number(sessionData.initialArtifactRevision) || 0;
let artifactLoadRequestSequence = Number(sessionData.initialArtifactLoadSequence) || 0;
let chromeLoadToken = String(sessionData.chromeLoadToken || "");
artifactLoadToken = String(sessionData.initialArtifactLoadToken || "");
let artifactSpokeToken = "";
let artifactMessageSequence = 0;
let layoutDiagnosticSequence = 0;
/** @type {{ port: MessagePort, page: string|null, proof: string, route: string, destination: string, documentId: string, documentSequence: number, token: string, revision: number, version: number, window: WindowProxy } | null} */
let currentArtifactBinding = null;
/** @type {{ documentId: string, port: MessagePort, timeout: ReturnType<typeof setTimeout> } | null} */
let artifactChallengeAttempt = null;
let latestReadyDocumentId = "";
let pendingReadyLoadDocumentId = "";
let nextDocumentSequence = 0;
let nextBindingVersion = 0;
let artifactLoadRecoveryAttempt = 0;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let artifactLoadRecoveryTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let artifactSilenceTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let copyHintTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let sendHintTimer;
let sendHintPersistent = false;
/** @type {{ kind: "preparation" | "submission" | "terminal", operation: object, preparationType?: string } | null} */
let sendFailureOwner = null;
let sendAcknowledgementWarningVisible = false;

let artifactLoadDestination = "";
/** @type {{ page: string, proof: string, route: string, destination: string, documentSequence: number, token: string, revision: number } | null} */
let pendingArtifactFailureBinding = null;
let topLevelTeardown = false;
const MAX_CONTROLLED_RELOAD_DISCRIMINATORS = 32;
const controlledReloadDiscriminators = [];
const historicalDestinations = new Map();
const MAX_HISTORICAL_DESTINATIONS = 64;
const historicalDestinationStorageKey = destinationStorageKey + ":history";
const retainedHistory = loadJsonState(historicalDestinationStorageKey, []);
if (Array.isArray(retainedHistory)) {
  for (const record of retainedHistory.slice(-MAX_HISTORICAL_DESTINATIONS)) {
    if (
      record &&
      typeof record.document_id === "string" &&
      typeof record.url === "string" &&
      record.url.length <= 65536
    )
      historicalDestinations.set(historyDestinationKey(record.document_id, record.url), record);
  }
}

function historyDestinationKey(documentId, destination) {
  return JSON.stringify([documentId, destination]);
}

function rememberHistoricalDestination(documentId, destination, receipt) {
  if (typeof receipt !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(receipt) || !destination) return;
  const id = historyDestinationKey(documentId, destination.url);
  historicalDestinations.delete(id);
  historicalDestinations.set(id, { ...destination, document_id: documentId, receipt });
  while (historicalDestinations.size > MAX_HISTORICAL_DESTINATIONS)
    historicalDestinations.delete(historicalDestinations.keys().next().value);
  saveJsonState(historicalDestinationStorageKey, Array.from(historicalDestinations.values()));
}

async function refreshHistoricalDestination(binding) {
  const destination = destinationPayload(destinationRecord(binding));
  const documentId = binding.documentId;
  if (!destination) return;
  try {
    const response = await fetch("/api/" + key + "/artifact-bindings/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        page: binding.page,
        page_proof: binding.proof,
        served_route: binding.route,
        artifact_load_token: binding.token,
        artifact_revision: binding.revision,
        document_id: binding.documentId,
        destination,
      }),
    });
    const result = await response.json();
    if (!response.ok) return;
    // Responses for different URLs may arrive in any order. They populate exact keys,
    // and never restore an older destination into the current binding.
    // Signing was authorized by the server before the response was sent. Retirement
    // while that response is in flight does not invalidate historical evidence.
    rememberHistoricalDestination(documentId, destination, result.receipt);
  } catch {
    /* Recovery without evidence fails closed. */
  }
}

function decodeNavigationPart(value) {
  try {
    return decodeURIComponent(String(value || "").replace(/\+/g, " "));
  } catch {
    return String(value || "");
  }
}

function stripControlledReloadParameter(destination) {
  const raw = String(destination || "");
  const hashIndex = raw.indexOf("#");
  const beforeHash = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : raw.slice(hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  if (queryIndex === -1) return beforeHash + hash;
  const pathname = beforeHash.slice(0, queryIndex);
  const query = beforeHash.slice(queryIndex + 1);
  let removed = false;
  const kept = [];
  for (const part of query.split("&")) {
    if (!part) {
      kept.push(part);
      continue;
    }
    const equals = part.indexOf("=");
    const name = equals === -1 ? part : part.slice(0, equals);
    if (decodeNavigationPart(name) !== "__lavish_reload") {
      kept.push(part);
      continue;
    }
    const value = equals === -1 ? "" : decodeNavigationPart(part.slice(equals + 1));
    if (removed || !controlledReloadDiscriminators.includes(value)) return null;
    removed = true;
  }
  return pathname + (kept.length ? "?" + kept.join("&") : "") + hash;
}

function freshReloadDestination(destination) {
  const clean = String(destination || artifactSrc);
  if (!clean) return "";
  const hashIndex = clean.indexOf("#");
  const beforeHash = hashIndex === -1 ? clean : clean.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : clean.slice(hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  const hasQuery = queryIndex !== -1 && queryIndex < beforeHash.length - 1;
  const separator = hasQuery ? "&" : "?";
  const discriminator = randomBindingChallenge();
  controlledReloadDiscriminators.push(discriminator);
  if (controlledReloadDiscriminators.length > MAX_CONTROLLED_RELOAD_DISCRIMINATORS) {
    controlledReloadDiscriminators.splice(
      0,
      controlledReloadDiscriminators.length - MAX_CONTROLLED_RELOAD_DISCRIMINATORS,
    );
  }
  return beforeHash + separator + "__lavish_reload=" + encodeURIComponent(discriminator) + hash;
}

function navigationPath(destination) {
  const raw = String(destination || "");
  const hashIndex = raw.indexOf("#");
  const beforeHash = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  return queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
}

function artifactPathPrefix() {
  return "/artifact/" + encodeURIComponent(key) + "/";
}

function destinationForServedRoute(servedRoute) {
  const route = String(servedRoute || "");
  if (!route || route.includes("\0") || route.startsWith("/")) return "";
  // `served_route` is the server-accepted lexical route. It is deliberately not
  // decoded or normalized here: relative links may depend on its exact alias.
  return artifactPathPrefix() + route.split("/").map(encodeURIComponent).join("/");
}

function fallbackLocationDestination(candidate) {
  const raw = String(candidate || "");
  if (!raw) return "";
  if (raw.startsWith("/")) return raw;
  const origin = String(location.protocol || "") + "//" + String(location.host || "");
  if (origin !== "//" && raw.startsWith(origin)) return raw.slice(origin.length) || "/";
  return "";
}

function frameLocationDestination() {
  try {
    const href = frame.contentWindow?.location?.href;
    return fallbackLocationDestination(href);
  } catch {
    // A sandboxed artifact normally has an opaque origin. Its WindowProxy permits
    // navigation but not reading location, so the challenged served route remains
    // the authoritative fallback in that case.
    return "";
  }
}

// Compare exactly one decoding per segment, not URL spellings or normalized paths.
// Keep in sync with artifactDestinationPathMatches in artifact-page.js.
function artifactDestinationPathMatches(pathname, expectedPath) {
  try {
    const actual = pathname.split("/");
    const expected = expectedPath.split("/");
    return (
      actual.length === expected.length &&
      actual.every((part, index) => {
        const decoded = decodeURIComponent(part);
        return (
          decoded !== "." &&
          decoded !== ".." &&
          !decoded.includes("\0") &&
          !decoded.includes("/") &&
          decoded === decodeURIComponent(expected[index])
        );
      })
    );
  } catch {
    return false;
  }
}

function normalizeArtifactDestination(value, servedRoute = "") {
  const candidate = String(value || "");
  const fallback = destinationForServedRoute(servedRoute);
  if (!candidate) return fallback;
  if (candidate.includes("\0") || candidate.includes("\\")) return "";
  try {
    const parsed =
      typeof URL === "function"
        ? new URL(candidate, location.href)
        : (() => {
            const relative = fallbackLocationDestination(candidate);
            if (!relative) return null;
            const hashIndex = relative.indexOf("#");
            const beforeHash = hashIndex === -1 ? relative : relative.slice(0, hashIndex);
            const hash = hashIndex === -1 ? "" : relative.slice(hashIndex);
            const queryIndex = beforeHash.indexOf("?");
            const pathname = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
            const search = queryIndex === -1 ? "" : beforeHash.slice(queryIndex);
            return {
              origin: String(location.protocol || "") + "//" + String(location.host || ""),
              pathname,
              search,
              hash,
            };
          })();
    if (!parsed || (typeof URL === "function" && parsed.origin !== location.origin)) return "";
    const pathName = parsed.pathname;
    if (!pathName.startsWith(artifactPathPrefix())) return "";
    // Inspect before URL parsing too: it otherwise erases dot-segment traversal.
    const rawPath = navigationPath(fallbackLocationDestination(candidate));
    if (
      fallback &&
      (!artifactDestinationPathMatches(rawPath, navigationPath(fallback)) ||
        !artifactDestinationPathMatches(pathName, navigationPath(fallback)))
    )
      return "";
    return stripControlledReloadParameter(pathName + parsed.search + parsed.hash) || "";
  } catch {
    return "";
  }
}

function bindingDestination(binding) {
  if (!binding) return "";
  const routeDestination = destinationForServedRoute(binding.route);
  const observed = binding.destination || binding.authoredDestination || frameLocationDestination() || routeDestination;
  return normalizeArtifactDestination(observed, binding.route) || String(observed || "");
}

function destinationRecord(bindingOrDestination) {
  if (!bindingOrDestination) return null;
  const binding = bindingOrDestination;
  const destination = bindingDestination(binding);
  if (!destination) return null;
  return {
    available: true,
    destination,
    // Keep the server-issued, root-relative route. The public `/artifact/...`
    // pathname is only a transport URL and cannot be used to re-resolve the
    // underlying file safely after a chrome reload.
    route: String(binding.route || ""),
    page: binding.page ?? null,
    page_proof: String(binding.proof || ""),
  };
}

function persistDestinationRecord(record) {
  if (!modernArtifactProtocol) return;
  saveJsonState(destinationStorageKey, record);
}

function markDestinationUnavailable() {
  if (!modernArtifactProtocol || topLevelTeardown) return;
  persistDestinationRecord({ available: false });
}

function readRetainedDestination() {
  if (!modernArtifactProtocol) return null;
  const record = loadJsonState(destinationStorageKey, null);
  if (!record || record.available !== true) return null;
  return {
    destination: String(record.destination || ""),
    route: String(record.route || ""),
    page: record.page === null ? null : String(record.page || ""),
    proof: String(record.page_proof || ""),
  };
}

function currentDestinationCandidate(explicit = null) {
  if (explicit) return explicit;
  if (currentArtifactBinding) return destinationRecord(currentArtifactBinding);
  return readRetainedDestination();
}

function destinationPayload(candidate) {
  if (!candidate) return null;
  const destination = String(candidate.destination || candidate.url || candidate.route || "");
  if (!destination) return null;
  const hashIndex = destination.indexOf("#");
  const beforeHash = hashIndex === -1 ? destination : destination.slice(0, hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  return {
    url: destination,
    route: typeof candidate.route === "string" ? candidate.route : "",
    page: candidate.page === undefined ? null : candidate.page,
    page_proof: String(candidate.proof || candidate.page_proof || ""),
    query: queryIndex === -1 ? "" : beforeHash.slice(queryIndex + 1),
    fragment: hashIndex === -1 ? "" : destination.slice(hashIndex + 1),
  };
}

function navigateArtifactFrame(destination) {
  const next = String(destination || "");
  // Legacy loads intentionally assign `src`: existing recovery/availability
  // accounting observes that navigation, and the legacy URL carries its load
  // token in the query string.  Protocol 1 uses `location.replace` so a
  // controlled reload does not add a synthetic entry to authored history.
  if (!modernArtifactProtocol) {
    frame.src = next;
    return;
  }
  try {
    const childLocation = frame.contentWindow?.location;
    if (childLocation && typeof childLocation.replace === "function") {
      childLocation.replace(next);
      return;
    }
  } catch {
    // Cross-origin/sandboxed frames may deny reading location; assigning the
    // iframe source remains the compatibility fallback for those browsers.
  }
  frame.src = next;
}

function artifactFrameSrcForLoad(load = {}) {
  if (modernArtifactProtocol) {
    const requested = load.destination || load.artifact_url || load.artifactUrl || currentDestinationCandidate();
    const candidate =
      typeof requested === "string" ? { destination: requested, route: navigationPath(requested) } : requested;
    const destination = normalizeArtifactDestination(
      candidate?.destination || candidate?.url || candidate?.route || artifactSrc,
      candidate?.route || "",
    );
    return destination ? freshReloadDestination(destination) : "";
  }
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
    return true;
  } catch {
    // The in-memory state still works if browser storage is unavailable.
    return false;
  }
}

function isReviewStateObject(value) {
  return Boolean(value && typeof value === "object" && (Object.hasOwn(value, "card") || Array.isArray(value.fields)));
}

function reviewStatePageKey(page) {
  // JSON is used only as a Map key. It distinguishes the entry/null namespace
  // from a literal page string without assigning untrusted text to an object.
  return JSON.stringify(page === null || page === undefined ? null : String(page));
}

function normalizeReviewStateScroll(value) {
  if (!value || typeof value !== "object") return { x: 0, y: 0 };
  const x = Number(value.x);
  const y = Number(value.y);
  return {
    x: Number.isFinite(x) && x >= 0 ? x : 0,
    y: Number.isFinite(y) && y >= 0 ? y : 0,
  };
}

function normalizeReviewStatePageRecord(value) {
  if (!value || typeof value !== "object") return null;
  if (!Object.hasOwn(value, "page")) return null;
  if (value.page !== null && typeof value.page !== "string") return null;
  const miss = value.unrestorable_draft_miss;
  return {
    page: value.page === null ? null : value.page,
    scroll: normalizeReviewStateScroll(value.scroll),
    reviewState: isReviewStateObject(value.review_state) ? value.review_state : null,
    unrestorableDraftMiss:
      miss &&
      typeof miss === "object" &&
      typeof miss.selector === "string" &&
      Number.isSafeInteger(Number(miss.revision))
        ? { selector: miss.selector, revision: Number(miss.revision) }
        : null,
  };
}

function loadPageReviewState() {
  const stored = loadJsonState(reviewStateStorageKey, null);
  const records = new Map();
  let legacyReviewState = null;
  if (stored && stored.version === pageReviewStateVersion && Array.isArray(stored.pages)) {
    for (const raw of stored.pages) {
      const record = normalizeReviewStatePageRecord(raw);
      if (record) records.set(reviewStatePageKey(record.page), record);
    }
  } else if (isReviewStateObject(stored)) {
    // Do not destroy a pre-page-protocol draft merely because the new chrome
    // cannot know its page until the first document completes its handshake.
    legacyReviewState = stored;
  }
  return { records, legacyReviewState };
}

function serializePageReviewState(records) {
  return {
    version: pageReviewStateVersion,
    pages: [...records.values()].map((record) => ({
      page: record.page,
      scroll: normalizeReviewStateScroll(record.scroll),
      review_state: isReviewStateObject(record.reviewState) ? record.reviewState : null,
      unrestorable_draft_miss: record.unrestorableDraftMiss
        ? {
            selector: String(record.unrestorableDraftMiss.selector || ""),
            revision: Number(record.unrestorableDraftMiss.revision) || 0,
          }
        : null,
    })),
  };
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

function isPromptIdentity(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= PROMPT_IDENTITY_MAX &&
    PROMPT_IDENTITY_RE.test(value)
  );
}

function promptIdentity(value) {
  return isPromptIdentity(value?.[promptIdentityField]) ? value[promptIdentityField] : "";
}

const chatAckIds = new Set();
function rememberChatAckIds(ids) {
  if (!Array.isArray(ids)) return;
  for (const value of ids) {
    if (isPromptIdentity(value)) chatAckIds.add(value);
  }
}
rememberChatAckIds(initialChatAckIds);

function createPromptIdentity() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

function assignPromptIdentity(prompt, keepExisting) {
  if (keepExisting && promptIdentity(prompt)) return prompt;
  prompt[promptIdentityField] = createPromptIdentity();
  return prompt;
}

function adoptQueuedPrompt(rawPrompt, keepIdentity) {
  const prompt = sanitizeQueuedPrompt(rawPrompt);
  if (!prompt) return null;
  if (!keepIdentity) delete prompt[promptIdentityField];
  assignPromptIdentity(prompt, true);
  return prompt;
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
    // Keep a stored identity so a reload can settle an already-accepted note; mint
    // one only when the restored prompt predates identity.
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => adoptQueuedPrompt(item, true))
      .filter(Boolean)
      .map((prompt) => {
        // Pre-page-protocol tabs persisted no attribution fields. Keep that
        // provenance distinct until the server authenticates the saved entry.
        if (modernArtifactProtocol && !Object.hasOwn(prompt, "page")) {
          prompt[legacyQueuedPageField] = true;
        }
        return prompt;
      });
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

function persistTerminalReservation(reserved) {
  try {
    if (reserved)
      sessionStorage.setItem(
        terminalStorageKey,
        JSON.stringify(
          modernArtifactProtocol
            ? { page: terminalSubmission?.page, ids: terminalSubmission?.prompts.map((prompt) => prompt.prompt_id) }
            : true,
        ),
      );
    else sessionStorage.removeItem(terminalStorageKey);
  } catch {
    // Session storage can be unavailable; the in-memory reservation still protects this page.
  }
}

function restoreTerminalReservation() {
  const saved = loadJsonState(terminalStorageKey, false);
  if (!modernArtifactProtocol)
    return saved === true ? { prompts: queued.slice(), inFlight: false, order: ++nextSendOperationOrder } : null;
  // Old boolean reservations did not identify a page or exact batch. Preserve the
  // writing as an editable queue, never infer an aggregate terminal submission.
  if (!saved || typeof saved.page !== "string" || !Array.isArray(saved.ids)) return null;
  const prompts = queued.filter((prompt) => saved.ids.includes(prompt.prompt_id));
  if (prompts.some((prompt) => prompt.page !== saved.page)) return null;
  return { page: saved.page, prompts, inFlight: false, order: ++nextSendOperationOrder };
}

function belongsToReviewPage(item, page = currentArtifactBinding?.page) {
  return !modernArtifactProtocol || (typeof page === "string" && item?.page === page);
}

function queuedForPage(page = currentArtifactBinding?.page) {
  return queued.filter((prompt) => belongsToReviewPage(prompt, page));
}

const REMOVE_ICON_SVG =
  '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const ANCHOR_EXCERPT_MAX = 120;
const ANCHOR_SELECTOR_MAX = 512;
const ANCHOR_LABEL_MAX = 40;

function boundAnchorText(value, max) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

// What a queued note is attached to, in the annotation card's own words. This is the same rule
// as the server's `chatEntryForPrompt` (src/chat-messages.js), which derives the anchor for the
// note once it is sent: a queued prompt has not reached the server yet and this file cannot
// import modules, so the rule is duplicated here and test/chrome-client-queue.test.js pins the
// two against the same fixtures. A bubble must not change its anchor when it settles.
function promptAnchor(prompt) {
  const tag = String(prompt?.tag || "");
  if (tag === "message") return null;
  const target = prompt?.target && typeof prompt.target === "object" ? prompt.target : null;
  const selector = boundAnchorText(prompt?.selector, ANCHOR_SELECTOR_MAX);
  const withSelector = (anchor) => (selector ? { ...anchor, selector } : anchor);
  if (tag === "whiteboard") {
    const index = Number(target?.diagramIndex);
    const excerpt = Number.isInteger(index) && index >= 0 ? "Diagram " + (index + 1) : prompt.text;
    return { kind: "whiteboard", label: "whiteboard", excerpt: boundAnchorText(excerpt, ANCHOR_EXCERPT_MAX) };
  }
  if (tag === "layout-warnings") {
    const count = Array.isArray(target?.warnings) ? target.warnings.length : 0;
    const excerpt = count > 0 ? count + (count === 1 ? " issue" : " issues") : prompt.text;
    return { kind: "layout", label: "layout", excerpt: boundAnchorText(excerpt, ANCHOR_EXCERPT_MAX) };
  }
  const type = String(target?.type || "");
  if (type === "text-range") {
    return withSelector({
      kind: "text",
      label: "text",
      excerpt: boundAnchorText(target.text || prompt.text, ANCHOR_EXCERPT_MAX),
    });
  }
  if (type === "table-cell") {
    const semantic = [target.rowLabel, target.columnLabel]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" \u2192 ");
    if (semantic)
      return withSelector({ kind: "cell", label: "cell", excerpt: boundAnchorText(semantic, ANCHOR_EXCERPT_MAX) });
  }
  if (type === "mermaid-node") {
    return withSelector({
      kind: "node",
      label: "node",
      excerpt: boundAnchorText(target.label || prompt.text, ANCHOR_EXCERPT_MAX),
    });
  }
  const elementTag = tag.trim();
  if (!elementTag) return null;
  return withSelector({
    kind: "element",
    label: boundAnchorText("<" + elementTag + ">", ANCHOR_LABEL_MAX),
    excerpt: boundAnchorText(prompt.text, ANCHOR_EXCERPT_MAX),
  });
}

// The anchor line: a mono chip naming the kind (`<h2>`, `text`, `cell`, ...) and a quoted
// excerpt, with the full excerpt and selector on hover.
function anchorHtml(anchor) {
  if (!anchor || typeof anchor !== "object") return "";
  const excerpt = String(anchor.excerpt || "");
  const title = [excerpt, anchor.selector].filter(Boolean).join("\n");
  return (
    '<div class="anchor" title="' +
    escapeHtml(title) +
    '"><span class="anchor-kind">' +
    escapeHtml(anchor.label || "") +
    "</span>" +
    (excerpt
      ? '<span class="anchor-excerpt' +
        (anchor.kind === "text" ? " text" : "") +
        '">\u201C' +
        escapeHtml(excerpt) +
        "\u201D</span>"
      : "") +
    "</div>"
  );
}

// What a note with images and no words says for itself. A queued prompt keeps its words in
// `prompt` (`text` is the element's excerpt); a transcript entry keeps them in `text`.
function attachmentOnlyText(entry) {
  if (!attachmentCount(entry)) return "";
  return entry.tag === "message" || entry.kind === "message" ? "Image message" : "Image annotation";
}

function userBubbleTextHtml(entry, text) {
  const displayText = String(text || attachmentOnlyText(entry));
  return displayText ? '<div class="bubble-text">' + escapeHtml(displayText) + "</div>" : "";
}

// A queued note is the user bubble in its not-yet-sent state: dashed, labelled Queued (Sending
// while its batch is in flight), and removable until then. It settles in place as a sent bubble
// once the server's transcript carries it, so nothing moves between regions.
function queuedBubbleHtml(prompt, index) {
  const sending = isPromptSending(prompt);
  return (
    '<div class="bubble user queued"><small>' +
    (sending ? "Sending\u2026" : "Queued") +
    ' <button class="queued-remove" type="button" aria-label="Remove queued prompt" data-index="' +
    index +
    '">' +
    REMOVE_ICON_SVG +
    "</button></small>" +
    anchorHtml(promptAnchor(prompt)) +
    userBubbleTextHtml(prompt, prompt.prompt) +
    bubbleAttachmentsHtml(prompt) +
    "</div>"
  );
}

// Whether a queued prompt is committed to a send that has not been answered yet: waiting for its
// snapshot, queued behind another submission, in flight, or held by the terminal reservation.
// Derived from the existing send bookkeeping rather than tracked separately, so no failure path
// can strand a note labelled Sending with its remove control disabled.
function isPromptSending(prompt) {
  if (terminalSubmission?.inFlight && terminalSubmission.prompts.includes(prompt)) return true;
  for (const request of snapshotRequests.values()) {
    if (request.action === "submit" && Array.isArray(request.prompts) && request.prompts.includes(prompt)) return true;
  }
  for (const submission of pendingSubmissions) {
    if (Array.isArray(submission.prompts) && submission.prompts.includes(prompt)) return true;
  }
  return Boolean(
    activeSubmission && Array.isArray(activeSubmission.prompts) && activeSubmission.prompts.includes(prompt),
  );
}

function render() {
  queuedLog.innerHTML = queued
    .map((prompt, index) => (belongsToReviewPage(prompt) ? queuedBubbleHtml(prompt, index) : ""))
    .join("");

  for (const button of queuedLog.querySelectorAll(".queued-remove")) {
    const removeButton = /** @type {HTMLButtonElement} */ (button);
    const prompt = queued[Number(removeButton.dataset.index)];
    removeButton.disabled = terminalSubmission !== null || isPromptSending(prompt);
    removeButton.addEventListener("click", (event) => removeQueuedPrompt(Number(removeButton.dataset.index), event));
  }
  updateSendState();
  scrollPanelToBottom();
  renderSheetSummary();
}

function updateSendState() {
  const terminalReserved = terminalSubmission !== null;
  // A terminal send owns the exact review batch, so freeze interactions inside the
  // artifact without disabling annotation mode. Disabling annotation mode closes the
  // SDK card and destroys an unsent draft before delivery has actually succeeded.
  // Native history can replace the document even while the iframe is inert;
  // keep the replacement inert too until the terminal request settles.
  // A restored or failed reservation may leave authored navigation usable on
  // another page so the reviewer can return to its page and retry.
  frame.inert =
    ended ||
    Boolean(terminalSubmission?.inFlight) ||
    (terminalReserved && (!modernArtifactProtocol || terminalSubmission.page === currentArtifactBinding?.page));
  const unavailable = modernArtifactProtocol && !currentArtifactBinding;
  sendButton.disabled = ended || terminalReserved || unavailable;
  sendAndEndButton.disabled =
    ended ||
    Boolean(terminalSubmission?.inFlight) ||
    unavailable ||
    Boolean(modernArtifactProtocol && terminalSubmission && terminalSubmission.page !== currentArtifactBinding?.page);
  annotationSwitch.disabled = ended || terminalReserved;
  chatInput.disabled = ended || terminalReserved || unavailable;
  chatAttachButton.disabled = ended || terminalReserved || unavailable;
  endButton.disabled = ended || terminalReserved;
  if (warningsQueueButton) updateWarningSelectionState();
}

function attachmentCount(prompt) {
  return Array.isArray(prompt.attachments) ? prompt.attachments.length : 0;
}

// How many thumbnails a bubble shows before the rest collapse into a badge.
const BUBBLE_THUMBNAIL_LIMIT = 4;

// Thumbnails for a note's images, served straight from the same-origin attachment endpoint (the
// ids are already server-vetted at upload time). The bubble has room for only a few, but the
// per-prompt cap is configurable (LAVISH_AXI_MAX_ATTACHMENTS_PER_PROMPT), so a note can
// legitimately carry more than fit: the remainder collapses into a +N badge rather than being
// dropped from the preview, which would make the queue look like it lost the extra images (W-A).
function bubbleAttachmentsHtml(entry) {
  const count = attachmentCount(entry);
  if (!count) return "";
  const hidden = count - BUBBLE_THUMBNAIL_LIMIT;
  return (
    '<span class="bubble-attachments">' +
    entry.attachments
      .slice(0, BUBBLE_THUMBNAIL_LIMIT)
      .map((attachment) => {
        const alt = escapeHtml(attachment.name || "image");
        return (
          '<img class="bubble-attachment" src="/api/' +
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
      ? '<span class="bubble-attachment-more" title="' +
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

function replaceExpiredThumbnail(event) {
  const image = event.target;
  if (
    String(image?.tagName || "").toUpperCase() !== "IMG" ||
    !String(image.className || "")
      .split(/\s+/)
      .includes("bubble-attachment")
  )
    return;
  const expired = document.createElement("span");
  expired.className = "bubble-attachment bubble-attachment-expired";
  expired.textContent = "Image expired";
  expired.title = String(image.alt || "image");
  image.replaceWith(expired);
}

chatLog.addEventListener("error", replaceExpiredThumbnail, true);

const DEFAULT_SEND_HINT = "Write a message or annotate an element first.";

function showSendHint(message = DEFAULT_SEND_HINT, holdMs = 2600, focusInput = true) {
  sendHint.textContent = message;
  sendHint.hidden = false;
  clearTimeout(sendHintTimer);
  sendHintPersistent = holdMs === null;
  sendHint.classList.toggle("persistent", sendHintPersistent);
  if (sendHintPersistent) {
    sendHintTimer = undefined;
    if (focusInput) chatInput.focus();
    return;
  }
  sendHintTimer = setTimeout(() => {
    sendHint.hidden = true;
    sendHint.textContent = DEFAULT_SEND_HINT;
    sendHintPersistent = false;
  }, holdMs);
  if (focusInput) chatInput.focus();
}

function hideSendHint(force = false) {
  if (sendHintPersistent && force !== true) return;
  clearTimeout(sendHintTimer);
  sendHint.hidden = true;
  sendHint.textContent = DEFAULT_SEND_HINT;
  sendHint.classList.remove("persistent");
  sendHintPersistent = false;
  sendAcknowledgementWarningVisible = false;
}

function armSendAcknowledgementWarning() {
  if (sendAcknowledgementTimer || pendingAcknowledgements.size === 0) return;
  sendAcknowledgementTimer = setTimeout(() => {
    sendAcknowledgementTimer = undefined;
    if (pendingAcknowledgements.size > 0 && !sendFailureOwner) {
      sendAcknowledgementWarningVisible = true;
      showSendHint(SEND_STALLED_COPY, null, false);
    }
  }, SEND_ACKNOWLEDGEMENT_WARNING_MS);
}

function clearSendAcknowledgementWarning() {
  clearTimeout(sendAcknowledgementTimer);
  sendAcknowledgementTimer = undefined;
  sendAcknowledgementWarningVisible = false;
}

function showQueuedSendFailure(message = SEND_FAILED_COPY, owner = null) {
  showPersistentSendFailure(message, true, owner);
}

function showPersistentSendFailure(message, requireQueuedFeedback = false, owner = null) {
  clearSendAcknowledgementWarning();
  if (requireQueuedFeedback && !queued.length) return;
  if (sendFailureOwner?.kind === "preparation") return;
  const currentOrder = Number(sendFailureOwner?.operation?.order) || 0;
  const nextOrder = Number(owner?.operation?.order) || 0;
  if (owner?.kind !== "preparation" && currentOrder > nextOrder) return;
  sendFailureOwner = owner;
  showSendHint(message, null, false);
}

function clearPersistentSendFailure() {
  sendFailureOwner = null;
  hideSendHint(true);
}

function clearPreparationFailure(preparationType) {
  if (sendFailureOwner?.kind !== "preparation" || sendFailureOwner.preparationType !== preparationType) return;
  clearPersistentSendFailure();
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

// One transcript entry, as the server serialized it (src/chat-messages.js). An agent entry's
// `html` is the server's rendering of the agent's text and is the only html ever set here; a
// user entry is always escaped text, with its anchor line and thumbnails when it carries them.
function chatBubbleHtml(entry) {
  if (entry.role === "agent") {
    return (
      "<small>Agent</small>" +
      (typeof entry.html === "string" && entry.html
        ? '<div class="chat-md">' + entry.html + "</div>"
        : '<div class="bubble-text">' + escapeHtml(entry.text) + "</div>")
    );
  }
  return (
    "<small>You</small>" +
    anchorHtml(entry.anchor) +
    userBubbleTextHtml(entry, entry.text) +
    bubbleAttachmentsHtml(entry)
  );
}

function addChat(entry, shouldScroll = true) {
  if (!entry || typeof entry !== "object") return;
  const role = entry.role === "agent" ? "agent" : "user";
  const text = String(entry.text || "");
  if (!text && !(role === "agent" ? entry.html : attachmentCount(entry) || entry.anchor)) return;

  const el = document.createElement("div");
  el.className = "bubble " + role;
  el.innerHTML = chatBubbleHtml({ ...entry, role, text });
  chatLog.appendChild(el);
  if (shouldScroll) scrollElementIntoView(el);
  return el;
}

function chatEntryDisplayKey(entry) {
  return JSON.stringify({
    role: entry?.role === "agent" ? "agent" : "user",
    kind: entry?.kind,
    text: String(entry?.text || ""),
    anchor: entry?.anchor,
    attachments: Array.isArray(entry?.attachments) ? entry.attachments.map((item) => String(item?.id || "")) : [],
  });
}

function chatEntriesMatch(left, right) {
  if (chatEntryDisplayKey(left) !== chatEntryDisplayKey(right)) return false;
  const leftAt = String(left?.at || "");
  const rightAt = String(right?.at || "");
  return !leftAt || !rightAt || leftAt === rightAt;
}

function parseChatRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function chatContainsEntries(candidate, entries) {
  if (!Array.isArray(candidate) || !Array.isArray(entries)) return false;
  if (entries.length === 0) return true;
  // A size-bound transcript may drop a prefix of what this tab already showed. The remaining
  // displayed suffix must still appear in order; a stale sync that is missing a newer tail
  // (including an empty wipe) is rejected.
  for (let start = 0; start < entries.length; start += 1) {
    const suffix = entries.slice(start);
    let matched = 0;
    for (const entry of candidate) {
      if (matched < suffix.length && chatEntriesMatch(entry, suffix[matched])) matched += 1;
    }
    if (matched === suffix.length) return true;
  }
  return false;
}

function chatStartsWith(candidate, prefix) {
  return (
    Array.isArray(candidate) &&
    Array.isArray(prefix) &&
    candidate.length >= prefix.length &&
    prefix.every((entry, index) => chatEntriesMatch(candidate[index], entry))
  );
}

function mergeAcceptedChat(accepted, chatAtRequest) {
  if (!Array.isArray(accepted) || !Array.isArray(chatAtRequest)) return null;
  if (!chatStartsWith(displayedChat, chatAtRequest)) return null;
  let requestOffset = chatAtRequest.length;
  for (let i = 0; i <= chatAtRequest.length; i += 1) {
    if (chatStartsWith(accepted, chatAtRequest.slice(i))) {
      requestOffset = i;
      break;
    }
  }
  const displayedTail = displayedChat.slice(chatAtRequest.length);
  const unmatchedDisplayed = [];
  let acceptedIndex = chatAtRequest.length - requestOffset;
  for (const displayedEntry of displayedTail) {
    while (acceptedIndex < accepted.length && !chatEntriesMatch(accepted[acceptedIndex], displayedEntry)) {
      acceptedIndex += 1;
    }
    if (acceptedIndex < accepted.length) {
      acceptedIndex += 1;
    } else {
      unmatchedDisplayed.push(displayedEntry);
    }
  }
  return accepted.concat(unmatchedDisplayed);
}

function queuedPromptMatchesEntry(prompt, entry) {
  const id = promptIdentity(prompt);
  return Boolean(id) && entry?.role === "user" && promptIdentity(entry) === id;
}

function promptAcknowledgedInChat(prompt, chat) {
  const id = promptIdentity(prompt);
  if (!id) return false;
  if (chatAckIds.has(id)) return true;
  if (!Array.isArray(chat)) return false;
  return chat.some((entry) => queuedPromptMatchesEntry(prompt, entry));
}

function settleQueuedFromTranscript(chat, shouldRender = true) {
  if (!Array.isArray(chat) || !queued.length) return false;
  // Match by the per-submission identity only. Displayed content is not identity: two tabs
  // can send the same selected text under one container with different range boundaries,
  // and each note must settle exactly once against its own acknowledgement.
  const settledPrompts = new Set();
  for (const prompt of queued) {
    if (!promptAcknowledgedInChat(prompt, chat)) continue;
    settledPrompts.add(prompt);
    deliveredPrompts.add(prompt);
  }
  if (!settledPrompts.size) return false;
  for (let i = queued.length - 1; i >= 0; i -= 1) {
    if (settledPrompts.has(queued[i])) queued.splice(i, 1);
  }
  persistQueuedPrompts();
  if (shouldRender) render();
  return true;
}

function syncChat(chat, revision) {
  const nextChat = Array.isArray(chat) ? chat : [];
  settleQueuedFromTranscript(nextChat);
  const nextRevision = parseChatRevision(revision);
  if (nextRevision !== null && nextRevision < chatRevision) return false;
  if (nextRevision === null || nextRevision === chatRevision) {
    if (!chatContainsEntries(nextChat, displayedChat)) return false;
  }
  if (nextRevision !== null) chatRevision = nextRevision;
  displayedChat = nextChat.slice();
  for (const el of [...chatLog.querySelectorAll(".bubble.user,.bubble.agent:not(.agent-working)")]) {
    el.remove();
  }

  let lastChatBubble = null;
  for (const item of nextChat) lastChatBubble = addChat(item, false) || lastChatBubble;
  if (workingBubble) chatLog.appendChild(workingBubble);
  // Handed-back drafts were written at the end of the conversation, and a rebuild re-appends the
  // whole transcript - so without this they end up above it, where the scroll below would leave
  // them off-screen. They are the one thing here the user cannot recover anywhere else.
  for (const note of retiredDraftNodes) chatLog.appendChild(note);
  const anchor = retiredDraftNodes[retiredDraftNodes.length - 1] || workingBubble || lastChatBubble;
  if (anchor) scrollElementIntoView(anchor);
  return true;
}

function setAgentPresence(state) {
  agentPresence = state === "listening" || state === "external" || state === "working" ? state : "waiting";
  updateSendState();
  renderSheetSummary();
  if (presenceBanner) presenceBanner.hidden = ended || agentPresence !== "waiting";

  // A supervisor-owned process-only listener is busy on the agent's behalf. It must not make the
  // composer look like an idle captain turn while the owning agent is offline.
  if (agentPresence !== "working" && agentPresence !== "external") {
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

// The server this page was connected to went away. What is true beyond that depends on why, so
// the shutdown names its reason and each one gets its own line - a page told "Lavish was updated"
// after a deliberate stop is being told something false. An unnamed reason (SIGTERM, or any
// caller that names none) claims neither.
function chromeOutdatedCopy(reason) {
  if (reason === "upgrade") return "Lavish was updated. This page is running the previous version.";
  if (reason === "local-build") {
    return "Lavish was restarted to pick up a local build. This page is running the copy the previous server sent.";
  }
  if (reason === "stop") return "Lavish was stopped. Reload after you start it again.";
  return "The Lavish server this page was connected to is no longer running. Reloading will work once it is running again.";
}

// Say so where the user can dismiss it, and never reload on their behalf - a forced reload
// interrupts whatever they were reading or writing.
function setChromeOutdated(visible, reason = chromeOutdatedReason) {
  chromeOutdatedReason = String(reason || "");
  chromeOutdatedGeneration += 1;
  if (outdatedText) outdatedText.textContent = chromeOutdatedCopy(chromeOutdatedReason);
  outdatedReloadInFlight = false;
  if (outdatedReloadButton) outdatedReloadButton.disabled = false;
  if (outdatedBanner) outdatedBanner.hidden = ended || !visible;
}

function statePageIdentity(pageOverride) {
  if (pageOverride !== undefined) return pageOverride === null ? null : String(pageOverride);
  return modernArtifactProtocol ? activeReviewPage : null;
}

function emptyPageReviewState(page) {
  return { page, scroll: { x: 0, y: 0 }, reviewState: null, unrestorableDraftMiss: null };
}

function pageReviewRecord(page) {
  return pageReviewStates.get(reviewStatePageKey(page)) || emptyPageReviewState(page);
}

function persistPageReviewStates() {
  if (!modernArtifactProtocol) return true;
  return saveJsonState(reviewStateStorageKey, serializePageReviewState(pageReviewStates));
}

function updatePageReviewState(page, patch) {
  const current = pageReviewRecord(page);
  const next = {
    page,
    scroll: normalizeReviewStateScroll(patch.scroll === undefined ? current.scroll : patch.scroll),
    reviewState: patch.reviewState === undefined ? current.reviewState : patch.reviewState,
    unrestorableDraftMiss:
      patch.unrestorableDraftMiss === undefined ? current.unrestorableDraftMiss : patch.unrestorableDraftMiss,
  };
  pageReviewStates.set(reviewStatePageKey(page), next);
  persistPageReviewStates();
  return next;
}

function activatePageReviewState(page) {
  if (!modernArtifactProtocol) return;
  const canonicalPage = page === null || page === undefined ? null : String(page);
  activeReviewPage = canonicalPage;
  let record = pageReviewStates.get(reviewStatePageKey(canonicalPage));
  if (!record && legacyReviewState && !legacyReviewStateMigrated) {
    // An older chrome had one unlabelled slot. Assign it once to the first
    // accepted page, and only then replace the old value with the typed envelope.
    record = emptyPageReviewState(canonicalPage);
    record.reviewState = legacyReviewState;
    pageReviewStates.set(reviewStatePageKey(canonicalPage), record);
    legacyReviewStateMigrated = true;
    legacyReviewState = null;
    persistPageReviewStates();
  }
  if (!record) record = emptyPageReviewState(canonicalPage);
  lastScroll = normalizeReviewStateScroll(record.scroll);
  lastReviewState = record.reviewState;
  unrestorableDraftMiss = record.unrestorableDraftMiss;
}

function setScrollPosition(x, y, pageOverride) {
  lastScroll = normalizeReviewStateScroll({ x, y });
  if (modernArtifactProtocol) updatePageReviewState(statePageIdentity(pageOverride), { scroll: lastScroll });
}

function setReviewState(state, pageOverride) {
  lastReviewState = state;
  // The artifact reported a card, so its anchor exists: whatever miss was recorded is answered.
  if (state?.card) unrestorableDraftMiss = null;
  if (!modernArtifactProtocol) {
    if (!state || (!state.card && !(Array.isArray(state.fields) && state.fields.length))) {
      try {
        sessionStorage.removeItem(reviewStateStorageKey);
      } catch {
        // The in-memory state still works if browser storage is unavailable.
      }
      return;
    }
    saveJsonState(reviewStateStorageKey, state);
    return;
  }
  const page = statePageIdentity(pageOverride);
  updatePageReviewState(page, {
    // An empty state means the card was queued/cancelled. It must clear that
    // page's draft and any first-miss evidence, but must not touch another page.
    reviewState: state && (state.card || (Array.isArray(state.fields) && state.fields.length)) ? state : null,
    unrestorableDraftMiss: state?.card ? null : null,
  });
}

function reviewStateHasUnsentDraft(state) {
  return Boolean(state && state.card && String(state.card.text || "").trim());
}

function hasUnsentDraft() {
  if (!modernArtifactProtocol) return reviewStateHasUnsentDraft(lastReviewState);
  if (reviewStateHasUnsentDraft(legacyReviewState)) return true;
  if (reviewStateHasUnsentDraft(lastReviewState)) return true;
  return [...pageReviewStates.values()].some((record) => reviewStateHasUnsentDraft(record.reviewState));
}

// The SDK looked for this draft's anchor in a loaded artifact and did not find it. Retiring a
// draft is itself data loss - the user may still be typing while the agent rewrites the element
// they anchored to - so one miss only records the answer. The draft is retired only when a
// SECOND artifact revision reports the same anchor missing: an element that is merely being
// rewritten comes back, and a report on the revision already recorded is the same answer twice,
// not two answers. Any report for a different draft, or for a draft that is no longer stored,
// leaves the stored text alone.
function discardUnrestorableDraft(selector, pageOverride) {
  if (!selector) return;
  const page = statePageIdentity(pageOverride);
  const record = modernArtifactProtocol ? pageReviewRecord(page) : null;
  const state = modernArtifactProtocol ? record.reviewState : lastReviewState;
  const miss = modernArtifactProtocol ? record.unrestorableDraftMiss : unrestorableDraftMiss;
  if (!state || !state.card) return;
  if (String(state.card.selector || "") !== selector) return;
  const revision = artifactLoadRevision;
  if (miss?.selector !== selector) {
    const nextMiss = { selector, revision };
    if (modernArtifactProtocol) updatePageReviewState(page, { unrestorableDraftMiss: nextMiss });
    else unrestorableDraftMiss = nextMiss;
    return;
  }
  if (miss.revision === revision) return;
  if (modernArtifactProtocol) {
    keepRetiredDraft(String(state.card.text || ""), page);
    const next = updatePageReviewState(page, {
      reviewState: { ...state, card: null },
      unrestorableDraftMiss: null,
    });
    if (page === activeReviewPage) {
      lastReviewState = next.reviewState;
      unrestorableDraftMiss = null;
    }
    return;
  }
  unrestorableDraftMiss = null;
  keepRetiredDraft(String(state.card.text || ""));
  setReviewState({ ...state, card: null });
}

// Retiring a draft ends Lavish's ability to replay it, so the text itself is handed back to the
// user before it goes: it is written to the conversation panel verbatim, where it is selectable,
// nothing overwrites what they may already be typing, and no control can discard it by accident.
// It is persisted per session so a reload does not take the last copy with it.
function loadRetiredDrafts() {
  const stored = loadJsonState(retiredDraftStorageKey, []);
  if (!Array.isArray(stored)) return [];
  return stored
    .map((entry) => {
      if (typeof entry === "string" && entry.trim()) return { text: entry, page: null };
      if (!entry || typeof entry !== "object" || typeof entry.text !== "string" || !entry.text.trim()) return null;
      return { text: entry.text, page: entry.page === null ? null : String(entry.page || "") || null };
    })
    .filter(Boolean);
}

// No entry already handed back is ever dropped to make room for a new one. When browser storage
// refuses the write, the note says so on the spot instead of an older one quietly disappearing at
// the next page load - the text the user wrote is the thing being protected here.
function keepRetiredDraft(text, pageOverride) {
  if (!text.trim()) return;
  const page = modernArtifactProtocol ? statePageIdentity(pageOverride) : null;
  const entry = { text, page };
  retiredDrafts = [...retiredDrafts, entry];
  renderRetiredDraft(entry, saveJsonState(retiredDraftStorageKey, retiredDrafts));
}

function renderRetiredDraft(entry, stored = true) {
  if (!chatLog) return;
  const text = String(entry?.text || entry || "");
  const page = entry && typeof entry === "object" ? entry.page : null;
  const el = document.createElement("div");
  el.className = "bubble note";
  if (el.dataset) el.dataset.lavishPage = page || "";
  el.innerHTML =
    "<small>Unsent annotation</small><div>The element this note was attached to is no longer in the artifact, so Lavish could not reopen the card. Your text is kept here:</div>" +
    '<div class="note-draft">' +
    escapeHtml(text) +
    "</div>" +
    (stored
      ? ""
      : '<div class="note-warning">This browser refused to store it, so copy it before you reload this page.</div>');
  retiredDraftNodes.push(el);
  chatLog.appendChild(el);
  scrollElementIntoView(el);
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

// ---- Phone-width conversation sheet ----
// Below this width chrome.css turns the conversation panel into a dock the user raises as a
// bottom sheet over the artifact. This controller owns intent, accessibility state, gestures,
// visual-viewport measurements, and the dock summary; CSS owns the geometry. The query must match
// the one chrome.css lays the sheet out under.
const MOBILE_SHEET_MEDIA = "(max-width: 860px)";
// How far a drag on the dock must travel before it counts as a gesture rather than a tap.
const SHEET_DRAG_THRESHOLD_PX = 48;
const sheetStorageKey = "lavish-axi:sheet-open:" + key;
const sheetMedia = typeof window.matchMedia === "function" ? window.matchMedia(MOBILE_SHEET_MEDIA) : null;
// The user's intent, kept across a chrome reload so a live-reload or server upgrade does not drop
// them back onto a closed dock mid-conversation.
let sheetOpen = readSheetOpen();
// The latest agent reply that landed while the sheet was closed: the dock previews it until the
// user opens the sheet, so a reply never arrives silently behind the artifact.
let unreadAgentReply = "";
/** @type {{ pointerId: any, startY: number, moved: boolean } | null} */
let sheetDrag = null;
let suppressSheetClick = false;

function readSheetOpen() {
  try {
    return sessionStorage.getItem(sheetStorageKey) === "1";
  } catch {
    return false;
  }
}

function isMobileSheet() {
  return Boolean(sheetMedia && sheetMedia.matches);
}

function setSheetOpen(open) {
  const next = Boolean(open);
  const changed = next !== sheetOpen;
  sheetOpen = next;
  try {
    if (sheetOpen) sessionStorage.setItem(sheetStorageKey, "1");
    else sessionStorage.removeItem(sheetStorageKey);
  } catch {
    // Storage refused is not worth a broken sheet: the state just stops surviving a reload.
  }
  if (sheetOpen) unreadAgentReply = "";
  applySheetState();
  if (!changed || !isMobileSheet()) return;
  if (sheetOpen) scrollPanelToBottom();
}

// Re-derives every sheet attribute from the phone layout, sheet-open, and session-ended state so a
// viewport crossing the breakpoint in either direction cannot make an ended panel interactive or
// leave a closed dock trapping focus.
function applySheetState() {
  const mobile = isMobileSheet();
  const open = mobile && sheetOpen;
  document.body.classList.toggle("sheet-open", open);
  const docked = mobile && !open;
  panelScroll.inert = ended || docked;
  chatComposer.inert = ended || docked;
  const activeElement = document.activeElement;
  if (docked && activeElement && (panelScroll.contains(activeElement) || chatComposer.contains(activeElement))) {
    panelToggle.focus();
  }
  panelToggle.setAttribute("aria-expanded", open ? "true" : "false");
  panelToggle.setAttribute("aria-label", open ? "Hide conversation" : "Show conversation");
  renderSheetSummary();
}

// What the closed dock says. One line, most actionable state first: work the user has queued,
// then a reply they have not seen, then whether the agent is there to receive a send.
function sheetSummary() {
  if (ended) return { text: "Session ended", accent: false, unread: false };
  const queuedCount = queuedForPage().length;
  if (queuedCount > 0) {
    return { text: queuedCount === 1 ? "1 queued" : queuedCount + " queued", accent: true, unread: false };
  }
  if (unreadAgentReply) return { text: unreadAgentReply, accent: false, unread: true };
  if (agentPresence === "working") return { text: "Agent is working…", accent: false, unread: false };
  if (agentPresence === "external") return { text: "External listener active", accent: false, unread: false };
  if (agentPresence === "listening") return { text: "Agent listening", accent: false, unread: false };
  return { text: "Agent not listening", accent: false, unread: false };
}

function renderSheetSummary() {
  const summary = sheetSummary();
  panelSummary.textContent = summary.text;
  panelSummary.classList.toggle("is-accent", summary.accent);
  panelSummary.classList.toggle("is-unread", summary.unread);
}

// A brief pulse on the dock when something the user should notice lands while the sheet is
// closed: a prompt they queued from the artifact, or an agent reply.
function pulseSheetDock() {
  if (!isMobileSheet() || sheetOpen) return;
  panelHead.classList.remove("is-fresh");
  // Restart the animation even when the previous pulse is still running.
  void panelHead.offsetWidth;
  panelHead.classList.add("is-fresh");
}

function noteAgentReply(text) {
  if (!isMobileSheet() || sheetOpen) return;
  unreadAgentReply = String(text || "");
  renderSheetSummary();
  pulseSheetDock();
}

// The phone keyboard shrinks the visual viewport without touching the layout viewport on iOS, so
// the sheet reads its height and offset from here; chrome.css consumes these only under the phone
// breakpoint. Android reports the same numbers through the layout viewport thanks to the
// `interactive-widget=resizes-content` viewport meta, which makes this a no-op there.
function syncVisualViewport() {
  const root = document.documentElement;
  if (!root || !root.style || typeof root.style.setProperty !== "function") return;
  const viewport = window.visualViewport;
  const height = viewport ? viewport.height : window.innerHeight;
  const top = viewport ? viewport.offsetTop : 0;
  if (!(height > 0)) return;
  root.style.setProperty("--vv-height", Math.round(height) + "px");
  root.style.setProperty("--vv-top", Math.round(Math.max(0, top || 0)) + "px");
}

function sheetDragOffset(event) {
  return sheetDrag ? Number(event.clientY) - sheetDrag.startY : 0;
}

function clearSheetDrag() {
  sheetDrag = null;
  panel.classList.remove("is-dragging");
  panel.style.transform = "";
}

function finishSheetDrag(event) {
  if (!sheetDrag || event.pointerId !== sheetDrag.pointerId) return;
  const offset = sheetDragOffset(event);
  const moved = sheetDrag.moved;
  clearSheetDrag();
  if (!moved) return;
  // The click that follows a completed drag must not undo what the drag decided.
  suppressSheetClick = true;
  if (sheetOpen && offset > SHEET_DRAG_THRESHOLD_PX) setSheetOpen(false);
  else if (!sheetOpen && offset < -SHEET_DRAG_THRESHOLD_PX) setSheetOpen(true);
}

panelHead.addEventListener("click", () => {
  if (!isMobileSheet()) return;
  if (suppressSheetClick) {
    suppressSheetClick = false;
    return;
  }
  setSheetOpen(!sheetOpen);
});
panelScrim.addEventListener("click", () => setSheetOpen(false));
panelHead.addEventListener("pointerdown", (event) => {
  if (!isMobileSheet() || event.button) return;
  sheetDrag = { pointerId: event.pointerId, startY: Number(event.clientY), moved: false };
  if (typeof panelHead.setPointerCapture === "function") panelHead.setPointerCapture(event.pointerId);
});
panelHead.addEventListener("pointermove", (event) => {
  if (!sheetDrag || event.pointerId !== sheetDrag.pointerId) return;
  const offset = sheetDragOffset(event);
  if (Math.abs(offset) > 6) sheetDrag.moved = true;
  if (!sheetDrag.moved) return;
  panel.classList.add("is-dragging");
  // Follow the finger: an open sheet only moves down, a closed dock only up.
  panel.style.transform = sheetOpen
    ? "translateY(" + Math.max(0, offset) + "px)"
    : "translateY(calc(100% - var(--dock-h) - env(safe-area-inset-bottom, 0px) + " + Math.min(0, offset) + "px))";
});
panelHead.addEventListener("pointerup", finishSheetDrag);
panelHead.addEventListener("pointercancel", (event) => {
  if (!sheetDrag || event.pointerId !== sheetDrag.pointerId) return;
  clearSheetDrag();
  suppressSheetClick = false;
});
if (sheetMedia && typeof sheetMedia.addEventListener === "function") {
  sheetMedia.addEventListener("change", (event) => {
    if (!event.matches) {
      sheetOpen = false;
      try {
        sessionStorage.removeItem(sheetStorageKey);
      } catch {
        // Storage refusal only prevents persistence; the in-memory state is already reset.
      }
    }
    applySheetState();
  });
}
if (window.visualViewport && typeof window.visualViewport.addEventListener === "function") {
  window.visualViewport.addEventListener("resize", syncVisualViewport);
  window.visualViewport.addEventListener("scroll", syncVisualViewport);
}
window.addEventListener("resize", syncVisualViewport);
syncVisualViewport();

function scrollElementIntoView(el) {
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function removeQueuedPrompt(index, event) {
  if (event) event.stopPropagation();
  if (terminalSubmission || isPromptSending(queued[index])) return;
  queued.splice(index, 1);
  persistQueuedPrompts();
  if (!queued.length) {
    clearSendAcknowledgementWarning();
    if (sendFailureOwner?.kind !== "preparation") clearPersistentSendFailure();
  }
  render();
}

function promptQueueKey(prompt) {
  const key = prompt && typeof prompt[internalQueueKeyField] === "string" ? prompt[internalQueueKeyField].trim() : "";
  if (!key || !modernArtifactProtocol) return key;
  // Replacement is local to the authored document. Identical question names
  // and selectors on sibling pages are independent review inputs.
  const page = Object.hasOwn(prompt, "page") ? prompt.page : null;
  return reviewStatePageKey(page) + "\0" + key;
}

function stampPromptBinding(prompt, binding = currentArtifactBinding) {
  if (!modernArtifactProtocol || !prompt || typeof prompt !== "object") return prompt;
  delete prompt[legacyQueuedPageField];
  // The artifact is untrusted and may include look-alike page fields.  Replace
  // them with the chrome's accepted binding, or an explicit null when the
  // composer has no eligible current document.
  prompt.page = binding?.page ?? null;
  prompt.page_proof = binding?.proof || "";
  return prompt;
}

function beginFeedbackPreparation() {
  if (ended || terminalSubmission) return null;
  /** @type {(succeeded: boolean) => void} */
  let finishPromise = () => {};
  const done = new Promise((resolve) => {
    finishPromise = resolve;
  });
  const preparation = {
    page: currentArtifactBinding?.page ?? null,
    done,
    finish(succeeded) {
      if (!feedbackPreparations.delete(preparation)) return;
      finishPromise(succeeded);
    },
  };
  feedbackPreparations.add(preparation);
  return preparation;
}

function enqueuePrompt(
  rawPrompt,
  /** @type {FeedbackPreparation | null} */ preparation = null,
  /** @type {any} */ sourceBinding = currentArtifactBinding,
) {
  if ((preparation && !feedbackPreparations.has(preparation)) || (terminalSubmission && !preparation)) return false;
  // The sandboxed iframe is untrusted: never accept a caller-supplied settlement identity.
  const prompt = adoptQueuedPrompt(rawPrompt, false);
  if (!prompt) return false;
  stampPromptBinding(prompt, sourceBinding);

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
  return true;
}

function stripInternalPromptFields(prompt) {
  if (!prompt || typeof prompt !== "object") return prompt;
  const clean = { ...prompt };
  delete clean[internalQueueKeyField];
  delete clean[legacyQueuedPageField];
  return clean;
}

function stampLegacyQueuedPrompts(binding) {
  if (!modernArtifactProtocol || !entryPage || binding?.page !== entryPage) return;
  let changed = false;
  for (const prompt of queued) {
    if (prompt?.[legacyQueuedPageField] !== true) continue;
    stampPromptBinding(prompt, binding);
    changed = true;
  }
  if (!changed) return;
  persistQueuedPrompts();
  render();
}

function randomBindingChallenge() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "challenge-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}

function bindingTuple(binding = currentArtifactBinding) {
  if (!binding) return {};
  return {
    page_protocol: 1,
    page: binding.page,
    page_proof: binding.proof,
    served_route: binding.route,
    document_id: binding.documentId,
    document_sequence: binding.documentSequence,
    artifact_load_token: binding.token,
    artifact_revision: binding.revision,
  };
}

function retireArtifactBinding() {
  const binding = currentArtifactBinding;
  if (binding) retireWhiteboardChannelsForBinding?.(binding);
  currentArtifactBinding = null;
  if (modernArtifactProtocol) {
    activateComposerPage(null);
    render();
    renderWarnings();
  }
  if (binding?.port) {
    try {
      binding.port.close();
    } catch {
      // A closed MessagePort is already retired.
    }
  }
}

function postToFrame(message) {
  if (modernArtifactProtocol) {
    const binding = currentArtifactBinding;
    if (!binding) return;
    try {
      binding.port.postMessage({ ...message, ...bindingTuple(binding) });
    } catch {
      retireArtifactBinding();
    }
    return;
  }
  if (frame.contentWindow) frame.contentWindow.postMessage(message, "*");
}

// An asynchronous operation started by a protocol-1 document must keep the
// binding that accepted it.  Looking up currentArtifactBinding when the
// request settles would let a result from document A land in replacement
// document B (including when both documents reuse the same localId/nonce).
function postToBindingFrame(binding, message) {
  if (!modernArtifactProtocol) {
    postToFrame(message);
    return;
  }
  if (!binding || currentArtifactBinding !== binding) return;
  try {
    binding.port.postMessage({ ...message, ...bindingTuple(binding) });
  } catch {
    if (currentArtifactBinding === binding) retireArtifactBinding();
  }
}

function requestSnapshot(action, prompts = [], endAfter = false, terminal = null) {
  const requestId = "snapshot-" + ++nextSnapshotRequestId;
  const capturedBinding =
    currentArtifactBinding &&
    (!modernArtifactProtocol ||
      action !== "submit" ||
      prompts.every((prompt) => prompt.page === currentArtifactBinding.page))
      ? {
          version: currentArtifactBinding.version,
          page: currentArtifactBinding.page,
          proof: currentArtifactBinding.proof,
          route: currentArtifactBinding.route,
          destination: currentArtifactBinding.destination,
          documentId: currentArtifactBinding.documentId,
          documentSequence: currentArtifactBinding.documentSequence,
          token: currentArtifactBinding.token,
          revision: currentArtifactBinding.revision,
        }
      : null;
  const request =
    action === "submit"
      ? {
          action,
          prompts,
          chatAtRequest: displayedChat.slice(),
          endAfter,
          terminal,
          order: terminal?.order || ++nextSendOperationOrder,
          binding: capturedBinding,
        }
      : { action, binding: capturedBinding };
  snapshotRequests.set(requestId, request);
  if (action === "submit") {
    request.acknowledgement = {};
    pendingAcknowledgements.add(request.acknowledgement);
    armSendAcknowledgementWarning();
    request.timeout = setTimeout(() => completeSnapshotRequest(requestId, ""), SNAPSHOT_REQUEST_TIMEOUT_MS);
  }
  if (modernArtifactProtocol && action === "submit" && !capturedBinding) completeSnapshotRequest(requestId, "");
  else postToFrame({ type: "lavish:requestSnapshot", snapshot_request_id: requestId });
}

function takeSnapshotRequest(requestId) {
  if (typeof requestId !== "string" || !requestId || !snapshotRequests.has(requestId)) return null;
  const request = snapshotRequests.get(requestId);
  snapshotRequests.delete(requestId);
  if (request?.timeout) clearTimeout(request.timeout);
  return request || null;
}

function completeSnapshotRequest(requestId, snapshot, responseBinding = null) {
  const request = takeSnapshotRequest(requestId);
  if (!request) return;
  if (modernArtifactProtocol) {
    const expected = request.binding;
    const actual = responseBinding;
    const sameBinding =
      expected &&
      actual &&
      expected.version === actual.version &&
      expected.page === actual.page &&
      expected.proof === actual.proof &&
      expected.documentId === actual.documentId &&
      expected.documentSequence === actual.documentSequence &&
      expected.token === actual.token &&
      expected.revision === actual.revision;
    if (!sameBinding) {
      // A navigation/rebind won the race.  Deliver the frozen words without
      // asking the new document to answer an old snapshot request.
      snapshot = "";
    }
  }
  if (request.action === "copy") {
    copyText(snapshot || "");
    return;
  }

  submitQueued({
    prompts: request.prompts || [],
    chatAtRequest: request.chatAtRequest || [],
    domSnapshot: snapshot || "",
    snapshotPage: snapshot ? (request.binding?.page ?? null) : null,
    snapshotPageProof: snapshot ? request.binding?.proof || "" : "",
    binding: request.binding || null,
    endAfter: request.endAfter === true,
    terminal: request.terminal || null,
    acknowledgement: request.acknowledgement || null,
    order: request.order || 0,
  }).catch(() => {});
}

function createChatAttachmentsController(page = null) {
  const items = [];
  let nextId = 0;
  let capRejected = false;
  let sendBlocked = false;

  function currentImageCount() {
    return items.filter((item) => item.file && CHAT_ATTACHMENT_MIME.has(item.file.type)).length;
  }

  function renderAttachments() {
    if (modernArtifactProtocol && page !== composerPage) return;
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
    if (modernArtifactProtocol && page !== composerPage) return;
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
    render: renderAttachments,
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

let composerPage = null;
const composerStorageKey = queueStorageKey + ":drafts";
const storedComposerDrafts = loadJsonState(composerStorageKey, []);
const composerDrafts = new Map(
  Array.isArray(storedComposerDrafts)
    ? storedComposerDrafts.filter(
        (item) => Array.isArray(item) && typeof item[0] === "string" && typeof item[1] === "string",
      )
    : [],
);
const composerAttachments = new Map();
let chatAttachmentController = createChatAttachmentsController();

function persistComposerDraft() {
  if (!modernArtifactProtocol || typeof composerPage !== "string") return;
  composerDrafts.set(composerPage, chatInput.value);
  saveJsonState(composerStorageKey, Array.from(composerDrafts));
}

function activateComposerPage(page) {
  if (!modernArtifactProtocol || composerPage === page) return;
  persistComposerDraft();
  if (typeof composerPage === "string") composerAttachments.set(composerPage, chatAttachmentController);
  composerPage = page;
  chatInput.value = typeof page === "string" ? composerDrafts.get(page) || "" : "";
  chatAttachmentController = composerAttachments.get(page) || createChatAttachmentsController(page);
  chatAttachmentController.render();
}

function hasOtherPageFeedback(page) {
  if (!modernArtifactProtocol) return false;
  const other = (item) => item.page !== page;
  return (
    queued.some(other) ||
    (composerPage !== null &&
      composerPage !== page &&
      (chatInput.value.trim() ||
        chatAttachmentController.hasPending() ||
        chatAttachmentController.hasErrors() ||
        chatAttachmentController.collectReady().length)) ||
    [...feedbackPreparations].some(other) ||
    [...composerDrafts].some(([owner, text]) => owner !== page && text.trim()) ||
    [...composerAttachments].some(
      ([owner, controller]) =>
        owner !== page && (controller.hasPending() || controller.hasErrors() || controller.collectReady().length),
    ) ||
    [...pageReviewStates.values()].some((record) => other(record) && reviewStateHasUnsentDraft(record.reviewState)) ||
    layoutWarnings.some(
      (warning) =>
        warning && other(warning) && warning.active && warning.selectable && selectedWarningIds.has(warning.id),
    )
  );
}

function blockTerminalForOtherPages(page, terminal = null) {
  if (!hasOtherPageFeedback(page)) return false;
  if (terminal) releaseTerminalSubmission(terminal);
  clearPersistentSendFailure();
  showPersistentSendFailure(
    "Other pages still have unsent feedback. Use Send to Agent for this page, then Back/Forward to send the remaining feedback. Use Send & End when no other page has pending work.",
  );
  return true;
}

function sendQueued(endAfter) {
  if (ended || (modernArtifactProtocol && !currentArtifactBinding)) return;
  if (endAfter && blockTerminalForOtherPages(currentArtifactBinding?.page, terminalSubmission)) return;
  if (terminalSubmission) {
    if (endAfter && !terminalSubmission.inFlight) retryTerminalSubmission();
    return;
  }
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
      stampPromptBinding(prompt);
      assignPromptIdentity(prompt, false);
      queued.push(prompt);
      persistQueuedPrompts();
      // Render the durable queued bubble before clearing the editor. If anything after this point
      // fails, the user's words are already both stored and visibly recoverable in the tab. It
      // becomes a sent bubble only when the server's transcript carries it (see submitQueuedOnce).
      render();
      chatInput.value = "";
      persistComposerDraft();
      chatAttachmentController.reset();
    }
  }
  const shouldEnd = Boolean(endAfter && !chipsBlocked);
  const preparations = shouldEnd
    ? [...feedbackPreparations].filter((preparation) => belongsToReviewPage(preparation))
    : [];
  const pageQueued = queuedForPage();
  if (!pageQueued.length && preparations.length === 0) {
    if (!chipsBlocked && !sendFailureOwner) showSendHint();
    return;
  }
  if (!sendFailureOwner) hideSendHint(true);
  if (shouldEnd) {
    const terminal = {
      page: currentArtifactBinding?.page ?? null,
      prompts: [],
      inFlight: true,
      order: ++nextSendOperationOrder,
    };
    terminalSubmission = terminal;
    updateSendState();
    finishTerminalPreparation(terminal, preparations);
    return;
  }
  requestSnapshot("submit", pageQueued, false, null);
  render();
}

function finishTerminalPreparation(terminal, preparations) {
  if (preparations.length === 0) {
    completeTerminalPreparation(terminal, []);
    return;
  }
  const timeout = setTimeout(() => {
    if (terminalSubmission !== terminal || ended) return;
    for (const preparation of preparations) preparation.finish(false);
    showPersistentSendFailure(
      "Could not finish preparing all feedback within 5 seconds. This review remains open, and existing queued feedback is still editable.",
      false,
      { kind: "preparation", operation: terminal, preparationType: "terminal" },
    );
    releaseTerminalSubmission(terminal);
  }, TERMINAL_PREPARATION_TIMEOUT_MS);
  Promise.all(preparations.map((preparation) => preparation.done)).then((results) => {
    clearTimeout(timeout);
    completeTerminalPreparation(terminal, results);
  });
}

function completeTerminalPreparation(terminal, results) {
  if (terminalSubmission !== terminal || ended) return;
  if (blockTerminalForOtherPages(terminal.page, terminal)) return;
  if (results.some((succeeded) => !succeeded)) {
    releaseTerminalSubmission(terminal);
    return;
  }
  terminal.prompts = queuedForPage(terminal.page);
  clearPreparationFailure("terminal");
  if (!terminal.prompts.length) {
    releaseTerminalSubmission(terminal);
    if (!sendFailureOwner) showSendHint();
    return;
  }
  // Only make the reservation durable once every preparation has joined the exact
  // batch. A reload before this point must restore an ordinary editable queue, not
  // an incomplete terminal submission.
  persistTerminalReservation(true);
  requestSnapshot("submit", terminal.prompts, true, terminal);
  render();
}

function retryTerminalSubmission() {
  if (!terminalSubmission || terminalSubmission.inFlight || ended) return;
  if (blockTerminalForOtherPages(terminalSubmission.page, terminalSubmission)) return;
  if (modernArtifactProtocol && terminalSubmission.page !== currentArtifactBinding?.page) return;
  terminalSubmission.inFlight = true;
  updateSendState();
  requestSnapshot("submit", terminalSubmission.prompts, true, terminalSubmission);
  render();
}

function markTerminalSubmissionFailed(submission) {
  if (!terminalSubmission || submission.terminal !== terminalSubmission || ended) return;
  terminalSubmission.inFlight = false;
  updateSendState();
}

function releaseTerminalSubmission(terminal) {
  if (terminalSubmission !== terminal || ended) return;
  terminalSubmission = null;
  persistTerminalReservation(false);
  render();
}

async function submitQueued(submission) {
  if (!Array.isArray(submission.chatAtRequest)) submission.chatAtRequest = displayedChat.slice();
  pendingSubmissions.push(submission);
  if (submitQueuedPromise) {
    return submitQueuedPromise;
  }

  submitQueuedPromise = (async () => {
    /** @type {unknown} */
    let firstError = null;
    while (pendingSubmissions.length && !ended) {
      const next = pendingSubmissions.shift();
      if (!next) continue;
      activeSubmission = next;
      try {
        const result = await submitQueuedOnce(next, firstError !== null);
        if (result === false) markTerminalSubmissionFailed(next);
      } catch (error) {
        markTerminalSubmissionFailed(next);
        if (firstError === null) firstError = error;
      } finally {
        if (next.acknowledgement) pendingAcknowledgements.delete(next.acknowledgement);
        activeSubmission = null;
        // Whatever happened, the batch is no longer in flight: a failed note reads Queued again
        // with its remove control back.
        render();
      }
    }
    if (firstError !== null) throw firstError;
  })();
  try {
    return await submitQueuedPromise;
  } finally {
    submitQueuedPromise = null;
  }
}

async function submitQueuedOnce(submission, preserveFailureState = false) {
  if (submission.endAfter && blockTerminalForOtherPages(submission.terminal?.page, submission.terminal)) return false;
  settleQueuedFromTranscript(displayedChat);
  const prompts = submission.prompts.filter(
    (prompt) => !deliveredPrompts.has(prompt) && !promptAcknowledgedInChat(prompt, displayedChat),
  );
  const shouldEndSession = submission.endAfter;
  if (!prompts.length) {
    if (shouldEndSession && !ended) {
      try {
        await endSession(submission.terminal);
      } catch (error) {
        showPersistentSendFailure(TERMINAL_SEND_FAILED_COPY, false, {
          kind: "terminal",
          operation: submission.terminal,
        });
        throw error;
      }
    }
    settleAcknowledgementGuidance(submission, preserveFailureState);
    return;
  }
  /** @type {{ prompts: any[], domSnapshot: string, page_protocol?: number, snapshot_page?: string | null, snapshot_page_proof?: string, endSession?: boolean }} */
  const body = {
    prompts: prompts.map(stripInternalPromptFields),
    domSnapshot: submission.domSnapshot,
    ...(modernArtifactProtocol
      ? {
          page_protocol: 1,
          snapshot_page: submission.domSnapshot ? (submission.snapshotPage ?? null) : null,
          snapshot_page_proof: submission.domSnapshot ? submission.snapshotPageProof || "" : "",
        }
      : {}),
  };
  if (shouldEndSession) body.endSession = true;
  let response;
  try {
    response = await fetch("/api/" + key + "/prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    // The DOM snapshot is optional context and can be the difference between a
    // useful terminal batch and Express' request-size limit. Retry exactly once
    // without it; never mutate or split the user's exact feedback batch.
    if (response.status === 413 && body.domSnapshot) {
      if (shouldEndSession && blockTerminalForOtherPages(submission.terminal?.page, submission.terminal)) return false;
      body.domSnapshot = "";
      if (modernArtifactProtocol) {
        body.snapshot_page = null;
        body.snapshot_page_proof = "";
      }
      response = await fetch("/api/" + key + "/prompts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }
  } catch (error) {
    showQueuedSendFailure(submission.terminal ? TERMINAL_SEND_FAILED_COPY : SEND_FAILED_COPY, {
      kind: submission.terminal ? "terminal" : "submission",
      operation: submission.terminal || submission,
    });
    throw error;
  }
  if (!response.ok) {
    if (response.status === 413) {
      showQueuedSendFailure(
        "Could not send because this feedback is too large. It is still queued. Remove some feedback or attachments, then try again.",
        { kind: "submission", operation: submission },
      );
      if (submission.terminal) releaseTerminalSubmission(submission.terminal);
      throw new Error("queued feedback exceeds the request size limit");
    }
    if (response.status === 409) {
      const data = await response.json().catch(() => null);
      // The session already ended before this batch arrived - most likely this chrome missed the
      // live `ended` event (a dropped connection). Go read-only now instead of leaving Send enabled
      // for another attempt that will be refused the same way.
      if (data?.status === "ended") {
        clearSendAcknowledgementWarning();
        markSessionEnded();
        return false;
      }
      if (Array.isArray(data?.warnings)) setLayoutWarnings(data.warnings);
      showQueuedSendFailure(
        "Could not send because the layout issue selection changed. Your feedback is still queued. Review the current issues, then click Send to Agent to retry.",
        { kind: "submission", operation: submission },
      );
      if (submission.terminal) releaseTerminalSubmission(submission.terminal);
      return;
    }
    // C4: the server persisted nothing (atomic reject) - the queue below is left
    // intact because the splice only runs on success. Surface exactly what failed
    // so the user can fix the offending attachment(s) rather than losing them.
    if (response.status === 400) {
      const detail = await response.json().catch(() => ({}));
      if (Array.isArray(detail.rejected) && detail.rejected.length) {
        showQueuedSendFailure(describeAttachmentRejection(detail.rejected, detail.caps), {
          kind: "submission",
          operation: submission,
        });
        if (submission.terminal) releaseTerminalSubmission(submission.terminal);
      } else {
        showQueuedSendFailure(submission.terminal ? TERMINAL_SEND_FAILED_COPY : SEND_FAILED_COPY, {
          kind: submission.terminal ? "terminal" : "submission",
          operation: submission.terminal || submission,
        });
      }
    } else {
      showQueuedSendFailure(submission.terminal ? TERMINAL_SEND_FAILED_COPY : SEND_FAILED_COPY, {
        kind: submission.terminal ? "terminal" : "submission",
        operation: submission.terminal || submission,
      });
    }
    throw new Error("failed to submit queued prompts");
  }
  const accepted = typeof response.json === "function" ? await response.json().catch(() => null) : null;
  rememberChatAckIds(accepted?.ack_ids);
  const acceptedChat = Array.isArray(accepted?.chat) ? accepted.chat : null;
  if (acceptedChat) settleQueuedFromTranscript(acceptedChat);
  const acceptedRevision = parseChatRevision(accepted?.chat_revision);
  const reconciledChat = acceptedChat
    ? acceptedRevision !== null && acceptedRevision > chatRevision
      ? acceptedChat
      : mergeAcceptedChat(acceptedChat, submission.chatAtRequest)
    : null;
  if (!acceptedChat || reconciledChat) {
    for (const prompt of prompts) {
      deliveredPrompts.add(prompt);
      const index = queued.indexOf(prompt);
      if (index !== -1) queued.splice(index, 1);
    }
    persistQueuedPrompts();
    if (reconciledChat) syncChat(reconciledChat, acceptedRevision);
  }
  render();
  settleAcknowledgementGuidance(submission, preserveFailureState);
  if (shouldEndSession) {
    markSessionEnded();
    return;
  }
}

function submissionResolvesSendFailure(submission) {
  if (!sendFailureOwner) return true;
  if (sendFailureOwner.kind === "preparation") return false;
  if (sendFailureOwner.kind === "terminal") return sendFailureOwner.operation === submission.terminal;
  const failedSubmission = sendFailureOwner.operation;
  return (
    failedSubmission === submission ||
    (Array.isArray(failedSubmission.prompts) &&
      failedSubmission.prompts.every((prompt) => deliveredPrompts.has(prompt)))
  );
}

function settleAcknowledgementGuidance(submission, preserveFailureState) {
  if (!submissionResolvesSendFailure(submission) || (preserveFailureState && queued.length)) return;
  const hasLaterAcknowledgement = [...pendingAcknowledgements].some(
    (acknowledgement) => acknowledgement !== submission.acknowledgement,
  );
  if (hasLaterAcknowledgement) {
    if (!sendAcknowledgementTimer && !sendAcknowledgementWarningVisible) armSendAcknowledgementWarning();
    return;
  }
  clearSendAcknowledgementWarning();
  clearPersistentSendFailure();
}

function normalizeLayoutFindings(value) {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === "object" && String(item.severity || "").toLowerCase() === "error")
    : [];
}

function clearLayoutGateTimer() {
  layoutGateEscape?.cancel?.();
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
// Bumping the cycle invalidates the previous timer; setLayoutGateFailure immediately replaces it
// with a fresh hold timer so the card cannot strand the visual gate.
function setLayoutGateFailure(title, copy, actionLabel = "Reload", onAction, { sticky = false } = {}) {
  if (ended) return;
  // A sticky card is the user's to retire, and that has to hold against being overwritten as
  // well as against being cleared: the version-skew warning is the only thing telling this page
  // it is running the pre-upgrade client, and a later ordinary load failure must not replace it.
  if (layoutGateFailureActive && layoutGateFailureSticky && !sticky) return;
  layoutGateFailureActive = true;
  layoutGateFailureSticky = sticky;
  layoutGateCycle += 1;
  // Failure copy must not disable the visual gate's own recovery paths. Keep a fresh hold timer
  // over the card so a server replacement or any other failure cannot strand the artifact behind
  // a sticky message forever.
  if (layoutGateTitle) layoutGateTitle.textContent = title;
  if (layoutGateCopy) layoutGateCopy.textContent = copy;
  if (layoutGateAction) {
    layoutGateAction.disabled = false;
    layoutGateAction.textContent = actionLabel;
    layoutGateAction.onclick = onAction || (() => location.reload());
  }
  if (layoutGateBypass) {
    layoutGateBypass.hidden = false;
    layoutGateBypass.onclick = () => forceRevealLayoutGate("manual");
  }
  setLayoutGateActive(true);
  armLayoutGateTimer();
}

// Every failure card in this feature is raised in a state where the server may not be listening,
// so none of them may navigate on trust: a reload into a dead port replaces a recoverable page
// with the browser's own connection-error page. Ask first, and say so when nothing answers.
// Title and body are written together: a probe that timed out establishes neither that the server
// is running nor that it is gone, so a heading naming a definite cause may not stand over a line
// saying the cause is unknown.
function checkServerThenReload(failureTitle, stillDownCopy) {
  let checking = false;
  return async () => {
    if (checking) return;
    checking = true;
    if (layoutGateAction) layoutGateAction.disabled = true;
    // The card this click was made on. A probe can take until HEALTH_PROBE_TIMEOUT_MS, and the
    // overlay may have moved on to a different card - or back to the checking gate - by then; its
    // copy is not this probe's to overwrite.
    const cycle = layoutGateCycle;
    let outcome = "not-running";
    let navigating = false;
    try {
      outcome = await probeChromeHealth();
      if (outcome === "running") {
        navigating = true;
        await flushWhiteboardsBeforeChromeReload();
        location.reload();
      }
    } finally {
      // Every path that does not navigate hands the control back, including a probe that timed
      // out or threw: a button that stays disabled is worse than the reload it was guarding.
      if (!navigating) {
        checking = false;
        if (layoutGateAction) layoutGateAction.disabled = false;
        if (cycle === layoutGateCycle) {
          const answered = outcome !== "no-answer";
          if (layoutGateTitle) layoutGateTitle.textContent = answered ? failureTitle : HEALTH_NO_ANSWER_TITLE;
          if (layoutGateCopy) layoutGateCopy.textContent = answered ? stillDownCopy : HEALTH_NO_ANSWER_COPY;
        }
      }
    }
  };
}

// A load attempt that gets going again retires the failure card. This runs even when the gate is
// disabled or the user already bypassed it, because otherwise the card would keep covering an
// artifact that has since loaded.
function clearLayoutGateFailure() {
  if (!layoutGateFailureActive || layoutGateFailureSticky) return;
  layoutGateFailureActive = false;
  if (layoutGateAction) {
    layoutGateAction.textContent = "Show anyway";
    layoutGateAction.onclick = () => forceRevealLayoutGate("manual");
  }
  if (layoutGateBypass) layoutGateBypass.hidden = true;
  revealLayoutGate();
}

function revealLayoutGate() {
  clearLayoutGateTimer();
  layoutGateEscape?.reveal?.();
  setLayoutGateActive(false);
}

function forceRevealLayoutGate(reason) {
  if (ended) return;
  if (reason === "manual") {
    layoutGateManuallyBypassed = true;
    layoutGateEscape?.manualReveal?.();
  }
  revealLayoutGate();
}

function armLayoutGateTimer() {
  clearLayoutGateTimer();
  if (layoutGateEscape?.arm) {
    layoutGateEscape.arm(layoutGateMaxHoldMs, () => forceRevealLayoutGate("timeout"));
    return;
  }
  const cycle = layoutGateCycle;
  layoutGateTimer = setTimeout(() => {
    if (cycle !== layoutGateCycle || !layoutGateVisible || ended) return;
    forceRevealLayoutGate("timeout");
  }, layoutGateMaxHoldMs);
  layoutGateTimer?.unref?.();
}

function startLayoutGateCycle() {
  clearLayoutGateFailure();
  if (!layoutGateEnabled || layoutGateManuallyBypassed || ended) return;

  layoutGateCycle += 1;
  setLayoutGateActive(true);
  // A sticky failure owns the card copy, but never the reveal. Do not repaint it as a checking
  // card, and do arm a fresh timer for reloads that happen while the sticky card is present.
  if (!layoutGateFailureSticky) setLayoutGateCard("checking");
  armLayoutGateTimer();
}

// The gate only waits for fonts and final geometry now. It never holds the artifact hostage
// pending an agent repair: findings are the user's to triage, so a completed pass always reveals
// and hands the result to the passive inbox.
function handleLayoutGatePass() {
  if (ended || !layoutGateVisible) return;
  revealLayoutGate();
}

function initializeLayoutGate() {
  if (layoutGateEscape?.isManuallyBypassed?.()) layoutGateManuallyBypassed = true;
  if (!layoutGateEnabled) {
    setLayoutGateActive(false);
    return;
  }

  if (layoutGateAction) layoutGateAction.onclick = () => forceRevealLayoutGate("manual");
  if (layoutGateBypass) layoutGateBypass.onclick = () => forceRevealLayoutGate("manual");
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
      ...(modernArtifactProtocol
        ? {
            document_sequence: Number(pass?.documentSequence) || 0,
            page: typeof pass?.page === "string" ? pass.page : null,
            page_proof: String(pass?.pageProof || ""),
          }
        : {}),
      viewport_width: Number(pass?.viewportWidth) || 0,
      findings: normalizeLayoutFindings(pass?.findings),
    }),
  });
  if (!response.ok) throw new Error("failed to submit layout diagnostics");
  return response.json();
}

async function reportArtifactFailures(failures, context = {}) {
  const loadToken = String(context.loadToken || artifactLoadToken);
  const revision = Number(context.revision ?? artifactLoadRevision) || 0;
  const binding = context.binding || null;
  if (loadToken !== artifactLoadToken || revision !== artifactLoadRevision) return;
  await fetch("/api/" + key + "/artifact-failures", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      failures,
      artifact_load_token: loadToken,
      artifact_revision: revision,
      ...(modernArtifactProtocol
        ? {
            page: binding?.page ?? null,
            page_proof: binding?.proof || "",
            document_sequence: Number(binding?.documentSequence) || 0,
          }
        : {}),
    }),
  });
}

// The narrow fatal probe. A healthy artifact boots its SDK and starts talking within seconds; if
// nothing ever arrives we ask the server whether the document is servable at all. Probing only on
// silence keeps the normal path to a single artifact request, and a non-OK answer is the one
// signal that separates "the review is unusable" from "the review has layout problems".
function armArtifactAvailabilityProbe(loadToken = artifactLoadToken) {
  clearTimeout(artifactSilenceTimer);
  const binding = currentArtifactBinding;
  const pendingBinding =
    !binding &&
    pendingArtifactFailureBinding?.token === loadToken &&
    pendingArtifactFailureBinding?.revision === artifactLoadRevision
      ? pendingArtifactFailureBinding
      : null;
  const context = {
    loadToken,
    revision: artifactLoadRevision,
    binding: binding || pendingBinding,
    definitiveBinding: binding,
    pendingBinding,
    destination: binding?.destination || pendingBinding?.destination || artifactLoadDestination || artifactSrc,
  };
  artifactSilenceTimer = setTimeout(() => {
    if (loadToken !== artifactLoadToken) return;
    probeArtifactAvailability(context).catch(() => {});
  }, ARTIFACT_SILENCE_PROBE_MS);
  artifactSilenceTimer?.unref?.();
}

function artifactProbeSrc(destination, revision, loadToken) {
  const source = String(destination || artifactSrc);
  const hashIndex = source.indexOf("#");
  const beforeHash = hashIndex === -1 ? source : source.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : source.slice(hashIndex);
  const separator = beforeHash.includes("?") ? "&" : "?";
  return (
    beforeHash +
    separator +
    "probe=1&artifact_revision=" +
    encodeURIComponent(revision) +
    "&artifact_load_token=" +
    encodeURIComponent(loadToken) +
    hash
  );
}

async function probeArtifactAvailability(context) {
  const { loadToken, revision, definitiveBinding, pendingBinding, destination } = context;
  if (
    loadToken !== artifactLoadToken ||
    revision !== artifactLoadRevision ||
    (definitiveBinding ? currentArtifactBinding !== definitiveBinding : currentArtifactBinding) ||
    (pendingBinding && pendingArtifactFailureBinding !== pendingBinding)
  )
    return;
  try {
    const response = await fetch(artifactProbeSrc(destination, revision, loadToken), { cache: "no-store" });
    if (
      loadToken !== artifactLoadToken ||
      revision !== artifactLoadRevision ||
      (definitiveBinding ? currentArtifactBinding !== definitiveBinding : currentArtifactBinding) ||
      (pendingBinding && pendingArtifactFailureBinding !== pendingBinding)
    )
      return;
    if (response.status === 409) return;
    if (response.ok) return;
    await reportArtifactFailures(
      [{ kind: "artifact-unavailable", detail: "the artifact document responded with HTTP " + response.status }],
      context,
    );
  } catch {
    // A transient fetch failure is uncertainty, not proof - stay silent.
  }
}

function activeWarnings() {
  return layoutWarnings.filter((warning) => warning && warning.active && belongsToReviewPage(warning));
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
  checkbox.dataset.warningId = warning.id;
  checkbox.checked = selectable && selectedWarningIds.has(warning.id);
  checkbox.disabled = !selectable || Boolean(terminalSubmission?.inFlight);
  checkbox.setAttribute(
    "aria-label",
    selectable
      ? "Select " + warning.title + " on " + warning.viewport_label
      : warning.title + " on " + warning.viewport_label + " " + unavailableLabel,
  );
  checkbox.addEventListener("change", () => {
    if (terminalSubmission?.inFlight) {
      checkbox.checked = selectable && selectedWarningIds.has(warning.id);
      return;
    }
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
  if (
    warning.selector &&
    (!modernArtifactProtocol || (currentArtifactBinding && warning.page === currentArtifactBinding.page))
  ) {
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
  dismiss.className = "warning-action warning-dismiss";
  dismiss.dataset.warningId = warning.id;
  dismiss.textContent = "Dismiss";
  dismiss.disabled = !selectable || Boolean(terminalSubmission?.inFlight);
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
  const selectionLocked = Boolean(terminalSubmission?.inFlight);
  const selectableIds = new Set(selectable.map((warning) => warning.id));
  for (const selector of [".warning-select", ".warning-dismiss"]) {
    for (const element of warningsList.querySelectorAll(selector)) {
      const control = /** @type {HTMLInputElement | HTMLButtonElement} */ (element);
      control.disabled = selectionLocked || !selectableIds.has(control.dataset.warningId);
    }
  }
  warningsSelectAll.disabled = selectable.length === 0 || selectionLocked;
  // Default selection is never "everything": Select all is an explicit action.
  warningsSelectAll.checked = selectable.length > 0 && selectedCount === selectable.length;
  warningsSelectAll.indeterminate = selectedCount > 0 && selectedCount < selectable.length;
  warningsSelected.textContent = selectedCount === 0 ? "None selected" : selectedCount + " selected";
  warningsQueueButton.disabled = selectedCount === 0 || ended || terminalSubmission !== null;
}

function toggleSelectAllWarnings() {
  if (terminalSubmission?.inFlight) {
    updateWarningSelectionState();
    return;
  }
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
  if (modernArtifactProtocol && (!currentArtifactBinding || warning.page !== currentArtifactBinding.page)) return;
  postToFrame({ type: "lavish:revealElement", selector: warning.selector });
}

// ---------------------------------------------------------------------------
// Revision legend
//
// The agent declares what it changed in the artifact HTML itself (a
// `data-lavish-revisions` registry plus `data-lavish-revision` marks); the SDK
// reads it and posts it here. The legend lives entirely in the chrome, so the
// served artifact still matches the file on disk - Lavish never paints the
// change indicator into the page. Reveal borrows the same transient marker the
// layout-issues drawer uses, and only when the reader asks for it.

// The payload crosses postMessage from a sandboxed frame rendering author
// content, so it is untrusted here whatever built it. These bound what is
// examined, not what is accepted: capping accepted rows alone would let a
// registry of ten thousand records walk the whole array on the chrome's main
// thread before yielding its handful of rows.
// Server-owned, injected into the session JSON from src/artifact-revisions.js.
// The swatch is presentation the chrome owes the reader, not something the
// artifact gets a say in, so nothing about it is read from the message.
const REVISION_PALETTE = (Array.isArray(sessionData.revisionPalette) ? sessionData.revisionPalette : []).filter(
  (entry) => entry && /^#[0-9a-fA-F]{6}$/.test(String(entry.hex)),
);
const REVISION_LIMITS = {
  // Derived from the server-injected palette (src/artifact-revisions.js) rather than a
  // second hardcoded number, so the two can never drift; falls back to 6 only if the
  // palette itself came through empty.
  entries: REVISION_PALETTE.length > 0 ? REVISION_PALETTE.length : 6,
  rawEntries: 256,
  marks: 200,
  rawMarks: 2000,
  id: 60,
  label: 80,
  summary: 400,
  timestamp: 40,
  excerpt: 120,
  selector: 400,
};
const REVISION_BORDER_STYLES = ["solid", "dashed", "dotted", "double"];

/** @type {any[]} */
let revisionEntries = [];
/** @type {any[]} */
let revisionMarks = [];
/** @type {Map<string, number>} */
const revisionRevealCursor = new Map();
let revisionsDrawerOpen = false;

// Display-only fields. Anything the legend merely shows can be shortened.
function revisionText(value, max) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value).trim();
  return text.length > max ? text.slice(0, max) : text;
}

// Identity fields, mirroring `exactRevisionText` in src/artifact-revisions.js.
// The message is untrusted here, so shortening an id or a selector is worse
// than dropping it: two distinct overlong ids collapse into one legend row, and
// the first 400 characters of a long selector are a different valid selector
// that Reveal would resolve to some other block.
function revisionExact(value, max) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value).trim();
  return text.length > 0 && text.length <= max ? text : "";
}

function revisionPatternFill(pattern) {
  if (pattern === "diagonal") return "repeating-linear-gradient(45deg, currentColor 0 2px, transparent 2px 5px)";
  if (pattern === "dots") return "radial-gradient(currentColor 1px, transparent 1px)";
  return "";
}

// The swatch for a revision's position in the registry. Position is the only
// thing the artifact influences, and it cannot repeat one: ids are deduplicated
// before this runs, so each accepted revision gets a distinct index and
// therefore a distinct swatch.
function revisionPresentation(index) {
  const entry = REVISION_PALETTE.length > 0 ? REVISION_PALETTE[index % REVISION_PALETTE.length] : null;
  return {
    color: entry ? String(entry.hex) : "#0072b2",
    borderStyle: REVISION_BORDER_STYLES.includes(String(entry && entry.borderStyle))
      ? String(entry.borderStyle)
      : "solid",
    pattern: revisionPatternFill(entry && entry.pattern),
  };
}

// Only text crosses from the artifact into the legend, and it crosses as
// textContent. Nothing the message carries reaches a style property.
function normalizeRevisionMessage(msg) {
  const rawRevisions = Array.isArray(msg && msg.revisions) ? msg.revisions : [];
  const revisions = [];
  const byId = new Map();
  let examined = 0;
  for (const raw of rawRevisions) {
    if (examined >= REVISION_LIMITS.rawEntries || revisions.length >= REVISION_LIMITS.entries) break;
    examined += 1;
    if (!raw || typeof raw !== "object") continue;
    const id = revisionExact(raw.id, REVISION_LIMITS.id);
    if (!id || /\s/.test(id) || byId.has(id)) continue;
    const entry = {
      id,
      label: revisionText(raw.label, REVISION_LIMITS.label) || id,
      timestamp: revisionText(raw.timestamp, REVISION_LIMITS.timestamp),
      summary: revisionText(raw.summary, REVISION_LIMITS.summary),
      ...revisionPresentation(revisions.length),
      marks: [],
    };
    byId.set(id, entry);
    revisions.push(entry);
  }

  const rawMarks = Array.isArray(msg && msg.marks) ? msg.marks : [];
  const marks = [];
  examined = 0;
  for (const raw of rawMarks) {
    if (examined >= REVISION_LIMITS.rawMarks || marks.length >= REVISION_LIMITS.marks) break;
    examined += 1;
    if (!raw || typeof raw !== "object") continue;
    const revisionId = revisionExact(raw.revision_id, REVISION_LIMITS.id);
    const selector = revisionExact(raw.selector, REVISION_LIMITS.selector);
    const owner = byId.get(revisionId);
    if (!owner || !selector) continue;
    const mark = {
      revisionId,
      selector,
      tag: revisionText(raw.tag, 40).toLowerCase(),
      excerpt: revisionText(raw.excerpt, REVISION_LIMITS.excerpt),
    };
    owner.marks.push(mark);
    marks.push(mark);
  }

  return { revisions, marks };
}

function resetRevisionLegend() {
  revisionEntries = [];
  revisionMarks = [];
  revisionRevealCursor.clear();
  renderRevisionLegend();
}

function applyRevisionMessage(msg) {
  const normalized = normalizeRevisionMessage(msg);
  revisionEntries = normalized.revisions;
  revisionMarks = normalized.marks;
  for (const id of [...revisionRevealCursor.keys()]) {
    if (!revisionEntries.some((entry) => entry.id === id)) revisionRevealCursor.delete(id);
  }
  renderRevisionLegend();
}

function revisionMarkSummary(entry) {
  if (entry.marks.length === 0) return "no marked blocks";
  return entry.marks.length === 1 ? "1 marked block" : entry.marks.length + " marked blocks";
}

function buildRevisionRow(entry) {
  const row = document.createElement("div");
  row.className = "revision-row";

  const swatch = document.createElement("span");
  swatch.className = "revision-swatch";
  swatch.setAttribute("aria-hidden", "true");
  swatch.style.color = entry.color;
  swatch.style.borderColor = entry.color;
  swatch.style.borderStyle = entry.borderStyle;
  if (entry.pattern) swatch.style.backgroundImage = entry.pattern;
  row.appendChild(swatch);

  const body = document.createElement("div");
  body.className = "revision-body";

  const head = document.createElement("div");
  head.className = "revision-head";
  const label = document.createElement("span");
  label.className = "revision-label";
  label.textContent = entry.label;
  head.appendChild(label);
  if (entry.timestamp) {
    const time = document.createElement("span");
    time.className = "revision-time";
    time.textContent = entry.timestamp;
    head.appendChild(time);
  }
  body.appendChild(head);

  if (entry.summary) {
    const summary = document.createElement("p");
    summary.className = "revision-summary";
    summary.textContent = entry.summary;
    body.appendChild(summary);
  }

  const foot = document.createElement("div");
  foot.className = "revision-foot";
  const count = document.createElement("span");
  count.className = "revision-marks";
  count.textContent = revisionMarkSummary(entry);
  foot.appendChild(count);
  if (entry.marks.length > 0) {
    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.className = "revision-reveal";
    const position = (revisionRevealCursor.get(entry.id) || 0) % entry.marks.length;
    reveal.textContent = entry.marks.length === 1 ? "Reveal" : "Reveal " + (position + 1) + "/" + entry.marks.length;
    reveal.setAttribute("aria-label", "Reveal the next block changed in " + entry.label);
    // Bound per row rather than delegated from the list: the rows are rebuilt
    // on every render anyway, so there is no listener to accumulate, and the
    // button carries the revision it belongs to without a data attribute round
    // trip through the DOM.
    reveal.onclick = () => revealNextRevisionMark(entry.id);
    foot.appendChild(reveal);
  }
  body.appendChild(foot);

  row.appendChild(body);
  return row;
}

function renderRevisionLegend() {
  if (!revisionsWrap) return;
  const count = revisionEntries.length;
  revisionsWrap.hidden = count === 0 || ended;
  if (revisionsWrap.hidden && revisionsDrawerOpen) setRevisionsDrawerOpen(false);
  revisionsCount.textContent = String(count);
  revisionsButton.setAttribute("aria-label", count === 1 ? "1 revision" : count + " revisions");
  revisionsSummary.textContent =
    (count === 1 ? "1 revision" : count + " revisions") +
    " · " +
    (revisionMarks.length === 1 ? "1 marked block" : revisionMarks.length + " marked blocks");

  revisionsList.replaceChildren(...revisionEntries.map(buildRevisionRow));
}

function setRevisionsDrawerOpen(open) {
  revisionsDrawerOpen = open && !ended;
  revisionsDrawer.hidden = !revisionsDrawerOpen;
  revisionsButton.setAttribute("aria-expanded", String(revisionsDrawerOpen));
  if (revisionsDrawerOpen) closeMenus();
}

function closeRevisionsDrawer({ restoreFocus = false } = {}) {
  if (!revisionsDrawerOpen) return;
  setRevisionsDrawerOpen(false);
  if (restoreFocus) revisionsButton.focus();
}

// Step through a revision's marked blocks one at a time. The existing reveal
// path flashes one element and clears the previous marker, so a revision that
// touched several blocks is walked rather than lit up all at once.
function revealNextRevisionMark(id) {
  const entry = revisionEntries.find((candidate) => candidate.id === id);
  if (!entry || entry.marks.length === 0) return;
  const position = (revisionRevealCursor.get(id) || 0) % entry.marks.length;
  postToFrame({ type: "lavish:revealElement", selector: entry.marks[position].selector });
  revisionRevealCursor.set(id, (position + 1) % entry.marks.length);
  renderRevisionLegend();
}

async function dismissWarning(id) {
  if (terminalSubmission?.inFlight) return;
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
  const binding = currentArtifactBinding;
  if (modernArtifactProtocol && !binding) return;
  const preparation = beginFeedbackPreparation();
  if (!preparation) return;
  const ids = activeWarnings()
    .filter((warning) => warning.selectable && selectedWarningIds.has(warning.id))
    .map((warning) => warning.id);
  if (ids.length === 0) {
    preparation.finish(true);
    return;
  }
  warningsQueueButton.disabled = true;
  let succeeded = false;
  try {
    const response = await fetch("/api/" + key + "/layout-warnings/queue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids,
        ...(modernArtifactProtocol ? { page_protocol: 1, page: binding.page, page_proof: binding.proof } : {}),
      }),
    });
    if (!response.ok) throw new Error("failed to queue layout warning fixes");
    const data = await response.json();
    if (data.prompt) {
      if (
        modernArtifactProtocol &&
        (!Array.isArray(data.prompt.target?.warnings) ||
          data.prompt.target.warnings.some((warning) => !belongsToReviewPage(warning, binding.page)))
      )
        throw new Error("layout warning page mismatch");
      if (
        !enqueuePrompt(
          {
            uid: "",
            prompt: data.prompt.prompt,
            selector: "",
            tag: "layout-warnings",
            text: data.prompt.text,
            target: data.prompt.target,
          },
          preparation,
          binding,
        )
      )
        throw new Error("failed to retain layout warning fixes");
    }
    for (const id of ids) selectedWarningIds.delete(id);
    persistWarningSelection();
    if (Array.isArray(data.warnings)) setLayoutWarnings(data.warnings);
    if (!modernArtifactProtocol || binding === currentArtifactBinding) closeWarningsDrawer({ restoreFocus: true });
    clearPreparationFailure("layout-warnings");
    succeeded = true;
  } catch {
    showPersistentSendFailure(
      "Could not prepare the selected layout fixes. Review the current issues and try again.",
      false,
      { kind: "preparation", operation: preparation, preparationType: "layout-warnings" },
    );
    updateWarningSelectionState();
  } finally {
    preparation.finish(succeeded);
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

async function endSession(terminal = null) {
  if (ended || (terminalSubmission && terminal !== terminalSubmission)) return;
  const response = await fetch("/api/" + key + "/end", { method: "POST" });
  if (!response.ok) throw new Error("failed to end session");
  markSessionEnded();
}

function markSessionEnded() {
  if (ended) return;
  ended = true;
  pendingArtifactFailureBinding = null;
  pendingAcknowledgements.clear();
  clearSendAcknowledgementWarning();
  terminalSubmission = null;
  persistTerminalReservation(false);
  cancelArtifactLoadRecovery();
  closeMenus();
  closeShareDialog();
  closeWarningsDrawer();
  renderWarnings();
  closeRevisionsDrawer();
  renderRevisionLegend();
  closeWhiteboard();
  annotationSwitch.disabled = true;
  moreButton.disabled = true;
  chatInput.disabled = true;
  updateSendState();
  applySheetState();
  if (presenceBanner) presenceBanner.hidden = true;
  if (handoffBanner) handoffBanner.hidden = true;
  if (outdatedBanner) outdatedBanner.hidden = true;
  layoutGateManuallyBypassed = true;
  layoutGateFailureSticky = false;
  revealLayoutGate();
  layoutGateEscape?.end?.();
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

// ONE owner for the whole result panel. Every path that renders an outcome - dialog open, a
// successful publish, a retry after any failure, an indeterminate report, an incomplete 200 -
// routes through here, because a row shown or hidden by one path and reset by another is how a
// retry after a failed publish came to display "Published" with the once-only update_key still
// hidden. Each row is derived from the value it would show, so nothing can be half-rendered.
function renderShareResult({ url = "", siteId = "", password = "", updateKey = "" } = {}) {
  shareUrlInput.value = url;
  shareUrlResult.hidden = !url;
  // A self-hosted backend may not return one, and an empty box with a copy button is worse than
  // no row. Never derive it from the URL: that shape belongs to the backend, not Lavish.
  shareSiteIdInput.value = siteId;
  shareSiteIdResult.hidden = !siteId;
  sharePasswordOutput.value = password;
  sharePasswordResult.hidden = !password;
  shareUpdateKeyInput.value = updateKey;
  shareUpdateKeyResult.hidden = !updateKey;
  // The note's own copy tells the user to republish with `--site <site id> --update-key <key>`,
  // so it may only appear when BOTH halves of that credential are on screen. An update key with
  // no usable site id cannot update anything, and the status line says so instead.
  shareUpdateKeyNote.hidden = !(updateKey && siteId);
  shareResult.hidden = !(url || siteId || password || updateKey);
  // Returned so every sentence in the status line is derived from what was actually rendered.
  // Copy stamped from the request instead has promised rows the panel does not contain.
  return { url, siteId, password, updateKey };
}

// Wording shared with the CLI's next_step for the same condition, so the two surfaces cannot
// drift into describing the same dead end differently.
const NO_SITE_ID_WARNING =
  " The host did not return a site id Lavish can use, and --site is half the republish credential, so this page can NEVER be republished or unpublished even though its update key is in hand.";

// What the page is gated behind, said only in terms of what the panel can show. A password the
// user typed is never echoed by the server, so pointing at a row that was not rendered is the
// same confidently-wrong sentence this feature exists to avoid.
function publishedVisibilityText(isPublic, rendered, publicText) {
  if (isPublic) return publicText;
  return rendered.password ? "behind the password below" : "behind the password you supplied";
}

function openShareDialog() {
  closeMenus();
  shareDialog.hidden = false;
  shareStatus.textContent = "";
  shareStatus.classList.remove("error");
  renderShareResult();
  shareGenerateInput.checked = false;
  sharePasswordInput.value = "";
  syncSharePasswordInput();
  sharePasswordInput.focus();
}

// A generated password and a typed one are the same field to the server, so the checkbox owns
// the input rather than the two racing to decide what gets published.
function syncSharePasswordInput() {
  const generating = shareGenerateInput.checked;
  sharePasswordInput.disabled = generating;
  sharePasswordInput.placeholder = generating
    ? "Lavish will generate one when you publish"
    : "Leave blank for a public page";
  if (generating) sharePasswordInput.value = "";
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

function reportIndeterminatePublish(data) {
  const rendered = renderShareResult({ password: data.password || "" });
  shareStatus.classList.add("error");
  const reason = data.error ? data.error + " " : "";
  const visibility = publishedVisibilityText(data.public, rendered, "PUBLIC - anyone with the link could read it");
  shareStatus.textContent =
    reason +
    "ht-ml.app may or may not have published this page, so treat the outcome as unknown. If it did publish, the page is live " +
    visibility +
    ", and its URL and update key were lost with the failed response, so it can never be republished or unpublished. Publishing again creates a SECOND page rather than replacing it." +
    (rendered.password ? " Copy the password now - it is shown once here and Lavish does not store it." : "");
}

// An incomplete 200 is NOT an unknown outcome: the host answered, so the page landed. Whatever
// fields did arrive are rendered, because a url with no update_key names a live, public-by-default
// page whose only write credential is gone - and saying "may or may not" there would throw away
// the address Lavish is holding.
function reportIncompletePublish(data) {
  const rendered = renderShareResult({
    url: data.url || "",
    siteId: data.site_id || "",
    password: data.password || "",
    updateKey: data.update_key || "",
  });
  shareStatus.classList.add("error");
  const visibility = publishedVisibilityText(data.public, rendered, "PUBLIC - anyone with the link can read it");
  const updateKeyNote = !rendered.updateKey
    ? "No update key came back, and ht-ml.app issues one only once and has no delete, so this page can never be republished or unpublished. "
    : rendered.siteId
      ? "Copy the update key below - it is issued once. "
      : "Copy the update key below - it is issued once, though" + NO_SITE_ID_WARNING.slice(1) + " ";
  shareStatus.textContent =
    "ht-ml.app accepted this publish, so the page IS live and " +
    visibility +
    ", but its response was malformed and Lavish could not read the whole result back. " +
    (rendered.url ? "Its address is below. " : "The response carried no URL, so Lavish cannot show the address. ") +
    updateKeyNote +
    "Publishing again creates a SECOND page rather than replacing it." +
    (rendered.password ? " Copy the password now - it is shown once here and Lavish does not store it." : "");
}

async function publishShare(event) {
  event.preventDefault();
  sharePublishButton.disabled = true;
  shareStatus.classList.remove("error");
  shareStatus.textContent = "Publishing to ht-ml.app...";
  renderShareResult();
  const generating = shareGenerateInput.checked;
  const password = generating ? "" : sharePasswordInput.value.trim();
  const passwordProtected = generating || Boolean(password);
  try {
    const response = await fetch("/api/" + key + "/share", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(generating ? { generate_password: true } : password ? { password } : {}),
    });
    const data = await response.json();
    if (!response.ok) {
      // Only a host rejection proves nothing was published. On anything else the page may already
      // be live, and a password minted for this request is the one thing that could still open it,
      // so it is shown here rather than dying with the failed response.
      if (data.outcome === "published-incomplete") {
        reportIncompletePublish(data);
        return;
      }
      if (data.outcome === "indeterminate") {
        reportIndeterminatePublish(data);
        return;
      }
      throw new Error(data.error || "publish failed");
    }
    const rendered = renderShareResult({
      url: data.url || "",
      siteId: data.site_id || "",
      password: data.password || "",
      updateKey: data.update_key || "",
    });
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
    if (rendered.updateKey && !rendered.siteId) shareStatus.textContent += NO_SITE_ID_WARNING;
    if (rendered.password) {
      shareStatus.textContent += " Copy the password now - it is shown once here and Lavish does not store it.";
    }
    shareUrlInput.focus();
    shareUrlInput.select();
  } catch (error) {
    // Deliberately does NOT clear the panel. It is already cleared before the fetch, so the only
    // thing this could reach is a result the success path already rendered - and wiping that
    // destroys the once-issued update_key of a page that definitely published.
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
function scheduleArtifactLoadRecovery(historicalPage = null) {
  if (ended) return false;
  const delay = ARTIFACT_LOAD_RECOVERY_DELAYS_MS[artifactLoadRecoveryAttempt];
  if (delay === undefined) return false;
  artifactLoadRecoveryAttempt += 1;
  const sequence = artifactLoadRequestSequence;
  cancelArtifactLoadRecovery();
  artifactLoadRecoveryTimer = setTimeout(() => {
    artifactLoadRecoveryTimer = undefined;
    if (ended || sequence !== artifactLoadRequestSequence) return;
    replaceArtifactFrame({ recoveryRetry: true, historicalPage }).catch(() => {});
  }, delay);
  artifactLoadRecoveryTimer?.unref?.();
  return true;
}

// The backoff budget belongs to the load attempt that started it, not to the page: anything
// asking for a fresh load - a live reload, Reload artifact, a takeover - gets the whole budget
// again, and only the recovery timer's own retries spend it down. A page that carried an
// exhausted counter forward would have no retries left at all for the next outage.
async function replaceArtifactFrame({ recoveryRetry = false, historicalPage = null } = {}) {
  cancelArtifactLoadRecovery();
  if (!recoveryRetry) artifactLoadRecoveryAttempt = 0;
  clearTimeout(artifactSilenceTimer);
  pendingArtifactFailureBinding = null;
  const destinationCandidate = historicalPage ? null : currentDestinationCandidate();
  const requestedDestination = destinationPayload(destinationCandidate);
  // The iframe is sandboxed, so reload by resetting the iframe URL from chrome.
  if (!artifactSrc) {
    // The next document reports its own registry once it loads; until then the
    // previous revision's legend would point at blocks that may no longer exist.
    // Only clear it here, right before the frame is actually replaced - a preserved
    // load (superseded/out-of-order/exhausted retries below) must leave it intact.
    resetRevisionLegend();
    startLayoutGateCycle();
    const currentSrc = frame.src || artifactSrc;
    navigateArtifactFrame(freshReloadDestination(currentSrc || artifactSrc));
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
  // clear on their own - the shared server is mid-restart, or a handoff no begin-load had yet
  // persisted was lost with that restart and this chrome's one re-handshake landed in the same
  // outage window. Giving up here is what leaves the review permanently unloaded.
  const recoverLater = () => {
    preservePreviousLoad();
    if (requestSequence !== artifactLoadRequestSequence || ended) return false;
    if (scheduleArtifactLoadRecovery(historicalPage)) return false;
    // Out of retries. Only say so when there is nothing on screen to say it over: a chrome that
    // already shows an artifact keeps showing it rather than losing a usable review.
    if (!artifactLoadToken) {
      setLayoutGateFailure(
        "Lavish could not load this artifact.",
        "The Lavish server did not answer this review's load request. It usually restarted while this page was opening. Check and reload to reconnect.",
        "Check and reload",
        checkServerThenReload(
          "Lavish could not load this artifact.",
          "Lavish is still not answering. Start it again with your agent, then use Check and reload.",
        ),
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
          ...(modernArtifactProtocol && requestedDestination
            ? { destination: requestedDestination, reload_reason: recoveryRetry ? "recovery" : "reload" }
            : {}),
          ...(modernArtifactProtocol && historicalPage
            ? {
                historical_page: historicalPage,
              }
            : {}),
        }),
      });
      if (response.ok) retireArtifactBinding();
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
        if (status === "invalid-destination") {
          setLayoutGateFailure(
            "Lavish could not reload this page.",
            "The page is no longer an eligible local HTML document. The current review was kept intact; reload the saved entry to continue.",
            "Reload entry",
            () => {
              retireArtifactBinding();
              markDestinationUnavailable();
              artifactLoadDestination = "";
              replaceArtifactFrame().catch(() => {});
            },
          );
          return preservePreviousLoad();
        }
        throw new Error("failed to begin artifact load");
      }
      const candidateRevision = Number(candidate?.artifact_revision);
      const candidateToken = String(candidate?.artifact_load_token || "");
      if (!Number.isSafeInteger(candidateRevision) || candidateRevision < 0 || !candidateToken) {
        throw new Error("invalid artifact load");
      }
      load = {
        artifact_revision: candidateRevision,
        artifact_load_token: candidateToken,
        artifact_url: typeof candidate?.artifact_url === "string" ? candidate.artifact_url : "",
        page: typeof candidate?.page === "string" ? candidate.page : "",
        page_proof: typeof candidate?.page_proof === "string" ? candidate.page_proof : "",
        served_route: typeof candidate?.served_route === "string" ? candidate.served_route : "",
      };
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
  retireAllWhiteboardChannels();
  setHandoffSuperseded(false);
  startLayoutGateCycle();
  const responseDestination = String(load?.artifact_url || "");
  const responseRoute = historicalPage ? String(load?.served_route || "") : destinationCandidate?.route || "";
  const validatedResponseDestination = responseDestination
    ? normalizeArtifactDestination(responseDestination, responseRoute)
    : "";
  const candidateDestination = historicalPage
    ? ""
    : String(destinationCandidate?.destination || destinationCandidate?.route || artifactSrc);
  const validatedCandidateDestination = normalizeArtifactDestination(candidateDestination, responseRoute);
  if (
    (responseDestination && !validatedResponseDestination) ||
    (!responseDestination && candidateDestination && !validatedCandidateDestination)
  ) {
    return recoverLater();
  }
  const selectedDestination = responseDestination ? validatedResponseDestination : validatedCandidateDestination;
  if (!selectedDestination) return recoverLater();
  artifactLoadDestination = selectedDestination;
  if (modernArtifactProtocol && load?.page && load?.page_proof && load?.served_route) {
    pendingArtifactFailureBinding = {
      page: load.page,
      proof: load.page_proof,
      route: load.served_route,
      destination: artifactLoadDestination,
      documentSequence: 1,
      token,
      revision,
    };
  }
  // The next document reports its own registry once it loads; until then the
  // previous revision's legend would point at blocks that may no longer exist.
  // This reset stays adjacent to the navigation that actually replaces the
  // document, after every preserve/fail-closed return above.
  resetRevisionLegend();
  navigateArtifactFrame(artifactFrameSrcForLoad({ revision, token, destination: artifactLoadDestination }));
  return true;
}

function resetFrame() {
  if (artifactResetPromise) return artifactResetPromise;
  const hasLiveInlineWhiteboard = [...inlineWhiteboardChannels.values()].some(
    (channel) => channel.initialized && channel.active && channel.context !== overlayContext,
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

/**
 * @typedef {{
 *   key: string,
 *   index: number,
 *   page: string | null,
 *   proof: string,
 *   binding: any,
 *   token: string,
 *   revision: number,
 *   documentId: string,
 *   documentSequence: number,
 *   placement?: "inline" | "overlay",
 *   channel?: any,
 *   channelId?: string,
 *   active?: boolean,
 * }} WhiteboardContext
 */

/** @type {Map<string, { diagramId: string, source: string, sourceHash: string, page: string | null, index: number }>} */
const whiteboards = new Map();
/** @type {number | null} */
let overlayIndex = null;
let overlayFrameReady = false;
let overlayChannelId = "";
/** @type {WhiteboardContext | null} */
let overlayContext = null;
/** @type {WhiteboardContext | null} */
let overlayOpeningContext = null;
let nextWhiteboardFlushId = 0;
let artifactResetPromise = null;
let chromeRestartReloadPromise = null;
const whiteboardTeardowns = new Map();
const whiteboardFlushes = new Map();
const whiteboardSaveChains = new Map();
const inlineWhiteboardChannels = new Map();

function whiteboardIdentityKey(page, index) {
  return JSON.stringify([page === null || page === undefined ? null : String(page), Number(index)]);
}

function captureWhiteboardContext(index, binding = currentArtifactBinding, placement = "inline") {
  const normalizedIndex = validWhiteboardIndex(index);
  if (normalizedIndex === null) return null;
  const modern = modernArtifactProtocol;
  const page = modern ? (binding?.page ?? null) : null;
  return {
    key: whiteboardIdentityKey(page, normalizedIndex),
    index: normalizedIndex,
    page,
    proof: modern ? String(binding?.proof || "") : "",
    binding,
    token: String(binding?.token || ""),
    revision: Number(binding?.revision) || 0,
    documentId: String(binding?.documentId || ""),
    documentSequence: Number(binding?.documentSequence) || 0,
    placement,
  };
}

function whiteboardContextIsLive(context) {
  if (!context || context.active === false || ended) return false;
  // The legacy page-less transport has no binding to compare. Its channel
  // remains authenticated by the existing source + channel-id checks.
  return !modernArtifactProtocol || Boolean(context.binding && currentArtifactBinding === context.binding);
}

function whiteboardPageQuery(context) {
  if (!modernArtifactProtocol || !context || context.page === null || !context.proof) return "";
  return "?page=" + encodeURIComponent(context.page) + "&page_proof=" + encodeURIComponent(context.proof);
}

function whiteboardEndpoint(pathname, context) {
  return String(pathname) + whiteboardPageQuery(context);
}

function whiteboardPageBody(context) {
  if (!modernArtifactProtocol || !context || context.page === null || !context.proof) return {};
  // Durable operations deliberately carry only the captured page credential.
  // Live generation fields belong to channel authentication, not to delayed
  // saves or feedback exports, which must remain valid across handoff/restart.
  return { page: context.page, page_proof: context.proof };
}

function whiteboardChannelAuthBody(token, context) {
  const body = { token: String(token || "") };
  if (modernArtifactProtocol && context?.binding) {
    Object.assign(body, {
      page_protocol: 1,
      page: context.page,
      page_proof: context.proof,
      artifact_load_token: context.token,
      artifact_revision: context.revision,
      document_sequence: context.documentSequence,
    });
  }
  return body;
}

function retireWhiteboardChannelsForBinding(binding) {
  if (!binding) return;
  for (const channel of inlineWhiteboardChannels.values()) {
    if (channel.context?.binding === binding) channel.active = false;
  }
  if (overlayContext?.binding === binding) overlayContext.active = false;
  if (overlayOpeningContext?.binding === binding) overlayOpeningContext.active = false;
}

function retireAllWhiteboardChannels() {
  for (const channel of inlineWhiteboardChannels.values()) channel.active = false;
  inlineWhiteboardChannels.clear();
  if (overlayContext) overlayContext.active = false;
  if (overlayOpeningContext) overlayOpeningContext.active = false;
}

function whiteboardTheme() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function postToWhiteboardOverlay(message, context = overlayContext, allowInactive = false) {
  if (!context || (!allowInactive && !whiteboardContextIsLive(context))) return;
  const channelId = String(context.channelId || overlayChannelId || "");
  if (whiteboardFrame.contentWindow && channelId) {
    whiteboardFrame.contentWindow.postMessage({ ...message, channelId }, "*");
  }
}

function postToInlineWhiteboard(context, message, allowInactive = false) {
  const channel = context?.channel || inlineWhiteboardChannels.get(context?.key);
  if (!channel || (!allowInactive && (!channel.active || !whiteboardContextIsLive(context)))) return;
  if (channel.window) channel.window.postMessage({ ...message, channelId: channel.channelId }, "*");
}

function postToWhiteboard(context, message, allowInactive = false) {
  if (!context) return;
  if (context.placement === "overlay") postToWhiteboardOverlay(message, context, allowInactive);
  else postToInlineWhiteboard(context, message, allowInactive);
}

async function fetchMermaidSources(context = null) {
  const response = await fetch(whiteboardEndpoint("/api/" + key + "/mermaid-sources", context));
  if (!response.ok) throw new Error("could not read the artifact's Mermaid sources");
  const data = await response.json();
  return Array.isArray(data.sources) ? data.sources : [];
}

async function authenticateWhiteboardChannel(token, context = null) {
  const response = await fetch("/api/" + key + "/whiteboard-channel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(whiteboardChannelAuthBody(token, context)),
  });
  return response.ok;
}

function showWhiteboardError(text) {
  whiteboardError.textContent = text;
  whiteboardError.hidden = false;
  whiteboardOverlay.hidden = false;
}

function whiteboardRecord(index, page = modernArtifactProtocol ? (currentArtifactBinding?.page ?? null) : null) {
  const normalizedIndex = validWhiteboardIndex(index);
  if (normalizedIndex === null) return null;
  const identityKey = whiteboardIdentityKey(page, normalizedIndex);
  let record = whiteboards.get(identityKey);
  if (!record) {
    record = { diagramId: "", source: "", sourceHash: "", page, index: normalizedIndex };
    whiteboards.set(identityKey, record);
  }
  return record;
}

async function handleWhiteboardReady(context, mode, isCurrent) {
  if (!context) return false;
  const { index } = context;
  try {
    const sources = await fetchMermaidSources(context);
    const source = sources.find((item) => item.index === index);
    if (!source) throw new Error("this diagram's Mermaid source was not found in the artifact file");
    const savedResponse = await fetch(whiteboardEndpoint("/api/" + key + "/whiteboard/" + index, context));
    const saved = savedResponse.ok ? (await savedResponse.json()).whiteboard : null;
    const record = whiteboardRecord(index, context.page);
    if (!record) return false;
    record.source = String(source.source || "");
    record.sourceHash = String(source.hash || "");
    if (!isCurrent()) return false;
    postToWhiteboard(context, {
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

function showWhiteboardOverlay(context) {
  if (!context || ended || !whiteboardContextIsLive(context)) return;
  overlayContext = { ...context, placement: "overlay", active: true, channel: null, channelId: "" };
  overlayIndex = context.index;
  overlayFrameReady = false;
  overlayChannelId = "";
  inlineWhiteboardChannels.delete(context.key);
  whiteboardError.hidden = true;
  whiteboardOverlay.hidden = false;
  postToFrame({ type: "lavish:suspendWhiteboard", diagramIndex: context.index, page: context.page });
  // A fresh document per open: the frame boots, posts ready, and receives its
  // init - no stale editor state can leak between opens.
  whiteboardFrame.src =
    "/whiteboard-frame?diagramIndex=" + encodeURIComponent(String(context.index)) + "&key=" + encodeURIComponent(key);
}

function finishWhiteboardClose(context = overlayContext) {
  const index = context?.index ?? overlayIndex;
  const shouldResume = Boolean(!ended && context && whiteboardContextIsLive(context));
  whiteboardOverlay.hidden = true;
  whiteboardError.hidden = true;
  whiteboardFrame.src = "about:blank";
  overlayIndex = null;
  overlayFrameReady = false;
  overlayChannelId = "";
  if (context) {
    context.active = false;
    if (context.key) inlineWhiteboardChannels.delete(context.key);
  }
  overlayContext = null;
  if (shouldResume) {
    postToFrame({ type: "lavish:resumeWhiteboard", diagramIndex: index, page: context.page });
  }
}

function whiteboardTeardownKey(context, placement) {
  return placement + ":" + (context?.key || "");
}

function beginWhiteboardTeardown(context, placement, onComplete) {
  if (!context) return Promise.resolve(false);
  const teardownKey = whiteboardTeardownKey(context, placement);
  const pending = whiteboardTeardowns.get(teardownKey);
  if (pending) {
    if (onComplete) pending.promise.then(onComplete);
    return pending.promise;
  }
  const flushId = `whiteboard-${++nextWhiteboardFlushId}`;
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  const teardown = { context, index: context.index, placement, flushId, promise, resolve, onComplete };
  whiteboardTeardowns.set(teardownKey, teardown);
  const message = { type: "lavish-whiteboard:prepareTeardown", flushId };
  postToWhiteboard(context, message);
  return promise;
}

function finishWhiteboardTeardown(context, message, placement) {
  const flushId = String(message.flushId || "");
  const teardownKey = whiteboardTeardownKey(context, placement);
  const teardown = whiteboardTeardowns.get(teardownKey);
  if (
    !teardown ||
    teardown.index !== context?.index ||
    teardown.placement !== placement ||
    teardown.flushId !== flushId ||
    teardown.context?.channelId !== context?.channelId
  )
    return;
  whiteboardTeardowns.delete(teardownKey);
  teardown.onComplete?.(true);
  teardown.resolve(true);
}

function failWhiteboardTeardown(context, message, placement) {
  const flushId = String(message.flushId || "");
  const teardownKey = whiteboardTeardownKey(context, placement);
  const teardown = whiteboardTeardowns.get(teardownKey);
  if (
    !teardown ||
    teardown.index !== context?.index ||
    teardown.placement !== placement ||
    teardown.flushId !== flushId ||
    teardown.context?.channelId !== context?.channelId
  )
    return;
  whiteboardTeardowns.delete(teardownKey);
  teardown.onComplete?.(false);
  teardown.resolve(false);
}

function whiteboardFlushKey(context, placement) {
  return placement + ":" + (context?.key || "");
}

function beginWhiteboardFlush(context, placement) {
  if (!context) return Promise.resolve(false);
  const flushKey = whiteboardFlushKey(context, placement);
  const pending = whiteboardFlushes.get(flushKey);
  if (pending) return pending.promise;
  const flushId = `whiteboard-flush-${++nextWhiteboardFlushId}`;
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  whiteboardFlushes.set(flushKey, { context, index: context.index, placement, flushId, promise, resolve });
  postToWhiteboard(context, { type: "lavish-whiteboard:flush", flushId });
  return promise;
}

function finishWhiteboardFlush(context, message, placement) {
  const flushId = String(message.flushId || "");
  const flushKey = whiteboardFlushKey(context, placement);
  const flush = whiteboardFlushes.get(flushKey);
  if (
    !flush ||
    flush.index !== context?.index ||
    flush.placement !== placement ||
    flush.flushId !== flushId ||
    flush.context?.channelId !== context?.channelId
  )
    return;
  whiteboardFlushes.delete(flushKey);
  flush.resolve(Boolean(message.ok));
}

async function flushWhiteboardsBeforeChromeReload() {
  const flushes = [];
  for (const channel of inlineWhiteboardChannels.values()) {
    if (channel.initialized && channel.active && channel.context !== overlayContext) {
      flushes.push(beginWhiteboardFlush(channel.context, "inline"));
    }
  }
  if (overlayContext && overlayFrameReady) flushes.push(beginWhiteboardFlush(overlayContext, "overlay"));
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
  for (const channel of [...inlineWhiteboardChannels.values()]) {
    if (!channel.initialized || !channel.active || channel.context === overlayContext) continue;
    if (!(await beginWhiteboardTeardown(channel.context, "inline"))) return false;
  }
  return true;
}

function openWhiteboardOverlay(context) {
  if (!context || ended || overlayIndex !== null || overlayOpeningContext !== null) return;
  if (!whiteboardContextIsLive(context)) return;
  overlayOpeningContext = context;
  beginWhiteboardTeardown(context, "inline", (flushed) => {
    if (overlayOpeningContext !== context) return;
    overlayOpeningContext = null;
    if (flushed && !ended && overlayIndex === null && whiteboardContextIsLive(context)) showWhiteboardOverlay(context);
  });
}

function closeWhiteboard() {
  const context = overlayContext;
  if (!context || overlayIndex === null) return;
  // Navigation retires the artifact binding while the standalone overlay can
  // still be visible. Its channel may no longer start any user action, but the
  // chrome must still be able to discard the departed editor instead of
  // waiting forever for a teardown response from a stale page.
  if (!whiteboardContextIsLive(context)) {
    finishWhiteboardClose(context);
    return;
  }
  if (!overlayFrameReady) {
    finishWhiteboardClose(context);
    return;
  }
  beginWhiteboardTeardown(context, "overlay", (flushed) => {
    if (flushed && overlayContext === context) finishWhiteboardClose(context);
  });
}

async function persistWhiteboardScene(context, message) {
  const response = await fetch(whiteboardEndpoint("/api/" + key + "/whiteboard/" + context.index, context), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source_hash: String(message.sourceHash || ""),
      text_metrics_version: Number(message.textMetricsVersion) || 0,
      scene: message.scene || null,
      baseline: message.baseline || null,
      ...whiteboardPageBody(context),
    }),
  });
  if (!response.ok) throw new Error("failed to save whiteboard scene");
}

function saveWhiteboardScene(context, message) {
  if (!context) return Promise.reject(new Error("whiteboard context is unavailable"));
  // The context and payload are captured before entering the chain. The
  // current page may change while either the prior save or this request is
  // waiting on the server; neither await is allowed to retarget the write.
  const capturedContext = { ...context };
  const capturedMessage = { ...message };
  const previous = whiteboardSaveChains.get(context.key) || Promise.resolve();
  const result = previous.catch(() => {}).then(() => persistWhiteboardScene(capturedContext, capturedMessage));
  const tail = result.catch(() => {});
  whiteboardSaveChains.set(context.key, tail);
  tail.finally(() => {
    if (whiteboardSaveChains.get(context.key) === tail) whiteboardSaveChains.delete(context.key);
  });
  return result;
}

function handleWhiteboardSave(context, message) {
  const capturedContext = { ...context };
  const flushId = String(message.flushId || "");
  saveWhiteboardScene(capturedContext, message).then(
    () => {
      if (flushId) postToWhiteboard(capturedContext, { type: "lavish-whiteboard:saveResult", flushId, ok: true }, true);
    },
    (error) => {
      if (flushId) {
        postToWhiteboard(
          capturedContext,
          {
            type: "lavish-whiteboard:saveResult",
            flushId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          true,
        );
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

async function queueWhiteboardFeedback(context, message) {
  const capturedContext = { ...context };
  const index = capturedContext.index;
  const preparation = beginFeedbackPreparation();
  if (!preparation) {
    postToWhiteboard(
      capturedContext,
      {
        type: "lavish-whiteboard:queueResult",
        ok: false,
        error: "Feedback delivery is already ending this review.",
      },
      true,
    );
    return;
  }
  const record = whiteboardRecord(index, capturedContext.page);
  const diagramId = record?.diagramId || "";
  let succeeded = false;
  try {
    // Persist the exact reviewed state before queueing, so the paths in the
    // prompt point at what the user actually saw.
    await saveWhiteboardScene(capturedContext, message);
    const response = await fetch(
      whiteboardEndpoint("/api/" + key + "/whiteboard/" + index + "/feedback-files", capturedContext),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scene: message.scene || null,
          pngDataUrl: String(message.pngDataUrl || ""),
          ...whiteboardPageBody(capturedContext),
        }),
      },
    );
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
    if (
      !enqueuePrompt(
        {
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
            page: capturedContext.page,
          },
          // Re-queueing the same diagram's whiteboard before sending replaces the
          // earlier unsent prompt instead of stacking duplicates.
          [internalQueueKeyField]: "whiteboard:" + index,
        },
        preparation,
        capturedContext,
      )
    )
      throw new Error("failed to retain whiteboard feedback");
    // Queued from the whiteboard inside the artifact, like any other in-artifact prompt.
    pulseSheetDock();
    postToWhiteboard(capturedContext, { type: "lavish-whiteboard:queueResult", ok: true }, true);
    if (capturedContext.placement === "overlay") closeWhiteboard();
    clearPreparationFailure("whiteboard");
    succeeded = true;
  } catch (error) {
    postToWhiteboard(
      capturedContext,
      {
        type: "lavish-whiteboard:queueResult",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      true,
    );
  } finally {
    preparation.finish(succeeded);
  }
}

// Inline frames live inside the artifact iframe, so a live reload replaces
// them wholesale and they re-init against fresh sources on their own. Only an
// open overlay outlives the reload; tell it when its diagram's source changed
// underneath it so the frame can surface staleness (never silently merge).
async function refreshWhiteboardSource() {
  const context = overlayContext;
  if (!context || overlayIndex === null) return;
  const index = context.index;
  try {
    const sources = await fetchMermaidSources(context);
    const source = sources.find((item) => item.index === index);
    const nextHash = source ? String(source.hash || "") : "";
    const record = whiteboardRecord(index, context.page);
    if (!record || overlayContext !== context) return;
    if (nextHash !== record.sourceHash) {
      record.source = source ? String(source.source || "") : "";
      record.sourceHash = nextHash;
      postToWhiteboardOverlay(
        {
          type: "lavish-whiteboard:sourceChanged",
          source: record.source,
          sourceHash: record.sourceHash,
        },
        context,
      );
    }
  } catch {
    // Best effort - the staleness banner also re-arms on the next open.
  }
}

function validWhiteboardIndex(value) {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 && index <= 999 ? index : null;
}

function handleAuthenticatedWhiteboardMessage(context, message, mode) {
  if (!context) return;
  const completion =
    message.type === "lavish-whiteboard:teardownReady" ||
    message.type === "lavish-whiteboard:teardownFailed" ||
    message.type === "lavish-whiteboard:flushComplete";
  // A departed frame may finish a save/flush that chrome accepted earlier, but
  // it cannot start a new persistence action after the binding has changed.
  if (!completion && !whiteboardContextIsLive(context)) return;
  if (message.type === "lavish-whiteboard:save") handleWhiteboardSave(context, message);
  if (message.type === "lavish-whiteboard:queueFeedback") queueWhiteboardFeedback(context, message);
  if (message.type === "lavish-whiteboard:maximize" && mode === "inline") openWhiteboardOverlay(context);
  if (message.type === "lavish-whiteboard:close" && mode === "overlay" && overlayContext === context) closeWhiteboard();
  if (message.type === "lavish-whiteboard:teardownReady") finishWhiteboardTeardown(context, message, mode);
  if (message.type === "lavish-whiteboard:teardownFailed") failWhiteboardTeardown(context, message, mode);
  if (message.type === "lavish-whiteboard:flushComplete") finishWhiteboardFlush(context, message, mode);
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
    const binding = modernArtifactProtocol ? currentArtifactBinding : null;
    if (modernArtifactProtocol && !binding) return;
    const context = captureWhiteboardContext(index, binding, "inline");
    if (!context || inlineWhiteboardChannels.has(context.key)) return;
    const channelId = String(message.channelToken || "");
    if (!channelId) return;
    context.channelId = channelId;
    const channel = { context, window: event.source, channelId, initialized: false, active: true };
    context.channel = channel;
    authenticateWhiteboardChannel(channelId, context).then((authenticated) => {
      if (!authenticated || ended || !whiteboardContextIsLive(context) || inlineWhiteboardChannels.has(context.key)) {
        channel.active = false;
        return;
      }
      inlineWhiteboardChannels.set(context.key, channel);
      const record = whiteboardRecord(index, context.page);
      if (!record) return;
      record.diagramId = String(message.diagramId || "");
      handleWhiteboardReady(
        context,
        "inline",
        () =>
          channel.active && whiteboardContextIsLive(context) && inlineWhiteboardChannels.get(context.key) === channel,
      ).then((initialized) => {
        if (inlineWhiteboardChannels.get(context.key) === channel) channel.initialized = initialized;
      });
    });
    return;
  }
  // Look up by the sender's captured channel, not by the current page. A late
  // message from page A must never be reinterpreted as diagram 0 on page B.
  const channel = [...inlineWhiteboardChannels.values()].find(
    (candidate) => candidate.window === event.source && candidate.channelId === message.channelId,
  );
  if (!channel || !channel.active || channel.context.index !== index) return;
  handleAuthenticatedWhiteboardMessage(channel.context, message, "inline");
}

function handleOverlayWhiteboardMessage(event, message) {
  if (event.source !== whiteboardFrame.contentWindow || overlayIndex === null || !overlayContext) return;
  const index = validWhiteboardIndex(message.diagramIndex);
  if (index === null || index !== overlayIndex) return;
  const context = overlayContext;
  if (message.type === "lavish-whiteboard:ready") {
    if (overlayFrameReady || overlayChannelId) return;
    const channelId = String(message.channelToken || "");
    if (!channelId) return;
    overlayChannelId = channelId;
    context.channelId = channelId;
    authenticateWhiteboardChannel(channelId, context).then(async (authenticated) => {
      const isCurrent = () =>
        overlayIndex === index &&
        overlayContext === context &&
        overlayChannelId === channelId &&
        event.source === whiteboardFrame.contentWindow &&
        whiteboardContextIsLive(context);
      if (!authenticated) {
        if (isCurrent()) overlayChannelId = "";
        return;
      }
      if (!isCurrent()) return;
      const initialized = await handleWhiteboardReady(context, "overlay", isCurrent);
      if (initialized && isCurrent()) overlayFrameReady = true;
    });
    return;
  }
  if (!overlayFrameReady || message.channelId !== overlayChannelId) return;
  handleAuthenticatedWhiteboardMessage(context, message, "overlay");
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
    // `replaceArtifactFrame` owns every controlled navigation. Keeping this
    // single path prevents a bootstrap assignment to the entry from briefly
    // replacing a retained sibling destination (and avoids an intermediate
    // blank/history entry before the fresh generation is ready).
    replaceArtifactFrame().catch(() => {});
  }
}

function reloadArtifact() {
  closeMenus();
  resetFrame().then((reloaded) => {
    if (reloaded) refreshWhiteboardSource();
  });
}

async function reloadAfterServerRestart(reason) {
  if (chromeRestartReloadPromise) return chromeRestartReloadPromise;
  chromeRestartReloadPromise = reloadChromeAfterServerRestart(reason);
  return chromeRestartReloadPromise;
}

// Three outcomes, not two: a port that accepts a connection and then says nothing proves neither
// that the server is running nor that it is gone, and a probe that never settles would leave the
// control the user is holding disabled for as long as the browser's own network timeout takes.
async function probeChromeHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch("/health", { cache: "no-store", signal: controller.signal });
    return res.ok ? "running" : "not-running";
  } catch {
    return controller.signal.aborted ? "no-answer" : "not-running";
  } finally {
    clearTimeout(timer);
  }
}

// The replacement server usually binds within a second, but it is a fresh node process competing
// with whatever else the machine is doing, and several `lavish-axi` invocations can be racing for
// the same port. Reloading on a fixed short deadline regardless of whether anything is listening
// trades a recoverable page for the browser's connection-error page, which no Lavish code can
// recover from. So wait for the port to answer, and if it never does, say so instead.
async function reloadChromeAfterServerRestart(reason = "") {
  let sawOutage = false;
  let healthy = false;
  let settled = false;
  // Keep the pre-outage behavior: a server that never actually went away is reloaded promptly.
  const settleDeadline = Date.now() + CHROME_RESTART_SETTLE_MS;
  const deadline = Date.now() + CHROME_RESTART_WAIT_MS;

  while (Date.now() < deadline) {
    // The bounded probe is what keeps this loop honest: a port that accepts and then says nothing
    // would otherwise hold one iteration open past the deadline, and neither the reload nor the
    // card below would ever happen.
    const outcome = await probeChromeHealth();
    healthy = outcome === "running";
    if (!healthy) sawOutage = true;
    if (healthy && (sawOutage || Date.now() >= settleDeadline)) {
      settled = true;
      break;
    }

    const probeDelay = Date.now() < settleDeadline ? CHROME_RESTART_PROBE_MS : CHROME_RESTART_SLOW_PROBE_MS;
    await new Promise((resolve) => setTimeout(resolve, probeDelay));
  }

  // A loop that ended on the deadline carries whatever the last probe happened to see, and in a
  // hidden tab the browser clamps these timers to seconds or minutes - so a single probe can be
  // the only one that ran. Neither answer may be trusted then: a stale failure claims a running
  // server is gone, and a stale success reloads into a port nothing is listening on.
  if (!settled) healthy = (await probeChromeHealth()) === "running";

  if (!healthy) {
    chromeRestartReloadPromise = null;
    setLayoutGateFailure(
      "Lavish is not running.",
      "The Lavish server restarted and did not come back. Start it again with your agent, then check and reload this page.",
      "Check and reload",
      checkServerThenReload(
        "Lavish is not running.",
        "Lavish is still not running. Start it again with your agent, then use Check and reload.",
      ),
      { sticky: true },
    );
    return;
  }

  // Unsent annotation text is the user's writing. A reload replays it, but it is still their
  // call when to interrupt the card they are typing into, so offer the reload instead of taking
  // it. The same applies to a page the user is only reading: the banner never reloads by itself.
  if (hasUnsentDraft()) {
    chromeRestartReloadPromise = null;
    // The line this page shows comes from the same reason its siblings were sent. An event that
    // named none leaves the branch that claims neither.
    setChromeOutdated(true, reason);
    return;
  }

  await flushWhiteboardsBeforeChromeReload();
  location.reload();
}

// The banner is shown at the moment a server goes away, and in the deliberate-stop case nothing
// is coming to replace it, so this button probes before it navigates for the same reason the
// not-running card does: a reload into a dead port lands on the browser's own error page.
async function reloadChromeForOutdatedBanner() {
  if (outdatedReloadInFlight) return;
  outdatedReloadInFlight = true;
  if (outdatedReloadButton) outdatedReloadButton.disabled = true;
  // The banner this click was made on: a later one carries a newer reason, and that line stands.
  const generation = chromeOutdatedGeneration;
  let outcome = "not-running";
  let navigating = false;
  try {
    outcome = await probeChromeHealth();
    if (outcome === "running") {
      navigating = true;
      await flushWhiteboardsBeforeChromeReload();
      location.reload();
    }
  } finally {
    if (!navigating) {
      outdatedReloadInFlight = false;
      if (outdatedReloadButton) outdatedReloadButton.disabled = false;
      if (outdatedText && generation === chromeOutdatedGeneration) {
        outdatedText.textContent =
          outcome === "no-answer"
            ? HEALTH_NO_ANSWER_COPY
            : "Lavish is still not running. Start it again, then use Check and reload.";
      }
    }
  }
}

function handleArtifactMessage(event, binding = null) {
  if (binding) {
    if (currentArtifactBinding !== binding || (event.target !== binding.port && event.currentTarget !== binding.port))
      return;
  } else if (event.source !== frame.contentWindow) return;

  const msg = event.data || {};
  const messageToken = String(msg.artifact_load_token || (binding ? binding.token : ""));
  if (
    (binding &&
      (msg.document_id !== binding.documentId ||
        Number(msg.document_sequence) !== binding.documentSequence ||
        msg.page !== binding.page ||
        msg.page_proof !== binding.proof ||
        messageToken !== binding.token ||
        Number(msg.artifact_revision) !== binding.revision)) ||
    (!binding && messageToken !== artifactLoadToken)
  ) {
    // A pass can be stamped by the load that just lost a token race. Ask the current artifact
    // document to run the audit again instead of consuming the only pass for this cycle.
    if (!binding && msg.type === "lavish:layoutDiagnostics") postToFrame({ type: "lavish:requestLayoutDiagnostics" });
    return;
  }
  const messageSequence = ++artifactMessageSequence;
  artifactSpokeToken = messageToken;
  clearTimeout(artifactSilenceTimer);
  if (binding && typeof msg.destination === "string") {
    const destination = normalizeArtifactDestination(msg.destination, binding.route);
    const changed = binding.destination !== (destination || msg.destination);
    binding.destination = destination || msg.destination;
    artifactLoadDestination = binding.destination;
    persistDestinationRecord(destinationRecord(binding));
    if (changed && destination) refreshHistoricalDestination(binding);
  }
  if (msg.type === "lavish:documentDeparting") {
    // A child navigation may land on a non-reviewable page (or nowhere at all).
    // Do not let the last accepted page masquerade as current on a later
    // whole-chrome reload. `beforeunload` sets the teardown guard first when
    // the top-level reviewer itself is being refreshed.
    markDestinationUnavailable();
    retireArtifactBinding();
    return;
  }
  if (msg.type === "lavish:layoutDiagnostics") {
    const diagnosticSequence = ++layoutDiagnosticSequence;
    const complete = msg.complete !== false;
    // The gate is visual, so the client-side settled pass is the release signal. Reporting the
    // pass is deliberately fire-and-forget: a server restart or a diagnostics 4xx/5xx must not
    // hold a rendered artifact hostage to a network round-trip.
    if (complete) handleLayoutGatePass();
    submitLayoutDiagnostics({
      complete,
      targetPresenceComplete: msg.target_presence_complete === true,
      artifactRevision: msg.artifact_revision,
      artifactLoadToken: msg.artifact_load_token,
      artifactPassSequence: msg.artifact_pass_sequence,
      documentSequence: binding?.documentSequence || 0,
      page: binding?.page ?? null,
      pageProof: binding?.proof || "",
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
      })
      .catch(() => {
        // A failed report is still a completed client-side pass. Keep this fallback explicit so a
        // future change cannot accidentally make the network request the gate's release path.
        if (complete && messageToken === artifactLoadToken && diagnosticSequence === layoutDiagnosticSequence) {
          handleLayoutGatePass();
        }
      });
    return;
  }
  // The artifact spoke, so it rendered and ran its SDK - there is nothing fatal to probe for.
  if (msg.type === "lavish:queuePrompt") {
    enqueuePrompt(msg.prompt, null, binding || currentArtifactBinding);
    // Queued from inside the artifact, where the closed dock is the only sign it landed.
    pulseSheetDock();
  }
  if (msg.type === "lavish:snapshot") {
    completeSnapshotRequest(
      msg.snapshot_request_id,
      msg.snapshot || "",
      binding
        ? {
            version: binding.version,
            page: binding.page,
            proof: binding.proof,
            route: binding.route,
            destination: binding.destination,
            documentId: binding.documentId,
            documentSequence: binding.documentSequence,
            token: binding.token,
            revision: binding.revision,
          }
        : null,
    );
  }
  if (msg.type === "lavish:scroll") {
    setScrollPosition(Number(msg.x) || 0, Number(msg.y) || 0, binding ? binding.page : undefined);
  }
  if (msg.type === "lavish:reviewState") {
    setReviewState(msg.state && typeof msg.state === "object" ? msg.state : null, binding ? binding.page : undefined);
  }
  if (msg.type === "lavish:reviewDraftUnrestorable") {
    discardUnrestorableDraft(String(msg.selector || ""), binding ? binding.page : undefined);
  }
  if (msg.type === "lavish:artifactAssetFailure") {
    reportArtifactFailures(
      [{ kind: "artifact-asset-unavailable", detail: String(msg.detail || "a local artifact asset failed to load") }],
      {
        loadToken: messageToken,
        revision: binding?.revision ?? artifactLoadRevision,
        binding,
      },
    ).catch(() => {});
  }
  if (msg.type === "lavish:uploadAttachment") {
    // Keep the result on the document that supplied the bytes.  The upload may
    // outlive navigation, so the generic postToFrame path is unsafe here.
    uploadAttachment(msg, binding ? (result) => postToBindingFrame(binding, result) : postToFrame);
  }
  // There is deliberately no attachment-delete message. See removeAttachment's
  // removal note below: the iframe cannot be trusted to decide a delete, and the
  // chrome cannot see every live reference, so reclamation is the sweeper's job.
  if (msg.type === "lavish:sendQueuedPrompts") sendQueued();
  if (msg.type === "lavish:endSession") endSession();
  if (msg.type === "lavish:revisions") applyRevisionMessage(msg);
  if (msg.type === "lavish:toggleAnnotationMode") toggleAnnotationMode();
}

// Protocol-1 documents answer a challenge only when it carries the server's MAC over their own
// nonce, so the chrome fetches it (same-origin, current generation) before challenging. Only
// successes are cached: the document re-announces readiness, which retries a failed fetch.
const chromeAuthRequests = new Map();
function requestChromeAuth(nonce) {
  const cacheKey = String(artifactLoadToken || "") + "\n" + nonce;
  const cached = chromeAuthRequests.get(cacheKey);
  if (cached) return cached;
  if (chromeAuthRequests.size >= 32) chromeAuthRequests.clear();
  const request = fetch("/api/" + key + "/artifact-bindings/chrome-auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      artifact_load_token: String(artifactLoadToken || ""),
      artifact_revision: Number(artifactLoadRevision),
      document_nonce: nonce,
    }),
  })
    .then(async (response) => {
      const body = response.ok ? await response.json().catch(() => ({})) : {};
      return typeof body?.chrome_auth === "string" ? body.chrome_auth : "";
    })
    .catch(() => "")
    .then((auth) => {
      if (!auth && chromeAuthRequests.get(cacheKey) === request) chromeAuthRequests.delete(cacheKey);
      return auth;
    });
  chromeAuthRequests.set(cacheKey, request);
  return request;
}

function challengeArtifactDocument(expectedDocumentId = "", chromeAuth = "") {
  if (!modernArtifactProtocol || !frame.contentWindow) return;
  if (
    currentArtifactBinding &&
    (!expectedDocumentId || currentArtifactBinding.documentId === String(expectedDocumentId))
  )
    return;
  const documentId = String(expectedDocumentId || "");
  if (artifactChallengeAttempt) {
    if (!documentId || artifactChallengeAttempt.documentId === documentId) return;
    clearTimeout(artifactChallengeAttempt.timeout);
    artifactChallengeAttempt.port.close();
    artifactChallengeAttempt = null;
  }
  const source = frame.contentWindow;
  const channel = new MessageChannel();
  const challenge = randomBindingChallenge();
  let answered = false;
  let expired = false;
  const timeout = setTimeout(() => {
    if (!answered) {
      expired = true;
      if (artifactChallengeAttempt === attempt) artifactChallengeAttempt = null;
      channel.port1.close();
    }
  }, 5000);
  const attempt = { documentId, port: channel.port1, timeout };
  artifactChallengeAttempt = attempt;
  channel.port1.addEventListener("message", async (event) => {
    if (answered || (event.target !== channel.port1 && event.currentTarget !== channel.port1)) return;
    const message = event.data || {};
    if (
      message.type !== "lavish:challengeResponse" ||
      message.challenge !== challenge ||
      (expectedDocumentId && message.document_id !== String(expectedDocumentId)) ||
      typeof message.document_id !== "string" ||
      !message.document_id ||
      message.page_protocol !== 1 ||
      typeof message.page !== "string" ||
      typeof message.page_proof !== "string"
    )
      return;
    let validation;
    try {
      validation = await fetch("/api/" + key + "/artifact-bindings/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          page: message.page,
          page_proof: message.page_proof,
          served_route: String(message.served_route || ""),
          artifact_load_token: String(message.artifact_load_token || ""),
          artifact_revision: Number(message.artifact_revision),
          document_id: message.document_id,
          destination: destinationPayload({
            page: message.page,
            proof: message.page_proof,
            route: String(message.served_route || ""),
            destination: normalizeArtifactDestination(message.destination, String(message.served_route || "")),
          }),
        }),
      });
    } catch {
      return;
    }
    if (!validation.ok) {
      const rejected = await validation.json().catch(() => ({}));
      if (
        rejected?.status === "stale" &&
        !answered &&
        !expired &&
        artifactChallengeAttempt === attempt &&
        (!latestReadyDocumentId || message.document_id === latestReadyDocumentId) &&
        !ended
      ) {
        answered = true;
        artifactChallengeAttempt = null;
        clearTimeout(timeout);
        channel.port1.close();
        const destination = normalizeArtifactDestination(message.destination, String(message.served_route || ""));
        const historicalPage = historicalDestinations.get(historyDestinationKey(message.document_id, destination));
        if (historicalPage && historicalPage.page === message.page && historicalPage.page_proof === message.page_proof)
          replaceArtifactFrame({ historicalPage }).catch(() => {});
      }
      return;
    }
    const validated = typeof validation.json === "function" ? await validation.json().catch(() => ({})) : {};
    // A retired challenge cannot activate a document, but a successfully signed
    // response still belongs to its exact historical document/destination.
    rememberHistoricalDestination(
      message.document_id,
      destinationPayload({
        page: message.page,
        proof: message.page_proof,
        route: String(message.served_route || ""),
        destination: normalizeArtifactDestination(message.destination, String(message.served_route || "")),
      }),
      validated.receipt,
    );
    if (answered || expired) return;
    if (
      artifactChallengeAttempt !== attempt ||
      String(message.artifact_load_token || "") !== String(artifactLoadToken || "") ||
      Number(message.artifact_revision) !== Number(artifactLoadRevision) ||
      (latestReadyDocumentId && message.document_id !== latestReadyDocumentId) ||
      ended
    ) {
      if (artifactChallengeAttempt === attempt) artifactChallengeAttempt = null;
      clearTimeout(timeout);
      channel.port1.close();
      return;
    }
    answered = true;
    artifactChallengeAttempt = null;
    clearTimeout(timeout);
    const binding = {
      port: channel.port1,
      page: message.page,
      proof: message.page_proof,
      route: String(message.served_route || ""),
      // Newer SDKs may echo the authored URL they observed. Older protocol-1
      // documents only expose the accepted served route; in that case the
      // helper falls back to the route without inventing a query or fragment.
      destination: normalizeArtifactDestination(
        message.destination || message.authored_destination || message.url,
        String(message.served_route || ""),
      ),
      documentId: String(message.document_id),
      documentSequence: ++nextDocumentSequence,
      token: String(message.artifact_load_token || ""),
      revision: Number(message.artifact_revision),
      version: ++nextBindingVersion,
      window: source,
    };
    retireArtifactBinding();
    pendingArtifactFailureBinding = null;
    currentArtifactBinding = binding;
    stampLegacyQueuedPrompts(binding);
    activatePageReviewState(binding.page);
    activateComposerPage(binding.page);
    // A pre-upgrade/restored terminal reservation must not lock the controls
    // needed to deliver another page's retained work.
    if (terminalSubmission && !terminalSubmission.inFlight) {
      blockTerminalForOtherPages(terminalSubmission.page, terminalSubmission);
    }
    render();
    renderWarnings();
    const destination = bindingDestination(binding);
    binding.destination = destination;
    rememberHistoricalDestination(
      binding.documentId,
      destinationPayload(destinationRecord(binding)),
      validated.receipt,
    );
    artifactLoadDestination = destination;
    persistDestinationRecord(destinationRecord(binding));
    channel.port1.addEventListener("message", (boundEvent) => handleArtifactMessage(boundEvent, binding));
    channel.port1.start?.();
    channel.port1.postMessage({ type: "lavish:activate", ...bindingTuple(binding) });
    artifactSpokeToken = binding.token;
    clearTimeout(artifactSilenceTimer);
    // The initial load handler may have run before the SDK announced readiness.
    // Release the retained chrome state only after the accepted binding exists.
    postToFrame({ type: "lavish:setAnnotationMode", enabled: annotation && !ended });
    postToFrame({ type: "lavish:restoreScroll", x: lastScroll.x, y: lastScroll.y });
    if (lastReviewState) postToFrame({ type: "lavish:restoreReviewState", state: lastReviewState });
  });
  channel.port1.start?.();
  // Node's MessageChannel (used by the deterministic client harness) keeps the
  // process alive unless both endpoints are unreferenced. Browsers do not
  // expose `unref`, so these calls are inert in production.
  /** @type {any} */ (channel.port1).unref?.();
  /** @type {any} */ (channel.port2).unref?.();
  source.postMessage({ type: "lavish:challenge", challenge, ...(chromeAuth ? { chrome_auth: chromeAuth } : {}) }, "*", [
    channel.port2,
  ]);
}

if (modernArtifactProtocol) {
  // The global channel is readiness-only.  All review traffic is accepted on
  // the transferred port after the challenge and tuple checks above.
  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return;
    const message = event.data || {};
    if (message.type !== "lavish:ready" || message.page_protocol !== 1) return;
    const previousDocumentId = latestReadyDocumentId;
    latestReadyDocumentId = String(message.document_id || "");
    const documentId = latestReadyDocumentId;
    const nonce = typeof message.document_nonce === "string" ? message.document_nonce : "";
    if (documentId && documentId !== previousDocumentId) pendingReadyLoadDocumentId = documentId;
    if (!nonce) {
      challengeArtifactDocument(documentId);
      return;
    }
    requestChromeAuth(nonce).then((chromeAuth) => {
      if (!chromeAuth || latestReadyDocumentId !== documentId || ended) return;
      challengeArtifactDocument(documentId, chromeAuth);
    });
  });
} else {
  window.addEventListener("message", (event) => handleArtifactMessage(event));
}

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
  if (ended || terminalSubmission) return;
  annotation = !annotation;
  annotationSwitch.setAttribute("aria-pressed", String(annotation));
  postToFrame({ type: "lavish:setAnnotationMode", enabled: annotation });
}

annotationSwitch.onclick = toggleAnnotationMode;

sendButton.onclick = () => sendQueued(false);
sendAndEndButton.onclick = () => sendQueued(true);
moreButton.onclick = () => {
  closeWarningsDrawer();
  closeRevisionsDrawer();
  toggleMenu(moreButton, moreMenu);
};
warningsButton.onclick = toggleWarningsDrawer;
revisionsButton.onclick = () => {
  closeWarningsDrawer();
  setRevisionsDrawerOpen(revisionsDrawer.hidden);
};
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
// the session (losing chips, uploads, and the live-event connection). Text drags stay
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
chatInput.addEventListener("input", () => {
  persistComposerDraft();
  hideSendHint();
});
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
copySharePasswordButton.onclick = () =>
  copyToButton(sharePasswordOutput.value, copySharePasswordButton, "Copy password");
copyShareSiteIdButton.onclick = () => copyToButton(shareSiteIdInput.value, copyShareSiteIdButton, "Copy site ID");
shareGenerateInput.onchange = syncSharePasswordInput;
endButton.onclick = () => {
  closeMenus();
  endSession();
};
handoffTakeoverButton.onclick = () => location.reload();
if (outdatedReloadButton) outdatedReloadButton.onclick = () => reloadChromeForOutdatedBanner();
if (outdatedDismissButton) {
  outdatedDismissButton.onclick = () => {
    // A dismissed unreachable banner stays dismissed until the stream actually recovers; without
    // this the next failed reconnect puts it straight back on screen.
    if (unreachableBannerOwned) {
      unreachableBannerOwned = false;
      unreachableDismissed = true;
    }
    setChromeOutdated(false);
  };
}
document.addEventListener("mousedown", (event) => {
  const target = /** @type {Node} */ (event.target);
  if (!moreMenu.hidden && !moreWrap.contains(target)) setMenuOpen(moreButton, moreMenu, false);
  if (warningsDrawerOpen && !warningsWrap.contains(target)) closeWarningsDrawer();
  if (revisionsDrawerOpen && !revisionsWrap.contains(target)) closeRevisionsDrawer();
});
// A non-modal popover closes when focus leaves it, so keyboard users are never stranded inside a
// panel they cannot see the end of.
warningsWrap.addEventListener("focusout", (event) => {
  const next = /** @type {Node | null} */ (event.relatedTarget);
  if (warningsDrawerOpen && next && !warningsWrap.contains(next)) closeWarningsDrawer();
});
revisionsWrap.addEventListener("focusout", (event) => {
  const next = /** @type {Node | null} */ (event.relatedTarget);
  if (revisionsDrawerOpen && next && !revisionsWrap.contains(next)) closeRevisionsDrawer();
});
whiteboardCloseButton.onclick = closeWhiteboard;
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!whiteboardOverlay.hidden) {
      closeWhiteboard();
    } else if (!shareDialog.hidden) {
      closeShareDialog();
    } else if (revisionsDrawerOpen) {
      closeRevisionsDrawer({ restoreFocus: true });
    } else if (warningsDrawerOpen) {
      closeWarningsDrawer({ restoreFocus: true });
    } else if (!moreMenu.hidden) {
      closeMenus();
    } else if (sheetOpen && isMobileSheet()) {
      setSheetOpen(false);
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
  if (modernArtifactProtocol && !currentArtifactBinding) {
    const announcedDocumentLoaded = pendingReadyLoadDocumentId && pendingReadyLoadDocumentId === latestReadyDocumentId;
    pendingReadyLoadDocumentId = "";
    if (!announcedDocumentLoaded) {
      latestReadyDocumentId = "";
      if (artifactChallengeAttempt) {
        clearTimeout(artifactChallengeAttempt.timeout);
        artifactChallengeAttempt.port.close();
        artifactChallengeAttempt = null;
      }
      challengeArtifactDocument();
    }
  }
  if (artifactSpokeToken !== artifactLoadToken) armArtifactAvailabilityProbe(artifactLoadToken);
  postToFrame({ type: "lavish:setAnnotationMode", enabled: annotation && !ended });
  // Replay the pre-reload scroll position so hot reloads don't jump the artifact to the top.
  postToFrame({ type: "lavish:restoreScroll", x: lastScroll.x, y: lastScroll.y });
  if (lastReviewState) postToFrame({ type: "lavish:restoreReviewState", state: lastReviewState });
  if (overlayContext && overlayIndex !== null && whiteboardContextIsLive(overlayContext)) {
    inlineWhiteboardChannels.delete(overlayContext.key);
    postToFrame({ type: "lavish:suspendWhiteboard", diagramIndex: overlayIndex, page: overlayContext.page });
  }
});

if (modernArtifactProtocol) {
  // A top-level reload tears down the child iframe too. Snapshot the already
  // validated destination first so the child's pagehide message cannot erase
  // it before the next chrome bootstrap can restore it. This is deliberately
  // not a beforeunload prompt: it only records state and never sets
  // `returnValue` or calls preventDefault().
  window.addEventListener("beforeunload", () => {
    pendingArtifactFailureBinding = null;
    const record = destinationRecord(currentArtifactBinding);
    if (!record) return;
    topLevelTeardown = true;
    persistDestinationRecord(record);
  });
}

initializeLayoutGate();

// WebSockets leave the browser's HTTP connection pool free for sends and artifact loads.
const events = new Map();
let eventReconnectDelayMs = 500;
function connectLiveEvents() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(protocol + "//" + location.host + "/events/" + encodeURIComponent(key));
  socket.addEventListener("open", () => {
    eventReconnectDelayMs = 500;
    liveEventFailures = 0;
    unreachableDismissed = false;
    if (unreachableBannerOwned) {
      unreachableBannerOwned = false;
      setChromeOutdated(false);
    }
    refreshLayoutWarnings();
  });
  socket.addEventListener("message", (message) => {
    try {
      const { type, data } = JSON.parse(message.data);
      return events.get(type)?.(data || {});
    } catch {
      // Ignore malformed frames; a later event or reconnect can recover the stream.
    }
  });
  socket.addEventListener("close", () => {
    liveEventFailures += 1;
    noteLiveEventsUnreachable();
    setTimeout(connectLiveEvents, eventReconnectDelayMs);
    eventReconnectDelayMs = Math.min(eventReconnectDelayMs * 2, 5000);
  });
}

// Raise the existing banner once the stream has been down long enough to mean it, and never
// against an ended session or a banner someone else owns. Reconnecting retires it.
function noteLiveEventsUnreachable() {
  if (liveEventFailures < LIVE_EVENT_UNREACHABLE_FAILURES) return;
  if (ended || unreachableDismissed || unreachableBannerOwned) return;
  if (outdatedBanner && !outdatedBanner.hidden) return;
  unreachableBannerOwned = true;
  setChromeOutdated(true, "");
}

events.set("reload", () => {
  resetFrame().then((reloaded) => {
    if (reloaded) refreshWhiteboardSource();
  });
});
events.set("chrome-reload", (data) => reloadAfterServerRestart(String(data.reason || "")));
// The replacement server serves a different artifact's review. This page keeps working against
// it; it is only running the previous version of the chrome, which is the user's to act on.
events.set("chrome-outdated", (data) => setChromeOutdated(true, String(data.reason || "")));
events.set("agent-reply", (data) => {
  const entry = {
    ...data,
    role: "agent",
    text: String(data.text || ""),
    ...(data.at ? { at: String(data.at) } : {}),
  };
  if (addChat(entry)) displayedChat.push(entry);
  noteAgentReply(entry.text);
});
events.set("chat-sync", (data) => {
  rememberChatAckIds(data.ack_ids);
  syncChat(data.chat || [], data.chat_revision);
});
events.set("agent-presence", (data) => setAgentPresence(data.mode === "external-listener" ? "external" : data.state));
events.set("layout-warnings", (data) => setLayoutWarnings(data.warnings || []));
events.set("ended", () => markSessionEnded());
connectLiveEvents();

applySheetState();
settleQueuedFromTranscript(initialChat, false);
render();
setChromeOutdated(false);
setWarningsDrawerOpen(false);
renderWarnings();
initialChat.forEach((item) => addChat(item));
retiredDrafts.forEach((entry) => renderRetiredDraft(entry));
setAgentPresence("waiting");
// The session already ended before this page (re)loaded, so there is no future live `ended` event
// to wait for - start read-only instead of looking live until a Send gets silently refused.
if (sessionData.initialEnded) markSessionEnded();

// Reaching this line is the only proof that this file parsed and ran to completion. The inline
// bootstrap already owns the gate's bounded escape if this script fails; retire only its separate
// boot-failure timer now that the full client has taken over.
const chromeBootWindow = /** @type {Record<string, any>} */ (/** @type {unknown} */ (window));
chromeBootWindow.__lavishChromeReady = true;
chromeBootWindow.__lavishCancelChromeBootFailsafe?.();
