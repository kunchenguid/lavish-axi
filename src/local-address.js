import os from "node:os";

export function isLocalAddressPresent(host) {
  if (typeof host !== "string" || host === "") return false;
  try {
    for (const entries of Object.values(os.networkInterfaces() || {})) {
      for (const entry of entries || []) {
        if (entry?.address === host) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}
