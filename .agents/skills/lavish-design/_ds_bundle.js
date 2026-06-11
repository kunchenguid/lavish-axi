/* @ds-bundle: {"format":3,"namespace":"LavishDesignSystem_019e18","components":[],"sourceHashes":{"ui_kits/editor/AnnotationCard.jsx":"e4ef246fc207","ui_kits/editor/Artifact.jsx":"af55469055a1","ui_kits/editor/Bubbles.jsx":"685612381332","ui_kits/editor/ChatPanel.jsx":"b8fa493fc85d","ui_kits/editor/Pills.jsx":"036cd5cad301","ui_kits/editor/TopBar.jsx":"3538d0a0dad7","ui_kits/editor/app.jsx":"a70747413714","ui_kits/editor/design-canvas.jsx":"bd8746af6e58","ui_kits/editor/options-app-v2.jsx":"3161094fd814","ui_kits/editor/options-app-v3.jsx":"7712a504d33a","ui_kits/editor/options-app.jsx":"f98ec7d5f23c","ui_kits/editor/options-chrome-v2.jsx":"f940622d3bce","ui_kits/editor/options-chrome-v3.jsx":"cac73025b895","ui_kits/editor/options-chrome.jsx":"6a2ee48e04af"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.LavishDesignSystem_019e18 = window.LavishDesignSystem_019e18 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// ui_kits/editor/AnnotationCard.jsx
try { (() => {
/* global React */
function AnnotationCard({
  target,
  onCancel,
  onQueue
}) {
  const {
    useState,
    useEffect,
    useRef
  } = React;
  const [value, setValue] = useState("");
  const ref = useRef(null);
  const taRef = useRef(null);

  // Position: clamp 12px from any viewport edge, prefer below the target
  const [pos, setPos] = useState({
    left: 0,
    top: 0
  });
  useEffect(() => {
    if (!target || !ref.current) return;
    const card = ref.current;
    const w = card.offsetWidth,
      h = card.offsetHeight;
    const r = target.rect;
    const left = Math.min(Math.max(12, r.left), window.innerWidth - w - 12);
    const top = Math.min(Math.max(12, r.bottom + 8), window.innerHeight - h - 12);
    setPos({
      left,
      top
    });
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
      zIndex: 50
    },
    heading: {
      fontWeight: 700,
      marginBottom: 6
    },
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
      boxSizing: "border-box"
    },
    row: {
      display: "flex",
      gap: 8,
      justifyContent: "flex-end",
      marginTop: 8
    },
    btn: {
      border: 0,
      borderRadius: 9,
      padding: "8px 10px",
      fontWeight: 700,
      fontFamily: "inherit",
      cursor: "pointer",
      fontSize: 13
    },
    cancel: {
      background: "var(--steel-700)",
      color: "var(--cream-100)"
    },
    send: {
      background: "var(--brass-500)",
      color: "var(--brass-ink)"
    }
  };
  if (!target) return null;
  return /*#__PURE__*/React.createElement("div", {
    ref: ref,
    style: annoStyles.card,
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    style: annoStyles.heading
  }, "Annotate <", target.tag, ">"), /*#__PURE__*/React.createElement("textarea", {
    ref: taRef,
    value: value,
    onChange: e => setValue(e.target.value),
    placeholder: "Tell the agent what to change about this element\u2026",
    style: annoStyles.ta
  }), /*#__PURE__*/React.createElement("div", {
    style: annoStyles.row
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...annoStyles.btn,
      ...annoStyles.cancel
    },
    onClick: onCancel
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    style: {
      ...annoStyles.btn,
      ...annoStyles.send,
      opacity: value.trim() ? 1 : 0.55,
      cursor: value.trim() ? "pointer" : "not-allowed"
    },
    onClick: () => value.trim() && onQueue(value.trim())
  }, "Queue")));
}
window.AnnotationCard = AnnotationCard;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/editor/AnnotationCard.jsx", error: String((e && e.message) || e) }); }

// ui_kits/editor/Artifact.jsx
try { (() => {
/* global React */
const {
  useState,
  useCallback
} = React;

// The faked landing-page artifact. Click any element to open the annotation card.
// We expose hover/click hooks so app.jsx can drive the annotation flow.
function Artifact({
  annotationOn,
  selectedEl,
  hoveredEl,
  onHover,
  onClick
}) {
  const artifactStyles = {
    frame: {
      background: "#ffffff",
      color: "#1a1a1a",
      flex: 1,
      minWidth: 0,
      minHeight: 0,
      overflow: "auto",
      cursor: annotationOn ? "default" : "auto",
      position: "relative"
    },
    page: {
      maxWidth: 720,
      margin: "0 auto",
      padding: "64px 48px 96px",
      fontFamily: "'EB Garamond', Georgia, serif"
    },
    eyebrow: {
      fontFamily: "'Geist', system-ui, sans-serif",
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: "0.14em",
      textTransform: "uppercase",
      color: "#7a6a3a",
      marginBottom: 28
    },
    h1: {
      fontStyle: "italic",
      fontSize: 64,
      lineHeight: 1.05,
      letterSpacing: "-0.01em",
      fontWeight: 400,
      margin: "0 0 24px",
      color: "#1a1a1a"
    },
    lede: {
      fontSize: 22,
      lineHeight: 1.45,
      color: "#3a3a3a",
      margin: "0 0 36px",
      fontStyle: "italic"
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
      cursor: "pointer"
    },
    p: {
      fontFamily: "'Geist', system-ui, sans-serif",
      fontSize: 15,
      lineHeight: 1.6,
      color: "#3a3a3a",
      margin: "36px 0 16px"
    },
    list: {
      fontFamily: "'Geist', system-ui, sans-serif",
      fontSize: 15,
      lineHeight: 1.7,
      color: "#3a3a3a",
      paddingLeft: 18,
      margin: 0
    },
    footer: {
      fontFamily: "'Geist Mono', monospace",
      fontSize: 11,
      color: "#7a7a7a",
      marginTop: 64,
      borderTop: "1px solid #e5e5e5",
      paddingTop: 18,
      display: "flex",
      justifyContent: "space-between"
    }
  };
  const outlineFor = id => {
    if (!annotationOn) return null;
    const hot = selectedEl && selectedEl.id === id || hoveredEl && hoveredEl.id === id;
    return hot ? {
      outline: "2px solid #f4c95d",
      outlineOffset: "2px"
    } : null;
  };

  // Each annotatable element wraps in an Anno
  const Anno = ({
    id,
    tag,
    children,
    style
  }) => {
    const handleEnter = () => annotationOn && onHover({
      id,
      tag,
      el: id
    });
    const handleLeave = () => annotationOn && onHover(null);
    const handleClick = e => {
      if (!annotationOn) return;
      e.preventDefault();
      e.stopPropagation();
      onClick({
        id,
        tag,
        rect: e.currentTarget.getBoundingClientRect()
      });
    };
    const Tag = tag === "h1" ? "h1" : tag === "p" ? "p" : tag === "button" ? "button" : "div";
    return /*#__PURE__*/React.createElement(Tag, {
      style: {
        ...style,
        ...outlineFor(id)
      },
      onMouseEnter: handleEnter,
      onMouseLeave: handleLeave,
      onClick: handleClick
    }, children);
  };
  return /*#__PURE__*/React.createElement("div", {
    style: artifactStyles.frame
  }, /*#__PURE__*/React.createElement("div", {
    style: artifactStyles.page
  }, /*#__PURE__*/React.createElement(Anno, {
    id: "eyebrow",
    tag: "div",
    style: artifactStyles.eyebrow
  }, "v0.1 \xB7 the rich editor"), /*#__PURE__*/React.createElement(Anno, {
    id: "h1",
    tag: "h1",
    style: artifactStyles.h1
  }, "For when a rich editor is not rich enough."), /*#__PURE__*/React.createElement(Anno, {
    id: "lede",
    tag: "p",
    style: artifactStyles.lede
  }, "Lavish opens an agent-generated HTML artifact in a local browser, lets you pinpoint elements, and ships your feedback back to the agent."), /*#__PURE__*/React.createElement(Anno, {
    id: "cta",
    tag: "button",
    style: artifactStyles.cta
  }, "Open an artifact \u2192"), /*#__PURE__*/React.createElement(Anno, {
    id: "p1",
    tag: "p",
    style: artifactStyles.p
  }, "Agents are good at producing rich HTML artifacts, but the human\u2013agent collaboration loop on such artifacts is lacking and falls back to screenshots and long responses for \"tell me what to change.\" That loses the thing HTML is best at: interactivity."), /*#__PURE__*/React.createElement(Anno, {
    id: "list",
    tag: "div",
    style: artifactStyles.list
  }, /*#__PURE__*/React.createElement("ul", {
    style: {
      margin: 0,
      paddingLeft: 18
    }
  }, /*#__PURE__*/React.createElement("li", null, /*#__PURE__*/React.createElement("strong", null, "Browser-native review"), " \u2014 relative JS/CSS/assets intact."), /*#__PURE__*/React.createElement("li", null, /*#__PURE__*/React.createElement("strong", null, "Precise feedback"), " \u2014 click elements, queue prompts."), /*#__PURE__*/React.createElement("li", null, /*#__PURE__*/React.createElement("strong", null, "Agent-ergonomic interface"), " \u2014 TOON output, long polling."))), /*#__PURE__*/React.createElement(Anno, {
    id: "footer",
    tag: "div",
    style: artifactStyles.footer
  }, /*#__PURE__*/React.createElement("span", null, "lavish-axi \xB7 v0.1.0"), /*#__PURE__*/React.createElement("span", null, "~/projects/landing/index.html"))));
}
window.Artifact = Artifact;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/editor/Artifact.jsx", error: String((e && e.message) || e) }); }

// ui_kits/editor/Bubbles.jsx
try { (() => {
/* global React */
function UserBubble({
  children
}) {
  const userBubbleStyles = {
    bubble: {
      alignSelf: "flex-end",
      maxWidth: "85%",
      borderRadius: 14,
      padding: "10px 12px",
      background: "var(--bg-elevated)",
      border: "1px solid var(--border-strong)"
    },
    label: {
      display: "block",
      color: "var(--fg-faint)",
      marginBottom: 4,
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      textAlign: "right"
    }
  };
  return /*#__PURE__*/React.createElement("div", {
    style: userBubbleStyles.bubble
  }, /*#__PURE__*/React.createElement("small", {
    style: userBubbleStyles.label
  }, "You"), /*#__PURE__*/React.createElement("div", null, children));
}
function AgentBubble({
  children
}) {
  const agentBubbleStyles = {
    bubble: {
      alignSelf: "flex-start",
      maxWidth: "85%",
      borderRadius: 14,
      padding: "10px 12px",
      background: "transparent",
      border: "1px solid var(--border-subtle)"
    },
    label: {
      display: "block",
      color: "var(--fg-faint)",
      marginBottom: 4,
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: "0.08em",
      textTransform: "uppercase"
    }
  };
  return /*#__PURE__*/React.createElement("div", {
    style: agentBubbleStyles.bubble
  }, /*#__PURE__*/React.createElement("small", {
    style: agentBubbleStyles.label
  }, "Agent"), /*#__PURE__*/React.createElement("div", null, children));
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
      color: "var(--fg-muted)"
    },
    spinner: {
      width: 14,
      height: 14,
      borderRadius: 999,
      border: "2px solid var(--steel-600)",
      borderTopColor: "var(--accent)",
      animation: "lavish-spin 0.8s linear infinite",
      display: "inline-block"
    }
  };
  return /*#__PURE__*/React.createElement("div", {
    style: workingStyles.bubble
  }, /*#__PURE__*/React.createElement("span", {
    style: workingStyles.spinner
  }), /*#__PURE__*/React.createElement("span", null, "Working\u2026"));
}
window.UserBubble = UserBubble;
window.AgentBubble = AgentBubble;
window.WorkingBubble = WorkingBubble;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/editor/Bubbles.jsx", error: String((e && e.message) || e) }); }

// ui_kits/editor/ChatPanel.jsx
try { (() => {
/* global React, UserBubble, AgentBubble, WorkingBubble, Pill */
const {
  useEffect: useEffectChat,
  useRef: useRefChat,
  useState: useStateChat
} = React;
function SendIcon({
  size = 14
}) {
  return /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.7",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M22 2 11 13"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M22 2 15 22l-4-9-9-4Z"
  }));
}
function CaretIcon({
  size = 13
}) {
  return /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "m6 9 6 6 6-6"
  }));
}
function ExitIcon({
  size = 14
}) {
  return /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.7",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"
  }), /*#__PURE__*/React.createElement("polyline", {
    points: "16 17 21 12 16 7"
  }), /*#__PURE__*/React.createElement("line", {
    x1: "21",
    y1: "12",
    x2: "9",
    y2: "12"
  }));
}
function ChatPanel({
  chat,
  working,
  pills,
  draft,
  onDraftChange,
  onRemovePill,
  onSend,
  onSendAndEnd
}) {
  const logRef = useRefChat(null);
  const splitRef = useRefChat(null);
  const [splitOpen, setSplitOpen] = useStateChat(false);
  useEffectChat(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [chat, working]);
  useEffectChat(() => {
    if (!splitOpen) return;
    const onDown = e => {
      if (splitRef.current && !splitRef.current.contains(e.target)) setSplitOpen(false);
    };
    const onKey = e => {
      if (e.key === "Escape") setSplitOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [splitOpen]);
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
    panel: {
      borderLeft: "1px solid var(--steel-700)",
      background: "var(--ink-800)",
      display: "flex",
      flexDirection: "column",
      minWidth: 0,
      minHeight: 0,
      width: 360,
      flexShrink: 0
    },
    h2: {
      fontSize: 15,
      margin: "16px 16px 8px",
      fontWeight: 600
    },
    log: {
      flex: 1,
      minHeight: 0,
      overflow: "auto",
      padding: "0 16px 12px",
      display: "flex",
      flexDirection: "column",
      gap: 10
    },
    composer: {
      display: "grid",
      gap: 8,
      padding: "12px 16px",
      borderTop: "1px solid var(--steel-700)",
      minWidth: 0,
      flexShrink: 0,
      boxSizing: "border-box"
    },
    pills: {
      display: "flex",
      flexWrap: "wrap",
      gap: 6,
      minWidth: 0
    },
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
      boxSizing: "border-box"
    },
    actions: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      justifyContent: "flex-end",
      position: "relative"
    },
    hint: {
      marginRight: "auto",
      color: "var(--fg-faint)",
      fontSize: 11,
      lineHeight: 1.35
    },
    split: {
      display: "inline-flex",
      alignItems: "stretch"
    },
    sendMain: {
      border: 0,
      borderTopLeftRadius: 10,
      borderBottomLeftRadius: 10,
      borderTopRightRadius: 0,
      borderBottomRightRadius: 0,
      padding: "9px 14px",
      background: "var(--brass-500)",
      color: "var(--brass-ink)",
      fontFamily: "inherit",
      fontWeight: 700,
      cursor: canSend ? "pointer" : "not-allowed",
      opacity: canSend ? 1 : 0.55,
      fontSize: 13,
      whiteSpace: "nowrap"
    },
    sendCaret: {
      border: 0,
      borderTopRightRadius: 10,
      borderBottomRightRadius: 10,
      borderTopLeftRadius: 0,
      borderBottomLeftRadius: 0,
      padding: "9px 9px",
      background: "var(--brass-500)",
      color: "var(--brass-ink)",
      cursor: working ? "not-allowed" : "pointer",
      opacity: working ? 0.55 : 1,
      borderLeft: "1px solid rgba(23,19,10,.22)",
      display: "grid",
      placeItems: "center"
    },
    menu: {
      position: "absolute",
      right: 0,
      bottom: 44,
      width: 208,
      background: "var(--ink-700)",
      border: "1px solid var(--steel-600)",
      borderRadius: 11,
      boxShadow: "var(--shadow-tooltip)",
      padding: 6,
      zIndex: 40
    }
  };
  const SplitMenuItem = ({
    icon,
    label,
    danger,
    disabled,
    onClick
  }) => {
    const [hover, setHover] = useStateChat(false);
    return /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: disabled ? undefined : onClick,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      style: {
        display: "flex",
        alignItems: "center",
        gap: 9,
        width: "100%",
        textAlign: "left",
        padding: "8px 9px",
        borderRadius: 8,
        fontSize: 13,
        fontFamily: "inherit",
        border: 0,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        background: hover && !disabled ? danger ? "rgba(240,100,100,.10)" : "var(--steel-700)" : "transparent",
        color: danger ? "var(--rust-500)" : "var(--cream-100)"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        display: "flex",
        opacity: danger ? 1 : 0.85
      }
    }, icon), label);
  };
  return /*#__PURE__*/React.createElement("aside", {
    style: s.panel
  }, /*#__PURE__*/React.createElement("h2", {
    style: s.h2
  }, "Conversation"), /*#__PURE__*/React.createElement("div", {
    ref: logRef,
    style: s.log
  }, chat.map((m, i) => m.role === "user" ? /*#__PURE__*/React.createElement(UserBubble, {
    key: i
  }, m.text) : /*#__PURE__*/React.createElement(AgentBubble, {
    key: i
  }, m.text)), working && /*#__PURE__*/React.createElement(WorkingBubble, null)), /*#__PURE__*/React.createElement("div", {
    style: s.composer
  }, pills.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: s.pills
  }, pills.map((p, i) => /*#__PURE__*/React.createElement(Pill, {
    key: i,
    prompt: p,
    onRemove: () => onRemovePill(i)
  }))), /*#__PURE__*/React.createElement("textarea", {
    placeholder: "Write a message for the agent\u2026",
    value: draft,
    onChange: e => {
      setHint(false);
      onDraftChange(e.target.value);
    },
    style: s.ta
  }), /*#__PURE__*/React.createElement("div", {
    style: s.actions,
    ref: splitRef
  }, hint && /*#__PURE__*/React.createElement("span", {
    style: s.hint
  }, "Write a message or annotate an element first."), /*#__PURE__*/React.createElement("div", {
    style: s.split
  }, /*#__PURE__*/React.createElement("button", {
    style: s.sendMain,
    disabled: !canSend,
    onClick: trySend
  }, "Send to Agent"), /*#__PURE__*/React.createElement("button", {
    style: s.sendCaret,
    title: "Send options",
    disabled: working,
    onClick: working ? undefined : () => setSplitOpen(v => !v)
  }, /*#__PURE__*/React.createElement(CaretIcon, null))), splitOpen && /*#__PURE__*/React.createElement("div", {
    style: s.menu
  }, /*#__PURE__*/React.createElement(SplitMenuItem, {
    icon: /*#__PURE__*/React.createElement(SendIcon, null),
    label: "Send to Agent",
    disabled: !canSend,
    onClick: () => {
      setSplitOpen(false);
      trySend();
    }
  }), /*#__PURE__*/React.createElement(SplitMenuItem, {
    icon: /*#__PURE__*/React.createElement(ExitIcon, null),
    label: "Send & end session",
    danger: true,
    onClick: () => {
      setSplitOpen(false);
      onSendAndEnd();
    }
  })))));
}
window.ChatPanel = ChatPanel;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/editor/ChatPanel.jsx", error: String((e && e.message) || e) }); }

