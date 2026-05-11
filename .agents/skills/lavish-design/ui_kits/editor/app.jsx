/* global React, ReactDOM, TopBar, Artifact, AnnotationCard, ChatPanel */
const { useState, useEffect, useCallback } = React;

const CANNED_REPLIES = [
  "Done. I tightened the heading and softened the lede — take a look.",
  "Updated. The CTA is now italic Garamond on brass; let me know if you'd rather a sans label.",
  "Got it. Moved the footer below the bullets and dropped the v0.1 chip.",
  "Adjusted. The eyebrow color is now sage to match the agent palette.",
];

function App() {
  const [annotationOn, setAnnotationOn] = useState(true);
  const [hovered, setHovered] = useState(null);
  const [annotating, setAnnotating] = useState(null); // { id, tag, rect }
  const [pills, setPills] = useState(["Tighten the heading — fewer words, more confidence"]);
  const [draft, setDraft] = useState("");
  const [chat, setChat] = useState([
    { role: "agent", text: "Opened landing/index.html. Annotation is on — click any element to start." },
  ]);
  const [working, setWorking] = useState(false);
  const [ended, setEnded] = useState(false);
  const [replyIdx, setReplyIdx] = useState(0);

  const handleArtifactClick = useCallback(
    (target) => {
      if (!annotationOn) return;
      setAnnotating(target);
    },
    [annotationOn],
  );

  const closeCard = () => setAnnotating(null);

  const queuePrompt = (text) => {
    setPills((p) => [...p, text]);
    setAnnotating(null);
  };

  const removePill = (i) => setPills((p) => p.filter((_, idx) => idx !== i));

  const sendToAgent = () => {
    if (working) return;
    const messages = [...pills];
    if (draft.trim()) messages.push(draft.trim());
    if (messages.length === 0) return;
    setChat((c) => [...c, ...messages.map((t) => ({ role: "user", text: t }))]);
    setPills([]);
    setDraft("");
    setWorking(true);
    setTimeout(() => {
      const reply = CANNED_REPLIES[replyIdx % CANNED_REPLIES.length];
      setReplyIdx((i) => i + 1);
      setChat((c) => [...c, { role: "agent", text: reply }]);
      setWorking(false);
    }, 1400);
  };

  const endSession = () => {
    setEnded(true);
    setAnnotationOn(false);
    setAnnotating(null);
    setChat((c) => [...c, { role: "agent", text: "Session ended. The agent polling loop can stop." }]);
  };

  // Click outside annotation card closes it
  useEffect(() => {
    if (!annotating) return;
    const onKey = (e) => {
      if (e.key === "Escape") closeCard();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [annotating]);

  const appStyles = {
    root: {
      position: "fixed",
      inset: 0,
      display: "flex",
      flexDirection: "column",
      background: "var(--ink-900)",
      color: "var(--cream-100)",
      fontFamily: "var(--font-sans)",
      fontSize: 14,
      lineHeight: 1.45,
      overflow: "hidden",
    },
    layout: { flex: 1, minHeight: 0, display: "flex" },
    endedOverlay: {
      position: "absolute",
      inset: "56px 0 0 0",
      background: "rgba(15, 17, 21, 0.86)",
      display: ended ? "flex" : "none",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 60,
      pointerEvents: "none",
    },
    endedCard: {
      background: "var(--ink-800)",
      border: "1px solid var(--steel-600)",
      borderRadius: 14,
      padding: "20px 24px",
      maxWidth: 360,
      textAlign: "center",
      pointerEvents: "auto",
    },
    endedQuote: {
      fontFamily: "var(--font-serif)",
      fontStyle: "italic",
      fontSize: 22,
      lineHeight: 1.3,
      color: "var(--cream-100)",
      marginBottom: 8,
    },
    endedSub: {
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      color: "var(--steel-300)",
    },
  };

  return (
    <div style={appStyles.root}>
      <TopBar
        filePath="~/projects/landing/index.html"
        annotationOn={annotationOn}
        onToggleAnnotation={() => setAnnotationOn((v) => !v)}
        onEndSession={endSession}
        ended={ended}
      />
      <div style={appStyles.layout}>
        <Artifact
          annotationOn={annotationOn && !ended}
          hoveredEl={hovered}
          selectedEl={annotating}
          onHover={setHovered}
          onClick={handleArtifactClick}
        />
        <ChatPanel
          chat={chat}
          working={working}
          pills={pills}
          draft={draft}
          onDraftChange={setDraft}
          onRemovePill={removePill}
          onSend={sendToAgent}
        />
      </div>
      {annotating && <AnnotationCard target={annotating} onCancel={closeCard} onQueue={queuePrompt} />}
      <div style={appStyles.endedOverlay}>
        <div style={appStyles.endedCard}>
          <div style={appStyles.endedQuote}>
            Session ended.
            <br />
            The agent polling loop can stop.
          </div>
          <div style={appStyles.endedSub}>~/projects/landing/index.html</div>
        </div>
      </div>
    </div>
  );
}

window.App = App;
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
