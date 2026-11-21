/* global document, getComputedStyle, location, window */

const sessionDataElement = document.getElementById("lavish-session");
const sessionData = JSON.parse(sessionDataElement?.textContent || "{}");
const key = String(sessionData.key || "");
const filePath = String(sessionData.file || "");
const queueStorageKey = "lavish-axi:queued:" + key;
const terminalStorageKey = "lavish-axi:terminal:" + key;
// Review-chrome state that must survive a browser refresh. Keyed per session so one review's
// triage can never leak into another artifact's.
const warningSelectionStorageKey = "lavish-axi:warning-selection:" + key;
// Unsent annotation-card text lives only in the sandboxed iframe, so a full page reload would
// destroy it unless the chrome persists what the SDK reports. Keyed per session like the queue,
// so a draft can never reappear over a different artifact.
const reviewStateStorageKey = "lavish-axi:review-state:" + key;
// Drafts Hilight could not replay. The text outlives the draft that carried it, so the user can
// still read and copy it after the anchor it was written against is gone for good.
const retiredDraftStorageKey = "lavish-axi:retired-drafts:" + key;
const internalQueueKeyField = "_lavishQueueKey";
const promptIdentityField = "prompt_id";
const PROMPT_IDENTITY_MAX = 128;
const PROMPT_IDENTITY_RE = /^[A-Za-z0-9_-]+$/;
let commentThreads = Array.isArray(sessionData.initialThreads) ? sessionData.initialThreads : [];
let threadSyncRevision = Number(sessionData.initialChatRevision) || 0;
const threadGeometry = new Map();
const threadDraftStorageKey = "lavish-axi:thread-drafts:" + key;
const threadDrafts = new Map(Object.entries(loadJsonState(threadDraftStorageKey, {})));
let activeThreadId = "";
let openThreadId = "";
// The whole-page thread: notes not tied to an element and agent replies outside any `## c<n>`
// section. It is the transcript minus the anchored threads, so it needs no server-side record.
const PAGE_THREAD_ID = "page";
const THREAD_CARD_GAP = 8;
// A resting card shows its root comment and its latest reply; the middle folds behind a count.
const THREAD_COLLAPSE_AFTER = 2;
// A compact card is one header line. chrome.css pins `.comment-thread.is-compact` to this height,
// so placement never has to measure one.
const THREAD_COMPACT_HEIGHT = 34;
const NON_THREAD_TAGS = new Set(["message", "whiteboard", "board", "layout-warnings"]);
const threadCardCache = new Map();
// Measured resting heights by thread id. Placement runs on every artifact scroll frame, so it
// reads only these and the open card; a rebuilt card or a resize clears its entry.
/** @type {Map<string, number>} */
const threadHeights = new Map();
let pageBarHeight = 0;
let lastThreadAnchors = "[]";
let pageSignature = "";
let resolvedDrawerOpen = false;
// Since when and why nobody is listening, as the server last reported it (null when unknown).
/** @type {{ since: string, why: string } | null} */
let agentStopped = null;
let activityDrawerOpen = false;
let activityRequest = 0;
// Canvas mode (see renderBoardHeader).
const boardTitle = document.getElementById("boardTitle");
const boardInfoWrap = document.getElementById("boardInfoWrap");
const boardInfoButton = document.getElementById("boardInfoButton");
const boardInfo = document.getElementById("boardInfo");
const boardInfoText = document.getElementById("boardInfoText");
const boardHealthSection = document.getElementById("boardHealth");
const boardHealthText = document.getElementById("boardHealthText");
const boardHealthShow = document.getElementById("boardHealthShow");
const boardProblems = document.getElementById("boardProblems");
const boardMarks = /** @type {HTMLFormElement | null} */ (document.getElementById("boardMarks"));
const boardNote = /** @type {HTMLInputElement | null} */ (document.getElementById("boardNote"));
const boardQueue = /** @type {HTMLButtonElement | null} */ (document.getElementById("boardQueue"));
const BOARD_QUEUE_TIMEOUT_MS = 20000;
/** @type {{ text: string, detail: string, warn: boolean, drifted: string, problems: string[] }} */
let boardHealth = { text: "", detail: "", warn: false, drifted: "", problems: [] };
let boardQueueTimer = 0;
let threadCounts = { resolved: 0, offPage: 0 };
let resolveToastTimer;
let resolveToastThreadId = "";
const RESOLVE_TOAST_MS = 6000;
const pageDraftStorageKey = "lavish-axi:page-draft:" + key;
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
const chatInput = /** @type {HTMLTextAreaElement} */ (document.getElementById("chatInput"));
const chatAttachments = /** @type {HTMLDivElement} */ (document.getElementById("chatAttachments"));
const chatAttachButton = /** @type {HTMLButtonElement} */ (document.getElementById("chatAttach"));
const chatAttachInput = /** @type {HTMLInputElement} */ (document.getElementById("chatAttachInput"));
const chatAttachmentNotice = /** @type {HTMLSpanElement} */ (document.getElementById("chatAttachmentNotice"));
const comments = /** @type {HTMLElement} */ (document.getElementById("comments"));
const commentsBody = /** @type {HTMLDivElement} */ (document.getElementById("commentsBody"));
const commentsFoot = /** @type {HTMLDivElement} */ (document.getElementById("commentsFoot"));
const sheetHead = /** @type {HTMLDivElement} */ (document.getElementById("sheetHead"));
const sheetSummaryText = /** @type {HTMLSpanElement} */ (document.getElementById("sheetSummary"));
const sheetToggle = /** @type {HTMLButtonElement} */ (document.getElementById("sheetToggle"));
const sheetScrim = /** @type {HTMLDivElement} */ (document.getElementById("sheetScrim"));
const pageThread = /** @type {HTMLElement} */ (document.getElementById("pageThread"));
const pageMessages = /** @type {HTMLOListElement} */ (document.getElementById("pageMessages"));
const pageThreadStatus = /** @type {HTMLSpanElement} */ (document.getElementById("pageThreadStatus"));
const pageThreadTime = /** @type {HTMLTimeElement | null} */ (document.getElementById("pageThreadTime"));
const activityOpenButton = /** @type {HTMLButtonElement | null} */ (document.getElementById("activityOpen"));
const activityDrawer = /** @type {HTMLDivElement | null} */ (document.getElementById("activityDrawer"));
const activityNow = /** @type {HTMLParagraphElement | null} */ (document.getElementById("activityNow"));
const activityList = /** @type {HTMLOListElement | null} */ (document.getElementById("activityList"));
const agentStatus = /** @type {HTMLSpanElement} */ (document.getElementById("agentStatus"));
const resolvedWrap = /** @type {HTMLDivElement} */ (document.getElementById("resolvedWrap"));
const resolvedButton = /** @type {HTMLButtonElement} */ (document.getElementById("resolvedButton"));
const resolvedCount = /** @type {HTMLSpanElement} */ (document.getElementById("resolvedCount"));
const resolvedDrawer = /** @type {HTMLDivElement} */ (document.getElementById("resolvedDrawer"));
const resolvedList = /** @type {HTMLDivElement} */ (document.getElementById("resolvedList"));
const resolveToast = /** @type {HTMLDivElement} */ (document.getElementById("resolveToast"));
const resolveToastText = /** @type {HTMLSpanElement} */ (document.getElementById("resolveToastText"));
const resolveUndoButton = /** @type {HTMLButtonElement} */ (document.getElementById("resolveUndo"));
const attachImagesButton = /** @type {HTMLButtonElement} */ (document.getElementById("attachImages"));
const sendButton = /** @type {HTMLButtonElement} */ (document.getElementById("send"));
const sendAndEndButton = /** @type {HTMLButtonElement} */ (document.getElementById("sendAndEnd"));
const annotationSwitch = /** @type {HTMLButtonElement} */ (document.getElementById("annotation"));
const commentsToggle = /** @type {HTMLButtonElement | null} */ (document.getElementById("commentsToggle"));
const commentsToggleCount = document.getElementById("commentsToggleCount");
// Desktop only: the reviewer can fold the comments margin away so the artifact
// (a board canvas especially) gets the full width. Remembered per session.
const commentsCollapsedKey = "lavish-axi:comments-collapsed:" + key;
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
const sendHint = /** @type {HTMLDivElement} */ (document.getElementById("sendHint"));
const whiteboardOverlay = /** @type {HTMLDivElement} */ (document.getElementById("whiteboardOverlay"));
const whiteboardFrame = /** @type {HTMLIFrameElement} */ (document.getElementById("whiteboardFrame"));
const whiteboardCloseButton = /** @type {HTMLButtonElement} */ (document.getElementById("whiteboardClose"));
const whiteboardError = /** @type {HTMLDivElement} */ (document.getElementById("whiteboardError"));
const artifactSrc = frame.dataset.artifactSrc || frame.getAttribute?.("data-artifact-src") || frame.src || "";

const queued = loadQueuedPrompts();
let annotation = true;
// Page defaults follow artifact loads until the reviewer explicitly chooses a mode.
let annotationOverridden = false;
let annotationDefaultReceived = false;
let ended = false;
let agentPresence = "waiting";
const layoutGateEnabled = sessionData.layoutGateEnabled !== false;
const configuredLayoutGateMaxHoldMs = Number(sessionData.layoutGateMaxHoldMs);
const layoutGateMaxHoldMs =
  Number.isFinite(configuredLayoutGateMaxHoldMs) && configuredLayoutGateMaxHoldMs > 0
    ? Math.min(configuredLayoutGateMaxHoldMs, 60_000)
    : 12_000;
// The plain checking gate gets a much shorter hold than a failure card (CHROME_LAYOUT_GATE_CHECK_MS).
const configuredLayoutGateCheckMs = Number(sessionData.layoutGateCheckMs);
const layoutGateCheckMs =
  Number.isFinite(configuredLayoutGateCheckMs) && configuredLayoutGateCheckMs > 0
    ? Math.min(configuredLayoutGateCheckMs, layoutGateMaxHoldMs)
    : layoutGateMaxHoldMs;
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
/** @typedef {{ done: Promise<boolean>, finish: (succeeded: boolean) => void }} FeedbackPreparation */
/** @typedef {{ prompts: any[], inFlight: boolean, order: number }} TerminalSubmission */
/** @type {Map<string, { action: "copy" | "submit", prompts?: any[], chatAtRequest?: any[], endAfter?: boolean, terminal?: TerminalSubmission | null, acknowledgement?: object, order?: number, timeout?: ReturnType<typeof setTimeout> }>} */
const snapshotRequests = new Map();
let nextSnapshotRequestId = 0;
let nextSendOperationOrder = 0;
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
let terminalSubmission =
  loadJsonState(terminalStorageKey, false) === true
    ? { prompts: queued.slice(), inFlight: false, order: ++nextSendOperationOrder }
    : null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let sendAcknowledgementTimer;
let lastScroll = { x: 0, y: 0 };
// The queued note open for editing in the panel, by prompt identity, and its unsaved words.
let editingPromptId = "";
let editingDraft = "";
let editFocusPending = false;
// The selector list last told to the artifact, so a render that changes nothing stays quiet.
let postedQueuedAnchors = "[]";
// In-iframe review context (an open annotation card's unsent text, Hilight-owned question
// answers). The sandbox means the chrome cannot read it back after a reload, so the SDK reports
// it as it changes and the chrome replays it once the new document is up. It is persisted per
// session so a full page reload replays it too.
let lastReviewState = loadJsonState(reviewStateStorageKey, null);
if (lastReviewState && typeof lastReviewState !== "object") lastReviewState = null;
const ARTIFACT_SILENCE_PROBE_MS = 8000;
const ARTIFACT_LOAD_BEGIN_RETRY_DELAYS_MS = [100, 300];
// Backoff for retrying a whole begin-load attempt after its in-call retries ran out. The
// in-call retries span 400ms, which only covers a slow response - not the multi-second window
// where the server is being replaced (a version-driven restart, or another `hilight <file>`
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
  "Still trying to send. Your feedback is saved in this tab. Keep this tab open while Hilight catches up, and check that the server is running.";
const SEND_FAILED_COPY =
  "Could not send. Your comments are still saved in this tab. Check that Hilight is running, then click Send to agent to retry.";
const TERMINAL_SEND_FAILED_COPY =
  "Could not send. Your comments are still saved in this tab. Check that Hilight is running, then choose Send all and end session in the More menu to retry the same batch.";