// ui_kits/editor/Pills.jsx
try { (() => {
/* global React */
function Pill({
  prompt,
  onRemove
}) {
  const pillStyles = {
    wrap: {
      position: "relative",
      maxWidth: "100%"
    },
    pill: {
      display: "flex",
      alignItems: "center",
      gap: 6,
      maxWidth: "100%",
      border: "1px solid var(--steel-500)",
      borderRadius: 999,
      background: "var(--ink-600)",
      color: "var(--steel-100)",
      padding: "5px 7px 5px 11px",
      fontSize: 12,
      fontWeight: 700
    },
    preview: {
      display: "block",
      maxWidth: 220,
      overflow: "hidden",
      whiteSpace: "nowrap",
      textOverflow: "ellipsis"
    },
    close: {
      width: 18,
      height: 18,
      border: 0,
      borderRadius: 999,
      padding: 0,
      background: "var(--steel-600)",
      color: "var(--steel-100)",
      lineHeight: "18px",
      fontSize: 14,
      cursor: "pointer"
    }
  };
  return /*#__PURE__*/React.createElement("div", {
    style: pillStyles.wrap
  }, /*#__PURE__*/React.createElement("div", {
    style: pillStyles.pill
  }, /*#__PURE__*/React.createElement("span", {
    style: pillStyles.preview,
    title: prompt
  }, prompt), /*#__PURE__*/React.createElement("button", {
    style: pillStyles.close,
    "aria-label": "Remove queued prompt",
    onClick: onRemove
  }, "\xD7")));
}
window.Pill = Pill;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/editor/Pills.jsx", error: String((e && e.message) || e) }); }

// ui_kits/editor/TopBar.jsx
try { (() => {
/* global React */
const {
  useState: useStateTB,
  useEffect: useEffectTB,
  useRef: useRefTB
} = React;
function TBIcon({
  d,
  size = 16
}) {
  return /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.7",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, d);
}
const tbMore = /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
  cx: "12",
  cy: "5",
  r: "1.4"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "12",
  cy: "12",
  r: "1.4"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "12",
  cy: "19",
  r: "1.4"
}));
const tbFile = /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
  d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
}), /*#__PURE__*/React.createElement("polyline", {
  points: "14 2 14 8 20 8"
}));
const tbRefresh = /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
  d: "M3 12a9 9 0 0 1 15-6.7L21 8"
}), /*#__PURE__*/React.createElement("path", {
  d: "M21 3v5h-5"
}), /*#__PURE__*/React.createElement("path", {
  d: "M21 12a9 9 0 0 1-15 6.7L3 16"
}), /*#__PURE__*/React.createElement("path", {
  d: "M3 21v-5h5"
}));
const tbCamera = /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
  d: "M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "12",
  cy: "13",
  r: "3"
}));
const tbExit = /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
  d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"
}), /*#__PURE__*/React.createElement("polyline", {
  points: "16 17 21 12 16 7"
}), /*#__PURE__*/React.createElement("line", {
  x1: "21",
  y1: "12",
  x2: "9",
  y2: "12"
}));
const tbCopy = /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
  x: "9",
  y: "9",
  width: "13",
  height: "13",
  rx: "2",
  ry: "2"
}), /*#__PURE__*/React.createElement("path", {
  d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
}));
const tbCheck = /*#__PURE__*/React.createElement("polyline", {
  points: "20 6 9 17 4 12"
});

// Annotate on/off switch — replaces the old labeled button.
function AnnotateSwitch({
  on,
  disabled,
  onToggle
}) {
  const s = {
    wrap: {
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
      color: "var(--steel-100)",
      fontSize: 13,
      whiteSpace: "nowrap",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.55 : 1,
      userSelect: "none",
      background: "none",
      border: 0,
      fontFamily: "inherit",
      padding: 0
    },
    track: {
      width: 34,
      height: 20,
      borderRadius: 999,
      background: on ? "var(--brass-500)" : "var(--steel-600)",
      position: "relative",
      flexShrink: 0,
      transition: "background 150ms var(--ease)"
    },
    knob: {
      position: "absolute",
      top: 2,
      left: on ? 16 : 2,
      width: 16,
      height: 16,
      borderRadius: 999,
      background: on ? "var(--brass-ink)" : "var(--steel-300)",
      transition: "left 150ms var(--ease)"
    }
  };
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    style: s.wrap,
    onClick: disabled ? undefined : onToggle,
    "aria-pressed": on
  }, /*#__PURE__*/React.createElement("span", {
    style: s.track
  }, /*#__PURE__*/React.createElement("span", {
    style: s.knob
  })), /*#__PURE__*/React.createElement("span", null, "Annotate"));
}
function MenuItem({
  icon,
  label,
  danger,
  onClick
}) {
  const [hover, setHover] = useStateTB(false);
  const base = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    textAlign: "left",
    padding: "9px 10px",
    borderRadius: 8,
    fontSize: 13,
    fontFamily: "inherit",
    border: 0,
    cursor: "pointer",
    background: hover ? danger ? "rgba(240,100,100,.10)" : "var(--steel-700)" : "transparent",
    color: danger ? "var(--rust-500)" : "var(--cream-100)"
  };
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    style: base,
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false)
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "flex",
      opacity: danger ? 1 : 0.8
    }
  }, /*#__PURE__*/React.createElement(TBIcon, {
    d: icon,
    size: 15
  })), label);
}
function TopBar({
  filePath,
  annotationOn,
  onToggleAnnotation,
  onEndSession,
  onReload,
  onSnapshot,
  ended
}) {
  const [menuOpen, setMenuOpen] = useStateTB(false);
  const [copied, setCopied] = useStateTB(false);
  const menuRef = useRefTB(null);
  useEffectTB(() => {
    if (!menuOpen) return;
    const onDown = e => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    const onKey = e => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
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
    } catch (e) {/* best-effort */}
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  const shortName = (filePath || "").split("/").slice(-2).join("/");
  const s = {
    bar: {
      height: 56,
      display: "flex",
      alignItems: "center",
      gap: 14,
      padding: "0 16px",
      background: "var(--ink-700)",
      borderBottom: "1px solid var(--steel-700)",
      boxSizing: "border-box",
      flexShrink: 0
    },
    brand: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      whiteSpace: "nowrap",
      flexShrink: 0
    },
    brandMark: {
      fontFamily: "var(--font-serif)",
      fontStyle: "italic",
      fontSize: 22,
      lineHeight: 1,
      color: "var(--cream-100)"
    },
    brandSupport: {
      fontFamily: "var(--font-sans)",
      fontSize: 10,
      fontWeight: 600,
      letterSpacing: "0.18em",
      textTransform: "uppercase",
      color: "var(--steel-200)",
      position: "relative",
      top: 1
    },
    spacer: {
      flex: 1
    },
    moreWrap: {
      position: "relative",
      flexShrink: 0
    },
    moreBtn: {
      width: 34,
      height: 34,
      display: "grid",
      placeItems: "center",
      border: "1px solid",
      borderColor: menuOpen ? "var(--steel-500)" : "var(--steel-700)",
      background: menuOpen ? "var(--steel-700)" : "transparent",
      color: menuOpen ? "var(--cream-100)" : "var(--steel-200)",
      borderRadius: 9,
      cursor: ended ? "not-allowed" : "pointer",
      padding: 0,
      opacity: ended ? 0.55 : 1
    },
    menu: {
      position: "absolute",
      right: 0,
      top: 42,
      width: 248,
      background: "var(--ink-700)",
      border: "1px solid var(--steel-600)",
      borderRadius: 12,
      boxShadow: "var(--shadow-tooltip)",
      padding: 6,
      zIndex: 70
    },
    menuHead: {
      padding: "7px 10px 9px"
    },
    menuLabel: {
      fontSize: 9,
      fontWeight: 700,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      color: "var(--fg-faint)",
      marginBottom: 5
    },
    menuFileBtn: {
      display: "flex",
      alignItems: "center",
      gap: 7,
      width: "100%",
      textAlign: "left",
      border: 0,
      background: "transparent",
      padding: "3px 4px",
      margin: "0 -4px",
      borderRadius: 7,
      cursor: "pointer",
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      color: "var(--steel-100)"
    },
    menuFileText: {
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      flex: 1
    },
    copyHint: {
      fontFamily: "var(--font-sans)",
      fontSize: 10,
      fontWeight: 600,
      color: copied ? "var(--brass-400)" : "var(--fg-faint)",
      flexShrink: 0,
      display: "flex",
      alignItems: "center",
      gap: 4
    },
    rule: {
      height: 1,
      background: "var(--steel-600)",
      margin: "4px 0"
    }
  };
  return /*#__PURE__*/React.createElement("div", {
    style: s.bar
  }, /*#__PURE__*/React.createElement("div", {
    style: s.brand
  }, /*#__PURE__*/React.createElement("span", {
    style: s.brandMark
  }, "Lavish"), /*#__PURE__*/React.createElement("span", {
    style: s.brandSupport
  }, "Editor")), /*#__PURE__*/React.createElement("div", {
    style: s.spacer
  }), /*#__PURE__*/React.createElement(AnnotateSwitch, {
    on: annotationOn,
    disabled: ended,
    onToggle: onToggleAnnotation
  }), /*#__PURE__*/React.createElement("div", {
    style: s.moreWrap,
    ref: menuRef
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "More",
    style: s.moreBtn,
    onClick: ended ? undefined : () => setMenuOpen(v => !v),
    disabled: ended
  }, /*#__PURE__*/React.createElement(TBIcon, {
    d: tbMore
  })), menuOpen && /*#__PURE__*/React.createElement("div", {
    style: s.menu
  }, /*#__PURE__*/React.createElement("div", {
    style: s.menuHead
  }, /*#__PURE__*/React.createElement("div", {
    style: s.menuLabel
  }, "Editing"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    style: s.menuFileBtn,
    title: `Copy path · ${filePath}`,
    onClick: copyPath,
    onMouseEnter: e => {
      e.currentTarget.style.background = "var(--steel-700)";
    },
    onMouseLeave: e => {
      e.currentTarget.style.background = "transparent";
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      opacity: 0.7,
      display: "flex"
    }
  }, /*#__PURE__*/React.createElement(TBIcon, {
    d: tbFile,
    size: 13
  })), /*#__PURE__*/React.createElement("span", {
    style: s.menuFileText
  }, shortName), /*#__PURE__*/React.createElement("span", {
    style: s.copyHint
  }, /*#__PURE__*/React.createElement(TBIcon, {
    d: copied ? tbCheck : tbCopy,
    size: 12
  }), copied ? "Copied" : "Copy"))), /*#__PURE__*/React.createElement("div", {
    style: s.rule
  }), /*#__PURE__*/React.createElement(MenuItem, {
    icon: tbRefresh,
    label: "Reload artifact",
    onClick: () => {
      setMenuOpen(false);
      onReload && onReload();
    }
  }), /*#__PURE__*/React.createElement(MenuItem, {
    icon: tbCamera,
    label: "Copy DOM snapshot",
    onClick: () => {
      setMenuOpen(false);
      onSnapshot && onSnapshot();
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: s.rule
  }), /*#__PURE__*/React.createElement(MenuItem, {
    icon: tbExit,
    label: "End session",
    danger: true,
    onClick: () => {
      setMenuOpen(false);
      onEndSession && onEndSession();
    }
  }))));
}
window.TopBar = TopBar;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/editor/TopBar.jsx", error: String((e && e.message) || e) }); }

