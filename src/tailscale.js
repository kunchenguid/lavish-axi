import { execFile } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function tailscaleCommandCandidates(platform = process.platform, env = process.env) {
  const candidates = ["tailscale"];
  if (platform === "darwin") {
    candidates.push(
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      "/Applications/Tailscale.app/Contents/MacOS/tailscale",
      "/opt/homebrew/bin/tailscale",
      "/usr/local/bin/tailscale",
    );
  } else if (platform === "win32") {
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    candidates.push(`${programFiles}\\Tailscale\\tailscale.exe`);
  } else {
    candidates.push("/usr/bin/tailscale", "/usr/local/bin/tailscale");
  }
  return [...new Set(candidates)];
}

/**
 * @typedef {{ ipv4: string, magicDnsName: string }} TailscaleNet
 * @typedef {{ ipv4: null, magicDnsName: null, warning: string }} IncompleteTailscaleNet
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
  const magicDnsName = dnsRaw.replace(/\.$/, "").toLowerCase();
  const labels = magicDnsName.split(".");
  if (
    magicDnsName.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    return null;
  }
  return { ipv4, magicDnsName };
}

async function resolveTailscaleCommand(command, env) {
  const candidates = path.isAbsolute(command)
    ? [command]
    : (env.PATH ?? (process.platform === "win32" ? "" : "/usr/bin:/bin")).split(path.delimiter).flatMap((directory) => {
        const candidate = path.resolve(directory, command);
        return process.platform === "win32" ? [candidate, `${candidate}.exe`] : [candidate];
      });
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Missing or inaccessible candidates must not trigger a launch attempt.
    }
  }
  return null;
}

/**
 * Detect a running Tailscale node on this machine. Missing binary, a stopped
 * tailnet, or any error returns null - never throws.
 * @param {{ execFile?: typeof execFileAsync, timeoutMs?: number, commands?: string[], now?: () => number, env?: NodeJS.ProcessEnv, resolveCommand?: typeof resolveTailscaleCommand }} [options]
 * @returns {Promise<TailscaleNet | IncompleteTailscaleNet | null>}
 */
export async function detectTailscale({
  execFile = execFileAsync,
  timeoutMs = 2000,
  commands = tailscaleCommandCandidates(),
  now = Date.now,
  env = process.env,
  resolveCommand = resolveTailscaleCommand,
} = {}) {
  const deadline = now() + timeoutMs;
  let incompleteRunningStatus = false;
  for (const command of commands) {
    if (deadline - now() <= 0) break;
    try {
      const resolvedCommand = await resolveCommand(command, env);
      if (!resolvedCommand) continue;
      const remainingMs = deadline - now();
      if (remainingMs <= 0) break;
      const { stdout } = await execFile(resolvedCommand, ["status", "--json"], {
        timeout: remainingMs,
        maxBuffer: 2_000_000,
        encoding: "utf8",
      });
      const raw = String(stdout || "");
      const status = parseTailscaleStatus(raw);
      if (status) return status;
      incompleteRunningStatus ||= isIncompleteRunningTailscaleStatus(raw);
    } catch {
      continue;
    }
  }
  if (incompleteRunningStatus) {
    return {
      ipv4: null,
      magicDnsName: null,
      warning:
        "Tailscale is running but MagicDNS is unavailable; there is no phone access. Lavish remains available on loopback.",
    };
  }
  return null;
}

function isIncompleteRunningTailscaleStatus(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!data || typeof data !== "object" || String(data.BackendState || "") !== "Running") return false;
  const addresses = [
    ...(Array.isArray(data.Self?.TailscaleIPs) ? data.Self.TailscaleIPs : []),
    ...(Array.isArray(data.TailscaleIPs) ? data.TailscaleIPs : []),
  ];
  return addresses.some((address) => typeof address === "string" && isIP(address.trim()) === 4);
}
