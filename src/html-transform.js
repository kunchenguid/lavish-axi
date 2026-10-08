import { parse } from "parse5";

export function injectLavishSdk(html, key, artifactRevision, artifactLoadToken = "") {
  const revisionNumber = Number(artifactRevision);
  const revision = Number.isFinite(revisionNumber) && revisionNumber >= 0 ? Math.trunc(revisionNumber) : null;
  const revisionQuery = revision === null ? "" : `&artifact_revision=${revision}`;
  const token = String(artifactLoadToken || "").slice(0, 200);
  const tokenQuery = token ? `&artifact_load_token=${encodeURIComponent(token)}` : "";
  const script = `<script src="/sdk.js?key=${encodeURIComponent(key)}${revisionQuery}${tokenQuery}"></script>`;
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${script}</body>`);
  }
  return `${html}\n${script}`;
}

const SESSION_LINK_LOADER = `(() => {
  const script = document.createElement("script");
  script.src = new URL("/session-link-navigation.js", location.href).href;
  document.head.appendChild(script);
})();`;

export function injectSessionLinkNavigation(html) {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const nodes = [...document.childNodes];
  let bodyEnd;
  while (nodes.length) {
    const node = nodes.pop();
    if ("tagName" in node && node.namespaceURI === "http://www.w3.org/1999/xhtml") {
      if (node.tagName === "body") bodyEnd = node.sourceCodeLocation?.endTag?.startOffset;
      if (node.tagName === "script") {
        const attrs = new Map(node.attrs.map(({ name, value }) => [name, value]));
        const type = (attrs.get("type") ?? (attrs.get("language") ? `text/${attrs.get("language")}` : ""))
          .trim()
          .toLowerCase();
        const executable =
          !type ||
          /^(?:application\/(?:x-)?(?:java|ecma)script|text\/(?:(?:x-)?(?:java|ecma)script|javascript1\.[0-5]|jscript|livescript))$/.test(
            type,
          );
        const content = node.childNodes.map((child) => ("value" in child ? child.value : "")).join("");
        if (!attrs.has("src") && executable && !attrs.has("nomodule") && content === SESSION_LINK_LOADER) {
          return html;
        }
      }
    }
    if ("childNodes" in node) nodes.push(...node.childNodes);
  }
  const script = `<script>${SESSION_LINK_LOADER}</script>`;
  if (bodyEnd !== undefined) return html.slice(0, bodyEnd) + script + html.slice(bodyEnd);
  return `${html}\n${script}`;
}