const HEALTH_NO_ANSWER_TITLE = "Hilight did not answer.";
const HEALTH_NO_ANSWER_COPY =
  "Hilight did not answer the check, so this page cannot tell whether it is running. Try again in a moment.";
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
let sendHintPersistent = false;
/** @type {{ kind: "preparation" | "submission" | "terminal", operation: object, preparationType?: string } | null} */
let sendFailureOwner = null;
let sendAcknowledgementWarningVisible = false;

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
    return true;
  } catch {
    // The in-memory state still works if browser storage is unavailable.
    return false;
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
    return Array.isArray(parsed) ? parsed.map((item) => adoptQueuedPrompt(item, true)).filter(Boolean) : [];
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
    if (reserved) sessionStorage.setItem(terminalStorageKey, "true");
    else sessionStorage.removeItem(terminalStorageKey);
  } catch {
    // Session storage can be unavailable; the in-memory reservation still protects this page.
  }
}

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
  if (tag === "board") {
    return { kind: "whiteboard", label: "board", excerpt: boundAnchorText("Canvas marks", ANCHOR_EXCERPT_MAX) };
  }
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
  if (type === "board-card") {
    return withSelector({
      kind: "element",
      label: "card",
      excerpt: boundAnchorText(target.title || prompt.text, ANCHOR_EXCERPT_MAX),
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

// What a note with images and no words says for itself. A queued prompt keeps its words in
// `prompt` (`text` is the element's excerpt); a transcript entry keeps them in `text`.
function attachmentOnlyText(entry) {
  if (!attachmentCount(entry)) return "";
  return entry.tag === "message" || entry.kind === "message" ? "Image message" : "Image annotation";
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
  const editing = editingPromptId ? queued.find((prompt) => promptIdentity(prompt) === editingPromptId) : null;
  // A note that left the queue or started sending takes its editor with it.
  if (editingPromptId && (!editing || !isPromptEditable(editing))) endQueuedEdit();
  postQueuedAnchors();
  renderThreads();
  updateSendState();
  renderSheetSummary();
}

// How many drafts one press of Send delivers: every queued note plus words still in the page
// comment box, which Send saves first.
function draftCount() {
  return queued.length + (chatInput.value.trim() ? 1 : 0);
}

function updateSendState() {
  const terminalReserved = terminalSubmission !== null;
  // A terminal send owns the exact review batch, so freeze interactions inside the
  // artifact without disabling annotation mode. Disabling annotation mode closes the
  // SDK card and destroys an unsent draft before delivery has actually succeeded.
  frame.inert = ended || terminalReserved;
  const count = draftCount();
  sendButton.textContent = count ? "Send to agent (" + count + ")" : "Send to agent";
  if (commentsToggleCount) {
    commentsToggleCount.textContent = String(count);
    commentsToggleCount.hidden = !(count && document.body.classList.contains("comments-collapsed"));
  }
  sendButton.classList.toggle("has-drafts", count > 0);
  sendButton.disabled = ended || terminalReserved;
  sendAndEndButton.disabled = ended || Boolean(terminalSubmission?.inFlight);
  annotationSwitch.disabled = ended || terminalReserved;
  chatInput.disabled = ended || terminalReserved;
  chatAttachButton.disabled = ended || terminalReserved;
  attachImagesButton.disabled = ended || terminalReserved;
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
// per-prompt cap is configurable (HILIGHT_MAX_ATTACHMENTS_PER_PROMPT), so a note can
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

comments.addEventListener("error", replaceExpiredThumbnail, true);

const UNSENT_OWNERSHIP_COPY =
  "Unsent comments stay in the tab or window where you wrote them; taking over in another window does not bring them along.";
const DEFAULT_SEND_HINT = "Nothing to send yet. " + UNSENT_OWNERSHIP_COPY;
const EMPTY_SEND_HINT_HOLD_MS = 9000;
const EMPTY_END_HINT = "Nothing to send. To end without feedback, use End session in the More menu (⋮).";

const LAYOUT_REQUEST_CONFLICT_COPY =
  "Could not send because the layout issues changed after you queued the layout fix request. Your feedback is still queued. Remove the layout fix request, or open Layout issues and queue the current ones, then send again.";
const LAYOUT_REQUEST_HELD_COPY =
  "Sent. Your layout fix request is still queued because those layout issues changed after you queued it. Remove it, or open Layout issues and queue the current ones.";
const LAYOUT_REQUEST_RETIRED_COPY =
  "Your queued layout fix request was not sent: those issues were already fixed or dismissed.";

function showSendHint(message = DEFAULT_SEND_HINT, holdMs = 2600, focusInput = true) {
  sendHint.textContent = message;
  sendHint.hidden = false;
  clearTimeout(sendHintTimer);
  sendHintPersistent = holdMs === null;
  sendHint.classList.toggle("persistent", sendHintPersistent);
  if (sendHintPersistent) {
    sendHintTimer = undefined;
    if (focusInput && openThreadId === PAGE_THREAD_ID) chatInput.focus();
    return;
  }
  sendHintTimer = setTimeout(() => {
    sendHint.hidden = true;
    sendHint.textContent = DEFAULT_SEND_HINT;
    sendHintPersistent = false;
  }, holdMs);
  if (focusInput && openThreadId === PAGE_THREAD_ID) chatInput.focus();
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

// Delivery state (docs/delivery-acks.md) as one plain word per thread. Seen, Working and Done are
// stamps the server puts on a sent note's transcript entry, so the word is derived from that entry
// on every render and never tracked here. Only the latest state shows.
function deliveryLabel(entry) {
  if (!entry || entry.receipt === "none") return "Sent";
  if (entry.done_at) return "Replied";
  if (entry.working_at) return "Working";
  if (entry.delivered_at) return "Seen";
  return "Sent";
}

// A transcript entry the page thread shows: agent replies outside any `## c<n>` section, and the
// reviewer's own notes that did not open or join a margin thread.
function isPageChatEntry(entry) {
  if (!entry || typeof entry !== "object" || entry.thread_id) return false;
  if (entry.role === "agent") return Boolean(String(entry.text || "") || entry.html);
  return Boolean(String(entry.text || "") || attachmentCount(entry) || entry.anchor);
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
  // The page thread re-renders in place; nothing here moves the reader's scroll position.
  renderThreads();
  return true;
}

// The bar's one-word answer to "will my comments reach the agent?". Every word must be true where
// it is shown: `waiting` is no poll at all, `listening` is a poll that takes a send within
// milliseconds, and `working` or an external listener is an agent whose next poll takes it.
const AGENT_STATUS = {
  waiting: ["Not listening", "No agent is polling this review. Ask your agent to run hilight poll."],
  listening: ["Listening", "Your agent is waiting for comments. Send delivers them right away."],
  working: ["Working", "Your agent is working on what you sent. New comments reach it on its next poll."],
  external: ["Listening", "An external listener holds this review. New comments reach the agent on its next poll."],
};

function setAgentPresence(state) {
  agentPresence = state === "listening" || state === "external" || state === "working" ? state : "waiting";
  updateSendState();
  renderSheetSummary();
  renderAgentStatus();
}

function renderAgentStatus() {
  const [text, title] = ended ? ["Ended", "This review session has ended."] : AGENT_STATUS[agentPresence];
  const stopped = !ended && agentPresence === "waiting" ? agentStopped : null;
  const short = stopped ? shortStopReason(stopped.why) : "";
  agentStatus.textContent = stopped
    ? `Not listening since ${clockTime(stopped.since)}${short ? ` · ${short}` : ""}`
    : text;
  agentStatus.title = stopped ? notListeningSentence(stopped) : title;
  agentStatus.dataset.state = ended ? "ended" : agentPresence;
}

function setHandoffSuperseded(visible) {
  if (handoffBanner) handoffBanner.hidden = ended || !visible;
}

// The server this page was connected to went away. What is true beyond that depends on why, so
// the shutdown names its reason and each one gets its own line - a page told "Hilight was updated"
// after a deliberate stop is being told something false. An unnamed reason (SIGTERM, or any
// caller that names none) claims neither.
function chromeOutdatedCopy(reason) {
  if (reason === "upgrade") return "Hilight was updated. This page is running the previous version.";
  if (reason === "local-build") {
    return "Hilight was restarted to pick up a local build. This page is running the copy the previous server sent.";
  }
  if (reason === "stop") return "Hilight was stopped. Reload after you start it again.";
  return "The Hilight server this page was connected to is no longer running. Reloading will work once it is running again.";
}

// Say so where the user can dismiss it, and never reload on their behalf - a forced reload
// interrupts whatever they were reading or writing.
// "23:05", or "12 Nov 23:05" when it was not today. An unreadable time reads as nothing.
function clockTime(iso) {
  const date = new Date(String(iso || ""));
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

// Two or three words for the status bar; the full reason is in its tooltip and in Activity.
function shortStopReason(why) {
  const text = String(why || "");
  if (/hilight stop/.test(text)) return "server was stopped";
  if (/server stopped/.test(text)) return "server restarted";
  if (/poll disconnected/.test(text)) return "poll closed";
  if (/took over/.test(text)) return "listener replaced";
  if (/timed out/.test(text)) return "poll timed out";
  if (/took your comments/.test(text)) return "took your comments";
  if (/review page was closed/.test(text)) return "page closed";
  return "";
}

function notListeningSentence(stopped) {
  const at = clockTime(stopped.since);
  return `Your agent stopped listening${at ? ` at ${at}` : ""}${stopped.why ? `: ${stopped.why}` : ""}. Comments you send will queue until it polls again.`;
}

function setChromeOutdated(visible, reason = chromeOutdatedReason) {
  chromeOutdatedReason = String(reason || "");
  chromeOutdatedGeneration += 1;
  if (outdatedText) outdatedText.textContent = chromeOutdatedCopy(chromeOutdatedReason);
  outdatedReloadInFlight = false;
  if (outdatedReloadButton) outdatedReloadButton.disabled = false;
  if (outdatedBanner) outdatedBanner.hidden = ended || !visible;
}

function setReviewState(state) {
  lastReviewState = state;
  // The artifact reported a card, so its anchor exists: whatever miss was recorded is answered.
  if (state?.card) unrestorableDraftMiss = null;
  const hasEntries = (list) => Array.isArray(list) && list.length > 0;
  if (!state || (!state.card && !hasEntries(state.fields) && !hasEntries(state.disclosures))) {
    try {
      sessionStorage.removeItem(reviewStateStorageKey);
    } catch {
      // The in-memory state still works if browser storage is unavailable.
    }
    return;
  }
  saveJsonState(reviewStateStorageKey, state);
}

function hasUnsentDraft() {
  if (editingPromptId) return true;
  return Boolean(lastReviewState && lastReviewState.card && String(lastReviewState.card.text || "").trim());
}

// The SDK looked for this draft's anchor in a loaded artifact and did not find it. Retiring a
// draft is itself data loss - the user may still be typing while the agent rewrites the element
// they anchored to - so one miss only records the answer. The draft is retired only when a
// SECOND artifact revision reports the same anchor missing: an element that is merely being
// rewritten comes back, and a report on the revision already recorded is the same answer twice,
// not two answers. Any report for a different draft, or for a draft that is no longer stored,
// leaves the stored text alone.
function discardUnrestorableDraft(selector) {
  if (!selector || !lastReviewState || !lastReviewState.card) return;
  if (String(lastReviewState.card.selector || "") !== selector) return;
  const revision = artifactLoadRevision;
  if (unrestorableDraftMiss?.selector !== selector) {
    unrestorableDraftMiss = { selector, revision };
    return;
  }
  if (unrestorableDraftMiss.revision === revision) return;
  unrestorableDraftMiss = null;
  keepRetiredDraft(String(lastReviewState.card.text || ""));
  setReviewState({ ...lastReviewState, card: null });
}

// Retiring a draft ends Hilight's ability to replay it, so the text itself is handed back to the
// user before it goes: it is written to the conversation panel verbatim, where it is selectable,
// nothing overwrites what they may already be typing, and no control can discard it by accident.
// It is persisted per session so a reload does not take the last copy with it.
function loadRetiredDrafts() {
  const stored = loadJsonState(retiredDraftStorageKey, []);
  if (!Array.isArray(stored)) return [];
  return stored.filter((entry) => typeof entry === "string" && entry.trim());
}

// No entry already handed back is ever dropped to make room for a new one. When browser storage
// refuses the write, the note says so on the spot instead of an older one quietly disappearing at
// the next page load - the text the user wrote is the thing being protected here.
function keepRetiredDraft(text) {
  if (!text.trim()) return;
  retiredDrafts = [...retiredDrafts, text];
  renderRetiredDraft(text, saveJsonState(retiredDraftStorageKey, retiredDrafts));
}

// Handed-back drafts show in the page thread, where they stay readable and selectable. Whether the
// browser stored the copy is per-entry, so a refused write keeps its warning.
const unstoredRetiredDrafts = new Set();
function renderRetiredDraft(text, stored = true) {
  if (!stored) unstoredRetiredDrafts.add(text);
  renderThreads();
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

// ---- Phone-width comments sheet ----
// Below this width chrome.css turns the comments margin into a dock the user raises as a bottom
// sheet over the artifact, with every thread stacked in page order. This controller owns intent,
// accessibility state, gestures, visual-viewport measurements, and the dock summary; CSS owns the
// geometry. The query must match the one chrome.css lays the sheet out under.
const MOBILE_SHEET_MEDIA = "(max-width: 860px)";
// How far a drag on the dock must travel before it counts as a gesture rather than a tap.
const SHEET_DRAG_THRESHOLD_PX = 48;
const sheetStorageKey = "lavish-axi:sheet-open:" + key;
const sheetMedia = typeof window.matchMedia === "function" ? window.matchMedia(MOBILE_SHEET_MEDIA) : null;
// The user's intent, kept across a chrome reload so a live-reload or server upgrade does not drop
// them back onto a closed dock mid-review.
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

// A board keeps the desktop layout at every width (see isBoardPage in src/server.js).
const boardPage = sessionData.boardPage === true;

function isMobileSheet() {
  return !boardPage && Boolean(sheetMedia && sheetMedia.matches);
}

function setSheetOpen(open) {
  sheetOpen = Boolean(open);
  try {
    if (sheetOpen) sessionStorage.setItem(sheetStorageKey, "1");
    else sessionStorage.removeItem(sheetStorageKey);
  } catch {
    // Storage refused is not worth a broken sheet: the state just stops surviving a reload.
  }
  if (sheetOpen) unreadAgentReply = "";
  applySheetState();
}

// Re-derives every sheet attribute from the phone layout, sheet-open, and session-ended state so a
// viewport crossing the breakpoint in either direction cannot make an ended sheet interactive or
// leave a closed dock trapping focus.
function applySheetState() {
  const mobile = isMobileSheet();
  const open = mobile && sheetOpen;
  document.body.classList.toggle("sheet-open", open);
  const docked = mobile && !open;
  commentsBody.inert = ended || docked;
  // The footer's Send sits below the viewport with the rest of the docked sheet.
  commentsFoot.inert = docked;
  const activeElement = document.activeElement;
  if (docked && activeElement && (commentsBody.contains(activeElement) || commentsFoot.contains(activeElement))) {
    sheetToggle.focus();
  }
  sheetToggle.setAttribute("aria-expanded", open ? "true" : "false");
  sheetToggle.setAttribute("aria-label", open ? "Hide comments" : "Show comments");
  renderSheetSummary();
  positionThreads();
}

// What the closed dock says. One line, most actionable state first: drafts the user has not sent,
// then a reply they have not seen, then whether the agent is there to receive a send.
function sheetSummary() {
  if (ended) return { text: "Session ended", accent: false, unread: false };
  const drafts = draftCount();
  if (drafts > 0) return { text: drafts === 1 ? "1 not sent" : drafts + " not sent", accent: true, unread: false };
  if (unreadAgentReply) return { text: unreadAgentReply, accent: false, unread: true };
  if (agentPresence === "working") return { text: "Agent is working", accent: false, unread: false };
  if (agentPresence === "external") return { text: "External listener active", accent: false, unread: false };
  if (agentPresence === "listening") return { text: "Agent listening", accent: false, unread: false };
  const since = agentStopped ? clockTime(agentStopped.since) : "";
  return { text: since ? `Agent not listening since ${since}` : "Agent not listening", accent: false, unread: false };
}

function renderSheetSummary() {
  const summary = sheetSummary();
  sheetSummaryText.textContent = summary.text;
  sheetSummaryText.classList.toggle("is-accent", summary.accent);
  sheetSummaryText.classList.toggle("is-unread", summary.unread);
}

// A brief pulse on the dock when something the user should notice lands while the sheet is
// closed: a comment they saved from the artifact, or an agent reply.
function pulseSheetDock() {
  if (!isMobileSheet() || sheetOpen) return;
  sheetHead.classList.remove("is-fresh");
  // Restart the animation even when the previous pulse is still running.
  void sheetHead.offsetWidth;
  sheetHead.classList.add("is-fresh");
}

// Only the closed phone dock hides comments; on desktop the margin is always beside the page.
function isCommentsHidden() {
  return isMobileSheet() && !sheetOpen;
}

function revealComments() {
  if (isMobileSheet()) setSheetOpen(true);
  else unfoldComments();
}

function noteAgentReply(text) {
  if (!isCommentsHidden()) return;
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
  comments.classList.remove("is-dragging");
  comments.style.transform = "";
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

sheetHead.addEventListener("click", () => {
  if (!isMobileSheet()) return;
  if (suppressSheetClick) {
    suppressSheetClick = false;
    return;
  }
  setSheetOpen(!sheetOpen);
});
sheetScrim.addEventListener("click", () => setSheetOpen(false));
sheetHead.addEventListener("pointerdown", (event) => {
  if (!isMobileSheet() || event.button) return;
  sheetDrag = { pointerId: event.pointerId, startY: Number(event.clientY), moved: false };
  if (typeof sheetHead.setPointerCapture === "function") sheetHead.setPointerCapture(event.pointerId);
});
sheetHead.addEventListener("pointermove", (event) => {
  if (!sheetDrag || event.pointerId !== sheetDrag.pointerId) return;
  const offset = sheetDragOffset(event);
  if (Math.abs(offset) > 6) sheetDrag.moved = true;
  if (!sheetDrag.moved) return;
  comments.classList.add("is-dragging");
  // Follow the finger: an open sheet only moves down, a closed dock only up.
  comments.style.transform = sheetOpen
    ? "translateY(" + Math.max(0, offset) + "px)"
    : "translateY(calc(100% - var(--dock-h) - env(safe-area-inset-bottom, 0px) + " + Math.min(0, offset) + "px))";
});
sheetHead.addEventListener("pointerup", finishSheetDrag);
sheetHead.addEventListener("pointercancel", (event) => {
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
    // A reply previewed while the dock hid the comments is no longer owed once they show.
    if (!isCommentsHidden()) unreadAgentReply = "";
    threadHeights.clear();
    applySheetState();
  });
}
if (window.visualViewport && typeof window.visualViewport.addEventListener === "function") {
  window.visualViewport.addEventListener("resize", syncVisualViewport);
  window.visualViewport.addEventListener("scroll", syncVisualViewport);
}
window.addEventListener("resize", () => {
  syncVisualViewport();
  // Card heights depend on the margin's width; measure again before the next placement.
  threadHeights.clear();
  positionThreads();
});
syncVisualViewport();

function isPromptEditable(prompt) {
  return Boolean(prompt) && !terminalSubmission && !isPromptSending(prompt);
}

// Which card shows a queued note: its thread when it replies in one, its own pending card when
// it is a new anchored comment, and the page thread otherwise.
function draftThreadId(prompt) {
  if (prompt?.thread_id) return String(prompt.thread_id);
  if (prompt?.selector && !NON_THREAD_TAGS.has(prompt.tag)) return promptIdentity(prompt);
  return PAGE_THREAD_ID;
}

function editQueuedPrompt(index, { reveal = true } = {}) {
  const prompt = queued[index];
  if (ended || !isPromptEditable(prompt)) return;
  const id = promptIdentity(prompt);
  if (!id) return;
  if (id !== editingPromptId) {
    // Moving to another note keeps what was typed into the first, the way leaving a field does.
    commitQueuedEdit();
    editingPromptId = id;
    editingDraft = String(prompt.prompt || "");
  }
  editFocusPending = true;
  revealComments();
  openThread(draftThreadId(prompt), { focus: false });
  render();
  if (reveal && prompt.selector) postToFrame({ type: "lavish:revealElement", selector: String(prompt.selector) });
}

function endQueuedEdit() {
  editingPromptId = "";
  editingDraft = "";
}

// Writes the open edit into its note without rendering. Returns whether the queue changed. A note
// cleared of words and images is removed, as if its remove control had been used.
function commitQueuedEdit() {
  if (!editingPromptId) return false;
  const index = queued.findIndex((prompt) => promptIdentity(prompt) === editingPromptId);
  const text = editingDraft.trim();
  endQueuedEdit();
  const prompt = queued[index];
  if (!isPromptEditable(prompt)) return false;
  if (!text && !attachmentCount(prompt)) {
    queued.splice(index, 1);
    afterQueuedPromptRemoved();
  } else {
    // In place, not replaced: the send bookkeeping tracks notes by object identity.
    prompt.prompt = text;
    persistQueuedPrompts();
  }
  return true;
}

function saveQueuedEdit() {
  commitQueuedEdit();
  render();
}

// A click on an element the artifact knows carries a queued note. The artifact names only the
// selector, so the most a forged message can do is open one of the user's own notes for editing.
function editQueuedAnchor(selector) {
  if (!selector) return;
  for (let index = queued.length - 1; index >= 0; index--) {
    if (isElementAnchoredPrompt(queued[index]) && queuedAnchorSelectorsOf(queued[index]).includes(selector)) {
      if (isPromptEditable(queued[index])) {
        editQueuedPrompt(index, { reveal: false });
        return;
      }
      break;
    }
  }
  // The note is already on its way, or gone: the click still deserves the card it would have had.
  postToFrame({ type: "lavish:annotateElement", selector });
}

// Notes that point at a whole element, cell, or diagram node, which a later click on that same
// target can find again. A text selection's note is about the words, not the element around them.
function isElementAnchoredPrompt(prompt) {
  const kind = promptAnchor(prompt)?.kind;
  return Boolean(prompt.selector) && (kind === "element" || kind === "cell" || kind === "node");
}

// A diagram node is one target however deep the click lands, so its note answers to the node's
// own selector as well as the clicked element's. Other notes name only the exact element.
function queuedAnchorSelectorsOf(prompt) {
  const target = prompt.target && typeof prompt.target === "object" ? prompt.target : null;
  const whole = target?.type === "mermaid-node" ? String(target.selector || "") : "";
  return whole ? [String(prompt.selector), whole] : [String(prompt.selector)];
}

// Tells the artifact which element selectors carry a queued note. Only selectors cross into the
// frame: the artifact is agent-authored, and the note text stays in the chrome.
function postQueuedAnchors(force = false) {
  const selectors = [
    ...new Set(queued.filter((prompt) => isElementAnchoredPrompt(prompt)).flatMap(queuedAnchorSelectorsOf)),
  ];
  const signature = JSON.stringify(selectors);
  if (!force && signature === postedQueuedAnchors) return;
  postedQueuedAnchors = signature;
  postToFrame({ type: "lavish:queuedAnchors", selectors });
}

function removeQueuedPrompt(index, event) {
  if (event) event.stopPropagation();
  if (terminalSubmission || isPromptSending(queued[index])) return;
  queued.splice(index, 1);
  afterQueuedPromptRemoved();
  render();
}

function afterQueuedPromptRemoved() {
  persistQueuedPrompts();
  if (!queued.length) {
    clearSendAcknowledgementWarning();
    if (sendFailureOwner?.kind !== "preparation") clearPersistentSendFailure();
  }
}

function promptQueueKey(prompt) {
  return prompt && typeof prompt[internalQueueKeyField] === "string" ? prompt[internalQueueKeyField].trim() : "";
}

function beginFeedbackPreparation() {
  if (ended || terminalSubmission) return null;
  /** @type {(succeeded: boolean) => void} */
  let finishPromise = () => {};
  const done = new Promise((resolve) => {
    finishPromise = resolve;
  });
  const preparation = {
    done,
    finish(succeeded) {
      if (!feedbackPreparations.delete(preparation)) return;
      finishPromise(succeeded);
    },
  };
  feedbackPreparations.add(preparation);
  return preparation;
}

function enqueuePrompt(rawPrompt, /** @type {FeedbackPreparation | null} */ preparation = null) {
  if ((preparation && !feedbackPreparations.has(preparation)) || (terminalSubmission && !preparation)) return false;
  // The sandboxed iframe is untrusted: never accept a caller-supplied settlement identity.
  const prompt = adoptQueuedPrompt(rawPrompt, false);
  if (!prompt) return false;
  delete prompt.thread_id;

  const queueKey = promptQueueKey(prompt);
  if (queueKey) {
    const index = queued.findIndex((item) => promptQueueKey(item) === queueKey);
    if (index !== -1) {
      // The replacement is the artifact's newer answer. Words typed against the old answer never
      // move onto it; they are handed back to the reviewer instead.
      if (editingPromptId && promptIdentity(queued[index]) === editingPromptId) {
        const draft = editingDraft.trim();
        endQueuedEdit();
        if (draft !== String(queued[index].prompt || "").trim()) keepRetiredDraft(draft);
      }
      queued[index] = prompt;
    } else {
      queued.push(prompt);
    }
  } else {
    queued.push(prompt);
  }
  persistQueuedPrompts();
  render();
  unfoldComments();
  return true;
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

// The margin cards ride the artifact's scroll, so a wheel over the comments column scrolls the
// page under them. Inner scrollers (an open thread's messages, a textarea) keep their own wheel.
comments.addEventListener(
  "wheel",
  (event) => {
    if (isMobileSheet()) return;
    for (let el = /** @type {Element | null} */ (event.target); el && el !== comments; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) return;
    }
    event.preventDefault();
    postToFrame({ type: "lavish:scrollBy", dy: event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY });
  },
  { passive: false },
);

function requestSnapshot(action, prompts = [], endAfter = false, terminal = null) {
  const requestId = "snapshot-" + ++nextSnapshotRequestId;
  const request =
    action === "submit"
      ? {
          action,
          prompts,
          chatAtRequest: displayedChat.slice(),
          endAfter,
          terminal,
          order: terminal?.order || ++nextSendOperationOrder,
        }
      : { action };
  snapshotRequests.set(requestId, request);
  if (action === "submit") {
    request.acknowledgement = {};
    pendingAcknowledgements.add(request.acknowledgement);
    armSendAcknowledgementWarning();
    request.timeout = setTimeout(() => completeSnapshotRequest(requestId, ""), SNAPSHOT_REQUEST_TIMEOUT_MS);
  }
  postToFrame({ type: "lavish:requestSnapshot", snapshot_request_id: requestId });
}

function takeSnapshotRequest(requestId) {
  if (typeof requestId !== "string" || !requestId || !snapshotRequests.has(requestId)) return null;
  const request = snapshotRequests.get(requestId);
  snapshotRequests.delete(requestId);
  if (request?.timeout) clearTimeout(request.timeout);
  return request || null;
}

function completeSnapshotRequest(requestId, snapshot) {
  const request = takeSnapshotRequest(requestId);
  if (!request) return;
  if (request.action === "copy") {
    copyText(snapshot || "");
    return;
  }

  submitQueued({
    prompts: request.prompts || [],
    chatAtRequest: request.chatAtRequest || [],
    domSnapshot: snapshot || "",
    endAfter: request.endAfter === true,
    terminal: request.terminal || null,
    acknowledgement: request.acknowledgement || null,
    order: request.order || 0,
  }).catch(() => {});
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

// Saves the page comment box as a draft: words and ready images become one queued note, which
// Send delivers with every other draft. Returns false while a pending or failed image holds the
// box back. A held chip holds back only THIS message (and an explicit end, which would strand
// the chips) - queued notes still deliver, mirroring how the annotation card holds only its own
// card open.
function queueComposerMessage() {
  const chipsBlocked = chatAttachmentController.hasPending() || chatAttachmentController.hasErrors();
  if (chipsBlocked) {
    chatAttachmentController.noteSendBlocked();
    return false;
  }
  const text = chatInput.value.trim();
  const attachments = chatAttachmentController.collectReady();
  if (text || attachments.length) {
    const prompt = { uid: "", prompt: text, selector: "", tag: "message", text: "Freeform message" };
    if (attachments.length) prompt.attachments = attachments;
    assignPromptIdentity(prompt, false);
    queued.push(prompt);
    persistQueuedPrompts();
    // The draft is stored and shown before the box is cleared, so if anything after this point
    // fails, the words are already both persisted and visibly recoverable in the tab.
    chatInput.value = "";
    savePageDraft();
    chatAttachmentController.reset();
    render();
  }
  return true;
}

function sendQueued(endAfter) {
  if (ended) return;
  if (terminalSubmission) {
    if (endAfter && !terminalSubmission.inFlight) retryTerminalSubmission();
    return;
  }
  closeMenus();
  // Send delivers what the margin shows, so an open edit is kept rather than sent stale.
  if (commitQueuedEdit()) render();

  const chipsBlocked = !queueComposerMessage();
  const shouldEnd = Boolean(endAfter && !chipsBlocked);
  const preparations = shouldEnd ? [...feedbackPreparations] : [];
  if (!queued.length && preparations.length === 0) {
    if (!chipsBlocked && !sendFailureOwner) {
      if (endAfter) showSendHint(EMPTY_END_HINT);
      else showSendHint(DEFAULT_SEND_HINT, EMPTY_SEND_HINT_HOLD_MS);
    }
    return;
  }
  if (!sendFailureOwner) hideSendHint(true);
  if (shouldEnd) {
    const terminal = {
      prompts: [],
      inFlight: true,
      order: ++nextSendOperationOrder,
    };
    terminalSubmission = terminal;
    updateSendState();
    finishTerminalPreparation(terminal, preparations);
    return;
  }
  requestSnapshot("submit", queued.slice(), false, null);
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
  if (results.some((succeeded) => !succeeded)) {
    releaseTerminalSubmission(terminal);
    return;
  }
  terminal.prompts = queued.slice();
  clearPreparationFailure("terminal");
  if (!terminal.prompts.length) {
    releaseTerminalSubmission(terminal);
    if (!sendFailureOwner) showSendHint(EMPTY_END_HINT);
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
  const body = { prompts: prompts.map(stripInternalPromptFields), domSnapshot: submission.domSnapshot };
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
      body.domSnapshot = "";
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
      showQueuedSendFailure(LAYOUT_REQUEST_CONFLICT_COPY, { kind: "submission", operation: submission });
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
  // A layout fix request whose issue changed after it was queued was held back by the server,
  // so it stays queued here for the reviewer; everything else in the batch was delivered.
  const heldIds = new Set(Array.isArray(accepted?.held_prompt_ids) ? accepted.held_prompt_ids : []);
  const held = prompts.filter((prompt) => heldIds.has(promptIdentity(prompt)));
  const retired = Array.isArray(accepted?.retired_prompt_ids) && accepted.retired_prompt_ids.length > 0;
  if (Array.isArray(accepted?.warnings)) setLayoutWarnings(accepted.warnings);
  if (!acceptedChat || reconciledChat) {
    for (const prompt of prompts) {
      if (held.includes(prompt)) continue;
      deliveredPrompts.add(prompt);
      const index = queued.indexOf(prompt);
      if (index !== -1) queued.splice(index, 1);
    }
    persistQueuedPrompts();
    if (reconciledChat) syncChat(reconciledChat, acceptedRevision);
    syncThreads(accepted);
  }
  render();
  settleAcknowledgementGuidance(submission, preserveFailureState);
  if (shouldEndSession) {
    markSessionEnded();
    return;
  }
  if (held.length) showQueuedSendFailure(LAYOUT_REQUEST_HELD_COPY, { kind: "submission", operation: submission });
  else if (retired) showSendHint(LAYOUT_REQUEST_RETIRED_COPY, 8000, false);
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
  if (layoutGateOverlay) layoutGateOverlay.dataset.state = state;
  if (!layoutGateTitle || !layoutGateCopy) return;

  if (state === "held") {
    layoutGateTitle.innerHTML = "Fixing a layout issue...";
    layoutGateCopy.textContent =
      "The browser found inaccessible or unusable content. Your agent has been notified and this will reveal after the next clean reload.";
    return;
  }

  layoutGateTitle.innerHTML = "Checking layout.<br>One moment.";
  layoutGateCopy.textContent = "Hilight is waiting for fonts and final geometry before revealing this artifact.";
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
  if (layoutGateOverlay) layoutGateOverlay.dataset.state = "failure";
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
  revealLayoutGate("recovered");
}

// `reason` is why the gate lifted: "pass" (the layout pass finished), "timeout", "manual",
// "recovered" or "ended". It is recorded as a performance mark so load time can be measured from
// any browser (`performance.getEntriesByName("hilight:layout-gate-revealed")`).
function revealLayoutGate(reason = "pass") {
  if (layoutGateVisible) {
    try {
      performance.mark("hilight:layout-gate-revealed", { detail: reason });
    } catch {
      // Measuring is optional.
    }
  }
  clearLayoutGateTimer();
  layoutGateEscape?.reveal?.();
  setLayoutGateActive(false);
  announceArtifactShown();
}

// The gate keeps the artifact at opacity 0 (and the browser throttles its frames) until the
// layout pass, so the artifact cannot tell on its own when the reviewer first sees it. A board
// waits for this before moving its camera to what is new. Once per load token.
let artifactShownToken = "";
function announceArtifactShown() {
  if (layoutGateVisible || !artifactSpokeToken || artifactShownToken === artifactSpokeToken) return;
  artifactShownToken = artifactSpokeToken;
  postToFrame({ type: "lavish:artifactShown" });
}

function forceRevealLayoutGate(reason) {
  if (ended) return;
  if (reason === "manual") {
    layoutGateManuallyBypassed = true;
    layoutGateEscape?.manualReveal?.();
  }
  revealLayoutGate(reason);
}

function armLayoutGateTimer(holdMs = layoutGateMaxHoldMs) {
  clearLayoutGateTimer();
  if (layoutGateEscape?.arm) {
    layoutGateEscape.arm(holdMs, () => forceRevealLayoutGate("timeout"));
    return;
  }
  const cycle = layoutGateCycle;
  layoutGateTimer = setTimeout(() => {
    if (cycle !== layoutGateCycle || !layoutGateVisible || ended) return;
    forceRevealLayoutGate("timeout");
  }, holdMs);
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
  armLayoutGateTimer(layoutGateFailureSticky ? layoutGateMaxHoldMs : layoutGateCheckMs);
}

// The gate only waits for fonts and final geometry now. It never holds the artifact hostage
// pending an agent repair: findings are the user's to triage, so a completed pass always reveals
// and hands the result to the passive inbox.
function handleLayoutGatePass() {
  if (ended || !layoutGateVisible) return;
  revealLayoutGate("pass");
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
  warningsQueueButton.disabled = selectedCount === 0 || ended || terminalSubmission !== null;
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

// ---------------------------------------------------------------------------
// Revision legend
//
// The agent declares what it changed in the artifact HTML itself (a
// `data-lavish-revisions` registry plus `data-lavish-revision` marks); the SDK
// reads it and posts it here. The legend lives entirely in the chrome, so the
// served artifact still matches the file on disk - Hilight never paints the
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
/** @type {any[]} */
let revisionEntries = [];
/** @type {Map<string, number>} */
const revisionRevealCursor = new Map();

// Display-only fields. Anything Hilight merely shows can be shortened.
function revisionText(value, max) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value).trim();
  return text.length > max ? text.slice(0, max) : text;
}

// Identity fields, mirroring `exactRevisionText` in src/artifact-revisions.js.
// The message is untrusted here, so shortening an id or a selector is worse
// than dropping it: two distinct overlong ids collapse into one revision, and
// the first 400 characters of a long selector are a different valid selector
// that Reveal would resolve to some other block.
function revisionExact(value, max) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value).trim();
  return text.length > 0 && text.length <= max ? text : "";
}

// The registry the artifact declares (data-lavish-revisions) and the blocks it marked. Thread
// answers name a revision (`## c1 reveal=r2`), and their Reveal button walks its marked blocks.
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

function resetRevisionRegistry() {
  revisionEntries = [];
  revisionRevealCursor.clear();
}

function applyRevisionMessage(msg) {
  const normalized = normalizeRevisionMessage(msg);
  revisionEntries = normalized.revisions;
  for (const id of [...revisionRevealCursor.keys()]) {
    if (!revisionEntries.some((entry) => entry.id === id)) revisionRevealCursor.delete(id);
  }
  renderThreads();
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
  const preparation = beginFeedbackPreparation();
  if (!preparation) return;
  const ids = [...selectedWarningIds];
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
      body: JSON.stringify({ ids }),
    });
    if (!response.ok) throw new Error("failed to queue layout warning fixes");
    const data = await response.json();
    if (data.prompt) {
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
        )
      )
        throw new Error("failed to retain layout warning fixes");
    }
    selectedWarningIds.clear();
    persistWarningSelection();
    if (Array.isArray(data.warnings)) setLayoutWarnings(data.warnings);
    closeWarningsDrawer({ restoreFocus: true });
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
  pendingAcknowledgements.clear();
  clearSendAcknowledgementWarning();
  terminalSubmission = null;
  persistTerminalReservation(false);
  cancelArtifactLoadRecovery();
  closeMenus();
  closeShareDialog();
  closeWarningsDrawer();
  renderWarnings();
  closeResolvedDrawer();
  closeWhiteboard();
  annotationSwitch.disabled = true;
  moreButton.disabled = true;
  chatInput.disabled = true;
  renderThreads();
  updateSendState();
  applySheetState();
  renderAgentStatus();
  if (handoffBanner) handoffBanner.hidden = true;
  if (outdatedBanner) outdatedBanner.hidden = true;
  layoutGateManuallyBypassed = true;
  layoutGateFailureSticky = false;
  revealLayoutGate("ended");
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
  // no row. Never derive it from the URL: that shape belongs to the backend, not Hilight.
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
  " The host did not return a site id Hilight can use, and --site is half the republish credential, so this page can NEVER be republished or unpublished even though its update key is in hand.";

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
    ? "Hilight will generate one when you publish"
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
    (rendered.password ? " Copy the password now - it is shown once here and Hilight does not store it." : "");
}

// An incomplete 200 is NOT an unknown outcome: the host answered, so the page landed. Whatever
// fields did arrive are rendered, because a url with no update_key names a live, public-by-default
// page whose only write credential is gone - and saying "may or may not" there would throw away
// the address Hilight is holding.
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
    ", but its response was malformed and Hilight could not read the whole result back. " +
    (rendered.url ? "Its address is below. " : "The response carried no URL, so Hilight cannot show the address. ") +
    updateKeyNote +
    "Publishing again creates a SECOND page rather than replacing it." +
    (rendered.password ? " Copy the password now - it is shown once here and Hilight does not store it." : "");
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
      shareStatus.textContent += " Copy the password now - it is shown once here and Hilight does not store it.";
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

// Every navigation of the artifact frame goes through here. The first fills the frame's initial
// empty document, which never adds a history entry; each later one replaces the frame's current
// entry through its window's `location.replace`, which a parent may call even across the opaque
// sandbox origin. Assigning `frame.src` again pushed one joint session-history entry per save,
// until Chrome refused a script's `window.close()` of the review tab.
function navigateArtifactFrame(src) {
  if (frame.src) {
    try {
      const location = frame.contentWindow?.location;
      if (location && typeof location.replace === "function") {
        location.replace(src);
        return;
      }
    } catch {
      // Fall back to the attribute below.
    }
  }
  frame.src = src;
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
    // The next document reports its own registry once it loads; until then the
    // previous revision's legend would point at blocks that may no longer exist.
    // Only clear it here, right before the frame is actually replaced - a preserved
    // load (superseded/out-of-order/exhausted retries below) must leave it intact.
    resetRevisionRegistry();
    startLayoutGateCycle();
    const currentSrc = frame.src || "about:blank";
    navigateArtifactFrame(currentSrc + (currentSrc.includes("?") ? "&" : "?") + "lavish_reload=" + Date.now());
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
      // A first load that gets no fresh token falls back to the one embedded in the page, so a
      // superseded chrome still shows the artifact behind its takeover banner.
      if (!frame.src) frame.src = artifactFrameSrcForLoad({ revision: artifactLoadRevision, token: previousToken });
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
    if (scheduleArtifactLoadRecovery()) return false;
    // Out of retries. Only say so when there is nothing on screen to say it over: a chrome that
    // already shows an artifact keeps showing it rather than losing a usable review.
    if (!artifactLoadToken) {
      setLayoutGateFailure(
        "Hilight could not load this artifact.",
        "The Hilight server did not answer this review's load request. It usually restarted while this page was opening. Check and reload to reconnect.",
        "Check and reload",
        checkServerThenReload(
          "Hilight could not load this artifact.",
          "Hilight is still not answering. Start it again with your agent, then use Check and reload.",
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
              UNSENT_OWNERSHIP_COPY,
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
  annotationDefaultReceived = false;
  inlineWhiteboardChannels.clear();
  setHandoffSuperseded(false);
  startLayoutGateCycle();
  // The next document reports its own registry once it loads; until then the
  // previous revision's legend would point at blocks that may no longer exist.
  resetRevisionRegistry();
  navigateArtifactFrame(artifactFrameSrcForLoad({ revision, token }));
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
  // Every queue result for the board also settles the comments panel's Queue marks button.
  if (index === BOARD_SCENE_INDEX && message.type === "lavish-whiteboard:queueResult") finishBoardQueue(message.ok);
}

function postToWhiteboard(index, placement, message) {
  if (placement === "overlay") postToWhiteboardOverlay(message);
  else postToInlineWhiteboard(index, message);
}

async function fetchMermaidSourcesData() {
  const response = await fetch("/api/" + key + "/mermaid-sources");
  if (!response.ok) throw new Error("could not read the artifact's Mermaid sources");
  const data = await response.json();
  return {
    sources: Array.isArray(data.sources) ? data.sources : [],
    librariesVersion: typeof data.libraries_version === "string" ? data.libraries_version : "",
  };
}

async function fetchMermaidSources() {
  return (await fetchMermaidSourcesData()).sources;
}

// Fetched per init so a frame converts with the libraries its source hash was
// computed from; a failed fetch resolves null and the frame converts without
// libraries.
function fetchWhiteboardLibraries() {
  return fetch("/api/whiteboard-libraries")
    .then((response) => (response.ok ? response.json() : null))
    .then((data) =>
      Array.isArray(data?.libraries)
        ? { libraries: data.libraries, version: typeof data.version === "string" ? data.version : "" }
        : null,
    )
    .catch(() => null);
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

// Board canvas (src/board-frame.js). The artifact SDK mounts one whiteboard
// frame over a board file under this reserved diagram index (BOARD_SCENE_INDEX
// in src/board-core.js; this file is served raw and cannot import it). Its
// scene persists in the same sidecar store as Mermaid whiteboards.
const BOARD_SCENE_INDEX = 999;
const BOARD_REFRESH_MS = 15000;
let boardRefreshTimer = 0;
let lastBoardJson = "";

async function fetchBoard() {
  const response = await fetch("/api/" + key + "/board");
  if (!response.ok) throw new Error("could not read the board from the artifact file");
  const data = await response.json();
  return data.board;
}

async function handleBoardReady(index, mode, isCurrent) {
  try {
    const [boardData, savedResponse] = await Promise.all([fetchBoard(), fetch("/api/" + key + "/whiteboard/" + index)]);
    const saved = savedResponse.ok ? (await savedResponse.json()).whiteboard : null;
    if (!isCurrent()) return false;
    lastBoardJson = JSON.stringify(boardData);
    postToWhiteboard(index, mode, {
      type: "lavish-whiteboard:init",
      mode,
      diagramIndex: index,
      diagramId: "",
      board: boardData,
      saved,
      theme: whiteboardTheme(),
    });
    startBoardRefresh();
    return true;
  } catch {
    return false;
  }
}

// Code cards are re-read from disk while the board is open, so a pinned range
// that changes under the reviewer flips to stale without a reload.
async function refreshBoard() {
  const channel = inlineWhiteboardChannels.get(BOARD_SCENE_INDEX);
  if (!channel?.initialized || document.visibilityState !== "visible") return;
  try {
    const boardData = await fetchBoard();
    const json = JSON.stringify(boardData);
    if (json === lastBoardJson || inlineWhiteboardChannels.get(BOARD_SCENE_INDEX) !== channel) return;
    lastBoardJson = json;
    postToInlineWhiteboard(BOARD_SCENE_INDEX, { type: "hilight-board:update", board: boardData });
  } catch {
    // Best effort; the next tick or reload re-reads it.
  }
}

// Canvas mode keeps one top bar. The board frame reports its title path,
// summary and code-card health (hilight-board:header); the bar shows the title,
// an info popover holds the summary, and the health joins the resolved and
// off-page counts in one status pill. The note and Queue marks sit in the
// comments panel beside Send; the frame exports the marks when asked.

const shortText = (value, max) => String(value ?? "").slice(0, max);

function renderBoardHeader(message) {
  const path = (Array.isArray(message.path) ? message.path : [])
    .slice(-12)
    .map((level) => ({ id: shortText(level?.id, 200), title: shortText(level?.title, 200) || "Board" }));
  if (boardTitle && path.length) {
    const nodes = [];
    path.forEach((level, index) => {
      if (index > 0) {
        const sep = document.createElement("span");
        sep.className = "board-sep";
        sep.textContent = "/";
        nodes.push(sep);
      }
      const last = index === path.length - 1;
      const crumb = document.createElement(last ? "span" : "button");
      crumb.className = "board-crumb" + (last ? " is-current" : "");
      crumb.textContent = level.title;
      crumb.title = level.title;
      if (!last) {
        /** @type {HTMLButtonElement} */ (crumb).type = "button";
        crumb.onclick = () =>
          postToInlineWhiteboard(BOARD_SCENE_INDEX, { type: "hilight-board:openLevel", level: level.id });
      }
      nodes.push(crumb);
    });
    boardTitle.replaceChildren(...nodes);
  }
  const summary = shortText(message.summary, 2000).trim();
  if (boardInfoText) boardInfoText.textContent = summary;
  if (boardInfoWrap) boardInfoWrap.hidden = !summary;
  if (!summary) setBoardInfoOpen(false);
  const health = message.health && typeof message.health === "object" ? message.health : {};
  boardHealth = {
    text: shortText(health.text, 200),
    detail: shortText(health.detail, 400),
    warn: health.warn === true,
    drifted: shortText(health.drifted, 200),
    problems: (Array.isArray(health.problems) ? health.problems : []).slice(0, 20).map((item) => shortText(item, 300)),
  };
  renderStatusPill();
}

function setBoardInfoOpen(open) {
  if (!boardInfo || !boardInfoButton) return;
  boardInfo.hidden = !open;
  boardInfoButton.setAttribute("aria-expanded", String(Boolean(open)));
  if (open) closeMenus();
}

// The one status pill: code-card health, board problems, then resolved and off-page comments.
function renderStatusPill() {
  const { resolved, offPage } = threadCounts;
  const problems = boardHealth.problems.length;
  const parts = [
    boardHealth.text,
    problems ? `${problems} board problem${problems === 1 ? "" : "s"}` : "",
    resolved ? resolved + " resolved" : "",
    offPage ? offPage + " off-page" : "",
  ].filter(Boolean);
  resolvedWrap.hidden = !parts.length || ended;
  resolvedCount.textContent = parts.join(" · ");
  resolvedButton.classList.toggle("has-health", Boolean(boardHealth.text));
  resolvedButton.classList.toggle("is-warn", boardHealth.warn || problems > 0);
  if (boardHealthSection && boardHealthText && boardHealthShow && boardProblems) {
    boardHealthSection.hidden = !boardHealth.detail && !problems;
    boardHealthText.textContent = boardHealth.detail;
    boardHealthText.hidden = !boardHealth.detail;
    boardHealthShow.hidden = !boardHealth.drifted;
    boardProblems.replaceChildren(
      ...boardHealth.problems.map((text) => {
        const item = document.createElement("li");
        item.textContent = text;
        return item;
      }),
    );
    boardProblems.hidden = !problems;
  }
  if (resolvedWrap.hidden && resolvedDrawerOpen) setResolvedDrawerOpen(false);
}

function finishBoardQueue(ok) {
  if (!boardQueue) return;
  window.clearTimeout(boardQueueTimer);
  boardQueue.disabled = false;
  boardQueue.textContent = "Queue marks";
  if (ok && boardNote) boardNote.value = "";
}

if (boardInfoButton) {
  boardInfoButton.onclick = () => setBoardInfoOpen(Boolean(boardInfo?.hidden));
  document.addEventListener("mousedown", (event) => {
    if (boardInfo && !boardInfo.hidden && !boardInfoWrap?.contains(/** @type {Node} */ (event.target))) {
      setBoardInfoOpen(false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && boardInfo && !boardInfo.hidden) {
      setBoardInfoOpen(false);
      boardInfoButton.focus();
    }
  });
}
if (boardHealthShow) {
  boardHealthShow.onclick = () => {
    if (!boardHealth.drifted) return;
    closeResolvedDrawer();
    postToInlineWhiteboard(BOARD_SCENE_INDEX, { type: "hilight-board:revealCard", card: boardHealth.drifted });
  };
}
if (boardMarks && boardQueue && boardNote) {
  boardMarks.addEventListener("submit", (event) => {
    event.preventDefault();
    if (boardQueue.disabled || !inlineWhiteboardChannels.get(BOARD_SCENE_INDEX)?.initialized) return;
    boardQueue.disabled = true;
    boardQueue.textContent = "Queueing…";
    // A board that never answers must not leave the button stuck.
    boardQueueTimer = window.setTimeout(() => finishBoardQueue(false), BOARD_QUEUE_TIMEOUT_MS);
    postToInlineWhiteboard(BOARD_SCENE_INDEX, { type: "hilight-board:queueMarks", note: boardNote.value });
  });
}

function startBoardRefresh() {
  if (boardRefreshTimer) return;
  boardRefreshTimer = window.setInterval(refreshBoard, BOARD_REFRESH_MS);
  window.addEventListener("focus", refreshBoard);
  if (window.matchMedia) {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", () => {
        if (inlineWhiteboardChannels.get(BOARD_SCENE_INDEX)?.initialized) {
          postToInlineWhiteboard(BOARD_SCENE_INDEX, { type: "hilight-board:theme", theme: whiteboardTheme() });
        }
      });
    }
  }
}

async function handleWhiteboardReady(index, mode, isCurrent) {
  if (index === BOARD_SCENE_INDEX && mode === "inline") return handleBoardReady(index, mode, isCurrent);
  try {
    const librariesRequest = fetchWhiteboardLibraries();
    const { sources, librariesVersion } = await fetchMermaidSourcesData();
    const source = sources.find((item) => item.index === index);
    if (!source) throw new Error("this diagram's Mermaid source was not found in the artifact file");
    const savedResponse = await fetch("/api/" + key + "/whiteboard/" + index);
    const saved = savedResponse.ok ? (await savedResponse.json()).whiteboard : null;
    const librariesData = await librariesRequest;
    // A library file that changed between the two requests leaves the frame
    // with libraries that do not match this source hash: treat that like a
    // failed fetch, so the conversion's autosave is held.
    const librariesMatch = Boolean(librariesData) && (!librariesVersion || librariesData.version === librariesVersion);
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
      libraries: librariesData ? librariesData.libraries : [],
      librariesUnavailable: !librariesMatch,
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
  const preparation = beginFeedbackPreparation();
  if (!preparation) {
    postToWhiteboard(index, mode, {
      type: "lavish-whiteboard:queueResult",
      ok: false,
      error: "Feedback delivery is already ending this review.",
    });
    return;
  }
  const diagramId = whiteboardRecord(index).diagramId;
  let succeeded = false;
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
    if (index === BOARD_SCENE_INDEX && message.board) {
      const boardText =
        (note ? note + "\n\n" : "") +
        "Marks on the board canvas:\n" +
        (summary ? "- " + summary.split("\n").join("\n- ") : "(only the note above)") +
        (files.preview_path ? "\n\nPNG preview of the current board level: " + String(files.preview_path) : "");
      if (
        !enqueuePrompt(
          {
            uid: "",
            prompt: boardText,
            selector: "",
            tag: "board",
            text: "Board: canvas marks",
            target: {
              type: "board-canvas",
              revision: String(message.sourceHash || ""),
              scenePath: String(files.scene_path || ""),
              previewPath: String(files.preview_path || ""),
              stats: message.stats && typeof message.stats === "object" ? message.stats : {},
            },
            // Re-queueing before sending replaces the earlier unsent summary.
            [internalQueueKeyField]: "board:canvas",
          },
          preparation,
        )
      )
        throw new Error("failed to retain board feedback");
      pulseSheetDock();
      postToWhiteboard(index, mode, { type: "lavish-whiteboard:queueResult", ok: true });
      clearPreparationFailure("whiteboard");
      succeeded = true;
      return;
    }
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
          },
          // Re-queueing the same diagram's whiteboard before sending replaces the
          // earlier unsent prompt instead of stacking duplicates.
          [internalQueueKeyField]: "whiteboard:" + index,
        },
        preparation,
      )
    )
      throw new Error("failed to retain whiteboard feedback");
    // Queued from the whiteboard inside the artifact, like any other in-artifact prompt.
    pulseSheetDock();
    postToWhiteboard(index, mode, { type: "lavish-whiteboard:queueResult", ok: true });
    if (mode === "overlay") closeWhiteboard();
    clearPreparationFailure("whiteboard");
    succeeded = true;
  } catch (error) {
    postToWhiteboard(index, mode, {
      type: "lavish-whiteboard:queueResult",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    preparation.finish(succeeded);
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
  if (index === BOARD_SCENE_INDEX && mode === "inline") {
    if (message.type === "hilight-board:header") renderBoardHeader(message);
    if (message.type === "hilight-board:queueSkipped") finishBoardQueue(false);
  }
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
// with whatever else the machine is doing, and several `hilight` invocations can be racing for
// the same port. Reloading on a fixed short deadline regardless of whether anything is listening
// trades a recoverable page for the browser's connection-error page, which no Hilight code can
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
      "Hilight is not running.",
      "The Hilight server restarted and did not come back. Start it again with your agent, then check and reload this page.",
      "Check and reload",
      checkServerThenReload(
        "Hilight is not running.",
        "Hilight is still not running. Start it again with your agent, then use Check and reload.",
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
            : "Hilight is still not running. Start it again, then use Check and reload.";
      }
    }
  }
}

// ---- Tab title and icon from the artifact ----
// The server stamps the tab from the artifact's <head> once, when the chrome is served. A page that
// changes after that (a live dashboard) can ask the chrome to follow it with
// window.lavish.setDocumentMeta. The page is untrusted, so the chrome clamps the title and takes
// only a bounded SVG data: icon, which cannot run script or fetch anything as a tab icon.
const DOCUMENT_TITLE_MAX_CHARS = 120;
const DOCUMENT_ICON_MAX_CHARS = 8192;
const DOCUMENT_ICON_RE = /^data:image\/svg\+xml[;,]/i;
const loadTimeTitle = document.title;
const loadTimeIconLink = document.querySelector?.('link[rel~="icon"]');
const loadTimeIconHref = loadTimeIconLink ? loadTimeIconLink.getAttribute("href") : null;

function applyDocumentMeta(msg) {
  if (msg.title === null) document.title = loadTimeTitle;
  else if (typeof msg.title === "string") {
    const title = msg.title
      .replace(/\p{Cc}+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, DOCUMENT_TITLE_MAX_CHARS)
      .trim();
    document.title = title ? title + " · Hilight" : loadTimeTitle;
  }
  if (msg.icon === null) setDocumentIcon(loadTimeIconHref);
  else if (
    typeof msg.icon === "string" &&
    msg.icon.length <= DOCUMENT_ICON_MAX_CHARS &&
    DOCUMENT_ICON_RE.test(msg.icon)
  ) {
    setDocumentIcon(msg.icon);
  }
}

function setDocumentIcon(href) {
  // Replace the element rather than edit its href: some browsers keep showing the old icon
  // otherwise.
  const old = document.querySelector('link[rel~="icon"]');
  const link = document.createElement("link");
  link.setAttribute("rel", "icon");
  if (href) link.setAttribute("href", href);
  if (old) old.replaceWith(link);
  else document.head.appendChild(link);
}

window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow) return;

  const msg = event.data || {};
  const messageToken = String(msg.artifact_load_token || "");
  if (messageToken !== artifactLoadToken) {
    // A pass can be stamped by the load that just lost a token race. Ask the current artifact
    // document to run the audit again instead of consuming the only pass for this cycle.
    if (msg.type === "lavish:layoutDiagnostics") postToFrame({ type: "lavish:requestLayoutDiagnostics" });
    return;
  }
  const messageSequence = ++artifactMessageSequence;
  artifactSpokeToken = messageToken;
  clearTimeout(artifactSilenceTimer);
  announceArtifactShown();
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
  if (msg.type === "lavish:annotationMode" && typeof msg.enabled === "boolean" && !annotationDefaultReceived) {
    annotationDefaultReceived = true;
    if (!annotationOverridden && !ended && !terminalSubmission) annotation = msg.enabled;
    annotationSwitch.setAttribute("aria-pressed", String(annotation && !ended));
    // Reconcile even if frame load replayed the old mode before this report arrived.
    postToFrame({ type: "lavish:setAnnotationMode", enabled: annotation && !ended });
  }
  if (msg.type === "lavish:threadGeometry") {
    const wasMissing = new Set([...threadGeometry].filter(([, position]) => position.missing).map(([id]) => id));
    threadGeometry.clear();
    for (const position of Array.isArray(msg.positions) ? msg.positions : []) {
      if (typeof position?.id !== "string") continue;
      threadGeometry.set(position.id, {
        top: Number.isFinite(position.top) ? Number(position.top) : null,
        missing: position.missing === true,
      });
    }
    const nowMissing = [...threadGeometry].filter(([, position]) => position.missing).map(([id]) => id);
    // A thread whose anchor appeared or vanished moves between the margin and the off-page list.
    if (nowMissing.length !== wasMissing.size || nowMissing.some((id) => !wasMissing.has(id))) renderThreads();
    else positionThreads();
  }
  if (msg.type === "lavish:threadHover") {
    const id = String(msg.id || "");
    // Leaving a highlight hands the glow back to the open card, if any.
    if (id) setActiveThread(id, false);
    else setActiveThread(openThreadId);
  }
  if (msg.type === "lavish:focusThread") openThread(String(msg.id || ""));
  if (msg.type === "lavish:queuePrompt") {
    enqueuePrompt(msg.prompt);
    // Queued from inside the artifact, where the closed dock is the only sign it landed.
    pulseSheetDock();
  }
  if (msg.type === "lavish:snapshot") {
    completeSnapshotRequest(msg.snapshot_request_id, msg.snapshot || "");
  }
  if (msg.type === "lavish:documentMeta") applyDocumentMeta(msg);
  if (msg.type === "lavish:scroll") {
    lastScroll = { x: Number(msg.x) || 0, y: Number(msg.y) || 0 };
  }
  if (msg.type === "lavish:reviewState") {
    setReviewState(msg.state && typeof msg.state === "object" ? msg.state : null);
  }
  if (msg.type === "lavish:reviewDraftUnrestorable") {
    discardUnrestorableDraft(String(msg.selector || ""));
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
  if (msg.type === "lavish:revisions") applyRevisionMessage(msg);
  if (msg.type === "lavish:toggleAnnotationMode") toggleAnnotationMode();
  if (msg.type === "lavish:editQueuedAnchor") editQueuedAnchor(String(msg.selector || ""));
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
  if (ended || terminalSubmission) return;
  annotationOverridden = true;
  annotation = !annotation;
  annotationSwitch.setAttribute("aria-pressed", String(annotation));
  postToFrame({ type: "lavish:setAnnotationMode", enabled: annotation });
}

