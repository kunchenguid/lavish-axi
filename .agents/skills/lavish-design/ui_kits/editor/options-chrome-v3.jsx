/* global React */
// v3: discoverability treatments for the "Send / Send & end session" split button.
// Focuses on the conversation panel + composer footer (the only area that changes).

const v3 = {
  wrap: { position: "absolute", inset: 0, display: "flex", justifyContent: "center", alignItems: "stretch", background: "var(--ink-900)", padding: 0 },
  panel: { width: "100%", borderLeft: "1px solid var(--steel-700)", background: "var(--ink-800)", display: "flex", flexDirection: "column", minHeight: 0, fontFamily: "var(--font-sans)", color: "var(--cream-100)", fontSize: 12, position: "relative" },
  panelH: { fontSize: 12, margin: "14px 14px 8px", fontWeight: 600 },
  log: { flex: 1, minHeight: 0, overflow: "hidden", padding: "0 14px 10px", display: "flex", flexDirection: "column", gap: 9 },
  uBub: { alignSelf: "flex-end", maxWidth: "86%", borderRadius: 12, padding: "8px 10px", background: "var(--bg-elevated)", border: "1px solid var(--border-strong)" },
  aBub: { alignSelf: "flex-start", maxWidth: "86%", borderRadius: 12, padding: "8px 10px", background: "transparent", border: "1px solid var(--border-subtle)" },
  bubLabel: { display: "block", fontSize: 8.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-faint)", marginBottom: 3 },
  composer: { borderTop: "1px solid var(--steel-700)", padding: 14, display: "grid", gap: 9, flexShrink: 0 },
  ta: { width: "100%", minHeight: 58, borderRadius: 11, border: "1px solid var(--steel-600)", background: "var(--ink-900)", color: "var(--cream-100)", padding: 9, font: "inherit", fontSize: 12, boxSizing: "border-box", resize: "none" },
};
const fBtn3 = { border: 0, background: "var(--brass-500)", color: "var(--brass-ink)", borderRadius: 10, padding: "9px 14px", fontFamily: "inherit", fontWeight: 700, fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" };

function I3({ d, size = 14 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{d}</svg>;
}
const ic3Exit = <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></>;
const ic3Send = <><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/></>;
const ic3Caret = <path d="m6 9 6 6 6-6"/>;

function Convo({ children }) {
  return (
    <div style={v3.log}>
      <div style={v3.uBub}><small style={{ ...v3.bubLabel, textAlign: "right" }}>You</small><div>Tighten the heading — fewer words.</div></div>
      <div style={v3.aBub}><small style={v3.bubLabel}>Agent</small><div>Done. Shortened it to a single line — anything else?</div></div>
      {children}
    </div>
  );
}

function SplitSend() {
  return (
    <div style={{ display: "inline-flex", alignItems: "stretch" }}>
      <button style={{ ...fBtn3, borderTopRightRadius: 0, borderBottomRightRadius: 0 }}>Send to Agent</button>
      <button title="Send & end session" style={{ ...fBtn3, borderTopLeftRadius: 0, borderBottomLeftRadius: 0, padding: "9px 9px", borderLeft: "1px solid rgba(23,19,10,.22)", display: "grid", placeItems: "center" }}><I3 d={ic3Caret} /></button>
    </div>
  );
}

/* ===== E1 · Contextual idle nudge (recommended) =====
   After the agent replies and the box is empty, a quiet line fades in. */
function PanelIdleNudge() {
  return (
    <div style={v3.wrap}><div style={v3.panel}>
      <h2 style={v3.panelH}>Conversation</h2>
      <Convo />
      <div style={v3.composer}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, color: "var(--steel-300)", padding: "0 1px" }}>
          <span style={{ width: 5, height: 5, borderRadius: 999, background: "var(--brass-500)", flexShrink: 0 }} />
          <span>Finished? Use the <span style={{ color: "var(--brass-400)", borderBottom: "1px solid var(--brass-500)", cursor: "pointer", fontWeight: 600 }}>▾ to send &amp; end</span> the session.</span>
        </div>
        <div style={v3.ta} />
        <div style={{ display: "flex", justifyContent: "flex-end" }}><SplitSend /></div>
      </div>
    </div></div>
  );
}

/* ===== E2 · Dual home — End session also in the ⋯ menu ===== */
function PanelDualHome() {
  return (
    <div style={v3.wrap}><div style={v3.panel}>
      <h2 style={v3.panelH}>Conversation</h2>
      <Convo />
      <div style={v3.composer}>
        <div style={v3.ta} />
        <div style={{ display: "flex", justifyContent: "flex-end" }}><SplitSend /></div>
      </div>
      {/* floating ⋯ menu (anchored top-right of the whole chrome in real life) */}
      <div style={{ position: "absolute", right: 12, top: 10, width: 210, background: "var(--ink-700)", border: "1px solid var(--steel-600)", borderRadius: 12, boxShadow: "var(--shadow-tooltip)", padding: 6, zIndex: 20 }}>
        <div style={{ padding: "6px 9px 7px" }}>
          <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-faint)", marginBottom: 4 }}>Editing</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--steel-100)" }}>landing/index.html</div>
        </div>
        <div style={{ height: 1, background: "var(--steel-600)", margin: "2px 0 4px" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", borderRadius: 8, fontSize: 11, color: "var(--steel-100)" }}>Reload artifact</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", borderRadius: 8, fontSize: 11, color: "var(--steel-100)" }}>Copy DOM snapshot</div>
        <div style={{ height: 1, background: "var(--steel-600)", margin: "4px 0" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", borderRadius: 8, fontSize: 11, color: "var(--rust-500)", background: "rgba(240,100,100,.08)" }}><span style={{ display: "flex" }}><I3 d={ic3Exit} size={13} /></span>End session</div>
      </div>
    </div></div>
  );
}

/* ===== E3 · Labeled caret — the trigger says what it does ===== */
function PanelLabeledCaret() {
  return (
    <div style={v3.wrap}><div style={v3.panel}>
      <h2 style={v3.panelH}>Conversation</h2>
      <Convo />
      <div style={v3.composer}>
        <div style={v3.ta} />
        <div style={{ display: "flex", justifyContent: "flex-end", position: "relative" }}>
          <div style={{ display: "inline-flex", alignItems: "stretch" }}>
            <button style={{ ...fBtn3, borderTopRightRadius: 0, borderBottomRightRadius: 0 }}>Send to Agent</button>
            <button style={{ ...fBtn3, borderTopLeftRadius: 0, borderBottomLeftRadius: 0, padding: "9px 10px", borderLeft: "1px solid rgba(23,19,10,.22)", display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11 }}>end <I3 d={ic3Caret} size={12} /></button>
          </div>
          <div style={{ position: "absolute", right: 0, bottom: 42, background: "var(--ink-700)", border: "1px solid var(--steel-600)", color: "var(--steel-100)", borderRadius: 8, padding: "6px 9px", fontSize: 10.5, whiteSpace: "nowrap", boxShadow: "var(--shadow-tooltip)" }}>
            Send &amp; end session
            <span style={{ position: "absolute", right: 18, bottom: -5, width: 8, height: 8, background: "var(--ink-700)", borderRight: "1px solid var(--steel-600)", borderBottom: "1px solid var(--steel-600)", transform: "rotate(45deg)" }} />
          </div>
        </div>
      </div>
    </div></div>
  );
}

Object.assign(window, { PanelIdleNudge, PanelDualHome, PanelLabeledCaret });