// ui_kits/editor/app.jsx
try { (() => {
/* global React, ReactDOM, TopBar, Artifact, AnnotationCard, ChatPanel */
const {
  useState,
  useEffect,
  useCallback
} = React;
const CANNED_REPLIES = ["Done. I tightened the heading and softened the lede — take a look.", "Updated. The CTA is now italic Garamond on brass; let me know if you'd rather a sans label.", "Got it. Moved the footer below the bullets and dropped the v0.1 chip.", "Adjusted. The eyebrow color is now sage to match the agent palette."];
function App() {
  const [annotationOn, setAnnotationOn] = useState(true);
  const [hovered, setHovered] = useState(null);
  const [annotating, setAnnotating] = useState(null); // { id, tag, rect }
  const [pills, setPills] = useState(["Tighten the heading — fewer words, more confidence"]);
  const [draft, setDraft] = useState("");
  const [chat, setChat] = useState([{
    role: "agent",
    text: "Opened landing/index.html. Annotation is on — click any element to start."
  }]);
  const [working, setWorking] = useState(false);
  const [ended, setEnded] = useState(false);
  const [replyIdx, setReplyIdx] = useState(0);
  const [artifactKey, setArtifactKey] = useState(0);
  const handleArtifactClick = useCallback(target => {
    if (!annotationOn) return;
    setAnnotating(target);
  }, [annotationOn]);
  const closeCard = () => setAnnotating(null);
  const queuePrompt = text => {
    setPills(p => [...p, text]);
    setAnnotating(null);
  };
  const removePill = i => setPills(p => p.filter((_, idx) => idx !== i));
  const sendToAgent = () => {
    if (working) return;
    const messages = [...pills];
    if (draft.trim()) messages.push(draft.trim());
    if (messages.length === 0) return;
    setChat(c => [...c, ...messages.map(t => ({
      role: "user",
      text: t
    }))]);
    setPills([]);
    setDraft("");
    setWorking(true);
    setTimeout(() => {
      const reply = CANNED_REPLIES[replyIdx % CANNED_REPLIES.length];
      setReplyIdx(i => i + 1);
      setChat(c => [...c, {
        role: "agent",
        text: reply
      }]);
      setWorking(false);
    }, 1400);
  };

  // Send the queued/typed messages, then end — no waiting for a reply.
  const sendAndEnd = () => {
    if (working) return;
    const messages = [...pills];
    if (draft.trim()) messages.push(draft.trim());
    if (messages.length) {
      setChat(c => [...c, ...messages.map(t => ({
        role: "user",
        text: t
      }))]);
      setPills([]);
      setDraft("");
    }
    endSession();
  };
  const endSession = () => {
    setEnded(true);
    setAnnotationOn(false);
    setAnnotating(null);
    setChat(c => [...c, {
      role: "agent",
      text: "Session ended. Return to your agent to continue."
    }]);
  };
  const reloadArtifact = () => {
    setArtifactKey(k => k + 1);
  };
  const copySnapshot = () => {
    setChat(c => [...c, {
      role: "agent",
      text: "Copied a DOM snapshot of the artifact to your clipboard."
    }]);
  };

  // Click outside annotation card closes it
  useEffect(() => {
    if (!annotating) return;
    const onKey = e => {
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
      overflow: "hidden"
    },
    layout: {
      flex: 1,
      minHeight: 0,
      display: "flex"
    },
    endedOverlay: {
      position: "absolute",
      inset: "56px 0 0 0",
      background: "rgba(15, 17, 21, 0.86)",
      display: ended ? "flex" : "none",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 60,
      pointerEvents: "none"
    },
    endedCard: {
      background: "var(--ink-800)",
      border: "1px solid var(--steel-600)",
      borderRadius: 14,
      padding: "20px 24px",
      maxWidth: 360,
      textAlign: "center",
      pointerEvents: "auto"
    },
    endedQuote: {
      fontFamily: "var(--font-serif)",
      fontStyle: "italic",
      fontSize: 22,
      lineHeight: 1.3,
      color: "var(--cream-100)",
      marginBottom: 8
    },
    endedSub: {
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      color: "var(--steel-300)"
    }
  };
  return /*#__PURE__*/React.createElement("div", {
    style: appStyles.root
  }, /*#__PURE__*/React.createElement(TopBar, {
    filePath: "~/projects/landing/index.html",
    annotationOn: annotationOn,
    onToggleAnnotation: () => setAnnotationOn(v => !v),
    onEndSession: endSession,
    onReload: reloadArtifact,
    onSnapshot: copySnapshot,
    ended: ended
  }), /*#__PURE__*/React.createElement("div", {
    style: appStyles.layout
  }, /*#__PURE__*/React.createElement(Artifact, {
    key: artifactKey,
    annotationOn: annotationOn && !ended,
    hoveredEl: hovered,
    selectedEl: annotating,
    onHover: setHovered,
    onClick: handleArtifactClick
  }), /*#__PURE__*/React.createElement(ChatPanel, {
    chat: chat,
    working: working,
    pills: pills,
    draft: draft,
    onDraftChange: setDraft,
    onRemovePill: removePill,
    onSend: sendToAgent,
    onSendAndEnd: sendAndEnd
  })), annotating && /*#__PURE__*/React.createElement(AnnotationCard, {
    target: annotating,
    onCancel: closeCard,
    onQueue: queuePrompt
  }), /*#__PURE__*/React.createElement("div", {
    style: appStyles.endedOverlay
  }, /*#__PURE__*/React.createElement("div", {
    style: appStyles.endedCard
  }, /*#__PURE__*/React.createElement("div", {
    style: appStyles.endedQuote
  }, "Session ended.", /*#__PURE__*/React.createElement("br", null), "Return to your agent to continue."), /*#__PURE__*/React.createElement("div", {
    style: appStyles.endedSub
  }, "~/projects/landing/index.html"))));
}
window.App = App;
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/editor/app.jsx", error: String((e && e.message) || e) }); }

// ui_kits/editor/design-canvas.jsx
try { (() => {
// @ds-adherence-ignore -- omelette starter scaffold (raw elements/hex/px by design)

/* BEGIN USAGE */
// DesignCanvas.jsx — Figma-ish design canvas wrapper
// Warm gray grid bg + Sections + Artboards + PostIt notes.
// Exports (to window): DesignCanvas, DCSection, DCArtboard, DCPostIt.
// Artboards are reorderable (grip-drag), deletable, labels/titles are
// inline-editable, and any artboard can be opened in a fullscreen focus
// overlay (←/→/Esc). State persists to a .design-canvas.state.json sidecar
// via the host bridge. No assets, no deps.
//
// Usage:
//   <DesignCanvas>
//     <DCSection id="onboarding" title="Onboarding" subtitle="First-run variants">
//       <DCArtboard id="a" label="A · Dusk" width={260} height={480}>…</DCArtboard>
//       <DCArtboard id="b" label="B · Minimal" width={260} height={480}>…</DCArtboard>
//     </DCSection>
//   </DesignCanvas>
//
// Artboards are static design frames, not scroll regions — never use
// height: 100% + overflow: auto/scroll on inner elements; size each artboard
// to fit its content (explicit pixel height, or let it grow).
/* END USAGE */

const DC = {
  bg: '#f0eee9',
  grid: 'rgba(0,0,0,0.06)',
  label: 'rgba(60,50,40,0.7)',
  title: 'rgba(40,30,20,0.85)',
  subtitle: 'rgba(60,50,40,0.6)',
  postitBg: '#fef4a8',
  postitText: '#5a4a2a',
  font: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
};

// One-time CSS injection (classes are dc-prefixed so they don't collide with
// the hosted design's own styles).
if (typeof document !== 'undefined' && !document.getElementById('dc-styles')) {
  const s = document.createElement('style');
  s.id = 'dc-styles';
  s.textContent = ['.dc-editable{cursor:text;outline:none;white-space:nowrap;border-radius:3px;padding:0 2px;margin:0 -2px}', '.dc-editable:focus{background:#fff;box-shadow:0 0 0 1.5px #c96442}', '[data-dc-slot]{transition:transform .18s cubic-bezier(.2,.7,.3,1)}', '[data-dc-slot].dc-dragging{transition:none;z-index:10;pointer-events:none}', '[data-dc-slot].dc-dragging .dc-card{box-shadow:0 12px 40px rgba(0,0,0,.25),0 0 0 2px #c96442;transform:scale(1.02)}',
  // isolation:isolate contains artboard content's z-indexes so a
  // z-indexed child (sticky navbar etc.) can't paint over .dc-header or
  // the .dc-menu popover that drops into the top of the card.
  '.dc-card{isolation:isolate;transition:box-shadow .15s,transform .15s}', '.dc-card *{scrollbar-width:none}', '.dc-card *::-webkit-scrollbar{display:none}',
  // Per-artboard header: grip + label on the left, delete/expand on the
  // right. Single flex row; when the artboard's on-screen width is too
  // narrow for both the label yields (ellipsis, then hidden entirely below
  // ~4ch via the container query) and the buttons stay on the row.
  '.dc-header{position:absolute;bottom:100%;left:-4px;margin-bottom:calc(4px * var(--dc-inv-zoom,1));z-index:2;', '  display:flex;align-items:center;container-type:inline-size}', '.dc-labelrow{display:flex;align-items:center;gap:4px;height:24px;flex:1 1 auto;min-width:0}', '.dc-grip{flex:0 0 auto;cursor:grab;display:flex;align-items:center;padding:5px 4px;border-radius:4px;transition:background .12s,opacity .12s}', '.dc-grip:hover{background:rgba(0,0,0,.08)}', '.dc-grip:active{cursor:grabbing}', '.dc-labeltext{flex:1 1 auto;min-width:0;cursor:pointer;border-radius:4px;padding:3px 6px;', '  display:flex;align-items:center;transition:background .12s;overflow:hidden}',
  // Below ~4ch of label room: hide the label entirely, and drop the grip to
  // hover-only (same reveal rule as .dc-btns) so a narrow header is clean
  // until the card is moused.
  '@container (max-width: 110px){', '  .dc-labeltext{display:none}', '  .dc-grip{opacity:0}', '  [data-dc-slot]:hover .dc-grip{opacity:1}', '}', '.dc-labeltext:hover{background:rgba(0,0,0,.05)}', '.dc-labeltext .dc-editable{overflow:hidden;text-overflow:ellipsis;max-width:100%}', '.dc-labeltext .dc-editable:focus{overflow:visible;text-overflow:clip}', '.dc-btns{flex:0 0 auto;margin-left:auto;display:flex;gap:2px;opacity:0;transition:opacity .12s}', '[data-dc-slot]:hover .dc-btns,.dc-btns:has(.dc-menu){opacity:1}', '.dc-expand,.dc-kebab{width:22px;height:22px;border-radius:5px;border:none;cursor:pointer;padding:0;', '  background:transparent;color:rgba(60,50,40,.7);display:flex;align-items:center;justify-content:center;', '  font:inherit;transition:background .12s,color .12s}', '.dc-expand:hover,.dc-kebab:hover{background:rgba(0,0,0,.06);color:#2a251f}',
  // Slot hosting an open menu floats above later siblings (which otherwise
  // paint on top — same z-index:auto, later DOM order) so the popup isn't
  // clipped by the next card.
  '[data-dc-slot]:has(.dc-menu){z-index:10}', '.dc-menu{position:absolute;top:100%;right:0;margin-top:4px;background:#fff;border-radius:8px;', '  box-shadow:0 8px 28px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.05);padding:4px;min-width:160px;z-index:10}', '.dc-menu button{display:block;width:100%;padding:7px 10px;border:0;background:transparent;', '  border-radius:5px;font-family:inherit;font-size:13px;font-weight:500;line-height:1.2;', '  color:#29261b;cursor:pointer;text-align:left;transition:background .12s;white-space:nowrap}', '.dc-menu button:hover{background:rgba(0,0,0,.05)}', '.dc-menu hr{border:0;border-top:1px solid rgba(0,0,0,.08);margin:4px 2px}', '.dc-menu .dc-danger{color:#c96442}', '.dc-menu .dc-danger:hover{background:rgba(201,100,66,.1)}',
  // Chrome (titles / labels / buttons) counter-scales against the viewport
  // zoom so it stays a constant on-screen size. --dc-inv-zoom is set by
  // DCViewport on every transform update and inherits to all descendants —
  // any overlay inside the world (e.g. a TweaksPanel on an artboard) can use
  // it the same way.
  //
  // The header uses transform:scale (out-of-flow, so layout impact doesn't
  // matter) with its world-space width set to card-width / inv-zoom so that
  // after counter-scaling its on-screen width exactly matches the card's —
  // that's what lets the container query + text-overflow behave against the
  // card's visible edge at every zoom level.
  //
  // The section head uses CSS zoom instead of transform so its layout box
  // grows with the counter-scale, pushing the card row down — otherwise the
  // constant-screen-size title would overflow into the (shrinking) world-
  // space gap and overlap the artboard headers at low zoom.
  '.dc-header{width:calc((100% + 4px) / var(--dc-inv-zoom,1));', '  transform:scale(var(--dc-inv-zoom,1));transform-origin:bottom left}', '.dc-sectionhead{zoom:var(--dc-inv-zoom,1)}'].join('\n');
  document.head.appendChild(s);
}
const DCCtx = React.createContext(null);

// Recursively unwrap React.Fragment so <>…</> grouping doesn't hide
// DCSection/DCArtboard children from the type-based walks below.
function dcFlatten(children) {
  const out = [];
  React.Children.forEach(children, c => {
    if (c && c.type === React.Fragment) out.push(...dcFlatten(c.props.children));else out.push(c);
  });
  return out;
}

// ─────────────────────────────────────────────────────────────
// DesignCanvas — stateful wrapper around the pan/zoom viewport.
// Owns runtime state (per-section order, renamed titles/labels, hidden
// artboards, focused artboard). Order/titles/labels/hidden persist to a
// .design-canvas.state.json
// sidecar next to the HTML. Reads go via plain fetch() so the saved
// arrangement is visible anywhere the HTML + sidecar are served together
// (omelette preview, direct link, downloaded zip). Writes go through the
// host's window.omelette bridge — editing requires the omelette runtime.
// Focus is ephemeral.
// ─────────────────────────────────────────────────────────────
const DC_STATE_FILE = '.design-canvas.state.json';
function DesignCanvas({
  children,
  minScale,
  maxScale,
  style
}) {
  const [state, setState] = React.useState({
    sections: {},
    focus: null
  });
  // Hold rendering until the sidecar read settles so the saved order/titles
  // appear on first paint (no source-order flash). didRead gates writes until
  // the read settles so the empty initial state can't clobber a slow read;
  // skipNextWrite suppresses the one echo-write that would otherwise follow
  // hydration.
  const [ready, setReady] = React.useState(false);
  const didRead = React.useRef(false);
  const skipNextWrite = React.useRef(false);
  React.useEffect(() => {
    let off = false;
    fetch('./' + DC_STATE_FILE).then(r => r.ok ? r.json() : null).then(saved => {
      if (off || !saved || !saved.sections) return;
      skipNextWrite.current = true;
      setState(s => ({
        ...s,
        sections: saved.sections
      }));
    }).catch(() => {}).finally(() => {
      didRead.current = true;
      if (!off) setReady(true);
    });
    const t = setTimeout(() => {
      if (!off) setReady(true);
    }, 150);
    return () => {
      off = true;
      clearTimeout(t);
    };
  }, []);
  React.useEffect(() => {
    if (!didRead.current) return;
    if (skipNextWrite.current) {
      skipNextWrite.current = false;
      return;
    }
    const t = setTimeout(() => {
      window.omelette?.writeFile(DC_STATE_FILE, JSON.stringify({
        sections: state.sections
      })).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [state.sections]);

  // Build registries synchronously from children so FocusOverlay can read
  // them in the same render. Fragments are flattened; wrapping in other
  // elements still opts out of focus/reorder.
  const registry = {}; // slotId -> { sectionId, artboard }
  const sectionMeta = {}; // sectionId -> { title, subtitle, slotIds[] }
  const sectionOrder = [];
  dcFlatten(children).forEach(sec => {
    if (!sec || sec.type !== DCSection) return;
    const sid = sec.props.id ?? sec.props.title;
    if (!sid) return;
    sectionOrder.push(sid);
    const persisted = state.sections[sid] || {};
    const abs = [];
    dcFlatten(sec.props.children).forEach(ab => {
      if (!ab || ab.type !== DCArtboard) return;
      const aid = ab.props.id ?? ab.props.label;
      if (aid) abs.push([aid, ab]);
    });
    // hidden is scoped to one source revision — when the agent regenerates
    // (artboard-ID set changes), prior deletes don't apply to new content.
    const srcKey = abs.map(([k]) => k).join('\x1f');
    const hidden = persisted.srcKey === srcKey ? persisted.hidden || [] : [];
    const srcIds = [];
    abs.forEach(([aid, ab]) => {
      if (hidden.includes(aid)) return;
      registry[`${sid}/${aid}`] = {
        sectionId: sid,
        artboard: ab
      };
      srcIds.push(aid);
    });
    const kept = (persisted.order || []).filter(k => srcIds.includes(k));
    sectionMeta[sid] = {
      title: persisted.title ?? sec.props.title,
      subtitle: sec.props.subtitle,
      slotIds: [...kept, ...srcIds.filter(k => !kept.includes(k))]
    };
  });
  const api = React.useMemo(() => ({
    state,
    section: id => state.sections[id] || {},
    patchSection: (id, p) => setState(s => ({
      ...s,
      sections: {
        ...s.sections,
        [id]: {
          ...s.sections[id],
          ...(typeof p === 'function' ? p(s.sections[id] || {}) : p)
        }
      }
    })),
    setFocus: slotId => setState(s => ({
      ...s,
      focus: slotId
    }))
  }), [state]);

  // Esc exits focus; any outside pointerdown commits an in-progress rename.
  React.useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape') api.setFocus(null);
    };
    const onPd = e => {
      const ae = document.activeElement;
      if (ae && ae.isContentEditable && !ae.contains(e.target)) ae.blur();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPd, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPd, true);
    };
  }, [api]);
  return /*#__PURE__*/React.createElement(DCCtx.Provider, {
    value: api
  }, /*#__PURE__*/React.createElement(DCViewport, {
    minScale: minScale,
    maxScale: maxScale,
    style: style
  }, ready && children), state.focus && registry[state.focus] && /*#__PURE__*/React.createElement(DCFocusOverlay, {
    entry: registry[state.focus],
    sectionMeta: sectionMeta,
    sectionOrder: sectionOrder
  }));
}

// ─────────────────────────────────────────────────────────────
// DCViewport — transform-based pan/zoom (internal)
//
// Input mapping (Figma-style):
//   • trackpad pinch  → zoom   (ctrlKey wheel; Safari gesture* events)
//   • trackpad scroll → pan    (two-finger)
//   • mouse wheel     → zoom   (notched; distinguished from trackpad scroll)
//   • middle-drag / primary-drag-on-bg → pan
//
// Transform state lives in a ref and is written straight to the DOM
// (translate3d + will-change) so wheel ticks don't go through React —
// keeps pans at 60fps on dense canvases.
// ─────────────────────────────────────────────────────────────
function DCViewport({
  children,
  minScale = 0.1,
  maxScale = 8,
  style = {}
}) {
  const vpRef = React.useRef(null);
  const worldRef = React.useRef(null);
  const tf = React.useRef({
    x: 0,
    y: 0,
    scale: 1
  });
  // Persist viewport across reloads so the user lands back where they were
  // after an agent edit or browser refresh. The sandbox origin is already
  // per-project; pathname keeps multiple canvas files in one project apart.
  const tfKey = 'dc-viewport:' + location.pathname;
  const saveT = React.useRef(0);
  const lastPostedScale = React.useRef();
  const apply = React.useCallback(() => {
    const {
      x,
      y,
      scale
    } = tf.current;
    const el = worldRef.current;
    if (!el) return;
    el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    // Exposed for zoom-invariant chrome (labels, buttons, TweaksPanel).
    el.style.setProperty('--dc-inv-zoom', String(1 / scale));
    // Keep the host toolbar's % readout in sync with the canvas scale. Pan
    // ticks leave scale unchanged — skip the cross-frame post for those.
    if (lastPostedScale.current !== scale) {
      lastPostedScale.current = scale;
      window.parent.postMessage({
        type: '__dc_zoom',
        scale
      }, '*');
    }
    clearTimeout(saveT.current);
    saveT.current = setTimeout(() => {
      try {
        localStorage.setItem(tfKey, JSON.stringify(tf.current));
      } catch {}
    }, 200);
  }, [tfKey]);
  React.useLayoutEffect(() => {
    const flush = () => {
      clearTimeout(saveT.current);
      try {
        localStorage.setItem(tfKey, JSON.stringify(tf.current));
      } catch {}
    };
    try {
      const s = JSON.parse(localStorage.getItem(tfKey) || 'null');
      if (s && Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.scale)) {
        tf.current = {
          x: s.x,
          y: s.y,
          scale: Math.min(maxScale, Math.max(minScale, s.scale))
        };
        apply();
      }
    } catch {}
    // Flush on pagehide and unmount so a reload within the 200ms debounce
    // window doesn't drop the last pan/zoom.
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);
  React.useEffect(() => {
    const vp = vpRef.current;
    if (!vp) return;
    const zoomAt = (cx, cy, factor) => {
      const r = vp.getBoundingClientRect();
      const px = cx - r.left,
        py = cy - r.top;
      const t = tf.current;
      const next = Math.min(maxScale, Math.max(minScale, t.scale * factor));
      const k = next / t.scale;
      // --dc-inv-zoom consumers (.dc-sectionhead's CSS zoom, each section's
      // marginBottom) reflow on every scale change, vertically shifting the
      // world layout — so a world point mathematically pinned under the cursor
      // drifts as you zoom (content creeps up on zoom-in, down on zoom-out).
      // Anchor the DOM element under the cursor instead: record its screen Y,
      // apply the transform + --dc-inv-zoom, then cancel whatever vertical
      // drift the reflow introduced so it stays put on screen.
      let marker = null,
        markerY0 = 0;
      if (k !== 1) {
        const hit = document.elementFromPoint(cx, cy);
        marker = hit && hit.closest ? hit.closest('[data-dc-slot],[data-dc-section]') : null;
        if (marker) markerY0 = marker.getBoundingClientRect().top;
      }
      // keep the world point under the cursor fixed
      t.x = px - (px - t.x) * k;
      t.y = py - (py - t.y) * k;
      t.scale = next;
      apply();
      if (marker) {
        // A pure zoom around (cx, cy) maps screen Y → cy + (Y - cy) * k. Any
        // departure after the --dc-inv-zoom reflow is the layout drift.
        const drift = marker.getBoundingClientRect().top - (cy + (markerY0 - cy) * k);
        if (Math.abs(drift) > 0.1) {
          t.y -= drift;
          apply();
        }
      }
    };

    // Mouse-wheel vs trackpad-scroll heuristic. A physical wheel sends
    // line-mode deltas (Firefox) or large integer pixel deltas with no X
    // component (Chrome/Safari, typically multiples of 100/120). Trackpad
    // two-finger scroll sends small/fractional pixel deltas, often with
    // non-zero deltaX. ctrlKey is set by the browser for trackpad pinch.
    const isMouseWheel = e => e.deltaMode !== 0 || e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40;
    const onWheel = e => {
      e.preventDefault();
      if (isGesturing) return; // Safari: gesture* owns the pinch — discard concurrent wheels
      if ((e.ctrlKey || e.metaKey) && !isMouseWheel(e)) {
        // trackpad pinch, or ctrl/cmd + smooth-scroll mouse. Notched
        // wheels fall through to the fixed-step branch below.
        zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
      } else if (isMouseWheel(e)) {
        // notched mouse wheel — fixed-ratio step per click
        zoomAt(e.clientX, e.clientY, Math.exp(-Math.sign(e.deltaY) * 0.18));
      } else {
        // trackpad two-finger scroll — pan
        tf.current.x -= e.deltaX;
        tf.current.y -= e.deltaY;
        apply();
      }
    };

    // Safari sends native gesture* events for trackpad pinch with a smooth
    // e.scale; preferring these over the ctrl+wheel fallback gives a much
    // better feel there. No-ops on other browsers. Safari also fires
    // ctrlKey wheel events during the same pinch — isGesturing makes
    // onWheel drop those entirely so they neither zoom nor pan.
    let gsBase = 1;
    let isGesturing = false;
    const onGestureStart = e => {
      e.preventDefault();
      isGesturing = true;
      gsBase = tf.current.scale;
    };
    const onGestureChange = e => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, gsBase * e.scale / tf.current.scale);
    };
    const onGestureEnd = e => {
      e.preventDefault();
      isGesturing = false;
    };

    // Drag-pan: middle button anywhere, or primary button on canvas
    // background (anything that isn't an artboard or an inline editor).
    let drag = null;
    const onPointerDown = e => {
      const onBg = !e.target.closest('[data-dc-slot], .dc-editable');
      if (!(e.button === 1 || e.button === 0 && onBg)) return;
      e.preventDefault();
      vp.setPointerCapture(e.pointerId);
      drag = {
        id: e.pointerId,
        lx: e.clientX,
        ly: e.clientY
      };
      vp.style.cursor = 'grabbing';
    };
    const onPointerMove = e => {
      if (!drag || e.pointerId !== drag.id) return;
      tf.current.x += e.clientX - drag.lx;
      tf.current.y += e.clientY - drag.ly;
      drag.lx = e.clientX;
      drag.ly = e.clientY;
      apply();
    };
    const onPointerUp = e => {
      if (!drag || e.pointerId !== drag.id) return;
      vp.releasePointerCapture(e.pointerId);
      drag = null;
      vp.style.cursor = '';
    };

    // Host-driven zoom (toolbar % menu). Zooms around viewport centre so the
    // visible midpoint stays fixed — matching the host's iframe-zoom feel.
    const onHostMsg = e => {
      const d = e.data;
      if (d && d.type === '__dc_set_zoom' && typeof d.scale === 'number') {
        const r = vp.getBoundingClientRect();
        zoomAt(r.left + r.width / 2, r.top + r.height / 2, d.scale / tf.current.scale);
      } else if (d && d.type === '__dc_probe') {
        // Host's [readyGen] reset asks whether a canvas is present; it
        // fires on the iframe's native 'load', which for canvases with
        // images/fonts is after our mount-time announce, so re-announce.
        // Clear the pan-tick guard so apply() re-posts the current scale
        // even if it's unchanged — the host just reset dcScale to 1.
        window.parent.postMessage({
          type: '__dc_present'
        }, '*');
        lastPostedScale.current = undefined;
        apply();
      }
    };
    window.addEventListener('message', onHostMsg);
    // Announce canvas mode so the host toolbar proxies its % control here
    // instead of scaling the iframe element (which would just shrink the
    // viewport window of an infinite canvas). The apply() that follows emits
    // the initial __dc_zoom so the toolbar % is correct before first pinch.
    // lastPostedScale reset mirrors the __dc_probe handler: the layout
    // effect's restore-path apply() may already have posted the restored
    // scale (before __dc_present), so clear the guard to re-post it in order.
    window.parent.postMessage({
      type: '__dc_present'
    }, '*');
    lastPostedScale.current = undefined;
    apply();
    vp.addEventListener('wheel', onWheel, {
      passive: false
    });
    vp.addEventListener('gesturestart', onGestureStart, {
      passive: false
    });
    vp.addEventListener('gesturechange', onGestureChange, {
      passive: false
    });
    vp.addEventListener('gestureend', onGestureEnd, {
      passive: false
    });
    vp.addEventListener('pointerdown', onPointerDown);
    vp.addEventListener('pointermove', onPointerMove);
    vp.addEventListener('pointerup', onPointerUp);
    vp.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('message', onHostMsg);
      vp.removeEventListener('wheel', onWheel);
      vp.removeEventListener('gesturestart', onGestureStart);
      vp.removeEventListener('gesturechange', onGestureChange);
      vp.removeEventListener('gestureend', onGestureEnd);
      vp.removeEventListener('pointerdown', onPointerDown);
      vp.removeEventListener('pointermove', onPointerMove);
      vp.removeEventListener('pointerup', onPointerUp);
      vp.removeEventListener('pointercancel', onPointerUp);
    };
  }, [apply, minScale, maxScale]);
  const gridSvg = `url("data:image/svg+xml,%3Csvg width='120' height='120' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M120 0H0v120' fill='none' stroke='${encodeURIComponent(DC.grid)}' stroke-width='1'/%3E%3C/svg%3E")`;
  return /*#__PURE__*/React.createElement("div", {
    ref: vpRef,
    className: "design-canvas",
    style: {
      height: '100vh',
      width: '100vw',
      background: DC.bg,
      overflow: 'hidden',
      overscrollBehavior: 'none',
      touchAction: 'none',
      position: 'relative',
      fontFamily: DC.font,
      boxSizing: 'border-box',
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    ref: worldRef,
    style: {
      position: 'absolute',
      top: 0,
      left: 0,
      transformOrigin: '0 0',
      willChange: 'transform',
      width: 'max-content',
      minWidth: '100%',
      minHeight: '100%',
      padding: '60px 0 80px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: -6000,
      backgroundImage: gridSvg,
      backgroundSize: '120px 120px',
      pointerEvents: 'none',
      zIndex: -1
    }
  }), children));
}

// ─────────────────────────────────────────────────────────────
// DCSection — editable title + h-row of artboards in persisted order
// ─────────────────────────────────────────────────────────────
function DCSection({
  id,
  title,
  subtitle,
  children,
  gap = 48
}) {
  const ctx = React.useContext(DCCtx);
  const sid = id ?? title;
  const all = React.Children.toArray(dcFlatten(children));
  const artboards = all.filter(c => c && c.type === DCArtboard);
  const rest = all.filter(c => !(c && c.type === DCArtboard));
  const sec = ctx && sid && ctx.section(sid) || {};
  // Must match DesignCanvas's srcKey computation exactly (it filters falsy
  // IDs), or onDelete persists a srcKey that DesignCanvas never recognizes.
  const allIds = artboards.map(a => a.props.id ?? a.props.label).filter(Boolean);
  const srcKey = allIds.join('\x1f');
  const hidden = sec.srcKey === srcKey ? sec.hidden || [] : [];
  const srcOrder = allIds.filter(k => !hidden.includes(k));
  const order = React.useMemo(() => {
    const kept = (sec.order || []).filter(k => srcOrder.includes(k));
    return [...kept, ...srcOrder.filter(k => !kept.includes(k))];
  }, [sec.order, srcOrder.join('|')]);
  const byId = Object.fromEntries(artboards.map(a => [a.props.id ?? a.props.label, a]));

  // marginBottom counter-scales so the on-screen gap between sections stays
  // constant — otherwise at low zoom the (world-space) gap collapses while
  // the screen-constant sectionhead below it doesn't, and the title reads as
  // belonging to the section above. paddingBottom below is just enough for
  // the 24px artboard-header (abs-positioned above each card) plus ~8px, so
  // the title sits tight against its own row at every zoom.
  return /*#__PURE__*/React.createElement("div", {
    "data-dc-section": sid,
    style: {
      marginBottom: 'calc(80px * var(--dc-inv-zoom, 1))',
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0 60px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "dc-sectionhead",
    style: {
      paddingBottom: 36
    }
  }, /*#__PURE__*/React.createElement(DCEditable, {
    tag: "div",
    value: sec.title ?? title,
    onChange: v => ctx && sid && ctx.patchSection(sid, {
      title: v
    }),
    style: {
      fontSize: 28,
      fontWeight: 600,
      color: DC.title,
      letterSpacing: -0.4,
      marginBottom: 6,
      display: 'inline-block'
    }
  }), subtitle && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 16,
      color: DC.subtitle
    }
  }, subtitle))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap,
      padding: '0 60px',
      alignItems: 'flex-start',
      width: 'max-content'
    }
  }, order.map(k => /*#__PURE__*/React.createElement(DCArtboardFrame, {
    key: k,
    sectionId: sid,
    artboard: byId[k],
    order: order,
    label: (sec.labels || {})[k] ?? byId[k].props.label,
    onRename: v => ctx && ctx.patchSection(sid, x => ({
      labels: {
        ...x.labels,
        [k]: v
      }
    })),
    onReorder: next => ctx && ctx.patchSection(sid, {
      order: next
    }),
    onDelete: () => ctx && ctx.patchSection(sid, x => ({
      hidden: [...(x.srcKey === srcKey ? x.hidden || [] : []), k],
      srcKey
    })),
    onFocus: () => ctx && ctx.setFocus(`${sid}/${k}`)
  }))), rest);
}

