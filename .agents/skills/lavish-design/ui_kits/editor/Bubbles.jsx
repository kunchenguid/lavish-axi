/* global React */
function UserBubble({ children }) {
  const userBubbleStyles = {
    bubble: {
      alignSelf: "flex-end",
      maxWidth: "85%",
      borderRadius: 14,
      padding: "10px 12px",
      background: "var(--bg-elevated)",
      border: "1px solid var(--border-strong)",
    },
    label: {
      display: "block",
      color: "var(--fg-faint)",
      marginBottom: 4,
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      textAlign: "right",
    },
  };
  return (
    <div style={userBubbleStyles.bubble}>
      <small style={userBubbleStyles.label}>You</small>
      <div>{children}</div>
    </div>
  );
}

function AgentBubble({ children }) {
  const agentBubbleStyles = {
    bubble: {
      alignSelf: "flex-start",
      maxWidth: "85%",
      borderRadius: 14,
      padding: "10px 12px",
      background: "transparent",
      border: "1px solid var(--border-subtle)",
    },
    label: {
      display: "block",
      color: "var(--fg-faint)",
      marginBottom: 4,
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
    },
  };
  return (
    <div style={agentBubbleStyles.bubble}>
      <small style={agentBubbleStyles.label}>Agent</small>
      <div>{children}</div>
    </div>
  );
}

function WorkingBubble() {
  const workingStyles = {
    bubble: {
      alignSelf: "flex-start",
      maxWidth: "85%",
      borderRadius: 14,
      padding: "10px 12px",
      background: "transparent",
      border: "1px solid var(--border-subtle)",
      display: "flex",
      alignItems: "center",
      gap: 8,
      color: "var(--fg-muted)",
    },
    spinner: {
      width: 14,
      height: 14,
      borderRadius: 999,
      border: "2px solid var(--steel-600)",
      borderTopColor: "var(--accent)",
      animation: "lavish-spin 0.8s linear infinite",
      display: "inline-block",
    },
  };
  return (
    <div style={workingStyles.bubble}>
      <span style={workingStyles.spinner} />
      <span>Working…</span>
    </div>
  );
}

window.UserBubble = UserBubble;
window.AgentBubble = AgentBubble;
window.WorkingBubble = WorkingBubble;
