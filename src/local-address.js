import os from "node:os";

import { isWildcardHost } from "./paths.js";

export const DISCOVER_ALL_INTERFACES_ENV = "LAVISH_AXI_DISCOVER_ALL_INTERFACES";

// The addresses server discovery dials, in preference order: the control hosts (the CLI's
// configured host and loopback), then - only when LAVISH_AXI_DISCOVER_ALL_INTERFACES=1 - every
// other local interface address. Every server since 0.1.78 binds loopback first as the port lock,
// so a current server is always found at loopback. The sweep only finds a 0.1.77-or-older server
// pinned to a Tailscale or LAN address alone, and costs a TCP connect to every VPN, tunnel, and
// LAN address on each CLI invocation, which endpoint monitoring reads as outbound connections.
/**
 * @param {string[]} controlHosts
 * @param {{ env?: NodeJS.ProcessEnv, interfaces?: Parameters<typeof localInterfaceAddresses>[0] }} [options]
 * @returns {string[]}
 */
export function discoveryHosts(controlHosts, { env = process.env, interfaces } = {}) {
  const hosts = [];
  for (const host of controlHosts) {
    if (!hosts.includes(host)) hosts.push(host);
  }
  if (env[DISCOVER_ALL_INTERFACES_ENV] !== "1") return hosts;
  for (const address of localInterfaceAddresses(interfaces)) {
    if (!hosts.includes(address)) hosts.push(address);
  }
  return hosts;
}

// Every concrete address on this machine's interfaces that a Lavish server could be listening on.
// Server replacement uses it to drop inherited addresses that left the machine, and the opt-in
// discovery sweep dials it. IPv6 link-local addresses need a zone to be dialed and are skipped.
// Older Node releases report `family` as a number.
/**
 * @param {Record<string, Array<{ address?: string, family?: string | number, internal?: boolean }> | undefined>} [interfaces]
 * @returns {string[]}
 */
export function localInterfaceAddresses(interfaces = safeNetworkInterfaces()) {
  const addresses = [];
  for (const entries of Object.values(interfaces || {})) {
    for (const entry of entries || []) {
      const address = typeof entry?.address === "string" ? entry.address : "";
      if (!address || isWildcardHost(address)) continue;
      const family = entry.family === 4 ? "IPv4" : entry.family === 6 ? "IPv6" : entry.family;
      if (family !== "IPv4" && family !== "IPv6") continue;
      if (family === "IPv6" && /^fe[89ab]/i.test(address)) continue;
      if (!addresses.includes(address)) addresses.push(address);
    }
  }
  return addresses;
}

function safeNetworkInterfaces() {
  try {
    return os.networkInterfaces();
  } catch {
    return {};
  }
}
