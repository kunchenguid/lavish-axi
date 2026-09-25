// Chrome themes. The chrome's rules read every color from the role layer in `src/chrome.css`
// `:root`; a theme is nothing but a full set of values for that layer. `brass` is the
// stylesheet's own defaults and ships no override, so the unthemed chrome is unchanged.
// `chrome-client.js` is served raw and cannot import this module, so the picker and the
// annotation card receive what they need through the session JSON (`serializeChromeThemes`).

export const DEFAULT_CHROME_THEME = "brass";
export const CHROME_THEME_STORAGE_KEY = "lavish-axi:chrome-theme";

/**
 * @param {string} hex
 * @param {number} opacity
 */
function alpha(hex, opacity) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/**
 * The role layer for a non-default theme, derived from a small palette so every theme treats
 * attention, danger, and overlays the same way.
 * @param {{ scheme: "light" | "dark", bg: string, panel: string, bar: string, elevated: string,
 *   fg: string, fgMuted: string, fgDim: string, fgFaint: string, fgLabel: string,
 *   border: string, borderSubtle: string, borderStrong: string,
 *   accent: string, accentHover: string, accentInk: string, danger: string, warnInk: string,
 *   hover: string, rowActive: string, warn: string, warnBg: string, warnBgHover: string,
 *   veil: string, shadow: string }} p
 * @returns {Record<string, string>}
 */
function roleTokens(p) {
  const light = p.scheme === "light";
  return {
    "--bg": p.bg,
    "--bg-panel": p.panel,
    "--bg-bar": p.bar,
    "--bg-elevated": p.elevated,
    "--fg": p.fg,
    "--fg-muted": p.fgMuted,
    "--fg-dim": p.fgDim,
    "--fg-faint": p.fgFaint,
    "--fg-label": p.fgLabel,
    "--border": p.border,
    "--border-subtle": p.borderSubtle,
    "--border-strong": p.borderStrong,
    "--accent": p.accent,
    "--accent-hover": p.accentHover,
    "--accent-ink": p.accentInk,
    "--danger": p.danger,
    "--shadow-tooltip": `0 16px 44px ${alpha(p.shadow, light ? 0.14 : 0.35)}`,
    "--shadow-floating": `0 20px 70px ${alpha(p.shadow, light ? 0.18 : 0.35)}`,
    "--color-scheme": p.scheme,
    "--bg-hover": p.hover,
    "--bg-row-active": p.rowActive,
    "--fg-code": p.fgMuted,
    "--accent-line": alpha(p.accent, 0.4),
    "--accent-highlight": alpha(p.accent, light ? 0.16 : 0.22),
    "--accent-highlight-line": alpha(p.accent, 0.35),
    "--accent-pulse": alpha(p.accent, 0.55),
    "--accent-pulse-end": alpha(p.accent, 0),
    "--warn-fg": p.warn,
    "--warn-bg": p.warnBg,
    "--warn-bg-hover": p.warnBgHover,
    "--warn-line": alpha(p.warn, 0.35),
    "--warn-line-strong": alpha(p.warn, 0.6),
    "--warn-badge": p.warn,
    "--warn-badge-ink": p.warnInk,
    "--danger-soft": alpha(p.danger, light ? 0.08 : 0.1),
    "--danger-line": alpha(p.danger, 0.4),
    "--notice-bg": p.warnBg,
    "--notice-line": alpha(p.warn, 0.45),
    "--scrim": alpha(p.veil, light ? 0.38 : 0.72),
    "--scrim-strong": alpha(p.veil, light ? 0.5 : 0.86),
    "--scrim-heavy": alpha(p.veil, light ? 0.62 : 0.92),
    "--shadow-scroll-edge": `0 -10px 14px -10px ${alpha(p.shadow, light ? 0.18 : 0.55)}`,
  };
}

/**
 * @typedef {{ id: string, name: string, description: string, tokens: Record<string, string> }} ChromeTheme
 */

