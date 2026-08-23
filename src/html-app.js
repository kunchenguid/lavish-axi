// Hosted sharing transport: publish a self-contained HTML page to ht-ml.app
// (https://ht-ml.app), a third-party hosting service not part of Lavish, and return a visitable
// share URL. Creation needs no account or API key - `POST /v1/sites` sends the HTML to
// ht-ml.app's servers with an optional password, then returns a `url` plus a secret
// `update_key` (the only credential, returned once, used later to update the page).
// Shares are public by default; when a password is supplied, viewers must enter it before viewing.
// An optional bearer token is supported for callers who have one but is never required.
//
// `PUT /v1/sites/{site_id}` republishes an existing page and authenticates with that secret
// `update_key` as the bearer credential. Omitting `password` there preserves whatever the page
// already had, so set/clear is deliberate rather than implied by every update. The service has
// no delete endpoint at all, which is why unpublishing is a republish of a placeholder page
// rather than a removal.

const DEFAULT_API_URL = "https://api.ht-ml.app";
const PUBLISH_TIMEOUT_MS = 30_000;
const SITE_ID_RE = /^[A-Za-z0-9._-]+$/;

export function htmlAppApiUrl(env = process.env) {
  return String(env.LAVISH_AXI_HTML_APP_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
}

export function createHtmlAppPayload(html, options = {}) {
  const body = { html_content: String(html ?? "") };
  const password = optionalString(options.password);
  if (password) body.password = password;
  return body;
}

/**
 * Update payload. An absent password preserves the site's current one; an empty string clears it.
 * @param {string} html
 * @param {{ password?: string | null }} [options]
 */
export function createHtmlAppUpdatePayload(html, options = {}) {
  const body = { html_content: String(html ?? "") };
  if (options.password !== undefined && options.password !== null) body.password = optionalString(options.password);
  return body;
}

/**
 * Validate the site identifier the host returned at create time. A URL is the thing users have
 * in hand and the thing that is not a site_id, so it gets its own message instead of a generic
 * rejection; everything else is refused because it would be interpolated into the request path.
 * @param {string} value
 * @returns {string}
 */
export function normalizeSiteId(value) {
  const siteId = optionalString(value);
  if (!siteId) throw new Error("a site_id is required");
  if (/^[a-z]+:\/\//i.test(siteId)) {
    throw new Error(`expected a site_id (such as abc123) rather than a URL: ${siteId}`);
  }
  if (!SITE_ID_RE.test(siteId)) {
    throw new Error(`not a valid site_id: ${siteId}`);
  }
  return siteId;
}

/**
 * The page an unpublished share is replaced with. ht-ml.app has no delete endpoint, so the page
 * keeps existing at its URL; this is what a visitor finds there afterwards.
 */
export function createUnpublishedPageHtml() {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    "<title>Unpublished</title>" +
    "<style>html{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;" +
    "font:16px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}" +
    "p{max-width:30rem;padding:2rem;text-align:center}</style>" +
    "</head><body><p>This page has been unpublished. Its contents are no longer available.</p></body></html>"
  );
}

/**
 * Publish HTML to the third-party ht-ml.app service and return the live site.
 * @param {string} html The (ideally self-contained) HTML to send to the host.
 * @param {object} [options]
 * @param {string} [options.password] Make the site private behind this password.
 * @param {string} [options.token] Optional bearer token (never required to create a site).
 * @param {string} [options.apiUrl] Override the API base (defaults to LAVISH_AXI_HTML_APP_API_URL or ht-ml.app).
 * @param {typeof fetch} [options.fetch] Injected fetch for testing.
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ url: string, site_id: string, update_key: string, status: string }>}
 */
export async function publishToHtmlApp(html, options = {}) {
  const env = options.env || process.env;
  const token = optionalString(options.token ?? env.LAVISH_AXI_HTML_APP_TOKEN);
  const data = await requestHtmlApp({
    method: "POST",
    path: "/v1/sites",
    body: createHtmlAppPayload(html, options),
    bearer: token,
    options,
    env,
  });

  const url = optionalString(data.url);
  if (!url) {
    throw new Error("ht-ml.app publish failed: response did not include a url");
  }
  const updateKey = optionalString(data.update_key);
  if (!updateKey) {
    throw new Error("ht-ml.app publish failed: response did not include an update_key");
  }
  return {
    url,
    site_id: String(data.site_id || ""),
    update_key: updateKey,
    status: String(data.status || ""),
  };
}

/**
 * Republish an existing ht-ml.app page with new HTML. The secret update_key is the credential.
 * @param {string} siteId The site_id returned when the page was created.
 * @param {string} html The replacement HTML.
 * @param {object} [options]
 * @param {string} [options.updateKey] Required secret write credential for the site.
 * @param {string|null} [options.password] Set a password, `""` to clear it, or omit to preserve it.
 * @param {string} [options.url] The known site URL, used when the response omits one.
 * @param {string} [options.apiUrl]
 * @param {typeof fetch} [options.fetch]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ url: string, site_id: string, status: string }>}
 */
export async function updateHtmlApp(siteId, html, options = {}) {
  const env = options.env || process.env;
  const site = normalizeSiteId(siteId);
  const updateKey = optionalString(options.updateKey);
  if (!updateKey) {
    throw new Error("ht-ml.app update failed: an update_key is required to change a published page");
  }
  const data = await requestHtmlApp({
    method: "PUT",
    path: `/v1/sites/${encodeURIComponent(site)}`,
    body: createHtmlAppUpdatePayload(html, options),
    bearer: updateKey,
    options,
    env,
    action: "update",
  });

  return {
    url: optionalString(data.url) || optionalString(options.url) || `https://${site}.ht-ml.app/`,
    site_id: String(data.site_id || site),
    status: String(data.status || ""),
  };
}

async function requestHtmlApp({ method, path, body, bearer, options, env, action = "publish" }) {
  const apiUrl = (options.apiUrl ? String(options.apiUrl).replace(/\/+$/, "") : "") || htmlAppApiUrl(env);
  const fetchImpl = options.fetch || fetch;

  const headers = { "content-type": "application/json", "user-agent": "lavish-axi" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || PUBLISH_TIMEOUT_MS);
  let response;
  let text;
  try {
    response = await fetchImpl(`${apiUrl}${path}`, {
      method,
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    text = await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`ht-ml.app ${action} timed out`, { cause: error });
    }
    throw new Error(`ht-ml.app ${action} failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }

  const data = text ? parseJson(text) : {};
  if (!response.ok) {
    throw new Error(`ht-ml.app ${action} failed: ${describeError(response.status, data, text)}`);
  }
  return data;
}

function describeError(status, data, text) {
  const detail = optionalString(data.detail || data.error || data.message);
  if (detail) return detail;
  if (status === 422) return "the HTML failed ht-ml.app's content safety scan";
  if (status === 401) return "unauthorized (invalid update_key, or the site is password protected)";
  if (status === 403) return "forbidden";
  return text ? text.slice(0, 200) : `HTTP ${status}`;
}

function optionalString(value) {
  return String(value ?? "").trim();
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text };
  }
}