annotationSwitch.onclick = toggleAnnotationMode;
if (commentsToggle) commentsToggle.onclick = () => setCommentsCollapsed(!commentsCollapsed());
// A board in a narrow window (a half-screen laptop, a preview pane) folds the comments margin so
// the canvas gets the width, at load and when the window is resized, until the reviewer opens or
// folds it themselves for this session.
const BOARD_FOLD_COMMENTS_BELOW_PX = 1000;
function storedCommentsChoice() {
  try {
    return localStorage.getItem(commentsCollapsedKey);
  } catch {
    return null;
  }
}
function applyBoardCommentsWidthRule() {
  if (!boardPage || isMobileSheet() || storedCommentsChoice() !== null) return;
  const narrow = window.innerWidth < BOARD_FOLD_COMMENTS_BELOW_PX;
  if (narrow !== commentsCollapsed()) setCommentsCollapsed(narrow, false);
}
if (storedCommentsChoice() === "1" && !isMobileSheet()) setCommentsCollapsed(true, false);
applyBoardCommentsWidthRule();
if (boardPage) window.addEventListener("resize", applyBoardCommentsWidthRule);

sendButton.onclick = () => sendQueued(false);
sendAndEndButton.onclick = () => sendQueued(true);
moreButton.onclick = () => {
  closeWarningsDrawer();
  closeResolvedDrawer();
  closeActivityDrawer();
  toggleMenu(moreButton, moreMenu);
};
warningsButton.onclick = () => {
  closeResolvedDrawer();
  toggleWarningsDrawer();
};
resolvedButton.onclick = () => {
  closeWarningsDrawer();
  closeActivityDrawer();
  setResolvedDrawerOpen(resolvedDrawer.hidden);
};
if (activityOpenButton) {
  activityOpenButton.onclick = () => {
    closeWarningsDrawer();
    closeResolvedDrawer();
    setActivityDrawerOpen(true);
  };
}
resolveUndoButton.onclick = undoResolve;
attachImagesButton.onclick = () => {
  closeMenus();
  revealComments();
  openThread(PAGE_THREAD_ID);
  chatAttachInput.click();
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
// Images dropped anywhere on the page comment attach to its draft, opening it so the chips show.
pageThread.addEventListener("dragover", (event) => {
  if (Array.from(event.dataTransfer?.types || []).includes("Files")) {
    event.preventDefault();
    pageThread.classList.add("is-dropping");
  }
});
pageThread.addEventListener("dragleave", (event) => {
  const entering = /** @type {Node | null} */ (event.relatedTarget);
  if (!pageThread.contains(entering)) pageThread.classList.remove("is-dropping");
});
pageThread.addEventListener("drop", (event) => {
  pageThread.classList.remove("is-dropping");
  if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
  event.preventDefault();
  openThread(PAGE_THREAD_ID);
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
// The page comment keeps the annotation card's keys: Enter saves a draft (Send delivers every
// draft at once), Shift+Enter breaks the line, Esc closes and keeps the words.
chatInput.addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    queueComposerMessage();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeThread(PAGE_THREAD_ID, { focusCard: true });
  }
});
chatInput.addEventListener("input", () => {
  hideSendHint();
  savePageDraft();
  autosize(chatInput);
  updateSendState();
  renderSheetSummary();
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
  if (resolvedDrawerOpen && !resolvedWrap.contains(target)) closeResolvedDrawer();
  if (activityDrawerOpen && activityDrawer && !activityDrawer.contains(target)) closeActivityDrawer();
});
// A non-modal popover closes when focus leaves it, so keyboard users are never stranded inside a
// panel they cannot see the end of.
warningsWrap.addEventListener("focusout", (event) => {
  const next = /** @type {Node | null} */ (event.relatedTarget);
  if (warningsDrawerOpen && next && !warningsWrap.contains(next)) closeWarningsDrawer();
});
resolvedWrap.addEventListener("focusout", (event) => {
  const next = /** @type {Node | null} */ (event.relatedTarget);
  if (resolvedDrawerOpen && next && !resolvedWrap.contains(next)) closeResolvedDrawer();
});
whiteboardCloseButton.onclick = closeWhiteboard;
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!whiteboardOverlay.hidden) {
      closeWhiteboard();
    } else if (!shareDialog.hidden) {
      closeShareDialog();
    } else if (activityDrawerOpen) {
      closeActivityDrawer({ restoreFocus: true });
    } else if (resolvedDrawerOpen) {
      closeResolvedDrawer({ restoreFocus: true });
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
  if (artifactSpokeToken !== artifactLoadToken) armArtifactAvailabilityProbe(artifactLoadToken);
  postToFrame({ type: "lavish:setAnnotationMode", enabled: annotation && !ended });
  // Replay the pre-reload scroll position so hot reloads don't jump the artifact to the top.
  postToFrame({ type: "lavish:restoreScroll", x: lastScroll.x, y: lastScroll.y });
  if (lastReviewState) postToFrame({ type: "lavish:restoreReviewState", state: lastReviewState });
  postQueuedAnchors(true);
  postThreadAnchors(true);
  if (overlayIndex !== null) {
    inlineWhiteboardChannels.delete(overlayIndex);
    postToFrame({ type: "lavish:suspendWhiteboard", diagramIndex: overlayIndex });
  }
});

