import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVE_LAYOUT_WARNING_STATUSES,
  activeLayoutWarningCount,
  applyDiagnosticPass,
  componentIdentity,
  describeLayoutWarning,
  dismissLayoutWarning,
  hasOutstandingRepairRequest,
  isSelectableLayoutWarning,
  isActiveLayoutWarning,
  LAYOUT_WARNING_STATUSES,
  layoutWarningFingerprint,
  layoutWarningPromptPayload,
  layoutWarningStatusLabel,
  markObsoleteViewportWarnings,
  normalizeLayoutWarningsTarget,
  queueLayoutWarnings,
  resolveDiagnosticViewportClasses,
  serializeLayoutWarnings,
  viewportClassFor,
} from "../src/layout-warnings.js";

const OVERFLOW = {
  selector: "html",
  kind: "page-horizontal-overflow",
  axis: "horizontal",
  overflowPx: 120,
  severity: "error",
};
const CLIPPED = {
  selector: "p#copy",
  kind: "clipped-text",
  axis: "vertical",
  overflowPx: 27,
  severity: "error",
};

function pass(findings, { revision = 1, viewportWidth = 1440, complete = true, at = "2026-07-30T00:00:00.000Z" } = {}) {
  return { findings, revision, viewportWidth, complete, at };
}

function detect(findings, options) {
  return applyDiagnosticPass([], pass(findings, options)).warnings;
}

test("viewport classes bucket by width", () => {
  assert.equal(viewportClassFor(390), "mobile");
  assert.equal(viewportClassFor(640), "mobile");
  assert.equal(viewportClassFor(820), "compact");
  assert.equal(viewportClassFor(1440), "desktop");
});

test("the fingerprint is rule + target + viewport and ignores magnitude", () => {
  const base = { rule: "clipped-text", target: "p#copy", viewportClass: "mobile" };
  assert.equal(layoutWarningFingerprint(base), layoutWarningFingerprint({ ...base }));
  assert.notEqual(layoutWarningFingerprint(base), layoutWarningFingerprint({ ...base, viewportClass: "desktop" }));
  assert.notEqual(layoutWarningFingerprint(base), layoutWarningFingerprint({ ...base, target: "p#other" }));
  assert.notEqual(layoutWarningFingerprint(base), layoutWarningFingerprint({ ...base, rule: "clipped-control" }));
});

test("component identity prefers the most specific id, then class, then tag", () => {
  assert.equal(componentIdentity("html > body > p#copy"), "#copy");
  assert.equal(componentIdentity("main > div.card"), ".card");
  assert.equal(componentIdentity("main > section:nth-of-type(2)"), "section");
  assert.equal(componentIdentity(""), "");
});

test("every audit rule has human-readable context", () => {
  for (const rule of [
    "page-horizontal-overflow",
    "clipped-text",
    "clipped-control",
    "viewport-unreachable-control",
    "viewport-unreachable-content",
    "overlapping-text",
  ]) {
    const described = describeLayoutWarning({ rule, overflow_px: 24, viewport_width: 390, axis: "horizontal" });
    if (rule !== "overlapping-text") assert.match(described.explanation, /24px/, rule);
    assert.ok(described.title.length > 0, rule);
    assert.ok(described.explanation.length > 0, rule);
  }
  assert.equal(describeLayoutWarning({ rule: "something-new" }).title, "Layout failure");
});

test("a repeated observation of the same fingerprint updates one record", () => {
  const first = applyDiagnosticPass([], pass([OVERFLOW]));
  assert.equal(first.warnings.length, 1);
  assert.equal(first.changed, true);

  const again = applyDiagnosticPass(first.warnings, pass([OVERFLOW]));
  assert.equal(again.warnings.length, 1);
  assert.equal(again.changed, false, "an identical repeat must not churn the record");

  const worse = applyDiagnosticPass(again.warnings, pass([{ ...OVERFLOW, overflowPx: 400 }]));
  assert.equal(worse.warnings.length, 1, "a worse magnitude is the same issue, not a new one");
  assert.equal(worse.warnings[0].overflow_px, 400);
  assert.equal(activeLayoutWarningCount(worse.warnings), 1);
});

