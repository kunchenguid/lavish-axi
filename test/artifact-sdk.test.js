import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyHorizontalOverflow,
  classifyParentOverflow,
  classifyVerticalOverflow,
  deriveLavishQueueKey,
  fragmentsSignificantlyOverlap,
  isModeToggleHotkeyEvent,
  isNativeInteractiveControl,
  resolveVisibleSpillCandidates,
  verticalFragmentOverflow,
} from "../src/artifact-sdk.js";

function node(tag, attrs = {}, children = []) {
  const el = {
    tagName: tag.toUpperCase(),
    nodeName: tag.toUpperCase(),
    nodeType: 1,
    parentElement: null,
    children: [],
    getAttribute(name) {
      return Object.hasOwn(attrs, name) ? attrs[name] : null;
    },
    closest(selector) {
      let current = this;
      while (current) {
        if (matchesSelectorList(current, selector)) return current;
        current = current.parentElement;
      }
      return null;
    },
    matches(selector) {
      return matchesSelectorList(this, selector);
    },
    contains(other) {
      let current = other;
      while (current) {
        if (current === this) return true;
        current = current.parentElement;
      }
      return false;
    },
  };
  if (attrs.id) el.id = attrs.id;
  if (attrs.name) el.name = attrs.name;
  if (attrs.type) el.type = attrs.type;
  if (attrs.value) el.value = attrs.value;
  for (const child of children) append(el, child);
  return el;
}

function append(parent, child) {
  child.parentElement = parent;
  parent.children.push(child);
  return child;
}

function matchesSelectorList(el, selectorList) {
  return selectorList.split(",").some((selector) => matchesSelector(el, selector.trim()));
}

function matchesSelector(el, selector) {
  if (selector === "form" || selector === "fieldset") return el.tagName.toLowerCase() === selector;
  if (selector === "[data-lavish-question]") return el.getAttribute("data-lavish-question") !== null;
  if (selector === "[contenteditable]:not([contenteditable='false'])") {
    const value = el.getAttribute("contenteditable");
    return value !== null && value !== "false";
  }
  if (/^[a-z]+$/i.test(selector)) return el.tagName.toLowerCase() === selector.toLowerCase();
  return false;
}

test("isNativeInteractiveControl leaves details body descendants annotatable", () => {
  const summaryChild = node("span");
  const summary = node("summary", {}, [summaryChild]);
  const bodyText = node("span");
  const bodyLink = node("a", { href: "#target" });
  const body = node("div", {}, [bodyText, bodyLink]);
  const details = node("details", { open: "" }, [summary, body]);

  assert.equal(isNativeInteractiveControl(summaryChild), true);
  assert.equal(isNativeInteractiveControl(details), false);
  assert.equal(isNativeInteractiveControl(bodyText), false);
  assert.equal(isNativeInteractiveControl(bodyLink), false);
});

test("isNativeInteractiveControl allows details as a text selection ancestor", () => {
  const firstParagraph = node("p");
  const secondParagraph = node("p");
  const details = node("details", { open: "" }, [node("summary", {}, [node("span")]), firstParagraph, secondParagraph]);

  assert.equal(isNativeInteractiveControl(details), false);
  assert.equal(isNativeInteractiveControl(firstParagraph), false);
  assert.equal(isNativeInteractiveControl(secondParagraph), false);
});

test("deriveLavishQueueKey uses explicit queueKey first", () => {
  const input = node("input", { type: "radio", name: "plan" });

  assert.equal(deriveLavishQueueKey(input, { queueKey: "deployment-plan" }), "deployment-plan");
});

test("deriveLavishQueueKey allows explicit empty queueKey to suppress derivation", () => {
  const button = node("button");
  node("section", { "data-lavish-question": "deployment-plan" }, [button]);

  assert.equal(deriveLavishQueueKey(button, { queueKey: "" }), "");
});

test("deriveLavishQueueKey groups controls inside data-lavish-question", () => {
  const first = node("button");
  const second = node("button");
  node("section", { "data-lavish-question": "deployment-plan" }, [first, second]);

  assert.equal(deriveLavishQueueKey(first), "question:deployment-plan");
  assert.equal(deriveLavishQueueKey(second), "question:deployment-plan");
});

test("deriveLavishQueueKey groups radio options by scoped group name", () => {
  const planA = node("input", { id: "plan-a", type: "radio", name: "plan", value: "A" });
  const planB = node("input", { id: "plan-b", type: "radio", name: "plan", value: "B" });
  node("form", { id: "deploy" }, [planA, planB]);

  assert.equal(deriveLavishQueueKey(planA), "radio:form:deploy:plan");
  assert.equal(deriveLavishQueueKey(planB), "radio:form:deploy:plan");
});

