# Excalidraw label clipping regression

## End-to-end reproduction

The fixture was opened with the built Lavish CLI and rendered through the normal session chrome, sandboxed artifact iframe, inline whiteboard iframe, Mermaid conversion, and Excalidraw canvas path.

`before.png` was captured from a cold browser before the fix.
It reproduces the supplied failure: leading and trailing glyphs are missing from `Disposable adapter sidecar`, `Adapter Protocol v1`, `Codex app-server`, `Future adapter`, and the multiline canonical-tools label.

## Root cause

`convertToExcalidrawElements` synchronously measured bound labels before Excalidraw registered and loaded Excalifont.
The browser therefore measured `16px Excalifont` with its narrower serif fallback and persisted those widths on the text elements.
Excalidraw later loaded Excalifont and drew its wider glyphs into the stale text-element bounds, so the canvas clipped glyphs at both horizontal edges.

Measured in the same Chrome rendering path:

| Label                      | Serif fallback width | Loaded Excalifont width |
| -------------------------- | -------------------: | ----------------------: |
| Disposable adapter sidecar |              171.484 |                 210.512 |
| Adapter Protocol v1        |              129.750 |                 157.440 |
| Codex app-server           |              113.289 |                 134.224 |
| Future adapter             |               92.852 |                 118.960 |

The fix asks Excalidraw's own scene-export boundary to load the exact required font subsets, then materializes the Mermaid skeletons again before mounting the editor.
This also reruns multiline wrapping with the loaded metrics.

## Visual verification

`after-fullscreen-1440x900-dpr1.png` was captured from a fresh browser profile at a 1440 by 900 viewport and device-pixel ratio 1.

`after-fullscreen-1024x768-dpr2.png` was captured after reopening the fullscreen whiteboard at a 1024 by 768 viewport and device-pixel ratio 2.

Every label is fully readable in both captures, including the multiline canonical-tools label.

`standalone-mermaid-1440x900-dpr1.png` opens the original artifact directly, without Lavish injection, and confirms that the non-Excalidraw Mermaid rendering path remains unchanged.
