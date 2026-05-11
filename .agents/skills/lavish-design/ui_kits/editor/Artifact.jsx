/* global React */
const { useState, useCallback } = React;

// The faked landing-page artifact. Click any element to open the annotation card.
// We expose hover/click hooks so app.jsx can drive the annotation flow.
function Artifact({ annotationOn, selectedEl, hoveredEl, onHover, onClick }) {
  const artifactStyles = {
    frame: {
      background: "#ffffff",
      color: "#1a1a1a",
      flex: 1,
      minWidth: 0,
      minHeight: 0,
      overflow: "auto",
      cursor: annotationOn ? "default" : "auto",
      position: "relative",
    },
    page: {
      maxWidth: 720,
      margin: "0 auto",
      padding: "64px 48px 96px",
      fontFamily: "'EB Garamond', Georgia, serif",
    },
    eyebrow: {
      fontFamily: "'Geist', system-ui, sans-serif",
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: "0.14em",
      textTransform: "uppercase",
      color: "#7a6a3a",
      marginBottom: 28,
    },
    h1: {
      fontStyle: "italic",
      fontSize: 64,
      lineHeight: 1.05,
      letterSpacing: "-0.01em",
      fontWeight: 400,
      margin: "0 0 24px",
      color: "#1a1a1a",
    },
    lede: {
      fontSize: 22,
      lineHeight: 1.45,
      color: "#3a3a3a",
      margin: "0 0 36px",
      fontStyle: "italic",
    },
    cta: {
      fontFamily: "'Geist', system-ui, sans-serif",
      background: "#f4c95d",
      color: "#17130a",
      border: 0,
      borderRadius: 10,
      padding: "12px 18px",
      fontWeight: 700,
      fontSize: 14,
      cursor: "pointer",
    },
    p: {
      fontFamily: "'Geist', system-ui, sans-serif",
      fontSize: 15,
      lineHeight: 1.6,
      color: "#3a3a3a",
      margin: "36px 0 16px",
    },
    list: {
      fontFamily: "'Geist', system-ui, sans-serif",
      fontSize: 15,
      lineHeight: 1.7,
      color: "#3a3a3a",
      paddingLeft: 18,
      margin: 0,
    },
    footer: {
      fontFamily: "'Geist Mono', monospace",
      fontSize: 11,
      color: "#7a7a7a",
      marginTop: 64,
      borderTop: "1px solid #e5e5e5",
      paddingTop: 18,
      display: "flex",
      justifyContent: "space-between",
    },
  };

  const outlineFor = (id) => {
    if (!annotationOn) return null;
    const hot = (selectedEl && selectedEl.id === id) || (hoveredEl && hoveredEl.id === id);
    return hot ? { outline: "2px solid #f4c95d", outlineOffset: "2px" } : null;
  };

  // Each annotatable element wraps in an Anno
  const Anno = ({ id, tag, children, style }) => {
    const handleEnter = () => annotationOn && onHover({ id, tag, el: id });
    const handleLeave = () => annotationOn && onHover(null);
    const handleClick = (e) => {
      if (!annotationOn) return;
      e.preventDefault();
      e.stopPropagation();
      onClick({ id, tag, rect: e.currentTarget.getBoundingClientRect() });
    };
    const Tag = tag === "h1" ? "h1" : tag === "p" ? "p" : tag === "button" ? "button" : "div";
    return (
      <Tag
        style={{ ...style, ...outlineFor(id) }}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        onClick={handleClick}
      >
        {children}
      </Tag>
    );
  };

  return (
    <div style={artifactStyles.frame}>
      <div style={artifactStyles.page}>
        <Anno id="eyebrow" tag="div" style={artifactStyles.eyebrow}>
          v0.1 · the rich editor
        </Anno>
        <Anno id="h1" tag="h1" style={artifactStyles.h1}>
          For when a rich editor is not rich enough.
        </Anno>
        <Anno id="lede" tag="p" style={artifactStyles.lede}>
          Lavish opens an agent-generated HTML artifact in a local browser, lets you pinpoint elements, and ships your
          feedback back to the agent.
        </Anno>
        <Anno id="cta" tag="button" style={artifactStyles.cta}>
          Open an artifact →
        </Anno>

        <Anno id="p1" tag="p" style={artifactStyles.p}>
          Agents are good at producing rich HTML artifacts, but the human–agent collaboration loop on such artifacts is
          lacking and falls back to screenshots and long responses for "tell me what to change." That loses the thing
          HTML is best at: interactivity.
        </Anno>

        <Anno id="list" tag="div" style={artifactStyles.list}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>
              <strong>Browser-native review</strong> — relative JS/CSS/assets intact.
            </li>
            <li>
              <strong>Precise feedback</strong> — click elements, queue prompts.
            </li>
            <li>
              <strong>Agent-ergonomic interface</strong> — TOON output, long polling.
            </li>
          </ul>
        </Anno>

        <Anno id="footer" tag="div" style={artifactStyles.footer}>
          <span>lavish-axi · v0.1.0</span>
          <span>~/projects/landing/index.html</span>
        </Anno>
      </div>
    </div>
  );
}

window.Artifact = Artifact;
