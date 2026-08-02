import { listPlaybooks, PLAYBOOK_ROUTER_INSTRUCTION } from "./playbooks.js";

export const TAILWIND_BROWSER_VERSION = "4.2.4";
export const DAISYUI_VERSION = "5.5.19";
export const MERMAID_VERSION = "11.15.0";

export const DESIGN_CDN_URLS = {
  tailwind: `https://cdn.jsdelivr.net/npm/@tailwindcss/browser@${TAILWIND_BROWSER_VERSION}/dist/index.global.js`,
  daisyui: `https://cdn.jsdelivr.net/npm/daisyui@${DAISYUI_VERSION}/daisyui.css`,
  daisyuiThemes: `https://cdn.jsdelivr.net/npm/daisyui@${DAISYUI_VERSION}/themes.css`,
};

// LOCAL PATCH: jsdelivr bare-use is disallowed here; pin to npmmirror's version-locked single file.
export const MERMAID_CDN_URL = `https://registry.npmmirror.com/mermaid/${MERMAID_VERSION}/files/dist/mermaid.esm.min.mjs`;

export const DESIGN_CDN_SNIPPET = `<link rel="stylesheet" href="${DESIGN_CDN_URLS.daisyui}">
<link rel="stylesheet" href="${DESIGN_CDN_URLS.daisyuiThemes}">
<script src="${DESIGN_CDN_URLS.tailwind}"></script>`;

export const MERMAID_CDN_SNIPPET = `<script type="module">
  import mermaid from "${MERMAID_CDN_URL}";

  // Render Mermaid in a theme that matches the artifact page, and re-render when
  // the viewer flips the page theme - Mermaid never restyles an already-rendered
  // SVG on its own, so a fixed theme clashes in either light or dark mode.
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

  // Normalize any CSS color the browser produces (rgb, oklch, hsl, named, ...)
  // to [r, g, b, a] bytes via a 1x1 canvas, so parsing never breaks on modern
  // color syntaxes like DaisyUI's oklch() values.
  const paint = document.createElement("canvas").getContext("2d");
  function toRgba(color) {
    paint.clearRect(0, 0, 1, 1);
    paint.fillStyle = "#000";
    paint.fillStyle = color;
    paint.fillRect(0, 0, 1, 1);
    return paint.getImageData(0, 0, 1, 1).data;
  }

  function compositeRgba(foreground, background) {
    const foregroundAlpha = foreground[3] / 255;
    const backgroundAlpha = background[3] / 255;
    const alpha = foregroundAlpha + backgroundAlpha * (1 - foregroundAlpha);
    if (alpha === 0) return [0, 0, 0, 0];
    return [
      (foreground[0] * foregroundAlpha + background[0] * backgroundAlpha * (1 - foregroundAlpha)) / alpha,
      (foreground[1] * foregroundAlpha + background[1] * backgroundAlpha * (1 - foregroundAlpha)) / alpha,
      (foreground[2] * foregroundAlpha + background[2] * backgroundAlpha * (1 - foregroundAlpha)) / alpha,
      alpha * 255,
    ];
  }

  function pageIsDark() {
    // Trust the actually-rendered page background so this works with any theming
    // mechanism: prefers-color-scheme, a data-theme attribute, or plain CSS.
    const root = document.documentElement;
    const rootBackground = toRgba(getComputedStyle(root).backgroundColor);
    const bodyBackground = document.body ? toRgba(getComputedStyle(document.body).backgroundColor) : [0, 0, 0, 0];
    const [r, g, b, a] = compositeRgba(bodyBackground, rootBackground);
    if (a > 0) {
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
    }
    const colorScheme = getComputedStyle(root).colorScheme;
    if (colorScheme.includes("dark") && !colorScheme.includes("light")) return true;
    if (colorScheme.includes("light") && !colorScheme.includes("dark")) return false;
    return darkQuery.matches;
  }

  const diagrams = [...document.querySelectorAll(".mermaid")].map((el) => ({ el, src: el.textContent }));
  let applied;
  let rendering = false;
  let queued = false;
  function queueRender() {
    queued = true;
    if (rendering) return;
    void render();
  }
  async function render() {
    rendering = true;
    try {
      while (queued) {
        queued = false;
        const theme = pageIsDark() ? "dark" : "default";
        if (theme === applied) continue;
        mermaid.initialize({ startOnLoad: false, theme, securityLevel: "strict" });
        for (const { el, src } of diagrams) {
          el.removeAttribute("data-processed");
          el.textContent = src;
        }
        try {
          await mermaid.run({ nodes: diagrams.map((d) => d.el) });
        } catch (error) {
          console.error("Mermaid diagram render failed:", error);
          return;
        }
        applied = theme;
      }
    } finally {
      rendering = false;
      if (queued) queueRender();
    }
  }

  // First render once stylesheets are applied (no wrong-theme flash), then keep
  // the diagrams in sync with page-theme toggles and OS light/dark changes.
  if (document.readyState === "complete") queueRender();
  else window.addEventListener("load", queueRender, { once: true });
  const themeObserver = new MutationObserver(queueRender);
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue;
    themeObserver.observe(el, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });
  }
  document.addEventListener("change", queueRender, true);
  document.addEventListener(
    "transitionend",
    ({ propertyName }) => {
      if (propertyName === "background-color") queueRender();
    },
    true,
  );
  darkQuery.addEventListener("change", queueRender);
</script>`;

