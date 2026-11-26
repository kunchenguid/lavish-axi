import { parse } from "parse5";

// parse5 finds the real </body> the way a browser does: a literal "</body>"
// inside a script, style, comment, attribute value, or inert template content
// is character data, not markup. Splice at the parser-reported end-tag offset
// so served bytes stay identical to the file on disk apart from the SDK tag.
function findBodyElement(node) {
  if (node.tagName === "body") return node;
  if (!Array.isArray(node.childNodes)) return null;
  for (const child of node.childNodes) {
    const found = findBodyElement(child);
    if (found) return found;
  }
  return null;
}

function bodyCloseIndex(html) {
  const body = findBodyElement(parse(html, { sourceCodeLocationInfo: true }));
  const endTag = body && body.sourceCodeLocation && body.sourceCodeLocation.endTag;
  return endTag ? endTag.startOffset : -1;
}

export function injectLavishSdk(html, key, artifactRevision, artifactLoadToken = "") {
  const revisionNumber = Number(artifactRevision);
  const revision = Number.isFinite(revisionNumber) && revisionNumber >= 0 ? Math.trunc(revisionNumber) : null;
  const revisionQuery = revision === null ? "" : `&artifact_revision=${revision}`;
  const token = String(artifactLoadToken || "").slice(0, 200);
  const tokenQuery = token ? `&artifact_load_token=${encodeURIComponent(token)}` : "";
  const script = `<script src="/sdk.js?key=${encodeURIComponent(key)}${revisionQuery}${tokenQuery}"></script>`;
  const index = bodyCloseIndex(html);
  if (index !== -1) {
    return `${html.slice(0, index)}${script}${html.slice(index)}`;
  }
  return `${html}\n${script}`;
}
