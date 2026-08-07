import crypto from "node:crypto";

// dealernet: titulos e rotulos exibidos vem da fonte unica de texto de interface.
import { ESTADOS_AVISO, REGRAS_LAYOUT, VIEWPORTS } from "./i18n-ptbr.js";

// The passive layout-warning inbox. Detection is passive: a browser diagnostic pass never wakes
// an agent and never triggers a repair. Findings land here as durable records the user triages
// from the Lavish top bar, and only an explicit "Queue selected fixes" turns them into an
// ordinary queued prompt.
//
// Every rule in this module is a lifecycle rule, and the lifecycle is deliberately conservative:
// a warning is only ever cleared by positive evidence (a newer artifact load plus a complete
// diagnostic pass for the same viewport class that no longer detects it). Absence of evidence -
// a failed pass, a different viewport, a reload in flight, a closed drawer, a delivered prompt -
// never clears anything.

export const LAYOUT_WARNING_STATUSES = [
  "open",
  "queued",
  "recurring",
  "unverified",
  "reopened",
  "resolved",
  "dismissed",
  "obsolete",
];

// Statuses that still count as unresolved work in the top-bar badge.
export const ACTIVE_LAYOUT_WARNING_STATUSES = ["open", "queued", "recurring", "unverified", "reopened"];

export const DEFAULT_DIAGNOSTIC_VIEWPORT_CLASSES = ["mobile", "compact", "desktop"];

const MAX_HISTORY_ENTRIES = 20;
const MAX_SERIALIZED_HISTORY_ENTRIES = 10;
const MAX_STORED_WARNINGS = 200;
const MAX_QUEUED_WARNINGS_PER_PROMPT = 50;

export function viewportClassFor(viewportWidth) {
  const width = finiteNumber(viewportWidth);
  if (width <= 640) return "mobile";
  if (width <= 1024) return "compact";
  return "desktop";
}

export function viewportClassLabel(viewportClass) {
  if (viewportClass === "mobile") return VIEWPORTS.mobile;
  if (viewportClass === "compact") return VIEWPORTS.compact;
  return VIEWPORTS.desktop;
}