export const LAYOUT_SAFETY_CSS_SNIPPET = `<style>
  *, *::before, *::after { box-sizing: border-box; }
  :where(.grid, .flex, .layout-grid, .layout-flex) > *,
  :where([style*="display: grid"], [style*="display:grid"], [style*="display: flex"], [style*="display:flex"]) > * {
    min-width: 0;
  }
  :where(p, h1, h2, h3, h4, h5, h6, li, dd, blockquote, figcaption, td, th, .badge, .label) {
    overflow-wrap: anywhere;
  }
  :where(img, svg, video, canvas, iframe) {
    max-width: 100%;
    height: auto;
  }
</style>`;

// Single source for how agents choose an artifact's design direction. It flows into the
// no-args home output, top-level --help, the generated skill (all via DESIGN_SYSTEM_HINT),
// the `lavish-axi design` summary, and the design command help. Edit the rule here only;
// other surfaces embed it or point at it instead of restating it.
export const DESIGN_PRIORITY_RULE =
  "Decide the design direction in this strict priority order, and only move to the next step when the current one truly yields nothing: (1) if the user asked for a specific look or named design system, use that; (2) otherwise you must first inspect the project the artifact is about - the subject or product whose content or UI it represents, which may differ from your current working directory - and match that project's design system: Tailwind or theme config, shared CSS variables or design tokens, component library, brand assets, or existing styled pages. If the artifact previews, proposes, or mocks a specific app's UI, render it in that app's own design system so it faithfully shows the product, even when you are running in a different repo; (3) only when both steps come up empty, hand-write self-contained inline CSS with a light theme by default. LOCAL PATCH: do NOT pull in the Tailwind CSS browser runtime, DaisyUI, or any other CDN-hosted style runtime - artifacts must stay self-contained and must not fetch styles at view time.";

export const DESIGN_SYSTEM_HINT =
  "Lavish does not auto-inject any design system - artifacts stay portable so they render identically when opened directly without lavish-axi running. Before writing any HTML: " +
  DESIGN_PRIORITY_RULE +
  " Run `lavish-axi design` for a content-to-playbook router, a copy-pasteable CDN snippet, a Mermaid CDN snippet/init for diagrams, and the DaisyUI component reference. When you deliver the artifact, state which of the three design sources you used and why.";

export const DAISYUI_THEMES = [
  "light",
  "dark",
  "cupcake",
  "bumblebee",
  "emerald",
  "corporate",
  "synthwave",
  "retro",
  "cyberpunk",
  "valentine",
  "halloween",
  "garden",
  "forest",
  "aqua",
  "lofi",
  "pastel",
  "fantasy",
  "wireframe",
  "black",
  "luxury",
  "dracula",
  "cmyk",
  "autumn",
  "business",
  "acid",
  "lemonade",
  "night",
  "coffee",
  "winter",
  "dim",
  "nord",
  "sunset",
  "caramellatte",
  "abyss",
  "silk",
];

export function createDesignOutput() {
  return {
    playbook_router: {
      instruction: PLAYBOOK_ROUTER_INSTRUCTION,
      playbooks: listPlaybooks(),
    },
    design: {
      // LOCAL PATCH: the Tailwind/DaisyUI CDN fallback is removed entirely. Keeping the snippet,
      // urls, theme list and component catalogue while telling the agent "do not use a CDN
      // runtime" is a contradictory instruction - in practice the agent follows the concrete
      // snippet, not the prohibition. Only the prohibition ships now.
      summary:
        "Lavish does not auto-inject any design system; artifacts stay portable HTML. Paint an explicit page background and readable text. " +
        DESIGN_PRIORITY_RULE +
        " There is no CDN snippet to paste: this installation has the Tailwind/DaisyUI fallback removed. Hand-write self-contained inline CSS (light theme by default) and inline every asset, so the artifact renders identically when opened directly with no network.",
      layout_safety_snippet: LAYOUT_SAFETY_CSS_SNIPPET,
      layout_safety_note:
        "Optional copy-paste CSS for artifacts with dense nested grid/flex layouts, badges, wide monospace or pixel fonts, or local media. Paste it into the artifact yourself when useful. Lavish never auto-injects it, so direct-open portability stays intact.",
      other_design_systems:
        "If the user asks for a different design system (Bootstrap, custom CSS, plain HTML, etc.), use that instead - Lavish does not require DaisyUI.",
    },
    diagram_tooling: {
      use_when:
        "Use this for flows / architecture / state / sequence diagrams after opening the diagram playbook; Mermaid handles layout and edge routing better than hand-built div/flexbox boxes.",
      mermaid_cdn_snippet: MERMAID_CDN_SNIPPET,
      cdn_urls: { mermaid: MERMAID_CDN_URL },
      versions: { mermaid: MERMAID_VERSION },
    },
    // LOCAL PATCH: DaisyUI theme_usage / themes / components / modifiers catalogues removed.
    // They only make sense with the CDN runtime this install forbids; shipping them alongside
    // the prohibition is what made the original patch ineffective.
    styling: [
      "Hand-write self-contained inline CSS. Light theme by default (dark only on request).",
      "Inline every asset. The artifact must render identically opened directly with no network.",
      "Keep body copy to a readable measure (~760-820px) and put wide tables or diagrams in their own overflow-x:auto container so the page itself never scrolls sideways.",
    ],
  };
}
