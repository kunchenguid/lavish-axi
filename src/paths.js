import { lookup as dnsLookup } from "node:dns/promises";
import { mkdir } from "node:fs/promises";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";

export const LOOPBACK_HOST = "127.0.0.1";
export const IPV6_LOOPBACK_HOST = "::1";

export function isWildcardHost(host) {
  const value = String(host || "")
    .trim()
    .toLowerCase();
  const unbracketed = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  const family = isIP(unbracketed);
  if (family === 4) return unbracketed === "0.0.0.0";
  if (family !== 6) return false;
  try {
    const normalized = new URL(`http://[${unbracketed}]/`).hostname.slice(1, -1);
    return normalized === "::" || normalized === "::ffff:0:0";
  } catch {
    return false;
  }
}

// Address the server binds to (LAVISH_AXI_HOST). Defaults to loopback. A wildcard value
// (0.0.0.0 or ::) is never listened on; resolveListenHosts maps it to loopback.
export function bindHost(env = process.env) {
  return env.LAVISH_AXI_HOST?.trim() || LOOPBACK_HOST;
}

/**
 * Concrete listen addresses. Never includes 0.0.0.0 / ::.
 * When LAVISH_AXI_HOST is unset, bind loopback plus Tailscale IPv4 if present.
 * An explicit LAVISH_AXI_HOST stays that single safe concrete address.
 * @param {{ host?: string, env?: NodeJS.ProcessEnv, tailscale?: { ipv4?: string } | null }} [options]
 * @returns {string[]}
 */
export function resolveListenHosts({ host, env = process.env, tailscale = null } = {}) {
  const envHost = env.LAVISH_AXI_HOST?.trim() || "";
  const autoTailscale = !envHost;
  const requested = host || bindHost(env);
  const primary = isWildcardHost(requested) ? LOOPBACK_HOST : requested || LOOPBACK_HOST;
  const hosts = [primary];
  if (autoTailscale && tailscale?.ipv4 && tailscale.ipv4 !== primary && !isWildcardHost(tailscale.ipv4)) {
    hosts.push(tailscale.ipv4);
  }
  return sanitizeListenHosts(hosts);
}

/**
 * @param {string[] | undefined} hosts
 * @returns {string[]}
 */
export function sanitizeListenHosts(hosts) {
  const out = [];
  for (const value of hosts || []) {
    const host = String(value || "").trim();
    if (!host || isWildcardHost(host)) continue;
    if (!out.includes(host)) out.push(host);
  }
  return out.length ? out : [LOOPBACK_HOST];
}

/**
 * @param {string[]} hosts
 * @param {{ lookup?: typeof dnsLookup }} [options]
 * @returns {Promise<string[]>}
 */
export async function resolveConcreteListenHosts(hosts, { lookup = dnsLookup } = {}) {
  const resolved = [];
  for (const host of hosts) {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (!Array.isArray(addresses) || addresses.length === 0) {
      throw new Error(`Listen host did not resolve: ${host}`);
    }
    if (addresses.some(({ address }) => isWildcardHost(address))) {
      throw new Error(`Listen host resolves to an all-interfaces address: ${host}`);
    }
    const address = addresses[0]?.address;
    if (!address || !isIP(address)) throw new Error(`Listen host did not resolve to an IP address: ${host}`);
    if (!resolved.includes(address)) resolved.push(address);
  }
  return resolved;
}

/**
 * Hostname written into session URLs. A running Tailscale MagicDNS name is the
 * phone-ready headline host; an explicit link host is used only without MagicDNS.
 * @param {{ env?: NodeJS.ProcessEnv, tailscale?: { magicDnsName?: string | null, ipv4?: string } | null, fallbackHost?: string }} [options]
 */
export function resolveLinkHost({ env = process.env, tailscale = null, fallbackHost = LOOPBACK_HOST } = {}) {
  if (tailscale?.magicDnsName) return tailscale.magicDnsName;
  const explicit = env.LAVISH_AXI_LINK_HOST?.trim();
  if (explicit) return explicit;
  return isWildcardHost(fallbackHost) ? LOOPBACK_HOST : fallbackHost || LOOPBACK_HOST;
}

// Host the CLI uses to reach the server it spawned. A wildcard bind address can't be
// dialed directly, so the local control channel falls back to loopback.
export function clientHost(env = process.env) {
  return resolveListenHosts({ env })[0];
}

// Hostname written into the session URLs the server generates (LAVISH_AXI_LINK_HOST).
// Defaults to the host the CLI dials.
export function linkHost(env = process.env) {
  return env.LAVISH_AXI_LINK_HOST?.trim() || clientHost(env);
}

// Extra Host header values the server's DNS-rebinding guard accepts beyond the
// loopback names and the resolved bind/link host, set via LAVISH_AXI_ALLOWED_HOSTS
// (whitespace-separated). A lone "*" disables the guard entirely - an explicit
// opt-out for operators fronting the server with their own auth/proxy.
export function extraAllowedHosts(env = process.env) {
  return (env.LAVISH_AXI_ALLOWED_HOSTS || "").split(/\s+/).filter(Boolean);
}

// Brackets an IPv6 literal so it can be safely interpolated into a URL authority.
// IPv4 addresses and hostnames pass through unchanged.
export function hostForUrl(host) {
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

export function stateDir() {
  return process.env.LAVISH_AXI_STATE_DIR || path.join(os.homedir(), ".lavish-axi");
}

export function stateFile() {
  return path.join(stateDir(), "state.json");
}

export function serverLogFile() {
  return path.join(stateDir(), "server.log");
}

export async function ensureStateDir() {
  await mkdir(stateDir(), { recursive: true });
}

export function defaultPort() {
  return Number(process.env.LAVISH_AXI_PORT || 4387);
}