initializeLayoutGate();

// Margin comments keep only anchor ids, selectors and page-authored range targets in the artifact.
// The reviewer's writing stays in the chrome and the store, outside the agent-authored page's reach.
const marginThreadCanvas = /** @type {HTMLDivElement} */ (document.getElementById("marginThreadCanvas"));

function threadMessageIds(threads) {
  const ids = new Set();
  for (const thread of threads) {
    for (const message of thread.messages || []) if (message.prompt_id) ids.add(message.prompt_id);
  }
  return ids;
}

function draftMessage(prompt) {
  return {
    role: "user",
    text: String(prompt.prompt || "") || attachmentOnlyText({ ...prompt, tag: prompt.tag }),
    prompt_id: promptIdentity(prompt),
    attachments: prompt.attachments,
    anchor: draftThreadId(prompt) === PAGE_THREAD_ID ? promptAnchor(prompt) : null,
    pending: true,
    locked: !isPromptEditable(prompt),
  };
}

// Server threads plus this tab's drafts: an anchored note still waiting to send shows as a
// pending thread, and a draft reply shows at the end of its thread until the server records it.
function visibleThreads() {
  const threads = commentThreads.map((thread) => ({ ...thread, messages: (thread.messages || []).slice() }));
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const recorded = threadMessageIds(threads);
  for (const prompt of queued) {
    const promptId = promptIdentity(prompt);
    const threadId = draftThreadId(prompt);
    if (!promptId || recorded.has(promptId) || threadId === PAGE_THREAD_ID) continue;
    let thread = byId.get(threadId);
    if (!thread && !prompt.thread_id) {
      thread = { id: promptId, anchor: prompt, resolved: false, pending: true, messages: [] };
      threads.push(thread);
      byId.set(thread.id, thread);
    }
    if (!thread) continue;
    thread.messages.push(draftMessage(prompt));
  }
  return threads;
}

