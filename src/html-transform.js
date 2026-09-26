export function injectLavishSdk(html, key, artifactRevision, artifactLoadToken = "", context = {}) {
  const hasRevision = artifactRevision !== null && artifactRevision !== undefined && artifactRevision !== "";
  const revisionNumber = hasRevision ? Number(artifactRevision) : Number.NaN;
  const revision = Number.isFinite(revisionNumber) && revisionNumber >= 0 ? Math.trunc(revisionNumber) : null;
  const token = String(artifactLoadToken || "").slice(0, 200);
  let query = `key=${encodeURIComponent(key)}`;
  if (context?.pageProtocol === 1 || context?.page_protocol === 1) {
    query += "&page_protocol=1";
    if (context.page !== undefined && context.page !== null) {
      query += `&page=${encodeURIComponent(String(context.page))}`;
    }
    if (context.pageProof) query += `&page_proof=${encodeURIComponent(String(context.pageProof))}`;
    if (context.servedRoute) query += `&served_route=${encodeURIComponent(String(context.servedRoute))}`;
    if (context.chromeNonce) query += `&chrome_nonce=${encodeURIComponent(String(context.chromeNonce))}`;
    if (context.chromeAuth) query += `&chrome_auth=${encodeURIComponent(String(context.chromeAuth))}`;
  }
  if (revision !== null) query += `&artifact_revision=${revision}`;
  if (token) query += `&artifact_load_token=${encodeURIComponent(token)}`;
  const script = `<script src="/sdk.js?${query}"></script>`;
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${script}</body>`);
  }
  return `${html}\n${script}`;
}