// DCArtboard — marker; rendered by DCArtboardFrame via DCSection.
function DCArtboard() {
  return null;
}

// Per-artboard export (kind: 'png' | 'html'). Both paths share the same
// self-contained clone: computed styles baked in, @font-face / <img> /
// inline-style background-image urls inlined as data URIs. PNG wraps the
// clone in foreignObject→canvas at 3× the artboard's natural width×height
// (same pipeline the host uses for page captures); HTML wraps it in a
// minimal standalone document. Both are independent of viewport zoom.
async function dcExport(node, w, h, name, kind) {
  try {
    await document.fonts.ready;
  } catch {}
  const toDataURL = url => fetch(url).then(r => r.blob()).then(b => new Promise(res => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => res(url);
    fr.readAsDataURL(b);
  })).catch(() => url);

  // Collect @font-face rules. ss.cssRules throws SecurityError on
  // cross-origin sheets (e.g. fonts.googleapis.com) — in that case fetch
  // the CSS text directly (those endpoints send ACAO:*) and regex-extract
  // the blocks. @import and @media/@supports are walked so nested
  // @font-face rules aren't missed.
  const fontRules = [],
    pending = [],
    seen = new Set();
  const scrapeCss = href => {
    if (seen.has(href)) return;
    seen.add(href);
    pending.push(fetch(href).then(r => r.text()).then(css => {
      for (const m of css.match(/@font-face\s*{[^}]*}/g) || []) fontRules.push({
        css: m,
        base: href
      });
      for (const m of css.matchAll(/@import\s+(?:url\()?['"]?([^'")\s;]+)/g)) scrapeCss(new URL(m[1], href).href);
    }).catch(() => {}));
  };
  const walk = (rules, base) => {
    for (const r of rules) {
      if (r.type === CSSRule.FONT_FACE_RULE) fontRules.push({
        css: r.cssText,
        base
      });else if (r.type === CSSRule.IMPORT_RULE && r.styleSheet) {
        const ibase = r.styleSheet.href || base;
        try {
          walk(r.styleSheet.cssRules, ibase);
        } catch {
          scrapeCss(ibase);
        }
      } else if (r.cssRules) walk(r.cssRules, base);
    }
  };
  for (const ss of document.styleSheets) {
    const base = ss.href || location.href;
    try {
      walk(ss.cssRules, base);
    } catch {
      if (ss.href) scrapeCss(ss.href);
    }
  }
  while (pending.length) await pending.shift();
  const fontCss = (await Promise.all(fontRules.map(async rule => {
    let out = rule.css,
      m;
    const re = /url\((['"]?)([^'")]+)\1\)/g;
    while (m = re.exec(rule.css)) {
      if (m[2].indexOf('data:') === 0) continue;
      let abs;
      try {
        abs = new URL(m[2], rule.base).href;
      } catch {
        continue;
      }
      out = out.split(m[0]).join('url("' + (await toDataURL(abs)) + '")');
    }
    return out;
  }))).join('\n');
  const cloneStyled = src => {
    if (src.nodeType === 8 || src.nodeType === 1 && src.tagName === 'SCRIPT') return document.createTextNode('');
    const dst = src.cloneNode(false);
    if (src.nodeType === 1) {
      const cs = getComputedStyle(src);
      let txt = '';
      for (let i = 0; i < cs.length; i++) txt += cs[i] + ':' + cs.getPropertyValue(cs[i]) + ';';
      dst.setAttribute('style', txt + 'animation:none;transition:none;');
      if (src.tagName === 'CANVAS') try {
        const im = document.createElement('img');
        im.src = src.toDataURL();
        im.setAttribute('style', txt);
        return im;
      } catch {}
    }
    for (let c = src.firstChild; c; c = c.nextSibling) dst.appendChild(cloneStyled(c));
    return dst;
  };
  const clone = cloneStyled(node);
  clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  // Drop the card's own shadow/radius so the export is a flush w×h rect;
  // the artboard's own background (if any) is already in the computed style.
  clone.style.boxShadow = 'none';
  clone.style.borderRadius = '0';
  const jobs = [];
  clone.querySelectorAll('img').forEach(el => {
    const s = el.getAttribute('src');
    if (s && s.indexOf('data:') !== 0) jobs.push(toDataURL(el.src).then(d => el.setAttribute('src', d)));
  });
  [clone, ...clone.querySelectorAll('*')].forEach(el => {
    const bg = el.style.backgroundImage;
    if (!bg) return;
    let m;
    const re = /url\(["']?([^"')]+)["']?\)/g;
    while (m = re.exec(bg)) {
      const tok = m[0],
        url = m[1];
      if (url.indexOf('data:') === 0) continue;
      jobs.push(toDataURL(url).then(d => {
        el.style.backgroundImage = el.style.backgroundImage.split(tok).join('url("' + d + '")');
      }));
    }
  });
  await Promise.all(jobs);
  const xml = new XMLSerializer().serializeToString(clone);
  const save = (blob, ext) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name + '.' + ext;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  if (kind === 'html') {
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>' + name + '</title>' + (fontCss ? '<style>' + fontCss + '</style>' : '') + '</head><body style="margin:0">' + xml + '</body></html>';
    return save(new Blob([html], {
      type: 'text/html'
    }), 'html');
  }

  // PNG: the SVG's own width/height must be the output resolution — an
  // <img>-loaded SVG rasterizes at its intrinsic size, so sizing it at 1×
  // and ctx.scale()-ing up would just upscale a 1× bitmap. viewBox maps the
  // w×h foreignObject onto the px·w × px·h SVG canvas so the browser renders
  // the HTML at full resolution.
  const px = 3;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w * px + '" height="' + h * px + '" viewBox="0 0 ' + w + ' ' + h + '"><foreignObject width="' + w + '" height="' + h + '">' + (fontCss ? '<style><![CDATA[' + fontCss + ']]></style>' : '') + xml + '</foreignObject></svg>';
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(new Error('svg load failed'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
  const cv = document.createElement('canvas');
  cv.width = w * px;
  cv.height = h * px;
  cv.getContext('2d').drawImage(img, 0, 0);
  cv.toBlob(blob => save(blob, 'png'), 'image/png');
}
function DCArtboardFrame({
  sectionId,
  artboard,
  label,
  order,
  onRename,
  onReorder,
  onFocus,
  onDelete
}) {
  const {
    id: rawId,
    label: rawLabel,
    width = 260,
    height = 480,
    children,
    style = {}
  } = artboard.props;
  const id = rawId ?? rawLabel;
  const ref = React.useRef(null);
  const cardRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);

  // ⋯ menu: close on any outside pointerdown. Two-click delete lives inside
  // the menu — first click arms the row, second commits; closing disarms.
  React.useEffect(() => {
    if (!menuOpen) {
      setConfirming(false);
      return;
    }
    const off = e => {
      if (!menuRef.current || !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', off, true);
    return () => document.removeEventListener('pointerdown', off, true);
  }, [menuOpen]);
  const doExport = kind => {
    setMenuOpen(false);
    if (!cardRef.current) return;
    const name = String(label || id || 'artboard').replace(/[^\w\s.-]+/g, '_');
    dcExport(cardRef.current, width, height, name, kind).catch(e => console.error('[design-canvas] export failed:', e));
  };

  // Live drag-reorder: dragged card sticks to cursor; siblings slide into
  // their would-be slots in real time via transforms. DOM order only
  // changes on drop.
  const onGripDown = e => {
    e.preventDefault();
    e.stopPropagation();
    const me = ref.current;
    // translateX is applied in local (pre-scale) space but pointer deltas and
    // getBoundingClientRect().left are screen-space — divide by the viewport's
    // current scale so the dragged card tracks the cursor at any zoom level.
    const scale = me.getBoundingClientRect().width / me.offsetWidth || 1;
    const peers = Array.from(document.querySelectorAll(`[data-dc-section="${sectionId}"] [data-dc-slot]`));
    const homes = peers.map(el => ({
      el,
      id: el.dataset.dcSlot,
      x: el.getBoundingClientRect().left
    }));
    const slotXs = homes.map(h => h.x);
    const startIdx = order.indexOf(id);
    const startX = e.clientX;
    let liveOrder = order.slice();
    me.classList.add('dc-dragging');
    const layout = () => {
      for (const h of homes) {
        if (h.id === id) continue;
        const slot = liveOrder.indexOf(h.id);
        h.el.style.transform = `translateX(${(slotXs[slot] - h.x) / scale}px)`;
      }
    };
    const move = ev => {
      const dx = ev.clientX - startX;
      me.style.transform = `translateX(${dx / scale}px)`;
      const cur = homes[startIdx].x + dx;
      let nearest = 0,
        best = Infinity;
      for (let i = 0; i < slotXs.length; i++) {
        const d = Math.abs(slotXs[i] - cur);
        if (d < best) {
          best = d;
          nearest = i;
        }
      }
      if (liveOrder.indexOf(id) !== nearest) {
        liveOrder = order.filter(k => k !== id);
        liveOrder.splice(nearest, 0, id);
        layout();
      }
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      const finalSlot = liveOrder.indexOf(id);
      me.classList.remove('dc-dragging');
      me.style.transform = `translateX(${(slotXs[finalSlot] - homes[startIdx].x) / scale}px)`;
      // After the settle transition, kill transitions + clear transforms +
      // commit the reorder in the same frame so there's no visual snap-back.
      setTimeout(() => {
        for (const h of homes) {
          h.el.style.transition = 'none';
          h.el.style.transform = '';
        }
        if (liveOrder.join('|') !== order.join('|')) onReorder(liveOrder);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          for (const h of homes) h.el.style.transition = '';
        }));
      }, 180);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };
  return /*#__PURE__*/React.createElement("div", {
    ref: ref,
    "data-dc-slot": id,
    style: {
      position: 'relative',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "dc-header",
    "data-omelette-chrome": "",
    style: {
      color: DC.label
    },
    onPointerDown: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    className: "dc-labelrow"
  }, /*#__PURE__*/React.createElement("div", {
    className: "dc-grip",
    onPointerDown: onGripDown,
    title: "Drag to reorder"
  }, /*#__PURE__*/React.createElement("svg", {
    width: "9",
    height: "13",
    viewBox: "0 0 9 13",
    fill: "currentColor"
  }, /*#__PURE__*/React.createElement("circle", {
    cx: "2",
    cy: "2",
    r: "1.1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "7",
    cy: "2",
    r: "1.1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "2",
    cy: "6.5",
    r: "1.1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "7",
    cy: "6.5",
    r: "1.1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "2",
    cy: "11",
    r: "1.1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "7",
    cy: "11",
    r: "1.1"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "dc-labeltext",
    onClick: onFocus,
    title: "Click to focus"
  }, /*#__PURE__*/React.createElement(DCEditable, {
    value: label,
    onChange: onRename,
    onClick: e => e.stopPropagation(),
    style: {
      fontSize: 15,
      fontWeight: 500,
      color: DC.label,
      lineHeight: 1
    }
  }))), /*#__PURE__*/React.createElement("div", {
    className: "dc-btns"
  }, /*#__PURE__*/React.createElement("div", {
    ref: menuRef,
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "dc-kebab",
    title: "More",
    onClick: () => setMenuOpen(o => !o)
  }, /*#__PURE__*/React.createElement("svg", {
    width: "12",
    height: "12",
    viewBox: "0 0 12 12",
    fill: "currentColor"
  }, /*#__PURE__*/React.createElement("circle", {
    cx: "2.5",
    cy: "6",
    r: "1.1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "6",
    cy: "6",
    r: "1.1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "9.5",
    cy: "6",
    r: "1.1"
  }))), menuOpen && /*#__PURE__*/React.createElement("div", {
    className: "dc-menu",
    onPointerDown: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => doExport('png')
  }, "Download PNG"), /*#__PURE__*/React.createElement("button", {
    onClick: () => doExport('html')
  }, "Download HTML"), /*#__PURE__*/React.createElement("hr", null), /*#__PURE__*/React.createElement("button", {
    className: "dc-danger",
    onClick: () => {
      if (confirming) {
        setMenuOpen(false);
        onDelete();
      } else setConfirming(true);
    }
  }, confirming ? 'Click again to delete' : 'Delete'))), /*#__PURE__*/React.createElement("button", {
    className: "dc-expand",
    onClick: onFocus,
    title: "Focus"
  }, /*#__PURE__*/React.createElement("svg", {
    width: "12",
    height: "12",
    viewBox: "0 0 12 12",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.6",
    strokeLinecap: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M7 1h4v4M5 11H1V7M11 1L7.5 4.5M1 11l3.5-3.5"
  }))))), /*#__PURE__*/React.createElement("div", {
    ref: cardRef,
    className: "dc-card",
    style: {
      borderRadius: 2,
      boxShadow: '0 1px 3px rgba(0,0,0,.08),0 4px 16px rgba(0,0,0,.06)',
      overflow: 'hidden',
      width,
      height,
      background: '#fff',
      ...style
    }
  }, children || /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#bbb',
      fontSize: 13,
      fontFamily: DC.font
    }
  }, id)));
}

// Inline rename — commits on blur or Enter.
function DCEditable({
  value,
  onChange,
  style,
  tag = 'span',
  onClick
}) {
  const T = tag;
  return /*#__PURE__*/React.createElement(T, {
    className: "dc-editable",
    contentEditable: true,
    suppressContentEditableWarning: true,
    onClick: onClick,
    onPointerDown: e => e.stopPropagation(),
    onBlur: e => onChange && onChange(e.currentTarget.textContent),
    onKeyDown: e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.currentTarget.blur();
      }
    },
    style: style
  }, value);
}