// The page thread's messages: the transcript outside every anchored thread, this tab's page
// drafts, and any annotation text Hilight handed back because its anchor disappeared.
function pageThreadMessages() {
  const messages = displayedChat.filter(isPageChatEntry).map((entry) => ({
    ...entry,
    role: entry.role === "agent" ? "agent" : "user",
  }));
  for (const prompt of queued) {
    if (promptIdentity(prompt) && draftThreadId(prompt) === PAGE_THREAD_ID) messages.push(draftMessage(prompt));
  }
  for (const text of retiredDrafts) messages.push({ role: "note", text, unstored: unstoredRetiredDrafts.has(text) });
  return messages;
}

function syncThreads(data) {
  const revision = parseChatRevision(data?.chat_revision);
  if (!Array.isArray(data?.threads) || revision === null || revision < threadSyncRevision) return;
  threadSyncRevision = revision;
  commentThreads = data.threads;
  renderThreads();
}

function postThreadAnchors(force = false) {
  const anchors = visibleThreads()
    .filter((thread) => !thread.resolved)
    .map((thread) => ({ id: thread.id, selector: thread.anchor.selector, target: thread.anchor.target }));
  const serialized = JSON.stringify(anchors);
  if (!force && serialized === lastThreadAnchors) return;
  lastThreadAnchors = serialized;
  postToFrame({ type: "lavish:threadAnchors", anchors });
}