test("deriveLavishQueueKey keeps same radio names independent across scopes", () => {
  const first = node("input", { type: "radio", name: "plan", value: "A" });
  const second = node("input", { type: "radio", name: "plan", value: "B" });
  node("form", { id: "deploy-one" }, [first]);
  node("form", { id: "deploy-two" }, [second]);

  assert.notEqual(deriveLavishQueueKey(first), deriveLavishQueueKey(second));
});

test("deriveLavishQueueKey does not infer plain button grouping without question metadata", () => {
  const button = node("button");

  assert.equal(deriveLavishQueueKey(button), "");
});

test("deriveLavishQueueKey keys checkbox toggles per checkbox, not per group", () => {
  const first = node("input", { type: "checkbox", name: "feature", value: "search" });
  const second = node("input", { type: "checkbox", name: "feature", value: "billing" });
  node("form", { id: "features" }, [first, second]);

  assert.notEqual(deriveLavishQueueKey(first), deriveLavishQueueKey(second));
});

test("deriveLavishQueueKey does not collide checkbox default values", () => {
  const first = node("input", { id: "search", type: "checkbox", name: "feature" });
  const second = node("input", { id: "billing", type: "checkbox", name: "feature" });
  first.value = "on";
  second.value = "on";
  node("form", { id: "features" }, [first, second]);

  assert.notEqual(deriveLavishQueueKey(first), deriveLavishQueueKey(second));
});

test("deriveLavishQueueKey keys named selects as fields", () => {
  const select = node("select", { name: "region" });
  node("form", { id: "deploy" }, [select]);

  assert.equal(deriveLavishQueueKey(select), "field:form:deploy:region");
});

test("fragmentsSignificantlyOverlap ignores the reflow gap in a wrapped inline phrase's bounding box", () => {
  // A <strong> that wraps across two lines reports one getClientRects() rect per line: the end
  // of line 1 near the right edge, then the continuation at the left edge of line 2. The union
  // bounding box of those two rects spans the full width between them - a naive bounding-box
  // check would treat anything sitting in that phantom middle area as overlapping, even though
  // nothing is actually rendered there.
  const wrappedFragments = [
    { left: 620, right: 900, top: 100, bottom: 120, width: 280, height: 20 },
    { left: 0, right: 260, top: 120, bottom: 140, width: 260, height: 20 },
  ];
  const siblingInThePhantomGap = [{ left: 300, right: 600, top: 100, bottom: 120, width: 300, height: 20 }];

  assert.equal(fragmentsSignificantlyOverlap(wrappedFragments, siblingInThePhantomGap), false);
});

test("fragmentsSignificantlyOverlap flags real pixel intersection between rendered fragments", () => {
  const elFragments = [{ left: 0, right: 100, top: 0, bottom: 20, width: 100, height: 20 }];
  const otherFragments = [{ left: 40, right: 140, top: 5, bottom: 25, width: 100, height: 20 }];

  assert.equal(fragmentsSignificantlyOverlap(elFragments, otherFragments), true);
});

test("fragmentsSignificantlyOverlap ignores sub-threshold seam overlap between adjacent lines", () => {
  const elFragments = [{ left: 0, right: 200, top: 0, bottom: 20, width: 200, height: 20 }];
  const barelyTouchingFragments = [{ left: 199, right: 210, top: 0, bottom: 20, width: 11, height: 20 }];

  assert.equal(fragmentsSignificantlyOverlap(elFragments, barelyTouchingFragments), false);
});

test("classifyVerticalOverflow flags a fixed-height badge whose wrapped label spills out with default overflow", () => {
  // DaisyUI-style badges/pills rarely set overflow-y at all, so it stays at its default
  // "visible" - the wrapped second word isn't clipped, it just spills outside the pill shape.
  const finding = classifyVerticalOverflow({
    scrollHeight: 40,
    clientHeight: 24,
    overflowY: "visible",
    hasText: true,
    isTruncated: false,
  });

  assert.deepEqual(finding, { overflowPx: 16, kind: "clipped-text", clips: false });
});

test("classifyVerticalOverflow marks hidden/clip overflow-y as a hard clip", () => {
  const finding = classifyVerticalOverflow({
    scrollHeight: 40,
    clientHeight: 24,
    overflowY: "hidden",
    hasText: true,
    isTruncated: false,
  });

  assert.deepEqual(finding, { overflowPx: 16, kind: "clipped-text", clips: true });
});

test("classifyVerticalOverflow ignores intentionally scrollable containers", () => {
  const finding = classifyVerticalOverflow({
    scrollHeight: 400,
    clientHeight: 200,
    overflowY: "auto",
    hasText: true,
    isTruncated: false,
  });

  assert.equal(finding, null);
});

test("classifyVerticalOverflow ignores boxes that simply grow to fit their content", () => {
  const finding = classifyVerticalOverflow({
    scrollHeight: 100,
    clientHeight: 100,
    overflowY: "visible",
    hasText: true,
    isTruncated: false,
  });

  assert.equal(finding, null);
});

