/* global React */
function AnnotationCard({ target, onCancel, onQueue }) {
  const { useState, useEffect, useRef } = React;
  const [value, setValue] = useState("");
  const ref = useRef(null);
  const taRef = useRef(null);

  // Position: clamp 12px from any viewport edge, prefer below the target
  const [pos, setPos] = useState({ left: 0, top: 0 });
  useEffect(() => {
    if (!target || !ref.current) return;
    const card = ref.current;
    const w = card.offsetWidth,
      h = card.offsetHeight;
    const r = target.rect;
    const left = Math.min(Math.max(12, r.left), window.innerWidth - w - 12);
    const top = Math.min(Math.max(12, r.bottom + 8), window.innerHeight - h - 12);
    setPos({ left, top });
    taRef.current && taRef.current.focus();
  }, [target]);

  const annoStyles = {
    card: {
      position: "fixed",
      left: pos.left,
      top: pos.top,
      width: "min(320px, calc(100vw - 24px))",
      padding: 12,
      borderRadius: 14,
      background: "var(--ink-800)",
      color: "var(--cream-100)",
      border: "1px solid var(--brass-500)",
      boxShadow: "var(--shadow-floating)",
      fontFamily: "var(--font-sans)",
      fontSize: 14,
      lineHeight: 1.4,
      zIndex: 50,
    },
    heading: { fontWeight: 700, marginBottom: 6 },
    ta: {
      width: "100%",
      minHeight: 86,
      resize: "vertical",
      borderRadius: 10,
      border: "1px solid var(--steel-600)",
      background: "var(--ink-900)",
      color: "var(--cream-100)",
      padding: 9,
      font: "inherit",
      boxSizing: "border-box",
    },
    row: { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 },
    btn: {
      border: 0,
      borderRadius: 9,
      padding: "8px 10px",
      fontWeight: 700,
      fontFamily: "inherit",
      cursor: "pointer",
      fontSize: 13,
    },
    cancel: { background: "var(--steel-700)", color: "var(--cream-100)" },
    send: { background: "var(--brass-500)", color: "var(--brass-ink)" },
  };

  if (!target) return null;
  return (
    <div ref={ref} style={annoStyles.card} onClick={(e) => e.stopPropagation()}>
      <div style={annoStyles.heading}>Annotate &lt;{target.tag}&gt;</div>
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Tell the agent what to change about this element…"
        style={annoStyles.ta}
      />
      <div style={annoStyles.row}>
        <button style={{ ...annoStyles.btn, ...annoStyles.cancel }} onClick={onCancel}>
          Cancel
        </button>
        <button
          style={{
            ...annoStyles.btn,
            ...annoStyles.send,
            opacity: value.trim() ? 1 : 0.55,
            cursor: value.trim() ? "pointer" : "not-allowed",
          }}
          onClick={() => value.trim() && onQueue(value.trim())}
        >
          Queue Prompt
        </button>
      </div>
    </div>
  );
}

window.AnnotationCard = AnnotationCard;
