/* global React */
const { useEffect, useRef } = React;

function TopBar({ filePath, annotationOn, onToggleAnnotation, onEndSession, ended }) {
  const topBarStyles = {
    bar: {
      height: 56,
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "0 16px",
      background: "var(--ink-700)",
      borderBottom: "1px solid var(--steel-700)",
      boxSizing: "border-box",
      flexShrink: 0,
    },
    brand: { display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap", flexShrink: 0 },
    divider: { width: 1, height: 22, background: "var(--steel-700)", flexShrink: 0 },
    fileWrap: {
      display: "flex",
      alignItems: "center",
      gap: 6,
      flex: 1,
      minWidth: 0,
      color: "var(--steel-200)",
      fontFamily: "var(--font-mono)",
      fontSize: 12,
    },
    fileIcon: { width: 12, height: 12, flexShrink: 0, opacity: 0.7 },
    fileText: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    brandMark: {
      fontFamily: "var(--font-serif)",
      fontStyle: "italic",
      fontSize: 22,
      lineHeight: 1,
      color: "var(--cream-100)",
    },
    brandSupport: {
      fontFamily: "var(--font-sans)",
      fontSize: 10,
      fontWeight: 600,
      letterSpacing: "0.18em",
      textTransform: "uppercase",
      color: "var(--steel-200)",
      position: "relative",
      top: 1,
    },
    btnBase: {
      border: 0,
      borderRadius: 10,
      padding: "9px 12px",
      fontFamily: "inherit",
      fontWeight: 700,
      cursor: "pointer",
      fontSize: 13,
      whiteSpace: "nowrap",
      flexShrink: 0,
    },
    secondary: { background: "var(--steel-700)", color: "var(--cream-100)", fontWeight: 600 },
    danger: {
      background: "transparent",
      color: "var(--rust-500)",
      border: "1px solid var(--rust-500)",
      fontWeight: 600,
    },
  };

  return (
    <div style={topBarStyles.bar}>
      <div style={topBarStyles.brand}>
        <span style={topBarStyles.brandMark}>Lavish</span>
        <span style={topBarStyles.brandSupport}>Editor</span>
      </div>
      <div style={topBarStyles.divider} />
      <div style={topBarStyles.fileWrap} title={filePath}>
        <svg
          style={topBarStyles.fileIcon}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        <span style={topBarStyles.fileText}>{filePath}</span>
      </div>
      <button
        style={{
          ...topBarStyles.btnBase,
          ...topBarStyles.secondary,
          opacity: ended ? 0.55 : 1,
          cursor: ended ? "not-allowed" : "pointer",
        }}
        onClick={ended ? undefined : onToggleAnnotation}
        disabled={ended}
      >
        Annotation: {annotationOn ? "On" : "Off"}
      </button>
      <button
        style={{
          ...topBarStyles.btnBase,
          ...topBarStyles.danger,
          opacity: ended ? 0.55 : 1,
          cursor: ended ? "not-allowed" : "pointer",
        }}
        onClick={ended ? undefined : onEndSession}
        disabled={ended}
      >
        End Session
      </button>
    </div>
  );
}

window.TopBar = TopBar;