// Thread UI lives in the comments column and the resolved drawer, so queries stay inside them.
function threadNodes(selector) {
  return [comments, resolvedList].flatMap((root) => [...(root?.querySelectorAll(selector) || [])]);
}

function threadCards(id) {
  return threadNodes(".comment-thread").filter((node) => node.getAttribute("data-thread-id") === id);
}

function marginCard(id) {
  if (id === PAGE_THREAD_ID) return pageThread;
  return threadCardCache.get("margin:" + id)?.card || null;
}

function setActiveThread(id, notify = true) {
  activeThreadId = id;
  for (const node of threadNodes(".comment-thread")) {
    node.classList.toggle("is-active", node.getAttribute("data-thread-id") === id);
  }
  if (notify) postToFrame({ type: "lavish:activeThread", id });
}

function saveThreadDrafts() {
  saveJsonState(threadDraftStorageKey, Object.fromEntries(threadDrafts));
}

// The page comment box survives a reload the same way thread reply boxes do: per tab, per session.
function savePageDraft() {
  try {
    if (chatInput.value) sessionStorage.setItem(pageDraftStorageKey, chatInput.value);
    else sessionStorage.removeItem(pageDraftStorageKey);
  } catch {
    // The box still works if browser storage is unavailable; only reload survival is lost.
  }
}

function restorePageDraft() {
  try {
    const stored = sessionStorage.getItem(pageDraftStorageKey);
    if (stored && !chatInput.value) chatInput.value = stored;
  } catch {
    // Nothing stored, or storage unavailable.
  }
}

function autosize(textarea) {
  if (!textarea?.style) return;
  textarea.style.height = "auto";
  textarea.style.height = Math.min(Number(textarea.scrollHeight) || 0, 220) + "px";
}

function pendingThreadPrompt(id) {
  return queued.find((prompt) => promptIdentity(prompt) === id && !prompt.thread_id) || null;
}

// Open = the card shows every message and its reply box. One card is open at a time, as in a
// shared document. A comment that was never sent opens straight into editing its words.
function commentsCollapsed() {
  return document.body.classList.contains("comments-collapsed");
}

/** @param {boolean} collapsed */
function setCommentsCollapsed(collapsed, remember = true) {
  document.body.classList.toggle("comments-collapsed", collapsed);
  const comments = document.getElementById("comments");
  if (comments) comments.inert = collapsed && !isMobileSheet();
  if (commentsToggle) {
    const label = collapsed ? "Show comments" : "Hide comments";
    commentsToggle.setAttribute("aria-expanded", String(!collapsed));
    commentsToggle.setAttribute("aria-label", label);
    commentsToggle.title = label;
  }
  try {
    // "0" records an explicit open, so a narrow board window does not fold it again.
    if (remember) localStorage.setItem(commentsCollapsedKey, collapsed ? "1" : "0");
  } catch {
    // The choice still applies to this page without storage.
  }
  updateSendState();
  if (!collapsed) window.requestAnimationFrame(positionThreads);
}

// Folded comments open again whenever something needs them (a new comment, a
// thread the reviewer opens), so Send to agent is never out of reach. Desktop
// only: the phone sheet keeps its own open and closed rules.
function unfoldComments() {
  if (!isMobileSheet() && commentsCollapsed()) setCommentsCollapsed(false);
}

function openThread(id, { focus = true } = {}) {
  unfoldComments();
  if (!id || ended) return;
  const pending = pendingThreadPrompt(id);
  if (openThreadId !== id) {
    if (editingPromptId && !(pending && promptIdentity(pending) === editingPromptId)) commitQueuedEdit();
    openThreadId = id;
    for (const node of threadNodes(".comment-thread")) {
      if (node.closest?.("#resolvedList")) continue;
      node.classList.toggle("is-open", node.getAttribute("data-thread-id") === id);
    }
  }
  if (pending && isPromptEditable(pending) && editingPromptId !== id) {
    editingPromptId = id;
    editingDraft = String(pending.prompt || "");
    editFocusPending = focus;
  }
  if (isMobileSheet()) setSheetOpen(true);
  renderThreads();
  const card = marginCard(id);
  if (!card) return;
  if (id === PAGE_THREAD_ID) {
    pageMessages.scrollTop = pageMessages.scrollHeight;
    autosize(chatInput);
  }
  animateRestack();
  positionThreads();
  const input = /** @type {HTMLTextAreaElement | null} */ (
    id === PAGE_THREAD_ID ? chatInput : card.querySelector(".thread-edit-input, .thread-reply textarea")
  );
  if (input && id !== PAGE_THREAD_ID && input.classList?.contains?.("thread-reply-input")) {
    input.value = String(threadDrafts.get(id) || "");
  }
  if (focus && input && !input.disabled) input.focus({ preventScroll: true });
  if (isMobileSheet()) card.scrollIntoView?.({ block: "nearest" });
  setActiveThread(id);
}

// Cards track a scroll frame-for-frame; only an open or close animates the restack.
let restackTimer;
function animateRestack() {
  marginThreadCanvas.classList.add("is-animating");
  clearTimeout(restackTimer);
  restackTimer = setTimeout(() => marginThreadCanvas.classList.remove("is-animating"), 240);
}

function closeThread(id, { focusCard = false } = {}) {
  if (openThreadId !== id) return;
  const card = marginCard(id);
  openThreadId = "";
  if (editingPromptId) {
    commitQueuedEdit();
    render();
  }
  for (const node of threadCards(id)) node.classList.remove("is-open");
  threadHeights.delete(id);
  animateRestack();
  positionThreads();
  setActiveThread("");
  if (focusCard && card?.isConnected !== false) card?.focus?.({ preventScroll: true });
}

// Google-Docs placement: every card wants its anchor's top. A card whose resting size would run
// into the next anchor's card shrinks to one compact line, decided from anchor spacing alone so a
// scroll never flips it. The open card (else the first card in view) keeps its exact top; cards
// below it are pushed down and cards above it pushed up, so none overlap. Cards in view never
// tuck under the page bar. Runs on every artifact scroll frame: all reads come before all writes,
// and only the open card is measured each time.
function positionThreads() {
  const canvas = marginThreadCanvas;
  if (!canvas) return;
  const cards = /** @type {HTMLElement[]} */ ([...canvas.children]);
  if (isMobileSheet()) {
    for (const el of cards) {
      el.style.transform = "";
      el.classList.remove("is-compact");
    }
    return;
  }
  if (!pageBarHeight && pageThread.offsetHeight && !pageThread.classList.contains("is-open")) {
    pageBarHeight = pageThread.offsetHeight;
  }
  const floor = (Number(pageThread.offsetTop) || 0) + pageBarHeight + THREAD_CARD_GAP;
  const unmeasured = cards.filter((el) => {
    const id = el.getAttribute("data-thread-id") || "";
    return id !== openThreadId && !threadHeights.has(id);
  });
  for (const el of unmeasured) el.classList.remove("is-compact");
  for (const el of unmeasured) threadHeights.set(el.getAttribute("data-thread-id") || "", el.offsetHeight);
  const items = cards
    .map((el) => {
      const id = el.getAttribute("data-thread-id") || "";
      const geometry = threadGeometry.get(id);
      const placed = Number.isFinite(geometry?.top) && geometry?.missing !== true;
      const open = id === openThreadId;
      return {
        el,
        id,
        open,
        placed,
        anchor: placed ? Number(geometry.top) : 0,
        height: open ? el.offsetHeight : threadHeights.get(id) || THREAD_COMPACT_HEIGHT,
        compact: false,
      };
    })
    .filter((item) => {
      item.el.classList.toggle("is-unplaced", !item.placed);
      return item.placed;
    })
    .sort((a, b) => a.anchor - b.anchor);
  for (let i = 0; i + 1 < items.length; i++) {
    if (items[i + 1].anchor - items[i].anchor >= items[i].height + THREAD_CARD_GAP) continue;
    if (!items[i].open) items[i].compact = true;
    if (!items[i + 1].open) items[i + 1].compact = true;
  }
  for (const item of items) if (item.compact) item.height = THREAD_COMPACT_HEIGHT;
  const desired = items.map((item) => (item.anchor >= 0 ? Math.max(item.anchor, floor) : item.anchor));
  let pivot = items.findIndex((item) => item.open);
  if (pivot === -1)
    pivot = Math.max(
      0,
      items.findIndex((item) => item.anchor >= 0),
    );
  const tops = desired.slice();
  for (let i = pivot + 1; i < items.length; i++) {
    tops[i] = Math.max(desired[i], tops[i - 1] + items[i - 1].height + THREAD_CARD_GAP);
  }
  for (let i = pivot - 1; i >= 0; i--) {
    tops[i] = Math.min(desired[i], tops[i + 1] - THREAD_CARD_GAP - items[i].height);
  }
  // Cards whose anchors are on screen never sit under the pinned Send button: the bottom of the
  // stack is lifted above it (and cards above are lifted with it), like the page-bar floor on top.
  const ceiling = (comments.clientHeight || 0) - (commentsFoot.offsetHeight || 0) - THREAD_CARD_GAP;
  if (ceiling > floor) {
    let limit = ceiling;
    for (let i = items.length - 1; i >= 0; i--) {
      // Anchors below the button line but still on screen (the last line of a page) lift too, and
      // the open card always does, so the card being typed in is never under the button.
      if (!items[i].open && items[i].anchor >= (comments.clientHeight || 0)) continue;
      if (tops[i] + items[i].height > limit) tops[i] = limit - items[i].height;
      limit = tops[i] - THREAD_CARD_GAP;
    }
  }
  items.forEach((item, i) => {
    item.el.classList.toggle("is-compact", item.compact);
    item.el.style.transform = "translateY(" + Math.round(tops[i]) + "px)";
  });
}

