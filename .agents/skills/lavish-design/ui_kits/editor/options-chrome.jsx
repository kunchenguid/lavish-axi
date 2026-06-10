/* global React */
// Mock chrome renderers for the "reduce button noise" exploration.
// Each renders a small, static Lavish Editor chrome at artboard scale.
// Shared bits live here; the four variants compose them differently.

const mc = {
  shell: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    background: "var(--ink-900)",
    color: "var(--cream-100)",
    fontFamily: "var(--font-sans)",
    fontSize: 12,
    overflow: "hidden",
  },
  bar: {
    height: 44,
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "0 12px",
    background: "var(--ink-700)",
    borderBottom: "1px solid var(--steel-700)",
    boxSizing: "border-box",
    flexShrink: 0,
  },
  brand: { display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap", flexShrink: 0 },
  brandMark: { fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 17, lineHeight: 1, color: "var(--cream-100)" },
  brandSupport: { fontSize: 8, fontWeight: 600, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--steel-200)", position: "relative", top: 1 },
  divider: { width: 1, height: 18, background: "var(--steel-700)", flexShrink: 0 },
  fileWrap: { display: "flex", alignItems: "center", gap: 5, flex: 1, minWidth: 0, color: "var(--steel-200)", fontFamily: "var(--font-mono)", fontSize: 10.5 },
  fileText: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  body: { flex: 1, minHeight: 0, display: "flex" },
  artifact: { flex: 1, minWidth: 0, background: "#ffffff", color: "#1a1a1a", padding: "22px 24px", position: "relative", overflow: "hidden" },
  artEyebrow: { fontSize: 7.5, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "#7a6a3a", marginBottom: 12 },
  artH1: { fontFamily: "'EB Garamond', Georgia, serif", fontStyle: "italic", fontSize: 30, lineHeight: 1.05, margin: "0 0 12px", color: "#1a1a1a", display: "inline-block" },
  artLede: { fontSize: 11, lineHeight: 1.5, color: "#3a3a3a", maxWidth: 320, margin: 0 },
  panel: { width: 234, flexShrink: 0, borderLeft: "1px solid var(--steel-700)", background: "var(--ink-800)", display: "flex", flexDirection: "column", minHeight: 0 },
  panelH: { fontSize: 11, margin: "12px 12px 8px", fontWeight: 600 },
  log: { flex: 1, minHeight: 0, overflow: "hidden", padding: "0 12px 8px", display: "flex", flexDirection: "column", gap: 8 },
  uBub: { alignSelf: "flex-end", maxWidth: "88%", borderRadius: 11, padding: "7px 9px", background: "var(--bg-elevated)", border: "1px solid var(--border-strong)" },
  aBub: { alignSelf: "flex-start", maxWidth: "88%", borderRadius: 11, padding: "7px 9px", background: "transparent", border: "1px solid var(--border-subtle)" },
  bubLabel: { display: "block", fontSize: 8, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-faint)", marginBottom: 3 },
  composer: { borderTop: "1px solid var(--steel-700)", padding: 12, display: "grid", gap: 8, flexShrink: 0 },
  ta: { width: "100%", minHeight: 52, borderRadius: 10, border: "1px solid var(--steel-600)", background: "var(--ink-900)", color: "var(--cream-100)", padding: 8, font: "inherit", fontSize: 11, boxSizing: "border-box", resize: "none" },
};

