/* global React */
const { useState: useStateTB, useEffect: useEffectTB, useRef: useRefTB } = React;

function TBIcon({ d, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {d}
    </svg>
  );
}
const tbMore = <><circle cx="12" cy="5" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="12" cy="19" r="1.4" /></>;
const tbFile = <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></>;
const tbRefresh = <><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></>;
const tbCamera = <><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" /><circle cx="12" cy="13" r="3" /></>;
const tbExit = <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></>;
const tbCopy = <><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>;
const tbCheck = <polyline points="20 6 9 17 4 12" />;

// Annotate on/off switch — replaces the old labeled button.
function AnnotateSwitch({ on, disabled, onToggle }) {
  const s = {
    wrap: { display: "inline-flex", alignItems: "center", gap: 8, color: "var(--steel-100)", fontSize: 13, whiteSpace: "nowrap", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1, userSelect: "none", background: "none", border: 0, fontFamily: "inherit", padding: 0 },
    track: { width: 34, height: 20, borderRadius: 999, background: on ? "var(--brass-500)" : "var(--steel-600)", position: "relative", flexShrink: 0, transition: "background 150ms var(--ease)" },
    knob: { position: "absolute", top: 2, left: on ? 16 : 2, width: 16, height: 16, borderRadius: 999, background: on ? "var(--brass-ink)" : "var(--steel-300)", transition: "left 150ms var(--ease)" },
  };
  return (
    <button type="button" style={s.wrap} onClick={disabled ? undefined : onToggle} aria-pressed={on}>
      <span style={s.track}><span style={s.knob} /></span>
      <span>Annotate</span>
    </button>
  );
}

function MenuItem({ icon, label, danger, onClick }) {
  const [hover, setHover] = useStateTB(false);
  const base = {
    display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left",
    padding: "9px 10px", borderRadius: 8, fontSize: 13, fontFamily: "inherit",
    border: 0, cursor: "pointer", background: hover ? (danger ? "rgba(240,100,100,.10)" : "var(--steel-700)") : "transparent",
    color: danger ? "var(--rust-500)" : "var(--cream-100)",
  };
  return (
    <button type="button" style={base} onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <span style={{ display: "flex", opacity: danger ? 1 : 0.8 }}><TBIcon d={icon} size={15} /></span>
      {label}
    </button>
  );
}

function TopBar({ filePath, annotationOn, onToggleAnnotation, onEndSession, onReload, onSnapshot, ended }) {
  const [menuOpen, setMenuOpen] = useStateTB(false);
  const [copied, setCopied] = useStateTB(false);
  const menuRef = useRefTB(null);

  useEffectTB(() => {
    if (!menuOpen) return;
    const onDown = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [menuOpen]);

  useEffectTB(() => {
    if (!menuOpen) setCopied(false);
  }, [menuOpen]);

  const copyPath = () => {
    const text = filePath || "";
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
    } catch (e) { /* best-effort */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const shortName = (filePath || "").split("/").slice(-2).join("/");

  const s = {
    bar: { height: 56, display: "flex", alignItems: "center", gap: 14, padding: "0 16px", background: "var(--ink-700)", borderBottom: "1px solid var(--steel-700)", boxSizing: "border-box", flexShrink: 0 },
    brand: { display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap", flexShrink: 0 },
    brandMark: { fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 22, lineHeight: 1, color: "var(--cream-100)" },
    brandSupport: { fontFamily: "var(--font-sans)", fontSize: 10, fontWeight: 600, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--steel-200)", position: "relative", top: 1 },
    spacer: { flex: 1 },
    moreWrap: { position: "relative", flexShrink: 0 },
    moreBtn: { width: 34, height: 34, display: "grid", placeItems: "center", border: "1px solid", borderColor: menuOpen ? "var(--steel-500)" : "var(--steel-700)", background: menuOpen ? "var(--steel-700)" : "transparent", color: menuOpen ? "var(--cream-100)" : "var(--steel-200)", borderRadius: 9, cursor: ended ? "not-allowed" : "pointer", padding: 0, opacity: ended ? 0.55 : 1 },
    menu: { position: "absolute", right: 0, top: 42, width: 248, background: "var(--ink-700)", border: "1px solid var(--steel-600)", borderRadius: 12, boxShadow: "var(--shadow-tooltip)", padding: 6, zIndex: 70 },
    menuHead: { padding: "7px 10px 9px" },
    menuLabel: { fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-faint)", marginBottom: 5 },
    menuFileBtn: { display: "flex", alignItems: "center", gap: 7, width: "100%", textAlign: "left", border: 0, background: "transparent", padding: "3px 4px", margin: "0 -4px", borderRadius: 7, cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--steel-100)" },
    menuFileText: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 },
    copyHint: { fontFamily: "var(--font-sans)", fontSize: 10, fontWeight: 600, color: copied ? "var(--brass-400)" : "var(--fg-faint)", flexShrink: 0, display: "flex", alignItems: "center", gap: 4 },
    rule: { height: 1, background: "var(--steel-600)", margin: "4px 0" },
  };

  return (
    <div style={s.bar}>
      <div style={s.brand}>
        <span style={s.brandMark}>Lavish</span>
        <span style={s.brandSupport}>Editor</span>
      </div>
      <div style={s.spacer} />
      <AnnotateSwitch on={annotationOn} disabled={ended} onToggle={onToggleAnnotation} />
      <div style={s.moreWrap} ref={menuRef}>
        <button type="button" title="More" style={s.moreBtn} onClick={ended ? undefined : () => setMenuOpen((v) => !v)} disabled={ended}>
          <TBIcon d={tbMore} />
        </button>
        {menuOpen && (
          <div style={s.menu}>
            <div style={s.menuHead}>
              <div style={s.menuLabel}>Editing</div>
              <button type="button" style={s.menuFileBtn} title={`Copy path · ${filePath}`} onClick={copyPath}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--steel-700)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                <span style={{ opacity: 0.7, display: "flex" }}><TBIcon d={tbFile} size={13} /></span>
                <span style={s.menuFileText}>{shortName}</span>
                <span style={s.copyHint}>
                  <TBIcon d={copied ? tbCheck : tbCopy} size={12} />
                  {copied ? "Copied" : "Copy"}
                </span>
              </button>
            </div>
            <div style={s.rule} />
            <MenuItem icon={tbRefresh} label="Reload artifact" onClick={() => { setMenuOpen(false); onReload && onReload(); }} />
            <MenuItem icon={tbCamera} label="Copy DOM snapshot" onClick={() => { setMenuOpen(false); onSnapshot && onSnapshot(); }} />
            <div style={s.rule} />
            <MenuItem icon={tbExit} label="End session" danger onClick={() => { setMenuOpen(false); onEndSession && onEndSession(); }} />
          </div>
        )}
      </div>
    </div>
  );
}

window.TopBar = TopBar;
