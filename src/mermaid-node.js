/* global document */

// Pure Mermaid node-identity helpers shared by the injected artifact SDK and the
// server-side session store. These functions are deliberately closure-free: the
// SDK ships them to the browser by serializing them with `.toString()` (see
// `createSdkJs`), so they must not reference anything outside their own bodies,
// their arguments, or browser globals. Keeping them here — instead of inside the
// `createArtifactSdk` closure — lets us unit test the label/identity logic
// directly and lets the server reuse the same target-shape contract.

// True when an <svg> was produced by Mermaid. We key on Mermaid's own output
// markers (id prefix, aria-roledescription, or a `.mermaid` / opt-in ancestor)
// rather than on how the diagram got onto the page, so author-pasted CDN
// diagrams, other Mermaid versions, and opt-in wrappers all match identically.
export function isMermaidSvg(svg) {
  if (!svg) return false;
  const id = svg.id || "";
  if (id.startsWith("mermaid-") || id.startsWith("mermaid_")) return true;
  if (svg.getAttribute?.("aria-roledescription")) return true;
  return !!(svg.closest && svg.closest(".mermaid, [data-lavish-mermaid]"));
}

// Extract a node's visible label as a single line. Mermaid renders multi-line
// labels (`A<br/>B`) as real <br> elements, which textContent silently drops —
// so we swap <br> for a space before reading, giving "A B" instead of "AB".
export function readNodeLabel(labelEl) {
  if (!labelEl) return "";
  let source = labelEl;
  if (labelEl.querySelector?.("br") && labelEl.cloneNode) {
    source = labelEl.cloneNode(true);
    for (const br of source.querySelectorAll("br")) br.replaceWith(document.createTextNode(" "));
  }
  return (source.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120);
}

// Resolve a Mermaid graph node from a click target, anchoring to the node's own
// identity (Mermaid's stable node id and its rendered label) rather than a
// structural CSS path, so the annotation survives a re-render that reshuffles
// the SVG. `selector` is passed in because it is owned by the SDK closure.
// Returns null when the element is not inside a Mermaid node.
export function mermaidNodeFrom(el, selector) {
  if (!el || !el.closest) return null;
  const node = el.closest("g.node, g.nodes > g");
  if (!node) return null;
  const svg = node.closest("svg");
  if (!svg || !isMermaidSvg(svg)) return null;

  const labelEl = node.querySelector(".nodeLabel, .label, foreignObject span, text");
  return {
    type: "mermaid-node",
    diagramId: svg.id || "",
    nodeId: node.id || "",
    label: readNodeLabel(labelEl),
    selector: typeof selector === "function" ? selector(node) : "",
  };
}

// Validate and canonicalize a mermaid-node target coming back from the browser.
// Strips unknown/hostile fields to a fixed shape before it reaches the agent.
export function normalizeMermaidNodeTarget(target) {
  return {
    type: "mermaid-node",
    diagramId: String(target.diagramId || ""),
    nodeId: String(target.nodeId || ""),
    label: String(target.label || ""),
    selector: String(target.selector || ""),
  };
}