// ─────────────────────────────────────────────────────────────
// Focus mode — overlay one artboard; ←/→ within section, ↑/↓ across
// sections, Esc or backdrop click to exit.
// ─────────────────────────────────────────────────────────────
function DCFocusOverlay({
  entry,
  sectionMeta,
  sectionOrder
}) {
  const ctx = React.useContext(DCCtx);
  const {
    sectionId,
    artboard
  } = entry;
  const sec = ctx.section(sectionId);
  const meta = sectionMeta[sectionId];
  const peers = meta.slotIds;
  const aid = artboard.props.id ?? artboard.props.label;
  const idx = peers.indexOf(aid);
  const secIdx = sectionOrder.indexOf(sectionId);
  const go = d => {
    const n = peers[(idx + d + peers.length) % peers.length];
    if (n) ctx.setFocus(`${sectionId}/${n}`);
  };
  const goSection = d => {
    // Sections whose artboards are all deleted have slotIds:[] — step past
    // them to the next non-empty section so ↑/↓ doesn't dead-end.
    const n = sectionOrder.length;
    for (let i = 1; i < n; i++) {
      const ns = sectionOrder[((secIdx + d * i) % n + n) % n];
      const first = sectionMeta[ns] && sectionMeta[ns].slotIds[0];
      if (first) {
        ctx.setFocus(`${ns}/${first}`);
        return;
      }
    }
  };
  React.useEffect(() => {
    const k = e => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        go(-1);
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        go(1);
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        goSection(-1);
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        goSection(1);
      }
    };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  });
  const {
    width = 260,
    height = 480,
    children
  } = artboard.props;
  const [vp, setVp] = React.useState({
    w: window.innerWidth,
    h: window.innerHeight
  });
  React.useEffect(() => {
    const r = () => setVp({
      w: window.innerWidth,
      h: window.innerHeight
    });
    window.addEventListener('resize', r);
    return () => window.removeEventListener('resize', r);
  }, []);
  const scale = Math.max(0.1, Math.min((vp.w - 200) / width, (vp.h - 260) / height, 2));
  const [ddOpen, setDd] = React.useState(false);
  const Arrow = ({
    dir,
    onClick
  }) => /*#__PURE__*/React.createElement("button", {
    onClick: e => {
      e.stopPropagation();
      onClick();
    },
    style: {
      position: 'absolute',
      top: '50%',
      [dir]: 28,
      transform: 'translateY(-50%)',
      border: 'none',
      background: 'rgba(255,255,255,.08)',
      color: 'rgba(255,255,255,.9)',
      width: 44,
      height: 44,
      borderRadius: 22,
      fontSize: 18,
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      transition: 'background .15s'
    },
    onMouseEnter: e => e.currentTarget.style.background = 'rgba(255,255,255,.18)',
    onMouseLeave: e => e.currentTarget.style.background = 'rgba(255,255,255,.08)'
  }, /*#__PURE__*/React.createElement("svg", {
    width: "18",
    height: "18",
    viewBox: "0 0 18 18",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: dir === 'left' ? 'M11 3L5 9l6 6' : 'M7 3l6 6-6 6'
  })));

  // Portal to body so position:fixed is the real viewport regardless of any
  // transform on DesignCanvas's ancestors (including the canvas zoom itself).
  return ReactDOM.createPortal(/*#__PURE__*/React.createElement("div", {
    onClick: () => ctx.setFocus(null),
    onWheel: e => e.preventDefault(),
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 100,
      background: 'rgba(24,20,16,.6)',
      backdropFilter: 'blur(14px)',
      fontFamily: DC.font,
      color: '#fff'
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 72,
      display: 'flex',
      alignItems: 'flex-start',
      padding: '16px 20px 0',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setDd(o => !o),
    style: {
      border: 'none',
      background: 'transparent',
      color: '#fff',
      cursor: 'pointer',
      padding: '6px 8px',
      borderRadius: 6,
      textAlign: 'left',
      fontFamily: 'inherit'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 18,
      fontWeight: 600,
      letterSpacing: -0.3
    }
  }, meta.title), /*#__PURE__*/React.createElement("svg", {
    width: "11",
    height: "11",
    viewBox: "0 0 11 11",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8",
    strokeLinecap: "round",
    style: {
      opacity: .7
    }
  }, /*#__PURE__*/React.createElement("path", {
    d: "M2 4l3.5 3.5L9 4"
  }))), meta.subtitle && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontSize: 13,
      opacity: .6,
      fontWeight: 400,
      marginTop: 2
    }
  }, meta.subtitle)), ddOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: '100%',
      left: 0,
      marginTop: 4,
      background: '#2a251f',
      borderRadius: 8,
      boxShadow: '0 8px 32px rgba(0,0,0,.4)',
      padding: 4,
      minWidth: 200,
      zIndex: 10
    }
  }, sectionOrder.filter(sid => sectionMeta[sid].slotIds.length).map(sid => /*#__PURE__*/React.createElement("button", {
    key: sid,
    onClick: () => {
      setDd(false);
      const f = sectionMeta[sid].slotIds[0];
      if (f) ctx.setFocus(`${sid}/${f}`);
    },
    style: {
      display: 'block',
      width: '100%',
      textAlign: 'left',
      border: 'none',
      cursor: 'pointer',
      background: sid === sectionId ? 'rgba(255,255,255,.1)' : 'transparent',
      color: '#fff',
      padding: '8px 12px',
      borderRadius: 5,
      fontSize: 14,
      fontWeight: sid === sectionId ? 600 : 400,
      fontFamily: 'inherit'
    }
  }, sectionMeta[sid].title)))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: () => ctx.setFocus(null),
    onMouseEnter: e => e.currentTarget.style.background = 'rgba(255,255,255,.12)',
    onMouseLeave: e => e.currentTarget.style.background = 'transparent',
    style: {
      border: 'none',
      background: 'transparent',
      color: 'rgba(255,255,255,.7)',
      width: 32,
      height: 32,
      borderRadius: 16,
      fontSize: 20,
      cursor: 'pointer',
      lineHeight: 1,
      transition: 'background .12s'
    }
  }, "\xD7")), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 64,
      bottom: 56,
      left: 100,
      right: 100,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      width: width * scale,
      height: height * scale,
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width,
      height,
      transform: `scale(${scale})`,
      transformOrigin: 'top left',
      background: '#fff',
      borderRadius: 2,
      overflow: 'hidden',
      boxShadow: '0 20px 80px rgba(0,0,0,.4)'
    }
  }, children || /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#bbb'
    }
  }, aid))), /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      fontSize: 14,
      fontWeight: 500,
      opacity: .85,
      textAlign: 'center'
    }
  }, (sec.labels || {})[aid] ?? artboard.props.label, /*#__PURE__*/React.createElement("span", {
    style: {
      opacity: .5,
      marginLeft: 10,
      fontVariantNumeric: 'tabular-nums'
    }
  }, idx + 1, " / ", peers.length))), /*#__PURE__*/React.createElement(Arrow, {
    dir: "left",
    onClick: () => go(-1)
  }), /*#__PURE__*/React.createElement(Arrow, {
    dir: "right",
    onClick: () => go(1)
  }), /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      position: 'absolute',
      bottom: 20,
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      gap: 8
    }
  }, peers.map((p, i) => /*#__PURE__*/React.createElement("button", {
    key: p,
    onClick: () => ctx.setFocus(`${sectionId}/${p}`),
    style: {
      border: 'none',
      padding: 0,
      cursor: 'pointer',
      width: 6,
      height: 6,
      borderRadius: 3,
      background: i === idx ? '#fff' : 'rgba(255,255,255,.3)'
    }
  })))), document.body);
}

