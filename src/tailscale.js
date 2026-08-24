import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * @typedef {{ ipv4: string, magicDnsName: string | null }} TailscaleNet
 */

/**
 * Parse `tailscale status --json` into this machine's Tailscale IPv4 and MagicDNS
 * name, or null when Tailscale is not up. Never throws.
 * @param {string} raw
 * @returns {TailscaleNet | null}
 */
export function parseTailscaleStatus(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const state = String(data.BackendState || "");
  if (state !== "Running") return null;

  const ips = [];
  const selfIps = data.Self && Array.isArray(data.Self.TailscaleIPs) ? data.Self.TailscaleIPs : [];
  const topIps = Array.isArray(data.TailscaleIPs) ? data.TailscaleIPs : [];
  for (const ip of [...selfIps, ...topIps]) {
    if (typeof ip === "string") ips.push(ip.trim());
  }
  const ipv4 = ips.find((ip) => isIP(ip) === 4);
  if (!ipv4) return null;

  const dnsRaw = typeof data.Self?.DNSName === "string" ? data.Self.DNSName.trim() : "";
  const magicDnsName = dnsRaw.replace(/\.$/, "").toLowerCase() || null;
  return { ipv4, magicDnsName };
}

/**
 * Detect a running Tailscale node on this machine. Missing binary, a stopped
 * tailnet, or any error returns null - never throws.
 * @param {{ execFile?: typeof execFileAsync, timeoutMs?: number }} [options]
 * @returns {Promise<TailscaleNet | null>}
 */
export async function detectTailscale({ execFile = execFileAsync, timeoutMs = 2000 } = {}) {
  try {
    const { stdout } = await execFile("tailscale", ["status", "--json"], {
      timeout: timeoutMs,
      maxBuffer: 2_000_000,
      encoding: "utf8",
    });
    return parseTailscaleStatus(String(stdout || ""));
  } catch {
    return null;
  }
}