test("classifyVerticalOverflow ignores scroll metrics when rendered text stays inside the box", () => {
  const finding = classifyVerticalOverflow({
    scrollHeight: 38,
    clientHeight: 28,
    overflowY: "hidden",
    hasText: true,
    isTruncated: false,
    textOverflowPx: 0,
  });

  assert.equal(finding, null);
});

test("classifyVerticalOverflow ignores one visible line with tight font metrics", () => {
  const finding = classifyVerticalOverflow({
    scrollHeight: 42,
    clientHeight: 32,
    overflowY: "visible",
    hasText: true,
    isTruncated: false,
    textOverflowPx: 8,
    textLineCount: 1,
  });

  assert.equal(finding, null);
});

test("verticalFragmentOverflow measures rendered text beyond the box boundary", () => {
  const fragments = [
    { top: 4, bottom: 18 },
    { top: 20, bottom: 36 },
  ];

  assert.equal(verticalFragmentOverflow(fragments, { top: 0, bottom: 28 }), 8);
});

test("resolveVisibleSpillCandidates keeps the deepest candidate for one bubbled spill", () => {
  const badge = node("span");
  const row = node("div", {}, [badge]);
  const section = node("section", {}, [row]);
  const candidates = [
    { el: section, selector: "section", overflowPx: 16, spillBottom: 140 },
    { el: row, selector: ".row", overflowPx: 16, spillBottom: 140 },
    { el: badge, selector: ".badge", overflowPx: 16, spillBottom: 140 },
  ];

  assert.deepEqual(
    resolveVisibleSpillCandidates(candidates).map((candidate) => candidate.selector),
    [".badge"],
  );
});

test("resolveVisibleSpillCandidates preserves ancestors with independent overflow", () => {
  const badge = node("span");
  const section = node("section", {}, [badge]);
  const candidates = [
    { el: section, selector: "section", overflowPx: 48, spillBottom: 220 },
    { el: badge, selector: ".badge", overflowPx: 16, spillBottom: 140 },
  ];

  assert.deepEqual(
    resolveVisibleSpillCandidates(candidates).map((candidate) => candidate.selector),
    ["section", ".badge"],
  );
});

test("classifyHorizontalOverflow still distinguishes clipped text from generic scroll overflow", () => {
  const clipped = classifyHorizontalOverflow({
    scrollWidth: 300,
    clientWidth: 200,
    overflowX: "hidden",
    hasText: true,
    isTruncated: false,
  });
  assert.deepEqual(clipped, { overflowPx: 100, kind: "clipped-text" });

  const genericScroll = classifyHorizontalOverflow({
    scrollWidth: 300,
    clientWidth: 200,
    overflowX: "visible",
    hasText: true,
    isTruncated: false,
  });
  assert.deepEqual(genericScroll, { overflowPx: 100, kind: "element-scroll-overflow" });
});

test("classifyParentOverflow ignores visual overhang without parent scroll impact", () => {
  const finding = classifyParentOverflow({
    overhangPx: 9,
    scrollWidth: 320,
    clientWidth: 320,
  });

  assert.equal(finding, null);
});

test("classifyParentOverflow keeps contained parent overhang advisory", () => {
  const finding = classifyParentOverflow({
    overhangPx: 9,
    scrollWidth: 329,
    clientWidth: 320,
  });

  assert.deepEqual(finding, {
    overflowPx: 9,
    kind: "element-parent-overflow",
    severity: "warning",
  });
});

test("isModeToggleHotkeyEvent matches Cmd/Ctrl+I regardless of case", () => {
  assert.equal(isModeToggleHotkeyEvent({ key: "i", metaKey: true }), true);
  assert.equal(isModeToggleHotkeyEvent({ key: "I", ctrlKey: true }), true);
  assert.equal(isModeToggleHotkeyEvent({ key: "i", metaKey: true, ctrlKey: true }), true);
});

test("isModeToggleHotkeyEvent requires a modifier so plain typing is unaffected", () => {
  assert.equal(isModeToggleHotkeyEvent({ key: "i" }), false);
  assert.equal(isModeToggleHotkeyEvent({ key: "i", shiftKey: true }), false);
});

test("isModeToggleHotkeyEvent rejects extra shift or alt modifiers", () => {
  assert.equal(isModeToggleHotkeyEvent({ key: "i", ctrlKey: true, shiftKey: true }), false);
  assert.equal(isModeToggleHotkeyEvent({ key: "i", metaKey: true, altKey: true }), false);
});

test("isModeToggleHotkeyEvent ignores other keys even with a modifier held", () => {
  assert.equal(isModeToggleHotkeyEvent({ key: "e", metaKey: true }), false);
  assert.equal(isModeToggleHotkeyEvent({ key: "Enter", metaKey: true }), false);
});
