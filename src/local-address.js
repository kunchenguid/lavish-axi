import os from "node:os";

import { isWildcardHost } from "./paths.js";

// Every concrete address on this machine's interfaces that a Lavish server could be listening on.
// A server pinned to a Tailscale or LAN address by one agent's LAVISH_AXI_HOST is invisible to a
// CLI that only dials its own configured host and loopback, so discovery also sweeps these before
// concluding nothing is running on the port. IPv6 link-local addresses need a zone to be dialed
// and are skipped. Older Node releases report `family` as a number.
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