// ─────────────────────────────────────────────────────────────
// Post-it — absolute-positioned sticky note
// ─────────────────────────────────────────────────────────────
function DCPostIt({
  children,
  top,
  left,
  right,
  bottom,
  rotate = -2,
  width = 180
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top,
      left,
      right,
      bottom,
      width,
      background: DC.postitBg,
      padding: '14px 16px',
      fontFamily: '"Comic Sans MS", "Marker Felt", "Segoe Print", cursive',
      fontSize: 14,
      lineHeight: 1.4,
      color: DC.postitText,
      boxShadow: '0 2px 8px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.08)',
      transform: `rotate(${rotate}deg)`,
      zIndex: 5
    }
  }, children);
}
Object.assign(window, {
  DesignCanvas,
  DCSection,
  DCArtboard,
  DCPostIt
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/editor/design-canvas.jsx", error: String((e && e.message) || e) }); }

// ui_kits/editor/options-app-v2.jsx
try { (() => {
/* global React, ReactDOM, DesignCanvas, DCSection, DCArtboard, ChromePaired, ChromeSplit, ChromeFinish */

const noteStyle2 = {
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  lineHeight: 1.5,
  color: "var(--steel-100)"
};
const tagStyle2 = {
  display: "inline-block",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--brass-500)",
  marginBottom: 6,
  letterSpacing: "0.04em"
};
function Cap({
  tag,
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width: 840,
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: tagStyle2
  }, tag), /*#__PURE__*/React.createElement("div", {
    style: noteStyle2,
    dangerouslySetInnerHTML: {
      __html: children
    }
  }));
}
function OptionsV2() {
  return /*#__PURE__*/React.createElement(DesignCanvas, null, /*#__PURE__*/React.createElement(DCSection, {
    id: "bar",
    title: "The bar, emptied",
    subtitle: "Wordmark \xB7 Annotate switch \xB7 \u22EF. The file path, reload and snapshot all move inside the \u22EF menu \u2014 shown open on the third board."
  }, /*#__PURE__*/React.createElement(DCArtboard, {
    id: "paired",
    label: "D \xB7 Paired footer actions",
    width: 840,
    height: 560
  }, /*#__PURE__*/React.createElement(ChromePaired, null), /*#__PURE__*/React.createElement(Cap, {
    tag: "D \xB7 PAIRED FOOTER \u2014 clearest hierarchy"
  }, "Bar drops to three things. Both session actions move to the composer footer, where your attention already is: ", /*#__PURE__*/React.createElement("b", null, "End session"), " sits left as a quiet rust text-button, ", /*#__PURE__*/React.createElement("b", null, "Send to Agent"), " filled on the right. Reads like a form \u2014 secondary action left, primary right. Nothing destructive in the chrome's top edge anymore.")), /*#__PURE__*/React.createElement(DCArtboard, {
    id: "split",
    label: "E \xB7 Split send button",
    width: 840,
    height: 560
  }, /*#__PURE__*/React.createElement(ChromeSplit, null), /*#__PURE__*/React.createElement(Cap, {
    tag: "E \xB7 SPLIT SEND \u2014 one footprint, two intents"
  }, "A single primary control. ", /*#__PURE__*/React.createElement("b", null, "Send to Agent"), " with a ", /*#__PURE__*/React.createElement("b", null, "\u25BE"), " that opens ", /*#__PURE__*/React.createElement("b", null, "Send & end session"), " \u2014 your \u201Csend\u201D muscle memory works, and ending is one deliberate notch away in the same spot. Tightest footer; the trade is that ending is slightly hidden.")), /*#__PURE__*/React.createElement(DCArtboard, {
    id: "finish",
    label: "F \xB7 Send is the finish (\u22EF open)",
    width: 840,
    height: 560
  }, /*#__PURE__*/React.createElement(ChromeFinish, null), /*#__PURE__*/React.createElement(Cap, {
    tag: "F \xB7 SEND IS THE FINISH \u2014 boldest reframe"
  }, "Treats ending as a ", /*#__PURE__*/React.createElement("i", null, "kind"), " of send. Full-width ", /*#__PURE__*/React.createElement("b", null, "Send to Agent"), ", and a whisper-quiet text link beneath: ", /*#__PURE__*/React.createElement("b", null, "Send a final note & end session"), ". The \u22EF menu is shown open here so you can see where the file path lands \u2014 under an ", /*#__PURE__*/React.createElement("b", null, "\u201CEditing\u201D"), " label, with Reload and Copy DOM snapshot below."))));
}
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(OptionsV2, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/editor/options-app-v2.jsx", error: String((e && e.message) || e) }); }

// ui_kits/editor/options-app-v3.jsx
try { (() => {
/* global React, ReactDOM, DesignCanvas, DCSection, DCArtboard, PanelIdleNudge, PanelDualHome, PanelLabeledCaret */

const ns3 = {
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  lineHeight: 1.5,
  color: "var(--steel-100)"
};
const ts3 = {
  display: "inline-block",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--brass-500)",
  marginBottom: 6,
  letterSpacing: "0.04em"
};
function Cap3({
  tag,
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width: 320,
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: ts3
  }, tag), /*#__PURE__*/React.createElement("div", {
    style: ns3,
    dangerouslySetInnerHTML: {
      __html: children
    }
  }));
}
function OptionsV3() {
  return /*#__PURE__*/React.createElement(DesignCanvas, null, /*#__PURE__*/React.createElement(DCSection, {
    id: "discover",
    title: "Making \u201Cend session\u201D discoverable",
    subtitle: "Option E keeps the tiny split button. These three mechanisms make sure nobody misses the end-session path \u2014 without adding permanent real estate."
  }, /*#__PURE__*/React.createElement(DCArtboard, {
    id: "nudge",
    label: "E1 \xB7 Contextual idle nudge",
    width: 320,
    height: 520
  }, /*#__PURE__*/React.createElement(PanelIdleNudge, null), /*#__PURE__*/React.createElement(Cap3, {
    tag: "E1 \xB7 IDLE NUDGE \u2014 teaches at the right moment"
  }, "The agent has replied and your box is empty \u2014 the moment you\u2019re ", /*#__PURE__*/React.createElement("i", null, "most"), " likely done. A quiet one-liner fades in above the composer pointing at the ", /*#__PURE__*/React.createElement("b", null, "\u25BE"), ". It costs zero space while you\u2019re actively working and disappears the instant you start typing. Teaches the fast path exactly when it\u2019s relevant.")), /*#__PURE__*/React.createElement(DCArtboard, {
    id: "dual",
    label: "E2 \xB7 Dual home in \u22EF",
    width: 320,
    height: 520
  }, /*#__PURE__*/React.createElement(PanelDualHome, null), /*#__PURE__*/React.createElement(Cap3, {
    tag: "E2 \xB7 DUAL HOME \u2014 the reliable safety net"
  }, /*#__PURE__*/React.createElement("b", null, "End session"), " also lives in the ", /*#__PURE__*/React.createElement("b", null, "\u22EF"), " menu (rust, set off below a divider). The split-button \u25BE stays the ", /*#__PURE__*/React.createElement("i", null, "fast"), " path; the \u22EF menu is the ", /*#__PURE__*/React.createElement("i", null, "discoverable"), " path everyone opens to explore. Belt and suspenders \u2014 anyone poking around finds it.")), /*#__PURE__*/React.createElement(DCArtboard, {
    id: "labeled",
    label: "E3 \xB7 Labeled caret + tooltip",
    width: 320,
    height: 520
  }, /*#__PURE__*/React.createElement(PanelLabeledCaret, null), /*#__PURE__*/React.createElement(Cap3, {
    tag: "E3 \xB7 LABELED CARET \u2014 visible at a glance"
  }, "The trigger isn\u2019t a bare \u25BE \u2014 it reads ", /*#__PURE__*/React.createElement("b", null, "\u201Cend \u25BE\u201D"), ", and hovering surfaces a ", /*#__PURE__*/React.createElement("b", null, "\u201CSend & end session\u201D"), " tooltip. The word is always on screen, so the option is never truly hidden. Adds a sliver of width back, but no second control."))));
}
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(OptionsV3, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/editor/options-app-v3.jsx", error: String((e && e.message) || e) }); }

// ui_kits/editor/options-app.jsx
try { (() => {
/* global React, DesignCanvas, DCSection, DCArtboard, ChromeBaseline, ChromeQuiet, ChromeOverflow, ChromeUnified */

const noteStyle = {
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  lineHeight: 1.5,
  color: "var(--steel-100)"
};
const tagStyle = {
  display: "inline-block",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--brass-500)",
  marginBottom: 6,
  letterSpacing: "0.04em"
};
function Caption({
  tag,
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width: 820,
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: tagStyle
  }, tag), /*#__PURE__*/React.createElement("div", {
    style: noteStyle,
    dangerouslySetInnerHTML: {
      __html: children
    }
  }));
}
function OptionsApp() {
  return /*#__PURE__*/React.createElement(DesignCanvas, null, /*#__PURE__*/React.createElement(DCSection, {
    id: "baseline",
    title: "Where it is today",
    subtitle: "Five competing controls: two filled-weight bar buttons, a floating Cancel/Queue pair, pill \xD7 chips, and Send."
  }, /*#__PURE__*/React.createElement(DCArtboard, {
    id: "current",
    label: "Current chrome",
    width: 820,
    height: 500
  }, /*#__PURE__*/React.createElement(ChromeBaseline, null))), /*#__PURE__*/React.createElement(DCSection, {
    id: "options",
    title: "Three ways to quiet it down",
    subtitle: "Each keeps a single filled brass action \u2014 Send \u2014 and demotes everything else."
  }, /*#__PURE__*/React.createElement(DCArtboard, {
    id: "quiet",
    label: "A \xB7 Quiet bar",
    width: 820,
    height: 560
  }, /*#__PURE__*/React.createElement(ChromeQuiet, null), /*#__PURE__*/React.createElement(Caption, {
    tag: "A \xB7 QUIET BAR \u2014 smallest change"
  }, "The two bar buttons become a ", /*#__PURE__*/React.createElement("b", null, "switch"), " (Annotate) and a single ", /*#__PURE__*/React.createElement("b", null, "icon"), " (end session). The floating card loses its filled Cancel \u2014 now a quiet text link beside a compact ", /*#__PURE__*/React.createElement("b", null, "Queue"), ". One filled button survives anywhere on screen: ", /*#__PURE__*/React.createElement("b", null, "Send"), ". Lowest-risk; keeps every existing flow intact.")), /*#__PURE__*/React.createElement(DCArtboard, {
    id: "overflow",
    label: "B \xB7 Overflow menu",
    width: 820,
    height: 560
  }, /*#__PURE__*/React.createElement(ChromeOverflow, null), /*#__PURE__*/React.createElement(Caption, {
    tag: "B \xB7 OVERFLOW MENU \u2014 emptiest bar"
  }, "The bar collapses to ", /*#__PURE__*/React.createElement("b", null, "wordmark \xB7 file \xB7 Annotate switch \xB7 \u22EF"), ". End Session, snapshot, reload all live behind the ", /*#__PURE__*/React.createElement("b", null, "\u22EF"), " menu. Send becomes an ", /*#__PURE__*/React.createElement("b", null, "icon inside the textarea"), ", so the composer reads as one object instead of input-plus-button. Calmest top edge; the trade is one extra click to reach session controls.")), /*#__PURE__*/React.createElement(DCArtboard, {
    id: "unified",
    label: "C \xB7 Unified composer",
    width: 820,
    height: 560
  }, /*#__PURE__*/React.createElement(ChromeUnified, null), /*#__PURE__*/React.createElement(Caption, {
    tag: "C \xB7 UNIFIED COMPOSER \u2014 fewest controls (recommended)"
  }, "The floating annotation card ", /*#__PURE__*/React.createElement("b", null, "disappears entirely"), ". Clicking an element drops a ", /*#__PURE__*/React.createElement("b", null, "context chip"), " (\u201Cediting <h1>\u201D) above the one composer \u2014 you type and Send like any message. This removes the whole Cancel/Queue cluster ", /*#__PURE__*/React.createElement("i", null, "and"), " the separate floating input. One place to write, one action to send. Biggest behavioral change, but the most elegant end state."))));
}
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(OptionsApp, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/editor/options-app.jsx", error: String((e && e.message) || e) }); }

// ui_kits/editor/options-chrome-v2.jsx
try { (() => {
/* global React */
// v2 chrome explorations: near-empty bar (file path → ⋯ menu),
// End Session relocated next to Send. Bold variants.

const v2 = {
  shell: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    background: "var(--ink-900)",
    color: "var(--cream-100)",
    fontFamily: "var(--font-sans)",
    fontSize: 12,
    overflow: "hidden"
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
    position: "relative"
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    whiteSpace: "nowrap",
    flexShrink: 0
  },
  brandMark: {
    fontFamily: "var(--font-serif)",
    fontStyle: "italic",
    fontSize: 17,
    lineHeight: 1,
    color: "var(--cream-100)"
  },
  brandSupport: {
    fontSize: 8,
    fontWeight: 600,
    letterSpacing: "0.18em",
    textTransform: "uppercase",
    color: "var(--steel-200)",
    position: "relative",
    top: 1
  },
  spacer: {
    flex: 1
  },
  body: {
    flex: 1,
    minHeight: 0,
    display: "flex"
  },
  artifact: {
    flex: 1,
    minWidth: 0,
    background: "#ffffff",
    color: "#1a1a1a",
    padding: "22px 24px",
    position: "relative",
    overflow: "hidden"
  },
  artEyebrow: {
    fontSize: 7.5,
    fontWeight: 700,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: "#7a6a3a",
    marginBottom: 12
  },
  artH1: {
    fontFamily: "'EB Garamond', Georgia, serif",
    fontStyle: "italic",
    fontSize: 30,
    lineHeight: 1.05,
    margin: "0 0 12px",
    color: "#1a1a1a",
    display: "inline-block"
  },
  artLede: {
    fontSize: 11,
    lineHeight: 1.5,
    color: "#3a3a3a",
    maxWidth: 320,
    margin: 0
  },
  panel: {
    width: 248,
    flexShrink: 0,
    borderLeft: "1px solid var(--steel-700)",
    background: "var(--ink-800)",
    display: "flex",
    flexDirection: "column",
    minHeight: 0
  },
  panelH: {
    fontSize: 11,
    margin: "12px 12px 8px",
    fontWeight: 600
  },
  log: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
    padding: "0 12px 8px",
    display: "flex",
    flexDirection: "column",
    gap: 8
  },
  uBub: {
    alignSelf: "flex-end",
    maxWidth: "88%",
    borderRadius: 11,
    padding: "7px 9px",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border-strong)"
  },
  aBub: {
    alignSelf: "flex-start",
    maxWidth: "88%",
    borderRadius: 11,
    padding: "7px 9px",
    background: "transparent",
    border: "1px solid var(--border-subtle)"
  },
  bubLabel: {
    display: "block",
    fontSize: 8,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "var(--fg-faint)",
    marginBottom: 3
  },
  composer: {
    borderTop: "1px solid var(--steel-700)",
    padding: 12,
    display: "grid",
    gap: 8,
    flexShrink: 0
  },
  ta: {
    width: "100%",
    minHeight: 50,
    borderRadius: 10,
    border: "1px solid var(--steel-600)",
    background: "var(--ink-900)",
    color: "var(--cream-100)",
    padding: 8,
    font: "inherit",
    fontSize: 11,
    boxSizing: "border-box",
    resize: "none"
  }
};
const fBtn = {
  border: 0,
  background: "var(--brass-500)",
  color: "var(--brass-ink)",
  borderRadius: 9,
  padding: "7px 12px",
  fontFamily: "inherit",
  fontWeight: 700,
  fontSize: 11,
  cursor: "pointer",
  whiteSpace: "nowrap"
};
const gBtn = {
  border: "1px solid var(--steel-600)",
  background: "transparent",
  color: "var(--steel-100)",
  borderRadius: 9,
  padding: "7px 11px",
  fontFamily: "inherit",
  fontWeight: 600,
  fontSize: 11,
  cursor: "pointer",
  whiteSpace: "nowrap"
};
const iBtn = {
  width: 28,
  height: 28,
  display: "grid",
  placeItems: "center",
  border: "1px solid var(--steel-700)",
  background: "transparent",
  color: "var(--steel-200)",
  borderRadius: 8,
  cursor: "pointer",
  flexShrink: 0,
  padding: 0
};
function I({
  d,
  size = 15
}) {
  return /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.6",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, d);
}
const icMore = /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
  cx: "12",
  cy: "5",
  r: "1.4"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "12",
  cy: "12",
  r: "1.4"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "12",
  cy: "19",
  r: "1.4"
}));
const icSend = /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
  d: "M22 2 11 13"
}), /*#__PURE__*/React.createElement("path", {
  d: "M22 2 15 22l-4-9-9-4Z"
}));
const icFile = /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
  d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
}), /*#__PURE__*/React.createElement("polyline", {
  points: "14 2 14 8 20 8"
}));
const icRefresh = /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
  d: "M3 12a9 9 0 0 1 15-6.7L21 8"
}), /*#__PURE__*/React.createElement("path", {
  d: "M21 3v5h-5"
}), /*#__PURE__*/React.createElement("path", {
  d: "M21 12a9 9 0 0 1-15 6.7L3 16"
}), /*#__PURE__*/React.createElement("path", {
  d: "M3 21v-5h5"
}));
const icCamera = /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
  d: "M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "12",
  cy: "13",
  r: "3"
}));
const icExit = /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
  d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"
}), /*#__PURE__*/React.createElement("polyline", {
  points: "16 17 21 12 16 7"
}), /*#__PURE__*/React.createElement("line", {
  x1: "21",
  y1: "12",
  x2: "9",
  y2: "12"
}));
const icCaret = /*#__PURE__*/React.createElement("path", {
  d: "m6 9 6 6 6-6"
});
function Brand() {
  return /*#__PURE__*/React.createElement("div", {
    style: v2.brand
  }, /*#__PURE__*/React.createElement("span", {
    style: v2.brandMark
  }, "Lavish"), /*#__PURE__*/React.createElement("span", {
    style: v2.brandSupport
  }, "Editor"));
}
function AnnotateToggle({
  on = true
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      color: "var(--steel-200)",
      fontSize: 10.5,
      whiteSpace: "nowrap"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 26,
      height: 15,
      borderRadius: 999,
      background: on ? "var(--brass-500)" : "var(--steel-600)",
      position: "relative",
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      position: "absolute",
      top: 2,
      left: on ? 13 : 2,
      width: 11,
      height: 11,
      borderRadius: 999,
      background: on ? "var(--brass-ink)" : "var(--steel-300)"
    }
  })), /*#__PURE__*/React.createElement("span", null, "Annotate"));
}
function Conversation() {
  return /*#__PURE__*/React.createElement("div", {
    style: v2.log
  }, /*#__PURE__*/React.createElement("div", {
    style: v2.uBub
  }, /*#__PURE__*/React.createElement("small", {
    style: {
      ...v2.bubLabel,
      textAlign: "right"
    }
  }, "You"), /*#__PURE__*/React.createElement("div", null, "Tighten the heading \u2014 fewer words.")), /*#__PURE__*/React.createElement("div", {
    style: v2.aBub
  }, /*#__PURE__*/React.createElement("small", {
    style: v2.bubLabel
  }, "Agent"), /*#__PURE__*/React.createElement("div", null, "Done. Shortened it to a single line.")));
}
function ArtifactBody() {
  return /*#__PURE__*/React.createElement("div", {
    style: v2.artifact
  }, /*#__PURE__*/React.createElement("div", {
    style: v2.artEyebrow
  }, "v0.1 \xB7 the rich editor"), /*#__PURE__*/React.createElement("div", {
    style: {
      ...v2.artH1,
      outline: "2px solid var(--brass-500)",
      outlineOffset: 2
    }
  }, "For when a rich editor", /*#__PURE__*/React.createElement("br", null), "is not rich enough."), /*#__PURE__*/React.createElement("p", {
    style: v2.artLede
  }, "Lavish opens an agent-generated HTML artifact in a local browser, lets you pinpoint elements, and ships your feedback back to the agent."));
}

