import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const LOOPBACK_HOST = "127.0.0.1";

// Binding to a wildcard address means "all interfaces" - it is not itself a connectable
// target, so the CLI's local control channel falls back to loopback in that case.
const WILDCARD_BIND_HOSTS = new Set(["0.0.0.0", "::"]);

// Address the server binds to (LAVISH_AXI_HOST). Defaults to loopback. A wildcard value
// (0.0.0.0 or ::) binds every interface.
export function bindHost(env = process.env) {
  return env.LAVISH_AXI_HOST?.trim() || LOOPBACK_HOST;
}

// Host the CLI uses to reach the server it spawned. A wildcard bind address can't be
// dialed directly, so the local control channel falls back to loopback.
export function clientHost(env = process.env) {
  const host = bindHost(env);
  return WILDCARD_BIND_HOSTS.has(host) ? LOOPBACK_HOST : host;
}

// Hostname written into the session URLs the server generates (LAVISH_AXI_LINK_HOST).
// Defaults to the host the CLI dials.
export function linkHost(env = process.env) {
  return env.LAVISH_AXI_LINK_HOST?.trim() || clientHost(env);
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