/** @type {ChromeTheme[]} */
export const CHROME_THEMES = [
  {
    id: "brass",
    name: "Brass",
    description: "Lavish dark",
    // Exactly the stylesheet's :root values; test/chrome-theme.test.js holds them together.
    tokens: {
      "--bg": "#0f1115",
      "--bg-panel": "#11141a",
      "--bg-bar": "#171a21",
      "--bg-elevated": "#1c212b",
      "--fg": "#f7f3ea",
      "--fg-muted": "#d8deea",
      "--fg-dim": "#b9c0cf",
      "--fg-faint": "#aeb6c6",
      "--fg-label": "#8c96aa",
      "--border": "#303745",
      "--border-subtle": "#2a2f3a",
      "--border-strong": "#3c4557",
      "--accent": "#f4c95d",
      "--accent-hover": "#ffd877",
      "--accent-ink": "#17130a",
      "--danger": "#f06464",
      "--shadow-tooltip": "0 16px 44px rgba(0, 0, 0, 0.35)",
      "--shadow-floating": "0 20px 70px rgba(0, 0, 0, 0.35)",
      "--color-scheme": "dark",
      "--bg-hover": "#2a2f3a",
      "--bg-row-active": "#171a21",
      "--fg-code": "#e8e1cf",
      "--accent-line": "rgba(244, 201, 93, 0.4)",
      "--accent-highlight": "rgba(244, 201, 93, 0.22)",
      "--accent-highlight-line": "rgba(244, 201, 93, 0.35)",
      "--accent-pulse": "rgba(244, 201, 93, 0.55)",
      "--accent-pulse-end": "rgba(244, 201, 93, 0)",
      "--warn-fg": "#ffd877",
      "--warn-bg": "rgba(37, 35, 15, 0.72)",
      "--warn-bg-hover": "rgba(93, 77, 27, 0.5)",
      "--warn-line": "rgba(244, 201, 93, 0.35)",
      "--warn-line-strong": "rgba(244, 201, 93, 0.6)",
      "--warn-badge": "#f4c95d",
      "--warn-badge-ink": "#17130a",
      "--danger-soft": "rgba(240, 100, 100, 0.1)",
      "--danger-line": "rgba(240, 100, 100, 0.4)",
      "--notice-bg": "#25230f",
      "--notice-line": "#5d4d1b",
      "--scrim": "rgba(15, 17, 21, 0.72)",
      "--scrim-strong": "rgba(15, 17, 21, 0.86)",
      "--scrim-heavy": "rgba(15, 17, 21, 0.92)",
      "--shadow-scroll-edge": "0 -10px 14px -10px rgba(0, 0, 0, 0.55)",
    },
  },
  {
    id: "paper",
    name: "Paper",
    description: "Warm light",
    tokens: roleTokens({
      scheme: "light",
      bg: "#fffefb",
      panel: "#f7f5ef",
      bar: "#f1eee6",
      elevated: "#ffffff",
      fg: "#141413",
      fgMuted: "#3d3d3a",
      fgDim: "#4a4943",
      fgFaint: "#5f5e57",
      fgLabel: "#6b6a63",
      border: "#ddd8cc",
      borderSubtle: "#e8e4da",
      borderStrong: "#c9c3b5",
      accent: "#a8461e",
      accentHover: "#8f3a17",
      accentInk: "#ffffff",
      danger: "#b3261e",
      hover: "#ebe7dc",
      rowActive: "#efebe2",
      warn: "#7a5500",
      warnInk: "#ffffff",
      warnBg: "#f8edcf",
      warnBgHover: "#f2e1b3",
      veil: "#1c1b18",
      shadow: "#141413",
    }),
  },
  {
    id: "daylight",
    name: "Daylight",
    description: "Cool light",
    tokens: roleTokens({
      scheme: "light",
      bg: "#ffffff",
      panel: "#f6f8fb",
      bar: "#ffffff",
      elevated: "#ffffff",
      fg: "#0f172a",
      fgMuted: "#334155",
      fgDim: "#3b475a",
      fgFaint: "#4e5a70",
      fgLabel: "#56627a",
      border: "#d5dce6",
      borderSubtle: "#e4e9f0",
      borderStrong: "#b9c3d1",
      accent: "#1d4ed8",
      accentHover: "#1e40af",
      accentInk: "#ffffff",
      danger: "#c62828",
      hover: "#e8edf5",
      rowActive: "#eef2f8",
      warn: "#8a4b00",
      warnInk: "#ffffff",
      warnBg: "#fdf0d9",
      warnBgHover: "#fae3b8",
      veil: "#0f172a",
      shadow: "#0f172a",
    }),
  },
  {
    id: "graphite",
    name: "Graphite",
    description: "Neutral dark",
    tokens: roleTokens({
      scheme: "dark",
      bg: "#0c0d0f",
      panel: "#121418",
      bar: "#15171a",
      elevated: "#1c1f23",
      fg: "#f1f2f4",
      fgMuted: "#d2d6dc",
      fgDim: "#bec3cb",
      fgFaint: "#a3a9b3",
      fgLabel: "#8d939d",
      border: "#2c3036",
      borderSubtle: "#24282e",
      borderStrong: "#3a3f48",
      accent: "#a596ff",
      accentHover: "#b7abff",
      accentInk: "#0d0a1f",
      danger: "#ff7b72",
      hover: "#262a30",
      rowActive: "#181a1e",
      warn: "#f2b955",
      warnInk: "#1f1606",
      warnBg: "#2a2110",
      warnBgHover: "#3a2d14",
      veil: "#0c0d0f",
      shadow: "#000000",
    }),
  },
  {
    id: "fjord",
    name: "Fjord",
    description: "Deep navy",
    tokens: roleTokens({
      scheme: "dark",
      bg: "#0b1624",
      panel: "#0d1827",
      bar: "#0e1a2a",
      elevated: "#132438",
      fg: "#eaf2fb",
      fgMuted: "#c9d6e4",
      fgDim: "#b3c3d6",
      fgFaint: "#9fb2c8",
      fgLabel: "#8599b1",
      border: "#223650",
      borderSubtle: "#1c2e44",
      borderStrong: "#2e4764",
      accent: "#55d2e6",
      accentHover: "#7be0ef",
      accentInk: "#04212a",
      danger: "#ff8a80",
      hover: "#1a2d44",
      rowActive: "#10203a",
      warn: "#f4b860",
      warnInk: "#231704",
      warnBg: "#2e2414",
      warnBgHover: "#3d2f18",
      veil: "#0b1624",
      shadow: "#000000",
    }),
  },
];

