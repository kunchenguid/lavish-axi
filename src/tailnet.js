/**
 * Live-session access from the user's other tailnet devices via Tailscale Serve.
 *
 * The server stays loopback-bound: tailscaled terminates TLS on the tailnet and
 * proxies to 127.0.0.1 locally, so enabling this never widens the bind address.
 * The MagicDNS hostname joins the Host allowlist through `tailnetAllowedHosts`
 * (consumed by the server's DNS-rebinding guard), and the serve config is
 * port-scoped to its own HTTPS port so it composes with any serve config the
 * operator already runs on :443. Session keys are derivable from file paths and
 * the server is unauthenticated, so public exposure (`tailscale funnel`) is
 * deliberately unsupported - the tailnet's WireGuard device authentication is
 * the access control. Everything here is pure or dependency-injected so it is
 * testable without a tailnet; the CLI command in `src/cli.js` owns process
 * spawning and server restarts.
 */
import { readFileSync } from "node:fs";

import { defaultPort, tailnetStateFile } from "./paths.js";

export const DEFAULT_TAILNET_HTTPS_PORT = 8443;

// macOS app-bundle fallback for when the CLI shim is not on PATH.
export const MACOS_TAILSCALE_APP_BINARY = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

// Tailscale's status JSON reports MagicDNS names with a trailing FQDN dot.
export function normalizeDnsName(name) {
  if (typeof name !== "string") return "";
  return name.trim().replace(/\.$/, "");
}

// Self.DNSName from `tailscale status --json`, normalized, or "" when the
// device has no usable MagicDNS name (logged out, no tailnet DNS).
export function parseSelfDnsName(statusJsonText) {
  let parsed;
  try {
    parsed = JSON.parse(statusJsonText);
  } catch {
    return "";
  }
  const self = parsed && typeof parsed === "object" ? parsed.Self : undefined;
  const dnsName = self && typeof self === "object" ? self.DNSName : undefined;
  return normalizeDnsName(typeof dnsName === "string" ? dnsName : "");
}

export function resolveTailnetHttpsPort(env = process.env) {
  const raw = Number(env.LAVISH_AXI_TAILNET_HTTPS_PORT || DEFAULT_TAILNET_HTTPS_PORT);
  return Number.isInteger(raw) && raw > 0 && raw <= 65_535 ? raw : DEFAULT_TAILNET_HTTPS_PORT;
}

// Port-scoped on purpose: `--https=<port>` creates/clears config for that port
// only, so an existing serve config on :443 (or anything else) is never touched.
export function buildServeArgs({ httpsPort, port = defaultPort() }) {
  return ["serve", "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${port}`];
}

export function buildServeOffArgs({ httpsPort }) {
  return ["serve", "--bg", `--https=${httpsPort}`, "off"];
}

/**
 * Persisted tailnet state, or null when the feature is off or the file is
 * unreadable/malformed. The read is dependency-injected for tests.
 * @param {{ readFile?: (path: string) => string, file?: string }} [options]
 */
export function readTailnetState({ readFile = (file) => readFileSync(file, "utf8"), file = tailnetStateFile() } = {}) {
  let raw;
  try {
    raw = readFile(file);
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const hostname = normalizeDnsName(parsed && typeof parsed === "object" ? parsed.hostname : "");
  if (!hostname) return null;
  const httpsPort =
    parsed && Number.isInteger(parsed.httpsPort) && parsed.httpsPort > 0 && parsed.httpsPort <= 65_535
      ? parsed.httpsPort
      : DEFAULT_TAILNET_HTTPS_PORT;
  return { hostname, httpsPort };
}

// Extra Host allowlist entries contributed by the tailnet feature. The server
// merges these next to LAVISH_AXI_ALLOWED_HOSTS so the DNS-rebinding guard
// accepts the MagicDNS name while the feature is on, and only then.
export function tailnetAllowedHosts(state = readTailnetState()) {
  return state ? [state.hostname] : [];
}

/**
 * Rewrites a locally-generated session URL onto the tailnet origin. Path and
 * query survive unchanged; only scheme and authority move.
 * @param {{ hostname: string, httpsPort: number }} state
 * @param {string} localUrl
 */
export function tailnetUrlFor(state, localUrl) {
  let parsed;
  try {
    parsed = new URL(localUrl);
  } catch {
    return "";
  }
  const suffix = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  const portPart = state.httpsPort === 443 ? "" : `:${state.httpsPort}`;
  return `https://${state.hostname}${portPart}${suffix}`;
}