// The ⋯ menu, optionally open — this is where the file path now lives.
function MoreMenu({
  open = false
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative",
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("button", {
    title: "More",
    style: {
      ...iBtn,
      ...(open ? {
        borderColor: "var(--steel-500)",
        color: "var(--cream-100)"
      } : null)
    }
  }, /*#__PURE__*/React.createElement(I, {
    d: icMore
  })), open && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      right: 0,
      top: 34,
      width: 232,
      background: "var(--ink-800)",
      border: "1px solid var(--steel-600)",
      borderRadius: 12,
      boxShadow: "var(--shadow-tooltip)",
      padding: 6,
      zIndex: 20
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "7px 9px 8px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 8,
      fontWeight: 700,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      color: "var(--fg-faint)",
      marginBottom: 4
    }
  }, "Editing"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6,
      fontFamily: "var(--font-mono)",
      fontSize: 10.5,
      color: "var(--steel-100)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      opacity: 0.7,
      display: "flex"
    }
  }, /*#__PURE__*/React.createElement(I, {
    d: icFile,
    size: 11
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    }
  }, "landing/index.html"))), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 1,
      background: "var(--steel-700)",
      margin: "2px 0 4px"
    }
  }), [["Reload artifact", icRefresh], ["Copy DOM snapshot", icCamera]].map(([t, d]) => /*#__PURE__*/React.createElement("div", {
    key: t,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "7px 9px",
      borderRadius: 8,
      fontSize: 11,
      color: "var(--steel-100)",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "flex",
      opacity: 0.8
    }
  }, /*#__PURE__*/React.createElement(I, {
    d: d,
    size: 13
  })), t))));
}

/* ===== D · Paired footer actions ===== */
function ChromePaired() {
  return /*#__PURE__*/React.createElement("div", {
    style: v2.shell
  }, /*#__PURE__*/React.createElement("div", {
    style: v2.bar
  }, /*#__PURE__*/React.createElement(Brand, null), /*#__PURE__*/React.createElement("div", {
    style: v2.spacer
  }), /*#__PURE__*/React.createElement(AnnotateToggle, null), /*#__PURE__*/React.createElement(MoreMenu, {
    open: false
  })), /*#__PURE__*/React.createElement("div", {
    style: v2.body
  }, /*#__PURE__*/React.createElement(ArtifactBody, null), /*#__PURE__*/React.createElement("div", {
    style: v2.panel
  }, /*#__PURE__*/React.createElement("h2", {
    style: v2.panelH
  }, "Conversation"), /*#__PURE__*/React.createElement(Conversation, null), /*#__PURE__*/React.createElement("div", {
    style: v2.composer
  }, /*#__PURE__*/React.createElement("div", {
    style: v2.ta
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      justifyContent: "space-between",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...gBtn,
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      color: "var(--rust-500)",
      borderColor: "transparent"
    }
  }, /*#__PURE__*/React.createElement(I, {
    d: icExit,
    size: 13
  }), "End session"), /*#__PURE__*/React.createElement("button", {
    style: fBtn
  }, "Send to Agent"))))));
}

/* ===== E · Split send button ===== */
function ChromeSplit() {
  return /*#__PURE__*/React.createElement("div", {
    style: v2.shell
  }, /*#__PURE__*/React.createElement("div", {
    style: v2.bar
  }, /*#__PURE__*/React.createElement(Brand, null), /*#__PURE__*/React.createElement("div", {
    style: v2.spacer
  }), /*#__PURE__*/React.createElement(AnnotateToggle, null), /*#__PURE__*/React.createElement(MoreMenu, {
    open: false
  })), /*#__PURE__*/React.createElement("div", {
    style: v2.body
  }, /*#__PURE__*/React.createElement(ArtifactBody, null), /*#__PURE__*/React.createElement("div", {
    style: v2.panel
  }, /*#__PURE__*/React.createElement("h2", {
    style: v2.panelH
  }, "Conversation"), /*#__PURE__*/React.createElement(Conversation, null), /*#__PURE__*/React.createElement("div", {
    style: v2.composer
  }, /*#__PURE__*/React.createElement("div", {
    style: v2.ta
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "flex-end",
      position: "relative"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "inline-flex",
      alignItems: "stretch"
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...fBtn,
      borderTopRightRadius: 0,
      borderBottomRightRadius: 0
    }
  }, "Send to Agent"), /*#__PURE__*/React.createElement("button", {
    title: "Send options",
    style: {
      ...fBtn,
      borderTopLeftRadius: 0,
      borderBottomLeftRadius: 0,
      padding: "7px 7px",
      borderLeft: "1px solid rgba(23,19,10,.22)",
      display: "grid",
      placeItems: "center"
    }
  }, /*#__PURE__*/React.createElement(I, {
    d: icCaret,
    size: 13
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      right: 0,
      bottom: 38,
      width: 196,
      background: "var(--ink-800)",
      border: "1px solid var(--steel-600)",
      borderRadius: 11,
      boxShadow: "var(--shadow-tooltip)",
      padding: 6,
      zIndex: 20
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "7px 9px",
      borderRadius: 8,
      fontSize: 11,
      color: "var(--steel-100)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "flex",
      opacity: 0.85
    }
  }, /*#__PURE__*/React.createElement(I, {
    d: icSend,
    size: 13
  })), "Send to Agent"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "7px 9px",
      borderRadius: 8,
      fontSize: 11,
      color: "var(--rust-500)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "flex"
    }
  }, /*#__PURE__*/React.createElement(I, {
    d: icExit,
    size: 13
  })), "Send & end session")))))));
}

/* ===== F · Send is the finish (two-tier) ===== */
function ChromeFinish() {
  return /*#__PURE__*/React.createElement("div", {
    style: v2.shell
  }, /*#__PURE__*/React.createElement("div", {
    style: v2.bar
  }, /*#__PURE__*/React.createElement(Brand, null), /*#__PURE__*/React.createElement("div", {
    style: v2.spacer
  }), /*#__PURE__*/React.createElement(AnnotateToggle, null), /*#__PURE__*/React.createElement(MoreMenu, {
    open: true
  })), /*#__PURE__*/React.createElement("div", {
    style: v2.body
  }, /*#__PURE__*/React.createElement(ArtifactBody, null), /*#__PURE__*/React.createElement("div", {
    style: v2.panel
  }, /*#__PURE__*/React.createElement("h2", {
    style: v2.panelH
  }, "Conversation"), /*#__PURE__*/React.createElement(Conversation, null), /*#__PURE__*/React.createElement("div", {
    style: v2.composer
  }, /*#__PURE__*/React.createElement("div", {
    style: v2.ta
  }), /*#__PURE__*/React.createElement("button", {
    style: {
      ...fBtn,
      width: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 7,
      padding: "9px 12px"
    }
  }, /*#__PURE__*/React.createElement(I, {
    d: icSend,
    size: 13
  }), "Send to Agent"), /*#__PURE__*/React.createElement("button", {
    style: {
      background: "transparent",
      border: 0,
      color: "var(--steel-300)",
      fontSize: 10.5,
      fontFamily: "inherit",
      cursor: "pointer",
      padding: 2,
      textAlign: "center"
    }
  }, "Send a final note & end session")))));
}
Object.assign(window, {
  ChromePaired,
  ChromeSplit,
  ChromeFinish
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/editor/options-chrome-v2.jsx", error: String((e && e.message) || e) }); }

// ui_kits/editor/options-chrome-v3.jsx
try { (() => {
/* global React */
// v3: discoverability treatments for the "Send / Send & end session" split button.
// Focuses on the conversation panel + composer footer (the only area that changes).

const v3 = {
  wrap: {
    position: "absolute",
    inset: 0,
    display: "flex",
    justifyContent: "center",
    alignItems: "stretch",
    background: "var(--ink-900)",
    padding: 0
  },
  panel: {
    width: "100%",
    borderLeft: "1px solid var(--steel-700)",
    background: "var(--ink-800)",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    fontFamily: "var(--font-sans)",
    color: "var(--cream-100)",
    fontSize: 12,
    position: "relative"
  },
  panelH: {
    fontSize: 12,
    margin: "14px 14px 8px",
    fontWeight: 600
  },
  log: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
    padding: "0 14px 10px",
    display: "flex",
    flexDirection: "column",
    gap: 9
  },
  uBub: {
    alignSelf: "flex-end",
    maxWidth: "86%",
    borderRadius: 12,
    padding: "8px 10px",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border-strong)"
  },
  aBub: {
    alignSelf: "flex-start",
    maxWidth: "86%",
    borderRadius: 12,
    padding: "8px 10px",
    background: "transparent",
    border: "1px solid var(--border-subtle)"
  },
  bubLabel: {
    display: "block",
    fontSize: 8.5,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "var(--fg-faint)",
    marginBottom: 3
  },
  composer: {
    borderTop: "1px solid var(--steel-700)",
    padding: 14,
    display: "grid",
    gap: 9,
    flexShrink: 0
  },
  ta: {
    width: "100%",
    minHeight: 58,
    borderRadius: 11,
    border: "1px solid var(--steel-600)",
    background: "var(--ink-900)",
    color: "var(--cream-100)",
    padding: 9,
    font: "inherit",
    fontSize: 12,
    boxSizing: "border-box",
    resize: "none"
  }
};
const fBtn3 = {
  border: 0,
  background: "var(--brass-500)",
  color: "var(--brass-ink)",
  borderRadius: 10,
  padding: "9px 14px",
  fontFamily: "inherit",
  fontWeight: 700,
  fontSize: 12,
  cursor: "pointer",
  whiteSpace: "nowrap"
};
function I3({
  d,
  size = 14
}) {
  return /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.7",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, d);
}
const ic3Exit = /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
  d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"
}), /*#__PURE__*/React.createElement("polyline", {
  points: "16 17 21 12 16 7"
}), /*#__PURE__*/React.createElement("line", {
  x1: "21",
  y1: "12",
  x2: "9",
  y2: "12"
}));
const ic3Send = /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
  d: "M22 2 11 13"
}), /*#__PURE__*/React.createElement("path", {
  d: "M22 2 15 22l-4-9-9-4Z"
}));
const ic3Caret = /*#__PURE__*/React.createElement("path", {
  d: "m6 9 6 6 6-6"
});
function Convo({
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: v3.log
  }, /*#__PURE__*/React.createElement("div", {
    style: v3.uBub
  }, /*#__PURE__*/React.createElement("small", {
    style: {
      ...v3.bubLabel,
      textAlign: "right"
    }
  }, "You"), /*#__PURE__*/React.createElement("div", null, "Tighten the heading \u2014 fewer words.")), /*#__PURE__*/React.createElement("div", {
    style: v3.aBub
  }, /*#__PURE__*/React.createElement("small", {
    style: v3.bubLabel
  }, "Agent"), /*#__PURE__*/React.createElement("div", null, "Done. Shortened it to a single line \u2014 anything else?")), children);
}
function SplitSend() {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "inline-flex",
      alignItems: "stretch"
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...fBtn3,
      borderTopRightRadius: 0,
      borderBottomRightRadius: 0
    }
  }, "Send to Agent"), /*#__PURE__*/React.createElement("button", {
    title: "Send & end session",
    style: {
      ...fBtn3,
      borderTopLeftRadius: 0,
      borderBottomLeftRadius: 0,
      padding: "9px 9px",
      borderLeft: "1px solid rgba(23,19,10,.22)",
      display: "grid",
      placeItems: "center"
    }
  }, /*#__PURE__*/React.createElement(I3, {
    d: ic3Caret
  })));
}

/* ===== E1 · Contextual idle nudge (recommended) =====
   After the agent replies and the box is empty, a quiet line fades in. */
function PanelIdleNudge() {
  return /*#__PURE__*/React.createElement("div", {
    style: v3.wrap
  }, /*#__PURE__*/React.createElement("div", {
    style: v3.panel
  }, /*#__PURE__*/React.createElement("h2", {
    style: v3.panelH
  }, "Conversation"), /*#__PURE__*/React.createElement(Convo, null), /*#__PURE__*/React.createElement("div", {
    style: v3.composer
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 7,
      fontSize: 11,
      color: "var(--steel-300)",
      padding: "0 1px"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 5,
      height: 5,
      borderRadius: 999,
      background: "var(--brass-500)",
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("span", null, "Finished? Use the ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--brass-400)",
      borderBottom: "1px solid var(--brass-500)",
      cursor: "pointer",
      fontWeight: 600
    }
  }, "\u25BE to send & end"), " the session.")), /*#__PURE__*/React.createElement("div", {
    style: v3.ta
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "flex-end"
    }
  }, /*#__PURE__*/React.createElement(SplitSend, null)))));
}

/* ===== E2 · Dual home — End session also in the ⋯ menu ===== */
function PanelDualHome() {
  return /*#__PURE__*/React.createElement("div", {
    style: v3.wrap
  }, /*#__PURE__*/React.createElement("div", {
    style: v3.panel
  }, /*#__PURE__*/React.createElement("h2", {
    style: v3.panelH
  }, "Conversation"), /*#__PURE__*/React.createElement(Convo, null), /*#__PURE__*/React.createElement("div", {
    style: v3.composer
  }, /*#__PURE__*/React.createElement("div", {
    style: v3.ta
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "flex-end"
    }
  }, /*#__PURE__*/React.createElement(SplitSend, null))), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      right: 12,
      top: 10,
      width: 210,
      background: "var(--ink-700)",
      border: "1px solid var(--steel-600)",
      borderRadius: 12,
      boxShadow: "var(--shadow-tooltip)",
      padding: 6,
      zIndex: 20
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "6px 9px 7px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 8,
      fontWeight: 700,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      color: "var(--fg-faint)",
      marginBottom: 4
    }
  }, "Editing"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 10.5,
      color: "var(--steel-100)"
    }
  }, "landing/index.html")), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 1,
      background: "var(--steel-600)",
      margin: "2px 0 4px"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "7px 9px",
      borderRadius: 8,
      fontSize: 11,
      color: "var(--steel-100)"
    }
  }, "Reload artifact"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "7px 9px",
      borderRadius: 8,
      fontSize: 11,
      color: "var(--steel-100)"
    }
  }, "Copy DOM snapshot"), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 1,
      background: "var(--steel-600)",
      margin: "4px 0"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "7px 9px",
      borderRadius: 8,
      fontSize: 11,
      color: "var(--rust-500)",
      background: "rgba(240,100,100,.08)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "flex"
    }
  }, /*#__PURE__*/React.createElement(I3, {
    d: ic3Exit,
    size: 13
  })), "End session"))));
}