// Stable identity: the diagnostic rule, the normalized target identity, and the viewport class.
// Magnitude is deliberately excluded so a finding that gets worse (or slightly better) updates
// the one record instead of inflating the count with a near-duplicate.
export function layoutWarningFingerprint({ rule, target, viewportClass }) {
  const payload = `${normalizeText(rule)}|${normalizeText(target)}|${normalizeText(viewportClass)}`;
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// The human-readable component identity for a CSS-path selector: the most specific id, then the
// first class, then the trailing tag. Returns "" when the selector carries no usable identity.
export function componentIdentity(selector) {
  const last = normalizeText(selector).split(">").pop()?.trim() || "";
  if (!last) return "";
  const id = last.match(/#([A-Za-z0-9_-]+)/);
  if (id) return `#${id[1]}`;
  const className = last.match(/\.([A-Za-z0-9_-]+)/);
  if (className) return `.${className[1]}`;
  const tag = last.match(/^([A-Za-z][A-Za-z0-9-]*)/);
  return tag ? tag[1] : "";
}

// dealernet: os titulos vem de src/i18n-ptbr.js; as explicacoes sao interpoladas com medidas e
// ficam aqui. Este texto e exibido para a PESSOA no inbox, entao e computado no servidor — o
// chrome renderiza o que recebe e nunca decide sozinho (invariante do upstream, mantido).
const RULE_DESCRIPTIONS = {
  "page-horizontal-overflow": {
    title: REGRAS_LAYOUT["page-horizontal-overflow"],
    explain: (warning) =>
      `A pagina esta ${pxText(warning.overflowPx)} mais larga que a area visivel de ${pxText(warning.viewportWidth)}, entao parte do conteudo fica fora da tela.`,
  },
  "clipped-text": {
    title: REGRAS_LAYOUT["clipped-text"],
    explain: (warning) =>
      `O texto renderizado ultrapassa a borda ${axisEdge(warning.axis)} do container em ${pxText(warning.overflowPx)} e fica escondido.`,
  },
  "clipped-control": {
    title: REGRAS_LAYOUT["clipped-control"],
    explain: (warning) =>
      `Um controle necessario ultrapassa a borda ${axisEdge(warning.axis)} do container em ${pxText(warning.overflowPx)}, entao parte dele nao pode ser usada.`,
  },
  "viewport-unreachable-control": {
    title: REGRAS_LAYOUT["viewport-unreachable-control"],
    explain: (warning) =>
      `Um controle necessario esta ${pxText(warning.overflowPx)} alem da borda ${axisEdge(warning.axis)} da area visivel e nao pode ser alcancado.`,
  },
  "viewport-unreachable-content": {
    title: REGRAS_LAYOUT["viewport-unreachable-content"],
    explain: (warning) =>
      `O texto renderizado esta ${pxText(warning.overflowPx)} alem da borda ${axisEdge(warning.axis)} da area visivel e nao pode ser lido.`,
  },
  "overlapping-text": {
    title: REGRAS_LAYOUT["overlapping-text"],
    explain: () => "Um elemento opaco cobre quase todo este texto, entao ele nao pode ser lido.",
  },
};

// Accepts either the stored record (snake_case) or a raw finding (camelCase) so the one set of
// user-facing strings serves both the inbox and any direct description of a fresh observation.
export function describeLayoutWarning(warning) {
  const normalized = {
    axis: warning?.axis,
    overflowPx: warning?.overflow_px ?? warning?.overflowPx,
    viewportWidth: warning?.viewport_width ?? warning?.viewportWidth,
  };
  const description = RULE_DESCRIPTIONS[warning?.rule ?? warning?.kind];
  if (!description) {
    return {
      title: "Falha de layout",
      explanation: `O navegador comprovou uma falha grave de layout neste elemento${normalized.overflowPx ? ` (${pxText(normalized.overflowPx)})` : ""}.`,
    };
  }
  return { title: description.title, explanation: description.explain(normalized) };
}

// dealernet: rotulos de estado do inbox, tambem exibidos para a pessoa.
const STATUS_LABELS = ESTADOS_AVISO;

export function layoutWarningStatusLabel(status) {
  return STATUS_LABELS[status] || ESTADOS_AVISO.open;
}

export function isActiveLayoutWarning(warning) {
  return ACTIVE_LAYOUT_WARNING_STATUSES.includes(String(warning?.status || ""));
}

export function activeLayoutWarnings(warnings) {
  return (Array.isArray(warnings) ? warnings : []).filter(isActiveLayoutWarning);
}

export function activeLayoutWarningCount(warnings) {
  return activeLayoutWarnings(warnings).length;
}

// A repair request is outstanding while a queued warning has not yet been re-checked against a
// newer artifact revision. `recurring` means the newer pass still found it, so asking again is
// legitimate; `queued` and a `queued` warning knocked to `unverified` are not.
// `queued_at` - not `queued_revision` - is the marker for "a repair was requested", because a
// revision of 0 is a legitimate value and would otherwise read as "never queued".
export function hasOutstandingRepairRequest(warning) {
  if (!warning) return false;
  if (warning.status === "queued") return true;
  return warning.status === "unverified" && Boolean(warning.queued_at);
}

export function isSelectableLayoutWarning(warning) {
  return isActiveLayoutWarning(warning) && !hasOutstandingRepairRequest(warning);
}

/**
 * Fold one completed (or failed) browser diagnostic pass into the stored warning records.
 *
 * @param {any[]} warnings stored records
 * @param {{ complete?: boolean, targetPresenceComplete?: boolean, viewportWidth?: number, revision?: number, at?: string, findings?: any[] }} pass
 * @returns {{ warnings: any[], changed: boolean }}
 */
export function applyDiagnosticPass(warnings, pass) {
  const previous = normalizeStoredWarnings(warnings);
  const at = String(pass?.at || new Date().toISOString());
  const revision = Math.max(0, Math.trunc(finiteNumber(pass?.revision)));
  const viewportWidth = finiteNumber(pass?.viewportWidth);
  const viewportClass = viewportClassFor(viewportWidth);
  const complete = pass?.complete !== false;
  const targetPresenceComplete = pass?.targetPresenceComplete === true;
  const observations = new Map();
  for (const finding of normalizeFindings(pass?.findings, viewportWidth)) {
    const fingerprint = layoutWarningFingerprint({
      rule: finding.rule,
      target: finding.selector,
      viewportClass,
    });
    if (!observations.has(fingerprint)) observations.set(fingerprint, finding);
  }

  const next = previous.map((warning) => {
    // A pass for one viewport class is silent about every other class. A desktop pass can never
    // clear a phone-specific warning.
    if (warning.viewport_class !== viewportClass) return warning;

    const observation = observations.get(warning.fingerprint);
    if (observation) {
      observations.delete(warning.fingerprint);
      return recordDetection(warning, observation, { at, revision, viewportWidth });
    }
    // Absence is only evidence when the pass actually completed.
    if (!complete || !targetPresenceComplete) return recordUnverified(warning, { at, revision });
    // Temporary absence within the same artifact load is not proof of repair - resolution needs
    // a newer successful load plus a complete pass.
    if (revision <= finiteNumber(warning.last_seen_revision)) return warning;
    if (!isActiveLayoutWarning(warning) && warning.status !== "dismissed") return warning;
    return recordResolved(warning, { at, revision });
  });

  for (const [fingerprint, observation] of observations) {
    next.push(createWarning(fingerprint, observation, { at, revision, viewportClass, viewportWidth }));
  }

  const pruned = pruneWarnings(next);
  return { warnings: pruned, changed: !sameWarnings(previous, pruned) };
}

/** Mark warnings as queued for repair. They stay unresolved and counted. */
export function queueLayoutWarnings(warnings, ids, { revision = 0, at = new Date().toISOString() } = {}) {
  const wanted = new Set(
    (Array.isArray(ids) ? ids : []).slice(0, MAX_QUEUED_WARNINGS_PER_PROMPT).map((id) => String(id)),
  );
  const previous = normalizeStoredWarnings(warnings);
  const queued = [];
  const next = previous.map((warning) => {
    if (!wanted.has(warning.id) || !isSelectableLayoutWarning(warning)) return warning;
    const updated = withHistory(
      {
        ...warning,
        status: "queued",
        queued_revision: Math.max(0, Math.trunc(finiteNumber(revision))),
        queued_at: at,
        queue_attempts: finiteNumber(warning.queue_attempts) + 1,
      },
      { at, revision, event: "queued" },
    );
    queued.push(updated);
    return updated;
  });
  return { warnings: next, queued, changed: queued.length > 0 };
}

/** Dismiss a warning for the current artifact revision only. */
export function dismissLayoutWarning(warnings, id, { revision = 0, at = new Date().toISOString() } = {}) {
  const target = String(id || "");
  let changed = false;
  const next = normalizeStoredWarnings(warnings).map((warning) => {
    if (warning.id !== target || !isSelectableLayoutWarning(warning)) return warning;
    changed = true;
    return withHistory(
      {
        ...warning,
        status: "dismissed",
        dismissed_revision: Math.max(0, Math.trunc(finiteNumber(revision))),
        dismissed_at: at,
      },
      { at, revision, event: "dismissed", note: "dismissed for this artifact revision" },
    );
  });
  return { warnings: next, changed };
}

// A viewport class that leaves the configured diagnostic set can never be re-checked, so its
// warnings are marked obsolete with an explicit reason rather than silently reading as fixed.
export function markObsoleteViewportWarnings(
  warnings,
  viewportClasses = DEFAULT_DIAGNOSTIC_VIEWPORT_CLASSES,
  { at = new Date().toISOString(), revision = 0 } = {},
) {
  const configured = new Set(
    (Array.isArray(viewportClasses) ? viewportClasses : DEFAULT_DIAGNOSTIC_VIEWPORT_CLASSES).map((value) =>
      String(value),
    ),
  );
  let changed = false;
  const next = normalizeStoredWarnings(warnings).map((warning) => {
    if (configured.has(warning.viewport_class) || !isActiveLayoutWarning(warning)) return warning;
    changed = true;
    const reason = `the ${warning.viewport_class} viewport is no longer in the configured diagnostic set, so this warning can no longer be re-checked`;
    return withHistory(
      { ...warning, status: "obsolete", obsolete_reason: reason, obsolete_at: at },
      { at, revision, event: "obsolete", note: reason },
    );
  });
  return { warnings: next, changed };
}

// The chrome renders only what the server hands it, so every display string is computed here.
export function serializeLayoutWarning(warning) {
  const { title, explanation } = describeLayoutWarning(warning);
  return {
    id: warning.id,
    fingerprint: warning.fingerprint,
    rule: warning.rule,
    severity: warning.severity,
    status: warning.status,
    status_label: layoutWarningStatusLabel(warning.status),
    title,
    explanation,
    selector: warning.selector,
    component: warning.component,
    axis: warning.axis,
    overflow_px: warning.overflow_px,
    viewport_class: warning.viewport_class,
    viewport_label: viewportClassLabel(warning.viewport_class),
    viewport_width: warning.viewport_width,
    first_seen_at: warning.first_seen_at,
    last_seen_at: warning.last_seen_at,
    last_seen_revision: warning.last_seen_revision,
    queued_at: warning.queued_at || "",
    queue_attempts: warning.queue_attempts || 0,
    active: isActiveLayoutWarning(warning),
    selectable: isSelectableLayoutWarning(warning),
    outstanding: hasOutstandingRepairRequest(warning),
    ...(warning.obsolete_reason ? { obsolete_reason: warning.obsolete_reason } : {}),
    history: (warning.history || []).slice(-MAX_SERIALIZED_HISTORY_ENTRIES),
  };
}

export function serializeLayoutWarnings(warnings) {
  return normalizeStoredWarnings(warnings).map(serializeLayoutWarning);
}

// The agent-facing payload for one queued batch. Bounded so a runaway detection pass can never
// blow up a prompt.
export function layoutWarningPromptPayload(warnings) {
  const selected = normalizeStoredWarnings(warnings).slice(0, MAX_QUEUED_WARNINGS_PER_PROMPT);
  const lines = selected.map((warning, index) => {
    const { title, explanation } = describeLayoutWarning(warning);
    return `${index + 1}. [${warning.id}] ${title} - ${explanation} Target: ${warning.selector || "(page)"}. Viewport: ${viewportClassLabel(warning.viewport_class)} (${pxText(warning.viewport_width)}). Status: ${layoutWarningStatusLabel(warning.status)}.`;
  });
  const count = selected.length;
  const prompt =
    `Fix ${count === 1 ? "this layout issue" : `these ${count} layout issues`} the browser detected in this artifact:\n` +
    `${lines.join("\n")}\n\n` +
    "Apply every listed fix in one pass before saving so the review refreshes once. " +
    "A queued layout issue is a repair request, not a resolved issue: Lavish only marks it resolved after a newer artifact load and a complete diagnostic pass for the same viewport no longer detects it.";
  const target = {
    type: "layout-warnings",
    artifact_revision: Math.max(0, Math.trunc(finiteNumber(selected[0]?.queued_revision))),
    warnings: selected.map((warning) => ({
      id: warning.id,
      rule: warning.rule,
      selector: warning.selector,
      component: warning.component,
      axis: warning.axis,
      overflow_px: warning.overflow_px,
      viewport_class: warning.viewport_class,
      viewport_width: warning.viewport_width,
      status: warning.status,
      last_seen_at: warning.last_seen_at,
    })),
  };
  return {
    prompt,
    text: count === 1 ? "Problema de layout: 1 selecionado" : `Problemas de layout: ${count} selecionados`,
    target,
  };
}

// Prompt-target normalization for the queued batch, mirroring the other structured targets.
export function normalizeLayoutWarningsTarget(target) {
  const warnings = Array.isArray(target?.warnings) ? target.warnings : [];
  const normalized = {
    type: "layout-warnings",
    warnings: warnings.slice(0, MAX_QUEUED_WARNINGS_PER_PROMPT).map((warning) => ({
      id: normalizeText(warning?.id).slice(0, 64),
      rule: normalizeText(warning?.rule).slice(0, 64),
      selector: normalizeText(warning?.selector).slice(0, 300),
      component: normalizeText(warning?.component).slice(0, 120),
      axis: warning?.axis === "vertical" ? "vertical" : "horizontal",
      overflow_px: finiteNumber(warning?.overflow_px),
      viewport_class: normalizeText(warning?.viewport_class).slice(0, 16),
      viewport_width: finiteNumber(warning?.viewport_width),
      status: normalizeText(warning?.status).slice(0, 16),
      last_seen_at: normalizeText(warning?.last_seen_at).slice(0, 40),
    })),
  };
  if (Object.hasOwn(target || {}, "artifact_revision")) {
    normalized.artifact_revision = Math.max(0, Math.trunc(finiteNumber(target.artifact_revision)));
  }
  return normalized;
}

export function resolveDiagnosticViewportClasses(env = process.env) {
  const raw = String(env.LAVISH_AXI_DIAGNOSTIC_VIEWPORTS || "").trim();
  if (!raw) return [...DEFAULT_DIAGNOSTIC_VIEWPORT_CLASSES];
  const configured = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => DEFAULT_DIAGNOSTIC_VIEWPORT_CLASSES.includes(value));
  return configured.length ? [...new Set(configured)] : [...DEFAULT_DIAGNOSTIC_VIEWPORT_CLASSES];
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function createWarning(fingerprint, observation, { at, revision, viewportClass, viewportWidth }) {
  return withHistory(
    {
      id: fingerprint,
      fingerprint,
      rule: observation.rule,
      severity: "error",
      status: "open",
      selector: observation.selector,
      component: componentIdentity(observation.selector),
      axis: observation.axis,
      overflow_px: observation.overflowPx,
      viewport_class: viewportClass,
      viewport_width: viewportWidth,
      first_seen_at: at,
      first_seen_revision: revision,
      last_seen_at: at,
      last_seen_revision: revision,
      observation_count: 1,
      queued_revision: 0,
      queued_at: "",
      queue_attempts: 0,
      dismissed_revision: 0,
      history: [],
    },
    { at, revision, event: "detected" },
  );
}

function recordDetection(warning, observation, { at, revision, viewportWidth }) {
  const status = detectedStatus(warning, revision);
  // Re-observing the identical finding on the artifact revision that already recorded it changes
  // nothing. Returning the record untouched keeps repeat passes from rewriting session state and
  // keeps the deduplicated count honest.
  const unchanged =
    status === warning.status &&
    revision <= finiteNumber(warning.last_seen_revision) &&
    warning.selector === observation.selector &&
    warning.axis === observation.axis &&
    finiteNumber(warning.overflow_px) === observation.overflowPx &&
    finiteNumber(warning.viewport_width) === viewportWidth;
  if (unchanged) return warning;

  const updated = {
    ...warning,
    rule: observation.rule,
    selector: observation.selector,
    component: componentIdentity(observation.selector),
    axis: observation.axis,
    overflow_px: observation.overflowPx,
    viewport_width: viewportWidth,
    last_seen_at: at,
    last_seen_revision: Math.max(finiteNumber(warning.last_seen_revision), revision),
    observation_count: finiteNumber(warning.observation_count) + 1,
    status,
  };
  if (status === warning.status) return updated;
  const note =
    status === "recurring"
      ? "still present after a newer artifact revision"
      : status === "reopened"
        ? "detected again after being resolved"
        : "";
  return withHistory(updated, { at, revision, event: status, note });
}

function detectedStatus(warning, revision) {
  if (warning.status === "dismissed" && revision <= finiteNumber(warning.dismissed_revision)) return "dismissed";
  if (warning.queued_at) {
    return revision > finiteNumber(warning.queued_revision) ? "recurring" : "queued";
  }
  if (warning.status === "resolved") return "reopened";
  if (warning.status === "reopened") return "reopened";
  return "open";
}

function recordUnverified(warning, { at, revision }) {
  if (!isActiveLayoutWarning(warning) || warning.status === "unverified") return warning;
  return withHistory(
    { ...warning, status: "unverified" },
    {
      at,
      revision,
      event: "unverified",
      note: "a diagnostic pass failed or was incomplete, so this warning was preserved rather than cleared",
    },
  );
}

function recordResolved(warning, { at, revision }) {
  return withHistory(
    {
      ...warning,
      status: "resolved",
      resolved_at: at,
      resolved_revision: revision,
      queued_revision: 0,
      queued_at: "",
    },
    { at, revision, event: "resolved", note: "absent from a complete pass on a newer artifact revision" },
  );
}

function withHistory(warning, entry) {
  const history = [
    ...(Array.isArray(warning.history) ? warning.history : []),
    {
      at: String(entry.at),
      revision: Math.max(0, Math.trunc(finiteNumber(entry.revision))),
      event: String(entry.event),
      ...(entry.note ? { note: String(entry.note).slice(0, 200) } : {}),
    },
  ];
  return { ...warning, history: history.slice(-MAX_HISTORY_ENTRIES) };
}

// Keep every unresolved record; trim the closed tail so review history stays bounded.
function pruneWarnings(warnings) {
  if (warnings.length <= MAX_STORED_WARNINGS) return warnings;
  const active = warnings.filter(isActiveLayoutWarning);
  const closed = warnings.filter((warning) => !isActiveLayoutWarning(warning));
  const room = Math.max(0, MAX_STORED_WARNINGS - active.length);
  const keptClosed = new Set(closed.slice(-room));
  return warnings.filter((warning) => isActiveLayoutWarning(warning) || keptClosed.has(warning));
}

function normalizeFindings(findings, viewportWidth) {
  if (!Array.isArray(findings)) return [];
  return findings
    .filter(
      (finding) =>
        finding &&
        typeof finding === "object" &&
        !Array.isArray(finding) &&
        String(finding.severity || "").toLowerCase() === "error",
    )
    .slice(0, MAX_STORED_WARNINGS)
    .map((finding) => ({
      rule: normalizeText(finding.kind || finding.rule || "layout-failure").slice(0, 64),
      selector: normalizeText(finding.selector).slice(0, 300),
      axis: finding.axis === "vertical" ? "vertical" : "horizontal",
      overflowPx: Math.round(finiteNumber(finding.overflowPx ?? finding.overflow_px)),
      viewportWidth: Math.round(finiteNumber(finding.viewportWidth ?? finding.viewport_width) || viewportWidth),
    }));
}

export function normalizeStoredWarnings(warnings) {
  if (!Array.isArray(warnings)) return [];
  return warnings.filter((warning) => warning && typeof warning === "object" && !Array.isArray(warning) && warning.id);
}

function sameWarnings(previous, next) {
  return JSON.stringify(previous) === JSON.stringify(next);
}

function normalizeText(value) {
  return value === null || value === undefined ? "" : String(value).replace(/\s+/g, " ").trim();
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function pxText(value) {
  return `${Math.round(finiteNumber(value))}px`;
}

function axisEdge(axis) {
  return axis === "vertical" ? "inferior" : "direita";
}