const ghostBtn = { border: "1px solid var(--steel-600)", background: "transparent", color: "var(--steel-100)", borderRadius: 9, padding: "6px 10px", fontFamily: "inherit", fontWeight: 600, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" };
const filledBtn = { border: 0, background: "var(--brass-500)", color: "var(--brass-ink)", borderRadius: 9, padding: "6px 11px", fontFamily: "inherit", fontWeight: 700, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" };
const iconBtn = { width: 28, height: 28, display: "grid", placeItems: "center", border: "1px solid transparent", background: "transparent", color: "var(--steel-200)", borderRadius: 8, cursor: "pointer", flexShrink: 0, padding: 0 };

function Ic({ d, size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {d}
    </svg>
  );
}
const fileIcon = <Ic size={11} d={<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></>} />;
const penIcon = <><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></>;
const moreIcon = <><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></>;
const sendIcon = <><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/></>;

function Brand() {
  return (
    <div style={mc.brand}>
      <span style={mc.brandMark}>Lavish</span>
      <span style={mc.brandSupport}>Editor</span>
    </div>
  );
}
function FileChip() {
  return (
    <div style={mc.fileWrap} title="~/projects/landing/index.html">
      <span style={{ opacity: 0.7, display: "flex" }}>{fileIcon}</span>
      <span style={mc.fileText}>~/projects/landing/index.html</span>
    </div>
  );
}
function Toggle({ on = true }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--steel-200)", fontSize: 10.5, whiteSpace: "nowrap" }}>
      <span style={{ width: 26, height: 15, borderRadius: 999, background: on ? "var(--brass-500)" : "var(--steel-600)", position: "relative", flexShrink: 0, transition: "background .15s" }}>
        <span style={{ position: "absolute", top: 2, left: on ? 13 : 2, width: 11, height: 11, borderRadius: 999, background: on ? "var(--brass-ink)" : "var(--steel-300)" }} />
      </span>
      <span>Annotate</span>
    </div>
  );
}
function Conversation({ extra }) {
  return (
    <div style={mc.log}>
      <div style={mc.uBub}><small style={{ ...mc.bubLabel, textAlign: "right" }}>You</small><div>Tighten the heading — fewer words.</div></div>
      <div style={mc.aBub}><small style={mc.bubLabel}>Agent</small><div>Done. Shortened it to a single line.</div></div>
      {extra}
    </div>
  );
}
function ArtifactBody({ note }) {
  return (
    <div style={mc.artifact}>
      <div style={mc.artEyebrow}>v0.1 · the rich editor</div>
      <div style={{ ...mc.artH1, outline: "2px solid var(--brass-500)", outlineOffset: 2 }}>For when a rich editor<br/>is not rich enough.</div>
      <p style={mc.artLede}>Lavish opens an agent-generated HTML artifact in a local browser, lets you pinpoint elements, and ships your feedback back to the agent.</p>
      {note}
    </div>
  );
}

/* ----- Variant 0 · Current (baseline) ----- */
function ChromeBaseline() {
  return (
    <div style={mc.shell}>
      <div style={mc.bar}>
        <Brand /><div style={mc.divider} /><FileChip />
        <button style={mc.barBtn || { ...ghostBtn, background: "var(--steel-700)", border: 0 }}>Annotation: On</button>
        <button style={{ ...ghostBtn, color: "var(--rust-500)", borderColor: "var(--rust-500)" }}>End Session</button>
      </div>
      <div style={mc.body}>
        <ArtifactBody note={
          <div style={{ position: "absolute", left: 150, top: 92, width: 188, padding: 9, borderRadius: 11, background: "var(--ink-800)", color: "var(--cream-100)", border: "1px solid var(--brass-500)", boxShadow: "var(--shadow-floating)" }}>
            <div style={{ fontWeight: 700, marginBottom: 5, fontSize: 11 }}>Annotate &lt;h1&gt;</div>
            <div style={{ height: 30, borderRadius: 7, border: "1px solid var(--steel-600)", background: "var(--ink-900)" }} />
            <div style={{ display: "flex", gap: 5, justifyContent: "flex-end", marginTop: 6 }}>
              <button style={{ ...ghostBtn, padding: "4px 7px", fontSize: 10 }}>Cancel</button>
              <button style={{ ...filledBtn, padding: "4px 7px", fontSize: 10 }}>Queue Prompt</button>
            </div>
          </div>
        } />
        <div style={mc.panel}>
          <h2 style={mc.panelH}>Conversation</h2>
          <Conversation extra={
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, border: "1px solid var(--steel-500)", borderRadius: 999, background: "var(--ink-600)", padding: "3px 5px 3px 8px", fontSize: 9.5, fontWeight: 700 }}>Make CTA italic<span style={{ width: 13, height: 13, borderRadius: 999, background: "var(--steel-600)", display: "grid", placeItems: "center", fontSize: 10 }}>×</span></span>
            </div>
          } />
          <div style={mc.composer}>
            <div style={mc.ta} />
            <div style={{ display: "flex", gap: 6 }}><button style={filledBtn}>Send to Agent</button></div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ----- Variant A · Quiet bar (demote to ghost + icon) ----- */
