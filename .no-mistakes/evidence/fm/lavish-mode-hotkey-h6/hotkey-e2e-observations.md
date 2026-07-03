# Lavish Mode Hotkey E2E Observations

Served artifact:
`.no-mistakes/evidence/fm/lavish-mode-hotkey-h6/hotkey-review-artifact.html`

Local session:
`http://127.0.0.1:4489/session/798ee9779fc3d824?no-gate=1`

Observed with `chrome-devtools-axi`:

- Initial accessibility snapshot exposed the top-bar `Annotate` button as pressed with description `Toggle annotate/explore mode (⌘I / Ctrl+I)`.
- With the chrome chat textarea focused, typing plain `i` left the switch unchanged and the textarea value became `i`.
- With the chrome chat textarea still focused, `Control+I` toggled the same top-bar `Annotate` switch.
- With the sandboxed artifact checkbox focused, the checkbox changed to checked and `Control+I` toggled the top-bar `Annotate` switch through the iframe SDK bridge.
- In annotate mode, clicking the comment target opened the Lavish annotation card and focused its textarea.
- With the annotation-card textarea focused, typing plain `i` entered `i` in the textarea and left annotate mode on.
- With the annotation-card textarea still focused, `Control+I` toggled to explore mode and closed the annotation card.
- A short debug poll returned `status: waiting`, so the browser did not report fresh layout warnings for this evidence artifact.
