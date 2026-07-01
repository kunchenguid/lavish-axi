// Hosted sharing transport: publish a self-contained HTML page to ht-ml.app
// (https://ht-ml.app), a third-party hosting service not part of Lavish, and return a visitable
// share URL. Creation needs no account or API key - `POST /v1/sites` sends the HTML to
// ht-ml.app's servers with an optional password, then returns a `url` plus a secret
// `update_key` (the only credential, returned once, used later to update or delete the page).
// Shares are public by default; when a password is supplied, viewers must enter it before viewing.
// An optional bearer token is supported for callers who have one but is never required.

const DEFAULT_API_URL = "https://api.ht-ml.app";
const PUBLISH_TIMEOUT_MS = 30_000;

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
  const apiUrl = (options.apiUrl ? String(options.apiUrl).replace(/\/+$/, "") : "") || htmlAppApiUrl(env);
  const fetchImpl = options.fetch || fetch;
  const token = optionalString(options.token ?? env.LAVISH_AXI_HTML_APP_TOKEN);

  const headers = { "content-type": "application/json", "user-agent": "lavish-axi" };
  if (token) headers.authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || PUBLISH_TIMEOUT_MS);
  let response;
  let text;
  try {
    response = await fetchImpl(`${apiUrl}/v1/sites`, {
      method: "POST",
      headers,
      body: JSON.stringify(createHtmlAppPayload(html, options)),
      signal: controller.signal,
    });
    text = await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("ht-ml.app publish timed out", { cause: error });
    }
    throw new Error(`ht-ml.app publish failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }

  const data = text ? parseJson(text) : {};
  if (!response.ok) {
    throw new Error(`ht-ml.app publish failed: ${describeError(response.status, data, text)}`);
  }

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
