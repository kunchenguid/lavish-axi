// Resolve the OS appearance (light/dark) and translate the device theme
// preference into a short directive agents can read when they write an
// artifact. The CLI runs on the user's machine, so for `system` we can read
// the current OS appearance at the moment the artifact is being generated and
// fold that into the directive. The artifact itself stays static HTML - we
// do not claim the baked theme will keep following the OS if the user
// toggles the system appearance later. That trade-off is documented in
// AGENTS.md and in the design hint.

import { execFile as execFileCb } from "node:child_process";

/**
 * Promise-friendly wrapper around `child_process.execFile` that returns the
 * stdout trimmed of trailing whitespace. Any error (missing binary, non-zero
 * exit, timeout) is swallowed and resolves to `null` so callers can treat a
 * failed OS-appearance query the same as "platform not supported".
 *
 * @param {string} file
 * @param {readonly string[]} args
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<string | null>}
 */
function execFileTrimmed(file, args, { timeoutMs = 750 } = {}) {
  return new Promise((resolve) => {
    execFileCb(file, args, { timeout: timeoutMs }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(String(stdout ?? "").trim());
    });
  });
}

/**
 * Best-effort resolution of the current OS appearance ("light" or "dark").
 * Returns null when the platform cannot be queried or the query fails - the
 * caller is expected to fall back to a neutral, non-presumptive directive
 * rather than guess.
 *
 * @param {NodeJS.Platform} [platform]
 * @param {{ exec?: typeof execFileTrimmed }} [deps]
 * @returns {Promise<"light" | "dark" | null>}
 */
export async function resolveSystemAppearance(platform = process.platform, { exec = execFileTrimmed } = {}) {
  try {
    if (platform === "darwin") {
      // "System Events" reads the user-level appearance pref (System Settings
      // -> Appearance). It returns "true" for dark, "false" for light, and
      // fails when System Events is not running or the user has not granted
      // accessibility access.
      const stdout = await exec("osascript", [
        "-e",
        'tell application "System Events" to get dark mode of appearance preferences',
      ]);
      if (stdout === null) return null;
      const normalized = stdout.trim().toLowerCase();
      if (normalized === "true") return "dark";
      if (normalized === "false") return "light";
      return null;
    }
    if (platform === "win32") {
      // AppsUseLightTheme is 0 when dark, 1 when light. Failure usually means
      // the theme key is missing on older Windows builds.
      const stdout = await exec("reg", [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
        "/v",
        "AppsUseLightTheme",
      ]);
      if (stdout === null) return null;
      const match = stdout.match(/AppsUseLightTheme\s+REG_DWORD\s+0x(\d+)/i);
      if (!match) return null;
      return match[1] === "0" ? "dark" : "light";
    }
    if (platform === "linux") {
      // GNOME / Cinnamon expose color-scheme via gsettings. Return values are
      // 'prefer-dark', 'prefer-light', or 'default'. WMs without gsettings
      // (KDE, tiling WMs) will simply fail - that is fine, we degrade to null.
      const stdout = await exec("gsettings", ["get", "org.gnome.desktop.interface", "color-scheme"]);
      if (stdout === null) return null;
      const normalized = stdout.trim().toLowerCase().replace(/^'|'$/g, "");
      if (normalized === "prefer-dark") return "dark";
      if (normalized === "prefer-light") return "light";
      return null;
    }
  } catch {
    // Defensive: the platform branches above can throw synchronously if a
    // dependency is misconfigured. Treat that like a failed query.
  }
  return null;
}

/**
 * Translate the device theme preference into a short directive an agent
 * reads while generating the artifact. Returns null when no preference is
 * set (or for the unset default) so a vanilla install never nags the agent.
 *
 * @param {string | null | undefined} themePref
 * @param {{
 *   resolvedAppearance?: "light" | "dark" | null,
 *   platform?: NodeJS.Platform,
 *   resolveSystemAppearance?: typeof resolveSystemAppearance,
 * }} [deps]
 * @returns {Promise<string | null>}
 */
export async function buildThemeDirective(
  themePref,
  { resolvedAppearance, resolveSystemAppearance: resolve = resolveSystemAppearance, platform = process.platform } = {},
) {
  if (themePref === null || themePref === undefined) return null;
  if (themePref === "light") {
    return "The user prefers a light appearance - bake a legible light theme into the artifact (own CSS, DaisyUI data-theme, or whatever system the artifact uses). Do not pin a dark theme.";
  }
  if (themePref === "dark") {
    return "The user prefers a dark appearance - bake a legible dark theme into the artifact. Do not pin a light theme.";
  }
  if (themePref === "system") {
    const appearance = resolvedAppearance !== undefined ? resolvedAppearance : await resolve(platform);
    if (appearance === "light") {
      return "The user follows the OS appearance; their device is currently in light mode - bake a legible light theme into the artifact. The baked theme will not track live OS toggles.";
    }
    if (appearance === "dark") {
      return "The user follows the OS appearance; their device is currently in dark mode - bake a legible dark theme into the artifact. The baked theme will not track live OS toggles.";
    }
    return "The user follows the OS appearance - bake a theme into the artifact that follows prefers-color-scheme (light on light systems, dark on dark) and looks legible in both. The baked theme is static; it will not live-track later OS toggles, but a media-query-driven design degrades gracefully.";
  }
  return null;
}