test("a warning is not resolved by a repeat pass on the same artifact revision", () => {
  const detected = detect([OVERFLOW], { revision: 3 });
  const sameRevision = applyDiagnosticPass(detected, pass([], { revision: 3 }));
  assert.equal(sameRevision.warnings[0].status, "open");
  assert.equal(activeLayoutWarningCount(sameRevision.warnings), 1);
});

test("a newer complete matching-viewport pass without the finding resolves it", () => {
  const detected = detect([OVERFLOW], { revision: 3 });
  const resolved = applyDiagnosticPass(detected, pass([], { revision: 4 }));
  assert.equal(resolved.warnings[0].status, "resolved");
  assert.equal(activeLayoutWarningCount(resolved.warnings), 0);
  assert.ok(resolved.warnings[0].history.some((entry) => entry.event === "resolved"));
});

test("a different viewport class can never clear a warning", () => {
  const mobile = detect([OVERFLOW], { revision: 3, viewportWidth: 390 });
  const desktopPass = applyDiagnosticPass(mobile, pass([], { revision: 9, viewportWidth: 1440 }));
  assert.equal(desktopPass.warnings[0].status, "open");
  assert.equal(desktopPass.changed, false);
  assert.equal(activeLayoutWarningCount(desktopPass.warnings), 1);
});

test("a failed or incomplete pass preserves the warning as unverified", () => {
  const detected = detect([OVERFLOW], { revision: 3 });
  const failed = applyDiagnosticPass(detected, pass([], { revision: 4, complete: false }));
  assert.equal(failed.warnings[0].status, "unverified");
  assert.equal(activeLayoutWarningCount(failed.warnings), 1);

  // A later complete pass that still sees it puts it back to open.
  const recovered = applyDiagnosticPass(failed.warnings, pass([OVERFLOW], { revision: 5 }));
  assert.equal(recovered.warnings[0].status, "open");
});

test("queueing marks an outstanding repair request without resolving anything", () => {
  const detected = detect([OVERFLOW, CLIPPED], { revision: 2 });
  const ids = detected.map((warning) => warning.id);
  const queued = queueLayoutWarnings(detected, [ids[0]], { revision: 2 });

  assert.equal(queued.queued.length, 1);
  assert.equal(queued.warnings[0].status, "queued");
  assert.equal(queued.warnings[1].status, "open");
  assert.equal(activeLayoutWarningCount(queued.warnings), 2, "queued still counts as unresolved");
  assert.equal(hasOutstandingRepairRequest(queued.warnings[0]), true);
  assert.equal(isSelectableLayoutWarning(queued.warnings[0]), false, "no duplicate request while outstanding");
  assert.equal(isSelectableLayoutWarning(queued.warnings[1]), true);
});

test("a queued warning still present on a newer revision becomes recurring and re-queueable", () => {
  const detected = detect([OVERFLOW], { revision: 2 });
  const queued = queueLayoutWarnings(detected, [detected[0].id], { revision: 2 }).warnings;
  const recurring = applyDiagnosticPass(queued, pass([OVERFLOW], { revision: 3 }));

  assert.equal(recurring.warnings[0].status, "recurring");
  assert.equal(activeLayoutWarningCount(recurring.warnings), 1);
  assert.equal(isSelectableLayoutWarning(recurring.warnings[0]), true);
  assert.ok(
    recurring.warnings[0].history.some((entry) => entry.event === "queued"),
    "prior attempt retained",
  );
  assert.ok(recurring.warnings[0].history.some((entry) => entry.event === "recurring"));

  const requeued = queueLayoutWarnings(recurring.warnings, [recurring.warnings[0].id], { revision: 3 });
  assert.equal(requeued.warnings[0].queue_attempts, 2);
});

test("a queued warning knocked to unverified is not re-requestable and returns to queued", () => {
  const detected = detect([OVERFLOW], { revision: 2 });
  const queued = queueLayoutWarnings(detected, [detected[0].id], { revision: 2 }).warnings;
  const unverified = applyDiagnosticPass(queued, pass([], { revision: 2, complete: false })).warnings;

  assert.equal(unverified[0].status, "unverified");
  assert.equal(isSelectableLayoutWarning(unverified[0]), false);

  const stillQueued = applyDiagnosticPass(unverified, pass([OVERFLOW], { revision: 2 })).warnings;
  assert.equal(stillQueued[0].status, "queued");
});

