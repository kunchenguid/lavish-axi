import { listPlaybooks, PLAYBOOK_ROUTER_INSTRUCTION } from "./playbooks.js";

export const TAILWIND_BROWSER_VERSION = "4.2.4";
export const DAISYUI_VERSION = "5.5.19";
export const MERMAID_VERSION = "11.15.0";

export const DESIGN_CDN_URLS = {
  tailwind: `https://cdn.jsdelivr.net/npm/@tailwindcss/browser@${TAILWIND_BROWSER_VERSION}/dist/index.global.js`,
  daisyui: `https://cdn.jsdelivr.net/npm/daisyui@${DAISYUI_VERSION}/daisyui.css`,
  daisyuiThemes: `https://cdn.jsdelivr.net/npm/daisyui@${DAISYUI_VERSION}/themes.css`,
};

export const MERMAID_CDN_URL = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.esm.min.mjs`;

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

export const DESIGN_SYSTEM_HINT =
  "Lavish does not auto-inject any design system - artifacts stay portable so they render identically when opened directly without lavish-axi running. Before writing any HTML, decide the design direction in this strict priority order, and only move to the next step when the current one truly yields nothing: (1) if the user asked for a specific look or named design system, use that; (2) otherwise you must first inspect the project the artifact is about - the subject or product whose content or UI it represents, which may differ from your current working directory - and match that project's design system: Tailwind or theme config, shared CSS variables or design tokens, component library, brand assets, or existing styled pages. If the artifact previews, proposes, or mocks a specific app's UI, render it in that app's own design system so it faithfully shows the product, even when you are running in a different repo; (3) only when both steps come up empty, use the Lavish-recommended Tailwind CSS browser runtime v4 + DaisyUI v5, available via CDN - run `lavish-axi design` for a content-to-playbook router, a copy-pasteable CDN snippet, a Mermaid CDN snippet/init for diagrams, and the DaisyUI component reference, and prefer the Tailwind/DaisyUI CDN snippet over hand-writing styles unless explicitly instructed otherwise by the user. When you deliver the artifact, state which of the three design sources you used and why.";

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
      summary:
        "Use this Lavish CDN fallback only if (1) the user gave no design direction and (2) you already inspected the project the artifact is about - the subject or product whose content or UI it represents, which may differ from your current working directory - and found no design system or style conventions to match. If you have not checked the subject project yet, check first. Lavish does not auto-inject any design system; artifacts stay portable HTML. The strict priority order is: (1) a look or named design system the user asked for; (2) the subject project's design system or style conventions - look for a Tailwind or theme config, shared CSS variables or design tokens, a component library, brand assets, or existing styled pages. If the artifact previews, proposes, or mocks a specific app's UI, render it in that app's own design system so it faithfully shows the product, even when you are running in a different repo; (3) this Tailwind CSS browser runtime v4 + DaisyUI v5 + themes snippet - paste the CDN snippet below into your `<head>` and prefer the CDN snippet over hand-writing styles unless explicitly instructed otherwise by the user.",
      cdn_snippet: DESIGN_CDN_SNIPPET,
      cdn_urls: DESIGN_CDN_URLS,
      versions: { tailwind: TAILWIND_BROWSER_VERSION, daisyui: DAISYUI_VERSION },
      latest_docs: "https://daisyui.com/components/",
      docs_note:
        "Use this command for common syntax. Read the latest DaisyUI docs for full details when using advanced or unfamiliar components.",
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
    theme_usage: [
      'Default to `<html data-theme="luxury">` - it matches the Lavish look. Pick a different theme from the list below only when the user asked for one or the content clearly calls for it.',
      'Set a nested section theme with `<section data-theme="night">`.',
      "Prefer semantic colors such as `bg-base-100`, `bg-base-200`, `text-base-content`, `bg-primary`, `text-primary-content`, `alert-warning`, and `btn-primary` so themes remain readable.",
      "Avoid hardcoded Tailwind color names for text and surfaces unless the user asked for exact colors.",
      "Use Tailwind responsive prefixes such as `sm:`, `md:`, `lg:`, and `xl:` for layout changes.",
      'Never `@apply` DaisyUI classes (such as `text-base-content/40`, `bg-base-200`, or `btn`) inside `<style type="text/tailwindcss">` - the Tailwind browser runtime does not know them, and one unknown utility aborts the entire compile, leaving the page with no Tailwind styles at all. Put DaisyUI classes directly on elements, or write plain CSS with theme variables such as `var(--color-base-200)`.',
    ],
    themes: DAISYUI_THEMES,
    components: {
      actions: ["button", "dropdown", "fab", "modal", "swap", "theme-controller"],
      data_display: [
        "accordion",
        "avatar",
        "badge",
        "card",
        "carousel",
        "chat",
        "collapse",
        "countdown",
        "diff",
        "hover-3d",
        "hover-gallery",
        "kbd",
        "list",
        "stat",
        "status",
        "table",
        "text-rotate",
        "timeline",
      ],
      navigation: ["breadcrumbs", "dock", "link", "menu", "navbar", "pagination", "steps", "tabs"],
      feedback: ["alert", "loading", "progress", "radial-progress", "skeleton", "toast", "tooltip"],
      data_input: [
        "calendar",
        "checkbox",
        "fieldset",
        "file-input",
        "filter",
        "label",
        "radio",
        "range",
        "rating",
        "select",
        "input",
        "textarea",
        "toggle",
        "validator",
      ],
      layout: ["divider", "drawer", "footer", "hero", "indicator", "join", "mask", "stack"],
      mockup: ["mockup-browser", "mockup-code", "mockup-phone", "mockup-window"],
    },
    modifiers: {
      colors: ["neutral", "primary", "secondary", "accent", "info", "success", "warning", "error"],
      sizes: ["xs", "sm", "md", "lg", "xl"],
      styles: ["outline", "dash", "soft", "ghost", "link"],
      placements: ["start", "center", "end", "top", "middle", "bottom", "left", "right"],
    },
    reference: {
      button: {
        classes: [
          "btn",
          "btn-neutral",
          "btn-primary",
          "btn-secondary",
          "btn-accent",
          "btn-info",
          "btn-success",
          "btn-warning",
          "btn-error",
          "btn-outline",
          "btn-dash",
          "btn-soft",
          "btn-ghost",
          "btn-link",
          "btn-xs",
          "btn-sm",
          "btn-md",
          "btn-lg",
          "btn-xl",
          "btn-wide",
          "btn-block",
          "btn-square",
          "btn-circle",
          "btn-active",
          "btn-disabled",
        ],
        syntax: '<button class="btn btn-primary">Save</button>',
        notes: [
          'Use `btn` on `<button>`, `<a role="button">`, `<input>`, or `<label>`.',
          'For class-only disabled state, add `btn-disabled tabindex="-1" role="button" aria-disabled="true"`.',
          "Use `btn-square` or `btn-circle` for icon-only buttons and provide an accessible label.",
        ],
      },
      card: {
        classes: [
          "card",
          "card-body",
          "card-title",
          "card-actions",
          "card-border",
          "card-dash",
          "card-side",
          "image-full",
          "card-xs",
          "card-sm",
          "card-md",
          "card-lg",
          "card-xl",
        ],
        syntax:
          '<div class="card card-border bg-base-100"><div class="card-body"><h2 class="card-title">Title</h2><p>Text</p><div class="card-actions justify-end"><button class="btn btn-primary">Act</button></div></div></div>',
        notes: [
          "Use `lg:card-side` for responsive horizontal cards.",
          "Use `card-border` for a bordered card without custom CSS.",
        ],
      },
      alert: {
        classes: [
          "alert",
          "alert-outline",
          "alert-dash",
          "alert-soft",
          "alert-info",
          "alert-success",
          "alert-warning",
          "alert-error",
          "alert-vertical",
          "alert-horizontal",
        ],
        syntax: '<div role="alert" class="alert alert-warning"><span>Check this before shipping.</span></div>',
        notes: [
          'Use `role="alert"` for important status messages.',
          "Use `sm:alert-horizontal` to switch from stacked to horizontal layouts.",
        ],
      },
      badge: {
        classes: [
          "badge",
          "badge-outline",
          "badge-dash",
          "badge-soft",
          "badge-ghost",
          "badge-neutral",
          "badge-primary",
          "badge-secondary",
          "badge-accent",
          "badge-info",
          "badge-success",
          "badge-warning",
          "badge-error",
          "badge-xs",
          "badge-sm",
          "badge-md",
          "badge-lg",
          "badge-xl",
        ],
        syntax: '<span class="badge badge-soft badge-warning">Risk</span>',
        notes: ["Use badges for short statuses and labels, not long prose."],
      },
      table: {
        classes: [
          "table",
          "table-zebra",
          "table-pin-rows",
          "table-pin-cols",
          "table-xs",
          "table-sm",
          "table-md",
          "table-lg",
          "table-xl",
        ],
        syntax:
          '<div class="overflow-x-auto rounded-box border border-base-content/5 bg-base-100"><table class="table table-zebra"><thead><tr><th>Name</th></tr></thead><tbody><tr><td>Value</td></tr></tbody></table></div>',
        notes: ["Wrap tables in `overflow-x-auto` for mobile.", "Use semantic table markup for tabular data."],
      },
      modal: {
        classes: [
          "modal",
          "modal-box",
          "modal-action",
          "modal-backdrop",
          "modal-toggle",
          "modal-open",
          "modal-top",
          "modal-middle",
          "modal-bottom",
          "modal-start",
          "modal-end",
        ],
        syntax:
          '<button class="btn" onclick="details_modal.showModal()">Open</button><dialog id="details_modal" class="modal"><div class="modal-box"><h3 class="text-lg font-bold">Title</h3><p class="py-4">Content</p><div class="modal-action"><form method="dialog"><button class="btn">Close</button></form></div></div></dialog>',
        notes: [
          "Prefer native `<dialog>` with `showModal()` for accessibility.",
          "Use unique IDs for every modal.",
          "Use `modal-bottom sm:modal-middle` for mobile-friendly responsive placement.",
        ],
      },
      collapse: {
        classes: [
          "collapse",
          "collapse-title",
          "collapse-content",
          "collapse-arrow",
          "collapse-plus",
          "collapse-open",
          "collapse-close",
        ],
        syntax:
          '<div tabindex="0" class="collapse collapse-arrow bg-base-200"><div class="collapse-title">Title</div><div class="collapse-content"><p>Hidden detail</p></div></div>',
        notes: [
          "Use a checkbox child for independently toggleable collapses.",
          "Use radio inputs with the same name for accordion behavior where only one item stays open.",
        ],
      },
      drawer: {
        classes: [
          "drawer",
          "drawer-toggle",
          "drawer-content",
          "drawer-side",
          "drawer-overlay",
          "drawer-end",
          "drawer-open",
        ],
        syntax:
          '<div class="drawer lg:drawer-open"><input id="nav" type="checkbox" class="drawer-toggle"><div class="drawer-content"><label for="nav" class="btn drawer-button lg:hidden">Menu</label></div><div class="drawer-side"><label for="nav" aria-label="close sidebar" class="drawer-overlay"></label><ul class="menu bg-base-200 min-h-full w-80 p-4"><li><button>Item</button></li></ul></div></div>',
        notes: [
          "Every page region belongs inside `drawer-content` or `drawer-side`.",
          "The hidden `drawer-toggle` input needs a unique ID.",
          "Use labels with `for` to open and close the drawer.",
        ],
      },
      navbar: {
        classes: ["navbar", "navbar-start", "navbar-center", "navbar-end"],
        syntax:
          '<div class="navbar bg-base-200"><div class="navbar-start"><a class="btn btn-ghost text-xl">Title</a></div><div class="navbar-end"><button class="btn btn-primary">Action</button></div></div>',
        notes: ["Use the start, center, and end parts to align content horizontally."],
      },
      menu: {
        classes: [
          "menu",
          "menu-title",
          "menu-dropdown",
          "menu-dropdown-toggle",
          "menu-disabled",
          "menu-active",
          "menu-focus",
          "menu-dropdown-show",
          "menu-xs",
          "menu-sm",
          "menu-md",
          "menu-lg",
          "menu-xl",
          "menu-horizontal",
          "menu-vertical",
        ],
        syntax:
          '<ul class="menu bg-base-200 rounded-box"><li><button class="menu-active">Item</button></li><li><a>Link</a></li></ul>',
        notes: ["Use `lg:menu-horizontal` for responsive menus.", "Use `<details>` for collapsible submenus."],
      },
      tabs: {
        classes: [
          "tabs",
          "tab",
          "tab-active",
          "tab-disabled",
          "tabs-box",
          "tabs-border",
          "tabs-lift",
          "tab-content",
          "tab-xs",
          "tab-sm",
          "tab-md",
          "tab-lg",
          "tab-xl",
        ],
        syntax:
          '<div role="tablist" class="tabs tabs-border"><button role="tab" class="tab tab-active">One</button><button role="tab" class="tab">Two</button></div>',
        notes: ["Use role attributes when tabs are interactive controls."],
      },
      steps: {
        classes: [
          "steps",
          "step",
          "step-primary",
          "step-secondary",
          "step-accent",
          "step-info",
          "step-success",
          "step-warning",
          "step-error",
          "steps-vertical",
          "steps-horizontal",
        ],
        syntax:
          '<ul class="steps"><li class="step step-primary">Plan</li><li class="step">Build</li><li class="step">Review</li></ul>',
        notes: ["Use `steps-vertical lg:steps-horizontal` for responsive process views."],
      },
      stat: {
        classes: ["stats", "stat", "stat-title", "stat-value", "stat-desc", "stat-figure", "stat-actions"],
        syntax:
          '<div class="stats stats-vertical lg:stats-horizontal shadow"><div class="stat"><div class="stat-title">Issues</div><div class="stat-value">3</div><div class="stat-desc">Need review</div></div></div>',
        notes: ["Use stats for key numbers above dense detail."],
      },
      progress: {
        classes: [
          "progress",
          "progress-neutral",
          "progress-primary",
          "progress-secondary",
          "progress-accent",
          "progress-info",
          "progress-success",
          "progress-warning",
          "progress-error",
          "radial-progress",
        ],
        syntax:
          '<progress class="progress progress-primary" value="70" max="100"></progress><div class="radial-progress" style="--value:70;" role="progressbar" aria-valuenow="70">70%</div>',
        notes: [
          "Progress elements need `value` and `max`.",
          'Radial progress uses `--value`, `role="progressbar"`, and `aria-valuenow`.',
        ],
      },
      forms: {
        classes: [
          "input",
          "textarea",
          "select",
          "checkbox",
          "radio",
          "toggle",
          "range",
          "rating",
          "fieldset",
          "fieldset-legend",
          "label",
          "floating-label",
          "validator",
        ],
        syntax:
          '<fieldset class="fieldset"><legend class="fieldset-legend">Choice</legend><select class="select"><option>One</option></select><p class="label">Helper text</p></fieldset>',
        notes: [
          "Use unique `name` values for each radio, rating, or filter group.",
          "Use matching color and size modifiers such as `input-primary input-lg` when needed.",
        ],
      },
      tooltip_toast: {
        classes: [
          "tooltip",
          "tooltip-open",
          "tooltip-top",
          "tooltip-bottom",
          "tooltip-left",
          "tooltip-right",
          "toast",
          "toast-start",
          "toast-center",
          "toast-end",
          "toast-top",
          "toast-middle",
          "toast-bottom",
        ],
        syntax:
          '<div class="tooltip" data-tip="More context"><button class="btn">Hover</button></div><div class="toast toast-end"><div class="alert alert-success">Saved</div></div>',
        notes: ["Tooltips use `data-tip` for text.", "Toast is a positioned wrapper; put `alert` content inside."],
      },
      mockup: {
        classes: [
          "mockup-browser",
          "mockup-browser-toolbar",
          "mockup-code",
          "mockup-phone",
          "mockup-phone-camera",
          "mockup-phone-display",
          "mockup-window",
        ],
        syntax: '<div class="mockup-code"><pre data-prefix="$"><code>npm test</code></pre></div>',
        notes: [
          "Use `pre data-prefix` for short command prompts, symbols, or line numbers.",
          "Keep `data-prefix` short because DaisyUI renders it in the code gutter; use prose outside the mockup for long labels.",
          "Use mockups for product or terminal examples, not regular prose.",
        ],
      },
      utility_rules: {
        classes: [
          "hero",
          "hero-content",
          "divider",
          "join",
          "join-item",
          "indicator",
          "indicator-item",
          "avatar",
          "chat",
          "chat-start",
          "chat-end",
          "loading",
          "skeleton",
          "diff",
          "timeline",
        ],
        syntax:
          '<main class="mx-auto max-w-6xl p-6 lg:p-10"><section class="hero bg-base-200 rounded-box"><div class="hero-content text-center"><h1 class="text-5xl font-bold">Review surface</h1></div></section></main>',
        notes: [
          "Compose DaisyUI components with Tailwind utilities for spacing, grid, flex, width, and typography.",
          "Prefer component classes over custom CSS for common UI.",
        ],
      },
    },
  };
}