function showResolveToast(id) {
  resolveToastThreadId = id;
  resolveToastText.textContent = "Resolved";
  resolveToast.hidden = false;
  clearTimeout(resolveToastTimer);
  resolveToastTimer = setTimeout(hideResolveToast, RESOLVE_TOAST_MS);
}

function hideResolveToast() {
  clearTimeout(resolveToastTimer);
  resolveToastTimer = undefined;
  resolveToastThreadId = "";
  resolveToast.hidden = true;
}

function undoResolve() {
  const id = resolveToastThreadId;
  hideResolveToast();
  if (id) setThreadResolved(id, false);
}

async function setThreadResolved(id, resolved, card = marginCard(id)) {
  const error = card?.querySelector?.(".thread-error");
  if (error) error.textContent = "";
  try {
    const response = await fetch("/api/" + encodeURIComponent(key) + "/threads/" + encodeURIComponent(id), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolved }),
    });
    if (!response.ok) throw new Error("request failed");
    if (resolved) closeThread(id);
    syncThreads(await response.json());
    if (resolved) {
      showResolveToast(id);
    } else {
      // Reopened: back in its place with its whole history, and the page shows where.
      if (resolveToastThreadId === id) hideResolveToast();
      closeResolvedDrawer();
      postToFrame({ type: "lavish:revealThread", id });
      openThread(id, { focus: false });
    }
  } catch {
    if (error) error.textContent = resolved ? "Could not resolve. Try again." : "Could not reopen. Try again.";
  }
}

// Enter in a thread's reply box saves a draft reply. Nothing reaches the agent until Send, which
// delivers every draft on the page in one batch.
function sendThreadReply(thread, input) {
  const text = input.value.trim();
  if (!text || ended || terminalSubmission) return;
  const prompt = {
    uid: "",
    prompt: text,
    selector: thread.anchor.selector,
    tag: "message",
    text: "Reply in comment thread " + thread.id,
    thread_id: thread.id,
  };
  assignPromptIdentity(prompt, false);
  queued.push(prompt);
  persistQueuedPrompts();
  threadDrafts.delete(thread.id);
  saveThreadDrafts();
  input.value = "";
  render();
  openThread(thread.id);
}

function threadEntryFor(message) {
  return message.prompt_id ? displayedChat.find((entry) => entry.prompt_id === message.prompt_id) || null : null;
}

// One plain word per thread for where its latest message stands. Drafts come first: a thread
// with an unsent note is Not sent (Sending while its batch is in flight, Not delivered after a
// failed send); otherwise an agent answer reads Replied and a sent note reads its receipt.
/** @returns {{ text: string, retry: boolean, at?: string, trail?: string } | null} */
function threadStatus(messages) {
  const drafts = messages.filter((message) => message.pending);
  if (drafts.length) {
    const prompts = drafts.map((message) => queued.find((prompt) => promptIdentity(prompt) === message.prompt_id));
    if (prompts.some((prompt) => prompt && isPromptSending(prompt))) return { text: "Sending", retry: false };
    if (sendFailureOwner && sendFailureOwner.kind !== "preparation") return { text: "Not delivered", retry: true };
    return { text: "Not sent", retry: false };
  }
  const last = [...messages].reverse().find((message) => message.role === "user" || message.role === "agent");
  if (!last) return null;
  if (last.role === "agent") return { text: "Replied", retry: false, ...deliveryTimes(null, last) };
  const entry = threadEntryFor(last) || last;
  return { text: deliveryLabel(entry), retry: false, ...deliveryTimes(entry, null) };
}

// When the latest state happened (shown beside the word) and the whole trail (its tooltip):
// sent, delivered to the agent, working, answered.
function deliveryTimes(entry, answer) {
  if (answer) {
    const at = clockTime(answer.at);
    return at ? { at, trail: `Answered by the agent at ${at}` } : {};
  }
  if (!entry || entry.receipt === "none") return {};
  const steps = [
    ["Sent", entry.at],
    ["delivered to the agent", entry.delivered_at],
    ["agent working", entry.working_at],
    ["answered", entry.done_at],
  ]
    .map(([label, iso]) => [label, clockTime(iso)])
    .filter(([, at]) => at);
  if (!steps.length) return {};
  return { at: steps[steps.length - 1][1], trail: steps.map(([label, at]) => `${label} ${at}`).join(" · ") };
}

function timeHtml(status) {
  if (!status?.at) return "";
  return (
    '<time class="thread-time" title="' + escapeHtml(status.trail || "") + '">' + escapeHtml(status.at) + "</time>"
  );
}

function statusHtml(status) {
  if (!status) return "";
  return (
    escapeHtml(status.text) +
    (status.retry ? ' · <button type="button" class="text-button thread-retry">Retry</button>' : "")
  );
}

function anchorLineHtml(anchor) {
  if (!anchor || typeof anchor !== "object") return "";
  const words = [anchor.label, anchor.excerpt].filter(Boolean).map(String).join(" · ");
  return words ? '<div class="thread-anchor-line">' + escapeHtml(words) + "</div>" : "";
}

function threadMessageHtml(message, editing, showAnchor) {
  if (message.role === "note") {
    return (
      '<div class="thread-author">Unsent annotation</div><div class="thread-body">The artifact removed or replaced what this note was attached to, so Hilight could not keep it open. Your text is kept here:</div><div class="thread-body note-draft">' +
      escapeHtml(message.text) +
      "</div>" +
      (message.unstored
        ? '<div class="thread-body note-warning">This browser refused to store it, so copy it before you reload this page.</div>'
        : "")
    );
  }
  const agent = message.role === "agent";
  const body = agent ? message.html || escapeHtml(message.text) : escapeHtml(message.text).replace(/\n/g, "<br>");
  return (
    '<div class="thread-author">' +
    (agent ? "Agent" : "You") +
    (message.pending && !message.locked && !editing
      ? '<span class="thread-message-actions"><button type="button" class="text-button thread-edit">Edit</button><button type="button" class="text-button thread-delete">Delete</button></span>'
      : "") +
    "</div>" +
    (showAnchor ? anchorLineHtml(message.anchor) : "") +
    (editing
      ? '<textarea class="thread-edit-input" rows="1" aria-label="Edit this comment"></textarea><div class="thread-reply-row"><span class="thread-hint">Enter saves · Esc closes</span><button type="button" class="text-button thread-delete">Delete</button></div>'
      : '<div class="thread-body">' + (agent ? '<div class="chat-md">' + body + "</div>" : body) + "</div>")
  );
}

function threadSignature(thread, placement, missing, messages, status) {
  return JSON.stringify([
    placement,
    missing,
    thread.resolved,
    Boolean(thread.pending),
    ended,
    Boolean(terminalSubmission),
    thread.anchor?.text,
    thread.anchor?.selector,
    status,
    messages.map((message) => [
      message.role,
      message.text,
      message.html || "",
      Boolean(message.pending),
      Boolean(message.locked),
      message.pending && message.prompt_id === editingPromptId,
      message.unstored || false,
      message.revision_id
        ? Boolean(revisionEntries.find((entry) => entry.id === message.revision_id)?.marks.length)
        : null,
      attachmentCount(message),
    ]),
  ]);
}

function queuedIndexOf(promptId) {
  return queued.findIndex((prompt) => promptIdentity(prompt) === promptId);
}

// Fills a thread's message list. A resting card shows its root comment and its latest message,
// with the middle folded behind a count; the open card shows everything.
function fillThreadMessages(list, messages, { showAnchors = false } = {}) {
  messages.forEach((message, index) => {
    const item = document.createElement("li");
    const editing = Boolean(message.pending && message.prompt_id && message.prompt_id === editingPromptId);
    item.className =
      "thread-message " +
      (message.role === "agent" ? "agent" : message.role === "note" ? "note" : "user") +
      (message.pending ? " is-draft" : "");
    if (messages.length > THREAD_COLLAPSE_AFTER && index > 0 && index < messages.length - 1) {
      item.classList.add("is-middle");
    }
    item.innerHTML = threadMessageHtml(message, editing, showAnchors);
    if (attachmentCount(message)) {
      const attachments = document.createElement("div");
      attachments.innerHTML = bubbleAttachmentsHtml(message);
      item.appendChild(attachments);
    }
    if (message.revision_id) {
      const reveal = document.createElement("button");
      reveal.type = "button";
      reveal.className = "text-button thread-reveal";
      reveal.textContent = "Reveal change";
      const revision = revisionEntries.find((entry) => entry.id === message.revision_id);
      reveal.disabled = !revision?.marks.length;
      reveal.title = reveal.disabled
        ? "This revision has no marked block on the current page"
        : "Jump to the block the agent changed";
      reveal.addEventListener("click", (event) => {
        event.stopPropagation();
        revealNextRevisionMark(message.revision_id);
      });
      item.appendChild(reveal);
    }
    if (message.pending && message.prompt_id) {
      item.querySelector(".thread-edit")?.addEventListener("click", (event) => {
        event.stopPropagation();
        const index = queuedIndexOf(message.prompt_id);
        if (index !== -1) editQueuedPrompt(index, { reveal: false });
      });
      for (const button of item.querySelectorAll(".thread-delete")) {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          if (editingPromptId === message.prompt_id) endQueuedEdit();
          const index = queuedIndexOf(message.prompt_id);
          if (index !== -1) removeQueuedPrompt(index);
        });
      }
      const editor = /** @type {HTMLTextAreaElement | null} */ (item.querySelector(".thread-edit-input"));
      if (editor) {
        editor.value = editingDraft;
        editor.addEventListener("input", () => {
          editingDraft = String(editor.value || "");
          autosize(editor);
        });
        editor.addEventListener("keydown", (event) => {
          if (event.isComposing || event.keyCode === 229) return;
          // The annotation card's keys: Enter keeps the words, Shift+Enter breaks the line, and
          // Esc closes keeping what was typed.
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            const threadId = openThreadId;
            saveQueuedEdit();
            if (threadId && threadId !== PAGE_THREAD_ID && !pendingThreadPrompt(threadId)) openThread(threadId);
            else closeThread(threadId, { focusCard: true });
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeThread(openThreadId, { focusCard: true });
          }
        });
      }
    }
    list.appendChild(item);
    if (messages.length > THREAD_COLLAPSE_AFTER && index === 0) {
      const more = document.createElement("li");
      more.className = "thread-more";
      const hidden = messages.length - 2;
      more.textContent = hidden + (hidden === 1 ? " more reply" : " more replies");
      list.appendChild(more);
    }
  });
}

function bindStatusRetry(root) {
  root.querySelector?.(".thread-retry")?.addEventListener("click", (event) => {
    event.stopPropagation();
    sendQueued(Boolean(terminalSubmission));
  });
}

function bindCardHover(card, id) {
  card.addEventListener("mouseenter", () => setActiveThread(id));
  card.addEventListener("mouseleave", () => {
    if (!card.contains(document.activeElement)) setActiveThread(openThreadId);
  });
  card.addEventListener("focusin", () => setActiveThread(id));
  card.addEventListener("focusout", (event) => {
    if (!card.contains(/** @type {Node | null} */ (event.relatedTarget))) setActiveThread(openThreadId);
  });
}

