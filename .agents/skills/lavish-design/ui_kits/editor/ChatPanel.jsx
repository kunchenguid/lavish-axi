/* global React, UserBubble, AgentBubble, WorkingBubble, Pill */
const { useEffect: useEffectChat, useRef: useRefChat, useState: useStateChat } = React;

function SendIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4Z" />
    </svg>
  );
}
function CaretIcon({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
function ExitIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

function ChatPanel({ chat, working, pills, draft, onDraftChange, onRemovePill, onSend, onSendAndEnd }) {
  const logRef = useRefChat(null);
  const splitRef = useRefChat(null);
  const [splitOpen, setSplitOpen] = useStateChat(false);

  useEffectChat(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [chat, working]);

  useEffectChat(() => {
    if (!splitOpen) return;
    const onDown = (e) => { if (splitRef.current && !splitRef.current.contains(e.target)) setSplitOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setSplitOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [splitOpen]);

  // The shipped product keeps Send enabled when the composer is empty and nudges instead:
  // a transient inline hint, with disabled styling reserved for the working state.
  const hasContent = pills.length > 0 || draft.trim().length > 0;
  const canSend = !working;
  const [hint, setHint] = useStateChat(false);
  const hintTimer = useRefChat(null);
  const trySend = () => {
    if (working) return;
    if (!hasContent) {
      setHint(true);
      clearTimeout(hintTimer.current);
      hintTimer.current = setTimeout(() => setHint(false), 2600);
      return;
    }
    setHint(false);
    onSend();
  };

  const s = {
    panel: { borderLeft: "1px solid var(--steel-700)", background: "var(--ink-800)", display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, width: 360, flexShrink: 0 },
    h2: { fontSize: 15, margin: "16px 16px 8px", fontWeight: 600 },
    log: { flex: 1, minHeight: 0, overflow: "auto", padding: "0 16px 12px", display: "flex", flexDirection: "column", gap: 10 },
    composer: { display: "grid", gap: 8, padding: "12px 16px", borderTop: "1px solid var(--steel-700)", minWidth: 0, flexShrink: 0, boxSizing: "border-box" },
    pills: { display: "flex", flexWrap: "wrap", gap: 6, minWidth: 0 },
    ta: { width: "100%", maxWidth: "100%", minWidth: 0, minHeight: 82, resize: "vertical", borderRadius: 12, border: "1px solid var(--steel-600)", background: "var(--ink-900)", color: "var(--cream-100)", padding: 10, font: "inherit", fontFamily: "var(--font-sans)", fontSize: 14, boxSizing: "border-box" },
    actions: { display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end", position: "relative" },
    hint: { marginRight: "auto", color: "var(--fg-faint)", fontSize: 11, lineHeight: 1.35 },
    split: { display: "inline-flex", alignItems: "stretch" },
    sendMain: { border: 0, borderTopLeftRadius: 10, borderBottomLeftRadius: 10, borderTopRightRadius: 0, borderBottomRightRadius: 0, padding: "9px 14px", background: "var(--brass-500)", color: "var(--brass-ink)", fontFamily: "inherit", fontWeight: 700, cursor: canSend ? "pointer" : "not-allowed", opacity: canSend ? 1 : 0.55, fontSize: 13, whiteSpace: "nowrap" },
    sendCaret: { border: 0, borderTopRightRadius: 10, borderBottomRightRadius: 10, borderTopLeftRadius: 0, borderBottomLeftRadius: 0, padding: "9px 9px", background: "var(--brass-500)", color: "var(--brass-ink)", cursor: working ? "not-allowed" : "pointer", opacity: working ? 0.55 : 1, borderLeft: "1px solid rgba(23,19,10,.22)", display: "grid", placeItems: "center" },
    menu: { position: "absolute", right: 0, bottom: 44, width: 208, background: "var(--ink-700)", border: "1px solid var(--steel-600)", borderRadius: 11, boxShadow: "var(--shadow-tooltip)", padding: 6, zIndex: 40 },
  };

  const SplitMenuItem = ({ icon, label, danger, disabled, onClick }) => {
    const [hover, setHover] = useStateChat(false);
    return (
      <button
        type="button"
        onClick={disabled ? undefined : onClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left",
          padding: "8px 9px", borderRadius: 8, fontSize: 13, fontFamily: "inherit", border: 0,
          cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
          background: hover && !disabled ? (danger ? "rgba(240,100,100,.10)" : "var(--steel-700)") : "transparent",
          color: danger ? "var(--rust-500)" : "var(--cream-100)",
        }}
      >
        <span style={{ display: "flex", opacity: danger ? 1 : 0.85 }}>{icon}</span>{label}
      </button>
    );
  };

  return (
    <aside style={s.panel}>
      <h2 style={s.h2}>Conversation</h2>
      <div ref={logRef} style={s.log}>
        {chat.map((m, i) =>
          m.role === "user" ? <UserBubble key={i}>{m.text}</UserBubble> : <AgentBubble key={i}>{m.text}</AgentBubble>
        )}
        {working && <WorkingBubble />}
      </div>
      <div style={s.composer}>
        {pills.length > 0 && (
          <div style={s.pills}>
            {pills.map((p, i) => (
              <Pill key={i} prompt={p} onRemove={() => onRemovePill(i)} />
            ))}
          </div>
        )}
        <textarea
          placeholder="Write a message for the agent…"
          value={draft}
          onChange={(e) => { setHint(false); onDraftChange(e.target.value); }}
          style={s.ta}
        />
        <div style={s.actions} ref={splitRef}>
          {hint && <span style={s.hint}>Write a message or annotate an element first.</span>}
          <div style={s.split}>
            <button style={s.sendMain} disabled={!canSend} onClick={trySend}>Send to Agent</button>
            <button style={s.sendCaret} title="Send options" disabled={working} onClick={working ? undefined : () => setSplitOpen((v) => !v)}>
              <CaretIcon />
            </button>
          </div>
          {splitOpen && (
            <div style={s.menu}>
              <SplitMenuItem icon={<SendIcon />} label="Send to Agent" disabled={!canSend} onClick={() => { setSplitOpen(false); trySend(); }} />
              <SplitMenuItem icon={<ExitIcon />} label="Send & end session" danger onClick={() => { setSplitOpen(false); onSendAndEnd(); }} />
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

window.ChatPanel = ChatPanel;
