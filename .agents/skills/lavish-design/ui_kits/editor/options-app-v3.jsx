/* global React, ReactDOM, DesignCanvas, DCSection, DCArtboard, PanelIdleNudge, PanelDualHome, PanelLabeledCaret */

const ns3 = { fontFamily: "var(--font-sans)", fontSize: 13, lineHeight: 1.5, color: "var(--steel-100)" };
const ts3 = { display: "inline-block", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--brass-500)", marginBottom: 6, letterSpacing: "0.04em" };

function Cap3({ tag, children }) {
  return (
    <div style={{ width: 320, marginTop: 10 }}>
      <div style={ts3}>{tag}</div>
      <div style={ns3} dangerouslySetInnerHTML={{ __html: children }} />
    </div>
  );
}

function OptionsV3() {
  return (
    <DesignCanvas>
      <DCSection
        id="discover"
        title="Making “end session” discoverable"
        subtitle="Option E keeps the tiny split button. These three mechanisms make sure nobody misses the end-session path — without adding permanent real estate."
      >
        <DCArtboard id="nudge" label="E1 · Contextual idle nudge" width={320} height={520}>
          <PanelIdleNudge />
          <Cap3 tag="E1 · IDLE NUDGE — teaches at the right moment">
            The agent has replied and your box is empty — the moment you’re <i>most</i> likely done. A quiet one-liner fades in above the composer pointing at the <b>▾</b>. It costs zero space while you’re actively working and disappears the instant you start typing. Teaches the fast path exactly when it’s relevant.
          </Cap3>
        </DCArtboard>

        <DCArtboard id="dual" label="E2 · Dual home in ⋯" width={320} height={520}>
          <PanelDualHome />
          <Cap3 tag="E2 · DUAL HOME — the reliable safety net">
            <b>End session</b> also lives in the <b>⋯</b> menu (rust, set off below a divider). The split-button ▾ stays the <i>fast</i> path; the ⋯ menu is the <i>discoverable</i> path everyone opens to explore. Belt and suspenders — anyone poking around finds it.
          </Cap3>
        </DCArtboard>

        <DCArtboard id="labeled" label="E3 · Labeled caret + tooltip" width={320} height={520}>
          <PanelLabeledCaret />
          <Cap3 tag="E3 · LABELED CARET — visible at a glance">
            The trigger isn’t a bare ▾ — it reads <b>“end ▾”</b>, and hovering surfaces a <b>“Send &amp; end session”</b> tooltip. The word is always on screen, so the option is never truly hidden. Adds a sliver of width back, but no second control.
          </Cap3>
        </DCArtboard>
      </DCSection>
    </DesignCanvas>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<OptionsV3 />);