function buildThreadCard(thread, placement, missing, messages, status) {
  const inDrawer = placement === "drawer";
  const card = document.createElement("article");
  card.className = "comment-thread" + (thread.pending ? " is-pending" : "") + (thread.resolved ? " is-resolved" : "");
  card.dataset.threadId = thread.id;
  card.tabIndex = 0;
  // A table-cell draft names its row and column, which the raw cell text alone would lose.
  const cell = thread.pending ? promptAnchor(thread.anchor) : null;
  // A canvas card's title alone reads like a sentence of its own ("Poll takes the whole batch"), so
  // the row says it is the card the comment is on.
  const boardCard = thread.anchor?.target?.type === "board-card" ? thread.anchor.target : null;
  const quote = String(
    (cell?.kind === "cell" && cell.excerpt) ||
      boardCard?.title ||
      thread.anchor.text ||
      thread.anchor.selector ||
      "Comment",
  )
    .replace(/\s+/g, " ")
    .trim();
  const headline = boardCard ? "On card: " + quote : quote;
  card.setAttribute("aria-label", (boardCard ? "Comment on card " : "Comment on ") + quote.slice(0, 120));
  // A compact card sits beside its anchor, so its one line says what was last written there.
  const latest = [...messages].reverse().find((message) => message.role === "user" || message.role === "agent");
  const snippet = latest
    ? (latest.role === "agent" ? "Agent: " : "You: ") +
      String(latest.text || "")
        .replace(/\s+/g, " ")
        .trim()
    : quote;
  card.innerHTML =
    '<header class="thread-head"><button type="button" class="thread-quote" title="Show in page">' +
    escapeHtml(headline) +
    '</button><span class="thread-snippet" aria-hidden="true">' +
    escapeHtml(snippet.slice(0, 160)) +
    '</span><span class="thread-status">' +
    statusHtml(status) +
    "</span>" +
    timeHtml(status) +
    // A resolved comment is a one-line row; Reopen sits on it, never behind an expand.
    (thread.resolved ? '<button type="button" class="text-button thread-reopen">Reopen</button>' : "") +
    "</header>" +
    (missing ? '<p class="thread-notice">The text this comment was on is no longer on the page.</p>' : "") +
    '<ol class="thread-messages"></ol><div class="thread-error" role="status"></div>';
  fillThreadMessages(card.querySelector(".thread-messages"), messages);
  bindStatusRetry(card);
  card.querySelector(".thread-quote").addEventListener("click", (event) => {
    event.stopPropagation();
    postToFrame({ type: "lavish:revealThread", id: thread.id });
    if (inDrawer) card.classList.toggle("is-open");
    else openThread(thread.id);
  });
  if (thread.resolved) {
    card.querySelector(".thread-reopen").addEventListener("click", (event) => {
      event.stopPropagation();
      setThreadResolved(thread.id, false, card);
    });
  } else if (!thread.pending && !ended) {
    const form = document.createElement("form");
    form.className = "thread-reply";
    form.innerHTML =
      '<textarea class="thread-reply-input" rows="1" aria-label="Reply to this comment" placeholder="Reply"></textarea><div class="thread-reply-row"><span class="thread-hint">Enter saves · Esc closes</span><button type="button" class="text-button thread-resolve">Resolve</button></div>';
    const input = /** @type {HTMLTextAreaElement} */ (form.querySelector("textarea"));
    input.value = String(threadDrafts.get(thread.id) || "");
    input.disabled = Boolean(terminalSubmission);
    input.addEventListener("input", () => {
      if (input.value) threadDrafts.set(thread.id, input.value);
      else threadDrafts.delete(thread.id);
      saveThreadDrafts();
      autosize(input);
      if (!inDrawer) positionThreads();
    });
    input.addEventListener("keydown", (event) => {
      // WebKit fires compositionend before the IME-confirming keydown, leaving only keyCode 229.
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendThreadReply(thread, input);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (inDrawer) card.classList.remove("is-open");
        else closeThread(thread.id, { focusCard: true });
      }
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      sendThreadReply(thread, input);
    });
    form.querySelector(".thread-resolve").addEventListener("click", (event) => {
      event.stopPropagation();
      setThreadResolved(thread.id, true, card);
    });
    card.appendChild(form);
  }
  card.addEventListener("click", (event) => {
    const target = /** @type {Element} */ (event.target);
    if (target.closest?.("button, a, textarea")) return;
    if (inDrawer) card.classList.add("is-open");
    else if (!thread.resolved) openThread(thread.id);
  });
  if (!inDrawer) bindCardHover(card, thread.id);
  return card;
}

function threadCard(thread, placement, missing) {
  const messages = thread.messages || [];
  const status = threadStatus(messages);
  const cacheKey = placement + ":" + thread.id;
  const signature = threadSignature(thread, placement, missing, messages, status);
  const cached = threadCardCache.get(cacheKey);
  let card = cached?.card;
  if (cached?.signature !== signature) {
    card = buildThreadCard(thread, placement, missing, messages, status);
    if (placement === "margin") threadHeights.delete(thread.id);
  }
  threadCardCache.set(cacheKey, { signature, card });
  if (placement === "margin") {
    card.classList.toggle("is-open", openThreadId === thread.id);
    card.classList.toggle("is-active", activeThreadId === thread.id);
  }
  return card;
}

function threadAnchorTop(thread) {
  const top = threadGeometry.get(thread.id)?.top;
  return Number.isFinite(top) ? Number(top) : Number.POSITIVE_INFINITY;
}

// The page thread is a fixed element so its comment box, images and draft survive every render.
// Only its message list is rebuilt, and only when what it shows changed.
function renderPageThread() {
  const messages = pageThreadMessages();
  const status = threadStatus(messages);
  const signature = threadSignature(
    { id: PAGE_THREAD_ID, anchor: {}, resolved: false },
    "page",
    false,
    messages,
    status,
  );
  pageThread.classList.toggle("is-open", openThreadId === PAGE_THREAD_ID);
  pageThread.classList.toggle("is-active", activeThreadId === PAGE_THREAD_ID);
  pageThread.classList.toggle("is-empty", messages.length === 0);
  if (signature === pageSignature) return;
  pageSignature = signature;
  pageThreadStatus.innerHTML = statusHtml(status);
  if (pageThreadTime) {
    pageThreadTime.textContent = status?.at || "";
    pageThreadTime.title = status?.trail || "";
  }
  bindStatusRetry(pageThreadStatus);
  // A new reply never yanks the reader: the list follows the end only if they were already there.
  const atEnd = pageMessages.scrollTop + pageMessages.clientHeight >= pageMessages.scrollHeight - 4;
  const scrollTop = pageMessages.scrollTop;
  pageMessages.replaceChildren();
  if (!messages.length) {
    const empty = document.createElement("li");
    empty.className = "thread-empty";
    empty.textContent = "Comment on the whole page";
    pageMessages.appendChild(empty);
  }
  fillThreadMessages(pageMessages, messages, { showAnchors: true });
  pageMessages.scrollTop = atEnd ? pageMessages.scrollHeight : scrollTop;
  if (openThreadId !== PAGE_THREAD_ID) pageBarHeight = 0;
}

function renderResolvedDrawer(threads, missing) {
  const resolved = threads.filter((thread) => thread.resolved);
  const offPage = threads.filter((thread) => !thread.resolved && missing(thread));
  threadCounts = { resolved: resolved.length, offPage: offPage.length };
  renderStatusPill();
  const nodes = [];
  if (offPage.length) {
    const heading = document.createElement("div");
    heading.className = "thread-group";
    heading.textContent = "No longer on the page";
    nodes.push(heading, ...offPage.map((thread) => threadCard(thread, "drawer", true)));
  }
  if (resolved.length) {
    const heading = document.createElement("div");
    heading.className = "thread-group";
    heading.textContent = "Resolved";
    nodes.push(heading, ...resolved.map((thread) => threadCard(thread, "drawer", missing(thread))));
  }
  resolvedList.replaceChildren(...nodes);
}

function setResolvedDrawerOpen(open) {
  resolvedDrawerOpen = Boolean(open) && !ended && !resolvedWrap.hidden;
  resolvedDrawer.hidden = !resolvedDrawerOpen;
  resolvedButton.setAttribute("aria-expanded", String(resolvedDrawerOpen));
  if (resolvedDrawerOpen) closeMenus();
}

function closeResolvedDrawer({ restoreFocus = false } = {}) {
  if (!resolvedDrawerOpen) return;
  setResolvedDrawerOpen(false);
  if (restoreFocus) resolvedButton.focus();
}

// Activity: the session's history from server.log, newest first, so the reviewer can see when a
// comment reached the agent, when it answered, and why it stopped listening.
function setActivityDrawerOpen(open) {
  if (!activityDrawer) return;
  activityDrawerOpen = Boolean(open) && !ended;
  activityDrawer.hidden = !activityDrawerOpen;
  activityOpenButton?.setAttribute("aria-expanded", String(activityDrawerOpen));
  if (activityDrawerOpen) {
    setMenuOpen(moreButton, moreMenu, false);
    void loadActivity();
  }
}

function closeActivityDrawer({ restoreFocus = false } = {}) {
  if (!activityDrawerOpen) return;
  setActivityDrawerOpen(false);
  if (restoreFocus) moreButton.focus();
}

async function loadActivity() {
  if (!activityList || !activityNow) return;
  const request = ++activityRequest;
  let history;
  try {
    const response = await fetch(`/api/${key}/history`);
    history = response.ok ? await response.json() : null;
  } catch {
    history = null;
  }
  if (request !== activityRequest) return;
  renderActivity(history);
}

function renderActivity(history) {
  if (!activityList || !activityNow) return;
  if (!history) {
    activityNow.textContent = "Activity is not available: Hilight did not answer.";
    activityList.replaceChildren();
    return;
  }
  const stopped =
    history.stopped && history.stopped.at ? { since: history.stopped.at, why: history.stopped.why } : null;
  activityNow.textContent =
    history.presence === "listening"
      ? "Your agent is listening. Send delivers right away."
      : history.presence === "working"
        ? "Your agent is working on what you sent. New comments reach it on its next poll."
        : stopped
          ? notListeningSentence(stopped)
          : "No agent is listening. Comments you send will queue until it polls.";
  const events = Array.isArray(history.events) ? [...history.events].reverse() : [];
  if (!events.length) {
    const empty = document.createElement("li");
    empty.className = "activity-empty";
    empty.textContent = "Nothing recorded yet.";
    activityList.replaceChildren(empty);
    return;
  }
  activityList.replaceChildren(
    ...events.map((event) => {
      const item = document.createElement("li");
      item.className = "activity-item";
      const time = document.createElement("time");
      time.className = "activity-time";
      time.dateTime = String(event.at || "");
      time.textContent = clockTime(event.at);
      const text = document.createElement("span");
      text.className = "activity-text";
      text.textContent = String(event.text || "");
      item.append(time, text);
      return item;
    }),
  );
}

function renderThreads() {
  const canvas = marginThreadCanvas;
  if (!canvas || !pageThread) return;
  const focused = /** @type {HTMLTextAreaElement | null} */ (
    document.activeElement?.closest?.(".comment-thread") ? document.activeElement : null
  );
  const caret = focused?.tagName === "TEXTAREA" ? [focused.selectionStart, focused.selectionEnd] : null;
  const focusedCard = focused?.closest?.(".comment-thread");
  const focusedKey = focusedCard
    ? (focusedCard.closest?.("#resolvedList") ? "drawer:" : "margin:") + focusedCard.getAttribute("data-thread-id")
    : "";
  const focusedEditor = focused?.classList?.contains?.("thread-edit-input");
  // The open card's history keeps the reader's place when an answer lands in it.
  const openList = marginCard(openThreadId)?.querySelector?.(".thread-messages");
  const openScroll = openList
    ? {
        top: openList.scrollTop,
        atEnd: openList.scrollTop + openList.clientHeight >= openList.scrollHeight - 4,
      }
    : null;
  const threads = visibleThreads();
  const missing = (thread) => threadGeometry.get(thread.id)?.missing === true;
  const inMargin = threads
    .filter((thread) => !thread.resolved && !missing(thread))
    .sort((a, b) => threadAnchorTop(a) - threadAnchorTop(b));
  renderPageThread();
  canvas.replaceChildren(...inMargin.map((thread) => threadCard(thread, "margin", false)));
  const live = new Set(threads.map((thread) => thread.id));
  for (const cacheKey of threadCardCache.keys()) {
    if (!live.has(cacheKey.slice(cacheKey.indexOf(":") + 1))) threadCardCache.delete(cacheKey);
  }
  for (const id of threadHeights.keys()) if (!live.has(id)) threadHeights.delete(id);
  renderResolvedDrawer(threads, missing);
  if (openThreadId && openThreadId !== PAGE_THREAD_ID && !live.has(openThreadId)) openThreadId = "";
  const nextOpenList = marginCard(openThreadId)?.querySelector?.(".thread-messages");
  if (openScroll && nextOpenList && nextOpenList !== openList) {
    nextOpenList.scrollTop = openScroll.atEnd ? nextOpenList.scrollHeight : openScroll.top;
  }
  postThreadAnchors();
  positionThreads();
  // A card rebuilt under the reviewer's caret (say, an agent answer arriving mid-reply) hands focus
  // and the caret to its replacement; the draft text itself is already in threadDrafts.
  const replacement = threadCardCache.get(focusedKey)?.card;
  let target = focused?.isConnected
    ? focused
    : caret
      ? /** @type {HTMLTextAreaElement | null} */ (
          replacement?.querySelector(focusedEditor ? ".thread-edit-input" : ".thread-reply textarea")
        )
      : null;
  if (editFocusPending) {
    const editor = /** @type {HTMLTextAreaElement | null} */ (
      threadNodes(".thread-edit-input").find((node) => node.isConnected !== false) || null
    );
    if (editor) {
      editFocusPending = false;
      editor.focus({ preventScroll: true });
      editor.setSelectionRange?.(editor.value.length, editor.value.length);
      autosize(editor);
      return;
    }
  }
  if (target && document.activeElement !== target && target.isConnected) {
    target.focus({ preventScroll: true });
    if (caret) target.setSelectionRange(caret[0], caret[1]);
  }
}

// Keyboard review: with a card focused, j/k or the arrow keys walk the comments in page order
// and bring each anchor into view, Enter opens the card, Esc closes it.
function threadOrder() {
  const cards = /** @type {HTMLElement[]} */ ([...marginThreadCanvas.children]).sort(
    (a, b) =>
      (threadGeometry.get(a.getAttribute("data-thread-id"))?.top ?? Infinity) -
      (threadGeometry.get(b.getAttribute("data-thread-id"))?.top ?? Infinity),
  );
  return [pageThread, ...cards];
}

commentsBody.addEventListener("keydown", (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  if (!target?.classList?.contains?.("comment-thread")) return;
  const id = target.getAttribute("data-thread-id") || "";
  const step =
    event.key === "j" || event.key === "ArrowDown" ? 1 : event.key === "k" || event.key === "ArrowUp" ? -1 : 0;
  if (step && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    const order = threadOrder();
    const next = order[order.indexOf(target) + step];
    if (!next) return;
    const nextId = next.getAttribute("data-thread-id") || "";
    if (nextId !== PAGE_THREAD_ID) postToFrame({ type: "lavish:revealThread", id: nextId });
    next.focus({ preventScroll: true });
    setActiveThread(nextId);
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openThread(id);
  } else if (event.key === "Escape" && openThreadId === id) {
    event.preventDefault();
    event.stopPropagation();
    closeThread(id, { focusCard: true });
  }
});

pageThread.addEventListener("click", (event) => {
  const target = /** @type {Element} */ (event.target);
  if (target.closest?.("button, a, textarea, input")) return;
  if (openThreadId !== PAGE_THREAD_ID) openThread(PAGE_THREAD_ID);
});
bindCardHover(pageThread, PAGE_THREAD_ID);

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
  if (isPageChatEntry(entry)) {
    displayedChat.push(entry);
    renderThreads();
  }
  noteAgentReply(entry.text);
});
events.set("chat-sync", (data) => {
  rememberChatAckIds(data.ack_ids);
  syncChat(data.chat || [], data.chat_revision);
  // After the transcript, so thread cards read fresh delivery receipts.
  syncThreads(data);
});
events.set("agent-presence", (data) => {
  agentStopped =
    data.state === "waiting" && data.since ? { since: String(data.since), why: String(data.why || "") } : null;
  setAgentPresence(data.mode === "external-listener" ? "external" : data.state);
  if (activityDrawerOpen) void loadActivity();
});
events.set("layout-warnings", (data) => setLayoutWarnings(data.warnings || []));
events.set("ended", () => markSessionEnded());
connectLiveEvents();

restorePageDraft();
applySheetState();
settleQueuedFromTranscript(initialChat, false);
render();
setChromeOutdated(false);
setWarningsDrawerOpen(false);
renderWarnings();
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
