const HARDCODED_FALLBACK_HOST = "https://a.kunchenguid.com";
const UMAMI_PATH = "/api/send";
const DEFAULT_HOSTNAME = "cli";
const DEFAULT_TITLE = "Lavish Editor CLI";
const DEFAULT_REQUEST_TIMEOUT_MS = 1_000;

export function resolveTelemetryConfig(input) {
  const optOut = String(input.env.LAVISH_AXI_TELEMETRY || "")
    .trim()
    .toLowerCase();
  if (optOut === "0" || optOut === "false" || optOut === "off") {
    return { enabled: false, host: "", websiteID: "" };
  }

  const websiteID = String(input.env.LAVISH_AXI_UMAMI_WEBSITE_ID || "").trim() || input.buildWebsiteID.trim();
  if (!websiteID) {
    return { enabled: false, host: "", websiteID: "" };
  }

  const host =
    String(input.env.LAVISH_AXI_UMAMI_HOST || "").trim() || input.buildHost.trim() || HARDCODED_FALLBACK_HOST;
  return { enabled: true, host, websiteID };
}

export function getBuildTimeUmamiHost() {
  return process.env.LAVISH_AXI_BUILD_UMAMI_HOST || "";
}

export function getBuildTimeUmamiWebsiteID() {
  return process.env.LAVISH_AXI_BUILD_UMAMI_WEBSITE_ID || "";
}

export function createTelemetryClient(config) {
  if (!config.enabled || !config.websiteID) {
    return new NoopTelemetryClient();
  }
  const endpoint = normalizeEndpoint(config.host);
  if (!endpoint) {
    return new NoopTelemetryClient();
  }
  return new HttpTelemetryClient(endpoint, config);
}

let defaultClient = null;

export function initDefaultTelemetry(init) {
  const resolved = resolveTelemetryConfig({
    env: init.env || process.env,
    buildHost: getBuildTimeUmamiHost(),
    buildWebsiteID: getBuildTimeUmamiWebsiteID(),
  });
  defaultClient = createTelemetryClient({
    enabled: resolved.enabled,
    host: resolved.host,
    websiteID: resolved.websiteID,
    app: init.app,
    version: init.version,
    platform: init.platform,
    arch: init.arch,
  });
  return defaultClient;
}

export function getDefaultTelemetry() {
  return defaultClient || new NoopTelemetryClient();
}

export function resetDefaultTelemetryForTests() {
  defaultClient = null;
}

class NoopTelemetryClient {
  track() {}

  pageview() {}

  async close() {}
}

class HttpTelemetryClient {
  constructor(endpoint, config) {
    this.endpoint = endpoint;
    this.websiteID = config.websiteID;
    this.app = config.app;
    this.version = config.version;
    this.platform = config.platform || "";
    this.arch = config.arch || "";
    this.fetchImpl = config.fetch || fetch;
    this.timeoutMs = config.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    this.userAgent = `${config.app}/${config.version} telemetry`;
    this.inFlight = new Set();
    this.closed = false;
  }

  track(name, fields = {}) {
    if (this.closed) return;
    const trimmed = String(name || "").trim();
    if (!trimmed) return;
    this.send(trimmed, eventURL(this.app, trimmed), fields);
  }

  pageview(path, fields = {}) {
    if (this.closed) return;
    this.send("", normalizePagePath(path), fields);
  }

  async close(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.closed = true;
    if (this.inFlight.size === 0 || timeoutMs <= 0) return;
    const drained = Promise.allSettled(Array.from(this.inFlight)).then(() => undefined);
    await Promise.race([
      drained,
      new Promise((resolve) => {
        setTimeout(resolve, timeoutMs);
      }),
    ]);
  }

  send(name, url, fields) {
    const data = { ...fields };
    if (this.platform && data.platform === undefined) data.platform = this.platform;
    if (this.arch && data.arch === undefined) data.arch = this.arch;
    if (data.version === undefined) data.version = this.version;

    const payload = {
      type: "event",
      payload: {
        website: this.websiteID,
        hostname: DEFAULT_HOSTNAME,
        title: DEFAULT_TITLE,
        url,
        name,
        data,
        timestamp: Math.floor(Date.now() / 1000),
      },
    };

    let body;
    try {
      body = JSON.stringify(payload);
    } catch {
      return;
    }

    const request = this.fire(body);
    this.inFlight.add(request);
    request.finally(() => this.inFlight.delete(request));
  }

  async fire(body) {
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": this.userAgent,
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      try {
        await response.body?.cancel?.();
      } catch {
        // Best effort only.
      }
    } catch {
      // Telemetry must never affect CLI behavior.
    }
  }
}

function normalizeEndpoint(host) {
  let url;
  try {
    url = new URL(String(host || "").trim());
  } catch {
    return null;
  }
  if (!url.protocol || !url.host) return null;
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.endsWith(UMAMI_PATH) ? pathname : pathname + UMAMI_PATH;
  return url.toString();
}

function eventURL(app, name) {
  if (!name) return `app://${app}`;
  return `app://${app}/${name.replace(/\./g, "/")}`;
}

function normalizePagePath(path) {
  const trimmed = String(path || "").trim();
  if (!trimmed) return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