const THEME_IDS = new Set(CHROME_THEMES.map((theme) => theme.id));

/**
 * @param {unknown} value
 * @returns {string}
 */
export function resolveChromeTheme(value) {
  return typeof value === "string" && THEME_IDS.has(value) ? value : DEFAULT_CHROME_THEME;
}

/** The override blocks for every non-default theme, inlined into the chrome page. */
export function createChromeThemeCss() {
  return CHROME_THEMES.filter((theme) => theme.id !== DEFAULT_CHROME_THEME)
    .map((theme) => {
      const declarations = Object.entries(theme.tokens)
        .map(([name, value]) => `  ${name}: ${value};`)
        .join("\n");
      return `:root[data-lavish-theme="${theme.id}"] {\n${declarations}\n}`;
    })
    .join("\n");
}

/**
 * Inlined in the chrome's <head> so a stored theme applies before first paint instead of
 * flashing the dark default. Storage can be disabled; the default theme then simply stays.
 */
export function createChromeThemeBootJs() {
  const themed = CHROME_THEMES.filter((theme) => theme.id !== DEFAULT_CHROME_THEME).map((theme) => theme.id);
  return `try{var t=localStorage.getItem(${JSON.stringify(CHROME_THEME_STORAGE_KEY)});if(${JSON.stringify(themed)}.indexOf(t)!==-1)document.documentElement.setAttribute("data-lavish-theme",t)}catch(e){}`;
}

/**
 * What the chrome client needs per theme: picker labels and swatch colors, plus the subset
 * of tokens the annotation card inside the artifact frame paints with. The card lives in the
 * artifact document, so the chrome hands these over by postMessage.
 */
export function serializeChromeThemes() {
  return CHROME_THEMES.map((theme) => {
    const t = theme.tokens;
    return {
      id: theme.id,
      name: theme.name,
      description: theme.description,
      swatch: { ground: t["--bg-bar"], accent: t["--accent"] },
      // The card's own stylesheet already paints the default theme; null tells it to drop
      // any override it holds rather than restate those values here.
      sdk:
        theme.id === DEFAULT_CHROME_THEME
          ? null
          : {
              "--color-scheme": t["--color-scheme"],
              "--bg": t["--bg"],
              "--bg-panel": t["--bg-panel"],
              "--bg-elevated": t["--bg-elevated"],
              "--bg-hover": t["--bg-hover"],
              "--bg-hover-strong": t["--border"],
              "--bg-thumb": t["--bg-bar"],
              "--fg": t["--fg"],
              "--fg-faint": t["--fg-faint"],
              "--border": t["--border"],
              "--accent": t["--accent"],
              "--accent-hover": t["--accent-hover"],
              "--accent-ink": t["--accent-ink"],
              "--alert": t["--danger"],
              "--shadow-floating": t["--shadow-floating"],
            },
    };
  });
}
