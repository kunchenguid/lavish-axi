/* global React, UserBubble, AgentBubble, WorkingBubble, Pill */
const { useEffect: useEffectChat, useRef: useRefChat } = React;

function ChatPanel({ chat, working, pills, draft, onDraftChange, onRemovePill, onSend }) {
  const logRef = useRefChat(null);
  useEffectChat(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [chat, working]);

  const canSend = !working && (pills.length > 0 || draft.trim().length > 0);

  const chatStyles = {
    panel: {
      borderLeft: "1px solid var(--steel-700)",
      background: "var(--ink-800)",
      display: "flex",
      flexDirection: "column",
      minWidth: 0,
      minHeight: 0,
      width: 360,
      flexShrink: 0,
    },
    h2: { fontSize: 15, margin: "16px 16px 8px", fontWeight: 600 },
    log: {
      flex: 1,
      minHeight: 0,
      overflow: "auto",
      padding: "0 16px 12px",
      display: "flex",
      flexDirection: "column",
      gap: 10,
    },
    composer: {
      display: "grid",
      gap: 8,
      padding: "12px 16px",
      borderTop: "1px solid var(--steel-700)",
      minWidth: 0,
      flexShrink: 0,
      boxSizing: "border-box",
    },
    pills: { display: "flex", flexWrap: "wrap", gap: 6, minWidth: 0 },
    ta: {
      width: "100%",
      maxWidth: "100%",
      minWidth: 0,
      minHeight: 82,
      resize: "vertical",
      borderRadius: 12,
      border: "1px solid var(--steel-600)",
      background: "var(--ink-900)",
      color: "var(--cream-100)",
      padding: 10,
      font: "inherit",
      fontFamily: "var(--font-sans)",
      fontSize: 14,
      boxSizing: "border-box",
    },
    actions: { display: "flex", gap: 8, justifyContent: "flex-end" },
    send: {
      border: 0,
      borderRadius: 10,
      padding: "9px 12px",
      background: "var(--brass-500)",
      color: "var(--brass-ink)",
      fontFamily: "inherit",
      fontWeight: 700,
      cursor: canSend ? "pointer" : "not-allowed",
      opacity: canSend ? 1 : 0.55,
      fontSize: 13,
      whiteSpace: "nowrap",
    },
  };

  return (
    <aside style={chatStyles.panel}>
      <h2 style={chatStyles.h2}>Conversation</h2>
      <div ref={logRef} style={chatStyles.log}>
        {chat.map((m, i) =>
          m.role === "user" ? <UserBubble key={i}>{m.text}</UserBubble> : <AgentBubble key={i}>{m.text}</AgentBubble>,
        )}
        {working && <WorkingBubble />}
      </div>
      <div style={chatStyles.composer}>
        {pills.length > 0 && (
          <div style={chatStyles.pills}>
            {pills.map((p, i) => (
              <Pill key={i} prompt={p} onRemove={() => onRemovePill(i)} />
            ))}
          </div>
        )}
        <textarea
          placeholder="Write a message for the agent…"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          style={chatStyles.ta}
        />
        <div style={chatStyles.actions}>
          <button style={chatStyles.send} disabled={!canSend} onClick={canSend ? onSend : undefined}>
            Send to Agent
          </button>
        </div>
      </div>
    </aside>
  );
}

window.ChatPanel = ChatPanel;
