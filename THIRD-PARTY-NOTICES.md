# Third-party notices

The published `lavish-axi` package vendors the following third-party software into `dist/`.
Each component remains under its own license; the notices below satisfy their attribution requirements.
The whiteboard bundle (`dist/whiteboard/`) is built from these packages by `scripts/build.js`.

## Bundled into `dist/whiteboard/whiteboard.js` and `whiteboard.css`

| Package                                              | License | Copyright                                         |
| ---------------------------------------------------- | ------- | ------------------------------------------------- |
| `@excalidraw/excalidraw`                             | MIT     | Copyright (c) 2020 Excalidraw                     |
| `@excalidraw/mermaid-to-excalidraw`                  | MIT     | Copyright (c) 2023 Excalidraw                     |
| `mermaid` (exact 11.12.1, bundled for the converter) | MIT     | Copyright (c) 2014 - 2022 Knut Sveidqvist         |
| `react`, `react-dom`                                 | MIT     | Copyright (c) Meta Platforms, Inc. and affiliates |

The full MIT license text applies to each of the packages above:

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Fonts vendored into `dist/whiteboard/fonts/` (from `@excalidraw/excalidraw`)

| Family          | License                                      |
| --------------- | -------------------------------------------- |
| Excalifont      | MIT (created for Excalidraw)                 |
| Virgil          | MIT (created for Excalidraw by Ellinor Rapp) |
| Nunito          | SIL Open Font License 1.1                    |
| Assistant       | SIL Open Font License 1.1                    |
| Cascadia Code   | SIL Open Font License 1.1                    |
| Comic Shanns    | MIT                                          |
| Liberation Sans | SIL Open Font License 1.1                    |
| Lilita One      | SIL Open Font License 1.1                    |

The Xiaolai family (CJK glyphs) is intentionally not vendored; Excalidraw falls back to its CDN or the system font for those glyphs.

## Bundled into `dist/design/` (pre-existing)

| Asset                                             | License |
| ------------------------------------------------- | ------- |
| `daisyui.css`, `daisyui-themes.css` (daisyUI)     | MIT     |
| `tailwindcss-browser.js` (`@tailwindcss/browser`) | MIT     |

## Pre-publication audit note

Font license attributions above were compiled from each family's upstream project.
Before any npm publication that changes the vendored font set, re-verify each family's license file upstream (the `@excalidraw/excalidraw` npm package does not ship per-font license files).
