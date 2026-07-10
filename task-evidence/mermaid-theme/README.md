# Mermaid diagram theming - before/after evidence

Task: make Mermaid diagrams in Lavish artifacts respect the artifact page theme instead of
rendering in a fixed theme.

All screenshots were captured from the real browser view through the real `lavish-axi` flow
(served chrome + sandboxed artifact iframe), using the same artifact structure for BEFORE and
AFTER so only the Mermaid init snippet differs.
The screenshots demonstrate the visual theming behavior; `after.html` now reproduces the final
serialized rerender implementation, which is also covered by the automated regression test.

The page defaults to DaisyUI `data-theme="luxury"` (dark) with a Dark/Light toggle that stamps
`data-theme` on the root element, mimicking a viewer theme toggle. The host OS preference was
**dark** during capture, which is why the AFTER light shots are the strong proof: the diagram
tracks the _page_ background, not the OS setting.

## BEFORE (fixed `theme: "base"`)

- `before-dark.png` - dark luxury page, but the diagram renders cream/light with light "Yes"/"No"
  label boxes: a glaring clash.
- `before-light.png` - the same fixed cream diagram happens to blend on a light page.

## AFTER (theme-aware init from `lavish-axi design`)

- `after-dark.png` - dark page -> dark Mermaid theme (dark nodes, light text). Matches the page.
- `after-light.png` - fresh load in light -> light Mermaid theme, even though the OS prefers dark.
  Proves the initial-render path reads the page background correctly (no wrong-theme flash).
- `after-light-toggled.png` - live toggle dark -> light re-renders the diagram to the light theme.
  Proves the toggle listener re-renders (Mermaid does not restyle an existing SVG on its own).

## Reproduce

`before.html` reproduces the fixed-theme behavior and `after.html` embeds the shipped theme-aware
snippet verbatim (`src/design-reference.js` `MERMAID_CDN_SNIPPET`). Open either with
`lavish-axi <file>` and toggle Dark/Light.
