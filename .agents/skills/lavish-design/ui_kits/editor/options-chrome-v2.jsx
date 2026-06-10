/* global React */
// v2 chrome explorations: near-empty bar (file path → ⋯ menu),
// End Session relocated next to Send. Bold variants.

const v2 = {
  shell: { position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "var(--ink-900)", color: "var(--cream-100)", fontFamily: "var(--font-sans)", fontSize: 12, overflow: "hidden" },
  bar: { height: 44, display: "flex", alignItems: "center", gap: 12, padding: "0 12px", background: "var(--ink-700)", borderBottom: "1px solid var(--steel-700)", boxSizing: "border-box", flexShrink: 0, position: "relative" },
  brand: { display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap", flexShrink: 0 },
  brandMark: { fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 17, lineHeight: 1, color: "var(--cream-100)" },
  brandSupport: { fontSize: 8, fontWeight: 600, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--steel-200)", position: "relative", top: 1 },
  spacer: { flex: 1 },
  body: { flex: 1, minHeight: 0, display: "flex" },
  artifact: { flex: 1, minWidth: 0, background: "#ffffff", color: "#1a1a1a", padding: "22px 24px", position: "relative", overflow: "hidden" },
  artEyebrow: { fontSize: 7.5, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "#7a6a3a", marginBottom: 12 },
  artH1: { fontFamily: "'EB Garamond', Georgia, serif", fontStyle: "italic", fontSize: 30, lineHeight: 1.05, margin: "0 0 12px", color: "#1a1a1a", display: "inline-block" },
  artLede: { fontSize: 11, lineHeight: 1.5, color: "#3a3a3a", maxWidth: 320, margin: 0 },
  panel: { width: 248, flexShrink: 0, borderLeft: "1px solid var(--steel-700)", background: "var(--ink-800)", display: "flex", flexDirection: "column", minHeight: 0 },
  panelH: { fontSize: 11, margin: "12px 12px 8px", fontWeight: 600 },
  log: { flex: 1, minHeight: 0, overflow: "hidden", padding: "0 12px 8px", display: "flex", flexDirection: "column", gap: 8 },
  uBub: { alignSelf: "flex-end", maxWidth: "88%", borderRadius: 11, padding: "7px 9px", background: "var(--bg-elevated)", border: "1px solid var(--border-strong)" },
  aBub: { alignSelf: "flex-start", maxWidth: "88%", borderRadius: 11, padding: "7px 9px", background: "transparent", border: "1px solid var(--border-subtle)" },
  bubLabel: { display: "block", fontSize: 8, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-faint)", marginBottom: 3 },
  composer: { borderTop: "1px solid var(--steel-700)", padding: 12, display: "grid", gap: 8, flexShrink: 0 },
  ta: { width: "100%", minHeight: 50, borderRadius: 10, border: "1px solid var(--steel-600)", background: "var(--ink-900)", color: "var(--cream-100)", padding: 8, font: "inherit", fontSize: 11, boxSizing: "border-box", resize: "none" },
};

const fBtn = { border: 0, background: "var(--brass-500)", color: "var(--brass-ink)", borderRadius: 9, padding: "7px 12px", fontFamily: "inherit", fontWeight: 700, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" };
const gBtn = { border: "1px solid var(--steel-600)", background: "transparent", color: "var(--steel-100)", borderRadius: 9, padding: "7px 11px", fontFamily: "inherit", fontWeight: 600, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" };
const iBtn = { width: 28, height: 28, display: "grid", placeItems: "center", border: "1px solid var(--steel-700)", background: "transparent", color: "var(--steel-200)", borderRadius: 8, cursor: "pointer", flexShrink: 0, padding: 0 };

function I({ d, size = 15 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{d}</svg>;
}
const icMore = <><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/></>;
const icSend = <><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/></>;
const icFile = <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></>;
const icRefresh = <><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></>;
const icCamera = <><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/></>;
const icExit = <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></>;
const icCaret = <path d="m6 9 6 6 6-6"/>;

function Brand() {
  return <div style={v2.brand}><span style={v2.brandMark}>Lavish</span><span style={v2.brandSupport}>Editor</span></div>;
}
function AnnotateToggle({ on = true }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--steel-200)", fontSize: 10.5, whiteSpace: "nowrap" }}>
      <span style={{ width: 26, height: 15, borderRadius: 999, background: on ? "var(--brass-500)" : "var(--steel-600)", position: "relative", flexShrink: 0 }}>
        <span style={{ position: "absolute", top: 2, left: on ? 13 : 2, width: 11, height: 11, borderRadius: 999, background: on ? "var(--brass-ink)" : "var(--steel-300)" }} />
      </span>
      <span>Annotate</span>
    </div>
  );
}
function Conversation() {
  return (
    <div style={v2.log}>
      <div style={v2.uBub}><small style={{ ...v2.bubLabel, textAlign: "right" }}>You</small><div>Tighten the heading — fewer words.</div></div>
      <div style={v2.aBub}><small style={v2.bubLabel}>Agent</small><div>Done. Shortened it to a single line.</div></div>
    </div>
  );
}
function ArtifactBody() {
  return (
    <div style={v2.artifact}>
      <div style={v2.artEyebrow}>v0.1 · the rich editor</div>
      <div style={{ ...v2.artH1, outline: "2px solid var(--brass-500)", outlineOffset: 2 }}>For when a rich editor<br/>is not rich enough.</div>
      <p style={v2.artLede}>Lavish opens an agent-generated HTML artifact in a local browser, lets you pinpoint elements, and ships your feedback back to the agent.</p>
    </div>
  );
}

// The ⋯ menu, optionally open — this is where the file path now lives.
function MoreMenu({ open = false }) {
  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <button title="More" style={{ ...iBtn, ...(open ? { borderColor: "var(--steel-500)", color: "var(--cream-100)" } : null) }}><I d={icMore} /></button>
      {open && (
        <div style={{ position: "absolute", right: 0, top: 34, width: 232, background: "var(--ink-800)", border: "1px solid var(--steel-600)", borderRadius: 12, boxShadow: "var(--shadow-tooltip)", padding: 6, zIndex: 20 }}>
          <div style={{ padding: "7px 9px 8px" }}>
            <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-faint)", marginBottom: 4 }}>Editing</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--steel-100)" }}>
              <span style={{ opacity: 0.7, display: "flex" }}><I d={icFile} size={11} /></span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>landing/index.html</span>
            </div>
          </div>
          <div style={{ height: 1, background: "var(--steel-700)", margin: "2px 0 4px" }} />
          {[["Reload artifact", icRefresh], ["Copy DOM snapshot", icCamera]].map(([t, d]) => (
            <div key={t} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", borderRadius: 8, fontSize: 11, color: "var(--steel-100)", cursor: "pointer" }}>
              <span style={{ display: "flex", opacity: 0.8 }}><I d={d} size={13} /></span>{t}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ===== D · Paired footer actions ===== */
function ChromePaired() {
  return (
    <div style={v2.shell}>
      <div style={v2.bar}><Brand /><div style={v2.spacer} /><AnnotateToggle /><MoreMenu open={false} /></div>
      <div style={v2.body}>
        <ArtifactBody />
        <div style={v2.panel}>
          <h2 style={v2.panelH}>Conversation</h2>
          <Conversation />
          <div style={v2.composer}>
            <div style={v2.ta} />
            <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
              <button style={{ ...gBtn, display: "inline-flex", alignItems: "center", gap: 6, color: "var(--rust-500)", borderColor: "transparent" }}><I d={icExit} size={13} />End session</button>
              <button style={fBtn}>Send to Agent</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ===== E · Split send button ===== */
function ChromeSplit() {
  return (
    <div style={v2.shell}>
      <div style={v2.bar}><Brand /><div style={v2.spacer} /><AnnotateToggle /><MoreMenu open={false} /></div>
      <div style={v2.body}>
        <ArtifactBody />
        <div style={v2.panel}>
          <h2 style={v2.panelH}>Conversation</h2>
          <Conversation />
          <div style={v2.composer}>
            <div style={v2.ta} />
            <div style={{ display: "flex", justifyContent: "flex-end", position: "relative" }}>
              <div style={{ display: "inline-flex", alignItems: "stretch" }}>
                <button style={{ ...fBtn, borderTopRightRadius: 0, borderBottomRightRadius: 0 }}>Send to Agent</button>
                <button title="Send options" style={{ ...fBtn, borderTopLeftRadius: 0, borderBottomLeftRadius: 0, padding: "7px 7px", borderLeft: "1px solid rgba(23,19,10,.22)", display: "grid", placeItems: "center" }}><I d={icCaret} size={13} /></button>
              </div>
              <div style={{ position: "absolute", right: 0, bottom: 38, width: 196, background: "var(--ink-800)", border: "1px solid var(--steel-600)", borderRadius: 11, boxShadow: "var(--shadow-tooltip)", padding: 6, zIndex: 20 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", borderRadius: 8, fontSize: 11, color: "var(--steel-100)" }}><span style={{ display: "flex", opacity: 0.85 }}><I d={icSend} size={13} /></span>Send to Agent</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", borderRadius: 8, fontSize: 11, color: "var(--rust-500)" }}><span style={{ display: "flex" }}><I d={icExit} size={13} /></span>Send &amp; end session</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ===== F · Send is the finish (two-tier) ===== */
function ChromeFinish() {
  return (
    <div style={v2.shell}>
      <div style={v2.bar}><Brand /><div style={v2.spacer} /><AnnotateToggle /><MoreMenu open={true} /></div>
      <div style={v2.body}>
        <ArtifactBody />
        <div style={v2.panel}>
          <h2 style={v2.panelH}>Conversation</h2>
          <Conversation />
          <div style={v2.composer}>
            <div style={v2.ta} />
            <button style={{ ...fBtn, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 7, padding: "9px 12px" }}><I d={icSend} size={13} />Send to Agent</button>
            <button style={{ background: "transparent", border: 0, color: "var(--steel-300)", fontSize: 10.5, fontFamily: "inherit", cursor: "pointer", padding: 2, textAlign: "center" }}>Send a final note &amp; end session</button>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ChromePaired, ChromeSplit, ChromeFinish });