test("a queued warning cannot be dismissed", () => {
  const detected = detect([OVERFLOW], { revision: 2 });
  const queued = queueLayoutWarnings(detected, [detected[0].id], { revision: 2 }).warnings;
  const dismissed = dismissLayoutWarning(queued, queued[0].id, { revision: 2 });

  assert.equal(dismissed.changed, false);
  assert.equal(dismissed.warnings[0].status, "queued");
  assert.equal(activeLayoutWarningCount(dismissed.warnings), 1);
});

test("a resolved warning that returns on a later revision reopens with bounded history", () => {
  const detected = detect([OVERFLOW], { revision: 2 });
  const resolved = applyDiagnosticPass(detected, pass([], { revision: 3 })).warnings;
  assert.equal(resolved[0].status, "resolved");

  const reopened = applyDiagnosticPass(resolved, pass([OVERFLOW], { revision: 4 })).warnings;
  assert.equal(reopened[0].status, "reopened");
  assert.equal(activeLayoutWarningCount(reopened), 1);
  assert.deepEqual(
    reopened[0].history.map((entry) => entry.event),
    ["detected", "resolved", "reopened"],
  );
  assert.ok(reopened[0].history.length <= 20);
});

test("history stays bounded across many transitions", () => {
  let warnings = detect([OVERFLOW], { revision: 1 });
  for (let revision = 2; revision < 40; revision += 1) {
    warnings = applyDiagnosticPass(warnings, pass(revision % 2 === 0 ? [] : [OVERFLOW], { revision })).warnings;
  }
  assert.ok(warnings[0].history.length <= 20, `history grew to ${warnings[0].history.length}`);
});

test("dismissal only hides the warning for the current revision", () => {
  const detected = detect([OVERFLOW], { revision: 5 });
  const dismissed = dismissLayoutWarning(detected, detected[0].id, { revision: 5 });
  assert.equal(dismissed.warnings[0].status, "dismissed");
  assert.equal(activeLayoutWarningCount(dismissed.warnings), 0);

  const sameRevision = applyDiagnosticPass(dismissed.warnings, pass([OVERFLOW], { revision: 5 }));
  assert.equal(sameRevision.warnings[0].status, "dismissed");

  const laterRevision = applyDiagnosticPass(sameRevision.warnings, pass([OVERFLOW], { revision: 6 }));
  assert.equal(laterRevision.warnings[0].status, "open");
  assert.equal(activeLayoutWarningCount(laterRevision.warnings), 1);
});

test("a viewport removed from the diagnostic set is marked obsolete with a reason", () => {
  const mobile = detect([OVERFLOW], { revision: 1, viewportWidth: 390 });
  const obsolete = markObsoleteViewportWarnings(mobile, ["desktop"], { revision: 2 });

  assert.equal(obsolete.changed, true);
  assert.equal(obsolete.warnings[0].status, "obsolete");
  assert.match(obsolete.warnings[0].obsolete_reason, /no longer in the configured diagnostic set/);
  assert.equal(activeLayoutWarningCount(obsolete.warnings), 0);
  assert.notEqual(obsolete.warnings[0].status, "resolved", "obsolete must never read as fixed");
});

test("the configured diagnostic viewport set falls back to every class", () => {
  assert.deepEqual(resolveDiagnosticViewportClasses({}), ["mobile", "compact", "desktop"]);
  assert.deepEqual(resolveDiagnosticViewportClasses({ LAVISH_AXI_DIAGNOSTIC_VIEWPORTS: "desktop, mobile" }), [
    "desktop",
    "mobile",
  ]);
  assert.deepEqual(resolveDiagnosticViewportClasses({ LAVISH_AXI_DIAGNOSTIC_VIEWPORTS: "nonsense" }), [
    "mobile",
    "compact",
    "desktop",
  ]);
});

test("the queued prompt payload carries bounded structured warning detail", () => {
  const detected = detect([OVERFLOW, CLIPPED], { revision: 2 });
  const payload = layoutWarningPromptPayload(detected);

  assert.match(payload.prompt, /Fix these 2 layout issues/);
  assert.match(payload.prompt, new RegExp(detected[0].id));
  assert.match(payload.prompt, /one pass before saving so the review refreshes once/);
  assert.match(payload.prompt, /not a resolved issue/);
  assert.equal(payload.text, "Layout issues: 2 selected");
  assert.equal(payload.target.type, "layout-warnings");
  assert.equal(payload.target.warnings.length, 2);
  assert.equal(payload.target.warnings[1].rule, "clipped-text");

  const queued = queueLayoutWarnings(
    detected,
    detected.map((warning) => warning.id),
    { revision: 2 },
  );
  assert.equal(layoutWarningPromptPayload(queued.queued).target.artifact_revision, 2);
});

