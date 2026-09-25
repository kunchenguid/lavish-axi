import { resolveChromeTheme } from "./chrome-theme.js";

/**
 * @param {string} html
 * @param {string} key
 * @param {number} [artifactRevision]
 * @param {string} [artifactLoadToken]
 * @param {{ theme?: unknown }} [options] the reviewer's chrome theme, so the SDK can apply it
 *   before first paint instead of after the load event
 */
export function injectLavishSdk(html, key, artifactRevision, artifactLoadToken = "", { theme } = {}) {
  const revisionNumber = Number(artifactRevision);
  const revision = Number.isFinite(revisionNumber) && revisionNumber >= 0 ? Math.trunc(revisionNumber) : null;
  const revisionQuery = revision === null ? "" : `&artifact_revision=${revision}`;
  const token = String(artifactLoadToken || "").slice(0, 200);
  const tokenQuery = token ? `&artifact_load_token=${encodeURIComponent(token)}` : "";
  const themeQuery = typeof theme === "string" && resolveChromeTheme(theme) === theme ? `&theme=${theme}` : "";
  const script = `<script src="/sdk.js?key=${encodeURIComponent(key)}${revisionQuery}${tokenQuery}${themeQuery}"></script>`;
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${script}</body>`);
  }
  return `${html}\n${script}`;
}