function ChromeQuiet() {
  return (
    <div style={mc.shell}>
      <div style={mc.bar}>
        <Brand /><div style={mc.divider} /><FileChip />
        <Toggle on={true} />
        <button title="End session" style={iconBtn}><Ic d={<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></>} /></button>
      </div>
      <div style={mc.body}>
        <ArtifactBody note={
          <div style={{ position: "absolute", left: 150, top: 92, width: 188, padding: 9, borderRadius: 11, background: "var(--ink-800)", color: "var(--cream-100)", border: "1px solid var(--brass-500)", boxShadow: "var(--shadow-floating)" }}>
            <div style={{ fontWeight: 700, marginBottom: 5, fontSize: 11 }}>Annotate &lt;h1&gt;</div>
            <div style={{ height: 30, borderRadius: 7, border: "1px solid var(--steel-600)", background: "var(--ink-900)" }} />
            <div style={{ display: "flex", gap: 5, justifyContent: "flex-end", marginTop: 6, alignItems: "center" }}>
              <span style={{ fontSize: 10, color: "var(--steel-300)", cursor: "pointer" }}>Cancel</span>
              <button style={{ ...filledBtn, padding: "4px 9px", fontSize: 10 }}>Queue</button>
            </div>
          </div>
        } />
        <div style={mc.panel}>
          <h2 style={mc.panelH}>Conversation</h2>
          <Conversation />
          <div style={mc.composer}>
            <div style={mc.ta} />
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}><button style={filledBtn}>Send to Agent</button></div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ----- Variant B · Overflow menu (one bar control) ----- */
function ChromeOverflow() {
  return (
    <div style={mc.shell}>
      <div style={mc.bar}>
        <Brand /><div style={mc.divider} /><FileChip />
        <Toggle on={true} />
        <button title="More" style={{ ...iconBtn, border: "1px solid var(--steel-700)" }}><Ic d={moreIcon} /></button>
      </div>
      <div style={mc.body}>
        <ArtifactBody note={
          <div style={{ position: "absolute", left: 150, top: 92, width: 188, padding: 9, borderRadius: 11, background: "var(--ink-800)", color: "var(--cream-100)", border: "1px solid var(--brass-500)", boxShadow: "var(--shadow-floating)" }}>
            <div style={{ fontWeight: 700, marginBottom: 5, fontSize: 11 }}>Annotate &lt;h1&gt;</div>
            <div style={{ height: 30, borderRadius: 7, border: "1px solid var(--steel-600)", background: "var(--ink-900)" }} />
            <div style={{ display: "flex", gap: 5, justifyContent: "flex-end", marginTop: 6, alignItems: "center" }}>
              <span style={{ fontSize: 10, color: "var(--steel-300)" }}>Esc</span>
              <button style={{ ...filledBtn, padding: "4px 9px", fontSize: 10 }}>Queue</button>
            </div>
          </div>
        } />
        <div style={mc.panel}>
          <h2 style={mc.panelH}>Conversation</h2>
          <Conversation />
          <div style={mc.composer}>
            <div style={{ position: "relative" }}>
              <div style={mc.ta} />
              <button title="Send" style={{ ...filledBtn, position: "absolute", right: 7, bottom: 7, width: 26, height: 26, padding: 0, display: "grid", placeItems: "center", borderRadius: 8 }}><Ic d={sendIcon} size={13} /></button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ----- Variant C · Unified composer (no floating card) ----- */
function ChromeUnified() {
  return (
    <div style={mc.shell}>
      <div style={mc.bar}>
        <Brand /><div style={mc.divider} /><FileChip />
        <Toggle on={true} />
        <button title="More" style={{ ...iconBtn, border: "1px solid var(--steel-700)" }}><Ic d={moreIcon} /></button>
      </div>
      <div style={mc.body}>
        <ArtifactBody note={null} />
        <div style={mc.panel}>
          <h2 style={mc.panelH}>Conversation</h2>
          <Conversation />
          <div style={mc.composer}>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 5, alignSelf: "flex-start", border: "1px solid var(--brass-500)", color: "var(--brass-500)", borderRadius: 999, padding: "3px 5px 3px 9px", fontSize: 9.5, fontWeight: 700, fontFamily: "var(--font-mono)" }}>
              <span style={{ display: "flex", opacity: 0.85 }}><Ic d={penIcon} size={10} /></span>
              editing &lt;h1&gt;
              <span style={{ width: 13, height: 13, borderRadius: 999, background: "rgba(244,201,93,.18)", display: "grid", placeItems: "center", fontSize: 10 }}>×</span>
            </div>
            <div style={{ position: "relative" }}>
              <div style={{ ...mc.ta, minHeight: 48 }} />
              <button title="Send" style={{ ...filledBtn, position: "absolute", right: 7, bottom: 7, width: 26, height: 26, padding: 0, display: "grid", placeItems: "center", borderRadius: 8 }}><Ic d={sendIcon} size={13} /></button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ChromeBaseline, ChromeQuiet, ChromeOverflow, ChromeUnified });