test("queueing more than one prompt batch leaves overflow selections selectable", () => {
  const warnings = detect(
    Array.from({ length: 60 }, (_, index) => ({
      ...OVERFLOW,
      selector: `p#item-${index}`,
    })),
    { revision: 2 },
  );
  const queued = queueLayoutWarnings(
    warnings,
    warnings.map((warning) => warning.id),
    { revision: 2 },
  );

  assert.equal(queued.queued.length, 50);
  assert.equal(queued.warnings.filter((warning) => warning.status === "queued").length, 50);
  assert.equal(queued.warnings.filter((warning) => warning.status === "open").length, 10);
  assert.equal(layoutWarningPromptPayload(queued.queued).target.warnings.length, 50);
});

test("a queued prompt target is normalized and bounded", () => {
  const normalized = normalizeLayoutWarningsTarget({
    type: "layout-warnings",
    artifact_revision: 7,
    warnings: Array.from({ length: 80 }, (_, index) => ({
      id: `id-${index}`,
      rule: "clipped-text",
      selector: "x".repeat(600),
      axis: "sideways",
      overflow_px: "nope",
    })),
  });

  assert.equal(normalized.warnings.length, 50);
  assert.equal(normalized.warnings[0].selector.length, 300);
  assert.equal(normalized.warnings[0].axis, "horizontal");
  assert.equal(normalized.warnings[0].overflow_px, 0);
  assert.equal(normalized.artifact_revision, 7);
});

test("stored records describe their real magnitude, not a zero", () => {
  const [warning] = serializeLayoutWarnings(detect([CLIPPED], { revision: 1, viewportWidth: 1080 }));
  assert.match(warning.explanation, /27px/);
  assert.match(warning.explanation, /bottom edge/);
});

test("serialized warnings carry everything the drawer renders", () => {
  const detected = detect([CLIPPED], { revision: 1, viewportWidth: 390 });
  const [warning] = serializeLayoutWarnings(detected);

  assert.equal(warning.status_label, "Open");
  assert.equal(warning.viewport_label, "Mobile");
  assert.equal(warning.viewport_width, 390);
  assert.equal(warning.component, "#copy");
  assert.ok(warning.title);
  assert.ok(warning.explanation);
  assert.ok(warning.last_seen_at);
  assert.equal(warning.active, true);
  assert.equal(warning.selectable, true);
});

test("legacy stored records without an id are dropped rather than shown", () => {
  const legacy = [{ selector: "html", kind: "page-horizontal-overflow", severity: "error" }];
  assert.deepEqual(serializeLayoutWarnings(legacy), []);
  assert.equal(applyDiagnosticPass(legacy, pass([])).warnings.length, 0);
});

test("every declared status has a label and a defined active/closed meaning", () => {
  for (const status of LAYOUT_WARNING_STATUSES) {
    assert.notEqual(layoutWarningStatusLabel(status), undefined, status);
    assert.equal(typeof isActiveLayoutWarning({ status }), "boolean", status);
  }
  assert.deepEqual(
    LAYOUT_WARNING_STATUSES.filter((status) => isActiveLayoutWarning({ status })),
    ACTIVE_LAYOUT_WARNING_STATUSES,
  );
});

test("a repair request is tracked by queue time, so revision 0 is not read as never queued", () => {
  const detected = detect([OVERFLOW], { revision: 0 });
  const queued = queueLayoutWarnings(detected, [detected[0].id], { revision: 0 }).warnings;

  assert.equal(queued[0].status, "queued");
  assert.equal(hasOutstandingRepairRequest(queued[0]), true);
  assert.equal(isSelectableLayoutWarning(queued[0]), false);

  const recurring = applyDiagnosticPass(queued, pass([OVERFLOW], { revision: 1 })).warnings;
  assert.equal(recurring[0].status, "recurring");
});
