---
name: lavish-design
description: Use this skill to generate well-branded interfaces and assets for Lavish, either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files.
If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.
If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.

## Where things live

- `README.md` — product context, content fundamentals, visual foundations, iconography, caveats
- `colors_and_type.css` — drop-in CSS custom properties for the full token system (ink, brass, sage, amber, rust, steel, cream + type + spacing + radii + shadows)
- `assets/` — wordmark, lavish-mark icon, flow diagram SVG
- `preview/` — Design-System-tab specimen cards (one concept per card)
- `ui_kits/editor/` — clickable React recreation of the Lavish Editor chrome

## Quick rules of thumb

1. **Dark ink + cream type + one brass accent.** No second accent, no gradient, no glassmorphism.
2. **Serif for prose and brand moments (EB Garamond italic). Sans for chrome (Geist). Mono for technical (Geist Mono).**
3. **No emoji. No exclamation marks. No "🚀 powerful seamless" copy.** Read the on-brand/off-brand examples in README's Content Fundamentals.
4. **The annotation outline = the focus outline:** 2px brass, 2px offset. Same for hover, focus, selected — they all mean "attention is here."
5. **Shadows only on floating surfaces** (tooltip, annotation card). Never on buttons or in-panel cards.
6. **Sage = agent. Amber = user. Rust = danger.** Don't mix.
7. **Words first, icons second.** When you must reach for an icon, use Lucide (stroke, 1.5, currentColor).

## To produce a new HTML artifact

1. `@import "../colors_and_type.css";` in your stylesheet (or copy the tokens block inline if standalone).
2. Build with the semantic vars (`--bg`, `--fg`, `--accent`, etc.) — never hard-code hex.
3. Set `font-family: var(--font-sans)` on the body; reach for `var(--font-serif)` on headlines and pull-quotes.
4. Reference `assets/lavish-wordmark.svg` for the brand mark; do not redraw it.
5. If you need a component (button, pill, bubble, annotation card, top bar), open the matching JSX file in `ui_kits/editor/` and copy the styles object — they're already token-driven.
