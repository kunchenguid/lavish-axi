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

export function injectSessionLinkNavigation(html, servedOrigin) {
  const origin = new URL(servedOrigin);
  if (!/^https?:$/.test(origin.protocol)) throw new TypeError("Invalid artifact origin");
  const scriptUrl = new URL("/session-link-navigation.js", origin.origin).href;
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
        if (
          attrs.get("src") === scriptUrl &&
          executable &&
          !attrs.has("nomodule") &&
          !attrs.has("crossorigin") &&
          !attrs.has("integrity")
        ) {
          return html;
        }
      }
    }
    if ("childNodes" in node) nodes.push(...node.childNodes);
  }
  const script = `<script src="${scriptUrl}"></script>`;
  if (bodyEnd !== undefined) return html.slice(0, bodyEnd) + script + html.slice(bodyEnd);
  return `${html}\n${script}`;
}

// Use a reversible byte mapping for ASCII-compatible encodings, so charset
// declarations and non-UTF-8 text survive delivery. UTF-16 BOMs need code-unit
// decoding so the HTML parser can recognize tags; keep their original byte order.
export function injectSessionLinkNavigationBytes(bytes, servedOrigin) {
  const littleEndian = bytes[0] === 0xff && bytes[1] === 0xfe;
  const bigEndian = bytes[0] === 0xfe && bytes[1] === 0xff;
  if (!littleEndian && !bigEndian) {
    const bomLength = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    return Buffer.concat([
      bytes.subarray(0, bomLength),
      Buffer.from(injectSessionLinkNavigation(bytes.subarray(bomLength).toString("latin1"), servedOrigin), "latin1"),
    ]);
  }
  const codeUnits = Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2)));
  if (bigEndian) codeUnits.swap16();
  const transformed = Buffer.from(
    "\ufeff" + injectSessionLinkNavigation(codeUnits.toString("utf16le").slice(1), servedOrigin),
    "utf16le",
  );
  if (bigEndian) transformed.swap16();
  return Buffer.concat([transformed, bytes.subarray(codeUnits.length)]);
}