/* ===== E3 · Labeled caret — the trigger says what it does ===== */
function PanelLabeledCaret() {
  return /*#__PURE__*/React.createElement("div", {
    style: v3.wrap
  }, /*#__PURE__*/React.createElement("div", {
    style: v3.panel
  }, /*#__PURE__*/React.createElement("h2", {
    style: v3.panelH
  }, "Conversation"), /*#__PURE__*/React.createElement(Convo, null), /*#__PURE__*/React.createElement("div", {
    style: v3.composer
  }, /*#__PURE__*/React.createElement("div", {
    style: v3.ta
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "flex-end",
      position: "relative"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "inline-flex",
      alignItems: "stretch"
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...fBtn3,
      borderTopRightRadius: 0,
      borderBottomRightRadius: 0
    }
  }, "Send to Agent"), /*#__PURE__*/React.createElement("button", {
    style: {
      ...fBtn3,
      borderTopLeftRadius: 0,
      borderBottomLeftRadius: 0,
      padding: "9px 10px",
      borderLeft: "1px solid rgba(23,19,10,.22)",
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      fontSize: 11
    }
  }, "end ", /*#__PURE__*/React.createElement(I3, {
    d: ic3Caret,
    size: 12
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      right: 0,
      bottom: 42,
      background: "var(--ink-700)",
      border: "1px solid var(--steel-600)",
      color: "var(--steel-100)",
      borderRadius: 8,
      padding: "6px 9px",
      fontSize: 10.5,
      whiteSpace: "nowrap",
      boxShadow: "var(--shadow-tooltip)"
    }
  }, "Send & end session", /*#__PURE__*/React.createElement("span", {
    style: {
      position: "absolute",
      right: 18,
      bottom: -5,
      width: 8,
      height: 8,
      background: "var(--ink-700)",
      borderRight: "1px solid var(--steel-600)",
      borderBottom: "1px solid var(--steel-600)",
      transform: "rotate(45deg)"
    }
  }))))));
}
Object.assign(window, {
  PanelIdleNudge,
  PanelDualHome,
  PanelLabeledCaret
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/editor/options-chrome-v3.jsx", error: String((e && e.message) || e) }); }

// ui_kits/editor/options-chrome.jsx
try { (() => {
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
    overflow: "hidden"
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
    flexShrink: 0
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    whiteSpace: "nowrap",
    flexShrink: 0
  },
  brandMark: {
    fontFamily: "var(--font-serif)",
    fontStyle: "italic",
    fontSize: 17,
    lineHeight: 1,
    color: "var(--cream-100)"
  },
  brandSupport: {
    fontSize: 8,
    fontWeight: 600,
    letterSpacing: "0.18em",
    textTransform: "uppercase",
    color: "var(--steel-200)",
    position: "relative",
    top: 1
  },
  divider: {
    width: 1,
    height: 18,
    background: "var(--steel-700)",
    flexShrink: 0
  },
  fileWrap: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    flex: 1,
    minWidth: 0,
    color: "var(--steel-200)",
    fontFamily: "var(--font-mono)",
    fontSize: 10.5
  },
  fileText: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  },
  body: {
    flex: 1,
    minHeight: 0,
    display: "flex"
  },
  artifact: {
    flex: 1,
    minWidth: 0,
    background: "#ffffff",
    color: "#1a1a1a",
    padding: "22px 24px",
    position: "relative",
    overflow: "hidden"
  },
  artEyebrow: {
    fontSize: 7.5,
    fontWeight: 700,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: "#7a6a3a",
    marginBottom: 12
  },
  artH1: {
    fontFamily: "'EB Garamond', Georgia, serif",
    fontStyle: "italic",
    fontSize: 30,
    lineHeight: 1.05,
    margin: "0 0 12px",
    color: "#1a1a1a",
    display: "inline-block"
  },
  artLede: {
    fontSize: 11,
    lineHeight: 1.5,
    color: "#3a3a3a",
    maxWidth: 320,
    margin: 0
  },
  panel: {
    width: 234,
    flexShrink: 0,
    borderLeft: "1px solid var(--steel-700)",
    background: "var(--ink-800)",
    display: "flex",
    flexDirection: "column",
    minHeight: 0
  },
  panelH: {
    fontSize: 11,
    margin: "12px 12px 8px",
    fontWeight: 600
  },
  log: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
    padding: "0 12px 8px",
    display: "flex",
    flexDirection: "column",
    gap: 8
  },
  uBub: {
    alignSelf: "flex-end",
    maxWidth: "88%",
    borderRadius: 11,
    padding: "7px 9px",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border-strong)"
  },
  aBub: {
    alignSelf: "flex-start",
    maxWidth: "88%",
    borderRadius: 11,
    padding: "7px 9px",
    background: "transparent",
    border: "1px solid var(--border-subtle)"
  },
  bubLabel: {
    display: "block",
    fontSize: 8,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "var(--fg-faint)",
    marginBottom: 3
  },
  composer: {
    borderTop: "1px solid var(--steel-700)",
    padding: 12,
    display: "grid",
    gap: 8,
    flexShrink: 0
  },
  ta: {
    width: "100%",
    minHeight: 52,
    borderRadius: 10,
    border: "1px solid var(--steel-600)",
    background: "var(--ink-900)",
    color: "var(--cream-100)",
    padding: 8,
    font: "inherit",
    fontSize: 11,
    boxSizing: "border-box",
    resize: "none"
  }
};
const ghostBtn = {
  border: "1px solid var(--steel-600)",
  background: "transparent",
  color: "var(--steel-100)",
  borderRadius: 9,
  padding: "6px 10px",
  fontFamily: "inherit",
  fontWeight: 600,
  fontSize: 11,
  cursor: "pointer",
  whiteSpace: "nowrap"
};
const filledBtn = {
  border: 0,
  background: "var(--brass-500)",
  color: "var(--brass-ink)",
  borderRadius: 9,
  padding: "6px 11px",
  fontFamily: "inherit",
  fontWeight: 700,
  fontSize: 11,
  cursor: "pointer",
  whiteSpace: "nowrap"
};
const iconBtn = {
  width: 28,
  height: 28,
  display: "grid",
  placeItems: "center",
  border: "1px solid transparent",
  background: "transparent",
  color: "var(--steel-200)",
  borderRadius: 8,
  cursor: "pointer",
  flexShrink: 0,
  padding: 0
};
function Ic({
  d,
  size = 15
}) {
  return /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.6",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, d);
}
const fileIcon = /*#__PURE__*/React.createElement(Ic, {
  size: 11,
  d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
  }), /*#__PURE__*/React.createElement("polyline", {
    points: "14 2 14 8 20 8"
  }))
});
const penIcon = /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
  d: "M12 20h9"
}), /*#__PURE__*/React.createElement("path", {
  d: "M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"
}));
const moreIcon = /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
  cx: "12",
  cy: "5",
  r: "1"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "12",
  cy: "12",
  r: "1"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "12",
  cy: "19",
  r: "1"
}));
const sendIcon = /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
  d: "M22 2 11 13"
}), /*#__PURE__*/React.createElement("path", {
  d: "M22 2 15 22l-4-9-9-4Z"
}));
function Brand() {
  return /*#__PURE__*/React.createElement("div", {
    style: mc.brand
  }, /*#__PURE__*/React.createElement("span", {
    style: mc.brandMark
  }, "Lavish"), /*#__PURE__*/React.createElement("span", {
    style: mc.brandSupport
  }, "Editor"));
}
function FileChip() {
  return /*#__PURE__*/React.createElement("div", {
    style: mc.fileWrap,
    title: "~/projects/landing/index.html"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      opacity: 0.7,
      display: "flex"
    }
  }, fileIcon), /*#__PURE__*/React.createElement("span", {
    style: mc.fileText
  }, "~/projects/landing/index.html"));
}
function Toggle({
  on = true
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      color: "var(--steel-200)",
      fontSize: 10.5,
      whiteSpace: "nowrap"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 26,
      height: 15,
      borderRadius: 999,
      background: on ? "var(--brass-500)" : "var(--steel-600)",
      position: "relative",
      flexShrink: 0,
      transition: "background .15s"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      position: "absolute",
      top: 2,
      left: on ? 13 : 2,
      width: 11,
      height: 11,
      borderRadius: 999,
      background: on ? "var(--brass-ink)" : "var(--steel-300)"
    }
  })), /*#__PURE__*/React.createElement("span", null, "Annotate"));
}
function Conversation({
  extra
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: mc.log
  }, /*#__PURE__*/React.createElement("div", {
    style: mc.uBub
  }, /*#__PURE__*/React.createElement("small", {
    style: {
      ...mc.bubLabel,
      textAlign: "right"
    }
  }, "You"), /*#__PURE__*/React.createElement("div", null, "Tighten the heading \u2014 fewer words.")), /*#__PURE__*/React.createElement("div", {
    style: mc.aBub
  }, /*#__PURE__*/React.createElement("small", {
    style: mc.bubLabel
  }, "Agent"), /*#__PURE__*/React.createElement("div", null, "Done. Shortened it to a single line.")), extra);
}
function ArtifactBody({
  note
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: mc.artifact
  }, /*#__PURE__*/React.createElement("div", {
    style: mc.artEyebrow
  }, "v0.1 \xB7 the rich editor"), /*#__PURE__*/React.createElement("div", {
    style: {
      ...mc.artH1,
      outline: "2px solid var(--brass-500)",
      outlineOffset: 2
    }
  }, "For when a rich editor", /*#__PURE__*/React.createElement("br", null), "is not rich enough."), /*#__PURE__*/React.createElement("p", {
    style: mc.artLede
  }, "Lavish opens an agent-generated HTML artifact in a local browser, lets you pinpoint elements, and ships your feedback back to the agent."), note);
}

/* ----- Variant 0 · Current (baseline) ----- */
function ChromeBaseline() {
  return /*#__PURE__*/React.createElement("div", {
    style: mc.shell
  }, /*#__PURE__*/React.createElement("div", {
    style: mc.bar
  }, /*#__PURE__*/React.createElement(Brand, null), /*#__PURE__*/React.createElement("div", {
    style: mc.divider
  }), /*#__PURE__*/React.createElement(FileChip, null), /*#__PURE__*/React.createElement("button", {
    style: mc.barBtn || {
      ...ghostBtn,
      background: "var(--steel-700)",
      border: 0
    }
  }, "Annotation: On"), /*#__PURE__*/React.createElement("button", {
    style: {
      ...ghostBtn,
      color: "var(--rust-500)",
      borderColor: "var(--rust-500)"
    }
  }, "End Session")), /*#__PURE__*/React.createElement("div", {
    style: mc.body
  }, /*#__PURE__*/React.createElement(ArtifactBody, {
    note: /*#__PURE__*/React.createElement("div", {
      style: {
        position: "absolute",
        left: 150,
        top: 92,
        width: 188,
        padding: 9,
        borderRadius: 11,
        background: "var(--ink-800)",
        color: "var(--cream-100)",
        border: "1px solid var(--brass-500)",
        boxShadow: "var(--shadow-floating)"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontWeight: 700,
        marginBottom: 5,
        fontSize: 11
      }
    }, "Annotate <h1>"), /*#__PURE__*/React.createElement("div", {
      style: {
        height: 30,
        borderRadius: 7,
        border: "1px solid var(--steel-600)",
        background: "var(--ink-900)"
      }
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 5,
        justifyContent: "flex-end",
        marginTop: 6
      }
    }, /*#__PURE__*/React.createElement("button", {
      style: {
        ...ghostBtn,
        padding: "4px 7px",
        fontSize: 10
      }
    }, "Cancel"), /*#__PURE__*/React.createElement("button", {
      style: {
        ...filledBtn,
        padding: "4px 7px",
        fontSize: 10
      }
    }, "Queue Prompt")))
  }), /*#__PURE__*/React.createElement("div", {
    style: mc.panel
  }, /*#__PURE__*/React.createElement("h2", {
    style: mc.panelH
  }, "Conversation"), /*#__PURE__*/React.createElement(Conversation, {
    extra: /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        flexWrap: "wrap",
        gap: 4
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        border: "1px solid var(--steel-500)",
        borderRadius: 999,
        background: "var(--ink-600)",
        padding: "3px 5px 3px 8px",
        fontSize: 9.5,
        fontWeight: 700
      }
    }, "Make CTA italic", /*#__PURE__*/React.createElement("span", {
      style: {
        width: 13,
        height: 13,
        borderRadius: 999,
        background: "var(--steel-600)",
        display: "grid",
        placeItems: "center",
        fontSize: 10
      }
    }, "\xD7")))
  }), /*#__PURE__*/React.createElement("div", {
    style: mc.composer
  }, /*#__PURE__*/React.createElement("div", {
    style: mc.ta
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: filledBtn
  }, "Send to Agent"))))));
}

/* ----- Variant A · Quiet bar (demote to ghost + icon) ----- */
function ChromeQuiet() {
  return /*#__PURE__*/React.createElement("div", {
    style: mc.shell
  }, /*#__PURE__*/React.createElement("div", {
    style: mc.bar
  }, /*#__PURE__*/React.createElement(Brand, null), /*#__PURE__*/React.createElement("div", {
    style: mc.divider
  }), /*#__PURE__*/React.createElement(FileChip, null), /*#__PURE__*/React.createElement(Toggle, {
    on: true
  }), /*#__PURE__*/React.createElement("button", {
    title: "End session",
    style: iconBtn
  }, /*#__PURE__*/React.createElement(Ic, {
    d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
      d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"
    }), /*#__PURE__*/React.createElement("polyline", {
      points: "16 17 21 12 16 7"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "21",
      y1: "12",
      x2: "9",
      y2: "12"
    }))
  }))), /*#__PURE__*/React.createElement("div", {
    style: mc.body
  }, /*#__PURE__*/React.createElement(ArtifactBody, {
    note: /*#__PURE__*/React.createElement("div", {
      style: {
        position: "absolute",
        left: 150,
        top: 92,
        width: 188,
        padding: 9,
        borderRadius: 11,
        background: "var(--ink-800)",
        color: "var(--cream-100)",
        border: "1px solid var(--brass-500)",
        boxShadow: "var(--shadow-floating)"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontWeight: 700,
        marginBottom: 5,
        fontSize: 11
      }
    }, "Annotate <h1>"), /*#__PURE__*/React.createElement("div", {
      style: {
        height: 30,
        borderRadius: 7,
        border: "1px solid var(--steel-600)",
        background: "var(--ink-900)"
      }
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 5,
        justifyContent: "flex-end",
        marginTop: 6,
        alignItems: "center"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 10,
        color: "var(--steel-300)",
        cursor: "pointer"
      }
    }, "Cancel"), /*#__PURE__*/React.createElement("button", {
      style: {
        ...filledBtn,
        padding: "4px 9px",
        fontSize: 10
      }
    }, "Queue")))
  }), /*#__PURE__*/React.createElement("div", {
    style: mc.panel
  }, /*#__PURE__*/React.createElement("h2", {
    style: mc.panelH
  }, "Conversation"), /*#__PURE__*/React.createElement(Conversation, null), /*#__PURE__*/React.createElement("div", {
    style: mc.composer
  }, /*#__PURE__*/React.createElement("div", {
    style: mc.ta
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      justifyContent: "flex-end"
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: filledBtn
  }, "Send to Agent"))))));
}

/* ----- Variant B · Overflow menu (one bar control) ----- */
function ChromeOverflow() {
  return /*#__PURE__*/React.createElement("div", {
    style: mc.shell
  }, /*#__PURE__*/React.createElement("div", {
    style: mc.bar
  }, /*#__PURE__*/React.createElement(Brand, null), /*#__PURE__*/React.createElement("div", {
    style: mc.divider
  }), /*#__PURE__*/React.createElement(FileChip, null), /*#__PURE__*/React.createElement(Toggle, {
    on: true
  }), /*#__PURE__*/React.createElement("button", {
    title: "More",
    style: {
      ...iconBtn,
      border: "1px solid var(--steel-700)"
    }
  }, /*#__PURE__*/React.createElement(Ic, {
    d: moreIcon
  }))), /*#__PURE__*/React.createElement("div", {
    style: mc.body
  }, /*#__PURE__*/React.createElement(ArtifactBody, {
    note: /*#__PURE__*/React.createElement("div", {
      style: {
        position: "absolute",
        left: 150,
        top: 92,
        width: 188,
        padding: 9,
        borderRadius: 11,
        background: "var(--ink-800)",
        color: "var(--cream-100)",
        border: "1px solid var(--brass-500)",
        boxShadow: "var(--shadow-floating)"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontWeight: 700,
        marginBottom: 5,
        fontSize: 11
      }
    }, "Annotate <h1>"), /*#__PURE__*/React.createElement("div", {
      style: {
        height: 30,
        borderRadius: 7,
        border: "1px solid var(--steel-600)",
        background: "var(--ink-900)"
      }
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 5,
        justifyContent: "flex-end",
        marginTop: 6,
        alignItems: "center"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 10,
        color: "var(--steel-300)"
      }
    }, "Esc"), /*#__PURE__*/React.createElement("button", {
      style: {
        ...filledBtn,
        padding: "4px 9px",
        fontSize: 10
      }
    }, "Queue")))
  }), /*#__PURE__*/React.createElement("div", {
    style: mc.panel
  }, /*#__PURE__*/React.createElement("h2", {
    style: mc.panelH
  }, "Conversation"), /*#__PURE__*/React.createElement(Conversation, null), /*#__PURE__*/React.createElement("div", {
    style: mc.composer
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: mc.ta
  }), /*#__PURE__*/React.createElement("button", {
    title: "Send",
    style: {
      ...filledBtn,
      position: "absolute",
      right: 7,
      bottom: 7,
      width: 26,
      height: 26,
      padding: 0,
      display: "grid",
      placeItems: "center",
      borderRadius: 8
    }
  }, /*#__PURE__*/React.createElement(Ic, {
    d: sendIcon,
    size: 13
  })))))));
}

/* ----- Variant C · Unified composer (no floating card) ----- */
function ChromeUnified() {
  return /*#__PURE__*/React.createElement("div", {
    style: mc.shell
  }, /*#__PURE__*/React.createElement("div", {
    style: mc.bar
  }, /*#__PURE__*/React.createElement(Brand, null), /*#__PURE__*/React.createElement("div", {
    style: mc.divider
  }), /*#__PURE__*/React.createElement(FileChip, null), /*#__PURE__*/React.createElement(Toggle, {
    on: true
  }), /*#__PURE__*/React.createElement("button", {
    title: "More",
    style: {
      ...iconBtn,
      border: "1px solid var(--steel-700)"
    }
  }, /*#__PURE__*/React.createElement(Ic, {
    d: moreIcon
  }))), /*#__PURE__*/React.createElement("div", {
    style: mc.body
  }, /*#__PURE__*/React.createElement(ArtifactBody, {
    note: null
  }), /*#__PURE__*/React.createElement("div", {
    style: mc.panel
  }, /*#__PURE__*/React.createElement("h2", {
    style: mc.panelH
  }, "Conversation"), /*#__PURE__*/React.createElement(Conversation, null), /*#__PURE__*/React.createElement("div", {
    style: mc.composer
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 5,
      alignSelf: "flex-start",
      border: "1px solid var(--brass-500)",
      color: "var(--brass-500)",
      borderRadius: 999,
      padding: "3px 5px 3px 9px",
      fontSize: 9.5,
      fontWeight: 700,
      fontFamily: "var(--font-mono)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "flex",
      opacity: 0.85
    }
  }, /*#__PURE__*/React.createElement(Ic, {
    d: penIcon,
    size: 10
  })), "editing <h1>", /*#__PURE__*/React.createElement("span", {
    style: {
      width: 13,
      height: 13,
      borderRadius: 999,
      background: "rgba(244,201,93,.18)",
      display: "grid",
      placeItems: "center",
      fontSize: 10
    }
  }, "\xD7")), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...mc.ta,
      minHeight: 48
    }
  }), /*#__PURE__*/React.createElement("button", {
    title: "Send",
    style: {
      ...filledBtn,
      position: "absolute",
      right: 7,
      bottom: 7,
      width: 26,
      height: 26,
      padding: 0,
      display: "grid",
      placeItems: "center",
      borderRadius: 8
    }
  }, /*#__PURE__*/React.createElement(Ic, {
    d: sendIcon,
    size: 13
  })))))));
}
Object.assign(window, {
  ChromeBaseline,
  ChromeQuiet,
  ChromeOverflow,
  ChromeUnified
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/editor/options-chrome.jsx", error: String((e && e.message) || e) }); }

})();
